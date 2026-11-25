// allowed: the kernel signals processes and writes files.
import { renameSync, writeFileSync } from "node:fs";

export const stop = (pid: number) => process.kill(pid, "SIGTERM");
export const save = (path: string) => (writeFileSync(`${path}.tmp`, "x"), renameSync(`${path}.tmp`, path));
