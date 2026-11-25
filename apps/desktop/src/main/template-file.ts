// "Open in editor" on the Templates page: opens a template file with the system's default app.
// The renderer names the file by where the engine found it (origin and repo-relative path), never
// by a path; the main process asks the engine for the file's path, then opens it only when it is
// a regular `.yaml` file inside a `.tokama` folder or inside the Tokama home, and not a link.
// `shell.openPath` runs whatever the system opens a file with, so a path that passes nothing else
// must never reach it.
import { lstatSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, normalize, relative, sep } from "node:path";
import type { OpenResult } from "../shared/bridge.js";
import type { EngineApi } from "./api.js";

export interface TemplateFileDeps {
  readonly api: EngineApi;
  /** Tokama's home folder (`~/.tokama`). */
  readonly tokamaHome: string;
  /** Electron's `shell.openPath`: resolves to an error message, or "" when the file opened. */
  readonly openPath: (path: string) => Promise<string>;
}

const TOKAMA_FOLDER = ".tokama";

/** The real path to open, or why the file may not be opened. */
export function openablePath(path: string, tokamaHome: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
  const refuse = (why: string) => ({ ok: false as const, message: `Tokama does not open ${basename(path) || path}: ${why}.` });
  if (!isAbsolute(path) || normalize(path) !== path) return refuse("its path is not a plain full path");
  if (extname(path) !== ".yaml") return refuse("only template files (.yaml) open from here");
  let real: string;
  try {
    if (lstatSync(path).isSymbolicLink()) return refuse("it is a link");
    real = realpathSync(path);
    if (!lstatSync(real).isFile()) return refuse("it is not a file");
  } catch {
    return refuse("it does not exist");
  }
  if (extname(real) !== ".yaml") return refuse("only template files (.yaml) open from here");
  if (!inTokamaFolder(real) && !inside(real, tokamaHome)) return refuse(`it is not in a repo's ${TOKAMA_FOLDER} folder or the Tokama home`);
  return { ok: true, path: real };
}

/** Whether some folder above the file is named exactly `.tokama`. */
function inTokamaFolder(real: string): boolean {
  return real.split(sep).slice(0, -1).includes(TOKAMA_FOLDER);
}

function inside(real: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Opens the template file the engine has at `{ origin, file }`; `input` comes from the renderer. */
export async function openTemplateFile(input: unknown, deps: TemplateFileDeps): Promise<OpenResult> {
  if (typeof input !== "object" || input === null) return { ok: false, message: "No template file was named." };
  const { origin, file } = input as { origin?: unknown; file?: unknown };
  const reply = await deps.api.query({ type: "template_detail", origin, file });
  if (!reply.ok) return { ok: false, message: reply.error.message };
  const path = (reply.data as { path?: unknown }).path;
  if (typeof path !== "string") return { ok: false, message: "This template has no file on this machine to open." };
  const checked = openablePath(path, deps.tokamaHome);
  if (!checked.ok) return checked;
  const failure = await deps.openPath(checked.path);
  return failure === "" ? { ok: true } : { ok: false, message: `The file did not open: ${failure}` };
}
