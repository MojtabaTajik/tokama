import type { AgentRuntime } from "../../../kernel/ports/index.js";

/**
 * The shell of the runtime: it refuses every call, so no step can start Codex CLI before the
 * sandbox mapping, the event stream and the stop are in place.
 */
export function createCodexCliRuntime(): AgentRuntime {
  return {
    async *launch() {
      yield {
        type: "end",
        outcome: "failed",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        error: "Tokama cannot run steps on Codex CLI yet.",
        errorKind: "crash",
      };
    },
  };
}
