import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { templateJsonSchema, templateJsonSchemaText } from "./json-schema.js";

const FILE = join(import.meta.dirname, "..", "..", "..", "schema", "template.schema.json");
const validate = new Ajv({ allErrors: true, strict: false }).compile(templateJsonSchema());

const QUICK = `format: 1
name: Quick
steps:
  - id: work
    name: Work
    agent: builder
    instructions: Do it.
finish: [findings]
`;

describe("the template JSON schema", () => {
  it("matches the checked-in file (run `pnpm build && pnpm --filter @tokama/core schema` after changing the format)", () => {
    expect(readFileSync(FILE, "utf8")).toBe(templateJsonSchemaText());
  });

  it("is a draft 7 schema", () => {
    expect(templateJsonSchema()["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
  });

  it.each([...BUILTIN_TEMPLATES])("accepts the built-in %s", (_id, text) => {
    const ok = validate(parse(text));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("accepts a small template", () => {
    expect(validate(parse(QUICK))).toBe(true);
  });

  it.each([
    ["an unknown field", QUICK.replace("name: Quick", "name: Quick\ncolour: sky"), "additionalProperties"],
    ["a wrong done_when word", QUICK.replace("instructions: Do it.", "instructions: Do it.\n    done_when: tests pass"), "enum"],
    ["no steps", QUICK.replace(/steps:[\s\S]*finish/, "steps: []\nfinish"), "minItems"],
    ["a missing finish", QUICK.replace("finish: [findings]\n", ""), "required"],
    ["format 2", QUICK.replace("format: 1", "format: 2"), "const"],
  ])("refuses %s", (_case, text, keyword) => {
    expect(validate(parse(text))).toBe(false);
    expect(validate.errors?.map((error) => error.keyword)).toContain(keyword);
  });
});
