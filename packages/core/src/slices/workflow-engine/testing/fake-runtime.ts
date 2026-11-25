// A scripted agent runtime for run-loop tests. Each call runs the next behavior of the script (the
// last one repeats): edit files in the call's working directory, reply, crash, loop, or hang until
// stopped. Every call is kept, so a test can read the prompts the loop sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentCallRequest, AgentRuntime } from "../../../kernel/ports/index.js";
import type { AgentCallErrorKind, AgentCallEvent } from "../../../kernel/schemas/index.js";

export const FAKE_PID = 4242;
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface FakeCall {
  readonly request: AgentCallRequest;
  readonly signal: AbortSignal;
}

export type Behavior = (call: FakeCall) => AsyncGenerator<AgentCallEvent, void, undefined>;

export interface FakeRuntime extends AgentRuntime {
  readonly calls: FakeCall[];
}

export function fakeRuntime(script: readonly Behavior[]): FakeRuntime {
  const calls: FakeCall[] = [];
  return {
    calls,
    async *launch(request, signal) {
      const call = { request, signal };
      const behavior = script[Math.min(calls.length, script.length - 1)];
      calls.push(call);
      yield { type: "started", pid: FAKE_PID };
      if (behavior !== undefined) yield* behavior(call);
    },
  };
}

const completed = (): AgentCallEvent => ({ type: "end", outcome: "completed", usage: NO_TOKENS });

/** Writes the files (relative to the working directory), then replies `text`. */
export const edits = (files: Readonly<Record<string, string>>, text = "Done."): Behavior =>
  async function* ({ request }) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(request.cwd, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    yield { type: "turn" };
    yield { type: "tool_call", id: "edit-1", name: "Write", kind: "edit", input: { file_path: Object.keys(files)[0] ?? "" } };
    yield { type: "tool_result", id: "edit-1" };
    yield { type: "text", text };
    yield completed();
  };

export const says = (text: string): Behavior => edits({}, text);

export const crashes = (errorKind: AgentCallErrorKind, error = `the call failed (${errorKind})`): Behavior =>
  async function* () {
    yield { type: "end", outcome: "failed", usage: NO_TOKENS, error, errorKind };
  };

/** Edits the files once, then repeats the same command until a guard (or a stop) ends the call. */
export const loops = (files: Readonly<Record<string, string>>): Behavior =>
  async function* (call) {
    yield* edits(files, "Checking again.")(call);
    for (let i = 0; !call.signal.aborted && i < 1000; i++) {
      yield { type: "turn" };
      yield { type: "tool_call", id: `ls-${i}`, name: "Bash", kind: "command", input: { command: "ls" } };
      await new Promise((resolve) => setImmediate(resolve));
    }
    yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
  };

/** Runs until the call is stopped; `onStart` runs once the call is under way. */
export const hangs = (onStart?: () => void): Behavior =>
  async function* ({ signal }) {
    yield { type: "turn" };
    onStart?.();
    await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
    yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
  };

/** Runs `effect` (e.g. moving a test clock), then behaves as `then`. */
export const after = (effect: () => void, then: Behavior): Behavior =>
  async function* (call) {
    effect();
    yield* then(call);
  };

const write = (cwd: string, files: Readonly<Record<string, string>>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
};

/** Writes the files, then the CLI crashes. */
export const editsThenCrashes = (files: Readonly<Record<string, string>>, errorKind: AgentCallErrorKind = "crash"): Behavior =>
  async function* ({ request }) {
    write(request.cwd, files);
    yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: "the CLI crashed", errorKind };
  };

/** Writes the files, then runs until stopped (or a guard's timeout). */
export const editsThenHangs = (files: Readonly<Record<string, string>>): Behavior =>
  async function* (call) {
    write(call.request.cwd, files);
    yield* hangs()(call);
  };
