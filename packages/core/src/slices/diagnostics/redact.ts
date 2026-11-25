// The diagnostics redactor: cleans an error's stack before it is written, so no path, repo name,
// email, URL, token or user name reaches the file or a reply.
//
// Order matters. Known literals go first, longest first, so a home folder with a space in it is
// still caught. Then URLs, so their slashes are not taken for paths; then emails and token
// shapes; then every remaining path, absolute or relative; then repo and user names; and last
// long hex or base64 runs. The input is cut to INPUT_CAP before any pattern runs, so a huge stack
// cannot make them slow, and the result is cut far shorter, so a secret split at the input cut
// never survives.
import { createHash } from "node:crypto";
import { MAX_STACK_CHARS, MAX_STACK_LINES } from "../../kernel/schemas/index.js";

export interface RedactionContext {
  /**
   * Folders of Tokama's own code. A path inside one keeps its part below the folder, as
   * `<app>/dist/engine.js`, when that part looks like a built file of Tokama's own; otherwise it
   * becomes `<path>` like any other path.
   */
  readonly codeRoots: readonly string[];
  /** Folders that become `<path>` with everything below them: the home folder, Tokama's home, repo folders. */
  readonly paths: readonly string[];
  /** Names that become `<repo>`: repo ids and their folder names. */
  readonly repoNames: readonly string[];
  /** The user's login name, which becomes `<user>`. */
  readonly userName?: string;
}

export const PLACEHOLDERS = ["<app>", "<path>", "<url>", "<email>", "<token>", "<repo>", "<user>"] as const;

const INPUT_CAP = 32_000;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// What a path may hold in a stack line: it ends at whitespace, quotes, brackets or the `:line:col`.
const PATH_CHARS = "[^\\s'\"<>()\\[\\]{},;:*|]";
// Built files of Tokama's own, below a code root; never a path that climbs out with `..`.
const OWN_FILE = /^(?!(?:.*\/)?\.\.(?:\/|$))(?:(?:apps|packages)\/[a-z0-9-]+\/)?(?:dist|out)\/[A-Za-z0-9._/-]+\.[cm]?js$|^node_modules\/[A-Za-z0-9@._/-]+\.[cm]?js$/;

// The lookbehinds start a match only at the start of a run, which keeps these linear on long input.
const URL_PATTERN = /(?<![a-zA-Z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>()]+/g;
// Letters and digits of any script: a name such as `jürgen.müller@kanzlei-müller.de` is caught too.
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const BEARER = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Also quoted, as in JSON: `"password":"..."`, `token: '...'`.
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|auth)(["']?\s*[=:]\s*["']?)[^\s'",;}]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s'"<>()|*?]*/g;
const UNC_PATH = /\\\\[^\s'"<>()|*?]+/g;
// Not inside a word of any script, and not after `<app>`, whose built-file path is kept.
const ABSOLUTE_PATH = new RegExp(`(?<![\\p{L}\\p{N}_.~/\\\\-])(?<!<app>)~?/${PATH_CHARS}+`, "gu");
// Relative paths: two or more parts with `/` or `\`, in any script. Not right after `node:`, so
// `node:internal/...` stays, and not inside `<app>/...`.
const RELATIVE_PATH = /(?<![\p{L}\p{N}_.+=/\\<-])(?<!node:)[\p{L}\p{N}_.+=-]+(?:[/\\][\p{L}\p{N}_.+=-]+)+[/\\]?/gu;
const LONG_HEX = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const LONG_BASE64 = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/=_-])/g;

/** Cleans any text by the rules above. Pure; never throws. */
export function redactText(input: string, context: RedactionContext): string {
  let text = input.slice(0, INPUT_CAP);

  for (const root of byLength(context.codeRoots)) {
    const pattern = new RegExp(`(?:file://)?${escape(trimSlash(root))}/(${PATH_CHARS}*)`, "g");
    text = text.replace(pattern, (_match, rel: string) => (OWN_FILE.test(rel) ? `<app>/${rel}` : "<path>"));
  }
  // Other file URLs are paths: they get the path rules and keep their `:line:col`.
  text = text.replace(/\bfile:\/\//g, "");
  text = text.replace(URL_PATTERN, "<url>");
  for (const path of byLength(context.paths)) {
    // It must end at a separator or a delimiter, so `/src/api` does not match the start of `/src/api-gateway`.
    text = text.replace(new RegExp(`${escape(trimSlash(path))}(?:[/\\\\]${PATH_CHARS}*)?(?![^\\s'"<>()\\[\\]{},;:*|/\\\\])`, "g"), "<path>");
  }
  text = text.replace(EMAIL, "<email>");
  for (const shape of TOKEN_SHAPES) text = text.replace(shape, "<token>");
  text = text.replace(BEARER, "$1 <token>");
  text = text.replace(SECRET_ASSIGNMENT, "$1$2<token>");
  text = text.replace(WINDOWS_PATH, "<path>").replace(UNC_PATH, "<path>");
  text = text.replace(ABSOLUTE_PATH, "<path>");
  text = text.replace(RELATIVE_PATH, "<path>");
  // Names may also be words of the message; they never touch a placeholder.
  for (const name of byLength(context.repoNames)) text = text.replace(wordPattern(name), "<repo>");
  if (context.userName !== undefined && context.userName !== "") text = text.replace(wordPattern(context.userName), "<user>");
  text = text.replace(LONG_HEX, "<token>");
  text = text.replace(LONG_BASE64, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "<token>" : run));
  // A path right after a placeholder (`<path>/x`) became a second placeholder; keep one.
  return text.replace(/(<path>|<url>|<email>|<token>)(?:<path>)+/g, "$1");
}

/** A stack, cleaned and cut to MAX_STACK_LINES lines and MAX_STACK_CHARS characters. */
export function cleanStack(stack: string, context: RedactionContext): string {
  const lines = redactText(stack, context)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(0, MAX_STACK_LINES);
  return lines.join("\n").slice(0, MAX_STACK_CHARS);
}

/**
 * A stable id for the same failure: the error's name and its first frames without line and
 * column numbers, so a rebuild or an edit elsewhere in a file keeps it. Without frames, the first
 * line with its digits removed. Takes a cleaned stack.
 */
export function fingerprint(name: string, cleanedStack: string): string {
  const lines = cleanedStack.split("\n");
  const frames = lines
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 8)
    .map((line) => line.trim().replace(/:\d+(?::\d+)?(?=\)?$)/, ""));
  const basis = frames.length > 0 ? frames : [(lines[0] ?? "").replace(/\d+/g, "#")];
  return createHash("sha256").update([name, ...basis].join("\n")).digest("hex").slice(0, 16);
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The name and raw stack of anything thrown: an Error (with one level of `cause`) or any other value. */
export function describeThrown(thrown: unknown): { name: string; stack: string } {
  if (thrown instanceof Error) {
    const name = ERROR_NAME.test(thrown.name) ? thrown.name : "Error";
    let stack = typeof thrown.stack === "string" && thrown.stack !== "" ? thrown.stack : `${name}: ${safeString(thrown.message)}`;
    if (thrown.cause !== undefined) {
      const cause = thrown.cause instanceof Error ? thrown.cause.stack ?? `${thrown.cause.name}: ${thrown.cause.message}` : safeString(thrown.cause);
      stack += `\nCaused by: ${cause}`;
    }
    return { name, stack };
  }
  return { name: "NonError", stack: `NonError: ${safeString(thrown)}` };
}

/** The error name at the start of a reported stack (`TypeError: ...`); `Error` when there is none. */
export function nameOfStack(stack: string): string {
  const first = /^([A-Za-z][A-Za-z0-9_]{0,63})(?::|$)/.exec(stack.trimStart().split("\n")[0] ?? "")?.[1];
  return first !== undefined && ERROR_NAME.test(first) ? first : "Error";
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "(unprintable value)";
  }
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, "") : path;
}

/** Longest first, so `/home/a/b` is replaced before `/home/a`. Empty and root-only entries are skipped. */
function byLength(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => trimSlash(value).replace(/[/\\]/g, "") !== "").sort((a, b) => b.length - a.length);
}

function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_.<-])${escape(name)}(?![A-Za-z0-9_>-])`, "gi");
}
