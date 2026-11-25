// What the Checks and Log tabs show, as plain functions: which steps run checks, which attempts
// have a transcript, and the words for durations, sizes and the cap note. The `useAttemptReply`
// hook asks the engine for one attempt's checks or transcript, again when the attempt changes,
// and every few seconds while it runs.
import type { AttemptSummary, ItemRecord, QueryResult, Setup, StepRecord } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

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

/** The steps an agent runs, by index: the ones with a transcript. */
export const agentSteps = (item: Pick<ItemRecord, "steps">): number[] => item.steps.flatMap((step, index) => (step.agentId === undefined ? [] : [index]));

/** The name of the agent step whose work a check step checks: itself, or the agent step before it. */
export function checkedStepName(item: Pick<ItemRecord, "steps">, index: number): string {
  for (let at = index; at >= 0; at--) if (item.steps[at]?.agentId !== undefined) return item.steps[at]!.name;
  return item.steps[index]?.name ?? "the step";
}

/** "4.2 s", "14 s", "1 min 52 s"; "–" when not known. */
export function durationText(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** "512 B", "96 KB", "212.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const count = (n: number) => n.toLocaleString("en-US");

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
 * on) and every POLL_MS while `live`; the last answer stays on screen while a new one is asked.
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
    if (!live) return;
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    let current = true;
    const settle = (state: ReplyState<QueryResult<T>>) => current && setAnswer({ for: asked, state });
    void bridge
      .query({ type, itemId, stepIndex, attempt } as { type: "attempt_checks"; itemId: string; stepIndex: number; attempt: number })
      .then((reply) => settle(reply.ok ? { kind: "loaded", data: reply.data as QueryResult<T> } : reply.error.code === "not_found" ? { kind: "missing", message: reply.error.message } : { kind: "failed", message: reply.error.message }))
      .catch((cause: unknown) => settle({ kind: "failed", message: String(cause) }));
    return () => {
      current = false;
    };
  }, [bridge, type, itemId, stepIndex, attempt, asked, version, tick]);
  return answer?.for === asked ? answer.state : LOADING;
}
