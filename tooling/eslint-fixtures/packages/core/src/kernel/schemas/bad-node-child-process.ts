// Only kernel/process and kernel/egress may use escape hatches, not the whole kernel.
import { spawn } from "node:child_process";

export const run = () => spawn("ls");
