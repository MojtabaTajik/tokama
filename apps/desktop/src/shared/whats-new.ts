// The release note of one version, `whats-new/<version>.md`: what a person who uses Tokama will
// notice. The app shows it once after an update and lists it in About; the release workflow
// publishes the same file as the release notes. A note is written by hand, in plain words:
//
//   ---
//   version: 0.2.0
//   date: 2026-12-03
//   security: true          (optional, default false)
//   ---
//
//   ## Sounds for notifications
//
//   A soft gecko chirp when work needs you.
//
//   Where: Pick it in Settings → Notifications
//
//   ## See what a finished run changed
//
//   The Diff tab now shows the exact commit.
//
//   + 12 smaller fixes
//
// The front matter has these three keys and no others. The body is blocks separated by blank
// lines: up to 3 highlights, each a `## ` title (1-60 characters), one sentence (1-200) and
// optionally a `Where:` line (1-80), then optionally one last `+ N smaller fixes` line. A note
// says something: a highlight, `security: true` or a fix count. There is no other markup: no
// links, lists, HTML or inline formatting, and "<" and ">" are not allowed. A file is at most
// 8 KiB of UTF-8, with LF or CRLF line ends and no tabs or other control characters.
//
// The release check runs this file on a runner where nothing is installed, with Node's type
// stripping: it imports nothing and uses only syntax that stripping keeps working.

export interface Highlight {
  readonly title: string;
  readonly text: string;
  readonly where?: string;
}

export interface Note {
  readonly version: string;
  /** `YYYY-MM-DD`, as written. */
  readonly date: string;
  readonly security: boolean;
  readonly highlights: readonly Highlight[];
  /** The number in "+ N smaller fixes"; 0 when the note has no such line. */
  readonly fixes: number;
}

export type ParseResult = { readonly ok: true; readonly note: Note } | { readonly ok: false; readonly problems: readonly string[] };

export type NoteKind = "highlights" | "security" | "fixes";

export const MAX_NOTE_BYTES = 8 * 1024;
export const MAX_HIGHLIGHTS = 3;
export const MAX_TITLE = 60;
export const MAX_SENTENCE = 200;
export const MAX_WHERE = 80;
export const MAX_FIXES = 999;

/** The one line a security note shows, in the app and in the release notes. */
export const SECURITY_LINE = "Fixes a security problem, nothing to do.";

/** The last line of a note, and of the card: "+ 1 smaller fix", "+ 12 smaller fixes". */
export const fixesLine = (count: number): string => `+ ${count} smaller ${count === 1 ? "fix" : "fixes"}`;

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const KEYS = ["version", "date", "security"];
/** A control character other than the line break, which has split the lines already. */
const hasControl = (line: string): boolean => [...line].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/** Whether `value` is a version as notes name them: three numbers, no leading zeros. */
export const isVersion = (value: unknown): value is string => typeof value === "string" && VERSION.test(value);

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. Both must pass `isVersion`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const isDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const length = (text: string): number => [...text].length;

interface Block {
  /** The line number (from 1) of its first line. */
  readonly line: number;
  readonly lines: readonly string[];
}

/** The note in `text`, or every problem found, each naming its line. With `fileName`, the version must be the file's name. Never throws. */
export function parseNote(text: string, fileName?: string): ParseResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_NOTE_BYTES) return { ok: false, problems: [`the file is ${bytes} bytes, at most ${MAX_NOTE_BYTES}`] };
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const problems: string[] = [];
  const bad = lines.findIndex(hasControl);
  if (bad >= 0) return { ok: false, problems: [`line ${bad + 1}: tabs and control characters are not allowed`] };

  if (lines[0] !== "---") return { ok: false, problems: ['line 1: a note starts with a "---" line and its front matter'] };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { ok: false, problems: ['the front matter has no closing "---" line'] };

  const found = new Map<string, string>();
  for (let index = 1; index < close; index++) {
    const match = /^([a-z]+): (.*)$/.exec(lines[index] ?? "");
    const key = match?.[1];
    if (match === null || key === undefined) problems.push(`line ${index + 1}: expected "key: value"`);
    else if (!KEYS.includes(key)) problems.push(`line ${index + 1}: unknown key "${key}"`);
    else if (found.has(key)) problems.push(`line ${index + 1}: "${key}" appears twice`);
    else found.set(key, (match[2] ?? "").trim());
  }
  const version = found.get("version");
  const date = found.get("date");
  const securityText = found.get("security");
  if (version === undefined) problems.push('the front matter has no "version"');
  else if (!isVersion(version)) problems.push(`version "${version}" is not x.y.z (digits, no leading zeros)`);
  else if (fileName !== undefined && fileName !== `${version}.md`) problems.push(`version ${version} does not match the file name ${fileName}`);
  if (date === undefined) problems.push('the front matter has no "date"');
  else if (!isDate(date)) problems.push(`date "${date}" is not a real YYYY-MM-DD day`);
  if (securityText !== undefined && securityText !== "true" && securityText !== "false") problems.push(`security "${securityText}" is not true or false`);
  const security = securityText === "true";

  const blocks: Block[] = [];
  let open: { line: number; lines: string[] } | undefined;
  for (let index = close + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      open = undefined;
    } else if (open === undefined) {
      open = { line: index + 1, lines: [line] };
      blocks.push(open);
    } else {
      open.lines.push(line);
    }
  }

  const highlights: Highlight[] = [];
  let fixes = 0;
  /** A problem when `value` is outside 1..max characters or holds "<" or ">". */
  const checkText = (line: number, what: string, value: string, max: number): void => {
    const size = length(value);
    if (size < 1 || size > max) problems.push(`line ${line}: ${what} is ${size} characters, ${size < 1 ? "at least 1" : `at most ${max}`}`);
    if (/[<>]/.test(value)) problems.push(`line ${line}: "<" and ">" are not allowed in ${what}`);
  };
  const startsBlock = (block: Block | undefined): boolean => block !== undefined && /^(## |Where:|\+)/.test(block.lines[0] ?? "");

  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    const first = block?.lines[0] ?? "";
    if (block === undefined) break;
    index++;
    if (first.startsWith("+")) {
      const match = /^\+ (\d+) smaller fix(?:es)?$/.exec(first);
      const count = Number(match?.[1]);
      if (block.lines.length > 1) problems.push(`line ${block.line}: the fixes line stands alone`);
      else if (match === null) problems.push(`line ${block.line}: the fixes line reads "+ N smaller fixes"`);
      else if (count < 1 || count > MAX_FIXES) problems.push(`line ${block.line}: the fix count is ${match[1]}, from 1 to ${MAX_FIXES}`);
      else if (first !== fixesLine(count)) problems.push(`line ${block.line}: write "${fixesLine(count)}"`);
      else fixes = count;
      if (index < blocks.length) problems.push(`line ${block.line}: the fixes line must be the last block`);
    } else if (first.startsWith("## ")) {
      const title = first.slice(3).trim();
      checkText(block.line, "a highlight's title", title, MAX_TITLE);
      if (block.lines.length > 1) problems.push(`line ${block.line}: put a blank line after the title`);
      if (highlights.length >= MAX_HIGHLIGHTS) problems.push(`line ${block.line}: at most ${MAX_HIGHLIGHTS} highlights`);
      const sentence = blocks[index];
      let sentenceText = "";
      if (sentence === undefined || startsBlock(sentence)) {
        problems.push(`line ${block.line}: the highlight "${title}" has no sentence`);
      } else {
        sentenceText = sentence.lines[0] ?? "";
        if (sentence.lines.length > 1) problems.push(`line ${sentence.line}: a highlight's sentence is one line`);
        checkText(sentence.line, "a highlight's sentence", sentenceText, MAX_SENTENCE);
        index++;
      }
      let where: string | undefined;
      const place = blocks[index];
      if (place?.lines[0]?.startsWith("Where:") === true) {
        where = (place.lines[0] ?? "").slice("Where:".length).trim();
        if (place.lines.length > 1) problems.push(`line ${place.line}: the "Where:" line stands alone`);
        checkText(place.line, "a highlight's Where line", where, MAX_WHERE);
        index++;
      }
      if (highlights.length < MAX_HIGHLIGHTS) highlights.push({ title, text: sentenceText, ...(where === undefined ? {} : { where }) });
    } else if (first.startsWith("#")) {
      problems.push(`line ${block.line}: only "## " headings are allowed`);
    } else {
      problems.push(`line ${block.line}: expected a "## " title, "Where:" or the fixes line, found "${[...first].slice(0, 30).join("")}"`);
    }
  }

  if (highlights.length === 0 && !security && fixes === 0 && problems.length === 0) problems.push("the note says nothing: add a highlight, security: true or a fix count");
  if (problems.length > 0 || version === undefined || date === undefined) return { ok: false, problems };
  return { ok: true, note: { version, date, security, highlights, fixes } };
}

/** What kind of update a note describes: with highlights, a security fix alone, or smaller fixes only. */
export function noteKind(note: Note): NoteKind {
  if (note.highlights.length > 0) return "highlights";
  return note.security ? "security" : "fixes";
}

/** The note as the body of a GitHub release, in Markdown, without the front matter. */
export function releaseNotes(note: Note): string {
  const blocks: string[] = [];
  if (note.security) blocks.push(`**Security:** ${SECURITY_LINE}`);
  for (const highlight of note.highlights) {
    blocks.push(`### ${highlight.title}`, highlight.text);
    if (highlight.where !== undefined) blocks.push(`Where: ${highlight.where}`);
  }
  if (note.fixes > 0) blocks.push(fixesLine(note.fixes));
  return blocks.join("\n\n");
}
