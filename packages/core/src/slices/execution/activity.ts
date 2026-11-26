// What an agent call is doing now, from its event stream: the latest action in words, when the
// agent last sent an event, and the tool call that is still running, if any. One tracker per
// call; the live activity line and the silence stop both read it.
//
// The words come from the tool call's input as the runtime recorded it: paths are relative to the
// worktree, a path outside it is only a hash, and commands have the worktree and home folder
// replaced. Paths a command still names outside the worktree are left out here.
import { type ActivityKind, type ItemActivity, MAX_ACTIVITY_LABEL_CHARS, type AgentCallEvent } from "../../kernel/schemas/index.js";
import { cutText } from "../../kernel/text/index.js";

type ToolCall = Extract<AgentCallEvent, { type: "tool_call" }>;

export interface Action {
  readonly kind: ActivityKind;
  /** What the agent does, in words: `editing src/board.ts`, `running pnpm test`, `thinking`. */
  readonly label: string;
}

/** What the tracker knows now. Plain JSON. */
export type ActivityState = Pick<ItemActivity, "lastAction" | "lastEventAt" | "toolRunning">;

export interface ActivityTracker {
  /** Feeds one event that arrived at `now`. Returns false for an event that is not the agent's own (a plan-usage report). */
  observe(event: AgentCallEvent, now: number): boolean;
  state(): ActivityState;
}

/** The input fields that name what a tool works on, most telling first. */
const SUBJECT_FIELDS = ["command", "file_path", "path", "notebook_path", "pattern", "url", "query"];
const READ_TOOLS = new Set(["Read", "LS"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const OUTSIDE = /^outside:[0-9a-f]+$/;
const THINKING: Action = { kind: "think", label: "thinking" };
const WRITING: Action = { kind: "think", label: "writing" };

/** What a tool call works on: a known field, else its first text field. */
export function toolSubject(input: ToolCall["input"]): string | undefined {
  const known = SUBJECT_FIELDS.map((field) => input[field]).find((value): value is string => typeof value === "string");
  return known ?? Object.values(input).find((value): value is string => typeof value === "string");
}

/**
 * A command with every path that starts at `/` or `~` left out: the runtime already wrote the
 * worktree as `.` and the home folder as `~`, so what is left points outside the worktree.
 */
export function redactPaths(command: string): string {
  // After a space, quote, `=`, `(`, `<`, `>`, `,` or `:`, or straight after a short flag (`-C/x`);
  // not the `//` of a URL.
  return command.replace(/(^|[\s"'=(<>,:]|(?:^|\s)-[A-Za-z])(?:~|\/(?!\/))[^\s"'`;|&)<>,]*/g, "$1<outside path>");
}

/** One line, no control characters, at most `MAX_ACTIVITY_LABEL_CHARS`: the end stays, since it names the file. */
export function labelText(text: string): string {
  const line = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return cutText(line, MAX_ACTIVITY_LABEL_CHARS, { keep: "tail" });
}

/** Longest pattern a search label quotes: a longer one is cut to this many characters, the `…` included. */
const MAX_PATTERN_CHARS = 40;

/** A search pattern quoted, so it reads as a pattern: `"groundY|lift"`, or `"groundY|lift|0\.0\d|spawn…"` when long. */
function quotePattern(pattern: string): string {
  const line = pattern.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  return `"${cutText(line, MAX_PATTERN_CHARS)}"`;
}

/** A tool call in words, as the activity line shows it. */
export function actionOf(call: Pick<ToolCall, "name" | "kind" | "input">): Action {
  const subject = toolSubject(call.input);
  const path = subject === undefined ? undefined : OUTSIDE.test(subject) ? "a file outside the worktree" : subject;
  const words = (kind: ActivityKind, verb: string, what: string | undefined): Action => ({ kind, label: labelText(what === undefined || what === "" ? verb : `${verb} ${what}`) });
  if (call.kind === "edit") return words("edit", "editing", path);
  if (call.kind === "command") return words("run", "running", subject === undefined ? undefined : redactPaths(subject));
  if (READ_TOOLS.has(call.name)) return words("read", "reading", path);
  if (SEARCH_TOOLS.has(call.name)) {
    // What it looks for says more than where it looks.
    const pattern = typeof call.input["pattern"] === "string" ? call.input["pattern"] : subject;
    return words("read", "searching", pattern === undefined ? undefined : quotePattern(redactPaths(pattern)));
  }
  // A connector's tool: `mcp__<server>__<tool>`.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.name);
  if (mcp) return words("other", "using", `${mcp[1]} · ${mcp[2]}`);
  return words("other", "using", call.name);
}

/** Starts at `startedAt` with the agent thinking and nothing running. */
export function createActivityTracker(startedAt: number): ActivityTracker {
  let lastAction: Action = THINKING;
  let lastEventAt = startedAt;
  // Tool calls without a result yet, in the order they started; an agent may run several at once.
  const running = new Map<string, NonNullable<ActivityState["toolRunning"]>>();

  return {
    observe(event, now) {
      switch (event.type) {
        case "rate_limit":
          return false;
        case "subagent":
          // A subagent runs inside one of the agent's tool calls: while one is open, the call is
          // alive and the agent's action stays. Without one, it is not the agent's own event.
          if (running.size === 0) return false;
          break;
        case "started":
          break;
        case "turn":
          // The agent takes a new turn only once its tools answered: none still runs. This also
          // ends a call whose result never matched its id.
          lastAction = THINKING;
          running.clear();
          break;
        case "text":
          lastAction = WRITING;
          break;
        case "tool_call":
          lastAction = actionOf(event);
          running.delete(event.id);
          running.set(event.id, { label: lastAction.label, startedAt: now });
          break;
        case "tool_result":
          running.delete(event.id);
          break;
        case "end":
          running.clear();
          break;
      }
      lastEventAt = now;
      return true;
    },
    state() {
      const open = [...running.values()].at(-1);
      return { lastAction, lastEventAt, toolRunning: open ?? null };
    },
  };
}
