import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTemplateRecord } from "./index.js";
import { migrateRecord, migrateTemplateRecord, TEMPLATE_RECORD_STEPS, type TemplateRecordStep } from "./template-migrate.js";
import { TEMPLATE_SCHEMA_VERSION } from "./template.js";

// A real version 1 snapshot: the template of an item log's first line, with the hash of its JSON.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "testing", "fixtures", "template-snapshot-v1.json"), "utf8")) as {
  sha256: string;
  record: Record<string, unknown>;
};

const NEWER = "This item was started by a newer Tokama (template record version 99). Update Tokama to open it.";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe("a stored version 1 record", () => {
  it("passes the migration as it is and still parses", () => {
    const migrated = migrateTemplateRecord(fixture.record);
    expect(migrated).toEqual({ ok: true, value: fixture.record });
    expect(migrated.ok && migrated.value).toBe(fixture.record);
    const parsed = parseTemplateRecord(fixture.record);
    expect(parsed.ok && parsed.value).toEqual(fixture.record);
  });
});

describe("a record from a newer Tokama", () => {
  const newer = { ...fixture.record, schemaVersion: 99 };

  it("is refused with a message that says what to do, and without throwing", () => {
    const expected = { ok: false, error: { issues: [{ path: "schemaVersion", message: NEWER }], newerVersion: 99 } };
    expect(migrateTemplateRecord(newer)).toEqual(expected);
    expect(parseTemplateRecord(newer)).toEqual(expected);
  });
});

describe("input the migration cannot place", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["text", "x"],
    ["no schemaVersion", { ref: "builtin/x" }],
    ["a text schemaVersion", { schemaVersion: "1" }],
    ["schemaVersion 0", { schemaVersion: 0 }],
    ["a fractional schemaVersion", { schemaVersion: 1.5 }],
  ])("hands %s on unchanged, for the strict parse to report", (_label, input) => {
    expect(migrateTemplateRecord(input)).toEqual({ ok: true, value: input });
    const parsed = parseTemplateRecord(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.newerVersion).toBeUndefined();
  });
});

describe("the chain", () => {
  const addField: TemplateRecordStep = (record) => ({ ...record, added: true });
  const renameField: TemplateRecordStep = ({ added, ...rest }) => ({ ...rest, renamed: added });
  const steps = { 1: addField, 2: renameField };

  it("runs the steps from the stored version up, in order, and sets the version", () => {
    expect(migrateRecord(deepFreeze({ schemaVersion: 1, name: "x" }), steps, 3)).toEqual({ ok: true, value: { schemaVersion: 3, name: "x", renamed: true } });
    expect(migrateRecord(deepFreeze({ schemaVersion: 2, added: false }), steps, 3)).toEqual({ ok: true, value: { schemaVersion: 3, renamed: false } });
  });

  it("runs nothing for a record that is current, and returns the same object", () => {
    const current = { schemaVersion: 3 };
    const migrated = migrateRecord(current, steps, 3);
    expect(migrated.ok && migrated.value).toBe(current);
  });

  it("never changes its input", () => {
    const input = deepFreeze({ schemaVersion: 1, nested: { list: [1] } });
    const copy = structuredClone(input);
    migrateRecord(input, steps, 3);
    expect(input).toEqual(copy);
  });

  it("names the version a missing step would have upgraded from", () => {
    expect(migrateRecord({ schemaVersion: 1 }, {}, 2)).toEqual({
      ok: false,
      error: { issues: [{ path: "schemaVersion", message: "No migration from template record version 1." }] },
    });
  });

  it("has a step for every version below the current one, and none above", () => {
    for (let version = 1; version < TEMPLATE_SCHEMA_VERSION; version++) expect(TEMPLATE_RECORD_STEPS[version]).toBeTypeOf("function");
    for (const key of Object.keys(TEMPLATE_RECORD_STEPS)) expect(Number(key)).toBeLessThan(TEMPLATE_SCHEMA_VERSION);
  });
});
