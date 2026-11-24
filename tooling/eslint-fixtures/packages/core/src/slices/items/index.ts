// allowed: a slice uses its own files and the kernel.
import type { Schema } from "../../kernel/schemas/index.js";
import { store } from "./store.js";

export const createItem = (schema: Schema) => store.push(schema);
