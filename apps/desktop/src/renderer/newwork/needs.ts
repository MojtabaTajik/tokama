// What New work needs before it can start, and the small texts it derives from a template.
// The template's `start.needs` says whether Start asks for a repo; for now an item runs in exactly
// one, and always starts from a description. Pure functions of the setup and the form, so the rules are testable without the screen.
import type { AgentSummary, ConnectionSummary, ItemKind, RepoSummary, TemplateSummary } from "@tokama/core";
import { stepAgent } from "../drawer/describe.js";

export const NEEDS = {
  template: "Choose a template",
  text: "Describe the work or paste an alert",
  repo: "Choose one repo",
} as const;

export interface Form {
  readonly template: TemplateSummary | undefined;
  readonly text: string;
  readonly repoIds: readonly string[];
}

/** Why Start is not possible yet, in the order the form is filled; undefined when it is. */
export function missing(form: Form): string | undefined {
  if (form.template === undefined) return NEEDS.template;
  // Every item starts from a description, and runs in one repo for now: the engine refuses others.
  if (form.text.trim() === "") return NEEDS.text;
  if (needsRepo(form.template) && form.repoIds.length !== 1) return NEEDS.repo;
  return undefined;
}

/** Whether the template needs a repo. */
export const needsRepo = (template: Pick<TemplateSummary, "start"> | undefined): boolean =>
  template !== undefined && (template.start.needs.includes("repo") || template.start.needs.includes("repos"));

/** The repos a template can run on: a repo's own template runs only in that repo; a built-in in any. */
export function reposFor(template: Pick<TemplateSummary, "id"> | undefined, repos: readonly RepoSummary[]): readonly RepoSummary[] {
  const owner = template?.id.split("/")[0];
  return owner === undefined || owner === "builtin" ? repos : repos.filter((repo) => repo.id === owner);
}

/**
 * Who runs each step and what that agent may do, for the steps whose agent is not the plain
 * built-in kind: one shared by a repo, or one that may run commands or use the web. What is shown
 * is what the engine would run.
 */
export function agentLines(template: TemplateSummary, repoOwner = template.id.split("/")[0]): string[] {
  return template.steps.flatMap((step) => {
    const access = step.agentAccess;
    if (access === undefined || (access.owner !== "repo" && access.commands.length === 0 && !access.web)) return [];
    const owner = access.owner === "repo" ? `from repo ${repoOwner}` : access.owner === "personal" ? "yours" : "built in";
    const can = [access.edit ? "edits files" : "reads only", ...(access.commands.length > 0 ? [`runs ${access.commands.join(", ")}`] : []), ...(access.web ? ["uses the web"] : [])];
    return [`${step.name} · ${access.name} (${owner}) · ${can.join(" · ")}`];
  });
}

/**
 * The commands the template runs on this machine with the engineer's rights: its setup command,
 * then each step's checks (the template's own, or the chosen repo's). A step that runs the repo's
 * checks before a repo is chosen shows that it will.
 */
export function commandsOf(template: TemplateSummary, repos: readonly RepoSummary[], repoIds: readonly string[]): string[] {
  const commands: string[] = template.setup === undefined ? [] : [template.setup];
  const chosen = repos.filter((repo) => repoIds.includes(repo.id));
  for (const step of template.steps) {
    if (step.checks === undefined) continue;
    if ("commands" in step.checks) commands.push(...step.checks.commands);
    else if (chosen.length === 0) commands.push("the repo's checks");
    else for (const repo of chosen) commands.push(...(repo.checks.length > 0 ? repo.checks : [`${repo.id} lists no checks`]));
  }
  return [...new Set(commands)];
}

export const KIND_GROUPS: readonly { readonly kind: ItemKind; readonly heading: string }[] = [
  { kind: "investigation", heading: "Investigate" },
  { kind: "task", heading: "Build" },
];

/** The template's steps on one line: "Plan · Architect (cloud) → Build · Local builder → Run checks · Tokama". */
export function stepsLine(template: TemplateSummary, agents: readonly AgentSummary[]): string {
  return template.steps
    .map((step) => {
      const agent = stepAgent(step, agents);
      // The agent the engine resolved for this template wins over a same-id agent in the list.
      return `${step.name} · ${step.agentAccess?.name ?? agent.name}${agent.runsOn === "cloud" ? " (cloud)" : ""}`;
    })
    .join(" → ");
}

/** The template's connections as "App Insights · prod (query)", each by the name the setup gives it. */
export function usesOf(template: TemplateSummary, connections: readonly ConnectionSummary[]): string[] {
  return template.connections.map((use) => `${connections.find((connection) => connection.id === use.connectionId)?.name ?? use.connectionId} (${use.access})`);
}
