// The JSON schema of the template file format, for editor autocomplete and inline errors. It
// covers the shape of the file; the rules that need the agents and the other steps (unknown
// agents, back targets, cloud data rules) are checked only by the engine.
import { z } from "zod";
import { TemplateFileSchema } from "./format.js";

export function templateJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(TemplateFileSchema, { io: "input", target: "draft-2020-12" }),
    title: "Tokama template",
  };
}
