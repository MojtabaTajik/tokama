// The risk of a change: low, high, or not rated, from fixed rules over facts Tokama measured.
// No AI judges it. The engine stores the facts and rates them each time the item is read, so a
// changed rule needs no migration. Every rating carries its reasons, in rule order.
import type { ChangeSummary, Risk, RiskReason, TouchKind } from "../../kernel/schemas/index.js";

/** More changed lines than this, with no second agent's review, is high. */
export const LARGE_LINES = 150;
/** More files or lines than these is high, reviewed or not. */
export const VERY_LARGE_FILES = 30;
export const VERY_LARGE_LINES = 800;

export interface RiskFacts {
  /** Undefined for an item whose change was never recorded: one from before this feature. */
  readonly change: ChangeSummary | undefined;
  /** A check passed on the tree that is committed (or, for a change waiting for approval, on that tree). */
  readonly checked: boolean;
  /** What the last reviewer said, when a reviewer ran. */
  readonly lastVerdict: "approve" | "changes" | undefined;
  /** An agent other than the one that wrote the change approved it. */
  readonly secondReview: boolean;
  /** The checks passed only on the last attempt the step allowed, after checks failed. */
  readonly lastAttempt: boolean;
  /** The engineer approved a change to a protected file. */
  readonly protectedApproved: boolean;
}

const SENSITIVE: ReadonlySet<TouchKind> = new Set(["dependencies", "migrations", "ci", "infrastructure", "secrets", "sign_in"]);

/** The kinds of sensitive file a change touches. */
export const sensitiveTouches = (change: ChangeSummary): TouchKind[] => (change.touches ?? []).map((touch) => touch.kind).filter((kind) => SENSITIVE.has(kind));

/** The changed lines of a change, added and removed. */
export const changedLines = (change: ChangeSummary): number => (change.added ?? 0) + (change.removed ?? 0);

export function risk(facts: RiskFacts): Risk {
  const { change } = facts;
  // A change counted in full has its lines; one logged before lines were counted has only a file count.
  if (change === undefined || change.unreadable !== undefined || change.added === undefined) return { level: "not_rated", reasons: ["unreadable_change"] };
  const lines = changedLines(change);
  const high: RiskReason[] = [];
  if (!facts.checked) high.push("no_checks");
  if (facts.lastVerdict === "changes") high.push("review_asked_changes");
  if (!facts.secondReview) {
    if (sensitiveTouches(change).length > 0) high.push("no_review_sensitive");
    if (lines > LARGE_LINES) high.push("no_review_large");
    if (facts.lastAttempt) high.push("no_review_last_attempt");
  }
  if (facts.protectedApproved) high.push("protected_change");
  if (change.files > VERY_LARGE_FILES || lines > VERY_LARGE_LINES) high.push("very_large");
  if (high.length > 0) return { level: "high", reasons: high };
  return { level: "low", reasons: [facts.secondReview ? "small_checked_reviewed" : "small_checked"] };
}
