// Client behavior against fake engines. The full client-engine tests live in apps/engine.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION, parseClientMessage, type CommandMessageInput, type QueryMessageInput } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./index.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake engine that answers every first line with `answer`. */
async function fakeEngine(dir: string, answer: string): Promise<Server> {
  writeFileSync(join(dir, "engine.token"), "t0k");
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "engine.sock"), resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

describe("@tokama/client", () => {
  // Typed against core's built .d.ts: outbound messages take ids as plain strings, no casts.
  it("builds outbound messages from plain string ids", () => {
    const itemId: string = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    const decisionId: string = "decision_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const query: QueryMessageInput = { apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "item", itemId } };
    const command: CommandMessageInput = {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r2",
      command: { type: "resolve_decision", itemId, decisionId, choice: "approve" },
    };
    expect(parseClientMessage(query)).toEqual({ ok: true, value: query });
    expect(parseClientMessage(command)).toEqual({ ok: true, value: command });
  });

  it("parses command reply data per command type, and reports invalid_reply for the wrong shape", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "engine.token"), "t0k");
    const itemId = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    // Answers the hello, then each command: start_item with a good id, stop_item with data it must not have.
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const message = JSON.parse(line) as { kind: string; requestId?: string; command?: { type: string } };
          if (message.kind === "hello") {
            socket.write(`${JSON.stringify({ kind: "welcome", apiVersion: API_VERSION, engineId: "e1" })}\n`);
            continue;
          }
          const data = { itemId };
          socket.write(`${JSON.stringify({ apiVersion: API_VERSION, kind: "reply", requestId: message.requestId, result: { ok: true, data } })}\n`);
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(join(dir, "engine.sock"), resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const connected = await connect({ dir, reconnect: false });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    const started = await connected.value.command({ type: "start_item", workspaceId: "northwind-prod", templateId: "quick-fix", repoIds: [], text: "x" });
    // Typed per command: no cast needed to read itemId.
    expect(started.ok && started.data.itemId).toBe(itemId);
    expect(await connected.value.command({ type: "stop_item", itemId })).toMatchObject({ ok: false, error: { code: "invalid_reply" } });
  });

  it("reports not_running without a start command", async () => {
    expect(await connect({ dir: tempDir() })).toMatchObject({ ok: false, error: { code: "not_running" } });
  });

  it("refuses a relative engine dir", async () => {
    expect(await connect({ dir: "relative/run" })).toMatchObject({ ok: false, error: { code: "invalid_endpoint" } });
  });

  it("reports an engine's unsupported_version refusal", async () => {
    const dir = tempDir();
    await fakeEngine(dir, `${JSON.stringify({ kind: "connection_error", apiVersion: 7, code: "unsupported_version", message: "engine speaks 7" })}\n`);
    expect(await connect({ dir })).toEqual({ ok: false, error: { code: "unsupported_version", message: "engine speaks 7" } });
  });

  it("refuses a welcome of another API version", async () => {
    const dir = tempDir();
    await fakeEngine(dir, `${JSON.stringify({ kind: "welcome", apiVersion: API_VERSION + 1, engineId: "e1" })}\n`);
    expect(await connect({ dir })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });

  it("refuses to send the token into a dir that others can read, or a symlinked dir", async () => {
    const dir = tempDir();
    await fakeEngine(dir, `${JSON.stringify({ kind: "welcome", apiVersion: API_VERSION, engineId: "e1" })}\n`);
    symlinkSync(dir, `${dir}-link`);
    cleanups.push(() => rmSync(`${dir}-link`, { force: true }));
    expect(await connect({ dir: `${dir}-link` })).toMatchObject({ ok: false, error: { code: "unsafe_dir" } });

    chmodSync(dir, 0o755);
    expect(await connect({ dir })).toMatchObject({ ok: false, error: { code: "unsafe_dir" } });
    chmodSync(dir, 0o700);
    expect((await connect({ dir })).ok).toBe(true);
  });

  it("reports an engine that exits before it serves, with its exit code and log", async () => {
    const dir = `${tempDir()}/run`;
    const start = { command: process.execPath, args: ["-e", "process.stderr.write('engine broke'); process.exit(1)"] };
    const connected = await connect({ dir, start, startTimeoutMs: 10_000 });
    expect(connected).toMatchObject({ ok: false, error: { code: "start_failed", message: expect.stringContaining("with code 1") } });
    expect(!connected.ok && connected.error.message).toContain(`${dir}/engine.log`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(`${dir}/engine.log`).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${dir}/engine.log`, "utf8")).toContain("engine broke");
  });

  it("reports a protocol error when the engine does not answer the hello", async () => {
    const dir = tempDir();
    await fakeEngine(dir, "hello there\n");
    expect(await connect({ dir })).toMatchObject({ ok: false, error: { code: "protocol_error" } });
  });
});
