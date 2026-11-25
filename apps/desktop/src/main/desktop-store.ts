// The desktop app's own settings file, `~/.tokama/desktop.json`: window placement, panel widths
// and view choices of this machine. The main process owns it; the engine never reads it. Writes
// are atomic (a temp file, then a rename) and the file is private to the user (mode 0600), so a
// crash or a second writer cannot leave half a file. Reading never throws: a missing, oversized
// or broken file gives the defaults, and a file with some bad fields keeps the good ones.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { replaceTextSync } from "@tokama/core";
import { DEFAULT_DESKTOP_STATE, type DesktopState, parseDesktopState } from "../shared/desktop-state.js";

/** A real file is about 400 bytes; anything much larger is not ours. */
const MAX_FILE_BYTES = 64 * 1024;
const SAVE_DELAY_MS = 400;

/**
 * The saved state, or the defaults when the file is missing, is not a plain file (a link, a pipe,
 * a device), is too large or is not valid JSON. It is opened without following a link and without
 * waiting on a pipe, so a planted special file cannot stop the app from starting.
 */
export function readDesktopState(path: string): DesktopState {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return DEFAULT_DESKTOP_STATE;
    const buffer = Buffer.alloc(stat.size);
    const read = readSync(fd, buffer, 0, stat.size, 0);
    return parseDesktopState(JSON.parse(buffer.toString("utf8", 0, read)));
  } catch {
    return DEFAULT_DESKTOP_STATE;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Writes `state` so that a reader sees the old file or the new one, never a part. Throws when it cannot write. */
export function writeDesktopState(path: string, state: DesktopState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const written = replaceTextSync(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  if (!written.ok) throw new Error(written.error.message);
}

export interface DesktopStore {
  get(): DesktopState;
  /** Applies `change` to the current state and saves soon; many changes in a burst make one write. */
  update(change: (state: DesktopState) => DesktopState): void;
  /** Writes any pending change now (the app is quitting). */
  flush(): void;
}

export interface StoreOptions {
  readonly delayMs?: number;
  /** Called when a write fails; the app goes on with its in-memory state. */
  readonly onError?: (error: unknown) => void;
}

export function desktopStore(path: string, options: StoreOptions = {}): DesktopStore {
  let state = readDesktopState(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    timer = undefined;
    try {
      writeDesktopState(path, state);
    } catch (error) {
      options.onError?.(error);
    }
  };
  return {
    get: () => state,
    update: (change) => {
      state = change(state);
      clearTimeout(timer);
      timer = setTimeout(write, options.delayMs ?? SAVE_DELAY_MS);
    },
    flush: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      write();
    },
  };
}
