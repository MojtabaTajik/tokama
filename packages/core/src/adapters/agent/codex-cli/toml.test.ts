import { describe, expect, it } from "vitest";
import { override, tomlString, tomlValue } from "./toml.js";

const value = (input: Parameters<typeof tomlValue>[0]) => {
  const result = tomlValue(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("tomlString", () => {
  it("quotes a plain text and keeps non-ASCII characters", () => {
    expect(value("never")).toBe('"never"');
    expect(value("Zürich ✓ 日本")).toBe('"Zürich ✓ 日本"');
  });

  it("escapes the characters that would end the string or break the line", () => {
    expect(value('say "hi"\\now')).toBe('"say \\"hi\\"\\\\now"');
    expect(value("a\nb\tc\r\f\b")).toBe('"a\\nb\\tc\\r\\f\\b"');
  });

  it("escapes every other control character, DEL included, as \\uXXXX", () => {
    expect(value("\u0000\u0001\u001f\u007f")).toBe('"\\u0000\\u0001\\u001F\\u007F"');
  });

  it("round-trips through a real TOML reader's rules: no raw control character or unescaped quote is left", () => {
    const hostile = 'a"\n]}\n[x]\ny = "z\\"\u0007 \u{1F600}';
    const out = value(hostile);
    expect([...out].filter((char) => (char.codePointAt(0) ?? 0) < 0x20 || char === "\u007f")).toEqual([]);
    // Decode the way TOML does: the escapes above are the only ones we write.
    const decoded = out
      .slice(1, -1)
      .replace(/\\(u[0-9A-F]{4}|.)/g, (_all, code: string) => (code.startsWith("u") ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" }[code] ?? "?")));
    expect(decoded).toBe(hostile);
  });

  it("refuses a lone surrogate", () => {
    expect(tomlString("a\ud800b")).toEqual({ ok: false, error: expect.stringContaining("broken character") });
    expect(tomlString("\u{1F600}").ok).toBe(true);
  });
});

describe("tomlValue", () => {
  it("writes booleans and integers", () => {
    expect(value(false)).toBe("false");
    expect(value(true)).toBe("true");
    expect(value(0)).toBe("0");
    expect(tomlValue(1.5).ok).toBe(false);
    expect(tomlValue(Number.NaN).ok).toBe(false);
    expect(tomlValue(2 ** 60).ok).toBe(false);
  });

  it("writes an inline table with every key quoted, nested tables included", () => {
    expect(value({ "~/.ssh": "none", ":workspace_roots": { "**/*.env": "none" } })).toBe('{"~/.ssh"="none",":workspace_roots"={"**/*.env"="none"}}');
    expect(value({})).toBe("{}");
    expect(value({ 'a"b': "c" })).toBe('{"a\\"b"="c"}');
  });

  it("passes up the error of a value or a key that cannot be written", () => {
    expect(tomlValue({ ok: "fine", bad: "\ud800" }).ok).toBe(false);
    expect(tomlValue({ "\ud800": "x" }).ok).toBe(false);
  });
});

describe("override", () => {
  it("joins a plain dotted key and the value", () => {
    expect(override("approval_policy", "never")).toEqual({ ok: true, value: 'approval_policy="never"' });
    expect(override("permissions.tokama.network.enabled", false)).toEqual({ ok: true, value: "permissions.tokama.network.enabled=false" });
  });

  it("refuses a key that is not a plain setting name", () => {
    for (const key of ["", "a=b", "a b", "a.", ".a", 'a."b"', "A"]) expect(override(key, "x").ok).toBe(false);
  });
});
