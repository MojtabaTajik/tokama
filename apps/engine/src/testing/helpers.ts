// Test helpers for the engine tests. Not part of the engine's entry.
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ItemRecord, LineDecoder, parseItemRecord } from "@tokama/core";

/** A short temp dir (macOS socket paths are limited to 103 bytes). Returns the engine dir inside it. */
export function tempEngineDir(cleanups: (() => unknown)[]): string {
  const root = mkdtempSync(join(tmpdir(), "tk-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "run");
}

export function sampleItem(title = "Checkout latency spike"): ItemRecord {
  const parsed = parseItemRecord({
    schemaVersion: 1,
    id: "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c",
    kind: "investigation",
    templateId: "emergency-investigator",
    title,
    text: "Alert: checkout p95 above 1.5 s",
    repoIds: [],
    privacy: "local_only",
    state: "running",
    createdAt: 1_760_000_000_000,
    steps: [{ name: "Triage", stage: "working", state: "running", agentId: "local-investigator", data: "none" }],
  });
  if (!parsed.ok) throw new Error("bad sample item");
  return parsed.value;
}

/** A raw socket that speaks the line protocol without the client, for protocol-level tests. */
export interface RawConnection {
  send(message: unknown): void;
  write(data: string | Buffer): void;
  /** The next message from the engine, parsed. Rejects if the connection closes first. */
  next(): Promise<unknown>;
  readonly closed: Promise<void>;
  destroy(): void;
}

/** `allowHalfOpen`: keep the connection open after the engine ends it, as a stuck client would. */
export function rawConnect(socketPath: string, options: { allowHalfOpen?: boolean } = {}): Promise<RawConnection> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ path: socketPath, allowHalfOpen: options.allowHalfOpen ?? false });
    const decoder = new LineDecoder(64 * 1024 * 1024);
    const received: unknown[] = [];
    const waiting: { resolve: (message: unknown) => void; reject: (error: Error) => void }[] = [];
    let ended = false;
    const closed = new Promise<void>((resolveClosed) =>
      socket.on("close", () => {
        ended = true;
        for (const waiter of waiting.splice(0)) waiter.reject(new Error("connection closed"));
        resolveClosed();
      }),
    );
    socket.on("data", (chunk: Buffer) => {
      const lines = decoder.push(chunk);
      if (!lines.ok) throw new Error("test decoder overflow");
      for (const line of lines.value) {
        const message: unknown = JSON.parse(line);
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(message);
        else received.push(message);
      }
    });
    // EPIPE or ECONNRESET when the engine closes on us; the close handler reports it.
    socket.on("error", () => {});
    socket.once("connect", () =>
      resolve({
        send: (message) => socket.write(`${JSON.stringify(message)}\n`),
        write: (data) => socket.write(data),
        next: () => {
          if (received.length > 0) return Promise.resolve(received.shift());
          if (ended) return Promise.reject(new Error("connection closed"));
          return new Promise((resolveNext, rejectNext) => waiting.push({ resolve: resolveNext, reject: rejectNext }));
        },
        closed,
        destroy: () => socket.destroy(),
      }),
    );
    socket.once("error", reject);
  });
}

/** Polls until `check` returns true or the deadline passes. */
export async function waitFor(check: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
