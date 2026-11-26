// What is set up on this machine, read fresh from Tokama's home folder and the repos: repos,
// agents (personal, each repo's shared ones, built-in) and templates. Reading never fails: a file
// that does not load becomes a config problem and the rest still loads.
import {
  cutText,
  displayPath,
  type Agent,
  type AgentId,
  type AgentLocation,
  type AgentSummary,
  type BrokenAgent,
  formatProblem,
  type Health,
  loadAgents,
  type LoadedAgents,
  loadBuiltins,
  loadRepos,
  loadTemplates,
  type Repo,
  type RepoId,
  RESERVED_REPO_IDS,
  runsInCloud,
  type Setup,
  type TemplateLoad,
  type TemplateRecord,
  type TemplateSummary,
} from "@tokama/core";
import { kindOf, stageOf } from "./records.js";

export type ConfigProblem = Health["config"][number];

export interface Config {
  readonly repos: readonly Repo[];
  /** Personal and built-in agents: the ones built-in templates are checked against. */
  readonly homeAgents: LoadedAgents;
  /** Per repo: personal, the repo's shared and built-in agents. */
  readonly repoAgents: ReadonlyMap<RepoId, LoadedAgents>;
  /** Every template file, loaded or not: each repo's, then the built-ins. */
  readonly templates: readonly TemplateLoad[];
  readonly problems: readonly ConfigProblem[];
}

export async function loadConfig(tokamaHome: string): Promise<Config> {
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();
  const report = (file: string, message: string) => {
    const key = `${file}\n${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ file: file.slice(0, 300), message: message.slice(0, 1000) });
  };

  const loaded = await loadRepos({ tokamaHome });
  if (!loaded.ok) for (const problem of loaded.error.problems) report(problem.file, formatProblem(problem));
  const repos = loaded.ok ? loaded.value : [];

  const homeAgents = await loadAgents({ tokamaHome });
  for (const problem of homeAgents.problems) report(problem.file, formatProblem(problem));
  const repoAgents = new Map<RepoId, LoadedAgents>();
  const templates: TemplateLoad[] = [];
  for (const repo of repos) {
    const agents = await loadAgents({ tokamaHome, repo });
    for (const problem of agents.problems) report(problem.file, formatProblem(problem));
    repoAgents.set(repo.id, agents);
    if (RESERVED_REPO_IDS.includes(repo.id)) {
      // Its template refs would clash with Tokama's own; the repo and its agents keep working.
      report("repos.yaml", `The repo id "${repo.id}" is reserved: template names start with builtin/ and personal/, so this repo's templates are not loaded. Rename the repo in repos.yaml.`);
      continue;
    }
    // One repo at a time, so its templates are checked against its own agents.
    for (const load of await loadTemplates({ repos: [repo], agents: locations(agents) })) {
      if (load.ok ? load.template.source.kind === "repo" : load.origin !== "builtin") templates.push(load);
    }
  }
  templates.push(...(await loadBuiltins(locations(homeAgents))));
  for (const load of templates) {
    if (load.ok) continue;
    const file = load.origin === "builtin" ? load.file : `${load.origin}/${load.file}`;
    report(file, load.problems.map((p) => `line ${p.line}: ${p.message}`).join(" "));
  }
  return { repos, homeAgents, repoAgents, templates, problems };
}

/**
 * Where each agent runs, for template checks. One rule for both the checks and the prompt:
 * runsInCloud. A broken id is listed as local, so its template still loads and the step that uses
 * it fails with the file's problem; once the file is fixed, the template is checked again.
 */
function locations(agents: LoadedAgents): Map<string, AgentLocation> {
  const map = new Map<string, AgentLocation>(agents.broken.map((broken) => [broken.id, { cloud: false }]));
  for (const agent of agents.agents) map.set(agent.id, { cloud: runsInCloud(agent.cliId) });
  return map;
}

/**
 * The agents a template's steps resolve against. A repo's template gets that repo's shared agents
 * too; a built-in one gets personal and built-in agents only, so a file in the repo it runs on can
 * never stand in for the agent the engineer was shown.
 */
export const agentsFor = (config: Config, template: Pick<TemplateRecord, "source">): LoadedAgents =>
  template.source.kind === "repo" ? (config.repoAgents.get(template.source.repoId) ?? config.homeAgents) : config.homeAgents;

/** The agent a step names, or why it cannot run. */
export function resolveAgent(agents: LoadedAgents, id: AgentId): Agent | { readonly problem: string } | undefined {
  const broken: BrokenAgent | undefined = agents.broken.find((entry) => entry.id === id);
  if (broken !== undefined) return { problem: broken.problems.map(formatProblem).join(" ") || `the file for ${id} does not load` };
  const agent = agents.agents.find((entry) => entry.id === id);
  if (agent?.cliId === "ollama") {
    // A local model is driven through a CLI that can also reach a cloud provider; until local
    // routing is built, such a call could leave the machine.
    return { problem: `${id} runs on ollama, and Tokama does not run local models yet. Use an agent that runs on claude-code.` };
  }
  return agent;
}

/** Why a step of the template cannot run on the repo, or undefined when every step can. */
export function stepProblems(template: TemplateRecord, agents: LoadedAgents): string[] {
  const problems: string[] = [];
  for (const step of template.steps) {
    const agent = resolveAgent(agents, step.agentId);
    if (agent === undefined) problems.push(`Step ${step.name} uses agent ${step.agentId}, which is not set up.`);
    else if ("problem" in agent) problems.push(`Step ${step.name} cannot run: ${agent.problem}`);
  }
  return problems;
}

/** Why the template cannot start at all in this version, or undefined. */
export function startProblem(template: TemplateRecord): string | undefined {
  if (template.start.askBeforeCloud) {
    return `${template.name} asks before each cloud step, and Tokama cannot ask yet. Turn ask_before_cloud off in the template to run it.`;
  }
  if (template.uses.repos.picked === undefined) return `${template.name} picks no repo, and Tokama runs items in one repo for now.`;
  return undefined;
}

function accessOf(agent: ReturnType<typeof resolveAgent>): { agentAccess?: TemplateSummary["steps"][number]["agentAccess"] } {
  if (agent === undefined || "problem" in agent) return {};
  const { limits } = agent;
  const role = roleLine(agent.role);
  return {
    agentAccess: {
      name: agent.name,
      owner: agent.owner.kind,
      ...(agent.owner.kind === "repo" && { repoId: agent.owner.repoId }),
      cliId: agent.cliId,
      model: agent.model,
      ...(role !== undefined && { role }),
      edit: limits.edit,
      commands: limits.commands.filter((c) => c.length <= 200).slice(0, 50),
      web: limits.web,
    },
  };
}

/** The first non-blank line of a role text, cut to the length the setup allows. */
export function roleLine(role: string): string | undefined {
  const line = role.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
  if (line === undefined) return undefined;
  return cutText(line, 200);
}

/** `warnings` are the template load's own (a line note, the last-checks note); the problems found against this machine's agents are added here. */
export function templateSummary(template: TemplateRecord, agents: LoadedAgents, warnings: readonly string[]): TemplateSummary {
  const start = startProblem(template);
  return {
    id: template.ref,
    name: template.name,
    kind: kindOf(template),
    ...(template.icon !== undefined && { icon: template.icon }),
    ...(template.color !== undefined && { color: template.color }),
    connections: template.uses.connections.map(({ connectionId, access }) => ({ connectionId, access })),
    steps: template.steps.map((step) => ({
      name: step.name,
      stage: stageOf(step),
      agentId: step.agentId,
      ...accessOf(resolveAgent(agents, step.agentId)),
      data: step.data,
      ...(step.connections.length > 0 && { uses: step.connections.map(({ connectionId, access }) => ({ connectionId, access })) }),
      ...(step.checks !== undefined && { checks: "from" in step.checks ? { from: "repo" as const } : { commands: [...step.checks.commands] } }),
    })),
    start: { needs: [...template.start.needs], askBeforeCloud: template.start.askBeforeCloud },
    ...(template.setup !== undefined && { setup: template.setup }),
    warnings: [...(start === undefined ? [] : [start]), ...stepProblems(template, agents), ...warnings].map((w) => w.slice(0, 1000)).slice(0, 50),
  };
}

export function toSetup(config: Config, health: Health): Setup {
  const agents: AgentSummary[] = [];
  const listed = new Set<string>();
  const add = (agent: Agent) => {
    if (listed.has(agent.id)) return;
    listed.add(agent.id);
    agents.push({ id: agent.id, name: agent.name, cliId: agent.cliId, model: agent.model, runsOn: runsInCloud(agent.cliId) ? "cloud" : "local" });
  };
  config.homeAgents.agents.forEach(add);
  for (const loaded of config.repoAgents.values()) loaded.agents.forEach(add);

  const templates = config.templates.flatMap((load) => {
    if (!load.ok) return [];
    const { template, warnings } = load;
    return [templateSummary(template, agentsFor(config, template), warnings)];
  });
  return {
    repos: config.repos.map((repo) => ({ id: repo.id, baseBranch: repo.baseBranch, checks: repo.checks.filter((check) => check.length <= 500).slice(0, 20), path: displayPath(repo.path) })),
    connections: [],
    agents,
    templates,
    health: { ...health, config: [...health.config, ...config.problems].slice(0, 100) },
  };
}

/** The loaded template with this ref. */
export function findTemplate(config: Config, ref: string): TemplateLoad | undefined {
  return config.templates.find((load) => (load.ok ? load.template.ref === ref : load.ref === ref));
}

