import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../clock/index.js";
import { postGzipJson } from "./post.js";

interface Received {
  readonly method: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server === undefined ? done() : server.close(() => done())));
  server = undefined;
});

/** A local server that records each request and answers with `reply`; `reply` returning undefined never answers. */
async function serve(reply: () => { status: number; body?: string; headers?: Record<string, string> } | undefined): Promise<{ url: URL; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
      const answer = reply();
      if (answer === undefined) return;
      response.writeHead(answer.status, answer.headers ?? { "content-type": "application/json" });
      response.end(answer.body ?? "");
    });
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: new URL(`http://127.0.0.1:${port}/diagnostics`), received };
}

const TEXT = '[\n{\n  "id": "diag_1",\n  "note": "naïve – ✓"\n}\n]\n';
const post = (url: URL, extra: Partial<Parameters<typeof postGzipJson>[0]> = {}) => postGzipJson({ url, text: TEXT, maxBytes: 2 * 1024 * 1024, timeoutMs: 30_000, ...extra });

describe("postGzipJson", () => {
  it("posts the text gzipped, byte for byte, with only the fixed headers", async () => {
    const { url, received } = await serve(() => ({ status: 201, body: '{"id":"rep_42"}' }));
    expect(await post(url)).toEqual({ ok: true, value: { id: "rep_42" } });
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.method).toBe("POST");
    expect(gunzipSync(request?.body ?? Buffer.alloc(0)).toString("utf8")).toBe(TEXT);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["content-encoding"]).toBe("gzip");
    // What fetch itself sends, and nothing that names the user, the machine or the app.
    expect(Object.keys(request?.headers ?? {}).sort()).toEqual(["accept", "accept-encoding", "accept-language", "connection", "content-encoding", "content-length", "content-type", "host", "sec-fetch-mode", "user-agent"]);
    expect(request?.headers["cookie"]).toBeUndefined();
    expect(request?.headers["authorization"]).toBeUndefined();
  });

  it("counts only a 2xx reply with a report id as success", async () => {
    for (const body of ["", "{}", '{"id":42}', '{"id":"has space"}', "not json", JSON.stringify({ id: "x".repeat(5000) })]) {
      const { url } = await serve(() => ({ status: 201, body }));
      expect(await post(url), body).toEqual({ ok: false, error: { kind: "bad_reply" } });
      server?.closeAllConnections();
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
  });

  it("gives the status of any other answer, a redirect included, and never follows it", async () => {
    for (const status of [400, 413, 415, 429, 500]) {
      const { url } = await serve(() => ({ status, body: "server text" }));
      expect(await post(url)).toEqual({ ok: false, error: { kind: "status", status } });
      server?.closeAllConnections();
      await new Promise<void>((done) => server?.close(() => done()));
      server = undefined;
    }
    const { url, received } = await serve(() => ({ status: 307, headers: { location: "https://elsewhere.example/diagnostics" } }));
    expect(await post(url)).toEqual({ ok: false, error: { kind: "status", status: 307 } });
    expect(received).toHaveLength(1);
  });

  it("times out after the given time, on the injected clock", async () => {
    const { url, received } = await serve(() => undefined);
    const clock = manualClock(0);
    const pending = post(url, { clock });
    await expect.poll(() => received.length).toBe(1);
    clock.advance(29_999);
    clock.advance(1);
    expect(await pending).toEqual({ ok: false, error: { kind: "timeout" } });
  });

  it("names the network failure when nothing answers", async () => {
    const { url } = await serve(() => ({ status: 201 }));
    server?.closeAllConnections();
    await new Promise<void>((done) => server?.close(() => done()));
    server = undefined;
    expect(await post(url)).toEqual({ ok: false, error: { kind: "network", code: "ECONNREFUSED" } });
  });

  it("sends nothing for a text over the limit, a non-HTTPS URL or a URL with credentials", async () => {
    const calls: unknown[] = [];
    const fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error("no"));
    }) as typeof globalThis.fetch;
    const https = new URL("https://api.example/diagnostics");
    expect(await post(https, { maxBytes: Buffer.byteLength(TEXT) - 1, fetch })).toEqual({ ok: false, error: { kind: "too_large" } });
    for (const url of ["http://api.example/diagnostics", "ftp://127.0.0.1/x", "https://user:pw@api.example/diagnostics", "http://127.0.0.2/diagnostics"]) {
      expect(await post(new URL(url), { fetch }), url).toEqual({ ok: false, error: { kind: "not_allowed" } });
    }
    expect(calls).toEqual([]);
    // The limit counts bytes, not characters.
    expect(Buffer.byteLength(TEXT)).toBeGreaterThan(TEXT.length);
  });
});
