// The part of TOML a `codex -c key=value` override needs: strings, booleans, integers and inline
// tables. Codex reads a value that does not parse as TOML as a plain string, so a value that is
// built wrong would not fail: it would silently mean something else. Every value is therefore
// built here, with every character that could end a string early escaped.
import { err, ok, type Result } from "../../../kernel/result/index.js";

export type TomlValue = string | boolean | number | { readonly [key: string]: TomlValue };

const NAMED_ESCAPES: Readonly<Record<string, string>> = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };

/** A TOML basic string. Refuses a lone surrogate, which has no UTF-8 form. */
export function tomlString(value: string): Result<string, string> {
  if (!value.isWellFormed()) return err("a text with a broken character cannot be passed to Codex CLI");
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // Control characters, including DEL, are not allowed raw in a basic string.
    out += NAMED_ESCAPES[char] ?? (code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0").toUpperCase()}` : char);
  }
  return ok(`${out}"`);
}

/** A TOML value. Table keys are always quoted. Numbers must be safe integers. */
export function tomlValue(value: TomlValue): Result<string, string> {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return ok(String(value));
  if (typeof value === "number") return Number.isSafeInteger(value) ? ok(String(value)) : err(`${value} is not an integer Codex CLI can be given`);
  const parts: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const quoted = tomlString(key);
    const text = tomlValue(inner);
    if (!quoted.ok) return quoted;
    if (!text.ok) return text;
    parts.push(`${quoted.value}=${text.value}`);
  }
  return ok(parts.length === 0 ? "{}" : `{${parts.join(",")}}`);
}

/** One `-c` override: `key=value`, a dotted key of plain words and the value as TOML. */
export function override(key: string, value: TomlValue): Result<string, string> {
  if (!/^[a-z_]+(\.[a-z_]+)*$/.test(key)) return err(`"${key}" is not a plain Codex CLI setting name`);
  const text = tomlValue(value);
  return text.ok ? ok(`${key}=${text.value}`) : text;
}
