// The `agents_list` query: every agent on this machine, read fresh from the files. Personal agents
// and the built-ins load once; each repo's shared agents load with that repo, so the same id can
// show up in two repos. A shared agent that a personal one hides is not listed: it is not used.
import {
  type AgentDetail,
  type AgentOwner,
  type AgentsListResult,
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

function detail(agent: Agent): AgentDetail {
  const roleCut = agent.role.length > MAX_ROLE_CHARS;
  return {
    id: agent.id,
    name: agent.name,
    cliId: agent.cliId,
    ...(agent.drivenBy === undefined ? {} : { drivenBy: agent.drivenBy }),
    model: agent.model,
    runsOn: agent.cliId === "ollama" ? "local" : "cloud",
    limits: { edit: agent.limits.edit, commands: [...agent.limits.commands], web: agent.limits.web },
    ...(agent.icon === undefined ? {} : { icon: agent.icon }),
    role: roleCut ? agent.role.slice(0, MAX_ROLE_CHARS) : agent.role,
    roleCut,
    owner: agent.owner,
    source: sourceOf(agent.owner, agent.id),
  };
}

const brokenDetail = (broken: BrokenAgent): BrokenAgentDetail => ({
  id: broken.id,
  owner: broken.owner,
  source: sourceOf(broken.owner, broken.id),
  problems: broken.problems.map(formatProblem).map((text) => text.slice(0, 1000)),
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
  // A broken agent shows its own problems; the rest (shadowed files, bad names, links) are listed once.
  const shown = new Set(broken.flatMap((entry) => entry.problems));
  const problems = [...new Set([...loads.flatMap((load) => load.problems), ...extra].map(formatProblem).map((text) => text.slice(0, 1000)))].filter((text) => !shown.has(text));

  const cut = agents.length > MAX_LISTED_AGENTS || broken.length > MAX_LISTED_AGENTS || problems.length > MAX_LISTED_AGENTS - 1;
  return {
    agents: agents.slice(0, MAX_LISTED_AGENTS),
    broken: broken.slice(0, MAX_LISTED_AGENTS),
    problems: [...problems.slice(0, MAX_LISTED_AGENTS - 1), ...(cut ? [`Only the first ${MAX_LISTED_AGENTS} of each list are shown.`] : [])],
  };
}
