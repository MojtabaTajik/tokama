import { createRequire } from "node:module";

export const cp: unknown = createRequire(import.meta.url)("child_process");
