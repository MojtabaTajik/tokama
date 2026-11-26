// The JSON schema of the template file format, for editor autocomplete and inline errors. It
// covers the shape of the file; the rules that need the agents and the other steps (unknown
// agents, back targets, cloud data rules) are checked only by the engine.
// Draft 7, the draft that editors' YAML and JSON support handles best.
import { z } from "zod";
import { TEMPLATE_FORMAT, TemplateFileSchema } from "./format.js";

/** The checked-in schema files: one per format, and `template.json` for the newest format. */
export const TEMPLATE_SCHEMA_FILES = [`template-${TEMPLATE_FORMAT}.json`, "template.json"] as const;

export function templateJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(TemplateFileSchema, { io: "input", target: "draft-7" }),
    title: "Tokama template",
    description: "A Tokama template: `.tokama/templates/<id>.yaml` in a repo.",
  };
}

/** The schema as the checked-in file holds it: two-space JSON with a final newline. */
export const templateJsonSchemaText = (): string => `${JSON.stringify(templateJsonSchema(), null, 2)}\n`;
