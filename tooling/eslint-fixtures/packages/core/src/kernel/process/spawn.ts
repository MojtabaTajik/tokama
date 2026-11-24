// allowed: kernel/process may spawn processes.
import { spawn } from "node:child_process";
import { schemaVersion } from "../schemas/index.js";

export const start = (command: string) => spawn(command, { env: { V: String(schemaVersion) } });
export const builtin = () => process.getBuiltinModule("node:child_process");
