// Runs a helper: one guarded agent call with no tools to act with. Tokama collects the helper's
// inputs itself, so what the prompt holds is exactly what leaves the machine; the agent only
// thinks and answers with one JSON object.
//
// The call runs in a folder of Tokama's own, `scratchDir`, that must hold nothing, with read-only
// limits whatever the agent file says, and `plain`, so the person's own instruction files, hooks and
// skills cannot change the one answer it must give. The request has no sandbox: with no commands the CLI is given
// no shell, and its file tools are confined to the working folder.
//
// `prepare` makes every refusal, before a run exists; `run` then gathers, asks and reads the
// answer. A bad answer gets one more try with a note of what was wrong; both tries are recorded.
import { lstat, chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../../kernel/clock/index.js";
import { hasCode } from "../../kernel/errno/index.js";
import { READ_ONLY, type AgentRuntime } from "../../kernel/ports/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  type AgentCallUsage,
  type AgentCallEvent,
  type AiCliId,
  CallIdSchema,
  type CommandErrorCode,
  type HelperAgent,
  type HelperId,
  type HelperInput,
  type HelperResult,
  type HelperRunPhase,
  type HelperRunRequest,
  type HelperSummary,
  newId,
  StepIdSchema,
  terminalText,
  type TokenUsage,
} from "../../kernel/schemas/index.js";
import { cutText, scrubPaths } from "../../kernel/text/index.js";
import type { Agent, LoadedAgents } from "../config/index.js";
import { type GuardReport, callUsage, helperGuardDefaults, runGuardedCall } from "../execution/index.js";
import { type HelperDefinition, type HelperInputName, HELPER_INPUTS, definitionProblem, findHelper, inputLabels, readAnswer, retryNote } from "../helpers/index.js";
import { buildHelperPrompt } from "../prompting/index.js";
import { type CliStatus, chooseHelperAgent, type HelperAgentChoice } from "./helper-agent.js";

const TEXT_CHARS = 300;
const MAX_TRIES = 2;
const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const NOT_BUILT_IN = "This helper is not in this engine yet.";

/** What a gatherer returns: the text of each input the helper asked for, or why it could not. */
export type HelperGatherer = (input: HelperInput, signal: AbortSignal) => Promise<Result<Partial<Record<HelperInputName, string>>, string>>;

export interface HelperRunnerDeps {
  readonly clock: Clock;
  readonly definitions: readonly HelperDefinition[];
  /** Collects a helper's inputs. A helper with no gatherer is listed as unavailable. */
  readonly gatherers: Readonly<Partial<Record<HelperId, HelperGatherer>>>;
  /** Personal and built-in agents, read again for every question; never a repo's. */
  readonly agents: () => Promise<LoadedAgents>;
  readonly cliStatus: (cliId: AiCliId) => Promise<CliStatus>;
  readonly cliName: (cliId: AiCliId) => string;
  readonly runtime: (agent: Agent) => AgentRuntime | undefined;
  readonly localOnly: () => boolean;
  /** The empty folder the calls run in. Its parent must exist. */
  readonly scratchDir: string;
  /** Folders written as a name in every text that comes from a CLI, as `[path, name]`. Give each folder in every form it may take (a link and its real path). */
  readonly folders: readonly (readonly [path: string, name: string])[];
}

export interface HelperCommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

/** A run that passed every refusal and is ready to start. */
export interface PreparedHelperRun {
  readonly definition: HelperDefinition;
  readonly request: HelperRunRequest;
  /** The agent that answers, as the run record and the log show it. */
  readonly agent: HelperAgent;
  readonly target: Agent;
  readonly runtime: AgentRuntime;
}

export interface HelperRunHooks {
  onPhase?(phase: HelperRunPhase): void;
  /** The agent's process started. */
  onProcess?(pid: number): void;
  /** One call ended, whatever came of it. `usage.attempt` is the try, from 1. */
  onUsage?(usage: AgentCallUsage): void;
}

/** What is kept of a run: names and sizes, never the text of an input or the answer. */
export interface HelperCallRecord {
  readonly helperId: HelperId;
  readonly helperVersion: number;
  readonly target: { readonly agentId: string; readonly cliId: AiCliId; readonly model: string };
  readonly sentToCloud: boolean;
  readonly inputs: readonly { readonly name: string; readonly bytes: number }[];
  readonly tries: readonly { readonly attempt: number; readonly end: Extract<AgentCallEvent, { type: "end" }>; readonly guard: GuardReport }[];
}

export interface HelperOutcome {
  readonly state: "done" | "failed" | "cancelled";
  /** Set exactly when done. */
  readonly result?: HelperResult;
  /** Set exactly when failed. */
  readonly error?: { readonly code: string; readonly message: string };
  /** The tokens of every call, and their cost when each call reported one. Absent when no call ended. */
  readonly usage?: { readonly tokens: TokenUsage; readonly costUsd?: number };
  readonly record: HelperCallRecord;
}

export interface HelperRunner {
  /** The `helpers` query: each helper, whether it can run now, and what a run sends where. */
  list(): Promise<HelperSummary[]>;
  /** Every refusal, in order, before anything is gathered or asked. `cloud: "accepted"` is the person's OK to send to a cloud agent. */
  prepare(request: HelperRunRequest, cloud?: "accepted"): Promise<Result<PreparedHelperRun, HelperCommandError>>;
  /** Gathers, asks and reads the answer. Never throws. Cancelling `signal` ends the run as cancelled. */
  run(prepared: PreparedHelperRun, hooks: HelperRunHooks, signal: AbortSignal): Promise<HelperOutcome>;
}

/** The line that says what a helper sends where: `Sends file names and build files of this folder to Claude Code · haiku.` */
export function helperDisclosure(labels: readonly string[], cliName: string, model: string): string {
  const what = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "nothing");
  return `Sends ${what} of this folder to ${cliName} · ${model}.`;
}

/** Text that came from a CLI or a file, made safe to show: no escape sequences, our folders written as names, cut short. */
export function cleanCliText(text: string, folders: readonly (readonly [path: string, name: string])[], max = TEXT_CHARS): string {
  return cutText(scrubPaths(terminalText(text), { roots: folders }).trim(), max);
}

/**
 * Makes sure `dir` is a plain folder, owned by us, mode 0700, and (when `empty`) holds nothing.
 * Returns what is wrong, or undefined. A link or a file in its place is never followed or removed.
 */
async function prepareScratch(dir: string, empty: boolean): Promise<string | undefined> {
  try {
    let info = await lstat(dir).catch((error: unknown) => (hasCode(error, "ENOENT") ? undefined : Promise.reject(error)));
    if (info === undefined) {
      await mkdir(dir, { mode: 0o700 });
      info = await lstat(dir);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return "The helper's working folder is not a plain folder.";
    if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
    if (empty) for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `The helper's working folder cannot be used: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const sumTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

export function createHelperRunner(deps: HelperRunnerDeps): HelperRunner {
  const { clock } = deps;
  const clean = (text: string, max = TEXT_CHARS) => cleanCliText(text, deps.folders, max);
  for (const definition of deps.definitions) {
    const problem = definitionProblem(definition);
    if (problem !== undefined) throw new Error(`Helper definition is not valid: ${problem}`);
  }
  if (new Set(deps.definitions.map((definition) => definition.id)).size !== deps.definitions.length) throw new Error("Two helper definitions have the same id.");
  // Helper calls under way, so a call never empties the folder under another.
  let active = 0;

  const choose = async (definition: HelperDefinition): Promise<HelperAgentChoice> => {
    const choice = await chooseHelperAgent(definition, {
      agents: await deps.agents(),
      cliStatus: deps.cliStatus,
      runtime: deps.runtime,
      cliName: deps.cliName,
      localOnly: deps.localOnly(),
    });
    return choice.ok ? choice : { ...choice, problem: clean(choice.problem, 400) };
  };

  return {
    async list() {
      return Promise.all(
        deps.definitions.map(async (definition): Promise<HelperSummary> => {
          const choice = await choose(definition);
          const problem = deps.gatherers[definition.id] === undefined ? NOT_BUILT_IN : choice.ok ? undefined : choice.problem;
          const { summary: agent } = choice;
          return {
            helperId: definition.id,
            name: definition.name,
            version: definition.version,
            available: problem === undefined,
            ...(problem !== undefined && { problem }),
            ...(agent !== undefined && { agent }),
            sends: inputLabels(definition),
          };
        }),
      );
    },

    async prepare(request, cloud) {
      const refuse = (code: CommandErrorCode, message: string) => err<HelperCommandError>({ code, message });
      const definition = findHelper(deps.definitions, request.helperId);
      if (definition === undefined || deps.gatherers[definition.id] === undefined) return refuse("helper_unavailable", NOT_BUILT_IN);
      const choice = await choose(definition);
      if (!choice.ok) return refuse("helper_unavailable", choice.problem);
      if (choice.summary.runsOn === "cloud" && cloud !== "accepted") {
        return refuse("cloud_not_accepted", helperDisclosure(inputLabels(definition), deps.cliName(choice.agent.cliId), choice.agent.model));
      }
      return ok({ definition, request, agent: choice.summary, target: choice.agent, runtime: choice.runtime });
    },

    async run(prepared, hooks, signal) {
      const { definition, request, target, runtime } = prepared;
      let included: { name: string; bytes: number }[] = [];
      let sentToCloud = false;
      const tries: { attempt: number; end: Extract<AgentCallEvent, { type: "end" }>; guard: GuardReport }[] = [];
      let tokens: TokenUsage | undefined;
      let cost: number | undefined = 0;
      const outcome = (state: HelperOutcome["state"], rest: { result?: HelperResult; error?: { code: string; message: string } } = {}): HelperOutcome => ({
        state,
        ...rest,
        ...(tokens !== undefined && { usage: { tokens, ...(cost !== undefined && { costUsd: cost }) } }),
        record: {
          helperId: definition.id,
          helperVersion: definition.version,
          target: { agentId: target.id, cliId: target.cliId, model: target.model },
          sentToCloud,
          inputs: included,
          tries,
        },
      });
      const failed = (code: string, message: string) => outcome("failed", { error: { code, message } });
      try {
        const gatherer = deps.gatherers[definition.id];
        if (gatherer === undefined) return failed("crash", NOT_BUILT_IN);
        const gathered = await gatherer(request.input, signal);
        if (signal.aborted) return outcome("cancelled");
        if (!gathered.ok) return failed("crash", clean(gathered.error) || "The helper could not collect its inputs.");
        const inputs = definition.inputs.map((name) => ({ name, text: gathered.value[name], maxBytes: HELPER_INPUTS[name].maxBytes }));
        const missing = inputs.find((input) => input.text === undefined);
        if (missing !== undefined) return failed("crash", `The helper's inputs did not include ${missing.name}.`);

        let note: string | undefined;
        for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
          hooks.onPhase?.(attempt === 1 ? "asking" : "retrying");
          const built = buildHelperPrompt({
            instructions: definition.instructions,
            answerExample: definition.example,
            inputs: inputs.map((input) => ({ name: input.name, text: input.text ?? "", maxBytes: input.maxBytes })),
            agent: { id: target.id, cliId: target.cliId, role: target.role },
            localOnly: deps.localOnly(),
            ...(note !== undefined && { retryNote: note }),
          });
          if (!built.ok) return failed(built.error.code === "too-large" ? "too_large" : "crash", built.error.message);
          included = [...built.value.record.included];
          sentToCloud = built.value.record.sentToCloud;

          active++;
          let reply = "";
          let call: Awaited<ReturnType<typeof runGuardedCall>>;
          try {
            const problem = await prepareScratch(deps.scratchDir, active === 1);
            if (problem !== undefined) return failed("crash", clean(problem));
            call = await runGuardedCall(
              runtime,
              { model: target.model, prompt: built.value.user, role: built.value.system, cwd: deps.scratchDir, limits: READ_ONLY, timeoutMs: definition.maxTimeMs, plain: true },
              signal,
              {
                clock,
                settings: helperGuardDefaults(definition.maxTimeMs),
                onEvent: (event) => {
                  if (event.type === "started" && event.pid >= 2) hooks.onProcess?.(event.pid);
                  if (event.type === "text") reply = event.text;
                },
              },
            );
          } finally {
            active--;
          }

          const usage = callUsage({ callId: CallIdSchema.parse(newId("call", call.startedAt)), stepId: StepIdSchema.parse(definition.id), attempt, agentId: target.id, cliId: target.cliId, model: target.model, call });
          tokens = sumTokens(tokens ?? NO_TOKENS, call.end.usage);
          cost = cost !== undefined && call.end.costUsd !== undefined ? cost + call.end.costUsd : undefined;
          const { error: endError, ...endRest } = call.end;
          tries.push({ attempt, end: { ...endRest, ...(endError !== undefined && { error: clean(endError) || "The call failed." }) }, guard: call.guard });
          hooks.onUsage?.(usage);

          if (signal.aborted) return outcome("cancelled");
          const { end, guard } = call;
          if (guard.stop === "timeout" || end.errorKind === "timeout") return failed("timeout", `The helper took longer than ${Math.round(definition.maxTimeMs / 1_000)} seconds.`);
          if (guard.stop === "silent" || guard.stop === "tool_silent") return failed("timeout", "The helper went silent and was stopped.");
          if (guard.stop !== null) return failed("crash", "The helper did not answer in one turn.");
          if (end.outcome === "failed") return failed(end.errorKind ?? "crash", clean(end.error ?? "") || "The helper's call failed.");
          if (end.outcome !== "completed") return failed("crash", "The helper's call ended without an answer.");

          const answer = readAnswer(definition, reply);
          if (answer.ok) return outcome("done", { result: answer.value });
          note = retryNote(answer.error);
        }
        return failed("bad_answer", "The helper's answer was not valid twice. Try again.");
      } catch (error) {
        return signal.aborted ? outcome("cancelled") : failed("crash", clean(`The helper failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    },
  };
}
