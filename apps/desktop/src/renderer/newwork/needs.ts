// What New work needs before it can start, and the small texts it derives from a template.
// The template's `start.needs` says what Start asks for: the text, exactly one repo, or one or
// more repos. Pure functions of the setup and the form, so the rules are testable without the screen.
import type { AgentSummary, ConnectionSummary, ItemKind, RepoSummary, TemplateSummary } from "@tokama/core";
import { stepAgent } from "../drawer/describe.js";

export const NEEDS = {
  template: "Choose a template",
  text: "Describe the work or paste an alert",
  repos: "Choose at least one repo",
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
  const { needs } = form.template.start;
  if (needs.includes("text") && form.text.trim() === "") return NEEDS.text;
  if (needs.includes("repo") && form.repoIds.length !== 1) return NEEDS.repo;
  if (needs.includes("repos") && form.repoIds.length === 0) return NEEDS.repos;
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
      return `${step.name} · ${agent.name}${agent.runsOn === "cloud" ? " (cloud)" : ""}`;
    })
    .join(" → ");
}

/** The template's connections as "App Insights · prod (query)", each by the name the setup gives it. */
export function usesOf(template: TemplateSummary, connections: readonly ConnectionSummary[]): string[] {
  return template.connections.map((use) => `${connections.find((connection) => connection.id === use.connectionId)?.name ?? use.connectionId} (${use.access})`);
}
