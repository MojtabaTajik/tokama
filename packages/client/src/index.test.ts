// Client behavior against fake engines. The full client-engine tests live in apps/engine.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("reports a protocol error when the engine does not answer the hello", async () => {
    const dir = tempDir();
    await fakeEngine(dir, "hello there\n");
    expect(await connect({ dir })).toMatchObject({ ok: false, error: { code: "protocol_error" } });
  });
});
