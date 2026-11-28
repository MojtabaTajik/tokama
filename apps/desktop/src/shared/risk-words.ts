// The words of an item's change and risk, for the result card, the list row and the banner. The
// engine rates by fixed rules and sends codes; the words are made here. High and Not rated always
// have a symbol and a word, so colour is never the only signal; Low is the normal case and plain
// text. Type imports only: the renderer and the main process both use this file.
import type { ChangeSummary, ItemRecord, RiskReason, TouchKind } from "@tokama/core";

/** The marks of a risk that is not low. The symbol carries the colour, the word is for screen readers. */
export const RISK_MARKS = {
  high: { symbol: "!", tone: "fail", word: "warning" },
  not_rated: { symbol: "?", tone: "muted", word: "unknown" },
} as const;

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const lines = new Intl.NumberFormat("en");

/** How many reasons a card names before "+N more". */
const REASONS_SHOWN = 2;

/** The kind of sensitive file, as it reads after "changes". */
const KIND_WORDS: Readonly<Record<TouchKind, string>> = {
  dependencies: "dependencies",
  migrations: "database migrations",
  ci: "CI",
  infrastructure: "infrastructure",
  secrets: "secrets or settings",
  sign_in: "sign-in code",
  tests_added: "new tests",
  tests_edited: "edited tests",
};

/** The number of files of a kind, for the Changed row: "2 migrations", "1 CI file", "2 new test files". */
const COUNT_WORDS: Readonly<Record<TouchKind, readonly [string, string]>> = {
  dependencies: ["dependency file", "dependency files"],
  migrations: ["migration", "migrations"],
  ci: ["CI file", "CI files"],
  infrastructure: ["infrastructure file", "infrastructure files"],
  secrets: ["settings or secrets file", "settings or secrets files"],
  sign_in: ["sign-in file", "sign-in files"],
  tests_added: ["new test file", "new test files"],
  tests_edited: ["edited test file", "edited test files"],
};

type ChangeItem = Pick<ItemRecord, "change">;

/** "5 files +61 −40": the files and lines of a change, or only the files when its lines were not counted. */
export function changeText(change: ChangeSummary): string {
  const files = plural(change.files, "file");
  return change.added === undefined || change.removed === undefined ? files : `${files} +${lines.format(change.added)} −${lines.format(change.removed)}`;
}

/** "2 migrations · 1 CI file": how many files of each kind, as the Changed row says it. */
export function touchesText(change: ChangeSummary): string[] {
  return (change.touches ?? []).map(({ kind, files }) => `${files} ${COUNT_WORDS[kind][files === 1 ? 0 : 1]}`);
}

/** The sensitive kinds of a change in one phrase: "dependencies", "database migrations and CI". */
function sensitiveText(change: ChangeSummary | undefined): string {
  const kinds = (change?.touches ?? []).map(({ kind }) => kind).filter((kind) => kind !== "tests_added" && kind !== "tests_edited");
  return kinds.length === 0 ? "a sensitive file" : list.format(kinds.map((kind) => KIND_WORDS[kind]));
}

/** Why a change could not be read: "Tokama could not read the change: binary files only", or no more when git gave no reason. */
function unreadableText(change: ChangeSummary | undefined): string {
  const why = change === undefined ? "this item is from before risk was rated" : change.unreadable === "too_large" ? "the change is too large to count" : change.unreadable === "binary_only" ? "binary files only" : undefined;
  return why === undefined ? "Tokama could not read the change" : `Tokama could not read the change: ${why}`;
}

/** A reason in full, for the result card. */
function reasonText(reason: RiskReason, change: ChangeSummary | undefined): string {
  switch (reason) {
    case "no_checks":
      return "no checks ran on these changes";
    case "review_asked_changes":
      return "the last review asked for changes";
    case "no_review_sensitive":
      return `changes ${sensitiveText(change)} and no second agent reviewed`;
    case "no_review_large":
      return "more than 150 changed lines and no second agent reviewed";
    case "no_review_last_attempt":
      return "the checks passed only on the last allowed attempt and no second agent reviewed";
    case "protected_change":
      return "you approved a change to a protected file";
    case "very_large":
      return "more than 30 files or 800 changed lines";
    case "small_checked_reviewed":
      return "small change, checks and a second agent's review passed";
    case "small_checked":
      return "small change, checks passed";
    case "unreadable_change":
      return unreadableText(change);
  }
}

/** A reason in a few words, for a row and a banner. */
function shortReason(reason: RiskReason, change: ChangeSummary | undefined): string {
  switch (reason) {
    case "no_checks":
      return "no checks ran";
    case "review_asked_changes":
      return "review asked for changes";
    case "no_review_sensitive":
      return `changes ${sensitiveText(change)}, no review`;
    case "no_review_large":
      return "large change, no review";
    case "no_review_last_attempt":
      return "checks passed on the last attempt, no review";
    case "protected_change":
      return "you approved a protected file";
    case "very_large":
      return "very large change";
    case "small_checked_reviewed":
    case "small_checked":
    case "unreadable_change":
      return reasonText(reason, change);
  }
}

export interface RiskWords {
  readonly level: "low" | "high" | "not_rated";
  /** "Low", "High" or "Not rated". */
  readonly word: string;
  /** The reasons the card names (two), in full. */
  readonly shown: readonly string[];
  /** The reasons past those, in full, behind "+N more". */
  readonly more: readonly string[];
  /** The first reason in a few words, for a row and a banner; absent for low and not rated, whose row says no more. */
  readonly first: string | undefined;
}

/** The risk of an item in words; undefined when it has none (nothing was changed, or the item did not finish). */
export function riskWords(item: ChangeItem & Pick<ItemRecord, "risk">): RiskWords | undefined {
  const { risk, change } = item;
  if (risk === undefined) return undefined;
  const reasons = risk.reasons.map((reason) => reasonText(reason, change));
  return {
    level: risk.level,
    word: risk.level === "low" ? "Low" : risk.level === "high" ? "High" : "Not rated",
    shown: reasons.slice(0, REASONS_SHOWN),
    more: reasons.slice(REASONS_SHOWN),
    first: risk.level === "high" ? shortReason(risk.reasons[0]!, change) : undefined,
  };
}

/** The risk of a done item in words for a banner, when it is not low: "risk high: changes dependencies, no review". */
export function riskBanner(item: ChangeItem & Pick<ItemRecord, "risk">): string | undefined {
  const words = riskWords(item);
  if (words === undefined || words.level === "low") return undefined;
  return words.level === "high" ? `risk high: ${words.first}` : "risk not rated";
}
