// Parses Claude Code's stream-json output (one JSON object per line) into agent call events, and
// keeps what the end event needs: usage, session id, the result, and the error signals.
// The stream is outside input: every line is validated, and a line that does not fit is skipped.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { z } from "zod";
import type { AgentCallErrorKind, AgentCallEvent, RateLimitWindow, TokenUsage } from "../../../kernel/schemas/index.js";

// A count the CLI reports. A missing or odd value counts as absent rather than dropping the line.
const count = z.int().nonnegative().optional().catch(undefined);

const MessageUsage = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
});

const ModelUsage = z.looseObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
});

const ContentBlock = z.looseObject({
  type: z.string(),
  id: z.string().min(1).optional().catch(undefined),
  text: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  input: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

const SystemLine = z.looseObject({
  type: z.literal("system"),
  subtype: z.string().optional().catch(undefined),
  session_id: z.string().min(1).optional().catch(undefined),
  cwd: z.string().optional().catch(undefined),
});

const AssistantLine = z.looseObject({
  type: z.literal("assistant"),
  /** Set on a subagent's message: the id of the parent's tool call that started the subagent. */
  parent_tool_use_id: z.string().nullable().optional().catch(undefined),
  message: z.looseObject({
    id: z.string().optional().catch(undefined),
    content: z.array(ContentBlock).catch([]),
    usage: MessageUsage.optional().catch(undefined),
  }),
  /** Set on a message the CLI made up for a failed API call, e.g. `authentication_failed`. */
  error: z.string().optional().catch(undefined),
  session_id: z.string().min(1).optional().catch(undefined),
});

const UserLine = z.looseObject({
  type: z.literal("user"),
  /** Set on a subagent's message: the id of the parent's tool call that started the subagent. */
  parent_tool_use_id: z.string().nullable().optional().catch(undefined),
  message: z.looseObject({
    // A prompt is a plain string; tool results come as a list of blocks.
    content: z.array(z.looseObject({ type: z.string(), tool_use_id: z.string().min(1).optional().catch(undefined) })).catch([]),
  }),
});

const Window = z.looseObject({ utilization: z.number().nonnegative(), resetsAt: z.number().nonnegative().optional().catch(undefined) });

const RateLimitLine = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string().min(1),
    rateLimitType: z.string().min(1).optional().catch(undefined),
    utilization: z.number().nonnegative().optional().catch(undefined),
    resetsAt: z.number().nonnegative().optional().catch(undefined),
    unifiedWindows: z.record(z.string(), Window).optional().catch(undefined),
  }),
});

const ResultLine = z.looseObject({
  type: z.literal("result"),
  subtype: z.string().optional().catch(undefined),
  is_error: z.boolean().catch(true),
  result: z.unknown().optional(),
  session_id: z.string().min(1).optional().catch(undefined),
  usage: MessageUsage.optional().catch(undefined),
  modelUsage: z.record(z.string().min(1), ModelUsage).optional().catch(undefined),
  /** The CLI's list-price estimate for the whole session, subagents included. */
  total_cost_usd: z.number().nonnegative().optional().catch(undefined),
  api_error_status: z.number().nullable().optional().catch(undefined),
});

const Line = z.discriminatedUnion("type", [SystemLine, AssistantLine, UserLine, RateLimitLine, ResultLine]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Fields that describe a call rather than identify it; they would hide a repeated call.
const NOT_IDENTITY = new Set(["description"]);
// The part of an edit that changes the file, kept as a short hash: two edits of one file are the
// same call only when they make the same change.
const CHANGE_FIELDS: Record<string, readonly string[]> = {
  Edit: ["old_string", "new_string", "replace_all"],
  Write: ["content"],
  MultiEdit: ["edits"],
  NotebookEdit: ["cell_id", "new_source", "edit_mode"],
};
type ToolInput = Record<string, string | number | boolean>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface CallResult {
  readonly isError: boolean;
  readonly text: string;
  /** The CLI's word for how the call ended, e.g. `success`, `error_during_execution`. */
  readonly subtype?: string;
  readonly apiErrorStatus?: number;
}

/** What the stream said about the call so far. */
export interface StreamState {
  readonly sessionId?: string;
  readonly result?: CallResult;
  readonly usage: TokenUsage;
  readonly modelUsage?: Record<string, TokenUsage>;
  /** The CLI's own cost estimate in US dollars, from the result. */
  readonly costUsd?: number;
  /** The `error` of the last made-up assistant message, and that message's text. */
  readonly assistantError?: { readonly code: string; readonly text: string };
  /** A rate-limit event said the plan's limit is reached. */
  readonly limitRejected: boolean;
}

export interface StreamParser {
  /** The events in one stdout line. Never throws. */
  line(line: string): AgentCallEvent[];
  state(): StreamState;
  /** `text` with the working directory written as `.` and the home directory as `~`. */
  scrub(text: string): string;
}

/** `cwd` is the call's working directory: paths in tool calls are recorded relative to it. */
export function createStreamParser(cwd: string, home: string = homedir()): StreamParser {
  // Claude reports its own view of the cwd (on macOS /tmp is /private/tmp); both are tried.
  const roots = [cwd];
  let sessionId: string | undefined;
  let result: CallResult | undefined;
  let resultUsage: { usage: TokenUsage; modelUsage?: Record<string, TokenUsage> } | undefined;
  let costUsd: number | undefined;
  let assistantError: StreamState["assistantError"];
  let limitRejected = false;
  // One API message arrives as one line per content block, each with the same id and usage.
  const messageUsage = new Map<string, TokenUsage>();
  const seenMessages = new Set<string>();

  const inside = (rel: string) => rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const relativePath = (path: string): string | undefined => {
    if (!isAbsolute(path)) {
      const rel = normalize(path);
      return inside(rel) ? rel : undefined;
    }
    for (const root of roots) {
      const rel = relative(root, path);
      if (rel === "") return ".";
      if (inside(rel)) return rel;
    }
    return undefined;
  };

  const scrub = (text: string): string => {
    let out = text;
    // Longest first, so the cwd is replaced before the home folder that may hold it.
    const replacements: Array<[string, string]> = [...roots.map((root): [string, string] => [root, "."]), [home, "~"]];
    for (const [from, to] of replacements.filter(([from]) => from.length > 1).sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(from).join(to);
    }
    return out;
  };

  /**
   * The fields that make two tool calls the same call. A path is relative to the working
   * directory; a path outside it is recorded as `outside:<hash>`, so two outside paths stay
   * distinct without the path being stored. Other strings have the cwd and home folder replaced.
   * Objects and arrays (an edit list, a todo list) are kept as a short hash.
   */
  const identity = (name: string, input: Record<string, unknown>): ToolInput => {
    const out: ToolInput = {};
    const change = CHANGE_FIELDS[name];
    for (const [key, value] of Object.entries(input)) {
      if (NOT_IDENTITY.has(key) || change?.includes(key) || value === null || value === undefined) continue;
      if (/path$/.test(key) && typeof value === "string") out[key] = relativePath(value) ?? `outside:${hash(value)}`;
      else if (typeof value === "string") out[key] = scrub(value);
      else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
      else out[key] = hash(JSON.stringify(value) ?? "");
    }
    if (change !== undefined) out["change"] = hash(JSON.stringify(change.map((key) => input[key] ?? null)));
    return out;
  };

  let anonymousTools = 0;
  const seenTools = new Set<string>();
  const endedTools = new Set<string>();
  const blockEvents = (block: z.output<typeof ContentBlock>): AgentCallEvent[] => {
    if (block.type === "text") return block.text ? [{ type: "text", text: block.text }] : [];
    if (block.type !== "tool_use" || !block.name) return [];
    const id = block.id ?? `tool-${++anonymousTools}`;
    if (seenTools.has(id)) return [];
    seenTools.add(id);
    const kind = EDIT_TOOLS.has(block.name) ? "edit" : block.name === "Bash" ? "command" : "other";
    return [{ type: "tool_call", id, name: block.name, kind, input: identity(block.name, block.input ?? {}) }];
  };

  const parseLine = (text: string): AgentCallEvent[] => {
    if (!text.startsWith("{")) return [];
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const parsed = Line.safeParse(json);
    if (!parsed.success) return [];
    const line = parsed.data;
    switch (line.type) {
      case "system":
        sessionId = line.session_id ?? sessionId;
        if (line.subtype === "init" && line.cwd !== undefined && isAbsolute(line.cwd)) roots.unshift(line.cwd);
        return [];
      case "assistant": {
        sessionId = line.session_id ?? sessionId;
        const message = line.message;
        if (message.id !== undefined && message.usage !== undefined) messageUsage.set(message.id, fromMessageUsage(message.usage));
        if (line.error !== undefined) {
          const said = message.content.map((block) => block.text ?? "").join("").trim();
          assistantError = { code: line.error, text: said };
        }
        // A subagent's turns and tool calls are not the parent's; its tokens still count.
        if (typeof line.parent_tool_use_id === "string") return [];
        // One turn per API message, which arrives as one line per content block.
        const newTurn = message.id === undefined || !seenMessages.has(message.id);
        if (message.id !== undefined) seenMessages.add(message.id);
        const events = message.content.flatMap(blockEvents);
        return newTurn ? [{ type: "turn" }, ...events] : events;
      }
      case "user": {
        // A subagent's tool results are not the parent's, as its tool calls are not.
        if (typeof line.parent_tool_use_id === "string") return [];
        return line.message.content.flatMap((block): AgentCallEvent[] => {
          if (block.type !== "tool_result" || block.tool_use_id === undefined || endedTools.has(block.tool_use_id)) return [];
          endedTools.add(block.tool_use_id);
          return [{ type: "tool_result", id: block.tool_use_id }];
        });
      }
      case "rate_limit_event":
        return [rateLimitEvent(line.rate_limit_info, (rejected) => (limitRejected ||= rejected))];
      case "result": {
        sessionId = line.session_id ?? sessionId;
        const said = typeof line.result === "string" ? line.result : "";
        result = { isError: line.is_error, text: said, ...(line.subtype !== undefined && { subtype: line.subtype }), ...(typeof line.api_error_status === "number" && { apiErrorStatus: line.api_error_status }) };
        // A result with zeroed totals (a crash) keeps the cost an earlier result reported.
        if (line.total_cost_usd !== undefined && (line.total_cost_usd > 0 || costUsd === undefined)) costUsd = line.total_cost_usd;
        const models = Object.entries(line.modelUsage ?? {});
        if (models.length > 0) {
          const modelUsage = Object.fromEntries(models.map(([name, usage]) => [name, fromModelUsage(usage)]));
          resultUsage = { usage: sum(Object.values(modelUsage)), modelUsage };
        } else if (line.usage !== undefined) {
          resultUsage = { usage: fromMessageUsage(line.usage) };
        }
        return [];
      }
    }
  };

  return {
    line(text) {
      try {
        return parseLine(text.trim());
      } catch {
        return [];
      }
    },
    scrub,
    state() {
      return {
        ...(sessionId !== undefined && { sessionId }),
        ...(result !== undefined && { result }),
        // Without a result (a stop, a crash), the per-message usage is the best partial count.
        usage: resultUsage?.usage ?? sum([...messageUsage.values()]),
        ...(resultUsage?.modelUsage !== undefined && { modelUsage: resultUsage.modelUsage }),
        ...(costUsd !== undefined && { costUsd }),
        ...(assistantError !== undefined && { assistantError }),
        limitRejected,
      };
    },
  };
}

function rateLimitEvent(
  info: z.output<typeof RateLimitLine>["rate_limit_info"],
  onRejected: (rejected: boolean) => void,
): AgentCallEvent {
  onRejected(info.status === "rejected");
  // Utilization is 0 to 1 and times are epoch seconds in this event.
  const window = (name: string, utilization: number, resetsAt: number | undefined): RateLimitWindow => ({
    window: name,
    usedPercent: Math.round(utilization * 10_000) / 100,
    ...(resetsAt !== undefined && { resetsAt: Math.round(resetsAt * 1000) }),
  });
  const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, w]) => window(name, w.utilization, w.resetsAt));
  if (windows.length === 0 && info.rateLimitType !== undefined && info.utilization !== undefined) {
    windows.push(window(info.rateLimitType, info.utilization, info.resetsAt));
  }
  return { type: "rate_limit", status: info.status, windows };
}

const fromMessageUsage = (usage: z.output<typeof MessageUsage>): TokenUsage => ({
  input: usage.input_tokens ?? 0,
  output: usage.output_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
});

const fromModelUsage = (usage: z.output<typeof ModelUsage>): TokenUsage => ({
  input: usage.inputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  cacheRead: usage.cacheReadInputTokens ?? 0,
  cacheWrite: usage.cacheCreationInputTokens ?? 0,
});

function sum(usages: readonly TokenUsage[]): TokenUsage {
  return usages.reduce(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
    }),
    NO_TOKENS,
  );
}

// The `error` values Claude Code puts on a made-up assistant message for a failed API call.
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"]);

/**
 * Why a call failed when it did not time out. Structured signals first (the assistant message's
 * `error`, a rejected rate-limit event, the API status), then the words of the result or stderr.
 */
export function classifyFailure(state: StreamState, stderr: string): AgentCallErrorKind {
  const code = state.assistantError?.code;
  if (code !== undefined && AUTH_ERRORS.has(code)) return "auth";
  if (code === "billing_error" || state.limitRejected) return "quota";
  if (code === "rate_limit" || code === "overloaded") return "rate_limit";
  const status = state.result?.apiErrorStatus;
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 529) return "rate_limit";
  const words = `${state.result?.text ?? ""}\n${state.assistantError?.text ?? ""}\n${stderr}`;
  if (/not logged in|run \/login|invalid api key|oauth token (has )?expired|authentication_error/i.test(words)) return "auth";
  if (/usage limit|hit your limit|out of extra usage|credit balance is too low/i.test(words)) return "quota";
  if (/rate[ _]limit|overloaded|\b429\b|\b529\b/i.test(words)) return "rate_limit";
  return "crash";
}
