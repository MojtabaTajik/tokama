// What the shell derives from engine records. Pure functions, so they are tested without React.
// The renderer may import core types only (no values), so the board-column rule is restated here
// and pinned to core's `itemStage` by a test.
import type { AiCliId, ItemRecord, Stage } from "@tokama/core";

/** The board column of an item: the same rule as core's `itemStage`. */
export function stageOf(item: Pick<ItemRecord, "state" | "steps">): Stage {
  if (item.state === "queued") return "queued";
  if (item.state === "done" || item.state === "stopped" || item.state === "failed") return "done";
  return item.steps.find((step) => step.state !== "passed")?.stage ?? "done";
}

/** Items that are still going: the sidebar lists only these. */
export function isLive(item: Pick<ItemRecord, "state">): boolean {
  return item.state === "queued" || item.state === "running" || item.state === "needs_you";
}

export type Marker = { readonly symbol: "⏸" | "●" | "◐" | "◌"; readonly word: string; readonly tone: "warn" | "live" | "muted" };

/** A live item's marker in the sidebar: a symbol and a word, so colour is never the only signal. */
export function markerOf(item: Pick<ItemRecord, "state" | "steps">): Marker {
  if (item.state === "needs_you") return { symbol: "⏸", word: "needs you", tone: "warn" };
  if (item.state === "queued") return { symbol: "◌", word: "queued", tone: "muted" };
  const stage = stageOf(item);
  if (stage === "verifying") return { symbol: "◐", word: "checks", tone: "muted" };
  return { symbol: "●", word: stage === "review" ? "review" : "working", tone: "live" };
}

export function needsYouCount(items: Iterable<Pick<ItemRecord, "state">>): number {
  let count = 0;
  for (const item of items) if (item.state === "needs_you") count++;
  return count;
}

/** The AI CLIs the rail shows a usage ring for, with their text monograms (never a logo). */
export const AI_CLIS: readonly { readonly id: AiCliId; readonly monogram: string; readonly name: string }[] = [
  { id: "claude-code", monogram: "CC", name: "Claude Code" },
  { id: "codex-cli", monogram: "CX", name: "Codex CLI" },
  { id: "ollama", monogram: "OL", name: "Ollama" },
];
