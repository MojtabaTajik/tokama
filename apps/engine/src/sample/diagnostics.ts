// Sample diagnostics for the fake engine mode: a real diagnostics store in the sample engine's own
// dir, never in the Tokama home, filled with a few entries of every type when it is empty. The
// sample crash is marked seen, so no crash prompt shows until the sample engine really dies.
import type { Clock } from "@tokama/core";
import { EngineDiagnostics, type DiagnosticsOptions } from "../diagnostics.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The sample entries, oldest first: how long ago each was recorded, and what it was. */
const SAMPLES: readonly { readonly ago: number; readonly record: (diagnostics: EngineDiagnostics) => void }[] = [
  { ago: 2 * DAY + 3 * HOUR, record: (d) => usage(d, ["start_task", "start_task", "approve", "finish_merge"]) },
  { ago: DAY + 5 * HOUR, record: (d) => d.store.warning("engine", "index_rebuilt") },
  { ago: DAY + 2 * HOUR, record: (d) => d.store.crash("renderer", "crashed") },
  { ago: 6 * HOUR, record: (d) => usage(d, ["start_task", "start_investigation", "approve", "request_changes", "finish_pull_request"]) },
  { ago: 3 * HOUR, record: (d) => d.store.warning("renderer", "renderer_unresponsive") },
  { ago: HOUR, record: (d) => d.store.error("engine", "request", sampleError()) },
];

function usage(diagnostics: EngineDiagnostics, actions: readonly Parameters<EngineDiagnostics["store"]["count"]>[0][]): void {
  for (const action of actions) diagnostics.store.count(action);
  diagnostics.store.flushUsage();
}

function sampleError(): Error {
  const error = new TypeError("Cannot read properties of undefined (reading 'attempt')");
  error.stack = [
    "TypeError: Cannot read properties of undefined (reading 'attempt')",
    "    at nextAttempt (/opt/tokama/packages/core/dist/slices/workflow-engine/attempts.js:88:17)",
    "    at runStep (/opt/tokama/packages/core/dist/slices/workflow-engine/run.js:212:9)",
    "    at async Engine.tick (/opt/tokama/apps/engine/dist/engine.js:61:5)",
  ].join("\n");
  return error;
}

/** Opens the sample store in `dir` and fills it when it holds nothing. */
export async function openSampleDiagnostics(options: Omit<DiagnosticsOptions, "home" | "clock"> & { readonly dir: string; readonly clock: Clock }): Promise<EngineDiagnostics> {
  const { dir, clock, ...rest } = options;
  // Seeding moves the store's clock back to each sample's time; it reads the real time otherwise.
  let back = 0;
  const shifted: Clock = { now: () => clock.now() - back, setTimeout: (callback, ms) => clock.setTimeout(callback, ms), clearTimeout: (handle) => clock.clearTimeout(handle) };
  const diagnostics = await EngineDiagnostics.open({ ...rest, home: dir, clock: shifted });
  if (diagnostics.store.list({ limit: 1 }).entries.length === 0 && diagnostics.store.settings().collect) {
    for (const sample of SAMPLES) {
      back = sample.ago;
      sample.record(diagnostics);
    }
    back = 0;
    diagnostics.store.updateSettings({ crashSeen: true });
  }
  return diagnostics;
}
