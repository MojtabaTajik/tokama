import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLogLine, projectKey, scanClaudeLogs, type LoggedUsage, type LogMark } from "./session-logs.js";

// Recorded shapes of Claude Code 2.1.332 session logs, with made-up content. Every piece of text a
// person or the model wrote carries SENTINEL, so a test can prove none of it comes out.
const FIXTURES = join(import.meta.dirname, "testing", "fixtures", "session-logs");
const SENTINEL = "SENTINEL";
const FOLDER = "-Users-someone-orders-api";
const PROJECT = projectKey(FOLDER);
const T = (iso: string) => Date.parse(iso);

let root: string;
let outside: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-claude-logs-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "tokama-claude-logs-outside-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8").split("\n").filter((line) => line !== "");
}

/** A logs folder as Claude Code lays it out: sessions, and a session's subagents two levels down. */
function layout(): string {
  const project = join(root, FOLDER);
  mkdirSync(join(project, "00000000-0000-4000-8000-00000000000a", "subagents"), { recursive: true });
  copyFileSync(join(FIXTURES, "session-a.jsonl"), join(project, "00000000-0000-4000-8000-00000000000a.jsonl"));
  copyFileSync(join(FIXTURES, "session-b.jsonl"), join(project, "00000000-0000-4000-8000-00000000000b.jsonl"));
  copyFileSync(join(FIXTURES, "subagent.jsonl"), join(project, "00000000-0000-4000-8000-00000000000a", "subagents", "agent-a0000000000000001.jsonl"));
  writeFileSync(join(project, "notes.txt"), "not a log\n");
  return project;
}

async function scan(options: { marks?: Map<string, LogMark>; since?: number; maxFiles?: number; maxFileBytes?: number; signal?: AbortSignal } = {}) {
  const marks = options.marks ?? new Map<string, LogMark>();
  const messages: LoggedUsage[] = [];
  const result = await scanClaudeLogs({
    root,
    since: options.since ?? 0,
    mark: (key) => marks.get(key),
    onFile: (key, mark, found) => {
      marks.set(key, mark);
      messages.push(...found);
    },
    ...(options.maxFiles !== undefined && { maxFiles: options.maxFiles }),
    ...(options.maxFileBytes !== undefined && { maxFileBytes: options.maxFileBytes }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  return { result, messages, marks };
}

describe("parseLogLine", () => {
  it("takes only the usage fields of assistant messages", () => {
    const parsed = lines("session-a.jsonl").map((line) => parseLogLine(line, PROJECT));
    expect(parsed).toEqual([
      {},
      {},
      { usage: { key: "req_00000000000000000000000001", at: T("2025-10-20T08:00:02.000Z"), model: "claude-opus-5-5", project: PROJECT, tokens: { input: 12, output: 5, cacheRead: 30000, cacheWrite: 2000 } } },
      // The same message again, streamed further: same key, more output.
      { usage: { key: "req_00000000000000000000000001", at: T("2025-10-20T08:00:05.000Z"), model: "claude-opus-5-5", project: PROJECT, tokens: { input: 12, output: 420, cacheRead: 30000, cacheWrite: 2000 } } },
      // A tool result that quotes the words "type":"assistant" is still a user line.
      {},
      { usage: { key: "req_00000000000000000000000002", at: T("2025-10-20T08:00:09.000Z"), model: "claude-sonnet-5-5", project: PROJECT, tokens: { input: 3, output: 80, cacheRead: 32000, cacheWrite: 0 } } },
      // A placeholder message that used no tokens.
      {},
      // Token counts that are not counts, and a torn line.
      { bad: true },
      { bad: true },
      {},
    ]);
  });

  it("keys a message without a request id by its message id, and counts missing cache fields as 0", () => {
    expect(parseLogLine(lines("session-b.jsonl")[1] ?? "", PROJECT).usage).toEqual({
      key: "msg_00000000000000000000000004",
      at: T("2025-10-19T22:30:00.000Z"),
      model: "claude-haiku-5-5",
      project: PROJECT,
      tokens: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("never returns message text, thinking, tool inputs, tool outputs or paths", () => {
    const out = JSON.stringify(["session-a.jsonl", "session-b.jsonl", "subagent.jsonl"].flatMap(lines).map((line) => parseLogLine(line, PROJECT)));
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain("/Users/someone");
    expect(out).not.toContain("toolu_");
  });

  it("refuses a time, model or id it cannot use", () => {
    const line = (fields: object) => JSON.stringify({ type: "assistant", requestId: "req_1", timestamp: "2025-10-20T08:00:00Z", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } }, ...fields });
    expect(parseLogLine(line({}), PROJECT).usage?.key).toBe("req_1");
    expect(parseLogLine(line({ timestamp: "yesterday" }), PROJECT)).toEqual({ bad: true });
    expect(parseLogLine(line({ requestId: "r".repeat(201), message: { model: "claude-opus-5-5", usage: { input_tokens: 1 } } }), PROJECT)).toEqual({ bad: true });
    expect(parseLogLine(line({ message: { id: "msg_1", usage: { input_tokens: 1 } } }), PROJECT)).toEqual({ bad: true });
    expect(parseLogLine(line({ message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: -1 } } }), PROJECT)).toEqual({ bad: true });
    expect(parseLogLine("[1,2]", PROJECT)).toEqual({});
  });
});

describe("scanClaudeLogs", () => {
  it("reads every session and subagent log once, and skips links, other files and lines it cannot use", async () => {
    const project = layout();
    // A project folder that links to another one is not followed: it would count the logs twice.
    symlinkSync(project, join(root, "-Users-someone-orders-api-link"));
    // A log that links out of the folder is refused.
    writeFileSync(join(outside, "elsewhere.jsonl"), lines("session-b.jsonl")[1] ?? "");
    symlinkSync(join(outside, "elsewhere.jsonl"), join(project, "elsewhere.jsonl"));
    // A huge line, then a good one.
    appendFileSync(join(project, "00000000-0000-4000-8000-00000000000b.jsonl"), `{"type":"assistant","usage":"${"x".repeat(17 * 1024 * 1024)}"}\n${lines("subagent.jsonl")[0]?.replace("req_00000000000000000000000005", "req_after_huge")}\n`);

    const { result, messages } = await scan();
    expect(result).toMatchObject({ found: true, complete: true, files: 4, skippedFiles: 1, skippedLines: 3 });
    expect(result.fileKeys).toHaveLength(4);
    expect(messages.map((m) => m.key).sort()).toEqual([
      "msg_00000000000000000000000004",
      "req_00000000000000000000000001",
      "req_00000000000000000000000001",
      "req_00000000000000000000000002",
      "req_00000000000000000000000002",
      "req_00000000000000000000000005",
      "req_after_huge",
    ]);
    expect(JSON.stringify({ messages, result })).not.toContain(SENTINEL);
  });

  it("reads only the new lines on the next scan, and a line still being written once it ends", async () => {
    const project = layout();
    const first = await scan();
    expect(first.messages).toHaveLength(6);
    const file = join(project, "00000000-0000-4000-8000-00000000000b.jsonl");
    const extra = lines("subagent.jsonl")[0]?.replace("req_00000000000000000000000005", "req_new") ?? "";
    appendFileSync(file, extra.slice(0, 100));
    const second = await scan({ marks: first.marks });
    expect(second.messages).toEqual([]);
    appendFileSync(file, `${extra.slice(100)}\n`);
    const third = await scan({ marks: second.marks });
    expect(third.messages.map((m) => m.key)).toEqual(["req_new"]);
  });

  it("skips messages before `since`, files over the size cap, and files past the count cap", async () => {
    layout();
    expect((await scan({ since: T("2025-10-20T00:00:00.000Z") })).messages.map((m) => m.key)).not.toContain("msg_00000000000000000000000004");
    expect((await scan({ maxFileBytes: 2000 })).result.skippedFiles).toBe(1);
    expect((await scan({ maxFiles: 1 })).result).toMatchObject({ files: 1, skippedFiles: 2 });
  });

  it("says when there is no logs folder, and when it stopped early", async () => {
    rmSync(root, { recursive: true });
    expect((await scan()).result).toMatchObject({ found: false, files: 0 });
    mkdirSync(root);
    layout();
    const stop = new AbortController();
    stop.abort();
    expect((await scan({ signal: stop.signal })).result).toMatchObject({ found: true, complete: false });
  });
});

describe("projectKey", () => {
  // Known vector: the first 32 hex characters of SHA-256 over `project:<folder>`. Stored usage rows
  // carry this key, so the format must not change.
  it("is the first 32 hex characters of the SHA-256 of project:<folder>", () => {
    expect(projectKey("-Users-someone-orders-api")).toBe("f6a33fff512831c2f382b2b3ab080335");
  });
});
