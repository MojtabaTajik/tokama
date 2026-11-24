// What New work needs before it can start, and the small texts it derives from a template.
// A task changes repos, so it needs at least one; an investigation reads, so repos only scope it.
// Pure functions of the setup and the form, so the rules are testable without the screen.
import type { AgentSummary, ConnectionSummary, ItemKind, TemplateSummary } from "@tokama/core";
import { stepAgent } from "../drawer/describe.js";

export const NEEDS = {
  template: "Choose a template",
  text: "Describe the work or paste an alert",
  repos: "Choose at least one repo",
} as const;

export interface Form {
  readonly template: TemplateSummary | undefined;
  readonly text: string;
  readonly repoIds: readonly string[];
}

/** Why Start is not possible yet, in the order the form is filled; undefined when it is. */
export function missing(form: Form): string | undefined {
  if (form.template === undefined) return NEEDS.template;
  if (form.text.trim() === "") return NEEDS.text;
  if (form.template.kind === "task" && form.repoIds.length === 0) return NEEDS.repos;
  return undefined;
}

/** Whether the template needs at least one repo. */
export const needsRepo = (template: Pick<TemplateSummary, "kind"> | undefined): boolean => template?.kind === "task";

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
