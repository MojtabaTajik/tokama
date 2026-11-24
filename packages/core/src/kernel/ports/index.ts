// Ports: the interfaces adapters implement (architecture.md, sections 6 and 7). Agent runtime and
// model host are separate ports, so a local model can run under any runtime.
//
// Rules every adapter follows, checked by the contract suites in `testing/`:
// - Expected failures (host down, CLI failed, aborted) are values, never thrown.
// - Every call takes an AbortSignal and returns promptly once it fires.
// - Everything returned is plain JSON data.
import type { Result } from "../result/index.js";
import type { AgentCallEvent } from "../schemas/index.js";

export interface PortError {
  /** `aborted`: the signal fired. `unavailable`: the backend cannot be reached. `failed`: anything else. */
  readonly code: "aborted" | "unavailable" | "failed";
  readonly message: string;
}

export interface AgentCallRequest {
  readonly model: string;
  readonly prompt: string;
  /** Working directory of the call: the task's worktree, or a scratch folder for investigations. */
  readonly cwd: string;
}

/** Drives one AI CLI (Claude Code, Codex CLI, ...) headless. */
export interface AgentRuntime {
  /**
   * Starts one agent call. The stream never throws and always ends with exactly one `end` event:
   * `completed`, `failed` (with `error`), or `aborted` once `signal` fires.
   */
  launch(request: AgentCallRequest, signal: AbortSignal): AsyncIterable<AgentCallEvent>;
}

export interface ModelInfo {
  /** The name the runtime passes as its model argument, e.g. `qwen3-coder:30b`. */
  readonly name: string;
}

/** Serves local models (Ollama, ...). */
export interface ModelHost {
  /** The models the host can serve now. */
  listModels(signal: AbortSignal): Promise<Result<readonly ModelInfo[], PortError>>;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
}

/** Gives agents tools on an outside system (an MCP server, built-in Postgres, ...). */
export interface Connector {
  listTools(signal: AbortSignal): Promise<Result<readonly ToolInfo[], PortError>>;
  /** `ok` when the system is reachable with the configured credentials and scope. */
  health(signal: AbortSignal): Promise<Result<void, PortError>>;
}

/** One reading of machine load. A sampler fills the metrics its platform can measure. */
export interface MachineSample {
  /** Milliseconds since the Unix epoch, from the kernel clock. */
  readonly at: number;
  readonly cpuPercent?: number;
  readonly gpuPercent?: number;
  readonly memoryUsedBytes?: number;
  readonly powerWatts?: number;
  readonly temperatureC?: number;
}

/** Measures machine load (macmon on macOS, a fallback elsewhere). */
export interface Sampler {
  sample(signal: AbortSignal): Promise<Result<MachineSample, PortError>>;
}
