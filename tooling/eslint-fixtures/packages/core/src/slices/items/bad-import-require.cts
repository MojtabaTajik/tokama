import cp = require("node:child_process");

export const run = () => cp.spawn("ls");
