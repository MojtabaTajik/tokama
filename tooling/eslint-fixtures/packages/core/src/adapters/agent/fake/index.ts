// allowed: an adapter may use the kernel, its own files, processes and the network.
import { execFile } from "child_process";
import { start } from "../../../kernel/process/spawn.js";
import { describe } from "./runtime.js";

export const fakeRuntime = { describe, start, execFile, ping: () => globalThis.fetch("http://localhost") };
