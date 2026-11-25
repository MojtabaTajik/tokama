// An adapter starts processes through the kernel's runner, never child_process.
import { execFile } from "node:child_process";

export const run = () => execFile("ls");
