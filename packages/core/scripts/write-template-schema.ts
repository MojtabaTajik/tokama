// Writes the template JSON schema to `schema/template.schema.json` from the built package, so
// changing the template format is followed by `pnpm build && pnpm --filter @tokama/core schema`.
// The file is checked in; a test fails when it no longer matches the format.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { templateJsonSchemaText } from "../dist/slices/templates/index.js";

const file = join(import.meta.dirname, "..", "schema", "template.schema.json");
writeFileSync(file, templateJsonSchemaText());
process.stdout.write(`wrote ${file}\n`);
