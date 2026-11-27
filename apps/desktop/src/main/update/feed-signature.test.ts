// Every key in these tests is made at run time, in a temporary folder or in memory: no private key is in the repo.
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FeedCheck, fetchFeedFiles, type Fetcher, LINUX_UPDATE_PUBLIC_KEY, MAX_FEED_BYTES, SIGNATURE_NAMESPACE, sha512OfFile, sha512OfFileStream, verifyFeed } from "./feed-signature.js";

const DEB = Buffer.from("the deb bytes");
const RPM = Buffer.from("the rpm bytes");
const sha512 = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");

const feedText = (version = "0.2.0", extra = "") => `version: ${version}
files:
  - url: Tokama-${version}-amd64.deb
    sha512: ${sha512(DEB)}
    size: ${DEB.length}
  - url: Tokama-${version}-x86_64.rpm
    sha512: ${sha512(RPM)}
    size: ${RPM.length}
${extra}path: Tokama-${version}-amd64.deb
sha512: ${sha512(DEB)}
releaseDate: '2026-11-27T10:00:00.000Z'
`;

// ---- The SSH signature format, written by hand: this is what the negative tests bend ----

const wire = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

interface TestKey {
  readonly privateKey: KeyObject;
  readonly raw: Buffer;
  readonly line: string;
}

function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return { privateKey, raw, line: `ssh-ed25519 ${Buffer.concat([wire("ssh-ed25519"), wire(raw)]).toString("base64")} test` };
}

interface Craft {
  readonly key: TestKey;
  /** The key the signature claims; defaults to the signing key. */
  readonly claims?: TestKey;
  readonly namespace?: string;
  readonly hash?: "sha512" | "sha256";
  readonly magic?: string;
  readonly version?: number;
  readonly reserved?: string;
  readonly trailing?: Buffer;
}

function craft(message: Buffer, options: Craft): string {
  const namespace = options.namespace ?? SIGNATURE_NAMESPACE;
  const hash = options.hash ?? "sha512";
  const reserved = options.reserved ?? "";
  const digest = createHash(hash).update(message).digest();
  const signed = Buffer.concat([Buffer.from("SSHSIG"), wire(namespace), wire(reserved), wire(hash), wire(digest)]);
  const value = sign(null, signed, options.key.privateKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(options.version ?? 1);
  const claimed = options.claims ?? options.key;
  const blob = Buffer.concat([
    Buffer.from(options.magic ?? "SSHSIG"),
    version,
    wire(Buffer.concat([wire("ssh-ed25519"), wire(claimed.raw)])),
    wire(namespace),
    wire(reserved),
    wire(hash),
    wire(Buffer.concat([wire("ssh-ed25519"), wire(value)])),
    options.trailing ?? Buffer.alloc(0),
  ]);
  return armor(blob);
}

const armor = (blob: Buffer) => `-----BEGIN SSH SIGNATURE-----\n${(blob.toString("base64").match(/.{1,70}/g) ?? []).join("\n")}\n-----END SSH SIGNATURE-----\n`;

// ---- A real `ssh-keygen -Y sign`, which is what the release workflow runs ----

let dir: string;
let real: { readonly line: string; readonly yml: Buffer; readonly sig: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tk-feed-sig-"));
  const keyFile = join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
  const ymlFile = join(dir, "latest-linux.yml");
  writeFileSync(ymlFile, feedText());
  execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyFile, "-n", SIGNATURE_NAMESPACE, ymlFile], { stdio: "ignore" });
  real = { line: readFileSync(`${keyFile}.pub`, "utf8").trim(), yml: readFileSync(ymlFile), sig: readFileSync(`${ymlFile}.sig`, "utf8") };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const check = (over: Partial<FeedCheck> = {}): FeedCheck => ({
  yml: real.yml,
  sig: real.sig,
  publicKey: real.line,
  format: "deb",
  downloadedSha512: sha512(DEB),
  downloadedVersion: "0.2.0",
  downloadedName: "Tokama-0.2.0-amd64.deb",
  ...over,
});

const refused = (input: FeedCheck, reason: RegExp) => {
  const verdict = verifyFeed(input);
  expect(verdict.ok).toBe(false);
  expect(verdict.ok === false && verdict.reason).toMatch(reason);
};

describe("the pinned key", () => {
  it("is the key line of packaging/linux-update.pub", () => {
    expect(readFileSync(join(import.meta.dirname, "../../../packaging/linux-update.pub"), "utf8").trim()).toBe(LINUX_UPDATE_PUBLIC_KEY);
  });
});

describe("verifyFeed", () => {
  it("accepts what `ssh-keygen -Y sign` signed, for the .deb and for the .rpm", () => {
    expect(verifyFeed(check())).toEqual({ ok: true });
    expect(verifyFeed(check({ format: "rpm", downloadedSha512: sha512(RPM), downloadedName: "Tokama-0.2.0-x86_64.rpm" }))).toEqual({ ok: true });
  });

  it("refuses a download saved under a name the signed feed does not give it, such as one with a quote that would break out of the installer's root shell command", () => {
    for (const downloadedName of ["x';touch pwned;'.deb", "Tokama-0.2.0-amd64.deb ", "other.deb", "../Tokama-0.2.0-amd64.deb", "Tokama-0.2.0-x86_64.rpm"]) {
      refused(check({ downloadedName }), /name is not the one/);
    }
  });

  it("refuses a signed entry whose own name has a shell character", () => {
    const key = testKey();
    const name = "x';touch pwned;'.deb";
    const text = `version: 0.2.0\nfiles:\n  - url: "${name}"\n    sha512: ${sha512(DEB)}\n`;
    refused(check({ yml: Buffer.from(text), sig: craft(Buffer.from(text), { key }), publicKey: key.line, downloadedName: name }), /name is not the one/);
  });

  it("accepts a signature of the same layout made in memory, so the tests below bend a true copy", () => {
    const key = testKey();
    const yml = Buffer.from(feedText());
    expect(verifyFeed(check({ yml, sig: craft(yml, { key }), publicKey: key.line }))).toEqual({ ok: true });
  });

  it("refuses a signature by another key, whatever key it claims", () => {
    const other = testKey();
    const pinned = testKey();
    const yml = Buffer.from(feedText());
    refused(check({ yml, sig: craft(yml, { key: other }), publicKey: pinned.line }), /not by the pinned key/);
    // It names the pinned key but was made with another: the signature itself does not hold.
    refused(check({ yml, sig: craft(yml, { key: other, claims: pinned }), publicKey: pinned.line }), /does not match/);
  });

  it("refuses a feed file with one changed byte, and a signature with one changed byte", () => {
    const yml = Buffer.from(real.yml);
    yml[yml.length - 3] = (yml[yml.length - 3] ?? 0) ^ 1;
    refused(check({ yml }), /does not match/);
    const blob = Buffer.from(real.sig.split("\n").slice(1, -2).join(""), "base64");
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    refused(check({ sig: armor(blob) }), /does not match/);
  });

  it("refuses an older signed feed file replayed for a newer download", () => {
    const key = testKey();
    const old = Buffer.from(feedText("0.1.0"));
    refused(check({ yml: old, sig: craft(old, { key }), publicKey: key.line }), /another version/);
  });

  it("refuses a download whose sha512 is not the one the feed names", () => {
    refused(check({ downloadedSha512: sha512(Buffer.from("tampered")) }), /not the file/);
    refused(check({ format: "rpm", downloadedSha512: sha512(DEB), downloadedName: "Tokama-0.2.0-x86_64.rpm" }), /not the file/);
  });

  it("refuses a missing, empty or truncated signature", () => {
    refused(check({ sig: "" }), /not a valid SSH signature/);
    refused(check({ sig: real.sig.slice(0, 60) }), /not a valid SSH signature/);
    refused(check({ sig: real.sig.replace("-----END SSH SIGNATURE-----", "") }), /not a valid SSH signature/);
    refused(check({ sig: real.sig.replace("-----BEGIN SSH SIGNATURE-----", "-----BEGIN SIGNATURE-----") }), /not a valid SSH signature/);
    refused(check({ sig: `${real.sig}trailing\n` }), /not a valid SSH signature/);
  });

  it("refuses broken armor", () => {
    refused(check({ sig: "-----BEGIN SSH SIGNATURE-----\n!!!!\n-----END SSH SIGNATURE-----\n" }), /not a valid SSH signature/);
    refused(check({ sig: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n" }), /cannot be read|SSHSIG/);
  });

  it("refuses a signature made for another namespace", () => {
    const keyFile = join(dir, "key");
    const ymlFile = join(dir, "other.yml");
    writeFileSync(ymlFile, real.yml);
    execFileSync("ssh-keygen", ["-Y", "sign", "-f", keyFile, "-n", "file", ymlFile], { stdio: "ignore" });
    refused(check({ sig: readFileSync(`${ymlFile}.sig`, "utf8") }), /namespace "file"/);
  });

  it("refuses a signature that hashes with sha256", () => {
    const key = testKey();
    const yml = Buffer.from(feedText());
    refused(check({ yml, sig: craft(yml, { key, hash: "sha256" }), publicKey: key.line }), /sha256/);
  });

  it("refuses a signature with another magic, version, a reserved field or bytes after the end", () => {
    const key = testKey();
    const yml = Buffer.from(feedText());
    const base = { yml, publicKey: key.line };
    refused(check({ ...base, sig: craft(yml, { key, magic: "SSHSIX" }) }), /SSHSIG magic/);
    refused(check({ ...base, sig: craft(yml, { key, version: 2 }) }), /version 1/);
    refused(check({ ...base, sig: craft(yml, { key, reserved: "x" }) }), /reserved/);
    refused(check({ ...base, sig: craft(yml, { key, trailing: Buffer.from("x") }) }), /cannot be read|after its end/);
  });

  it("refuses when the pinned key is not an ssh-ed25519 key", () => {
    refused(check({ publicKey: "ssh-rsa AAAA" }), /not an ssh-ed25519 key/);
    refused(check({ publicKey: "" }), /not an ssh-ed25519 key/);
  });

  it("refuses a signed feed file that names the package twice, not at all, or does not list files", () => {
    const key = testKey();
    const signed = (text: string) => ({ yml: Buffer.from(text), sig: craft(Buffer.from(text), { key }), publicKey: key.line });
    // Both .deb entries name the download's own sha512: two entries are still not one.
    refused(check(signed(feedText("0.2.0", `  - url: Tokama-0.2.0-other.deb\n    sha512: ${sha512(DEB)}\n`))), /2 \.deb files/);
    refused(check(signed(feedText().replaceAll(".deb", ".AppImage"))), /0 \.deb files/);
    refused(check(signed("version: 0.2.0\npath: x\n")), /lists no files/);
    refused(check(signed("- just\n- a list\n")), /not a mapping/);
    refused(check(signed("version: 0.2.0\nfiles: nope\n")), /lists no files/);
  });

  it("reads a signed feed file as plain data: a YAML tag does not run or build anything", () => {
    const key = testKey();
    const text = `version: 0.2.0\nfiles: !!js/function "function () { throw 1 }"\n`;
    const verdict = verifyFeed(check({ yml: Buffer.from(text), sig: craft(Buffer.from(text), { key }), publicKey: key.line }));
    expect(verdict.ok).toBe(false);
  });

  it("never throws", () => {
    expect(() => verifyFeed(check({ yml: Buffer.from([0xff, 0xfe]), sig: "x" }))).not.toThrow();
  });
});

describe("sha512OfFile", () => {
  it("is the base64 sha512 of the whole file, across the read size", () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    const file = join(dir, "big.bin");
    writeFileSync(file, big);
    expect(sha512OfFile(file)).toBe(sha512(big));
  });

  it("is the same digest when read as a stream, and fails for a missing file", async () => {
    const file = join(dir, "big2.bin");
    const big = Buffer.alloc(3 * 1024 * 1024 + 5, 9);
    writeFileSync(file, big);
    expect(await sha512OfFileStream(file)).toBe(sha512(big));
    await expect(sha512OfFileStream(join(dir, "missing.bin"))).rejects.toThrow();
  });
});

describe("fetchFeedFiles", () => {
  const FEED = "https://updates.tokama.dev/linux/";
  const allowAll = () => true;
  const answer = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
  const serving = (files: Record<string, Response | undefined>, asked: string[] = []): Fetcher => async (url) => {
    asked.push(url);
    const response = files[new URL(url).pathname.split("/").pop() ?? ""];
    return response ?? new Response("not found", { status: 404 });
  };

  it("fetches the feed file and its signature from the feed address", async () => {
    const asked: string[] = [];
    const files = await fetchFeedFiles(serving({ "latest-linux.yml": answer("yml"), "latest-linux.yml.sig": answer("sig") }, asked), FEED, allowAll);
    expect(files.yml.toString()).toBe("yml");
    expect(files.sig).toBe("sig");
    expect(asked.map((url) => url.replace(/\?noCache=[a-z0-9]+$/, "")).sort()).toEqual([`${FEED}latest-linux.yml`, `${FEED}latest-linux.yml.sig`]);
    expect(asked.every((url) => /\?noCache=[a-z0-9]+$/.test(url))).toBe(true);
  });

  it("fails when the signature is missing (404) or the feed file is", async () => {
    await expect(fetchFeedFiles(serving({ "latest-linux.yml": answer("yml") }), FEED, allowAll)).rejects.toThrow(/latest-linux\.yml\.sig is missing/);
    await expect(fetchFeedFiles(serving({ "latest-linux.yml.sig": answer("sig") }), FEED, allowAll)).rejects.toThrow(/latest-linux\.yml is missing/);
  });

  it("fails on a response that is not a plain 200", async () => {
    await expect(fetchFeedFiles(serving({ "latest-linux.yml": answer("yml", { status: 206 }), "latest-linux.yml.sig": answer("sig") }), FEED, allowAll)).rejects.toThrow(/missing or too large/);
  });

  it("fails on a feed file that is too large, by its header and by its bytes", async () => {
    const big = "x".repeat(MAX_FEED_BYTES + 1);
    await expect(fetchFeedFiles(serving({ "latest-linux.yml": answer(big), "latest-linux.yml.sig": answer("sig") }), FEED, allowAll)).rejects.toThrow(/too large/);
    await expect(fetchFeedFiles(serving({ "latest-linux.yml": answer("yml", { headers: { "content-length": String(MAX_FEED_BYTES + 1) } }), "latest-linux.yml.sig": answer("sig") }), FEED, allowAll)).rejects.toThrow(/too large/);
    await expect(fetchFeedFiles(serving({ "latest-linux.yml": answer("yml"), "latest-linux.yml.sig": answer("x".repeat(5000)) }), FEED, allowAll)).rejects.toThrow(/too large/);
  });

  it("asks nothing of an address the updater would not use", async () => {
    const asked: string[] = [];
    await expect(fetchFeedFiles(serving({}, asked), "http://example.test/linux/", (url) => url.startsWith("https:"))).rejects.toThrow(/not on an allowed address/);
    expect(asked).toEqual([]);
  });

  it("gives up on a feed that does not answer", async () => {
    const hang: Fetcher = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchFeedFiles(hang, FEED, allowAll, 20)).rejects.toThrow();
  });
});
