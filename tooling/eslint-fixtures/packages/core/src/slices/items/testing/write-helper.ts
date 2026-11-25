// allowed: test helpers write files and signal processes directly.
import { writeFileSync } from "node:fs";

export const plant = (path: string) => writeFileSync(path, "x");
export const stop = (pid: number) => process.kill(pid, "SIGTERM");
