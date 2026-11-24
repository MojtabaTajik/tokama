// Builds what one agent call receives and checks the step's data rule a second time, at the last
// point before anything is sent. Template validation already refuses these cases; this check
// holds even for a forged or damaged template record. Never throws: every problem is a refusal.
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  connectionDerivedSteps,
  type AgentId,
  type AiCliId,
  type DataRule,
  type StepId,
  type TemplateRecord,
  type TemplateStepDef,
} from "../../kernel/schemas/index.js";
import { CHECK_OUTPUT_MAX_BYTES, chooseMark, fence, randomMark, tail } from "./fence.js";
import { TOKAMA_RULES } from "./rules.js";

/** Larger inputs are refused, never cut: a cut diff or file would mislead the agent. */
export const PROMPT_LIMITS = {
  diffBytes: 256 * 1024,
  repoFileBytes: 64 * 1024,
  resultBytes: 64 * 1024,
  userBytes: 1024 * 1024,
  references: 20,
} as const;

/** What prompting needs of an agent; the config slice's `Agent` fits as it is. */
export interface PromptAgent {
  readonly id: AgentId;
  readonly cliId: AiCliId;
  /** The role instructions, added after the Tokama rules. */
  readonly role: string;
}

/** Earlier results by step id, then by field: `{{ build.diff }}` is `results.build.diff`. */
export type StepResults = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface RepoFile {
  /** Repo-relative path, with no `..` segment. */
  readonly path: string;
  readonly text: string;
}

export interface RepoContext {
  readonly diff?: string;
  readonly files?: readonly RepoFile[];
}

export interface PromptInput {
  readonly template: TemplateRecord;
  readonly stepId: StepId;
  readonly agent: PromptAgent;
  readonly results: StepResults;
  /** What the engineer asked for: the item's text. */
  readonly itemText: string;
  /** The output of the last failed checks, for a retry. Only its last part is kept. */
  readonly lastCheckOutput?: string;
  /**
   * What a later step said about this step's work (a reviewer's requested changes), for the next
   * attempt. Its first line is kept; the rest keeps its last part. Refused for a cloud agent when
   * the step that wrote it has results from connections.
   */
  readonly feedback?: { readonly fromStepId: StepId; readonly text: string };
  readonly repoContext?: RepoContext;
  /** For a cloud step with `summary-after-approval`: the summary text the engineer approved. Sent as it is. */
  readonly approvedSummary?: string;
  /** Local-only mode: every cloud agent is refused. */
  readonly localOnly?: boolean;
  /** The call's worktree: written as `.` in every input. */
  readonly worktreeRoot?: string;
  /** Written as `~` in every input. Default: the user's home folder. */
  readonly home?: string;
  /** Draws the data-block mark. Default: 16 random bytes in hex. */
  readonly drawMark?: () => string;
}

export type IncludedKind = "item-text" | "result" | "diff" | "repo-file" | "check-output" | "feedback" | "approved-summary";

export interface IncludedInput {
  readonly kind: IncludedKind;
  /** `build.diff` for a result, the path for a repo file, otherwise the kind. */
  readonly name: string;
  /** UTF-8 size of what was included. */
  readonly bytes: number;
  /** Present when the input was cut: its size before the cut. */
  readonly cutFromBytes?: number;
}

/** What went into the call, for the item store. Plain JSON. */
export interface PromptRecord {
  readonly stepId: StepId;
  readonly agentId: AgentId;
  readonly cloud: boolean;
  readonly data: DataRule;
  readonly mark: string;
  readonly included: readonly IncludedInput[];
  readonly warnings: readonly string[];
  /**
   * For a cloud agent: the prompt text Tokama sends. What the agent then reads with its tools
   * (files, command output) is not in it.
   */
  readonly sentToCloud?: { readonly system: string; readonly user: string };
}

export interface BuiltPrompt {
  /** Goes to the CLI's system prompt (`--append-system-prompt`). Holds no untrusted content. */
  readonly system: string;
  /** Goes to the CLI as the prompt. */
  readonly user: string;
  readonly record: PromptRecord;
}

export type PromptRefusalCode =
  | "unknown-step"
  | "agent-mismatch"
  | "sees-not-earlier"
  | "local-only"
  | "cloud-data-none"
  | "cloud-connections"
  | "cloud-connection-input"
  | "missing-summary"
  | "invalid-input"
  | "too-large"
  | "mark";

export interface PromptRefusal {
  readonly code: PromptRefusalCode;
  readonly message: string;
}

/** Whether the agent's model runs off this machine. A new CLI id fails typecheck here. */
export function runsInCloud(cliId: AiCliId): boolean {
  switch (cliId) {
    case "claude-code":
    case "codex-cli":
      return true;
    case "ollama":
      return false;
  }
}

/** `{{ ... }}` with no braces inside: a nested `{{ {{ x }} }}` only ever matches its inner part. */
const REFERENCE = /\{\{([^{}]*)\}\}/g;
const STEP_FIELD = /^\s*([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]{1,64})\s*$/;
/** Control, format, separator and unassigned characters: not allowed in a block name. */
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

class Refused extends Error {
  constructor(readonly refusal: PromptRefusal) {
    super(refusal.message);
  }
}
const refuse = (code: PromptRefusalCode, message: string): never => {
  throw new Refused({ code, message });
};
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

type Block = { kind: IncludedKind; name: string; text: string; cutFromBytes?: number };

export function buildPrompt(input: PromptInput): Result<BuiltPrompt, PromptRefusal> {
  try {
    return ok(build(input));
  } catch (error) {
    if (error instanceof Refused) return err(error.refusal);
    return err({ code: "invalid-input", message: `The prompt inputs are not valid: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function build(input: PromptInput): BuiltPrompt {
  const { template, stepId, agent } = input;
  const index = template.steps.findIndex((step) => step.id === stepId);
  if (index < 0) refuse("unknown-step", `Template ${template.ref} has no step ${JSON.stringify(stepId)}.`);
  const step = template.steps[index]!;
  const name = `Step ${JSON.stringify(step.id)}`;
  if (agent.id !== step.agentId) refuse("agent-mismatch", `${name} runs on agent ${JSON.stringify(step.agentId)}, not ${JSON.stringify(agent.id)}.`);
  const earlier = new Set(template.steps.slice(0, index).map((s) => s.id));
  const notEarlier = step.sees.find((seen) => !earlier.has(seen));
  if (notEarlier !== undefined) refuse("sees-not-earlier", `${name} sees ${JSON.stringify(notEarlier)}, which is not an earlier step of the template.`);

  const cloud = runsInCloud(agent.cliId);
  if (cloud && input.localOnly === true) refuse("local-only", `${name} runs on ${JSON.stringify(agent.id)}, a cloud agent, and this run is local only.`);
  if (cloud) checkCloud(template, step, input.approvedSummary);
  const summaryOnly = cloud && step.data === "summary-after-approval";

  const scrub = scrubber(input.worktreeRoot, input.home ?? homedir());
  const text = (value: unknown, what: string): string => {
    if (typeof value !== "string") refuse("invalid-input", `${what} is not text.`);
    return scrub(value as string);
  };
  const capped = (block: Block, max: number): Block => {
    const size = bytesOf(block.text);
    if (size > max) refuse("too-large", `${name}: ${block.name} is ${size} bytes, over the ${max}-byte limit.`);
    return block;
  };

  // The inputs after the instructions, in order. Each becomes one data block.
  const blocks: Block[] = [];
  if (summaryOnly) {
    // Sent exactly as the engineer approved it.
    blocks.push({ kind: "approved-summary", name: "approved summary", text: input.approvedSummary! });
  } else {
    blocks.push({ kind: "item-text", name: "item text", text: text(input.itemText, "The item text") });
    const repo = input.repoContext;
    if (repo?.diff !== undefined) blocks.push(capped({ kind: "diff", name: "diff", text: text(repo.diff, "The diff") }, PROMPT_LIMITS.diffBytes));
    for (const file of repo?.files ?? []) {
      blocks.push(capped({ kind: "repo-file", name: repoPath(file?.path), text: text(file.text, `Repo file ${JSON.stringify(file.path)}`) }, PROMPT_LIMITS.repoFileBytes));
    }
    if (input.feedback !== undefined) {
      const { fromStepId, text: said } = input.feedback;
      if (cloud && connectionDerivedSteps(template.steps).has(fromStepId)) {
        refuse("cloud-connection-input", `${name} runs on a cloud agent, so it cannot get the feedback of ${JSON.stringify(fromStepId)}, which has results from connections.`);
      }
      const whole = text(said, "The feedback");
      const newline = whole.indexOf("\n");
      const [header, rest] = newline === -1 ? [whole, ""] : [whole.slice(0, newline + 1), whole.slice(newline + 1)];
      const cut = tail(rest, Math.max(0, CHECK_OUTPUT_MAX_BYTES - bytesOf(header)));
      const kept = `${header}${cut.text}`;
      blocks.push({ kind: "feedback", name: `feedback from ${fromStepId}`, text: kept, ...(cut.bytes < cut.originalBytes ? { cutFromBytes: bytesOf(whole) } : {}) });
    }
    if (input.lastCheckOutput !== undefined) {
      const cut = tail(text(input.lastCheckOutput, "The check output"), CHECK_OUTPUT_MAX_BYTES);
      blocks.push({ kind: "check-output", name: "last check output", text: cut.text, ...(cut.bytes < cut.originalBytes ? { cutFromBytes: cut.originalBytes } : {}) });
    }
  }

  // References resolve against the steps this step sees, and never in summary-only mode, where
  // the approved summary stands in for every earlier result. Each result is rendered once; a
  // repeat points to its block.
  const warnings: string[] = [];
  const visible = new Set<string>(step.sees);
  const occurrences = [...step.instructions.text.matchAll(REFERENCE)].map((match) => match[1]!);
  if (occurrences.length > PROMPT_LIMITS.references) {
    refuse("too-large", `${name} has ${occurrences.length} references in its instructions, over the limit of ${PROMPT_LIMITS.references}.`);
  }
  const referencedSteps = new Set<string>();
  const byName = new Map<string, Block>();
  const resolved = occurrences.map((raw): Block | undefined => {
    const shown = `{{${raw}}}`.slice(0, 100);
    if (summaryOnly) {
      warnings.push(`${shown} left out: this step sends only the approved summary.`);
      return undefined;
    }
    const match = STEP_FIELD.exec(raw);
    const [id, field] = match ? [match[1]!, match[2]!] : [undefined, undefined];
    if (id !== undefined) referencedSteps.add(id);
    const fields: unknown = id !== undefined && visible.has(id) && Object.hasOwn(input.results, id) ? input.results[id] : undefined;
    if (fields !== undefined && (typeof fields !== "object" || fields === null)) refuse("invalid-input", `The results of step ${JSON.stringify(id)} are not a set of fields.`);
    if (fields === undefined || field === undefined || !Object.hasOwn(fields as object, field)) {
      warnings.push(`${shown} is not a result this step sees; it was left out.`);
      return undefined;
    }
    const blockName = `${id}.${field}`;
    const known = byName.get(blockName);
    if (known) return known;
    const block = capped({ kind: "result", name: blockName, text: text((fields as Record<string, unknown>)[field], `Result ${blockName}`) }, PROMPT_LIMITS.resultBytes);
    byName.set(blockName, block);
    return block;
  });
  if (!summaryOnly) {
    for (const seen of step.sees) {
      if (!referencedSteps.has(seen)) warnings.push(`${name} sees ${JSON.stringify(seen)} but its instructions do not reference it; its results were not sent.`);
    }
  }

  const untrusted = [...blocks, ...byName.values()].flatMap((block) => [block.name, block.text]);
  const mark = chooseMark(untrusted, input.drawMark ?? randomMark);
  if (!mark.ok) refuse("mark", mark.error);
  const markValue = (mark as { value: string }).value;

  const included: IncludedInput[] = [];
  const render = (block: Block): string => {
    const bytes = bytesOf(block.text);
    included.push({ kind: block.kind, name: block.name, bytes, ...(block.cutFromBytes === undefined ? {} : { cutFromBytes: block.cutFromBytes }) });
    const note = block.cutFromBytes === undefined ? undefined : `cut to the last ${bytes} of ${block.cutFromBytes} bytes`;
    return fence(block.name, block.text, markValue, note);
  };

  // One replace over the instructions only, with a function replacer: values are inserted as they
  // are (no `$&` patterns), and inserted text is never scanned for references again.
  const rendered = new Set<Block>();
  let next = 0;
  const instructions = step.instructions.text.replace(REFERENCE, () => {
    const block = resolved[next++];
    if (!block) return "";
    if (rendered.has(block)) return `(data block ${JSON.stringify(block.name)} above)`;
    rendered.add(block);
    return `\n${render(block)}\n`;
  });

  const role = agent.role.trim();
  const system = role === "" ? TOKAMA_RULES : `${TOKAMA_RULES}\n\n${role}`;
  const user = [`Data blocks in this message use the mark ${markValue}.`, instructions.trim(), ...blocks.map(render)].join("\n\n") + "\n";
  const userBytes = bytesOf(user);
  if (userBytes > PROMPT_LIMITS.userBytes) refuse("too-large", `${name}: the prompt is ${userBytes} bytes, over the ${PROMPT_LIMITS.userBytes}-byte limit.`);

  const record: PromptRecord = {
    stepId: step.id,
    agentId: agent.id,
    cloud,
    data: step.data,
    mark: markValue,
    included,
    warnings,
    ...(cloud ? { sentToCloud: { system, user } } : {}),
  };
  return { system, user, record };
}

/** The data-rule checks for a cloud step; refuses when the step may not run. */
function checkCloud(template: TemplateRecord, step: TemplateStepDef, approvedSummary: string | undefined): void {
  const name = `Step ${JSON.stringify(step.id)}`;
  if (step.connections.length > 0) refuse("cloud-connections", `${name} runs on a cloud agent and has connections. Cloud steps never get connections.`);
  switch (step.data) {
    case "none":
      return refuse("cloud-data-none", `${name} runs on a cloud agent but its data rule is none, so nothing may be sent to it.`);
    case "summary-after-approval":
      if (typeof approvedSummary !== "string" || approvedSummary.trim() === "") {
        refuse("missing-summary", `${name} sends only an approved summary, and no approved summary was given.`);
      }
      return;
    case "repo-and-diff": {
      const derived = connectionDerivedSteps(template.steps);
      const first = step.sees.find((seen) => derived.has(seen));
      if (first !== undefined) {
        refuse("cloud-connection-input", `${name} sends the repo and diff to a cloud agent, so it cannot get ${JSON.stringify(first)}, which has results from connections.`);
      }
      return;
    }
  }
}

/** A repo file's path as its block name: relative, with no `..` segment, printable. */
function repoPath(path: unknown): string {
  if (typeof path !== "string" || path === "") return refuse("invalid-input", "A repo file has no path.");
  const shown = JSON.stringify(path.slice(0, 200));
  if (NOT_PRINTABLE.test(path)) refuse("invalid-input", `Repo file path ${shown} has characters that are not printable.`);
  if (isAbsolute(path) || /^[\\/]|^[A-Za-z]:/.test(path)) refuse("invalid-input", `Repo file path ${shown} is absolute; it must be relative to the repo.`);
  if (path.split(/[\\/]/).includes("..")) refuse("invalid-input", `Repo file path ${shown} has a '..' segment.`);
  return path;
}

/** Writes the worktree as `.` and the home folder as `~`; longest first, as the worktree is usually inside home. */
function scrubber(worktreeRoot: string | undefined, home: string): (text: string) => string {
  const replacements: Array<[string, string]> = [...(worktreeRoot === undefined ? [] : [[worktreeRoot, "."] as [string, string]]), [home, "~"]];
  const ordered = replacements.filter(([from]) => from.length > 1).sort((a, b) => b[0].length - a[0].length);
  return (text) => ordered.reduce((out, [from, to]) => out.split(from).join(to), text);
}
