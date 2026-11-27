// Sample repos for the suggest-checks tests. Each fixture file in `fixtures/suggest-checks` holds
// a sample's files, the answer recorded for them and the helper version the answer was made for.
// Names are neutral (`orders-api`); nothing here is a real project.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HelperResult } from "../../../kernel/schemas/index.js";

export const FIXTURES = join(import.meta.dirname, "fixtures", "suggest-checks");

export interface Sample {
  readonly version: number;
  readonly files: Readonly<Record<string, string>>;
  readonly answer: HelperResult;
}

export const sampleNames = (): string[] => readdirSync(FIXTURES).map((file) => file.replace(/\.json$/, "")).sort();

export const readSample = (name: string): Sample => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Sample;

/** Writes sample `name`'s files into `root` (made if missing). */
export function writeSampleRepo(root: string, name: string): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(readSample(name).files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
