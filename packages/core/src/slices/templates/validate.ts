// Turns the text of one template file into a TemplateRecord, or into a list of problems in plain
// words, each with the line it is on. Problems with the file's shape (unknown fields, wrong words)
// come first, all at once; the rules that need the whole template run once the shape is right.
// Every value from the file goes into a message through `quote` or `clean`.
import { isMap, LineCounter, parseDocument, type Document, type Node } from "yaml";
import type { z } from "zod";
import { posixSh, type SyntaxRefusalReason } from "../../kernel/command-policy/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  connectionDerivedSteps,
  ConnectionAccessSchema,
  RESERVED_STEP_IDS,
  TEMPLATE_REFERENCE,
  TEMPLATE_SCHEMA_VERSION,
  TemplateRecordSchema,
  type AgentId,
  type ConnectionId,
  type RepoId,
  type StepId,
  type TemplateId,
  type TemplateRecord,
  type TemplateRef,
  type TemplateStepDef,
} from "../../kernel/schemas/index.js";
import { DURATION, FIELD_WORDS, knownFields, TEMPLATE_FORMAT, TemplateFileSchema, type StepFile, type TemplateFile } from "./format.js";
import { clean, quote } from "./quote.js";
import { didYouMean } from "./suggest.js";

export interface TemplateProblem {
  /** 1-based; 1 for problems with the file as a whole. */
  readonly line: number;
  readonly message: string;
}

/** What the validator needs to know about an agent: whether its model runs in the cloud. */
export interface AgentLocation {
  readonly cloud: boolean;
}

export interface ValidateContext {
  readonly ref: TemplateRef;
  readonly source: TemplateRecord["source"];
  /** Every agent set up on this machine, by id. */
  readonly agents: ReadonlyMap<string, AgentLocation>;
  /**
   * Reads an instruction file named by the template, relative to the template file. The error is
   * a plain-word reason. Absent for built-ins, which keep their instructions inline.
   */
  readonly readInstructions?: (file: string) => Promise<Result<string, string>>;
  /** Told each warning of a template that loads: something it says that has no effect. */
  readonly onWarning?: (warning: TemplateProblem) => void;
}

type Path = readonly PropertyKey[];
type Report = (path: Path, message: string) => void;

/** A one-line value ending in `.md` (any case) with no spaces names a file; anything else is the text itself. */
export const isInstructionFile = (value: string): boolean => /^\S+\.md$/i.test(value);
const INSTRUCTION_FILE_CHARS = /^[A-Za-z0-9._/-]+$/;
const MAX_INSTRUCTION_FILE_CHARS = 200;
/** `{{ build.diff }}`: a reference to an earlier step's result, by step id. */
const STEP_REFERENCE = /\{\{\s*([a-z0-9][a-z0-9-]*)\.[^}]*\}\}/g;
const DEFAULT_RETRY_ATTEMPTS = 3;

export async function validateTemplate(text: string, ctx: ValidateContext): Promise<Result<TemplateRecord, TemplateProblem[]>> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const lineAt = (offset: number) => lines.linePos(offset).line;

  if (doc.errors.length > 0) return err(doc.errors.map((error) => yamlProblem(error.code, error.message, error.pos[0], text, lineAt)));
  if (!isMap(doc.contents)) {
    return err([{ line: 1, message: "A template is a set of fields such as name:, steps: and finish:; this file has none." }]);
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return err([{ line: 1, message: `The file cannot be read as a template: ${clean((error as Error).message)}.` }]);
  }

  const lineOf = (path: Path, key?: string) => findLine(doc, path, key, lineAt);
  // A newer file would also show a pile of unknown-field problems; the one that matters is its version.
  const format = (data as { format?: unknown } | null)?.format;
  if (typeof format === "number" && Number.isSafeInteger(format) && format > TEMPLATE_FORMAT) {
    return err([{ line: lineOf(["format"]), message: `This template needs a newer Tokama (format ${format}). Update Tokama to use it.` }]);
  }
  const parsed = TemplateFileSchema.safeParse(data);
  if (!parsed.success) {
    // A value of the wrong kind also fails the size checks of the right kind; report only the kind.
    const wrongKind = new Set(parsed.error.issues.filter((issue) => issue.code === "invalid_type").map((issue) => issue.path.join(".")));
    const issues = parsed.error.issues.filter((issue) => issue.code === "invalid_type" || !wrongKind.has(issue.path.join(".")));
    return err(issues.flatMap((issue) => issueProblems(issue, [], data, lineOf)));
  }

  const problems: TemplateProblem[] = [];
  const report: Report = (path, message) => problems.push({ line: lineOf(path), message });
  const warnings: TemplateProblem[] = [];
  const warn: Report = (path, message) => warnings.push({ line: lineOf(path), message });
  const record = await buildRecord(parsed.data, ctx, report, warn);
  problems.sort((a, b) => a.line - b.line);
  if (problems.length > 0) return err(problems);
  // The file schema's limits match the record's, so this only fails on a bug here; it keeps a
  // record that items could not store from ever being returned.
  const checked = TemplateRecordSchema.safeParse(record);
  if (!checked.success) return err([{ line: 1, message: `The template cannot be stored: ${clean(checked.error.issues[0]?.message ?? "invalid")}.` }]);
  warnings.sort((a, b) => a.line - b.line);
  for (const warning of warnings) ctx.onWarning?.(warning);
  return ok(record);
}

// ---- YAML and shape problems

function yamlProblem(code: string, message: string, offset: number, text: string, lineAt: (offset: number) => number): TemplateProblem {
  const line = lineAt(offset);
  const source = text.split("\n")[line - 1] ?? "";
  const inlineBack = /^\s*(?:-\s+)?([a-z_]+):\s*back:\s*(\S+)/.exec(source);
  if (code === "BLOCK_AS_IMPLICIT_KEY" && inlineBack) {
    const [, field = "", target = ""] = inlineBack;
    const map = quote(`${field}: { back: ${target} }`);
    return { line, message: `Write ${map}, or put ${quote(`back: ${target}`)} on its own line under ${quote(`${field}:`)}.` };
  }
  if (code === "DUPLICATE_KEY") return { line, message: "This field appears twice; keep one." };
  if (code === "MULTIPLE_DOCS") return { line, message: "A template file holds one template; remove the second document (after ---)." };
  const first = (message.split("\n")[0] ?? message).replace(/ at line \d+, column \d+:?$/, "");
  return { line, message: `The file is not valid YAML: ${clean(first)}.` };
}

// zod issue shapes, reduced to the fields used here.
type Issue = z.core.$ZodIssue;

function issueProblems(issue: Issue, prefix: Path, data: unknown, lineOf: (path: Path, key?: string) => number): TemplateProblem[] {
  const path = [...prefix, ...issue.path];
  const value = valueAt(data, path);
  const subject = subjectOf(path, data);
  const field = fieldOf(path);
  const name = quote(field);

  if (value === undefined && (issue.code === "invalid_type" || issue.code === "invalid_value")) {
    if (path.length === 1 && field === "format") return [{ line: 1, message: '"format" is missing: add format: 1 at the top of the file.' }];
    return [{ line: lineOf(path.slice(0, -1)), message: prefixed(subject, `${name} is missing.`) }];
  }

  switch (issue.code) {
    case "unrecognized_keys": {
      const known = knownFields(path);
      return issue.keys.map((key) => ({
        line: lineOf(path, key),
        message: `${capitalize(ownerOf(path, subject))} has an unknown field ${quote(key)}.${didYouMean(key, known)}`,
      }));
    }
    case "invalid_union": {
      // When the value is of the kind one branch takes (a map for back:), report that branch's
      // own problems; otherwise list the forms the field takes.
      const fits = issue.errors.find(
        (errors) => !errors.some((e) => e.path.length === 0 && (e.code === "invalid_type" || e.code === "invalid_value")),
      );
      if (fits) return fits.flatMap((inner) => issueProblems(inner, path, data, lineOf));
      return [{ line: lineOf(path), message: prefixed(subject, `${name} ${wordsMessage(field, value)}`) }];
    }
    case "invalid_value": {
      // Here the field is a connection id, which must not pick up the word list of a field of the same name.
      if (path.at(-2) === "connections") {
        return [{ line: lineOf(path), message: prefixed(subject, `connection ${name} ${wordsMessage("", value, ConnectionAccessSchema.options)}`) }];
      }
      if (field === "finish" && value === "update-tickets") {
        return [{ line: lineOf(path), message: `${name} no longer takes update-tickets; it is now called outside-changes.` }];
      }
      return [{ line: lineOf(path), message: prefixed(subject, `${name} ${wordsMessage(field, value, issue.values.map(String))}`) }];
    }
    case "invalid_type":
      return [{ line: lineOf(path), message: prefixed(subject, `${name} must be ${kindName(issue.expected)}.`) }];
    case "invalid_key": {
      const reason = issue.issues[0]?.message ?? "is not valid";
      return [{ line: lineOf(path), message: prefixed(subject, `${name} is not a valid id: it ${reason}.`) }];
    }
    case "too_small":
    case "too_big":
      return [{ line: lineOf(path), message: prefixed(subject, `${name} ${sizeMessage(issue)}.`) }];
    case "invalid_format":
    case "custom":
      return [{ line: lineOf(path), message: prefixed(subject, `${name} ${issue.message}.`) }];
    default:
      return [{ line: lineOf(path), message: prefixed(subject, `${name} is not valid.`) }];
  }
}

function wordsMessage(field: string, value: unknown, values?: readonly string[]): string {
  const words = FIELD_WORDS[field] ?? values ?? [];
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? "");
  // Only real words are suggested, not placeholders such as "back: <step id>".
  const hint = typeof value === "string" ? didYouMean(value, words.filter((word) => !/[<\s]/.test(word))) : "";
  return `must be ${list}.${hint}`;
}

function sizeMessage(issue: Extract<Issue, { code: "too_small" | "too_big" }>): string {
  const small = issue.code === "too_small";
  const limit = Number(small ? (issue as { minimum: number | bigint }).minimum : (issue as { maximum: number | bigint }).maximum);
  if (issue.origin === "array") return small ? `needs at least ${limit} ${limit === 1 ? "entry" : "entries"}` : `has more than ${limit} entries`;
  if (issue.origin === "string") return small ? "must not be empty" : `is longer than ${limit} characters`;
  return small ? `must be at least ${limit}` : `must be at most ${limit}`;
}

function kindName(expected: string): string {
  const names: Record<string, string> = {
    string: "text",
    array: "a list, such as [a, b]",
    object: "a set of fields",
    record: "a set of fields",
    int: "a whole number",
    // Every number in the format is a whole number (max_attempts).
    number: "a whole number",
    boolean: "true or false",
  };
  return names[expected] ?? "of another kind";
}

const REFUSAL_WORDS: Record<SyntaxRefusalReason, string> = {
  substitution: "command substitution ($(...) or backticks)",
  "ansi-c-quote": "$'...' quoting",
  redirect: "a redirect (>, <)",
  background: "a background &",
  subshell: "a subshell ( ... )",
  newline: "a line break",
  "unbalanced-quote": "an unclosed quote",
};

/** Why a check or setup command is not one simple command, parsed as the command policy parses it. */
function commandProblem(command: string): string | undefined {
  const split = posixSh.split(command);
  if (!split.ok) return `cannot use ${REFUSAL_WORDS[split.error.reason]}`;
  if (split.value.length !== 1) return "must be one command, with no &&, ||, ; or |";
  if (split.value[0]!.words.length === 0) return "has no command words";
  return undefined;
}

// ---- Rules that need the whole file and the agents

async function buildRecord(file: TemplateFile, ctx: ValidateContext, report: Report, warn: Report): Promise<TemplateRecord> {
  const stepIds = file.steps.map((step) => step.id);
  const indexOf = new Map<string, number>();
  file.steps.forEach((step, i) => {
    if (RESERVED_STEP_IDS.includes(step.id)) report(["steps", i, "id"], `${quote(step.id)} is a reserved name; pick another step id.`);
    if (indexOf.has(step.id)) report(["steps", i, "id"], `Two steps have the id ${quote(step.id)}; step ids must be different.`);
    else indexOf.set(step.id, i);
  });

  const needs = file.start?.needs ?? ["text"];
  const picksRepos = needs.includes("repo") || needs.includes("repos");
  if (needs.includes("repo") && needs.includes("repos")) report(["start", "needs"], `"needs" has both repo and repos; use repo for exactly one, repos for one or more.`);
  if (new Set(needs).size !== needs.length) report(["start", "needs"], `"needs" lists the same thing twice.`);
  const repos = file.uses?.repos;
  if (typeof repos === "string" && !picksRepos) {
    report(["uses", "repos"], `"repos: ${repos}" gives access to the repos picked at Start, but start.needs asks for no repo. Add repo to start.needs, or name the repos.`);
  }
  const picked = picksRepos ? (typeof repos === "string" ? repos : "read") : undefined;
  const named = typeof repos === "object" ? Object.entries(repos).map(([repoId, access]) => ({ repoId: repoId as RepoId, access })) : [];
  if (new Set(file.finish).size !== file.finish.length) report(["finish"], `"finish" lists the same thing twice.`);
  const changesRepo = file.finish.filter((finish) => finish === "commit" || finish === "pull-request");
  if (changesRepo.length > 0 && picked !== "edit" && !named.some((repo) => repo.access === "edit")) {
    report(["finish"], `"finish: ${changesRepo.join(", ")}" needs a repo with edit access, but uses.repos gives none.`);
  }

  if (file.setup !== undefined) {
    const problem = commandProblem(file.setup);
    if (problem) report(["setup"], `The setup command ${problem}.`);
  }

  let budget: TemplateRecord["budget"];
  if (file.budget) {
    const [, hours, minutes] = DURATION.exec(file.budget.time) ?? [];
    const total = Number(hours ?? 0) * 60 + Number(minutes ?? 0);
    if (total < 1 || total > 1440) report(["budget", "time"], `"time" must be between 1m and 24h, for example 90m or 2h.`);
    budget = { timeMinutes: total };
  }

  const backTargets = new Set(
    file.steps.flatMap((step) => [step.if_failed, step.if_changes_requested].flatMap((rule) => (typeof rule === "object" ? [rule.back] : []))),
  );
  const scope: StepScope = {
    file,
    ctx,
    stepIds,
    indexOf,
    backTargets,
    templateConnections: new Map(Object.entries(file.uses?.connections ?? {})),
    templateCommands: file.uses?.commands ?? [],
    report,
    warn,
  };
  const steps: TemplateStepDef[] = [];
  for (const [i, step] of file.steps.entries()) steps.push(await buildStep(step, i, scope));
  checkCloudData(file, steps, scope);
  checkReferences(steps, scope);

  const record: TemplateRecord = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    ref: ctx.ref,
    id: ctx.ref.split("/")[1] as TemplateId,
    source: ctx.source,
    name: file.name,
    uses: {
      repos: { ...(picked ? { picked } : {}), named },
      connections: [...scope.templateConnections].map(([connectionId, access]) => ({ connectionId: connectionId as ConnectionId, access })),
      commands: [...scope.templateCommands],
    },
    start: { needs, askBeforeCloud: file.start?.ask_before_cloud ?? false, notify: file.start?.notify ?? false },
    steps,
    finish: file.finish,
  };
  if (file.icon !== undefined) record.icon = file.icon;
  if (file.color !== undefined) record.color = file.color;
  if (file.setup !== undefined) record.setup = file.setup;
  if (budget !== undefined) record.budget = budget;
  return record;
}

interface StepScope {
  readonly file: TemplateFile;
  readonly ctx: ValidateContext;
  readonly stepIds: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly backTargets: ReadonlySet<string>;
  readonly templateConnections: ReadonlyMap<string, string>;
  readonly templateCommands: readonly string[];
  readonly report: Report;
  readonly warn: Report;
}

const isCloud = (scope: StepScope, step: StepFile) => scope.ctx.agents.get(step.agent)?.cloud ?? false;
/** A cloud step that sends the repo and diff: what it sees leaves the machine with no one reading it first. */
const sendsRepo = (scope: StepScope, step: StepFile) => isCloud(scope, step) && step.data === "repo-and-diff";

async function buildStep(step: StepFile, i: number, scope: StepScope): Promise<TemplateStepDef> {
  const { ctx, stepIds, indexOf, templateConnections, templateCommands, report } = scope;
  const at = (...rest: PropertyKey[]): Path => ["steps", i, ...rest];
  const name = `Step ${quote(step.id)}`;

  const agent = ctx.agents.get(step.agent);
  if (agent === undefined) {
    const known = [...ctx.agents.keys()];
    const list = known.length > 0 && known.length <= 8 ? ` Agents set up: ${known.map(clean).join(", ")}.` : "";
    report(at("agent"), `${name} uses agent ${quote(step.agent)}, which is not set up.${didYouMean(step.agent, known) || list}`);
  }
  const cloud = isCloud(scope, step);

  // A back target must be a step of this template, and this step or an earlier one: a loop
  // only ever goes back, and the engine caps how often a step sends the work back.
  const checkBack = (field: string, target: string) => {
    const index = indexOf.get(target);
    const goes = `${name}: "${field}" goes back to ${quote(target)}`;
    if (index === undefined) report(at(field, "back"), `${goes}, which is not a step in this template.${didYouMean(target, stepIds)}`);
    else if (index > i) report(at(field, "back"), `${goes}, which comes later; back can only go to this step or an earlier one.`);
  };
  if (typeof step.if_failed === "object") checkBack("if_failed", step.if_failed.back);
  if (typeof step.if_changes_requested === "object") checkBack("if_changes_requested", step.if_changes_requested.back);

  const doneWhen = step.done_when ?? "agent finishes";
  if (step.if_changes_requested !== undefined && doneWhen !== "reviewer approves") {
    report(at("if_changes_requested"), `${name}: "if_changes_requested" applies only with done_when: reviewer approves.`);
  }
  if (doneWhen === "reviewer approves") checkReviewer(step, i, scope, name);
  if (doneWhen === "reviewer approves" && step.if_failed !== undefined) {
    scope.warn(at("if_failed"), `${name}: "if_failed" has no effect on a reviewer step; use "if_changes_requested".`);
  }

  const checks = buildChecks(step, doneWhen, name, at, report);

  if (cloud && step.data === undefined) {
    report(at("agent"), `${name} runs on ${quote(step.agent)}, a cloud agent, so it must say what may leave this machine: add data: summary-after-approval or data: repo-and-diff.`);
  } else if (cloud && step.data === "none") {
    report(at("data"), `${name} has data: none, but ${quote(step.agent)} is a cloud agent and would get nothing. Use summary-after-approval or repo-and-diff, or a local agent.`);
  }

  const stepConnections = Object.entries(step.uses?.connections ?? {});
  if (cloud && stepConnections.length > 0) {
    report(at("uses", "connections"), `${name} runs on ${quote(step.agent)}, a cloud agent, and cloud steps cannot use connections. Remove them or use a local agent.`);
  }
  for (const [connectionId] of stepConnections) {
    if (!templateConnections.has(connectionId)) {
      report(
        at("uses", "connections", connectionId),
        `${name} uses connection ${quote(connectionId)}, which the template does not list in uses.connections.${didYouMean(connectionId, templateConnections.keys())}`,
      );
    }
  }
  for (const [j, command] of (step.uses?.commands ?? []).entries()) {
    if (!templateCommands.includes(command)) {
      report(at("uses", "commands", j), `${name} uses command ${quote(command)}, which the template does not list in uses.commands.${didYouMean(command, templateCommands)}`);
    }
  }

  for (const [j, seen] of (step.sees ?? []).entries()) {
    const index = indexOf.get(seen);
    if (index === undefined) report(at("sees", j), `${name} sees ${quote(seen)}, which is not a step in this template.${didYouMean(seen, stepIds)}`);
    else if (index >= i) report(at("sees", j), `${name} sees ${quote(seen)}, but a step can only see the results of earlier steps.`);
  }

  const ifFailed: TemplateStepDef["ifFailed"] =
    typeof step.if_failed === "object" ? { action: "back", stepId: step.if_failed.back } : { action: step.if_failed ?? "ask" };
  // A step that is retried, sent back to, or that you approve (Request changes runs it again) must
  // be able to run more than once.
  const loops = ifFailed.action === "retry" || scope.backTargets.has(step.id) || doneWhen === "you approve";
  const def: TemplateStepDef = {
    id: step.id,
    name: step.name,
    agentId: step.agent as AgentId,
    instructions: await instructions(step.instructions, name, at("instructions"), ctx, report),
    doneWhen,
    ifFailed,
    maxAttempts: step.max_attempts ?? (loops ? DEFAULT_RETRY_ATTEMPTS : 1),
    data: step.data ?? "none",
    // Cloud steps see only what they declare; local steps see every earlier step by default.
    sees: step.sees ?? (cloud ? [] : (stepIds.slice(0, i) as StepId[])),
    connections: stepConnections.map(([connectionId, access]) => ({ connectionId: connectionId as ConnectionId, access })),
    // A step that sends the repo out gets only the commands it lists itself.
    commands: step.uses?.commands ?? (sendsRepo(scope, step) ? [] : [...templateCommands]),
  };
  if (checks !== undefined) def.checks = checks;
  if (doneWhen === "reviewer approves") {
    def.ifChangesRequested =
      typeof step.if_changes_requested === "object" ? { action: "back", stepId: step.if_changes_requested.back } : { action: "ask" };
  }
  if (step.icon !== undefined) def.icon = step.icon;
  if (step.color !== undefined) def.color = step.color;
  return def;
}

/**
 * A reviewer must be independent of the work it reviews: its agent may run none of the steps in
 * its range. The range starts at the `if_changes_requested` back target, or else after the
 * previous reviewer (or at the first step), and ends just before the reviewer.
 */
function checkReviewer(step: StepFile, i: number, scope: StepScope, name: string): void {
  const { file, indexOf, report } = scope;
  const target = typeof step.if_changes_requested === "object" ? indexOf.get(step.if_changes_requested.back) : undefined;
  let start = 0;
  if (target !== undefined && target < i) start = target;
  else {
    for (let j = i - 1; j >= 0; j--) {
      if ((file.steps[j]!.done_when ?? "agent finishes") === "reviewer approves") {
        start = j + 1;
        break;
      }
    }
  }
  const range = file.steps.slice(start, i);
  if (range.length === 0) {
    report(["steps", i, "done_when"], `${name} waits for a reviewer, but there is no earlier step for it to review.`);
    return;
  }
  const own = range.find((reviewed) => reviewed.agent === step.agent);
  if (own) report(["steps", i, "agent"], `${name} reviews step ${quote(own.id)}, so it needs a different agent; both use ${quote(step.agent)}.`);
}

function buildChecks(step: StepFile, doneWhen: string, name: string, at: (...rest: PropertyKey[]) => Path, report: Report): TemplateStepDef["checks"] {
  const listed = step.checks === "from-repo" || (step.checks !== undefined && step.checks.length > 0);
  if (doneWhen !== "checks pass") {
    if (listed) report(at("checks"), `${name} lists checks, but checks run only with done_when: checks pass.`);
    return undefined;
  }
  if (step.checks === "from-repo") return { from: "repo" };
  if (step.checks === undefined || step.checks.length === 0) {
    report(at("done_when"), `${name} waits for checks to pass but lists none: add checks: from-repo or a list of commands.`);
    return undefined;
  }
  for (const [j, command] of step.checks.entries()) {
    const problem = commandProblem(command);
    if (problem) report(at("checks", j), `${name}: the check ${quote(command)} ${problem}.`);
  }
  return { commands: step.checks };
}

/**
 * A cloud step with data: repo-and-diff sends what it sees with no one reading it first, so it
 * may not see results that came from connections (directly or through other steps), and every
 * `{{ step.x }}` its instructions use must be in its `sees`. Summary steps are exempt: the
 * engineer reads the summary before it is sent.
 */
function checkCloudData(file: TemplateFile, steps: readonly TemplateStepDef[], scope: StepScope): void {
  const fromConnections = connectionDerivedSteps(steps);
  for (const [i, step] of steps.entries()) {
    if (!sendsRepo(scope, file.steps[i]!)) continue;
    const name = `Step ${quote(step.id)}`;
    for (const [j, seen] of step.sees.entries()) {
      if (fromConnections.has(seen)) {
        scope.report(
          ["steps", i, "sees", j],
          `${name} sends the repo to a cloud agent with no summary to approve, so it cannot see ${quote(seen)}, which has results from connections. Use data: summary-after-approval.`,
        );
      }
    }
    const referenced = new Set([...step.instructions.text.matchAll(STEP_REFERENCE)].map((match) => match[1]!));
    for (const id of referenced) {
      if (scope.indexOf.has(id) && !step.sees.includes(id as StepId)) {
        scope.report(["steps", i, "instructions"], `${name} uses {{ ${clean(id)}... }} in its instructions, but does not list ${quote(id)} in sees.`);
      }
    }
  }
}

/**
 * Every `{{ root.field }}` in a step's instructions must start with the id of a step of this
 * template. A reference with no `root.` shape is left to the prompt builder's own warning. A
 * reserved root such as `inputs` is allowed here once the feature behind it exists.
 */
function checkReferences(steps: readonly TemplateStepDef[], scope: StepScope): void {
  for (const [i, step] of steps.entries()) {
    const roots = new Set<string>();
    for (const match of step.instructions.text.matchAll(TEMPLATE_REFERENCE)) {
      const root = /^\s*([^\s.{}]+)\./.exec(match[1]!)?.[1];
      if (root !== undefined && !scope.indexOf.has(root)) roots.add(root);
    }
    for (const root of roots) {
      scope.report(
        ["steps", i, "instructions"],
        `Step ${quote(step.id)} uses {{ ${clean(root)}... }} in its instructions, but ${quote(root)} is not a step in this template. Only {{ <step id>.<field> }} references are allowed.${didYouMean(root, scope.stepIds)}`,
      );
    }
  }
}

async function instructions(value: string, name: string, path: Path, ctx: ValidateContext, report: Report): Promise<TemplateStepDef["instructions"]> {
  if (!isInstructionFile(value)) {
    if (/^\S+$/.test(value) && (value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value))) {
      report(path, `${name}: ${quote(value)} looks like a file name, but instruction files must end in .md. Inline instructions are a sentence.`);
    }
    return { text: value };
  }
  const file = { file: value, text: value };
  if (!INSTRUCTION_FILE_CHARS.test(value)) {
    report(path, `${name}: the instructions file name ${quote(value)} may use only letters, digits, ".", "_", "/" and "-".`);
    return file;
  }
  if (value.length > MAX_INSTRUCTION_FILE_CHARS) {
    report(path, `${name}: the instructions file name ${quote(value)} is longer than ${MAX_INSTRUCTION_FILE_CHARS} characters.`);
    return file;
  }
  if (value.startsWith("/") || value.split("/").includes("..")) {
    report(path, `${name}: the instructions file ${quote(value)} must be a path inside the templates folder, without "..".`);
    return file;
  }
  if (ctx.readInstructions === undefined) {
    report(path, `${name}: built-in templates keep their instructions inline, not in ${quote(value)}.`);
    return file;
  }
  const read = await ctx.readInstructions(value);
  if (!read.ok) {
    report(path, `${name}: the instructions file ${quote(value)} ${read.error}.`);
    return file;
  }
  if (read.value.trim() === "") report(path, `${name}: the instructions file ${quote(value)} is empty.`);
  return { file: value, text: read.value };
}

// ---- Paths and lines

function findLine(doc: Document, path: Path, key: string | undefined, lineAt: (offset: number) => number): number {
  for (let length = path.length; length >= 0; length--) {
    const node = (length === 0 ? doc.contents : doc.getIn(path.slice(0, length), true)) as Node | null | undefined;
    if (node?.range == null) continue;
    if (key !== undefined && length === path.length && isMap(node)) {
      const pair = node.items.find((item) => (item.key as { value?: unknown } | null)?.value === key);
      const keyNode = pair?.key as Node | undefined;
      if (keyNode?.range) return lineAt(keyNode.range[0]);
    }
    // A missing field is reported on its parent's line; for a map that is its first field.
    return lineAt(node.range[0]);
  }
  return 1;
}

function valueAt(data: unknown, path: Path): unknown {
  let current = data;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** `step "fix"` for a path inside a step, else undefined. */
function subjectOf(path: Path, data: unknown): string | undefined {
  if (path[0] !== "steps" || typeof path[1] !== "number") return undefined;
  const id = valueAt(data, ["steps", path[1], "id"]);
  return typeof id === "string" && id !== "" ? `step ${quote(id)}` : `step ${path[1] + 1}`;
}

/** The field a problem is about: the last name in the path; for a list entry, the list's name. */
function fieldOf(path: Path): string {
  const last = path.at(-1);
  if (typeof last === "number") return String(path.at(-2) ?? "");
  return last === undefined ? "template" : String(last);
}

/** Whose field an unknown field is: the template, a step, or a named field such as "uses". */
function ownerOf(path: Path, subject: string | undefined): string {
  if (path.length === 0) return "the template";
  if (subject === undefined) return quote(fieldOf(path));
  return path.length === 2 ? subject : `${subject}: ${quote(fieldOf(path))}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const prefixed = (subject: string | undefined, message: string) => (subject ? `${capitalize(subject)}: ${message}` : capitalize(message));
