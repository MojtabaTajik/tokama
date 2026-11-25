// The `agents_list` query: every agent on this machine, read fresh from the files. Personal agents
// and the built-ins load once; each repo's shared agents load with that repo, so the same id can
// show up in two repos. A shared agent that a personal one hides is not listed: it is not used.
import {
  type AgentDetail,
  type AgentOwner,
  type AgentsListResult,
  BUILTIN_AGENT_IDS,
  type BrokenAgent,
  type BrokenAgentDetail,
  type ConfigProblem,
  formatProblem,
  loadAgents,
  type LoadedAgents,
  loadRepos,
  MAX_LISTED_AGENTS,
  MAX_ROLE_CHARS,
  type Agent,
} from "@tokama/core";

/** Where an agent's file is, as the loader names it in its problems: relative to Tokama's home or the repo. */
const sourceOf = (owner: AgentOwner, id: string): string =>
  owner.kind === "builtin" ? `builtin/${id}.md` : owner.kind === "personal" ? `agents/${id}.md` : `${owner.repoId}/.tokama/agents/${id}.md`;

const MAX_COMMANDS = 100;
const MAX_COMMAND_CHARS = 500;
const MAX_PROBLEMS = 50;
const MAX_PROBLEM_CHARS = 1000;

/** The first `max` items; when some are left out, the last one says how many ("+12 more"). */
function limited(items: readonly string[], max: number, chars: number): string[] {
  const cut = (text: string) => text.slice(0, chars);
  if (items.length <= max) return items.map(cut);
  return [...items.slice(0, max - 1).map(cut), `+${items.length - (max - 1)} more`];
}

const replacesBuiltin = (owner: AgentOwner, id: string): boolean => owner.kind !== "builtin" && BUILTIN_AGENT_IDS.includes(id);

function detail(agent: Agent): AgentDetail {
  const roleCut = agent.role.length > MAX_ROLE_CHARS;
  return {
    id: agent.id,
    name: agent.name,
    cliId: agent.cliId,
    ...(agent.drivenBy === undefined ? {} : { drivenBy: agent.drivenBy }),
    model: agent.model,
    runsOn: agent.cliId === "ollama" ? "local" : "cloud",
    limits: { edit: agent.limits.edit, commands: limited(agent.limits.commands, MAX_COMMANDS, MAX_COMMAND_CHARS), web: agent.limits.web },
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    role: roleCut ? agent.role.slice(0, MAX_ROLE_CHARS) : agent.role,
    roleCut,
    owner: agent.owner,
    source: sourceOf(agent.owner, agent.id),
    replacesBuiltin: replacesBuiltin(agent.owner, agent.id),
  };
}

const brokenDetail = (broken: BrokenAgent): BrokenAgentDetail => ({
  id: broken.id,
  owner: broken.owner,
  source: sourceOf(broken.owner, broken.id),
  replacesBuiltin: replacesBuiltin(broken.owner, broken.id),
  problems: limited(broken.problems.map(formatProblem), MAX_PROBLEMS, MAX_PROBLEM_CHARS),
});

export async function listAgents(tokamaHome: string): Promise<AgentsListResult> {
  const loads: LoadedAgents[] = [await loadAgents({ tokamaHome })];
  const extra: ConfigProblem[] = [];
  const repos = await loadRepos({ tokamaHome });
  if (repos.ok) {
    for (const repo of repos.value) loads.push(await loadAgents({ tokamaHome, repo }));
  } else {
    extra.push(...repos.error.problems);
  }

  const owned = (owner: AgentOwner, index: number) => index === 0 || owner.kind === "repo";
  const agents = loads.flatMap((load, index) => load.agents.filter((agent) => owned(agent.owner, index)).map(detail));
  const broken = loads.flatMap((load, index) => load.broken.filter((entry) => owned(entry.owner, index)).map(brokenDetail));
  // A broken agent shows its own problems. The rest are listed once: a broken file that another
  // file shadows, a bad file name, a refused link, an unreadable folder.
  const text = (problem: ConfigProblem) => formatProblem(problem).slice(0, MAX_PROBLEM_CHARS);
  const shown = new Set(loads.flatMap((load) => load.broken.flatMap((entry) => entry.problems.map(text))));
  const problems = [...new Set([...loads.flatMap((load) => load.problems), ...extra].map(text))].filter((line) => !shown.has(line));

  const cut = agents.length > MAX_LISTED_AGENTS || broken.length > MAX_LISTED_AGENTS || problems.length > MAX_LISTED_AGENTS - 1;
  return {
    agents: agents.slice(0, MAX_LISTED_AGENTS),
    broken: broken.slice(0, MAX_LISTED_AGENTS),
    problems: [...problems.slice(0, MAX_LISTED_AGENTS - 1), ...(cut ? [`Only the first ${MAX_LISTED_AGENTS} of each list are shown.`] : [])],
  };
}
