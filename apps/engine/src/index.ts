// Entry of the engine service as a library, for tests and for embedding. The process entry is main.ts.
export { startEngine, type EngineHandle, type EngineOptions, type StartError } from "./engine.js";
export { MemoryItemStore, type ItemListener } from "./store.js";
