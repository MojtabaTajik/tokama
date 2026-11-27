import type { EngineClient } from "@tokama/client";
import { describe, expect, it, vi } from "vitest";
import { engineApi, mainQuery } from "./api.js";

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";

/** A client whose query and command mocks the tests inspect. */
function fakeClient() {
  const query = vi.fn<(request: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { items: [] } }));
  const command = vi.fn<(request: unknown) => Promise<unknown>>(async () => ({ ok: true, data: null }));
  const client = { engineId: "engine-1", query, command, events: vi.fn(), close: vi.fn() } as unknown as EngineClient;
  return { client, query, command };
}

describe("engineApi.query", () => {
  it("forwards a valid query to the client and returns its reply", async () => {
    const { client, query } = fakeClient();
    const api = engineApi(() => client);
    await expect(api.query({ type: "setup" })).resolves.toEqual({ ok: true, data: { items: [] } });
    await api.query({ type: "board" });
    expect(query.mock.calls).toEqual([[{ type: "setup" }], [{ type: "board" }]]);
  });

  it("returns the engine's error reply as it is", async () => {
    const { client, query } = fakeClient();
    query.mockResolvedValueOnce({ ok: false, error: { code: "not_found", message: "no such item" } });
    await expect(engineApi(() => client).query({ type: "item", itemId: ITEM_ID })).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "no such item" },
    });
  });

  it.each([
    ["an unknown type", { type: "drop_tables" }],
    ["a bad id", { type: "item", itemId: "../etc" }],
    ["an extra field", { type: "setup", extra: 1 }],
    ["a command", { type: "stop_item", itemId: ITEM_ID }],
    ["no object", "setup"],
    ["nothing", undefined],
  ])("refuses %s without reaching the engine", async (_what, input) => {
    const { client, query } = fakeClient();
    const reply = await engineApi(() => client).query(input);
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("not a valid query") } });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a query whose reply carries a path: only the main process asks it", async () => {
    const { client, query } = fakeClient();
    const ask = { type: "attempt_file", itemId: ITEM_ID, stepIndex: 0, attempt: 1, file: "transcript" };
    expect(await engineApi(() => client).query(ask)).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("attempt_file") } });
    expect(query).not.toHaveBeenCalled();
    await mainQuery(() => client)(ask);
    expect(query).toHaveBeenCalledWith(ask);
    expect(await mainQuery(() => client)({ type: "attempt_file", itemId: "../etc", stepIndex: 0, attempt: 1, file: 1 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("answers not_connected when there is no client", async () => {
    await expect(engineApi(() => undefined).query({ type: "setup" })).resolves.toEqual({
      ok: false,
      error: { code: "not_connected", message: "the app is not connected to the engine" },
    });
  });
});

describe("engineApi.command", () => {
  it("forwards a valid command to the client and returns its reply", async () => {
    const { client, command } = fakeClient();
    await expect(engineApi(() => client).command({ type: "stop_item", itemId: ITEM_ID })).resolves.toEqual({ ok: true, data: null });
    expect(command).toHaveBeenCalledWith({ type: "stop_item", itemId: ITEM_ID });
  });

  it("refuses an invalid command, naming the bad field, without reaching the engine", async () => {
    const { client, command } = fakeClient();
    const reply = await engineApi(() => client).command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: [], text: "   " });
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("text") } });
    expect(command).not.toHaveBeenCalled();
  });

  it("refuses a query sent as a command", async () => {
    const { client, command } = fakeClient();
    expect(await engineApi(() => client).command({ type: "setup" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(command).not.toHaveBeenCalled();
  });

  it("answers not_connected when there is no client", async () => {
    expect(await engineApi(() => undefined).command({ type: "stop_item", itemId: ITEM_ID })).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });
});

describe("engineApi.command and repo paths written with ~", () => {
  it("gives Try checks and the suggest-checks helper a full path, and leaves a full path and every other command as it is", async () => {
    const { client, command } = fakeClient();
    const api = engineApi(() => client, "/home/ada");
    await api.command({ type: "try_checks", path: "~/code/orders-api", checks: [{ command: "pnpm test" }] });
    await api.command({ type: "try_checks", path: "/srv/orders-api", checks: [{ command: "pnpm test" }] });
    await api.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "~/code/orders-api" } }, cloud: "accepted" });
    await api.command({ type: "stop_item", itemId: ITEM_ID });
    expect(command.mock.calls).toEqual([
      [{ type: "try_checks", path: "/home/ada/code/orders-api", checks: [{ command: "pnpm test" }] }],
      [{ type: "try_checks", path: "/srv/orders-api", checks: [{ command: "pnpm test" }] }],
      [{ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/home/ada/code/orders-api" } }, cloud: "accepted" }],
      [{ type: "stop_item", itemId: ITEM_ID }],
    ]);
  });
});

describe("engineApi.command and diagnostics", () => {
  it("refuses a diagnostics report from the window, which has its own narrow channel", async () => {
    const { client, command } = fakeClient();
    const reply = await engineApi(() => client).command({ type: "report_diagnostic", report: { type: "crash", source: "desktop", kind: "unclean_exit" } });
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(command).not.toHaveBeenCalled();
  });

  it("forwards the diagnostics settings and delete commands", async () => {
    const { client, command } = fakeClient();
    await engineApi(() => client).command({ type: "diagnostics_settings", collect: false });
    await engineApi(() => client).command({ type: "diagnostics_delete", all: true });
    expect(command).toHaveBeenCalledTimes(2);
  });
});
