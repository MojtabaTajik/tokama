// allowed: slices may use the safe built-ins, and other objects' members are ordinary code.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const read = (dir: string) => readFile(join(dir, "step.md"), "utf8");
export const stop = (handle: { kill(signal: string): boolean }) => handle.kill("SIGTERM");
