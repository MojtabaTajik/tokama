// Builds what one agent call receives and checks the step's data rule a second time, at the last
// point before anything is sent. Template validation already refuses these cases; this check
// holds even for a forged or damaged template record.
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { AgentId, AiCliId, DataRule, StepId, TemplateRecord, TemplateStepDef } from "../../kernel/schemas/index.js";
import { CHECK_OUTPUT_MAX_BYTES, chooseMark, fence, randomMark, tail } from "./fence.js";
import { TOKAMA_RULES } from "./rules.js";

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
  /** Repo-relative path. */
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
  readonly repoContext?: RepoContext;
  /** For a cloud step with `summary-after-approval`: the summary text the engineer approved. */
  readonly approvedSummary?: string;
  /** Draws the data-block mark. Default: 16 random bytes in hex. */
  readonly drawMark?: () => string;
}

export type IncludedKind = "item-text" | "result" | "diff" | "repo-file" | "check-output" | "approved-summary";

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
  /** For a cloud agent: the exact text that leaves the machine. */
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
  | "cloud-data-none"
  | "cloud-connections"
  | "cloud-connection-input"
  | "missing-summary"
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

const refuse = (code: PromptRefusalCode, message: string) => err<PromptRefusal>({ code, message });

export function buildPrompt(input: PromptInput): Result<BuiltPrompt, PromptRefusal> {
  const { template, stepId, agent } = input;
  const index = template.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return refuse("unknown-step", `Template ${template.ref} has no step ${JSON.stringify(stepId)}.`);
  const step = template.steps[index]!;
  const name = `Step ${JSON.stringify(step.id)}`;
  if (agent.id !== step.agentId) {
    return refuse("agent-mismatch", `${name} runs on agent ${JSON.stringify(step.agentId)}, not ${JSON.stringify(agent.id)}.`);
  }
  const earlier = new Set(template.steps.slice(0, index).map((s) => s.id));
  const notEarlier = step.sees.find((seen) => !earlier.has(seen));
  if (notEarlier !== undefined) {
    return refuse("sees-not-earlier", `${name} sees ${JSON.stringify(notEarlier)}, which is not an earlier step of the template.`);
  }

  const cloud = runsInCloud(agent.cliId);
  if (cloud) {
    const refusal = cloudRefusal(template, step, input.approvedSummary);
    if (refusal) return err(refusal);
  }
  const summaryOnly = cloud && step.data === "summary-after-approval";

  // The inputs after the instructions, in order. Each becomes one data block.
  const warnings: string[] = [];
  const included: IncludedInput[] = [];
  type Block = { kind: IncludedKind; name: string; text: string; cutFromBytes?: number };
  const blocks: Block[] = [];
  if (summaryOnly) {
    blocks.push({ kind: "approved-summary", name: "approved summary", text: input.approvedSummary! });
  } else {
    blocks.push({ kind: "item-text", name: "item text", text: input.itemText });
    if (input.repoContext?.diff !== undefined) blocks.push({ kind: "diff", name: "diff", text: input.repoContext.diff });
    for (const file of input.repoContext?.files ?? []) blocks.push({ kind: "repo-file", name: file.path, text: file.text });
    if (input.lastCheckOutput !== undefined) {
      const cut = tail(input.lastCheckOutput, CHECK_OUTPUT_MAX_BYTES);
      blocks.push({ kind: "check-output", name: "last check output", text: cut.text, ...(cut.bytes < cut.originalBytes ? { cutFromBytes: cut.originalBytes } : {}) });
    }
  }

  // References resolve against the steps this step sees, and never in summary-only mode, where
  // the approved summary stands in for every earlier result.
  const visible = new Set<string>(step.sees);
  const references: Block[] = [];
  const resolve = (raw: string): Block | undefined => {
    const shown = `{{${raw}}}`.slice(0, 100);
    if (summaryOnly) {
      warnings.push(`${shown} left out: this step sends only the approved summary.`);
      return undefined;
    }
    const match = STEP_FIELD.exec(raw);
    const [id, field] = match ? [match[1]!, match[2]!] : [undefined, undefined];
    const fields = id !== undefined && visible.has(id) && Object.hasOwn(input.results, id) ? input.results[id] : undefined;
    if (fields === undefined || field === undefined || !Object.hasOwn(fields, field)) {
      warnings.push(`${shown} is not a result this step sees; it was left out.`);
      return undefined;
    }
    return { kind: "result", name: `${id}.${field}`, text: fields[field]! };
  };
  // First pass only finds the references, so the mark can be checked against their values too.
  const resolved = [...step.instructions.text.matchAll(REFERENCE)].map((match) => resolve(match[1]!));
  for (const block of resolved) if (block) references.push(block);

  const untrusted = [...blocks, ...references].flatMap((block) => [block.name, block.text]);
  const mark = chooseMark(untrusted, input.drawMark ?? randomMark);
  if (!mark.ok) return refuse("mark", mark.error);

  const render = (block: Block): string => {
    included.push({ kind: block.kind, name: block.name, bytes: Buffer.byteLength(block.text, "utf8"), ...(block.cutFromBytes === undefined ? {} : { cutFromBytes: block.cutFromBytes }) });
    const note = block.cutFromBytes === undefined ? undefined : `cut to the last ${Buffer.byteLength(block.text, "utf8")} of ${block.cutFromBytes} bytes`;
    return fence(block.name, block.text, mark.value, note);
  };

  // One replace over the instructions only, with a function replacer: values are inserted as they
  // are (no `$&` patterns), and inserted text is never scanned for references again.
  let next = 0;
  const instructions = step.instructions.text.replace(REFERENCE, () => {
    const block = resolved[next++];
    return block ? `\n${render(block)}\n` : "";
  });

  const system = agent.role.trim() === "" ? TOKAMA_RULES : `${TOKAMA_RULES}\n\n${agent.role.trim()}`;
  const user = [`Data blocks in this message use the mark ${mark.value}.`, instructions.trim(), ...blocks.map(render)].join("\n\n") + "\n";

  const record: PromptRecord = {
    stepId: step.id,
    agentId: agent.id,
    cloud,
    data: step.data,
    mark: mark.value,
    included,
    warnings,
    ...(cloud ? { sentToCloud: { system, user } } : {}),
  };
  return ok({ system, user, record });
}

/** The data-rule checks for a cloud step; undefined when the step may run. */
function cloudRefusal(template: TemplateRecord, step: TemplateStepDef, approvedSummary: string | undefined): PromptRefusal | undefined {
  const name = `Step ${JSON.stringify(step.id)}`;
  if (step.connections.length > 0) {
    return { code: "cloud-connections", message: `${name} runs on a cloud agent and has connections. Cloud steps never get connections.` };
  }
  switch (step.data) {
    case "none":
      return { code: "cloud-data-none", message: `${name} runs on a cloud agent but its data rule is none, so nothing may be sent to it.` };
    case "summary-after-approval":
      if (approvedSummary === undefined || approvedSummary.trim() === "") {
        return { code: "missing-summary", message: `${name} sends only an approved summary, and no approved summary was given.` };
      }
      return undefined;
    case "repo-and-diff": {
      const tainted = fromConnections(template);
      const first = step.sees.find((seen) => tainted.has(seen));
      if (first !== undefined) {
        return {
          code: "cloud-connection-input",
          message: `${name} sends the repo and diff to a cloud agent, so it cannot get ${JSON.stringify(first)}, which has results from connections.`,
        };
      }
      return undefined;
    }
  }
}

/**
 * Steps whose results come from connections: steps with connections, and steps that see one of
 * those, followed to a fixed point so a forged record's forward `sees` cannot hide a chain.
 */
function fromConnections(template: TemplateRecord): Set<string> {
  const tainted = new Set<string>(template.steps.filter((step) => step.connections.length > 0).map((step) => step.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of template.steps) {
      if (!tainted.has(step.id) && step.sees.some((seen) => tainted.has(seen))) {
        tainted.add(step.id);
        grew = true;
      }
    }
  }
  return tainted;
}
