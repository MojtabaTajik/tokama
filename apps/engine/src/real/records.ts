// The item record the API serves, folded from a stored item: what the board card, the drawer
// header and its Steps tab show. A pure function of the stored item: step names, stages and data
// rules come from the template snapshot the item started with, never from today's templates.
import {
  cutText,
  type AttemptRecord,
  type AttemptSummary,
  type Decision,
  attemptLimit,
  countedAttempts,
  type DecisionChoice,
  type DecisionKind,
  explainStop,
  REQUEST_CHANGES_ID,
  hostedRepo,
  type ItemKind,
  type ItemRecord,
  openAttempt,
  openDecisions,
  parseItemRecord,
  parseTemplateRecord,
  type Stage,
  type StepRecord,
  type StoredDecision,
  type StoredItem,
  type TemplateRecord,
  type TemplateStepDef,
} from "@tokama/core";
import { attemptMs, itemMs, stepTimes } from "./timing.js";

const MAX_ATTEMPTS_SHOWN = 50;
const MAX_CHECKS_SHOWN = 20;

/** What each kind of decision asks when the template and the step are not known; the decision's own detail says why. */
const QUESTIONS: Readonly<Record<DecisionKind, string>> = {
  plan_approval: "Go on with this result?",
  cloud_summary: "Send this summary to the cloud agent?",
  outside_change: "Allow this change outside the worktree?",
  after_failure: "The step failed. Retry it, or end the item?",
  run_failure: "The run failed. Retry the step, or stop?",
  budget: "The item used its time budget. Continue?",
  tamper: "Files that steer Tokama changed. Approve them?",
};

/** Step names that read as a command, so "Build it this way?" makes sense; any other name is asked as "Go on to <name> this way?". */
const COMMAND_VERBS = new Set(["build", "implement", "fix", "write", "refactor", "migrate", "update", "add", "create", "draft", "document", "deploy", "release"]);

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The step a plan approval comes from, the step after it, and what approving it does. */
function approvalOf(open: StoredDecision, template: TemplateRecord | undefined) {
  const at = template?.steps.findIndex((step) => step.id === open.stepId) ?? -1;
  const step = template?.steps[at];
  const next = at < 0 ? undefined : template?.steps[at + 1];
  const last = step !== undefined && next === undefined;
  return { step, next, commits: last && template!.finish.includes("commit"), files: open.change?.files };
}

/** What the decision asks, in the words of the step it is about: the engineer reads the question, not the kind. */
export function questionOf(open: StoredDecision, template: TemplateRecord | undefined, runLimit?: number): string {
  // A question with no step of its own (setup, Finish) names none.
  const step = template?.steps.find((s) => s.id === open.stepId);
  const name = step?.name;
  switch (open.kind) {
    case "plan_approval": {
      const { next, commits, files } = approvalOf(open, template);
      // No step, or a log from before both the tree and the count were kept: nothing tells what the approval covers.
      if (step === undefined || (files === undefined && open.tree === undefined)) return QUESTIONS.plan_approval;
      if (files === 0) {
        if (next === undefined) return "Accept this result and finish?";
        return COMMAND_VERBS.has(next.name.toLowerCase()) ? `${next.name} it this way?` : `Go on to ${next.name} this way?`;
      }
      if (next === undefined) return commits ? "Commit this change?" : "Accept this result and finish?";
      return `Go on to ${next.name} with this change?`;
    }
    case "after_failure": {
      if (name === undefined) return QUESTIONS.after_failure;
      const choices = new Set(open.choices.map((c) => c.id));
      if (choices.has("one_more_attempt")) return `${name} used its ${plural(runLimit ?? step!.maxAttempts, "run")}. Run it once more?`;
      if (choices.has("one_more_round")) return `${name} sent the work back too often. Run one more round?`;
      return `${name} failed. Run ${name} again?`;
    }
    case "run_failure":
      return name === undefined ? QUESTIONS.run_failure : `${name} could not run. Run ${name} again?`;
    case "budget":
      // After a Continue the item has used more than one budget, so the question names only the time that is added.
      return template?.budget === undefined ? QUESTIONS.budget : `The item used its time budget. Continue for ${template.budget.timeMinutes} more min?`;
    default:
      return QUESTIONS[open.kind];
  }
}

const cut = (text: string | undefined, max: number): string | undefined => {
  const line = text?.replace(/\s+/g, " ").trim();
  if (line === undefined || line === "") return undefined;
  return cutText(line, max);
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
    const attempts = step.attempts.slice(-MAX_ATTEMPTS_SHOWN).map((attempt) => toAttempt(item, attempt));
    // Runs and the limit count the current round: a step sent back to starts again from run 1.
    const round = def && { runs: countedAttempts(step), maxAttempts: attemptLimit(item, step, def.maxAttempts) };
    const detail = stepDetail(step.state, step.attempts, round);
    const note = step.state === "running" ? changesNoteOf(item, step.id) : undefined;
    return {
      name: def?.name ?? step.id,
      stage: checking ? "verifying" : def ? stageOf(def) : "working",
      state: step.state,
      // A step the snapshot does not describe: say it may send data out.
      data: def?.data ?? "repo-and-diff",
      ...(def && { doneWhen: def.doneWhen }),
      ...(def && { agentId: def.agentId }),
      ...(def && def.connections.length > 0 && { uses: def.connections.map(({ connectionId, access }) => ({ connectionId, access })) }),
      ...(detail !== undefined && { detail }),
      ...(attempts.length > 0 && { attempts }),
      ...round,
      ...(note !== undefined && { changesNote: note }),
      ...stepTimes(item, step),
    };
  });

  const decision = toDecision(item, template);
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
  const finish = toFinish(item);
  const cardLine = cut(finishLine(finish) ?? cardLineOf(item, steps, decision?.question), 120);
  const durationMs = itemMs(item);

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
    ...(durationMs !== undefined && { durationMs }),
    ...(outcome && { outcome }),
    ...(finish !== undefined && { finish }),
  } satisfies ItemRecord;
  // The record is checked here, so a bad one is logged once instead of failing every board reply.
  const checked = parseItemRecord(record);
  if (!checked.ok) throw new Error(`item ${item.id} does not map to a valid record: ${checked.error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  return checked.value;
}

/** A done item's worktree and what was done with it; undefined for other items. */
function toFinish(item: StoredItem): ItemRecord["finish"] {
  const worktree = item.worktrees[0];
  if (item.outcome?.kind !== "done" || worktree === undefined) return undefined;
  const stored = item.finish;
  const hosted = worktree.pushUrl === undefined ? undefined : hostedRepo(worktree.pushUrl);
  const failed = stored?.failed && cut(stored.failed.detail, 500);
  const detail = cut(stored?.detail, 500);
  return {
    ...(stored?.running !== undefined && { running: stored.running }),
    ...(stored?.merged !== undefined && { merged: { baseBranch: stored.merged.baseBranch, commit: stored.merged.commit } }),
    ...(stored?.pullRequest !== undefined && { pullRequest: { url: stored.pullRequest.url } }),
    worktreeRemoved: stored?.worktreeRemoved ?? false,
    ...(stored?.failed !== undefined &&
      failed !== undefined && {
        failed: {
          action: stored.failed.action,
          detail: failed,
          ...(stored.failed.reason !== undefined && { reason: stored.failed.reason }),
          ...(stored.failed.changes !== undefined && { changes: stored.failed.changes.slice(0, 30) }),
        },
      }),
    ...(stored?.at !== undefined && { at: stored.at }),
    ...(detail !== undefined && { detail }),
    ...(hosted !== undefined && { pushTarget: `${hosted.host}/${hosted.owner}/${hosted.name}` }),
  };
}

/** The card's line once a finish action ran. */
function finishLine(finish: ItemRecord["finish"]): string | undefined {
  if (finish === undefined) return undefined;
  if (finish.merged !== undefined) return `merged into ${finish.merged.baseBranch} · ${finish.merged.commit.slice(0, 7)}`;
  if (finish.pullRequest !== undefined) return `PR opened · ${finish.pullRequest.url.replace(/^https:\/\//, "")}`;
  if (finish.worktreeRemoved) return "discarded";
  return undefined;
}

function toAttempt(item: StoredItem, attempt: AttemptRecord): AttemptSummary {
  const detail = cut(attempt.detail, 500);
  const durationMs = attemptMs(item, attempt);
  return {
    attempt: attempt.attempt,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt !== undefined && { endedAt: attempt.endedAt }),
    ...(durationMs !== undefined && { durationMs }),
    ...(attempt.result !== undefined && { result: attempt.result }),
    ...(attempt.failure !== undefined && { failure: attempt.failure }),
    ...(detail !== undefined && { detail }),
    ...(attempt.transcriptSaved !== undefined && { transcriptSaved: attempt.transcriptSaved }),
    ...(attempt.transcriptBytes !== undefined && { transcriptBytes: attempt.transcriptBytes }),
    ...(attempt.said !== undefined && { said: attempt.said }),
    checks: attempt.checks.slice(-MAX_CHECKS_SHOWN).map(({ command, passed, exitCode }) => ({ command, passed, exitCode })),
  };
}

function stepDetail(state: StepRecord["state"], attempts: readonly AttemptRecord[], round: { runs: number; maxAttempts: number } | undefined): string | undefined {
  const last = attempts.at(-1);
  switch (state) {
    case "pending":
      return undefined;
    case "running":
      if (last === undefined || round?.runs === 0) return "starting";
      return round === undefined ? `attempt ${last.attempt}` : `attempt ${round.runs} of ${round.maxAttempts}`;
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

/** The note of Request changes, when it is the step's latest answer: the step runs again with it. */
function changesNoteOf(item: StoredItem, stepId: string): string | undefined {
  const last = item.decisions.findLast((d) => d.stepId === stepId && d.resolved !== undefined);
  return last?.kind === "plan_approval" && last.resolved?.choice === REQUEST_CHANGES_ID ? last.resolved.note : undefined;
}

/** The oldest open question. A restart can leave two open; the next shows once this one is answered. */
function toDecision(item: StoredItem, template: TemplateRecord | undefined): Decision | undefined {
  const open = openDecisions(item)[0];
  if (open === undefined) return undefined;
  const at = [open.stepId, item.currentStepId].map((id) => item.steps.findIndex((step) => step.id === id)).find((index) => index >= 0);
  const pending = item.steps.findIndex((step) => step.state !== "passed");
  const why = cut(open.detail, 500);
  const stopped = explainStop(item, open, template);
  const stepIndex = at ?? (pending >= 0 ? pending : item.steps.length - 1);
  const stored = item.steps.find((step) => step.id === open.stepId);
  const def = template?.steps.find((step) => step.id === open.stepId);
  const runLimit = stored !== undefined && def !== undefined ? attemptLimit(item, stored, def.maxAttempts) : undefined;
  return {
    id: open.id,
    kind: open.kind,
    stepIndex,
    question: questionOf(open, template, runLimit),
    ...(why !== undefined && { why }),
    // A step that changed no files has nothing to diff; a log from before the count was kept shows the diff of its tree.
    ...(open.kind === "plan_approval" && open.tree !== undefined && (open.change?.files ?? 1) > 0 && { hasDiff: true }),
    ...(stopped !== undefined && { stopped }),
    choices: choicesOf(open, template).slice(0, 5),
  };
}

/** Choices that run a stopped step again name it ("Run Review again"), in logs written before they did too. */
const RUN_AGAIN = new Set(["retry_step", "one_more_attempt"]);

/** A label the question's words explain; a name too long for a label leaves the stored one. */
const relabel = (choice: DecisionChoice, label: string): DecisionChoice => (label.length <= 64 ? { ...choice, label } : choice);

function choicesOf(open: StoredDecision, template: TemplateRecord | undefined): DecisionChoice[] {
  const name = template?.steps.find((step) => step.id === open.stepId)?.name;
  if (name === undefined) return open.choices;
  if (open.kind === "plan_approval") {
    const { next, commits, files } = approvalOf(open, template);
    return open.choices.map((choice) => {
      if (choice.id === "approve") return relabel(choice, next !== undefined ? `Approve and start ${next.name}` : commits && files !== 0 ? "Approve and commit" : "Approve and finish");
      if (choice.id === REQUEST_CHANGES_ID) return relabel(choice, files === 0 ? "Change the plan…" : "Request changes…");
      return choice;
    });
  }
  if (open.kind !== "after_failure" && open.kind !== "run_failure") return open.choices;
  const label = `Run ${name} again`;
  return open.choices.map((choice) => (RUN_AGAIN.has(choice.id) ? relabel(choice, label) : choice));
}

function cardLineOf(item: StoredItem, steps: readonly StepRecord[], question: string | undefined): string | undefined {
  const commit = item.outcome?.commits?.[0];
  if (commit !== undefined) {
    const branch = item.worktrees.find((w) => w.repoId === commit.repoId)?.branch;
    return `commit ${commit.commit.slice(0, 7)}${branch === undefined ? "" : ` · ${branch}`}`;
  }
  if (item.outcome !== undefined) return item.outcome.detail;
  if (question !== undefined) return question;
  const at = steps.findIndex((step) => step.state !== "passed");
  const step = steps[at];
  if (step === undefined || step.state === "pending") return item.state === "queued" ? "starting" : undefined;
  return step.detail === undefined ? step.name : `${step.name} · ${step.detail}`;
}
