// Turns the text of one template file into a TemplateRecord, or into a list of problems in plain
// words, each with the line it is on. Problems with the file's shape (unknown fields, wrong words)
// come first, all at once; the rules that need the whole template run once the shape is right.
import { isMap, LineCounter, parseDocument, type Document, type Node } from "yaml";
import type { z } from "zod";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  TemplateRecordSchema,
  type AgentId,
  type ConnectionId,
  type DataRule,
  type RepoId,
  type StepId,
  type TemplateId,
  type TemplateRecord,
  type TemplateRef,
  type TemplateStepDef,
} from "../../kernel/schemas/index.js";
import { DURATION, FIELD_WORDS, knownFields, TemplateFileSchema, type StepFile, type TemplateFile } from "./format.js";
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
}

type Path = readonly PropertyKey[];

/** A one-line value ending in `.md` with no spaces names a file; anything else is the text itself. */
export const isInstructionFile = (value: string): boolean => /^\S+\.md$/.test(value);

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
    return err([{ line: 1, message: `The file cannot be read as a template: ${(error as Error).message}.` }]);
  }

  const lineOf = (path: Path, key?: string) => findLine(doc, path, key, lineAt);
  const parsed = TemplateFileSchema.safeParse(data);
  if (!parsed.success) {
    // A value of the wrong kind also fails the size checks of the right kind; report only the kind.
    const wrongKind = new Set(parsed.error.issues.filter((issue) => issue.code === "invalid_type").map((issue) => issue.path.join(".")));
    const issues = parsed.error.issues.filter((issue) => issue.code === "invalid_type" || !wrongKind.has(issue.path.join(".")));
    return err(issues.flatMap((issue) => issueProblems(issue, [], data, lineOf)));
  }

  const problems: TemplateProblem[] = [];
  const report = (path: Path, message: string) => problems.push({ line: lineOf(path), message });
  const record = await buildRecord(parsed.data, ctx, report);
  problems.sort((a, b) => a.line - b.line);
  if (problems.length > 0) return err(problems);
  // The file schema's limits match the record's, so this only fails on a bug here; it keeps a
  // record that items could not store from ever being returned.
  const checked = TemplateRecordSchema.safeParse(record);
  if (!checked.success) return err([{ line: 1, message: `The template cannot be stored: ${checked.error.issues[0]?.message ?? "invalid"}.` }]);
  return ok(record);
}

// ---- YAML and shape problems

function yamlProblem(code: string, message: string, offset: number, text: string, lineAt: (offset: number) => number): TemplateProblem {
  const line = lineAt(offset);
  const source = text.split("\n")[line - 1] ?? "";
  const inlineBack = /^\s*(?:-\s+)?([a-z_]+):\s*back:\s*(\S+)/.exec(source);
  if (code === "BLOCK_AS_IMPLICIT_KEY" && inlineBack) {
    const [, field, target] = inlineBack;
    return { line, message: `Write "${field}: { back: ${target} }", or put "back: ${target}" on its own line under "${field}:".` };
  }
  if (code === "DUPLICATE_KEY") return { line, message: "This field appears twice; keep one." };
  if (code === "MULTIPLE_DOCS") return { line, message: "A template file holds one template; remove the second document (after ---)." };
  const first = (message.split("\n")[0] ?? message).replace(/ at line \d+, column \d+:?$/, "");
  return { line, message: `The file is not valid YAML: ${first}.` };
}

// zod issue shapes, reduced to the fields used here.
type Issue = z.core.$ZodIssue;

function issueProblems(issue: Issue, prefix: Path, data: unknown, lineOf: (path: Path, key?: string) => number): TemplateProblem[] {
  const path = [...prefix, ...issue.path];
  const value = valueAt(data, path);
  const subject = subjectOf(path, data);
  const field = fieldOf(path);

  if (value === undefined && (issue.code === "invalid_type" || issue.code === "invalid_value")) {
    if (path.length === 1 && field === "format") return [{ line: 1, message: '"format" is missing: add format: 1 at the top of the file.' }];
    return [{ line: lineOf(path.slice(0, -1)), message: prefixed(subject, `"${field}" is missing.`) }];
  }

  switch (issue.code) {
    case "unrecognized_keys": {
      const known = knownFields(path);
      return issue.keys.map((key) => ({
        line: lineOf(path, key),
        message: `${capitalize(ownerOf(path, subject))} has an unknown field "${key}".${didYouMean(key, known)}`,
      }));
    }
    case "invalid_union": {
      // When the value is of the kind one branch takes (a map for back:), report that branch's
      // own problems; otherwise list the forms the field takes.
      const fits = issue.errors.find(
        (errors) => !errors.some((e) => e.path.length === 0 && (e.code === "invalid_type" || e.code === "invalid_value")),
      );
      if (fits) return fits.flatMap((inner) => issueProblems(inner, path, data, lineOf));
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" ${wordsMessage(field, value)}`) }];
    }
    case "invalid_value":
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" ${wordsMessage(field, value, issue.values.map(String))}`) }];
    case "invalid_type":
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" must be ${kindName(issue.expected)}.`) }];
    case "invalid_key": {
      const reason = issue.issues[0]?.message ?? "is not valid";
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" is not a valid id: it ${reason}.`) }];
    }
    case "too_small":
    case "too_big":
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" ${sizeMessage(issue)}.`) }];
    case "invalid_format":
    case "custom":
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" ${issue.message}.`) }];
    default:
      return [{ line: lineOf(path), message: prefixed(subject, `"${field}" is not valid.`) }];
  }
}

function wordsMessage(field: string, value: unknown, values?: readonly string[]): string {
  const words = FIELD_WORDS[field] ?? values ?? [];
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? "");
  const hint = typeof value === "string" ? didYouMean(value, words.filter((word) => !word.includes("<"))) : "";
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
  return names[expected] ?? expected;
}

// ---- Rules that need the whole file and the agents

async function buildRecord(file: TemplateFile, ctx: ValidateContext, report: (path: Path, message: string) => void): Promise<TemplateRecord> {
  const stepIds = file.steps.map((step) => step.id);
  const indexOf = new Map<string, number>();
  file.steps.forEach((step, i) => {
    if (indexOf.has(step.id)) report(["steps", i, "id"], `Two steps have the id "${step.id}"; step ids must be different.`);
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
  if (new Set(file.finish).size !== file.finish.length) report(["finish"], `"finish" lists the same thing twice.`);

  let budget: TemplateRecord["budget"];
  if (file.budget) {
    const [, hours, minutes] = DURATION.exec(file.budget.time) ?? [];
    const total = Number(hours ?? 0) * 60 + Number(minutes ?? 0);
    if (total < 1 || total > 1440) report(["budget", "time"], `"time" must be between 1m and 24h, for example 90m or 2h.`);
    budget = { timeMinutes: total };
  }

  const templateConnections = new Map(Object.entries(file.uses?.connections ?? {}));
  const steps: TemplateStepDef[] = [];
  for (const [i, step] of file.steps.entries()) {
    steps.push(await buildStep(step, i, { file, ctx, stepIds, indexOf, templateConnections, report }));
  }

  const record: TemplateRecord = {
    schemaVersion: 1,
    ref: ctx.ref,
    id: ctx.ref.split("/")[1] as TemplateId,
    source: ctx.source,
    name: file.name,
    uses: {
      repos: {
        ...(picksRepos ? { picked: typeof repos === "string" ? repos : "read" } : {}),
        named: typeof repos === "object" ? Object.entries(repos).map(([repoId, access]) => ({ repoId: repoId as RepoId, access })) : [],
      },
      connections: [...templateConnections].map(([connectionId, access]) => ({ connectionId: connectionId as ConnectionId, access })),
      commands: file.uses?.commands ?? [],
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
  readonly templateConnections: ReadonlyMap<string, string>;
  readonly report: (path: Path, message: string) => void;
}

async function buildStep(step: StepFile, i: number, scope: StepScope): Promise<TemplateStepDef> {
  const { file, ctx, stepIds, indexOf, templateConnections, report } = scope;
  const at = (...rest: PropertyKey[]): Path => ["steps", i, ...rest];
  const name = `Step "${step.id}"`;

  const agent = ctx.agents.get(step.agent);
  if (agent === undefined) {
    const known = [...ctx.agents.keys()];
    const list = known.length > 0 && known.length <= 8 ? ` Agents set up: ${known.join(", ")}.` : "";
    report(at("agent"), `${name} uses agent "${step.agent}", which is not set up.${didYouMean(step.agent, known) || list}`);
  }
  const cloud = agent?.cloud ?? false;

  // A back target must be a step of this template, and this step or an earlier one: a loop
  // only ever goes back, so each pass re-runs steps whose max_attempts bound it.
  const checkBack = (field: string, target: string) => {
    const index = indexOf.get(target);
    if (index === undefined) report(at(field, "back"), `${name}: "${field}" goes back to "${target}", which is not a step in this template.${didYouMean(target, stepIds)}`);
    else if (index > i) report(at(field, "back"), `${name}: "${field}" goes back to "${target}", which comes later; back can only go to this step or an earlier one.`);
  };
  if (typeof step.if_failed === "object") checkBack("if_failed", step.if_failed.back);
  if (typeof step.if_changes_requested === "object") checkBack("if_changes_requested", step.if_changes_requested.back);

  const doneWhen = step.done_when ?? "agent finishes";
  if (step.if_changes_requested !== undefined && doneWhen !== "reviewer approves") {
    report(at("if_changes_requested"), `${name}: "if_changes_requested" applies only with done_when: reviewer approves.`);
  }
  if (step.checks !== undefined && step.checks.length > 0 && doneWhen !== "checks pass") {
    report(at("checks"), `${name} lists checks, but checks run only with done_when: checks pass.`);
  }
  if (doneWhen === "reviewer approves") {
    const target = typeof step.if_changes_requested === "object" ? indexOf.get(step.if_changes_requested.back) : undefined;
    const reviewed = target !== undefined && target < i ? file.steps[target] : file.steps[i - 1];
    if (reviewed === undefined) report(at("done_when"), `${name} waits for a reviewer, but there is no earlier step for it to review.`);
    else if (reviewed.agent === step.agent) {
      report(at("agent"), `${name} reviews step "${reviewed.id}", so it needs a different agent; both use "${step.agent}".`);
    }
  }

  const data: DataRule = step.data ?? "none";
  if (cloud && step.data === undefined) {
    report(at("agent"), `${name} runs on "${step.agent}", a cloud agent, so it must say what may leave this machine: add data: summary-after-approval or data: repo-and-diff.`);
  } else if (cloud && step.data === "none") {
    report(at("data"), `${name} has data: none, but "${step.agent}" is a cloud agent and would get nothing. Use summary-after-approval or repo-and-diff, or a local agent.`);
  }

  const stepConnections = Object.entries(step.uses?.connections ?? {});
  if (cloud && stepConnections.length > 0) {
    report(at("uses", "connections"), `${name} runs on "${step.agent}", a cloud agent, and cloud steps cannot use connections. Remove them or use a local agent.`);
  }
  for (const [connectionId] of stepConnections) {
    if (!templateConnections.has(connectionId)) {
      report(
        at("uses", "connections", connectionId),
        `${name} uses connection "${connectionId}", which the template does not list in uses.connections.${didYouMean(connectionId, templateConnections.keys())}`,
      );
    }
  }

  for (const [j, seen] of (step.sees ?? []).entries()) {
    const index = indexOf.get(seen);
    if (index === undefined) report(at("sees", j), `${name} sees "${seen}", which is not a step in this template.${didYouMean(seen, stepIds)}`);
    else if (index >= i) report(at("sees", j), `${name} sees "${seen}", but a step can only see the results of earlier steps.`);
  }

  const ifFailed: TemplateStepDef["ifFailed"] =
    typeof step.if_failed === "object" ? { action: "back", stepId: step.if_failed.back } : { action: step.if_failed ?? "ask" };
  const def: TemplateStepDef = {
    id: step.id,
    name: step.name,
    agentId: step.agent as AgentId,
    instructions: await instructions(step.instructions, name, at("instructions"), ctx, report),
    doneWhen,
    checks: step.checks ?? [],
    ifFailed,
    maxAttempts: step.max_attempts ?? (ifFailed.action === "retry" ? 3 : 1),
    data,
    // Cloud steps see only what they declare; local steps see every earlier step by default.
    sees: step.sees ?? (cloud ? [] : (stepIds.slice(0, i) as StepId[])),
    connections: stepConnections.map(([connectionId, access]) => ({ connectionId: connectionId as ConnectionId, access })),
  };
  if (step.if_changes_requested !== undefined) {
    def.ifChangesRequested =
      typeof step.if_changes_requested === "object" ? { action: "back", stepId: step.if_changes_requested.back } : { action: "ask" };
  }
  if (step.icon !== undefined) def.icon = step.icon;
  if (step.color !== undefined) def.color = step.color;
  return def;
}

async function instructions(
  value: string,
  name: string,
  path: Path,
  ctx: ValidateContext,
  report: (path: Path, message: string) => void,
): Promise<TemplateStepDef["instructions"]> {
  if (!isInstructionFile(value)) return { text: value };
  if (value.length > 200) {
    report(path, `${name}: the instructions file name "${value.slice(0, 40)}..." is longer than 200 characters.`);
    return { text: value };
  }
  const segments = value.split(/[\\/]/);
  if (value.startsWith("/") || /^[a-zA-Z]:/.test(value) || segments.includes("..")) {
    report(path, `${name}: the instructions file "${value}" must be a path inside the templates folder, without "..".`);
    return { file: value, text: value };
  }
  if (ctx.readInstructions === undefined) {
    report(path, `${name}: built-in templates keep their instructions inline, not in "${value}".`);
    return { file: value, text: value };
  }
  const read = await ctx.readInstructions(value);
  if (!read.ok) {
    report(path, `${name}: the instructions file "${value}" ${read.error}.`);
    return { file: value, text: value };
  }
  if (read.value.trim() === "") report(path, `${name}: the instructions file "${value}" is empty.`);
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
  return typeof id === "string" && id !== "" ? `step "${id}"` : `step ${path[1] + 1}`;
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
  if (subject === undefined) return `"${fieldOf(path)}"`;
  return path.length === 2 ? subject : `${subject}: "${fieldOf(path)}"`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const prefixed = (subject: string | undefined, message: string) => (subject ? `${capitalize(subject)}: ${message}` : capitalize(message));
