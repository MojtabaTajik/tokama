// The templates and template_detail queries: every template file the engine loaded, as list
// entries, and one file in full. The caller loads the files; this only shapes the replies.
import { join } from "node:path";
import { cutText, MAX_MESSAGE_BYTES, MAX_TEMPLATE_ENTRIES, type TemplateDetail, type TemplateEntry, type TemplateFileKey, type TemplateLoad, type TemplateView } from "@tokama/core";

const MAX_PROBLEMS = 100;
const MAX_WARNINGS = 50;
const MAX_MESSAGE = 1000;
const BUILTIN = "builtin";
/** Room for the reply's envelope (version, request id, framing) around the detail. */
const ENVELOPE_BYTES = 4 * 1024;

export interface TemplateFiles {
  /** Every template file, loaded or not. */
  readonly loads: readonly TemplateLoad[];
  /** A repo's folder on this machine; undefined for a sample repo, which has none. */
  readonly repoPath: (repoId: string) => string | undefined;
}

export function keyOf(load: TemplateLoad): TemplateFileKey {
  if (!load.ok) return { origin: load.origin, file: load.file };
  const { source, ref } = load.template;
  return source.kind === "repo" ? { origin: source.repoId, file: source.file } : { origin: BUILTIN, file: ref };
}

export function templateEntries(files: TemplateFiles): TemplateEntry[] {
  return files.loads.slice(0, MAX_TEMPLATE_ENTRIES).map((load) => entryOf(load, files));
}

/** The file at `key`, or undefined when the engine found none there. */
export function templateDetail(files: TemplateFiles, key: TemplateFileKey): TemplateDetail | undefined {
  const load = files.loads.find((candidate) => sameKey(keyOf(candidate), key));
  if (load === undefined) return undefined;
  const entry = entryOf(load, files);
  const detail: TemplateDetail = {
    entry,
    template: load.ok ? viewOf(load.template) : null,
    problems: load.ok ? [] : load.problems.slice(0, MAX_PROBLEMS).map((problem) => ({ line: problem.line, message: cap(problem.message) })),
    warnings: load.ok ? load.warnings.slice(0, MAX_WARNINGS).map(cap) : [],
    text: load.text ?? null,
    textTooLarge: false,
    path: entry.openable ? fullPath(files, entry) : null,
  };
  // JSON can make text up to six times longer (control characters), so a file within the read
  // limit can still overflow a message. The problems matter more than the text: drop the text.
  if (Buffer.byteLength(JSON.stringify(detail)) + ENVELOPE_BYTES > MAX_MESSAGE_BYTES) return { ...detail, text: null, textTooLarge: true };
  return detail;
}

function entryOf(load: TemplateLoad, files: TemplateFiles): TemplateEntry {
  const key = keyOf(load);
  // Only a template file read from a repo folder on this machine can be opened; not the folder
  // itself when it could not be listed, and never a built-in or a sample repo's file.
  const openable = key.origin !== BUILTIN && key.file.endsWith(".yaml") && load.text !== undefined && files.repoPath(key.origin) !== undefined;
  if (!load.ok) return { ...key, ...(load.ref !== undefined && { ref: load.ref }), problemCount: load.problems.length, openable };
  const { ref, name, icon, color } = load.template;
  return { ...key, ref, name, ...(icon !== undefined && { icon }), ...(color !== undefined && { color }), problemCount: 0, openable };
}

function fullPath(files: TemplateFiles, key: TemplateFileKey): string | null {
  const root = files.repoPath(key.origin);
  return root === undefined ? null : join(root, ...key.file.split("/"));
}

/** The record without the instruction text, which the page does not show and can be long. */
function viewOf(template: Extract<TemplateLoad, { ok: true }>["template"]): TemplateView {
  return {
    ...template,
    steps: template.steps.map(({ instructions, ...step }) => ({ ...step, ...(instructions.file !== undefined && { instructionsFile: instructions.file }) })),
  };
}

const sameKey = (a: TemplateFileKey, b: TemplateFileKey): boolean => a.origin === b.origin && a.file === b.file;
const cap = (message: string): string => cutText(message, MAX_MESSAGE);
