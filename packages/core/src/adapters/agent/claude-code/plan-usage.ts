// Claude Code's plan windows, read without Tokama ever touching its login:
// - `requestClaudePlan` asks a fresh, idle `claude -p` session for its usage with the `get_usage`
//   control request. Claude Code makes the network call itself, with its own login; no prompt is
//   sent and no tokens are spent. The request is experimental, so it runs only on versions it was
//   checked on or later, and a reply of another shape counts as no answer.
// - `readClaudePlanCache` reads the one key `cachedUsageUtilization` of `~/.claude.json`, the copy
//   Claude Code keeps of its last usage answer. Read-only; the rest of the file is ignored.
// Both answers carry a `limits` list (session, weekly, and weekly limits scoped to one model) and
// the older fixed windows. The list is read when every entry has a known shape, else the fixed
// windows are. Only usage numbers and labels are kept, never account fields.
// The run loop's third source, the rate-limit events of Tokama's own calls, comes from the stream parser.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "../../../kernel/clock/index.js";
import { readTextFile } from "../../../kernel/fs-safe/index.js";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import { err, ok, type Result } from "../../../kernel/result/index.js";
import type { PlanWindow } from "../../../kernel/schemas/index.js";
import { CLAUDE_CODE_COMMAND } from "./command.js";
import { compareVersions, parseVersion } from "./version.js";

/** The first Claude Code version `get_usage` was checked on. */
export const GET_USAGE_FROM = "2.1.331";

/** The plan windows Claude Code reported, and when they were read. */
export interface ClaudePlan {
  readonly windows: readonly PlanWindow[];
  readonly asOf: number;
  /** The subscription, e.g. `max`, `pro`. */
  readonly plan?: string;
  readonly extraUsage?: "on" | "off";
  readonly version?: string;
}

export interface ClaudePlanOptions {
  /** argv that starts the CLI. Default: `[CLAUDE_CODE_COMMAND]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  readonly runner?: ProcessRunner;
  readonly clock?: Clock;
  /** Per command. Default: 20 s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

// The fixed windows a plan has. Other keys of the reply are codenamed buckets, spend and extra usage.
const WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;
const MAX_LIMITS = 20;
// A model name such as `Fable` or `Opus 4`: letters, digits, spaces, dots and dashes.
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,47}$/u;
const REQUEST_ID = "tokama-usage";
const MAX_LINES = 200;
// `~/.claude.json` holds Claude Code's whole config; well below this in practice.
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

const Bucket = z.looseObject({
  // 0 to 100 in both the reply and the cache; null when the plan has no such window.
  utilization: z.number().nonnegative().nullable(),
  resets_at: z.string().nullable().optional(),
});

// One entry of the `limits` list. An unknown kind or group, or a percent that is not a number,
// refuses the whole list.
const Limit = z.looseObject({
  kind: z.enum(["session", "weekly_all", "weekly_scoped"]),
  group: z.enum(["session", "weekly"]),
  percent: z.number().nonnegative(),
  resets_at: z.string().nullable().optional().catch(undefined),
  severity: z.string().regex(/^[a-z_]{1,32}$/).nullable().optional().catch(undefined),
  is_active: z.boolean().optional().catch(undefined),
  // Read only for its label; see `scopeLabel`.
  scope: z.unknown().optional(),
});

// How much of the weekly limit a scoped limit may use; `limit_index` points into `limits`.
const Share = z.looseObject({ limit_index: z.int().nonnegative(), allowance_percent_of_weekly: z.number().nonnegative() });

const Utilization = z.looseObject({
  ...Object.fromEntries(WINDOWS.map((name) => [name, Bucket.nullable().optional().catch(undefined)])),
  extra_usage: z.looseObject({ is_enabled: z.boolean() }).nullable().optional().catch(undefined),
  limits: z.array(Limit).min(1).max(MAX_LIMITS).nullable().optional().catch(undefined),
  weekly_scoped_shares: z.array(Share).max(MAX_LIMITS).nullable().optional().catch(undefined),
});

const Reply = z.looseObject({
  type: z.literal("control_response"),
  response: z.discriminatedUnion("subtype", [
    z.looseObject({
      subtype: z.literal("success"),
      request_id: z.literal(REQUEST_ID),
      response: z.looseObject({
        subscription_type: z.string().min(1).max(64).nullable().optional().catch(undefined),
        rate_limits_available: z.boolean(),
        rate_limits: Utilization.nullable(),
      }),
    }),
    z.looseObject({ subtype: z.literal("error"), request_id: z.literal(REQUEST_ID), error: z.string().optional().catch(undefined) }),
  ]),
});

const Cache = z.looseObject({
  cachedUsageUtilization: z.looseObject({ fetchedAtMs: z.int().nonnegative(), utilization: Utilization }),
});

/** Asks Claude Code for its plan windows. An error says, in plain words, why they are unknown. */
export async function requestClaudePlan(options: ClaudePlanOptions = {}): Promise<Result<ClaudePlan, string>> {
  const command = options.command ?? [CLAUDE_CODE_COMMAND];
  const runner = options.runner ?? createProcessRunner();
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const run = async (args: readonly string[], stdin?: string) => {
    const lines: string[] = [];
    const result = await runner.run({
      command: { argv: [...command, ...args] },
      cwd: tmpdir(),
      timeoutMs,
      ...(options.signal !== undefined && { signal: options.signal }),
      ...(stdin !== undefined && { stdin }),
      stdout: { onLine: (line) => void (lines.length < MAX_LINES && lines.push(line)) },
    });
    return { result, lines };
  };
  const STOPPED = "The usage request was stopped.";
  // Why a command gave nothing, in plain words: stopped, too slow, or not there at all.
  const failure = ({ result }: Awaited<ReturnType<typeof run>>, what: string): string | undefined => {
    if (result.kind === "not-started") return result.reason === "aborted" ? STOPPED : result.code === "ENOENT" ? "Claude Code is not installed, or `claude` is not on the PATH." : `Claude Code did not start: ${result.message.slice(0, 200)}`;
    if (result.aborted) return STOPPED;
    if (result.timedOut) return `Claude Code did not ${what} within ${Math.round(timeoutMs / 1000)} s.`;
    return undefined;
  };

  const shown = await run(["--version"]);
  const notShown = failure(shown, "report its version");
  if (notShown !== undefined) return err(notShown);
  const version = parseVersion(shown.lines.join("\n"));
  if (version === undefined) return err("Claude Code did not report its version.");
  if (compareVersions(version, GET_USAGE_FROM) < 0) return err(`Claude Code ${version} is older than ${GET_USAGE_FROM}, the first version Tokama asks for usage.`);

  // --restricted ignores the user's settings and hooks; no tools, no MCP servers, nothing allowed.
  const asked = await run(
    ["-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose", "--restricted", "--permission-mode=dontAsk", "--strict-mcp-config", "--tools="],
    `${JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } })}\n`,
  );
  // A stop after the answer came does not lose the answer, unless it was the caller's.
  if (options.signal?.aborted) return err(STOPPED);
  const now = clock.now();
  for (const line of asked.lines) {
    if (!line.includes('"control_response"')) continue;
    const reply = parseGetUsageReply(line, now);
    return reply.ok ? ok({ ...reply.value, version }) : reply;
  }
  return err(failure(asked, "answer the usage request") ?? `Claude Code ${version} did not answer the usage request.`);
}

/** Reads one `get_usage` reply line. Exported for the recorded-sample tests. */
export function parseGetUsageReply(line: string, now: number): Result<ClaudePlan, string> {
  const parsed = Reply.safeParse(parseJson(line));
  if (!parsed.success) return err("Claude Code answered the usage request in a shape Tokama does not know.");
  const { response } = parsed.data;
  if (response.subtype === "error") return err(`Claude Code could not read its usage${response.error ? `: ${response.error.slice(0, 200)}` : "."}`);
  const answer = response.response;
  if (!answer.rate_limits_available || answer.rate_limits === null) return err("This Claude Code login has no plan windows (an API key or a cloud provider).");
  return ok(reading(answer.rate_limits, now, answer.subscription_type ?? undefined));
}

/** Reads Claude Code's cached usage from `<home>/.claude.json`. */
export async function readClaudePlanCache(home: string = homedir()): Promise<Result<ClaudePlan, string>> {
  const path = join(home, ".claude.json");
  // Claude Code rewrites the file often; a read can catch it half written, so a bad read is tried once more.
  for (let tries = 0; ; tries++) {
    const text = await readTextFile(path, { maxBytes: MAX_CONFIG_BYTES });
    if (!text.ok) return err(text.error.reason === "not_found" ? "Claude Code has no cached usage." : `Cannot read Claude Code's cached usage: ${text.error.message}.`);
    const cached = parseUsageCache(text.value);
    if (cached.ok || tries > 0 || parseJson(text.value) !== undefined) return cached;
  }
}

/** Reads the cached usage out of the text of `~/.claude.json`. Exported for the recorded-sample tests. */
export function parseUsageCache(text: string): Result<ClaudePlan, string> {
  const parsed = Cache.safeParse(parseJson(text));
  if (!parsed.success) return err("Claude Code has no cached usage Tokama can read.");
  const { fetchedAtMs, utilization } = parsed.data.cachedUsageUtilization;
  return ok(reading(utilization, fetchedAtMs));
}

function reading(utilization: z.output<typeof Utilization>, asOf: number, plan?: string): ClaudePlan {
  const extra = utilization.extra_usage;
  return {
    windows: utilization.limits ? limitWindows(utilization.limits, utilization.weekly_scoped_shares ?? []) : fixedWindows(utilization),
    asOf,
    ...(plan !== undefined && { plan }),
    ...(extra !== null && extra !== undefined && { extraUsage: extra.is_enabled ? "on" : "off" }),
  };
}

function fixedWindows(utilization: z.output<typeof Utilization>): PlanWindow[] {
  return WINDOWS.flatMap((name): PlanWindow[] => {
    const bucket = utilization[name] as z.output<typeof Bucket> | null | undefined;
    if (bucket === null || bucket === undefined || bucket.utilization === null) return [];
    return [{ window: name, usedPercent: percent(bucket.utilization), ...resetTime(bucket.resets_at) }];
  });
}

function limitWindows(limits: readonly z.output<typeof Limit>[], shares: readonly z.output<typeof Share>[]): PlanWindow[] {
  return limits.map((limit, index): PlanWindow => {
    const scope = limit.kind === "weekly_scoped" ? scopeLabel(limit.scope) : undefined;
    // A share counts only for the scoped limit it points at.
    const share = limit.kind === "weekly_scoped" ? shares.find((s) => s.limit_index === index) : undefined;
    return {
      window: limit.kind,
      usedPercent: percent(limit.percent),
      ...resetTime(limit.resets_at),
      ...(scope !== undefined && { scope }),
      group: limit.group,
      ...(limit.severity && { severity: limit.severity }),
      ...(limit.is_active !== undefined && { active: limit.is_active }),
      ...(share !== undefined && { sharePercent: Math.min(100, Math.round(share.allowance_percent_of_weekly * 100) / 100) }),
    };
  });
}

/**
 * The model a scoped limit covers, e.g. `Fable`. The scope's shape is not documented, so only its
 * model's display name or name is looked for; ids, the scope's own name (it could name an account
 * or an organization) and other fields are never read.
 */
function scopeLabel(scope: unknown): string | undefined {
  const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);
  const model = field(scope, "model");
  for (const candidate of [field(model, "display_name"), field(model, "name")]) {
    if (typeof candidate !== "string") continue;
    const label = candidate.trim();
    if (LABEL.test(label)) return label;
  }
  return undefined;
}

/** 0 to 100 as the CLI sends it, cut to two decimals and at most 1000. */
const percent = (value: number): number => Math.min(1000, Math.round(value * 100) / 100);

function resetTime(resetsAt: string | null | undefined): { resetsAt?: number } {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(at) && at >= 0 ? { resetsAt: at } : {};
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
