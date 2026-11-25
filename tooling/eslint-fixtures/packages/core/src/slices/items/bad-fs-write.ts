import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile } from "fs/promises";

export const save = (path: string) => {
  writeFileSync(`${path}.tmp`, readFileSync(path));
  renameSync(`${path}.tmp`, path);
  return appendFile(path, "x");
};
