// Writes the template JSON schema to each file of `TEMPLATE_SCHEMA_FILES` in `schema/` from the
// built package, so changing the template format is followed by
// `pnpm build && pnpm --filter @tokama/core schema`.
// The files are checked in; a test fails when one no longer matches the format.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_SCHEMA_FILES, templateJsonSchemaText } from "../dist/slices/templates/index.js";

for (const name of TEMPLATE_SCHEMA_FILES) {
  const file = join(import.meta.dirname, "..", "schema", name);
  writeFileSync(file, templateJsonSchemaText());
  process.stdout.write(`wrote ${file}\n`);
}
