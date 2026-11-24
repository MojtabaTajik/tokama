// Only index.ts and composition.ts wire the engine; a new top-level file gets no wiring rights.
export { createItem } from "./slices/items/index.js";
export { fakeRuntime } from "./adapters/agent/fake/index.js";
export { engine } from "./composition.js";
