// "Open the file" on the Checks and Log tabs: opens a saved check log or agent transcript with the
// system's default app. The renderer names the file by item, step, attempt and check number,
// never by a path. The main process asks the engine for the file's path with a query its window
// may not send, and opens it only when it is a regular `.log` or `.txt` file inside that item's
// own folder in the Tokama home, and not a link. `shell.openPath` runs whatever the system opens
// a file with, so a path that passes nothing else must never reach it.
import type { QueryReply } from "@tokama/client";
import { parseQuery, type QueryType } from "@tokama/core";
import { lstatSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative } from "node:path";
import type { AttemptFileName, OpenResult } from "../shared/bridge.js";

export interface AttemptFileDeps {
  /** Sends a query to the engine, main-only ones included. */
  readonly query: (input: unknown) => Promise<QueryReply<QueryType>>;
  /** Tokama's home folder (`~/.tokama`). */
  readonly tokamaHome: string;
  /** Electron's `shell.openPath`: resolves to an error message, or "" when the file opened. */
  readonly openPath: (path: string) => Promise<string>;
}

const EXTENSIONS = new Set([".log", ".txt"]);

/** The real path to open, or why the file may not be opened. `itemDir` is the item's folder. */
export function openableAttemptPath(path: string, itemDir: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
  const refuse = (why: string) => ({ ok: false as const, message: `Tokama does not open ${basename(path) || "this file"}: ${why}.` });
  if (!isAbsolute(path) || normalize(path) !== path) return refuse("its path is not a plain full path");
  if (!EXTENSIONS.has(extname(path))) return refuse("only saved logs (.log, .txt) open from here");
  let real: string;
  let realDir: string;
  try {
    if (lstatSync(path).isSymbolicLink()) return refuse("it is a link");
    real = realpathSync(path);
    if (!lstatSync(real).isFile()) return refuse("it is not a file");
    realDir = realpathSync(itemDir);
  } catch {
    return refuse("it does not exist");
  }
  if (!EXTENSIONS.has(extname(real))) return refuse("only saved logs (.log, .txt) open from here");
  const rel = relative(realDir, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return refuse("it is not in the item's folder");
  return { ok: true, path: real };
}

/** Opens the saved file the engine has for `{ itemId, stepIndex, attempt, file }`; `input` comes from the renderer. */
export async function openAttemptFile(input: unknown, deps: AttemptFileDeps): Promise<OpenResult> {
  if (typeof input !== "object" || input === null) return { ok: false, message: "No file was named." };
  const { itemId, stepIndex, attempt, file } = input as Partial<Record<keyof AttemptFileName, unknown>>;
  const query = parseQuery({ type: "attempt_file", itemId, stepIndex, attempt, file });
  if (!query.ok || query.value.type !== "attempt_file") return { ok: false, message: "No file was named." };
  const reply = await deps.query(query.value);
  if (!reply.ok) return { ok: false, message: reply.error.message };
  const path = (reply.data as { path?: unknown }).path;
  if (typeof path !== "string") return { ok: false, message: "This file is not on this machine." };
  // The folder comes from the validated item id, never from the path the engine sent.
  const checked = openableAttemptPath(path, join(deps.tokamaHome, "items", query.value.itemId));
  if (!checked.ok) return checked;
  const failure = await deps.openPath(checked.path);
  return failure === "" ? { ok: true } : { ok: false, message: `The file did not open: ${failure}` };
}
