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
  type Clock,
  type Command,
  type CommandError,
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
  type StoredItem,
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
  readonly log: (message: string) => void;
}

/** The commands about items; repo commands are the engine's own. */
type ItemCommand = Extract<Command, { type: "start_item" | "resolve_decision" | "stop_item" }>;

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
      }
    };
    for (const item of items.list()) project(item);
    this.unsubscribe = items.subscribe(project);

    const runtime = options.runtime ?? defaultRuntime(options.runner);
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
        return this.loop.resolveDecision(command.itemId, command.decisionId, command.choice);
      case "stop_item":
        return this.loop.stopItem(command.itemId);
    }
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
