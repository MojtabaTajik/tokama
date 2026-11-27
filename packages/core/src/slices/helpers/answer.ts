// Reads a helper's answer from the agent's reply: finds the one JSON object in it, checks it
// against the answer's shape and the helper's own rule, and writes the note for a second try. A
// note never repeats what the agent wrote: it says which part of the shape was wrong, by path.
import { cutText } from "../../kernel/text/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { type HelperResult, HelperResultSchemas } from "../../kernel/schemas/index.js";
import type { HelperDefinition } from "./definition.js";

/** A reply longer than this is refused unread. */
export const MAX_REPLY_BYTES = 32 * 1024;
const MAX_PATHS = 5;
const MAX_PATH_CHARS = 120;
/** Starts of an object tried before the search for one gives up. */
const MAX_STARTS = 64;

export type AnswerProblem =
  | { readonly kind: "too_long" }
  | { readonly kind: "no_json" }
  | { readonly kind: "many_json" }
  /** The agent answered with a JSON Schema (the shape it was shown) instead of an answer. */
  | { readonly kind: "schema_echo" }
  /** `paths` are places in the answer's shape, e.g. `checks.0.minutes`; `(answer)` is the object itself. */
  | { readonly kind: "wrong_shape"; readonly paths: readonly string[] }
  | { readonly kind: "rule"; readonly message: string };

/** The end of the object that starts at `start` (a `{`), or -1 when it never closes. Braces inside strings do not count. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON text parsed, or undefined when it is not one object. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sortKeys) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value;

/**
 * The distinct JSON objects in a reply: the whole reply when it is one object, otherwise every
 * top-level object in it (a fenced block, or an object between sentences). The same object found
 * twice counts once.
 */
function objectsIn(reply: string): Record<string, unknown>[] {
  const whole = parseObject(reply.trim());
  if (whole !== undefined) return [whole];
  const found = new Map<string, Record<string, unknown>>();
  let failed = 0;
  for (let at = reply.indexOf("{"); at !== -1 && failed < MAX_STARTS; at = reply.indexOf("{", at + 1)) {
    const end = objectEnd(reply, at);
    const object = end === -1 ? undefined : parseObject(reply.slice(at, end + 1));
    if (object === undefined) {
      failed++;
      continue;
    }
    found.set(JSON.stringify(sortKeys(object)), object);
    // The next search starts after this object.
    at = end;
  }
  return [...found.values()];
}

/** A place in the shape written for people. Segments that are not plain names (a key the agent invented) become `*`. */
const pathText = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? "(answer)" : cutText(path.map((segment) => (/^[A-Za-z0-9_]{1,40}$/.test(String(segment)) ? String(segment) : "*")).join("."), MAX_PATH_CHARS);

/** The answer in `reply`, or the first thing wrong with it. */
export function readAnswer(definition: HelperDefinition, reply: string): Result<HelperResult, AnswerProblem> {
  if (Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES) return err({ kind: "too_long" });
  const objects = objectsIn(reply);
  if (objects.length === 0) return err({ kind: "no_json" });
  if (objects.length > 1) return err({ kind: "many_json" });
  const object = { ...objects[0] };
  // A JSON Schema has `type` and `properties` at the top, and no helper's answer has those keys.
  if ("type" in object && "properties" in object) return err({ kind: "schema_echo" });
  // `$schema` is a meta key a model copies from the schema it saw: harmless, so it is dropped; every other key stays strict.
  delete object["$schema"];
  const parsed = HelperResultSchemas[definition.id].safeParse(object);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => pathText(issue.path)))].slice(0, MAX_PATHS);
    return err({ kind: "wrong_shape", paths });
  }
  const rule = definition.check?.(parsed.data);
  return rule === undefined ? ok(parsed.data) : err({ kind: "rule", message: cutText(rule, 200) });
}

/** What goes back to the agent for a second try. It says what was wrong, never what the agent wrote. */
export function retryNote(problem: AnswerProblem): string {
  switch (problem.kind) {
    case "too_long":
      return "Your last answer was too long. Answer again with a shorter JSON object.";
    case "no_json":
      return "Your last answer held no JSON object. Answer with exactly one JSON object and nothing else.";
    case "many_json":
      return "Your last answer held more than one JSON object. Answer with exactly one JSON object and nothing else.";
    case "schema_echo":
      return "You replied with the schema. Reply with the answer object, like the example, not the schema.";
    case "wrong_shape":
      return `Your last answer did not match the shape. These parts were wrong: ${problem.paths.join(", ")}. Answer again with one JSON object that matches the shape.`;
    case "rule":
      return `Your last answer broke a rule: ${problem.message} Answer again with one JSON object that follows it.`;
  }
}
