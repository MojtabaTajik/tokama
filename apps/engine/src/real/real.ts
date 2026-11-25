// Real mode: the engine API served from the item logs, the config files and the run loop.
//
// The stored items are projected into the engine's MemoryItemStore as API item records, so board
// and item replies and item_updated events take the one path the engine already has. Config is
// read again for every setup query and before every start, so edits to repos.yaml, agents and
// templates apply without a restart. Commands wait until restart recovery is done (the run loop
// holds them).
import {
  adapters,
  type Agent,
  type AgentRuntime,
  type AttemptChecksResult,
  type AttemptFile,
  type AttemptFileResult,
  type AttemptLogResult,
  type Clock,
  type Command,
  type CommandError,
  type DecisionId,
  type ItemDiff,
  type ItemId,
  type CommandResult,
  createGit,
  createRunLoop,
  err,
  ItemStore,
  ok,
  type ProcessRunner,
  type ProcessTable,
  type RecoveredItem,
  type Result,
  type RunLoop,
  type Setup,
  type StepOutputResult,
  type StoredItem,
  parseTemplateRecord,
  summarizeOutput,
} from "@tokama/core";
import type { MemoryItemStore } from "../store.js";
import { agentsFor, type Config, findTemplate, loadConfig, resolveAgent, startProblem, stepProblems, toSetup } from "./config.js";
import { cachedChecks, type HealthChecks } from "./health.js";
import { toItemRecord } from "./records.js";

export interface RealEngineOptions {
  readonly home: string;
  readonly items: ItemStore;
  readonly store: MemoryItemStore;
  readonly clock: Clock;
  readonly processes: ProcessTable;
  readonly runner: ProcessRunner;
  readonly checks: HealthChecks;
  /** The runtime for an agent. Default: Claude Code for claude-code agents, none for others. */
  readonly runtime?: (agent: Agent) => AgentRuntime | undefined;
  /** Time between SIGTERM and SIGKILL for a leftover agent tree at start. */
  readonly recoveryGraceMs?: number;
  /** argv that starts gh for Open PR. Default: `["gh"]`. */
  readonly ghCommand?: readonly [string, ...string[]];
  /** The SSH agent socket, for a push to an SSH remote only. Default: this process's SSH_AUTH_SOCK. */
  readonly sshAuthSock?: string;
  readonly log: (message: string) => void;
  /** Called with an error the engine handles and logs, for diagnostics. */
  readonly onError?: (error: unknown) => void;
}

/** The commands about items; repo commands are the engine's own. */
type ItemCommand = Extract<Command, { type: "start_item" | "resolve_decision" | "stop_item" | "finish_item" | "accept_git_changes" }>;

const fail = (code: CommandError["code"], message: string): Result<never, CommandError> => err({ code, message });

export class RealEngine {
  /** Settles once restart recovery is done. */
  readonly ready: Promise<readonly RecoveredItem[]>;
  private readonly loop: RunLoop;
  private readonly health: ReturnType<typeof cachedChecks>;
  private readonly unsubscribe: () => void;

  private constructor(
    private readonly options: RealEngineOptions,
    private config: Config,
  ) {
    const { items, store, log } = options;
    this.health = cachedChecks(options.checks, () => options.clock.now());
    const project = (item: StoredItem) => {
      try {
        const record = toItemRecord(item);
        if (record !== undefined) store.put(record);
      } catch (error) {
        log(String(error instanceof Error ? error.message : error));
        options.onError?.(error);
      }
    };
    for (const item of items.list()) project(item);
    this.unsubscribe = items.subscribe(project);

    const runtime = options.runtime ?? defaultRuntime(options.runner);
    const sshAuthSock = "sshAuthSock" in options ? options.sshAuthSock : process.env["SSH_AUTH_SOCK"];
    this.loop = createRunLoop({
      store: items,
      git: createGit({ runner: options.runner }),
      runner: options.runner,
      clock: options.clock,
      processes: options.processes,
      repo: (id) => this.config.repos.find((repo) => repo.id === id),
      agent: (_repo, id, template) => resolveAgent(agentsFor(this.config, template), id),
      runtime,
      ...(options.recoveryGraceMs !== undefined && { recoveryGraceMs: options.recoveryGraceMs }),
      log,
      ...(options.ghCommand !== undefined && { ghCommand: options.ghCommand }),
      ...(sshAuthSock !== undefined && sshAuthSock !== "" && { sshAuthSock }),
    });
    this.ready = this.loop.ready;
  }

  /** Reads the config first: the run loop picks up items as soon as it exists, and needs the repos. */
  static async create(options: RealEngineOptions): Promise<RealEngine> {
    return new RealEngine(options, await loadConfig(options.home));
  }

  /** Reads the config again, e.g. after repos.yaml changed. */
  async refresh(): Promise<void> {
    await this.reload();
  }

  /** Reloads overlap; a read that started before a newer one finished never replaces it. */
  private reloads = 0;
  private latest = 0;
  private async reload(): Promise<Config> {
    const mine = ++this.reloads;
    const config = await loadConfig(this.options.home);
    if (mine > this.latest) {
      this.latest = mine;
      this.config = config;
    }
    return config;
  }

  async setup(): Promise<Setup> {
    const [config, health] = await Promise.all([this.reload(), this.health.get()]);
    return toSetup(config, { ...health, config: [] });
  }

  /** The only template that can start, when there is exactly one; otherwise none. */
  async suggestTemplate(): Promise<string | null> {
    const startable = this.config.templates.flatMap((load) => (load.ok && startProblem(load.template) === undefined ? [load.template.ref] : []));
    return startable.length === 1 ? startable[0]! : null;
  }

  async command(command: ItemCommand): Promise<Result<CommandResult<ItemCommand["type"]>, CommandError>> {
    switch (command.type) {
      case "start_item":
        return this.startItem(command);
      case "resolve_decision":
        return this.loop.resolveDecision(command.itemId, command.decisionId, command.choice, command.note);
      case "stop_item":
        return this.loop.stopItem(command.itemId);
      case "finish_item":
        return this.loop.finishItem(command.itemId, command.action);
      case "accept_git_changes":
        return this.loop.acceptGitChanges(command.itemId);
    }
  }

  /** The change an open decision about a step you approve shows. */
  async decisionDiff(itemId: ItemId, decisionId: DecisionId): Promise<Result<ItemDiff, CommandError>> {
    return this.loop.decisionDiff(itemId, decisionId);
  }

  /** The final message of the agent of a step's attempt, with what it says as far as Tokama can read it. */
  async stepOutput(itemId: ItemId, stepIndex: number, attempt?: number): Promise<Result<StepOutputResult, CommandError>> {
    const output = await this.loop.stepOutput(itemId, stepIndex, attempt);
    if (!output.ok) return output;
    const item = this.options.items.get(itemId);
    const template = item === undefined ? undefined : parseTemplateRecord(item.template.record);
    const stepId = item?.steps[stepIndex]?.id;
    const def = template?.ok === true ? template.value.steps.find((step) => step.id === stepId) : undefined;
    return ok({ ...output.value, summary: summarizeOutput(output.value.text, def?.doneWhen === "reviewer approves") });
  }

  /** Each check of a step's attempt with the end of its saved output. */
  async attemptChecks(itemId: ItemId, stepIndex: number, attempt: number): Promise<Result<AttemptChecksResult, CommandError>> {
    return this.loop.attemptChecks(itemId, stepIndex, attempt);
  }

  /** The end of a step attempt's transcript and the agent's final message. */
  async attemptLog(itemId: ItemId, stepIndex: number, attempt: number): Promise<Result<AttemptLogResult, CommandError>> {
    return this.loop.attemptLog(itemId, stepIndex, attempt);
  }

  /** The full path of a saved file of a step's attempt, for the desktop's Open the file. */
  async attemptFile(itemId: ItemId, stepIndex: number, attempt: number, file: AttemptFile): Promise<Result<AttemptFileResult, CommandError>> {
    return this.loop.attemptFile(itemId, stepIndex, attempt, file);
  }

  private async startItem(command: Extract<Command, { type: "start_item" }>): Promise<Result<{ itemId: StoredItem["id"] }, CommandError>> {
    const [config, health] = await Promise.all([this.reload(), this.health.get()]);
    if (!health.git.ok) return fail("invalid_request", health.git.message ?? "git cannot be used.");
    const load = findTemplate(config, command.templateId);
    if (load === undefined) return fail("not_found", `No template ${command.templateId}.`);
    if (!load.ok) return fail("invalid_request", `Template ${command.templateId} does not load: ${load.problems.map((p) => `line ${p.line}: ${p.message}`).join(" ")}`);
    const { template } = load;
    // The default is decided here, from the template: off unless the template turns it on.
    if (command.options?.askBeforeCloud ?? template.start.askBeforeCloud) {
      return fail("invalid_request", "Ask before cloud steps is not available yet: Tokama cannot pause before a cloud step. Start without it.");
    }
    const problem = startProblem(template);
    if (problem !== undefined) return fail("invalid_request", problem);
    const [repoId, ...others] = command.repoIds;
    if (repoId === undefined) return fail("invalid_request", `${template.name} needs a repo.`);
    if (others.length > 0) return fail("invalid_request", "Tokama runs an item in one repo for now: choose one.");
    if (template.source.kind === "repo" && template.source.repoId !== repoId) {
      return fail("invalid_request", `${template.ref} belongs to repo ${template.source.repoId} and runs only there.`);
    }
    if (!config.repos.some((repo) => repo.id === repoId)) return fail("not_found", `No repo ${repoId}.`);
    const steps = stepProblems(template, agentsFor(config, template));
    if (steps.length > 0) return fail("invalid_request", steps.join(" "));
    const started = await this.loop.startItem({ template, repoId, text: command.text });
    return started.ok ? ok({ itemId: started.value }) : started;
  }

  /** Stops running agents and checks without recording an end; the next start asks Retry step / Stop. */
  async close(): Promise<void> {
    await this.loop.close();
    this.unsubscribe();
  }
}

/** Claude Code for claude-code agents. Keyed on where the agent runs, never on the CLI that drives a local model. */
function defaultRuntime(runner: ProcessRunner): (agent: Agent) => AgentRuntime | undefined {
  const factories: Record<string, unknown> = { ...adapters };
  const create = factories["createClaudeCodeRuntime"] as ((options: { runner: ProcessRunner }) => AgentRuntime) | undefined;
  let claude: AgentRuntime | undefined;
  return (agent) => {
    if (agent.cliId !== "claude-code" || create === undefined) return undefined;
    claude ??= create({ runner });
    return claude;
  };
}
