// YAML config text to a validated value, with every problem in plain words at its line.
// Keys in config files are snake_case; zod issues are turned into "base_branch is missing",
// "runs_on 'claud-code' isn't known. Did you mean claude-code?" and the like.
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node } from "yaml";
import type { z } from "zod";
import { err, ok, type Result } from "../../kernel/result/index.js";

/** One thing wrong with a config file. `file` is the name shown to the engineer, not a full path. */
export interface ConfigProblem {
  readonly file: string;
  /** 1-based line in the file, when the problem has one. */
  readonly line?: number;
  readonly message: string;
}

export interface ConfigError {
  readonly problems: readonly ConfigProblem[];
}

/** `agents/reviewer.md line 3: runs_on 'claud-code' isn't known. Did you mean claude-code?` */
export const formatProblem = (problem: ConfigProblem): string =>
  problem.line === undefined ? `${problem.file}: ${problem.message}` : `${problem.file} line ${problem.line}: ${problem.message}`;

/** The format version every config file carries as `format: 1`. */
export const CONFIG_FORMAT = 1;

// A file is a few KB; a deep alias chain is an attack, not a config.
const MAX_ALIASES = 50;

/**
 * Parses YAML `text` and validates it with `schema`. `firstLine` is the file line the text starts
 * on (2 for front matter after an opening `---`), so problems carry file lines. Never throws.
 */
export function parseYaml<S extends z.ZodType>(
  schema: S,
  text: string,
  file: string,
  firstLine = 1,
): Result<z.output<S>, ConfigProblem[]> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const lineAt = (offset: number) => lines.linePos(offset).line + firstLine - 1;
  if (doc.errors.length > 0) {
    return err(doc.errors.map((error) => ({ file, line: lineAt(error.pos[0]), message: `isn't valid YAML: ${yamlMessage(error.message)}` })));
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    return err([{ file, message: `isn't valid YAML: ${yamlMessage((error as Error).message)}` }]);
  }
  const parsed = schema.safeParse(data, { reportInput: true });
  if (parsed.success) return ok(parsed.data);
  const problems = parsed.error.issues.flatMap((issue) => describe(issue, schema).map(({ path, message }) => {
    const node = nodeAt(doc, path);
    return { file, line: node?.range ? lineAt(node.range[0]) : firstLine, message };
  }));
  return err(problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)));
}

// The yaml package's messages name the problem first, then where it is; the line is ours.
const yamlMessage = (message: string): string => clean(message.split(/ at line \d+/)[0]!.trim(), 200);

const MAX_SHOWN = 60;
// JSON.stringify escapes C0 controls; these also reorder or break a terminal line.
const UNSAFE = /[\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text from a file made safe to print: control characters escaped, cut to `max` characters. */
export function clean(text: string, max: number): string {
  const escaped = JSON.stringify(text)
    .slice(1, -1)
    .replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length > max ? `${escaped.slice(0, max)}…` : escaped;
}

/** A raw value for a message: `'claud-code'`, escaped and cut to about 60 characters. */
export const quote = (value: unknown): string =>
  typeof value === "string" ? `'${clean(value, MAX_SHOWN)}'` : clean(JSON.stringify(value) ?? String(value), MAX_SHOWN).replaceAll('\\"', '"');

interface Described {
  /** Path of the node whose line the problem gets. */
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function describe(issue: z.core.$ZodIssue, schema: z.ZodType): Described[] {
  const path = issue.path;
  const label = labelOf(path);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path: [...path, key],
      message: `${quote(key)} isn't a known field.${suggestion(key, keysAt(schema, path))}`,
    }));
  }
  if (path.length === 0) {
    const input = "input" in issue ? issue.input : undefined;
    return [{ path, message: input === null || input === undefined ? "is empty" : "must be a list of settings (key: value lines)" }];
  }
  const input = "input" in issue ? issue.input : undefined;
  if (input === undefined && (issue.code === "invalid_type" || issue.code === "invalid_value")) {
    return [{ path, message: `${label} is missing` }];
  }
  switch (issue.code) {
    case "invalid_type":
      return [{ path, message: `${label} must be ${typeWord(issue.expected)}` }];
    case "invalid_value": {
      const values = issue.values.map(String);
      if (values.length === 1) return [{ path, message: `${label} ${quote(input)} isn't supported. Use ${values[0]}.` }];
      const hint = suggestion(String(input), values) || ` Use ${oneOf(values)}.`;
      return [{ path, message: `${label} ${quote(input)} isn't known.${hint}` }];
    }
    case "too_small":
      return [{ path, message: `${label} must not be empty` }];
    case "too_big":
      return [{ path, message: `${label} must be at most ${String(issue.maximum)} characters` }];
    default:
      return [{ path, message: `${label} ${issue.message}` }];
  }
}

/** The fields the schema knows for the map at `path`, for "Did you mean" on an unknown field. */
function keysAt(schema: z.core.$ZodType, path: readonly PropertyKey[]): string[] {
  let def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
  let index = 0;
  for (;;) {
    if (def.type === "optional" || def.type === "default" || def.type === "nullable") {
      def = (def["innerType"] as z.core.$ZodType)._zod.def as typeof def;
    } else if (def.type === "pipe") {
      def = (def["in"] as z.core.$ZodType)._zod.def as typeof def;
    } else if (index === path.length) {
      break;
    } else if (def.type === "object") {
      const field = (def["shape"] as Record<string, z.core.$ZodType>)[String(path[index++])];
      if (field === undefined) return [];
      def = field._zod.def as typeof def;
    } else if (def.type === "array") {
      index++;
      def = (def["element"] as z.core.$ZodType)._zod.def as typeof def;
    } else {
      return [];
    }
  }
  return def.type === "object" ? Object.keys(def["shape"] as object) : [];
}

/** `runs_on`, or `commands item 2` for a list entry. */
function labelOf(path: readonly PropertyKey[]): string {
  const last = path.at(-1);
  if (typeof last !== "number") return String(last);
  const parent = path.at(-2);
  return parent === undefined ? `item ${last + 1}` : `${String(parent)} item ${last + 1}`;
}


const oneOf = (values: readonly string[]): string =>
  values.length === 1 ? values[0]! : `${values.slice(0, -1).join(", ")} or ${values.at(-1)!}`;

function typeWord(expected: string): string {
  switch (expected) {
    case "string":
      return "text";
    case "number":
    case "int":
      return "a number";
    case "boolean":
      return "true or false";
    case "array":
      return "a list";
    case "object":
      return "a list of settings (key: value lines)";
    default:
      return expected;
  }
}

/** ` Did you mean claude-code?` when one option is close to `input`, else "". */
export function suggestion(input: string, options: readonly string[]): string {
  const typed = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const option of options) {
    const candidate = option.toLowerCase();
    // A prefix counts as close: `codex` for codex-cli.
    const distance = candidate.startsWith(typed) || typed.startsWith(candidate) ? 1 : editDistance(typed, candidate);
    if (distance < bestDistance) [best, bestDistance] = [option, distance];
  }
  return best !== undefined && typed !== "" && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? ` Did you mean ${best}?` : "";
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The deepest node along `path`. For a map entry it is the key, so a problem sits on the line
 * that names the field; for a missing field it is the map that should hold it.
 */
function nodeAt(doc: Document, path: readonly PropertyKey[]): Node | undefined {
  let node: unknown = doc.contents;
  let found = node as Node | undefined;
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => isScalar(item.key) && item.key.value === segment);
      if (pair === undefined) break;
      found = pair.key as Node;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === "number") {
      node = node.items[segment];
      if (node === undefined || node === null) break;
      found = node as Node;
    } else {
      break;
    }
  }
  return found;
}
