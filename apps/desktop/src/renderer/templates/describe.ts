// What the Templates page says about a template, in plain words: Start, each step as one sentence,
// Finish, and what the template can use. Pure functions, tested without React. Everything here
// comes from the template's fields; nothing is guessed from names or instruction text.
import type { AgentSummary, ConnectionSummary, Finish, StartNeed, TemplateEntry, TemplateStepView, TemplateView } from "@tokama/core";
import { formatDuration } from "../format/duration.js";
import { cliName } from "../model.js";
import { type Mark, markOf } from "../ui/status.js";
import { attempts, ROUND_TRIPS } from "./limits.js";

const NEEDS: Record<StartNeed, string> = { text: "a task description", repo: "one repo", repos: "one or more repos" };

export const FINISH: Record<Finish, { readonly name: string; readonly text: string }> = {
  commit: { name: "Commit", text: "on the item’s branch" },
  "pull-request": { name: "Pull request", text: "opened from the item’s branch" },
  findings: { name: "Findings", text: "on the item" },
  document: { name: "Document", text: "on the item" },
  "outside-changes": { name: "Outside changes", text: "made outside the repo, such as tickets" },
};

/** "a, b and c". */
export function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const sentence = (parts: readonly string[]): string => {
  const text = parts.filter((part) => part !== "").join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

/** "Needs a task description and one repo. Asks before each cloud step." */
export function startSentence(template: Pick<TemplateView, "start">): string {
  const { needs, askBeforeCloud, notify } = template.start;
  const parts = [needs.length === 0 ? "Needs nothing to start." : `Needs ${andList(needs.map((need) => NEEDS[need]))}.`];
  if (askBeforeCloud) parts.push("Asks before each cloud step.");
  if (notify) parts.push("Sends a notification when it needs you or ends.");
  return parts.join(" ");
}

/** "Builder (Claude Code, this machine)", or the bare id of an agent that is not set up. */
export function agentPhrase(agentId: string, agents: readonly AgentSummary[]): string {
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) return `${agentId} (not set up)`;
  return `${agent.name} (${cliName(agent.cliId)}, ${agent.runsOn === "cloud" ? "cloud" : "this machine"})`;
}

const stepName = (template: Pick<TemplateView, "steps">, id: string): string => template.steps.find((step) => step.id === id)?.name ?? id;

function doesPhrase(step: TemplateStepView, template: Pick<TemplateView, "uses">): string {
  if (step.doneWhen === "reviewer approves") return "reviews the work";
  switch (template.uses.repos.picked) {
    case "edit":
      return "works in the item’s worktree";
    case "read":
      return "reads the repo";
    case undefined:
      return "works on the task";
  }
}

function checksPhrase(step: TemplateStepView): string {
  if (step.checks === undefined || "from" in step.checks) return "the repo’s checks pass";
  const [only, ...more] = step.checks.commands;
  return more.length === 0 && only !== undefined ? `${only} passes` : `${andList(step.checks.commands)} pass`;
}

function donePhrase(step: TemplateStepView): string {
  switch (step.doneWhen) {
    case "agent finishes":
      return "done when the agent finishes";
    case "checks pass":
      return `done when ${checksPhrase(step)}`;
    case "reviewer approves":
      return "done when it approves";
    case "you approve":
      return "done when you approve";
  }
}

function failedPhrase(step: TemplateStepView, template: Pick<TemplateView, "steps">): string {
  // The engine decides a reviewer step only by its changes-requested rule, so its failure rule is never said.
  if (step.doneWhen === "reviewer approves") return "";
  const when = step.doneWhen === "checks pass" ? "if checks fail" : "if it fails";
  switch (step.ifFailed.action) {
    case "retry":
      return `${when}, try again, up to ${attempts(step.maxAttempts)}`;
    case "back":
      // Back to its own step is a retry; back to an earlier step is capped by round trips.
      return step.ifFailed.stepId === step.id
        ? `${when}, try again, up to ${attempts(step.maxAttempts)}`
        : `${when}, send the work back to ${stepName(template, step.ifFailed.stepId)} and run again after it, up to ${ROUND_TRIPS} round trips, then ask you`;
    case "ask":
      return `${when}, ask you`;
    case "stop":
      return `${when}, stop`;
  }
}

function changesPhrase(step: TemplateStepView, template: Pick<TemplateView, "steps">): string {
  if (step.ifChangesRequested === undefined) return step.doneWhen === "reviewer approves" ? "if it asks for changes, ask you" : "";
  if (step.ifChangesRequested.action !== "back") return "if it asks for changes, ask you";
  const { stepId } = step.ifChangesRequested;
  return stepId === step.id
    ? `if it asks for changes, try again, up to ${attempts(step.maxAttempts)}`
    : `if it asks for changes, send the work back to ${stepName(template, stepId)} and check again after each fix, up to ${ROUND_TRIPS} round trips, then ask you`;
}

/** What leaves the machine, said only for a cloud agent: a local one keeps everything here. */
function dataPhrase(step: TemplateStepView, agents: readonly AgentSummary[]): string {
  if (agents.find((agent) => agent.id === step.agentId)?.runsOn !== "cloud") return "";
  switch (step.data) {
    case "repo-and-diff":
      return "sends the repo and diff to the cloud";
    case "summary-after-approval":
      return "sends a summary to the cloud after you approve it";
    case "none":
      return "sends nothing to the cloud";
  }
}

function connectionsPhrase(step: TemplateStepView, connections: readonly ConnectionSummary[]): string {
  if (step.connections.length === 0) return "";
  const names = step.connections.map((use) => `${connections.find((connection) => connection.id === use.connectionId)?.name ?? use.connectionId} (${use.access})`);
  return `uses ${andList(names)}`;
}

/**
 * One step as one sentence: "Builder (Claude Code, this machine) works in the item’s worktree;
 * done when the repo’s checks pass; if checks fail, try again, up to 3 attempts."
 */
export function stepSentence(step: TemplateStepView, template: Pick<TemplateView, "steps" | "uses">, agents: readonly AgentSummary[], connections: readonly ConnectionSummary[] = []): string {
  return sentence([
    `${agentPhrase(step.agentId, agents)} ${doesPhrase(step, template)}`,
    connectionsPhrase(step, connections),
    dataPhrase(step, agents),
    donePhrase(step),
    failedPhrase(step, template),
    changesPhrase(step, template),
  ]);
}

/** What a template does to code, in two words: the same notes the New work list shows by item kind. */
export const READ_ONLY_NOTE = "read-only";
export const CHANGES_CODE_NOTE = "changes code";

/**
 * "changes code" when Start picks the repo to edit, "read-only" when it picks one to read; the
 * engine works only in the picked repo. Commands the template gives its agents can write files, so
 * then no promise is made (undefined).
 */
export function accessNote(template: Pick<TemplateView, "uses" | "steps">): string | undefined {
  if (template.uses.repos.picked === "edit") return CHANGES_CODE_NOTE;
  return template.uses.commands.length > 0 || template.steps.some((step) => step.commands.length > 0) ? undefined : READ_ONLY_NOTE;
}

export interface UseLine {
  readonly name: string;
  readonly detail: string;
}

/** The repos, connections and commands the template may use, each with its access. */
export function usesOf(template: Pick<TemplateView, "uses" | "steps">, connections: readonly ConnectionSummary[] = []): { readonly repos: UseLine[]; readonly connections: UseLine[]; readonly commands: string[] } {
  const { picked, named } = template.uses.repos;
  const repos: UseLine[] = [];
  if (picked !== undefined) repos.push({ name: "the repo you pick", detail: picked === "edit" ? "edit · gets a worktree" : "read · nothing committed" });
  for (const repo of named) repos.push({ name: repo.repoId, detail: repo.access });
  return {
    repos,
    connections: template.uses.connections.map((use) => {
      const usedBy = template.steps.filter((step) => step.connections.some((own) => own.connectionId === use.connectionId)).map((step) => step.name);
      const name = connections.find((connection) => connection.id === use.connectionId)?.name ?? use.connectionId;
      return { name, detail: usedBy.length > 0 ? `${use.access} · used by ${andList(usedBy)}` : use.access };
    }),
    commands: [...template.uses.commands],
  };
}

/** "45 m", "2 h 00 m", "1 h 30 m". */
export const budgetText = (minutes: number): string => formatDuration(minutes * 60_000, "coarse");

export type Status = Mark;

/** ✓ valid, or ✕ and how many problems: a symbol and a word, never colour alone. */
export function statusOf(entry: Pick<TemplateEntry, "problemCount">): Status {
  if (entry.problemCount === 0) return markOf("passed", "valid");
  return markOf("failed", entry.problemCount === 1 ? "1 problem" : `${entry.problemCount} problems`);
}

/** The list row's second line: the repo and the file, or "built-in". */
export function placeOf(entry: Pick<TemplateEntry, "origin" | "file">): string {
  return entry.origin === "builtin" ? "built-in" : `${entry.origin}/${entry.file}`;
}

/** The row's name: the template's, or the file name when the file does not load. */
export function titleOf(entry: Pick<TemplateEntry, "name" | "file">): string {
  return entry.name ?? entry.file.split("/").at(-1) ?? entry.file;
}
