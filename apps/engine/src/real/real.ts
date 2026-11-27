// Real mode: the engine API served from the item logs, the config files and the run loop.
//
// The stored items are projected into the engine's MemoryItemStore as API item records, so board
// and item replies and item_updated events take the one path the engine already has. Config is
// read again for every setup query and before every start, so edits to repos.yaml, agents and
// templates apply without a restart. Commands wait until restart recovery is done (the run loop
// holds them).
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type AgentRuntime,
  type AiCliAdapter,
  aiCliAdapters,
  type AiCliId,
  type AttemptChecksResult,
  type AttemptFile,
  type AttemptFileResult,
  type AttemptLogResult,
  BUILTIN_HELPERS,
  type CheckTrialDeps,
  type Clock,
  type Command,
  type CommandError,
  createCheckTrialRunner,
  createHelperRunner,
  DEFAULT_WORKTREE_FOLDER,
  type DecisionId,
  type EngineEvent,
  type HelperDefinition,
  type HelperGatherer,
  type HelperId,
  type ItemChange,
  type ItemDiff,
  type ItemId,
  type CommandResult,
  createGit,
  createRunLoop,
  err,
  type Git,
  ItemStore,
  loadAgents,
  ok,
  type ProcessRunner,
  type ProcessTable,
  type RecoveredItem,
  type Repo,
  type Result,
  type RunLoop,
  type RunLoopDeps,
  type Setup,
  type StepOutputResult,
  type StoredItem,
  parseTemplateRecord,
  suggestRepo,
  summarizeOutput,
  supportsNoLazyFetch,
} from "@tokama/core";
import type { MemoryItemStore } from "../store.js";
import { agentsFor, type Config, findTemplate, loadConfig, resolveAgent, startProblem, stepProblems, toSetup } from "./config.js";
import { cachedChecks, type HealthChecks } from "./health.js";
import { cliName, cliReadiness } from "./clis.js";
import { HelperRuns } from "./helpers.js";
import { CheckTrials } from "./trials.js";
import { toItemRecord } from "./records.js";

export interface RealEngineOptions {
  readonly home: string;
  /** The engine's own folder (socket and token): closed to the agents' commands. */
  readonly engineDir?: string;
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
  /** What a running item does now, for live display; `undefined` once nothing runs. */
  readonly onActivity?: RunLoopDeps["onActivity"];
  /** Where helper runs send their events: `helper_run_updated` and `usage_changed`. Default: nowhere. */
  readonly emit?: (event: EngineEvent) => void;
  /** The helpers this engine offers and how it collects their inputs. Default: the built-in list, which is empty. */
  readonly helpers?: { readonly definitions: readonly HelperDefinition[]; readonly gatherers: Readonly<Partial<Record<HelperId, HelperGatherer>>> };
}

/** The folder a helper's call runs in, inside the Tokama home. */
const HELPER_FOLDER = "helper-scratch";

/** A folder in each form a CLI may report it: as given and as its real path (a temp folder on macOS is reached through a link). */
const forms = (path: string): string[] => {
  try {
    return [...new Set([path, realpathSync(path)])];
  } catch {
    return [path];
  }
};

/** The commands about items; repo commands are the engine's own. */
type ItemCommand = Extract<Command, { type: "start_item" | "resolve_decision" | "stop_item" | "finish_item" | "accept_git_changes" }>;

const fail = (code: CommandError["code"], message: string): Result<never, CommandError> => err({ code, message });

export class RealEngine {
  /** Settles once restart recovery is done. */
  readonly ready: Promise<readonly RecoveredItem[]>;
  private readonly loop: RunLoop;
  private readonly git: Git;
  private readonly health: ReturnType<typeof cachedChecks>;
  private readonly unsubscribe: () => void;
  /** The helper runs: asking, cancelling, the log and the usage rows. */
  readonly helpers: HelperRuns;
  /** Try checks: the trial runs and the open-trials file. */
  readonly trials: CheckTrials;

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

    const runtime = options.runtime ?? defaultRuntime(options.runner, options.home, options.engineDir);
    const sshAuthSock = "sshAuthSock" in options ? options.sshAuthSock : process.env["SSH_AUTH_SOCK"];
    this.git = createGit({ runner: options.runner });
    this.loop = createRunLoop({
      store: items,
      git: this.git,
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
      ...(options.onActivity !== undefined && { onActivity: options.onActivity }),
    });
    this.ready = this.loop.ready;

    const home = options.home;
    const homes = forms(home);
    const helpers = options.helpers ?? { definitions: BUILTIN_HELPERS, gatherers: {} };
    this.helpers = new HelperRuns({
      runner: createHelperRunner({
        clock: options.clock,
        definitions: helpers.definitions,
        gatherers: helpers.gatherers,
        agents: () => loadAgents({ tokamaHome: home }),
        cliStatus: async (cliId) => cliReadiness(cliId, (await this.health.get()).clis),
        cliName: (cliId) => cliName(cliId),
        runtime,
        // Local-only mode is not built yet; the helper checks it for every call from the day it is.
        localOnly: () => false,
        scratchDir: join(home, HELPER_FOLDER),
        // Longest first is scrubPaths' own job: the helper folder, the Tokama home and the user's home, each in both forms.
        folders: [...homes.map((path) => [join(path, HELPER_FOLDER), "~/.tokama/helper-scratch"] as const), ...homes.map((path) => [path, "~/.tokama"] as const), ...forms(homedir()).map((path) => [path, "~"] as const)],
      }),
      home,
      hostId: items.hostId,
      clock: options.clock,
      processes: options.processes,
      ...(options.recoveryGraceMs !== undefined && { recoveryGraceMs: options.recoveryGraceMs }),
      emit: options.emit ?? (() => {}),
      log,
    });
    this.trials = new CheckTrials({
      runner: createCheckTrialRunner({
        git: this.git,
        runner: options.runner,
        clock: options.clock,
        resolveRepo: (path, baseBranch) => this.resolveTrialRepo(path, baseBranch),
        folders: [...homes.map((path) => [path, "~/.tokama"] as const), ...forms(homedir()).map((path) => [path, "~"] as const)],
      }),
      git: this.git,
      home,
      clock: options.clock,
      processes: options.processes,
      ...(options.recoveryGraceMs !== undefined && { recoveryGraceMs: options.recoveryGraceMs }),
      emit: options.emit ?? (() => {}),
      log,
    });
  }

  /**
   * The repo a Try checks request names: a configured repo with its own base branch and worktree
   * folder, or any other git repo with commits, with the branch `suggest_repo` proposes.
   */
  private async resolveTrialRepo(path: string, baseBranch: string | undefined): ReturnType<CheckTrialDeps["resolveRepo"]> {
    const config = await this.reload();
    const suggested = await suggestRepo({ tokamaHome: this.options.home, git: this.git }, path);
    if (!suggested.ok) return fail(suggested.error.code === "not_found" ? "not_found" : "invalid_request", suggested.error.message);
    const folder = suggested.value;
    if (!folder.gitRepo) return fail("invalid_request", folder.problem ?? "This folder is not a git repo.");
    if (!folder.hasCommits) return fail("invalid_state", "This repo has no commits yet. Make a first commit, then try the checks.");
    let configured: Repo | undefined;
    for (const repo of config.repos) {
      if ((await realpath(repo.path).catch(() => repo.path)) === folder.path) configured = repo;
    }
    const branch = baseBranch ?? configured?.baseBranch ?? folder.defaultBranch ?? folder.branch;
    if (branch === undefined) return fail("invalid_request", "Tokama cannot tell which branch to start from. Give a base branch, such as main.");
    return ok({ path: folder.path, baseBranch: branch, worktreeFolder: configured?.worktreeFolder ?? DEFAULT_WORKTREE_FOLDER });
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

  /** What an ended item changed: the commit it was merged as, or its worktree against its base commit. */
  async itemDiff(itemId: ItemId): Promise<Result<ItemChange, CommandError>> {
    return this.loop.itemDiff(itemId);
  }

  /** The final message of the agent of a step's attempt, with what it says as far as Tokama can read it. */
  async stepOutput(itemId: ItemId, stepIndex: number, attempt?: number): Promise<Result<StepOutputResult, CommandError>> {
    const output = await this.loop.stepOutput(itemId, stepIndex, attempt);
    if (!output.ok) return output;
    const item = this.options.items.get(itemId);
    const template = item === undefined ? undefined : parseTemplateRecord(item.template.record);
    const stepId = item?.steps[stepIndex]?.id;
    const def = template?.ok === true ? template.value.steps.find((step) => step.id === stepId) : undefined;
    // Built field by field: the loop's tail is for the summary only, and the reply's schema is strict.
    const { text, truncated, tail } = output.value;
    return ok({ attempt: output.value.attempt, text, truncated, summary: summarizeOutput(text, def?.doneWhen === "reviewer approves", tail) });
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
    const repo = config.repos.find((candidate) => candidate.id === repoId);
    if (repo === undefined) return fail("not_found", `No repo ${repoId}.`);
    // Older git ignores GIT_NO_LAZY_FETCH, so a partial clone could fetch through its own config.
    // A repo that cannot be read is refused too, with git's reason.
    if (!supportsNoLazyFetch(health.git.version ?? "")) {
      const partial = await this.git.partialClone(repo.path);
      if (!partial.ok) return fail("invalid_request", `Tokama could not check whether ${repo.id} is a partial clone: ${partial.error.message}`);
      if (partial.value) return fail("invalid_request", "This repo is a partial clone. Update git to 2.44 or newer to use it.");
    }
    const steps = stepProblems(template, agentsFor(config, template));
    if (steps.length > 0) return fail("invalid_request", steps.join(" "));
    const started = await this.loop.startItem({ template, repoId, text: command.text });
    return started.ok ? ok({ itemId: started.value }) : started;
  }

  /** Stops running agents and checks without recording an end; the next start asks Retry step / Stop. */
  async close(): Promise<void> {
    await this.helpers.close();
    await this.trials.close();
    await this.loop.close();
    this.unsubscribe();
  }
}

/** The runtime of the adapter for the CLI the agent runs on, made once per CLI. Keyed on where the agent runs, never on the CLI that drives a local model. */
export function defaultRuntime(runner: ProcessRunner, tokamaHome: string, engineDir?: string, list: readonly AiCliAdapter[] = aiCliAdapters): (agent: Agent) => AgentRuntime | undefined {
  const runtimes = new Map<AiCliId, AgentRuntime>();
  return (agent) => {
    const adapter = list.find((candidate) => candidate.id === agent.cliId);
    if (adapter === undefined) return undefined;
    let runtime = runtimes.get(adapter.id);
    if (runtime === undefined) {
      runtime = adapter.createRuntime({ runner, tokamaHome, closedDirs: engineDir === undefined ? [] : [engineDir] });
      runtimes.set(adapter.id, runtime);
    }
    return runtime;
  };
}
