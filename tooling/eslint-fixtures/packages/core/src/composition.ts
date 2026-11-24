// allowed: composition wires adapters to slices through their public entries.
import { fakeRuntime } from "./adapters/agent/fake/index.js";
import { createItem } from "./slices/items/index.js";
import { schemaVersion } from "./kernel/schemas/index.js";

export const engine = { runtime: fakeRuntime, createItem, schemaVersion };
