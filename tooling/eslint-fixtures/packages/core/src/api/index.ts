// allowed: the API uses the kernel, its own files and the public entry of workflow-engine.
import type { Schema } from "../kernel/schemas/index.js";
import { runItem } from "../slices/workflow-engine/index.js";

export type Command = { kind: "start"; schema: Schema };
export const startItem = runItem;
