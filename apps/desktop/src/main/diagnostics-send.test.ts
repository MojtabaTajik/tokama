import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { EngineClient } from "@tokama/client";
import { type DiagnosticEntry, DiagnosticEntrySchema, DiagnosticsBodySchema, DiagnosticsStore, diagnosticsBody, entryText, manualClock, MAX_DIAGNOSTICS_BYTES, MAX_LISTED_DIAGNOSTICS } from "@tokama/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_URL, diagnosticsService, listAll, saveToFile, SEND_TIMEOUT_MS, UPLOAD_LIMIT_BYTES } from "./diagnostics-send.js";
import { diagnosticsUrl } from "./policy.js";

const MACHINE = { os: "macos", osVersion: "15.2", distro: null, arch: "arm64", cpu: { family: "Apple M3 Pro", cores: 12 }, ramGb: "16-32", gpu: null } as const;
const id = (n: number) => `diag_00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const entry = (n: number, at = 1_000_000 + n): DiagnosticEntry =>
  DiagnosticEntrySchema.parse({
    schemaVersion: 1,
    id: id(n),
    at,
    installId: "install_00000000-0000-7000-8000-000000000001",
    sessionId: "session_00000000-0000-7000-8000-000000000002",
    appVersion: "0.1.0",
    engineVersion: "0.1.0",
    clis: [],
    machine: MACHINE,
    type: "warning",
    source: "engine",
    code: "index_rebuilt",
  });

/** A client over a list of entries, answering like the engine: newest first, `until` inclusive, at most 200. */
function fakeClient(initial: DiagnosticEntry[], options: { failDeletes?: boolean } = {}) {
  let entries = [...initial];
  const deletes: string[][] = [];
  const client = {
    query: vi.fn(async (query: { type: string; until?: number }) => {
      const matching = entries.filter((e) => query.until === undefined || e.at <= query.until).sort((a, b) => b.at - a.at);
      return { ok: true, data: { entries: matching.slice(0, MAX_LISTED_DIAGNOSTICS), truncated: matching.length > MAX_LISTED_DIAGNOSTICS } };
    }),
    command: vi.fn(async (command: { type: string; ids: string[] }) => {
      if (options.failDeletes === true) return { ok: false, error: { code: "disconnected", message: "gone" } };
      deletes.push(command.ids);
      entries = entries.filter((e) => !command.ids.includes(e.id));
      return { ok: true, data: { deleted: command.ids.length } };
    }),
  };
  return { client: client as unknown as EngineClient, deletes, add: (e: DiagnosticEntry) => entries.push(e), clear: () => (entries = []), entries: () => entries };
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server === undefined ? done() : server.close(() => done())));
  server = undefined;
});

/** A local receiver: records each unpacked body and answers `status` (null: never answers). */
async function receiver(status: number | null = 201): Promise<{ url: URL; bodies: string[] }> {
  const bodies: string[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(gunzipSync(Buffer.concat(chunks)).toString("utf8"));
      if (status === null) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status < 300 ? '{"id":"rep_1"}' : '{"error":"entries[0].code: not a known code"}');
    });
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return { url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/diagnostics`), bodies };
}

const noSave = async () => "cancelled" as const;

describe("listAll", () => {
  it("reads every entry across pages, newest first, each once", async () => {
    const { client } = fakeClient(Array.from({ length: 450 }, (_, n) => entry(n, 1000 + Math.floor(n / 3))));
    const all = await listAll(client);
    expect(all).toHaveLength(450);
    expect(new Set(all?.map((e) => e.id)).size).toBe(450);
    expect(all?.map((e) => e.at)).toEqual([...(all ?? [])].map((e) => e.at).sort((a, b) => b - a));
  });

  it("fails rather than give a short list when more than a page shares one time", async () => {
    const { client } = fakeClient([...Array.from({ length: 250 }, (_, n) => entry(n, 500)), entry(999, 400)]);
    expect(await listAll(client)).toBeUndefined();
  });
});

describe("diagnosticsService", () => {
  it("loads each entry with its text, and sends exactly those texts, gzipped, in one request", async () => {
    const fake = fakeClient([entry(1), entry(2), entry(3)]);
    const { url, bodies } = await receiver();
    const service = diagnosticsService({ client: () => fake.client, url, saveFile: noSave });
    const loaded = await service.load();
    if (!loaded.ok) throw new Error("not loaded");
    expect(loaded.items.map((item) => item.text)).toEqual(loaded.items.map((item) => entryText(item.entry)));
    expect(await service.send(loaded.items.map((item) => item.entry.id))).toEqual({ ok: true, sent: 3 });
    expect(bodies).toEqual([diagnosticsBody(loaded.items.map((item) => item.text))]);
    expect(DiagnosticsBodySchema.parse(JSON.parse(bodies[0] ?? ""))).toEqual({ entries: loaded.items.map((item) => item.entry) });
  });

  it("removes only the sent entries; one recorded during the send stays", async () => {
    const fake = fakeClient([entry(1), entry(2), entry(3)]);
    const { url } = await receiver();
    const service = diagnosticsService({ client: () => fake.client, url, saveFile: noSave });
    await service.load();
    fake.add(entry(4));
    expect(await service.send([id(1), id(3), id(4)])).toEqual({ ok: true, sent: 2 });
    expect(fake.deletes).toEqual([[id(3), id(1)]]);
    expect(fake.entries().map((e) => e.id).sort()).toEqual([id(2), id(4)]);
  });

  it("removes nothing when the receiver refuses, and names each refusal", async () => {
    for (const [status, reason] of [[400, "rejected"], [413, "too_large"], [415, "unsupported"], [429, "rate_limited"], [503, "busy_today"], [500, "server"]] as const) {
      const fake = fakeClient([entry(1), entry(2)]);
      const { url } = await receiver(status);
      const service = diagnosticsService({ client: () => fake.client, url, saveFile: noSave });
      await service.load();
      expect(await service.send([id(1), id(2)])).toEqual({ ok: false, reason, count: 2, ...(status === 400 && { detail: "entries[0].code: not a known code" }) });
      expect(fake.deletes).toEqual([]);
      server?.closeAllConnections();
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  it("times out after 30 seconds on the clock, removes nothing, and refuses a second send meanwhile", async () => {
    const fake = fakeClient([entry(1)]);
    const { url, bodies } = await receiver(null);
    const clock = manualClock(0);
    const service = diagnosticsService({ client: () => fake.client, url, saveFile: noSave, clock });
    await service.load();
    const pending = service.send([id(1)]);
    await expect.poll(() => bodies.length).toBe(1);
    expect(await service.send([id(1)])).toEqual({ ok: false, reason: "busy", count: 1 });
    clock.advance(SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: "timeout", count: 1 });
    expect(fake.deletes).toEqual([]);
  });

  it("sends a full 2 MB store as one request that stays within the limit, and deletes in chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-send-"));
    try {
      const clock = manualClock(Date.UTC(2026, 10, 25));
      const store = await DiagnosticsStore.open({ dir, engineVersion: "0.1.0", machine: MACHINE, redaction: () => ({ codeRoots: [], paths: [], repoNames: [] }), clock });
      for (let n = 0; n < 6000; n++) {
        clock.advance(1);
        store.warning("engine", "index_rebuilt");
      }
      const client = {
        query: async (query: { until?: number }) => ({ ok: true, data: store.list(query.until === undefined ? {} : { until: query.until }) }),
        command: async (command: { ids: string[] }) => ({ ok: true, data: { deleted: store.delete({ ids: command.ids as never }) } }),
      } as unknown as EngineClient;
      const { url, bodies } = await receiver();
      const service = diagnosticsService({ client: () => client, url, saveFile: noSave });
      const loaded = await service.load();
      if (!loaded.ok) throw new Error("not loaded");
      expect(loaded.items.length).toBeGreaterThan(1000);
      expect(await service.send(loaded.items.map((item) => item.entry.id))).toEqual({ ok: true, sent: loaded.items.length });
      expect(bodies).toHaveLength(1);
      expect(Buffer.byteLength(bodies[0] ?? "")).toBeLessThanOrEqual(MAX_DIAGNOSTICS_BYTES);
      expect(store.list().entries).toEqual([]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so when the receiver stored the entries but they could not be removed here", async () => {
    const fake = fakeClient([entry(1), entry(2)], { failDeletes: true });
    const { url, bodies } = await receiver();
    const service = diagnosticsService({ client: () => fake.client, url, saveFile: noSave });
    await service.load();
    expect(await service.send([id(1), id(2)])).toEqual({ ok: true, sent: 2, kept: 2 });
    expect(fake.entries()).toHaveLength(2);
    // Still shown, so a later Send all sends them again; the receiver ignores the copies.
    expect(await service.send([id(1), id(2)])).toEqual({ ok: true, sent: 2, kept: 2 });
    expect(bodies).toHaveLength(2);
  });

  it("does not send entries cleared since the page loaded", async () => {
    const fake = fakeClient([entry(1), entry(2)]);
    const post = vi.fn(async () => ({ ok: true as const, value: { id: "rep_1" } }));
    const service = diagnosticsService({ client: () => fake.client, url: DIAGNOSTICS_URL, saveFile: noSave, post });
    await service.load();
    fake.clear();
    expect(await service.send([id(1), id(2)])).toEqual({ ok: false, reason: "nothing", count: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  it("sends nowhere without a receiver, as on the sample engine without a test server", async () => {
    const fake = fakeClient([entry(1)]);
    const post = vi.fn();
    const service = diagnosticsService({ client: () => fake.client, url: undefined, saveFile: noSave, post });
    await service.load();
    expect(await service.send([id(1)])).toEqual({ ok: false, reason: "no_receiver", count: 1 });
    expect(post).not.toHaveBeenCalled();
    expect(fake.deletes).toEqual([]);
  });

  it("keeps the texts of the load started last when loads overlap", async () => {
    const fake = fakeClient([entry(1), entry(2)]);
    let release: () => void = () => undefined;
    const slowClient = { ...fake.client, query: vi.fn(async (q: never) => { await new Promise<void>((done) => (release = done)); return fake.client.query(q); }) } as unknown as EngineClient;
    let first = true;
    const post = vi.fn(async () => ({ ok: true as const, value: { id: "rep_1" } }));
    const service = diagnosticsService({ client: () => (first ? slowClient : fake.client), url: DIAGNOSTICS_URL, saveFile: noSave, post });
    const older = service.load();
    first = false;
    fake.clear();
    fake.add(entry(3));
    await service.load();
    release();
    await older;
    expect(await service.send([id(1), id(2), id(3)])).toEqual({ ok: true, sent: 1 });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ text: diagnosticsBody([entryText(entry(3))]) }));
  });

  it("takes only ids from the renderer: anything else sends nothing, and the URL is its own", async () => {
    const fake = fakeClient([entry(1)]);
    const post = vi.fn(async () => ({ ok: true as const, value: { id: "rep_1" } }));
    const service = diagnosticsService({ client: () => fake.client, url: DIAGNOSTICS_URL, saveFile: noSave, post });
    await service.load();
    for (const input of [undefined, "diag_x", { url: "https://evil.example", ids: [id(1)] }, [id(1), 5], ["not an id"], [id(77)]]) {
      expect(await service.send(input)).toMatchObject({ ok: false, reason: "nothing" });
    }
    expect(post).not.toHaveBeenCalled();
    await service.send([id(1)]);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ url: DIAGNOSTICS_URL, maxBytes: UPLOAD_LIMIT_BYTES, timeoutMs: SEND_TIMEOUT_MS }));
    expect(DIAGNOSTICS_URL.href).toBe("https://api.tokama.dev/diagnostics");
  });

  it("says when there is no engine, and when a load cannot read every entry", async () => {
    expect(await diagnosticsService({ client: () => undefined, url: DIAGNOSTICS_URL, saveFile: noSave }).load()).toEqual({ ok: false, reason: "not_connected" });
    const stuck = fakeClient(Array.from({ length: 250 }, (_, n) => entry(n, 500)));
    expect(await diagnosticsService({ client: () => stuck.client, url: DIAGNOSTICS_URL, saveFile: noSave }).load()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("saves the same text Send all would send", async () => {
    const fake = fakeClient([entry(1), entry(2)]);
    const saveFile = vi.fn(async () => "saved" as const);
    const service = diagnosticsService({ client: () => fake.client, url: DIAGNOSTICS_URL, saveFile });
    const loaded = await service.load();
    if (!loaded.ok) throw new Error("not loaded");
    expect(await service.save([id(1), id(2)])).toEqual({ ok: true });
    expect(saveFile).toHaveBeenCalledWith(diagnosticsBody(loaded.items.map((item) => item.text)));
    expect(await service.save([])).toEqual({ ok: false, reason: "nothing" });
  });
});

describe("saveToFile", () => {
  it("offers a dated JSON file and writes the text as it is", async () => {
    const write = vi.fn(async () => undefined);
    const show = vi.fn(async () => ({ canceled: false, filePath: "/tmp/out.json" }));
    expect(await saveToFile("[]", show, new Date(Date.UTC(2026, 10, 25)), write)).toBe("saved");
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "tokama-diagnostics-2026-11-25.json" }));
    expect(write).toHaveBeenCalledWith("/tmp/out.json", "[]");
    expect(await saveToFile("[]", async () => ({ canceled: true, filePath: "" }), new Date(), write)).toBe("cancelled");
    expect(await saveToFile("[]", show, new Date(), async () => Promise.reject(new Error("EACCES")))).toBe("failed");
  });
});

describe("diagnosticsUrl", () => {
  it("is the fixed URL in a packaged app, and otherwise unless a loopback test server is named", () => {
    const local = "http://127.0.0.1:4321/diagnostics";
    expect(diagnosticsUrl(local, true, DIAGNOSTICS_URL)).toBe(DIAGNOSTICS_URL);
    expect(diagnosticsUrl(undefined, false, DIAGNOSTICS_URL)).toBe(DIAGNOSTICS_URL);
    expect(diagnosticsUrl("https://evil.example/x", false, DIAGNOSTICS_URL)).toBe(DIAGNOSTICS_URL);
    expect(diagnosticsUrl("not a url", false, DIAGNOSTICS_URL)).toBe(DIAGNOSTICS_URL);
    expect(diagnosticsUrl(local, false, DIAGNOSTICS_URL)?.href).toBe(local);
    // The sample engine: no fixed URL, so only a named test server.
    expect(diagnosticsUrl(undefined, false, undefined)).toBeUndefined();
    expect(diagnosticsUrl("https://api.tokama.dev/diagnostics", false, undefined)).toBeUndefined();
    expect(diagnosticsUrl(local, false, undefined)?.href).toBe(local);
  });
});
