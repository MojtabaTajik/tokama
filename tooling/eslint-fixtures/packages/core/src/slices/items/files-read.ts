// allowed: reads, folders and deletes are not writes.
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";

export const tidy = async (dir: string) => (mkdirSync(dir, { recursive: true }), unlinkSync(`${dir}/x`), readFileSync(`${dir}/y`), readdir(dir));
