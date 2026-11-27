// What the result card on an ended item says, as plain data: the agent's words (its headline, in
// one of three sizes, or the first lines of its output), why the item stopped when it did not
// finish, and the fact rows Checked, Reviewed and Sent out, each from the item's own record. A
// fact that is normal is grey text; only ✕ and ! carry a colour, and every mark has a word for
// screen readers. A row with nothing to say is left out, except where its absence is the news
// ("– Quick fix has no review step"). Pure functions, tested without React.
import type { ItemRecord, Setup, StepRecord } from "@tokama/core";
import { checkAttempts, checksOf, failureLine } from "../../shared/item-facts.js";
import { readTag, saidOf } from "../../shared/item-said.js";
import { agentInfo } from "../agent/agent-info.js";
import { backendOf } from "../brand/backends/index.js";
import { type Mark, markOf } from "../ui/status.js";
import { bytesText } from "./attempt-view.js";
import { stepAgent, templateName } from "./describe.js";

/**
 * A reply without points has "more to read" from this size on: about 60 words, at the 6 to 7
 * bytes a word of English takes. Below it the headline is the whole output.
 */
const LONG_BODY_BYTES = 400;

/** The marks of the rows, from the status table. The card colours only ✕ and !: a normal fact is grey. */
export const MARKS = {
  ok: markOf("passed"),
  fail: markOf("failed"),
  warn: markOf("warning"),
  none: markOf("unknown", "none"),
  sent: markOf("pull_request", "sent out"),
} as const;

export interface ResultRow {
  readonly key: "checked" | "reviewed" | "sent";
  readonly label: string;
  readonly mark?: Mark;
  readonly text: string;
  /** A second line in mono: the commands that ran, the tool and model that reviewed. */
  readonly detail?: string;
}

/** What the step's agent said in its own words: a headline, the points it wrote, and how much more there is to read. */
export interface SaidWords {
  readonly kind: "said";
  readonly agent: string;
  readonly stepIndex: number;
  readonly headline: string;
  readonly points: readonly string[];
  /** Points the agent wrote past the ones carried. */
  readonly morePoints: number;
  /** A must-read: "read · 6 min". The card then offers the reader and does not shorten anything. */
  readonly read: string | undefined;
  /** The size of the output ("2.4 KB") when there is more than the card shows. */
  readonly more: string | undefined;
}

/** The first lines of an output, for an agent that wrote no headline, as the engine kept them. */
export interface LinesWords {
  readonly kind: "lines";
  readonly agent: string;
  readonly stepIndex: number;
  readonly lines: readonly string[];
  readonly more: string | undefined;
}

/** An item that has no words of its agent at all: the card asks for the first lines of this attempt's output. */
export interface FetchWords {
  readonly kind: "fetch";
  readonly agent: string;
  readonly stepIndex: number;
  readonly attempt: number;
}

export type ResultWords = SaidWords | LinesWords | FetchWords;

export interface ResultView {
  /** Why an item that did not finish stopped, in Tokama's words: "Stopped at Build, step 2 of 3: pnpm test failed 3 times". */
  readonly failure: string | undefined;
  readonly words: ResultWords | undefined;
  readonly rows: readonly ResultRow[];
}

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const isReviewer = (step: Pick<StepRecord, "doneWhen">): boolean => step.doneWhen === "reviewer approves";

/** The latest ended attempt of an agent's step: the output that stands for it. */
const endedAttempt = (step: StepRecord): number | undefined => (step.agentId === undefined ? undefined : step.attempts?.findLast((attempt) => attempt.result !== undefined)?.attempt);

/** The step whose output stands for the item when its agent wrote no headline: the last worker that passed, else the last agent that ended an attempt. */
function outputStep(item: Pick<ItemRecord, "steps">): { readonly stepIndex: number; readonly attempt: number } | undefined {
  const find = (accept: (step: StepRecord) => boolean) => {
    for (let stepIndex = item.steps.length - 1; stepIndex >= 0; stepIndex--) {
      const step = item.steps[stepIndex]!;
      const attempt = accept(step) ? endedAttempt(step) : undefined;
      if (attempt !== undefined) return { stepIndex, attempt };
    }
    return undefined;
  };
  return find((step) => step.state === "passed" && !isReviewer(step)) ?? find(() => true);
}

function wordsOf(item: ItemRecord, setup: Setup | undefined): ResultWords | undefined {
  const agents = setup?.agents ?? [];
  const found = saidOf(item);
  if (found !== undefined) {
    const { said, stepIndex } = found;
    const agent = stepAgent(item.steps[stepIndex]!, agents).name;
    const size = bytesText(said.bodyBytes);
    if (said.source === "first_lines") {
      return { kind: "lines", agent, stepIndex, lines: [said.headline, ...said.points], more: said.bodyBytes > 0 ? size : undefined };
    }
    const mustRead = said.readMinutes !== undefined;
    // A reply that is only the headline block has nothing more to read, whatever points it carries.
    const more = !mustRead && said.bodyBytes > 0 && (said.points.length + said.morePoints > 0 || said.bodyBytes >= LONG_BODY_BYTES);
    return { kind: "said", agent, stepIndex, headline: said.headline, points: said.points, morePoints: said.morePoints, read: readTag(said), more: more ? size : undefined };
  }
  const step = outputStep(item);
  return step === undefined ? undefined : { kind: "fetch", agent: stepAgent(item.steps[step.stepIndex]!, agents).name, ...step };
}

function checkedRow(item: ItemRecord, described: boolean): ResultRow | undefined {
  const label = "Checked";
  const checks = checksOf(item);
  const latest = checkAttempts(item);
  if (checks !== undefined) {
    const counts = `${checks.passed} of ${checks.total} ${checks.total === 1 ? "check" : "checks"} passed`;
    if (checks.passed < checks.total) {
      const failed = latest.flatMap(({ attempt }) => attempt.checks).find((check) => !check.passed);
      const why = failed === undefined ? undefined : `${failed.command} ${failed.exitCode === null ? "stopped by a signal" : `exit ${failed.exitCode}`}`;
      return { key: "checked", label, mark: MARKS.fail, text: counts, ...(why !== undefined && { detail: why }) };
    }
    // The checks that decided it ran again after a failure: "on attempt 3 of 3".
    const last = latest.reduce((best, entry) => (entry.attempt.attempt > best.attempt.attempt ? entry : best));
    const retried = last.attempt.attempt > 1 ? `, on attempt ${last.attempt.attempt}${last.step.maxAttempts === undefined ? "" : ` of ${last.step.maxAttempts}`}` : "";
    const commands = [...new Set(latest.flatMap(({ attempt }) => attempt.checks.map((check) => check.command)))];
    return { key: "checked", label, mark: MARKS.ok, text: `${counts}${retried}`, detail: commands.join(" · ") };
  }
  if (!described) return undefined;
  if (item.kind === "investigation") {
    const approved = item.steps.some((step) => step.doneWhen === "you approve" && step.state === "passed");
    return approved ? { key: "checked", label, mark: MARKS.ok, text: "You approved the findings" } : undefined;
  }
  // An item that ended early with nothing to change has nothing to check.
  if (item.outcome?.kind === "no_action_needed") return undefined;
  const templateRuns = item.steps.some((step) => step.doneWhen === "checks pass");
  if (!templateRuns) return { key: "checked", label, mark: MARKS.warn, text: "This template runs no checks" };
  return item.state === "done" ? { key: "checked", label, mark: MARKS.warn, text: "No checks ran" } : { key: "checked", label, mark: MARKS.none, text: "Checks did not run" };
}

function reviewedRow(item: ItemRecord, setup: Setup | undefined, described: boolean): ResultRow | undefined {
  const label = "Reviewed";
  const at = item.steps.findLastIndex(isReviewer);
  if (at === -1) {
    // A read-only item has nothing to review; for others a missing review is said, so it is seen and not guessed.
    if (!described || item.kind === "investigation") return undefined;
    return { key: "reviewed", label, mark: MARKS.none, text: `${templateName(item, setup)} has no review step` };
  }
  const step = item.steps[at]!;
  const name = stepAgent(step, setup?.agents ?? []).name;
  if (step.state === "passed") {
    const info = agentInfo(item, at, setup);
    const who = [info?.cliId === undefined ? undefined : backendOf(info.cliId).name, info?.model].filter((part) => part !== undefined);
    return { key: "reviewed", label, mark: MARKS.ok, text: `${name} approved`, ...(who.length > 0 && { detail: who.join(" · ") }) };
  }
  // A run that failed gave no verdict; the last attempt that did decides.
  const verdict = step.attempts?.findLast((attempt) => attempt.result !== undefined && attempt.result !== "run_failed");
  if (verdict?.result === "failed") return { key: "reviewed", label, mark: MARKS.warn, text: `${name} asked for changes` };
  return { key: "reviewed", label, mark: MARKS.none, text: "Review did not run" };
}

const SENT_PHRASE = { "repo-and-diff": "Code and diffs to", "summary-after-approval": "The summary you approved to" } as const;

/** What left the machine, from the steps that ran: a step that never ran sent nothing, and a step that may send is always listed. */
function sentRow(item: ItemRecord, setup: Setup | undefined): ResultRow {
  const label = "Sent out";
  const agents = setup?.agents ?? [];
  const to = new Map<keyof typeof SENT_PHRASE, Set<string>>();
  for (const step of item.steps) {
    if (step.agentId === undefined || step.data === "none") continue;
    // A step that stopped at its approval question has no attempt: nothing was sent. A passed step with none is an old record.
    if ((step.attempts?.length ?? 0) === 0 && step.state !== "passed") continue;
    const agent = stepAgent(step, agents);
    // A local agent runs on this machine: its data rule allows sending, but it sent nothing. An agent the setup no longer lists counts as cloud.
    if (agent.runsOn === "local") continue;
    const tools = to.get(step.data) ?? new Set<string>();
    tools.add(agent.cliId === undefined ? agent.name : backendOf(agent.cliId).name);
    to.set(step.data, tools);
  }
  const parts = [...to].map(([rule, tools]) => `${SENT_PHRASE[rule]} ${list.format(tools)}`);
  // Open PR pushed the branch: that left the machine too.
  if (item.finish?.pullRequest !== undefined) parts.push(`The branch to ${item.finish.pushTarget ?? "the remote"}`);
  if (parts.length === 0) return { key: "sent", label, text: "Nothing: local only" };
  return { key: "sent", label, mark: MARKS.sent, text: parts.join(" · ") };
}

/** The card of an item that has ended: done, failed or stopped. */
export function resultView(item: ItemRecord, setup: Setup | undefined): ResultView {
  // Without the template's own words for its steps (a record the snapshot does not describe), what a template lacks cannot be said.
  const described = item.steps.some((step) => step.doneWhen !== undefined);
  const failure = item.state === "done" ? undefined : failureLine(item);
  const words = wordsOf(item, setup);
  return {
    failure,
    // What an item that did not finish says is what its agent wrote, not the first lines of its output.
    words: failure !== undefined && !(words?.kind === "said") ? undefined : words,
    rows: [checkedRow(item, described), reviewedRow(item, setup, described), sentRow(item, setup)].filter((row) => row !== undefined),
  };
}
