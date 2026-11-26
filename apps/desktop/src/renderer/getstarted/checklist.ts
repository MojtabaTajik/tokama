// What the Get started checklist shows: four rows, each with a title that never changes, a mark and
// a word, the line under it and its action. Pure: the engine's health, the repos and templates go
// in, rows come out; nothing here reads the clock or the screen. Text comes from words.ts, and
// whatever the engine wrote is carried as plain text, never as markup.
import type { CliHealth, Health, RepoSummary, TemplateSummary } from "@tokama/core";
import { noChecks, QUICK_CHANGE_ID } from "../newwork/needs.js";
import { type Mark, markOf } from "../ui/status.js";
import { CLAUDE_CODE_MIN, COMMANDS, GIT_MIN, LINKS, SAMPLE_TASK, TEXT, TITLES, WORDS } from "./words.js";

export const QUICK_FIX_ID = "builtin/quick-fix";

export type RowId = "ai-cli" | "git" | "repo" | "quick-fix";

/** One piece of the line under a row's title. */
export type Part =
  | string
  | { readonly strong: string }
  | { readonly code: string }
  | { readonly quote: string }
  /** The tool's icon before its name. */
  | { readonly tool: "claude-code" }
  /** A link to the product site, opened in the browser. */
  | { readonly link: { readonly text: string; readonly href: string } }
  /** A link that does something in the app. */
  | { readonly act: { readonly text: string; readonly id: "edit-repo" | "open-templates" } };

export type Action =
  | { readonly kind: "link"; readonly label: string; readonly href: string }
  | { readonly kind: "add-repo"; readonly label: string }
  | { readonly kind: "check-again"; readonly label: string }
  /** Opens New work filled in with `prefill`; off (`locked`) until steps 1 to 3 are done. */
  | { readonly kind: "start"; readonly label: string; readonly locked: boolean; readonly prefill?: { readonly templateId?: string; readonly repoId: string; readonly text: string } };

export interface Row {
  readonly id: RowId;
  readonly title: string;
  readonly mark: Mark;
  /** The status word beside the title; the mark never stands alone. */
  readonly word: string;
  readonly done: boolean;
  readonly detail: readonly Part[];
  /** What the engine wrote about the problem, exactly as sent: shown as text, with no link and no Copy. */
  readonly engineText?: string;
  /** A command to run in a terminal, shown with Copy. */
  readonly command?: string;
  readonly action?: Action;
}

export interface Checklist {
  readonly rows: readonly Row[];
  readonly doneCount: number;
  /** The first row that is not done: its action is the filled button. */
  readonly next: RowId | undefined;
  readonly subtitle: string;
}

export interface ChecklistInput {
  /** Undefined until the setup has loaded. */
  readonly health: Health | undefined;
  /** The last setup load failed, or the engine is not answering: the health on hand may be old. */
  readonly checkFailed: boolean;
  /** Check again is running. */
  readonly checking: boolean;
  readonly repos: readonly RepoSummary[];
  readonly templates: readonly TemplateSummary[];
  /** An item or a finished-item count exists: step 4 is done. */
  readonly started: boolean;
  /** What the first item was, when known, for step 4's line. */
  readonly firstItem: { readonly text: string; readonly repoId: string | undefined } | undefined;
  readonly mac: boolean;
}

/** `a` is at least `b`: dotted numbers compared part by part. */
export function atLeast(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** The first dotted number in a version text such as "2.1.332" or "git version 2.47.1 (Apple Git-154)". */
export const numberIn = (text: string | undefined): string | undefined => (text === undefined ? undefined : /\d+(?:\.\d+)+/.exec(text)?.[0]);

export type AiCliState =
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "not_installed" }
  | { readonly kind: "logged_out"; readonly version: string | undefined }
  | { readonly kind: "too_old"; readonly version: string }
  | { readonly kind: "needs_fix"; readonly version: string | undefined; readonly message: string }
  | { readonly kind: "checking" }
  | { readonly kind: "could_not_check" };

/** Where the AI CLI stands, from the engine's health of Claude Code (the one AI CLI Tokama runs for now). */
export function aiCliState(health: Health | undefined): AiCliState {
  const cli: CliHealth | undefined = health?.clis.find((entry) => entry.cliId === "claude-code");
  if (cli === undefined) return { kind: "could_not_check" };
  if (cli.timedOut === true) return { kind: "checking" };
  if (!cli.installed) return { kind: "not_installed" };
  const version = numberIn(cli.version);
  if (!cli.loggedIn) return { kind: "logged_out", version };
  if (version !== undefined && !atLeast(version, CLAUDE_CODE_MIN)) return { kind: "too_old", version };
  if (cli.message !== undefined || version === undefined) return { kind: "needs_fix", version, message: cli.message ?? "" };
  return { kind: "ready", version };
}

/** The word of an AI CLI problem that stops new work, or undefined when work may start (or Tokama cannot tell yet, and the engine then answers for itself). */
export function aiCliBlock(health: Health | undefined): string | undefined {
  const state = aiCliState(health);
  switch (state.kind) {
    case "not_installed":
      return WORDS.notInstalled;
    case "logged_out":
      return WORDS.loggedOut;
    case "too_old":
      return WORDS.tooOld;
    case "needs_fix":
      return WORDS.needsFix;
    default:
      return undefined;
  }
}

const row = (id: RowId, title: string, mark: Mark, word: string, rest: Partial<Pick<Row, "detail" | "engineText" | "command" | "action">> = {}): Row => ({
  id,
  title,
  mark,
  word,
  done: mark.symbol === markOf("passed").symbol,
  detail: [],
  ...rest,
});

const FAILED = markOf("failed");
const READY = markOf("passed");
const TODO = markOf("pending");

function aiCliRow(input: ChecklistInput): Row {
  const title = TITLES.aiCli;
  const recheck: Action = { kind: "check-again", label: TEXT.checkAgain };
  if (input.checking) return row("ai-cli", title, markOf("queued"), WORDS.checking, { detail: [TEXT.cliChecking] });
  if (input.checkFailed) return row("ai-cli", title, markOf("warning"), WORDS.couldNotCheck, { detail: [TEXT.cliCouldNot], action: recheck });
  const state = aiCliState(input.health);
  const named = (version: string | undefined): Part[] => [{ tool: "claude-code" }, { strong: version === undefined ? TEXT.cliName : `${TEXT.cliName} ${version}` }];
  switch (state.kind) {
    case "could_not_check":
      return row("ai-cli", title, markOf("warning"), WORDS.couldNotCheck, { detail: [TEXT.cliCouldNot], action: recheck });
    case "checking":
      return row("ai-cli", title, markOf("queued"), WORDS.checking, { detail: [TEXT.cliChecking] });
    case "not_installed":
      return row("ai-cli", title, FAILED, WORDS.notInstalled, { detail: [TEXT.cliNone], action: { kind: "link", label: TEXT.cliInstall, href: LINKS.installClaudeCode } });
    case "logged_out":
      return row("ai-cli", title, FAILED, WORDS.loggedOut, { detail: [...named(state.version), ` ${TEXT.cliLoggedOut}`], command: COMMANDS.login });
    case "too_old":
      return row("ai-cli", title, FAILED, WORDS.tooOld, { detail: [...named(state.version), ` ${TEXT.cliTooOld}`], command: COMMANDS.update });
    case "needs_fix":
      return row("ai-cli", title, FAILED, WORDS.needsFix, {
        detail: [...named(state.version), ` ${state.version === undefined ? TEXT.cliCannotRun : TEXT.cliSandbox}`],
        ...(state.message !== "" && { engineText: state.message }),
      });
    case "ready":
      return row("ai-cli", title, READY, WORDS.ready, { detail: [...named(state.version), ` ${TEXT.cliReady}`] });
  }
}

function gitRow(input: ChecklistInput): Row {
  const title = TITLES.git;
  const { health, mac } = input;
  if (input.checkFailed || health === undefined) {
    return row("git", title, markOf("warning"), WORDS.couldNotCheck, { detail: [TEXT.gitCouldNot], action: { kind: "check-again", label: TEXT.checkAgain } });
  }
  const version = numberIn(health.git.version);
  if (health.git.ok) return row("git", title, READY, WORDS.ready, { detail: [version === undefined ? "git." : TEXT.gitReady(version)] });
  const missing = health.git.version === undefined;
  const lead = missing ? TEXT.gitNone : `${TEXT.gitFound(version)} ${TEXT.gitNeeds}`;
  const link: Part = { link: { text: TEXT.gitOther, href: LINKS.installGit } };
  return row("git", title, FAILED, missing ? WORDS.notFound : WORDS.tooOld, {
    detail: mac ? [`${lead} ${TEXT.gitRunMac} `, link, "."] : [`${lead} ${TEXT.gitRunLinux} `, link, `. ${TEXT.gitSelfUpdates}`],
    ...(mac && { command: COMMANDS.brewGit }),
  });
}

function repoRow(input: ChecklistInput): Row {
  const [first, ...rest] = input.repos;
  if (first === undefined) return row("repo", TITLES.repo, TODO, WORDS.todo, { detail: [TEXT.repoTodo], action: { kind: "add-repo", label: TEXT.repoAdd } });
  const checks: Part[] =
    first.checks.length === 0
      ? [TEXT.repoNoChecks]
      : [`${TEXT.repoChecks(first.checks.length)}: `, ...first.checks.flatMap((check, index): Part[] => (index === 0 ? [{ code: check }] : [", ", { code: check }]))];
  const detail: Part[] = [{ strong: first.id }, " · ", ...(first.path === undefined ? [] : [{ code: first.path } as const, " · "]), ...checks, ...(rest.length === 0 ? [] : [` · ${TEXT.repoMore(rest.length)}`])];
  return row("repo", TITLES.repo, READY, WORDS.added, { detail });
}

function quickFixRow(input: ChecklistInput, ready: boolean): Row {
  const title = TITLES.quickFix;
  if (input.started) {
    const first = input.firstItem;
    const detail: Part[] = first === undefined ? [TEXT.quickFirstRun] : [{ quote: first.text }, ...(first.repoId === undefined ? [] : [` on ${first.repoId}`]), ` ${TEXT.quickFirstRunAfter}`];
    return row("quick-fix", title, READY, WORDS.done, { detail });
  }
  const repo = input.repos[0];
  if (!ready || repo === undefined) {
    return row("quick-fix", title, TODO, WORDS.todo, { detail: [TEXT.quickLocked], action: { kind: "start", label: TEXT.quickStart, locked: true } });
  }
  const quickFix = input.templates.find((template) => template.id === QUICK_FIX_ID);
  const blocked = noChecks(quickFix, input.repos, [repo.id], input.templates);
  if (blocked !== undefined) {
    const change = blocked.instead;
    const addCheck: Part = { act: { text: TEXT.quickAddCheck, id: "edit-repo" } };
    return row("quick-fix", title, TODO, WORDS.todo, {
      detail: [`${TEXT.quickNoChecksBefore} ${repo.id} ${TEXT.quickNoChecksAfter} `, addCheck, ` ${TEXT.quickNoChecksEnd}`],
      ...(change !== undefined && { action: { kind: "start", label: TEXT.quickChange, locked: false, prefill: { templateId: QUICK_CHANGE_ID, repoId: repo.id, text: SAMPLE_TASK } } }),
    });
  }
  return row("quick-fix", title, TODO, WORDS.todo, {
    detail: [`${TEXT.quickReady} `, { quote: SAMPLE_TASK }, `. ${TEXT.quickReadyAfter}`],
    action: { kind: "start", label: TEXT.quickStart, locked: false, prefill: { ...(quickFix !== undefined && { templateId: QUICK_FIX_ID }), repoId: repo.id, text: SAMPLE_TASK } },
  });
}

export function checklist(input: ChecklistInput): Checklist {
  const first = [aiCliRow(input), gitRow(input), repoRow(input)];
  const rows = [...first, quickFixRow(input, first.every((entry) => entry.done))];
  const doneCount = rows.filter((entry) => entry.done).length;
  return { rows, doneCount, next: rows.find((entry) => !entry.done)?.id, subtitle: doneCount === rows.length ? TEXT.allDone : TEXT.intro };
}
