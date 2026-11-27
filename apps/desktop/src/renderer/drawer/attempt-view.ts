// What the Checks and Log tabs show, as plain functions: which steps run checks, which attempts
// have a transcript, and the words for durations, sizes and the cap note. The `useAttemptReply`
// hook asks the engine for one attempt's checks or transcript, again when the attempt changes,
// and every few seconds while it runs.
import type { AttemptSummary, ItemRecord, QueryResult, Setup, StepRecord } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { formatDuration } from "../format/duration.js";
import { clock } from "../format/time.js";

/** How often a running attempt's checks or transcript are read again while its tab is open. */
export const POLL_MS = 2000;

/** The item changes a repo: its template edits the picked repo, as the "changes <repo>" label says. */
export const changesRepo = (item: Pick<ItemRecord, "kind" | "repoIds">): boolean => item.kind === "task" && item.repoIds.length > 0;

export interface StepAttempt {
  readonly index: number;
  readonly step: StepRecord;
  readonly attempt: AttemptSummary;
}

/**
 * The steps that run checks, by index: those the template gives checks, and any step that
 * recorded one (the setup may not know the template any more).
 */
export function checkSteps(item: Pick<ItemRecord, "templateId" | "steps">, setup: Setup | undefined): number[] {
  const template = setup?.templates.find((candidate) => candidate.id === item.templateId);
  return item.steps.flatMap((step, index) => (template?.steps[index]?.checks !== undefined || (step.attempts ?? []).some((a) => a.checks.length > 0) ? [index] : []));
}

/** The attempts of the given steps, in step order and oldest first. */
export function attemptsOf(item: Pick<ItemRecord, "steps">, indexes: readonly number[]): StepAttempt[] {
  return indexes.flatMap((index) => {
    const step = item.steps[index]!;
    return (step.attempts ?? []).map((attempt) => ({ index, step, attempt }));
  });
}

/** The check commands a step runs after its agent, as the template and the item's repo give them now; none when the setup does not say. */
export function plannedChecks(item: Pick<ItemRecord, "templateId" | "repoIds">, setup: Setup | undefined, index: number): readonly string[] {
  const checks = setup?.templates.find((template) => template.id === item.templateId)?.steps[index]?.checks;
  if (checks === undefined) return [];
  return "commands" in checks ? checks.commands : (setup?.repos.find((repo) => repo.id === item.repoIds[0])?.checks ?? []);
}

/** The steps an agent runs, by index: the ones with a transcript. */
export const agentSteps = (item: Pick<ItemRecord, "steps">): number[] => item.steps.flatMap((step, index) => (step.agentId === undefined ? [] : [index]));

/** The name of the agent step whose work a check step checks: itself, or the agent step before it. */
export function checkedStepName(item: Pick<ItemRecord, "steps">, index: number): string {
  for (let at = index; at >= 0; at--) if (item.steps[at]?.agentId !== undefined) return item.steps[at]!.name;
  return item.steps[index]?.name ?? "the step";
}

/** "4.2 s", "14 s", "1 m 52 s"; "–" when not known. */
export const durationText = (ms: number | null): string => (ms === null ? "–" : formatDuration(ms, "fine"));

/** "512 B", "96 KB", "212.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const count = (n: number) => n.toLocaleString("en-US");

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "4 minutes 12 seconds": a duration with its units spelled, for screen readers. */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const parts = [
    [Math.floor(seconds / 86_400), "day"],
    [Math.floor((seconds % 86_400) / 3600), "hour"],
    [Math.floor((seconds % 3600) / 60), "minute"],
    [seconds % 60, "second"],
  ] as const;
  const shown = parts.filter(([n]) => n > 0).map(([n, word]) => unit(n, word));
  return shown.length === 0 ? unit(0, "second") : shown.join(" ");
}

/** "38 kilobytes": a size with its unit spelled, for screen readers. */
export function spokenSize(bytes: number): string {
  if (bytes < 1024) return unit(bytes, "byte");
  if (bytes < 1024 * 1024) return unit(Math.round(bytes / 1024), "kilobyte");
  return `${(bytes / (1024 * 1024)).toFixed(1)} megabytes`;
}

/** A line's facts as they are seen and as they are spoken. */
export interface LineFacts {
  readonly text: string;
  readonly spoken: string;
}

const joinFacts = (parts: readonly { readonly text: string; readonly spoken?: string }[]): LineFacts => ({
  text: parts.map((part) => part.text).join(" · "),
  spoken: parts.map((part) => part.spoken ?? part.text).join(", "),
});

/** How long an attempt worked: its recorded time once it ended, the time since it started while it runs. */
export const attemptMs = (attempt: Pick<AttemptSummary, "durationMs" | "startedAt" | "result">, now: number): number | undefined =>
  attempt.durationMs ?? (attempt.result === undefined && attempt.startedAt !== undefined ? Math.max(0, now - attempt.startedAt) : undefined);

/**
 * The bytes of the transcripts of these attempts, when every one that has a transcript says its
 * size; an older record that does not leaves the whole size unknown. Running attempts add nothing yet.
 */
export function transcriptBytes(attempts: readonly Pick<AttemptSummary, "result" | "transcriptSaved" | "transcriptBytes">[]): number | undefined {
  let total = 0;
  let known = false;
  for (const attempt of attempts) {
    if (attempt.result === undefined || attempt.transcriptSaved === false) continue;
    if (attempt.transcriptBytes === undefined) return undefined;
    total += attempt.transcriptBytes;
    known = true;
  }
  return known ? total : undefined;
}

/** A size as the line shows and speaks it; undefined when it is not known. */
export const sizeFact = (bytes: number | undefined): LineFacts | undefined => (bytes === undefined ? undefined : { text: sizeText(bytes), spoken: spokenSize(bytes) });

/** A step's line: "3 attempts · 4 m 12 s · 38 KB"; a running step says "attempt 2 of 3". `size` is of what the tab shows: transcripts, an output. */
export function stepFacts(step: Pick<StepRecord, "attempts" | "runs" | "maxAttempts">, now: number, size: LineFacts | undefined): LineFacts {
  const attempts = step.attempts ?? [];
  if (attempts.length === 0) return { text: "no log", spoken: "no log" };
  const running = attempts.at(-1)!.result === undefined;
  const total = attempts.flatMap((attempt) => attemptMs(attempt, now) ?? []).reduce((sum, ms) => sum + ms, 0);
  const timed = attempts.some((attempt) => attemptMs(attempt, now) !== undefined);
  return joinFacts([
    { text: running && step.runs !== undefined && step.maxAttempts !== undefined ? `attempt ${step.runs} of ${step.maxAttempts}` : unit(attempts.length, "attempt") },
    ...(timed ? [{ text: formatDuration(total), spoken: spokenDuration(total) }] : []),
    ...(size === undefined ? [] : [size]),
  ]);
}

/** An attempt's line: "14:16 · 1 m 22 s · 12 KB". */
export function attemptFacts(attempt: Pick<AttemptSummary, "startedAt" | "durationMs" | "result" | "transcriptSaved" | "transcriptBytes">, now: number): LineFacts {
  const ms = attemptMs(attempt, now);
  const size = sizeFact(attempt.transcriptSaved === false ? undefined : attempt.transcriptBytes);
  return joinFacts([
    ...(attempt.startedAt === undefined ? [] : [{ text: clock(attempt.startedAt) }]),
    ...(ms === undefined ? [] : [{ text: formatDuration(ms), spoken: spokenDuration(ms) }]),
    ...(size === undefined ? [] : [size]),
  ]);
}

/** The Log bar: "3 steps · 5 attempts · 248 KB"; the size only when every transcript's size is known. */
export function logFacts(steps: readonly Pick<StepRecord, "attempts">[]): string {
  const attempts = steps.flatMap((step) => step.attempts ?? []);
  const bytes = transcriptBytes(attempts);
  return [unit(steps.length, "step"), unit(attempts.length, "attempt"), ...(bytes === undefined ? [] : [sizeText(bytes)])].join(" · ");
}

/** The lines of a reply's text; an empty text has none. */
export const linesOf = (text: string): string[] => (text === "" ? [] : text.split("\n"));

/** "Last 40 of 1,312 lines · 96 KB": how much of a saved file a cut reply shows. */
export function capNote(tail: { readonly text: string; readonly totalBytes: number; readonly totalLines: number | null }, lead = "Last"): string {
  const shown = linesOf(tail.text).length;
  return tail.totalLines === null ? `${lead} ${count(shown)} lines · ${sizeText(tail.totalBytes)}` : `${lead} ${count(shown)} of ${count(tail.totalLines)} lines · ${sizeText(tail.totalBytes)}`;
}

/** A transcript line: a tool call (`→ Read src/x.ts`), the agent's words, or a gap between messages. */
export type TranscriptLine = { readonly kind: "tool" | "text"; readonly text: string } | { readonly kind: "gap" };

export function transcriptLines(text: string): TranscriptLine[] {
  return linesOf(text).map((line) => (line.startsWith("→ ") ? { kind: "tool", text: line.slice(2) } : line.trim() === "" ? { kind: "gap" } : { kind: "text", text: line }));
}

export type ReplyState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly data: T };

const LOADING = { kind: "loading" } as const;

/**
 * One attempt's checks or transcript. Asked again when `version` changes (the item record moved
 * on) and, while `live`, POLL_MS after each answer, so a slow engine is never asked twice at once.
 * The last answer stays on screen while a new one is asked.
 */
export function useAttemptReply<T extends "attempt_checks" | "attempt_log">(
  bridge: TokamaBridge,
  type: T,
  key: { readonly itemId: string; readonly stepIndex: number; readonly attempt: number },
  version: string,
  live: boolean,
): ReplyState<QueryResult<T>> {
  const { itemId, stepIndex, attempt } = key;
  const asked = `${type} ${itemId} ${stepIndex} ${attempt}`;
  const [answer, setAnswer] = useState<{ readonly for: string; readonly state: ReplyState<QueryResult<T>> } | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (state: ReplyState<QueryResult<T>>) => {
      if (!current) return;
      setAnswer({ for: asked, state });
      if (live) timer = setTimeout(() => setTick((n) => n + 1), POLL_MS);
    };
    void bridge
      .query({ type, itemId, stepIndex, attempt } as { type: "attempt_checks"; itemId: string; stepIndex: number; attempt: number })
      .then((reply) => settle(reply.ok ? { kind: "loaded", data: reply.data as QueryResult<T> } : reply.error.code === "not_found" ? { kind: "missing", message: reply.error.message } : { kind: "failed", message: reply.error.message }))
      .catch((cause: unknown) => settle({ kind: "failed", message: String(cause) }));
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bridge, type, itemId, stepIndex, attempt, asked, version, tick, live]);
  return answer?.for === asked ? answer.state : LOADING;
}
