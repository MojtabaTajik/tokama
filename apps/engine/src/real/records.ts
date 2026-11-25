// The item record the API serves, folded from a stored item: what the board card, the drawer
// header and its Steps tab show. A pure function of the stored item: step names, stages and data
// rules come from the template snapshot the item started with, never from today's templates.
import {
  type AttemptRecord,
  type AttemptSummary,
  type Decision,
  type DecisionKind,
  type ItemKind,
  type ItemRecord,
  openAttempt,
  openDecisions,
  parseItemRecord,
  parseTemplateRecord,
  type Stage,
  type StepRecord,
  type StoredItem,
  type TemplateRecord,
  type TemplateStepDef,
} from "@tokama/core";

const MAX_ATTEMPTS_SHOWN = 50;
const MAX_CHECKS_SHOWN = 20;

/** What each kind of decision asks; the decision's own detail says why. */
export const QUESTIONS: Readonly<Record<DecisionKind, string>> = {
  plan_approval: "Approve this step's result?",
  cloud_summary: "Send this summary to the cloud agent?",
  outside_change: "Allow this change outside the worktree?",
  after_failure: "The step failed. Retry it, or end the item?",
  run_failure: "The run failed. Retry the step, or stop?",
  budget: "The item used its time budget. Continue?",
  tamper: "Files that steer Tokama changed. Approve them?",
};

const cut = (text: string | undefined, max: number): string | undefined => {
  const line = text?.replace(/\s+/g, " ").trim();
  if (line === undefined || line === "") return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A template edits a repo when Start picks one to edit; anything else only reads. */
export const kindOf = (template: Pick<TemplateRecord, "uses">): ItemKind => (template.uses.repos.picked === "edit" ? "task" : "investigation");

/** The board column a step counts as, before it runs. */
export function stageOf(step: Pick<TemplateStepDef, "doneWhen">): Stage {
  return step.doneWhen === "reviewer approves" || step.doneWhen === "you approve" ? "review" : "working";
}

/** "local only" when no step may send anything off the machine. */
export const privacyOf = (steps: readonly Pick<TemplateStepDef, "data">[]): ItemRecord["privacy"] =>
  steps.every((step) => step.data === "none") ? "local_only" : "local_and_cloud";

/** The item as the API serves it; undefined for a deleted item. */
export function toItemRecord(item: StoredItem): ItemRecord | undefined {
  if (item.deleted) return undefined;
  const parsed = parseTemplateRecord(item.template.record);
  const template = parsed.ok ? parsed.value : undefined;
  const defs = new Map(template?.steps.map((step) => [step.id as string, step]));
  const running = openAttempt(item);

  const steps: StepRecord[] = item.steps.map((step) => {
    const def = defs.get(step.id);
    const checking = def?.doneWhen === "checks pass" && running?.step.id === step.id && running.attempt.processes.some((p) => p.role === "check");
    const attempts = step.attempts.slice(-MAX_ATTEMPTS_SHOWN).map(toAttempt);
    const detail = stepDetail(step.state, step.attempts, def?.maxAttempts);
    return {
      name: def?.name ?? step.id,
      stage: checking ? "verifying" : def ? stageOf(def) : "working",
      state: step.state,
      // A step the snapshot does not describe: say it may send data out.
      data: def?.data ?? "repo-and-diff",
      ...(def && { agentId: def.agentId }),
      ...(def && def.connections.length > 0 && { uses: def.connections.map(({ connectionId, access }) => ({ connectionId, access })) }),
      ...(detail !== undefined && { detail }),
      ...(attempts.length > 0 && { attempts }),
    };
  });

  const decision = toDecision(item);
  const outcome = item.outcome && {
    kind: item.outcome.kind,
    ...(cut(item.outcome.detail, 500) !== undefined && { detail: cut(item.outcome.detail, 500)! }),
    ...(item.outcome.commits !== undefined && {
      commits: item.outcome.commits.map(({ repoId, commit }) => {
        const branch = item.worktrees.find((w) => w.repoId === repoId)?.branch;
        return { repoId, commit, ...(branch !== undefined && { branch }) };
      }),
    }),
  };
  const cardLine = cut(cardLineOf(item, steps, decision?.kind), 120);

  const record = {
    schemaVersion: 1,
    id: item.id,
    kind: template ? kindOf(template) : "task",
    templateId: item.templateRef,
    title: cut(item.title, 200) ?? "Untitled",
    text: item.text,
    repoIds: item.repoIds,
    // An unreadable snapshot tells nothing about what may leave the machine: say it may.
    privacy: template ? privacyOf(template.steps) : "local_and_cloud",
    state: item.state,
    createdAt: item.createdAt,
    ...(cardLine !== undefined && { cardLine }),
    ...(decision !== undefined && item.state === "needs_you" && { decision }),
    steps,
    ...(outcome && { outcome }),
  } satisfies ItemRecord;
  // The record is checked here, so a bad one is logged once instead of failing every board reply.
  const checked = parseItemRecord(record);
  if (!checked.ok) throw new Error(`item ${item.id} does not map to a valid record: ${checked.error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return checked.value;
}

function toAttempt(attempt: AttemptRecord): AttemptSummary {
  const detail = cut(attempt.detail, 500);
  return {
    attempt: attempt.attempt,
    ...(attempt.result !== undefined && { result: attempt.result }),
    ...(attempt.failure !== undefined && { failure: attempt.failure }),
    ...(detail !== undefined && { detail }),
    checks: attempt.checks.slice(-MAX_CHECKS_SHOWN).map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
  };
}

function stepDetail(state: StepRecord["state"], attempts: readonly AttemptRecord[], maxAttempts: number | undefined): string | undefined {
  const last = attempts.at(-1);
  const of = maxAttempts === undefined ? "" : ` of ${maxAttempts}`;
  switch (state) {
    case "pending":
      return undefined;
    case "running":
      return last === undefined ? "starting" : `attempt ${last.attempt}${of}`;
    case "needs_you":
      return "waits for you";
    case "passed":
      return last === undefined ? "passed" : `passed on attempt ${last.attempt}`;
    case "failed":
      return cut(last?.detail, 200) ?? "failed";
    case "stopped":
      return "stopped";
  }
}

/** The oldest open question. A restart can leave two open; the next shows once this one is answered. */
function toDecision(item: StoredItem): Decision | undefined {
  const open = openDecisions(item)[0];
  if (open === undefined) return undefined;
  const at = [open.stepId, item.currentStepId].map((id) => item.steps.findIndex((step) => step.id === id)).find((index) => index >= 0);
  const pending = item.steps.findIndex((step) => step.state !== "passed");
  const why = cut(open.detail, 500);
  return {
    id: open.id,
    kind: open.kind,
    stepIndex: at ?? (pending >= 0 ? pending : item.steps.length - 1),
    question: QUESTIONS[open.kind],
    ...(why !== undefined && { why }),
    choices: open.choices.slice(0, 5),
  };
}

function cardLineOf(item: StoredItem, steps: readonly StepRecord[], asked: DecisionKind | undefined): string | undefined {
  const commit = item.outcome?.commits?.[0];
  if (commit !== undefined) {
    const branch = item.worktrees.find((w) => w.repoId === commit.repoId)?.branch;
    return `commit ${commit.commit.slice(0, 7)}${branch === undefined ? "" : ` · ${branch}`}`;
  }
  if (item.outcome !== undefined) return item.outcome.detail;
  if (asked !== undefined) return QUESTIONS[asked];
  const at = steps.findIndex((step) => step.state !== "passed");
  const step = steps[at];
  if (step === undefined || step.state === "pending") return item.state === "queued" ? "starting" : undefined;
  return step.detail === undefined ? step.name : `${step.name} · ${step.detail}`;
}
