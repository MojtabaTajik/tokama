// The packaged app on macOS runs from the Applications folder only. From a disk image or a
// download folder it would start an engine out of a mounted or translocated copy. Electron's
// dialogs and its move call are passed in, so the flow is tested without Electron.

import type { ConnectError } from "@tokama/client";

export type ConflictType = "exists" | "existsAndRunning";

export interface Question {
  message: string;
  detail: string;
  buttons: string[];
}

export interface MoveDeps {
  /** Asks a question with buttons; resolves to the index of the one pressed. */
  readonly ask: (question: Question) => Promise<number>;
  /** Asks the same, and answers at once: Electron's conflict handler cannot wait. */
  readonly askSync: (question: Question) => number;
  /** Moves the app and relaunches it from Applications; false when it did not move. */
  readonly moveToApplicationsFolder: (options: { conflictHandler: (type: ConflictType) => boolean }) => boolean;
  readonly showErrorBox: (title: string, content: string) => void;
  /**
   * How many items (queued, running or waiting for the user) an engine that runs from the copy in Applications has: 0 when there is
   * no such engine, undefined when that could not be told. The engine keeps running after its
   * app quits, and a replace would remove the files it runs from.
   */
  readonly itemsRunningInApplications: () => Promise<number | undefined>;
}

/** The copy of the app that the move replaces. */
export const APPLICATIONS_COPY = "/Applications/Tokama.app";

/** True when `command`, the command line of a process, runs a file of the app copy `app`. */
export function runsFromCopy(command: string, app = APPLICATIONS_COPY): boolean {
  return command.startsWith(`${app}/Contents/`);
}

/** Where `itemsRunningIn` looks for an engine, and how it asks it. */
export interface CopyEngineDeps {
  readonly endpoint: () => { ok: true; value: { lockPath: string } } | { ok: false };
  readonly readLock: (lockPath: string) => { pid: number } | undefined;
  readonly describe: (pid: number) => Promise<{ command: string } | undefined>;
  /** Connects to a running engine without starting one. */
  readonly connect: () => Promise<ConnectResult>;
  /** The app copy whose engine counts. Default: the copy in Applications. */
  readonly app?: string;
}

export type ConnectResult =
  | {
      ok: true;
      value: {
        query(query: { type: "board" }): Promise<{ ok: true; data: { items: readonly { state: string }[] } } | { ok: false }>;
        close(): Promise<void>;
      };
    }
  | { ok: false; error: Pick<ConnectError, "code" | "engine"> };

/**
 * Unfinished items of an engine that runs from the app copy: 0 when there is none, undefined when
 * that could not be told. An engine of another API version cannot answer a board query; its
 * handshake count is used, which has only running and finishing items, not queued or waiting ones.
 */
export async function itemsRunningIn(deps: CopyEngineDeps): Promise<number | undefined> {
  const endpoint = deps.endpoint();
  if (!endpoint.ok) return undefined;
  const lock = deps.readLock(endpoint.value.lockPath);
  if (lock === undefined) return 0;
  const described = await deps.describe(lock.pid).then(
    (found) => ({ found }),
    () => undefined,
  );
  if (described === undefined) return undefined;
  if (described.found === undefined || !runsFromCopy(described.found.command, deps.app)) return 0;
  const connected = await deps.connect();
  if (!connected.ok) return connected.error.code === "unsupported_version" ? connected.error.engine?.runningItems : undefined;
  try {
    const reply = await connected.value.query({ type: "board" });
    return reply.ok ? reply.data.items.filter((item) => item.state === "queued" || item.state === "running" || item.state === "needs_you").length : undefined;
  } finally {
    await connected.value.close().catch(() => undefined);
  }
}

/** True for a packaged app on macOS that is not in an Applications folder. `inApplications` is only called on macOS, where Electron has it. */
export function shouldOfferMove(input: { platform: NodeJS.Platform; isPackaged: boolean; inApplications: () => boolean }): boolean {
  return input.platform === "darwin" && input.isPackaged && !input.inApplications();
}

/** What an existing copy in Applications makes of the move: it is replaced only when the user says so, and a running copy is brought to the front instead. */
export function conflictAnswer(type: ConflictType, deps: Pick<MoveDeps, "askSync">): boolean {
  if (type === "existsAndRunning") return true;
  const answer = deps.askSync({
    message: "A copy of Tokama is already in Applications. Replace it?",
    detail: "The copy in Applications is moved to the Trash, and this one takes its place.",
    buttons: ["Replace", "Quit"],
  });
  return answer === 0;
}

/**
 * Asks to move the app to Applications and does it on a yes. The app quits afterwards on every
 * path: a move relaunches it from Applications, and a refusal leaves it nowhere it may start an engine.
 */
export async function offerMove(deps: MoveDeps): Promise<void> {
  const answer = await deps.ask({
    message: "Move Tokama to your Applications folder?",
    detail: "Tokama runs its engine from the app itself, so it needs to be in Applications before it starts. Running it from the disk image or Downloads would keep the disk image in use.",
    buttons: ["Move to Applications", "Quit"],
  });
  if (answer !== 0) return;
  // Before anything is replaced: items of an engine that runs from the copy in Applications would lose their files.
  const running = await deps.itemsRunningInApplications().catch(() => undefined);
  if (running !== 0) {
    deps.showErrorBox(
      "Could not replace Tokama",
      running === undefined
        ? "Tokama could not check whether the copy in Applications is running items. Open the copy in Applications, let its items finish or stop them, quit it, then open this copy again."
        : `The copy of Tokama in Applications still has ${running} unfinished ${running === 1 ? "item" : "items"}. Let ${running === 1 ? "it" : "them"} finish or stop ${running === 1 ? "it" : "them"}, then open this copy again.`,
    );
    return;
  }
  try {
    deps.moveToApplicationsFolder({ conflictHandler: (type) => conflictAnswer(type, deps) });
  } catch (error) {
    deps.showErrorBox("Could not move Tokama", String(error));
  }
}
