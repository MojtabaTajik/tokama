import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../process/index.js";
import { createKeychainStore, parsePasswordLine } from "./keychain.js";
import { Secret } from "./secret.js";

// How the macOS store drives `security`, with a scripted runner, so it runs on every OS.
// store.test.ts runs the same store against a real keychain on macOS.

const VALUE = "s3cr3t-Value";
const HEX = Buffer.from(VALUE, "utf8").toString("hex");
const ref = { workspace: "northwind-prod", account: "orders-db" };

// Keychain paths the store checks exist; `security` is never run on them (the runner is scripted).
const dir = mkdtempSync(join(tmpdir(), "tokama-keychain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function keychainFile(...parts: string[]): string {
  const path = join(dir, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  return path;
}

function scripted(exitCode: number | null, stderr: readonly string[] = [], extra: Partial<RunResult> = {}) {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    run(request) {
      requests.push(request);
      stderr.forEach((line) => request.stderr?.onLine?.(line));
      return Promise.resolve({
        kind: "finished",
        pid: 1234,
        exitCode,
        signal: exitCode === null ? "SIGKILL" : null,
        timedOut: false,
        aborted: false,
        startedAt: 0,
        endedAt: 1,
        durationMs: 1,
        ...extra,
      } as RunResult);
    },
  };
  return { runner, requests };
}

describe("macOS Keychain store: talking to security", () => {
  it("passes the value on stdin as hex, never on the argv", async () => {
    const { runner, requests } = scripted(0);
    const keychain = keychainFile("k.keychain-db");
    const result = await createKeychainStore({ runner, keychain }).set(ref, new Secret(VALUE));
    expect(result.ok).toBe(true);
    const request = requests[0];
    expect(request?.command).toEqual({ argv: ["/usr/bin/security", "-i"] });
    expect(request?.stdin).toBe(
      `add-generic-password -U -s dev.tokama.northwind-prod -a orders-db -X ${HEX} ${keychain}\n`,
    );
    expect(JSON.stringify(request?.command)).not.toContain(VALUE);
    expect(JSON.stringify(request?.command)).not.toContain(HEX);
  });

  it("runs get, has and delete with argv only, under the Tokama service", async () => {
    const { runner, requests } = scripted(0, [`password: "${VALUE}"`]);
    const store = createKeychainStore({ runner });
    expect((await store.get(ref)).ok).toBe(true);
    await store.has(ref);
    await store.delete(ref);
    expect(requests.map((request) => request.command)).toEqual([
      { argv: ["/usr/bin/security", "find-generic-password", "-g", "-s", "dev.tokama.northwind-prod", "-a", "orders-db"] },
      { argv: ["/usr/bin/security", "find-generic-password", "-s", "dev.tokama.northwind-prod", "-a", "orders-db"] },
      { argv: ["/usr/bin/security", "delete-generic-password", "-s", "dev.tokama.northwind-prod", "-a", "orders-db"] },
    ]);
    expect(requests.every((request) => request.stdin === undefined && request.timeoutMs === 30_000)).toBe(true);
  });

  it("maps not found", async () => {
    const store = createKeychainStore({ runner: scripted(44).runner });
    const got = await store.get(ref);
    expect(!got.ok && got.error.code).toBe("not_found");
    expect(await store.has(ref)).toEqual({ ok: true, value: false });
    expect(await store.delete(ref)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    [36, "unavailable"],
    [50, "unavailable"],
    [51, "unavailable"],
    [128, "unavailable"],
    [152, "unavailable"],
    [1, "failed"],
    [2, "failed"],
  ])("maps exit %i to %s for every call", async (code, expected) => {
    const store = createKeychainStore({ runner: scripted(code).runner });
    for (const result of [await store.set(ref, new Secret(VALUE)), await store.get(ref), await store.has(ref), await store.delete(ref)]) {
      expect(!result.ok && result.error.code).toBe(expected);
    }
  });

  it("keeps the value out of errors even when security echoes it", async () => {
    // An over-long `security -i` line once came back as `unknown command "<hex>"`.
    const echo = [`security: unknown command "${HEX}"`, `password: "${VALUE}"`, HEX.toUpperCase(), VALUE];
    const outcomes = [
      ...[1, 36, 44].map((code) => scripted(code, echo).runner),
      scripted(null, echo).runner,
      scripted(null, echo, { timedOut: true }).runner,
    ];
    for (const runner of outcomes) {
      const store = createKeychainStore({ runner });
      for (const result of [await store.set(ref, new Secret(VALUE)), await store.get(ref), await store.has(ref), await store.delete(ref)]) {
        if (result.ok) continue;
        const text = JSON.stringify(result.error);
        for (const leaked of [VALUE, HEX, HEX.toUpperCase()]) expect(text).not.toContain(leaked);
      }
    }
  });

  it("reports a missing tool or a timeout as unavailable", async () => {
    const missing: ProcessRunner = {
      run: () => Promise.resolve({ kind: "not-started", reason: "spawn-error", message: "spawn ENOENT", code: "ENOENT" }),
    };
    const got = await createKeychainStore({ runner: missing }).get(ref);
    expect(!got.ok && got.error).toEqual({ code: "unavailable", message: "could not start /usr/bin/security (ENOENT)" });

    const timedOut = await createKeychainStore({ runner: scripted(null, [], { timedOut: true }).runner }).has(ref);
    expect(!timedOut.ok && timedOut.error.code).toBe("unavailable");
  });

  it("turns a runner rejection into a failed result", async () => {
    const broken: ProcessRunner = { run: () => Promise.reject(new Error(VALUE)) };
    const result = await createKeychainStore({ runner: broken }).set(ref, new Secret(VALUE));
    expect(!result.ok && result.error.code).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it("fails a get whose output has no password line", async () => {
    const result = await createKeychainStore({ runner: scripted(0, ["keychain: x"]).runner }).get(ref);
    expect(!result.ok && result.error.code).toBe("failed");
  });

  it("refuses a value too long for one security -i line with this keychain path", async () => {
    const { runner, requests } = scripted(0);
    const keychain = keychainFile(...Array.from({ length: 4 }, () => "k".repeat(210)), "k.keychain-db");
    const result = await createKeychainStore({ runner, keychain }).set(ref, new Secret("a".repeat(1536)));
    expect(!result.ok && result.error.code).toBe("invalid_value");
    expect(requests).toEqual([]);
  });

  it("refuses a missing keychain file, so security never falls back to the login keychain", async () => {
    const { runner, requests } = scripted(0);
    expect(() => createKeychainStore({ runner, keychain: join(dir, "missing.keychain-db") })).toThrow(TypeError);

    const keychain = keychainFile("removed.keychain-db");
    const store = createKeychainStore({ runner, keychain });
    rmSync(keychain);
    for (const result of [await store.set(ref, new Secret(VALUE)), await store.get(ref), await store.has(ref), await store.delete(ref)]) {
      expect(!result.ok && result.error.code).toBe("unavailable");
    }
    expect(requests).toEqual([]);
  });

  it("refuses a keychain path that a security -i line cannot carry", () => {
    for (const keychain of ["relative.keychain-db", "/with space/k", '/q"uote', "/back\\slash"]) {
      expect(() => createKeychainStore({ runner: scripted(0).runner, keychain })).toThrow(TypeError);
    }
  });
});

describe("parsePasswordLine", () => {
  it.each([
    ['password: "plain"', "plain"],
    ['password: "a"b"', 'a"b'],
    ['password: """"', '""'],
    ['password: "0x41"', "0x41"],
    ['password: " "', " "],
    ['password: 0x615C62  "a\\134b"', "a\\b"],
    ["password: 0xC3A9 ", "é"],
    ['password: 0x68690A7468657265  "hi\\012there"', "hi\nthere"],
  ])("reads %j", (line, expected) => {
    expect(parsePasswordLine(["keychain: \"/x\"", line])).toBe(expected);
  });

  it.each([[[]], [["password: "]], [["password: 0xABC "]], [['password: "unterminated']]])("rejects %j", (lines) => {
    expect(parsePasswordLine(lines)).toBeUndefined();
  });
});
