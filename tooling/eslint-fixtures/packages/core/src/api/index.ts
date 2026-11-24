// allowed: the API uses the kernel and its own files.
import type { Schema } from "../kernel/schemas/index.js";

export type Command = { kind: "start"; schema: Schema };
