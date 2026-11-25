// allowed: an adapter may use the kernel, its own files and the network.
import { connect } from "node:net";
import { start } from "../../../kernel/process/spawn.js";
import { describe } from "./runtime.js";

export const fakeRuntime = { describe, start, connect, ping: () => fetch("http://localhost") };
