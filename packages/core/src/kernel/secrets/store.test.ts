import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProcessRunner } from "../process/index.js";
import type { Result } from "../result/index.js";
import {
  MAX_SECRET_BYTES,
  Secret,
  createKeychainStore,
  createMemorySecretStore,
  createSecretStore,
  type SecretError,
  type SecretRef,
  type SecretStore,
} from "./index.js";

// The contract every SecretStore meets. It runs against the in-memory store everywhere and against
// the macOS Keychain store on macOS, in a throwaway keychain the suite creates and deletes, so it
// never touches the login keychain and works on a CI machine without one.

const VALUES = [
  "plain-password",
  "pässwörd 🔑",
  "line one\nline two",
  'quote " and back\\slash',
  "68690a7468657265", // looks like hex; must not be decoded
  "0x41",
  "  padded  ",
  "a".repeat(MAX_SECRET_BYTES),
  "é".repeat(MAX_SECRET_BYTES / 2), // at the limit, and printed as hex by the Keychain
];

function value<T>(result: Result<T, SecretError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function error(result: Result<unknown, SecretError>): SecretError {
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

function contract(makeStore: () => SecretStore) {
  let store: SecretStore;
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string): SecretRef => ({ connectionId: `${name}-${suffix}` });
  const ref = id("postgres-prod");
  beforeAll(() => {
    store = makeStore();
  });
  afterAll(async () => {
    for (const name of ["postgres-prod", "other", "too-long"]) await store.delete(id(name));
  });

  it("reports a missing secret", async () => {
    expect(value(await store.has(ref))).toBe(false);
    expect(error(await store.get(ref)).code).toBe("not_found");
    expect(value(await store.delete(ref))).toBeUndefined();
  });

  it.each(VALUES.map((text) => [text.length > 40 ? `${text.slice(0, 20)}... (${text.length})` : text, text]))(
    "round-trips %j",
    async (_label, text) => {
      value(await store.set(ref, new Secret(text)));
      expect(value(await store.has(ref))).toBe(true);
      expect(value(await store.get(ref)).reveal()).toBe(text);
    },
  );

  it("replaces, isolates and deletes", async () => {
    value(await store.set(ref, new Secret("first")));
    value(await store.set(ref, new Secret("second")));
    value(await store.set(id("other"), new Secret("other-value")));
    expect(value(await store.get(ref)).reveal()).toBe("second");
    expect(value(await store.get(id("other"))).reveal()).toBe("other-value");

    value(await store.delete(ref));
    expect(value(await store.has(ref))).toBe(false);
    expect(value(await store.has(id("other")))).toBe(true);
  });

  it.each([
    { connectionId: "Has Space" },
    { connectionId: "UPPER" },
    { connectionId: "" },
    { connectionId: "two words" },
    { connectionId: '"quoted"' },
    { connectionId: "-starts-with-dash" },
    { connectionId: "x".repeat(65) },
  ])("refuses the ref %j", async (bad) => {
    expect(error(await store.set(bad, new Secret("v"))).code).toBe("invalid_ref");
    expect(error(await store.get(bad)).code).toBe("invalid_ref");
    expect(error(await store.has(bad)).code).toBe("invalid_ref");
    expect(error(await store.delete(bad)).code).toBe("invalid_ref");
  });

  it("refuses an empty or oversized value and stores nothing", async () => {
    const tooLong = id("too-long");
    expect(error(await store.set(tooLong, new Secret(""))).code).toBe("invalid_value");
    const big = "Zq".repeat(MAX_SECRET_BYTES / 2) + "!";
    const failure = error(await store.set(tooLong, new Secret(big)));
    expect(failure.code).toBe("invalid_value");
    expect(failure.message).not.toContain("Zq");
    expect(value(await store.has(tooLong))).toBe(false);
  });
}

describe("memory secret store", () => {
  contract(createMemorySecretStore);
});

describe.runIf(process.platform === "darwin")("macOS Keychain secret store", { timeout: 20_000 }, () => {
  const runner = createProcessRunner();
  let dir: string;
  let keychain: string;
  const security = async (...args: string[]) => {
    const result = await runner.run({ command: { argv: ["/usr/bin/security", ...args] }, cwd: dir, timeoutMs: 15_000 });
    if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`security ${args[0]} failed`);
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tokama-secrets-"));
    keychain = join(dir, "test.keychain-db");
    // A test-only keychain password; create-keychain does not add the keychain to the search list.
    await security("create-keychain", "-p", "tokama-test", keychain);
    await security("unlock-keychain", "-p", "tokama-test", keychain);
    await security("set-keychain-settings", keychain); // no auto-lock during the run
  });
  afterAll(async () => {
    await security("delete-keychain", keychain).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  contract(() => createKeychainStore({ runner, keychain }));
});

describe("createSecretStore", () => {
  it.each(["linux", "win32"] as const)("returns unsupported_platform on %s", async (platform) => {
    const store = createSecretStore({ platform });
    const ref = { connectionId: "a" };
    for (const result of [await store.set(ref, new Secret("v")), await store.get(ref), await store.has(ref), await store.delete(ref)]) {
      expect(error(result).code).toBe("unsupported_platform");
    }
  });
});
