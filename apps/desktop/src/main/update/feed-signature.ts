// The check that a Linux update is the one the release signed. The .deb and .rpm carry no
// publisher signature and the system installs them as root, so the feed file `latest-linux.yml` is
// signed in the release workflow with one ed25519 key (`ssh-keygen -Y sign -n tokama-update`), and
// this file checks that signature against the key built into the app before an update counts as
// ready. The signature covers the feed file; the feed file names the package's sha512; the package
// on disk must match it. No Electron here.
// eslint-disable-next-line no-restricted-imports -- these are SHA-512 digests in the formats of an SSH signature and of the update feed; none is stored, and sha256Hex does not apply.
import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import yaml from "js-yaml";

/** The public key of the Linux update signature, as an OpenSSH public key line. */
export const LINUX_UPDATE_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvm7qanBAEl2BOzCxnuDIwl+jf+6yc8mQI+5bacJ3aQ";

/** The namespace the release signs with; a signature made for another purpose never passes. */
export const SIGNATURE_NAMESPACE = "tokama-update";

/** The most that is read of the feed file and of its signature. */
export const MAX_FEED_BYTES = 64 * 1024;
export const MAX_SIGNATURE_BYTES = 4 * 1024;

export type FeedVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const fail = (reason: string): FeedVerdict => ({ ok: false, reason });

/** Reads the fields of an SSH wire blob: uint32 lengths, then bytes. */
class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error("truncated");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  uint32(): number {
    return this.take(4).readUInt32BE(0);
  }
  string(): Buffer {
    return this.take(this.uint32());
  }
  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

/** An SSH wire string. */
const wire = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

/** The 32-byte key of an `ssh-ed25519 <base64>` line, or undefined when it is anything else. */
function rawKeyOf(line: string): Buffer | undefined {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: \S.*)?$/.exec(line.trim());
  if (match?.[1] === undefined) return undefined;
  try {
    const blob = new Reader(Buffer.from(match[1], "base64"));
    if (blob.string().toString("utf8") !== "ssh-ed25519") return undefined;
    const key = blob.string();
    return blob.done() && key.length === 32 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The blob inside the armor of an SSH signature, or undefined when the armor is not exactly the one `ssh-keygen -Y sign` writes. */
function unarmor(text: string): Buffer | undefined {
  const match = /^-----BEGIN SSH SIGNATURE-----\n((?:[A-Za-z0-9+/]+={0,2}\n)+)-----END SSH SIGNATURE-----\n?$/.exec(text.replace(/\r\n/g, "\n"));
  if (match?.[1] === undefined) return undefined;
  const body = match[1].replace(/\n/g, "");
  const bytes = Buffer.from(body, "base64");
  return bytes.length > 0 && bytes.toString("base64") === body ? bytes : undefined;
}

/** Why `signature` (the armored .sig) is not a valid signature of `message` by `publicKey`, or undefined. */
function signatureProblem(message: Buffer, signature: string, publicKey: string): string | undefined {
  const raw = rawKeyOf(publicKey);
  if (raw === undefined) return "the pinned key is not an ssh-ed25519 key";
  const blob = unarmor(signature);
  if (blob === undefined) return "the signature is not a valid SSH signature";
  try {
    const reader = new Reader(blob);
    if (reader.take(6).toString("latin1") !== "SSHSIG") return "the signature has no SSHSIG magic";
    if (reader.uint32() !== 1) return "the signature is not version 1";
    const signer = reader.string();
    const namespace = reader.string().toString("utf8");
    const reserved = reader.string();
    const hashAlgorithm = reader.string().toString("utf8");
    const inner = new Reader(reader.string());
    if (!reader.done()) return "the signature has bytes after its end";
    if (!signer.equals(Buffer.concat([wire("ssh-ed25519"), wire(raw)]))) return "the signature is not by the pinned key";
    if (namespace !== SIGNATURE_NAMESPACE) return `the signature is for the namespace ${JSON.stringify(namespace)}`;
    if (reserved.length !== 0) return "the signature has a reserved field";
    if (hashAlgorithm !== "sha512") return `the signature hashes with ${JSON.stringify(hashAlgorithm)}, not sha512`;
    if (inner.string().toString("utf8") !== "ssh-ed25519") return "the signature is not an ed25519 signature";
    const value = inner.string();
    if (!inner.done() || value.length !== 64) return "the signature value is not 64 bytes";
    const signed = Buffer.concat([Buffer.from("SSHSIG", "latin1"), wire(namespace), wire(""), wire("sha512"), wire(createHash("sha512").update(message).digest())]);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, signed, key, value) ? undefined : "the signature does not match the feed file";
  } catch {
    return "the signature cannot be read";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface FeedCheck {
  /** The exact bytes of `latest-linux.yml` that were signed. */
  readonly yml: Buffer;
  /** The text of the `.sig` file. */
  readonly sig: string;
  /** The key that must have signed: an OpenSSH public key line. */
  readonly publicKey: string;
  /** Which package this app installs. */
  readonly format: "deb" | "rpm";
  /** The base64 sha512 of the package file on disk. */
  readonly downloadedSha512: string;
  /** The version the updater found for the package on disk. */
  readonly downloadedVersion: string;
  /** The file name of the package on disk (no folder). */
  readonly downloadedName: string;
}

/** What a package file name may hold: no quote, space, slash or shell character. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.(deb|rpm)$/;

/**
 * Whether the downloaded package is the one the signed feed file names. Every doubt is a no: a bad
 * or missing signature, another key, namespace or hash, a feed file of another version, no entry
 * for this package type, two entries for it, or a package whose sha512 is not the entry's. It
 * never throws.
 */
export function verifyFeed(input: FeedCheck): FeedVerdict {
  try {
    const problem = signatureProblem(input.yml, input.sig, input.publicKey);
    if (problem !== undefined) return fail(problem);
    // Only strings: the signed text is read as the plain data it is.
    const feed: unknown = yaml.load(input.yml.toString("utf8"), { schema: yaml.FAILSAFE_SCHEMA });
    if (!isRecord(feed)) return fail("the feed file is not a mapping");
    if (feed["version"] !== input.downloadedVersion) return fail("the signed feed file is for another version than the download");
    const files = feed["files"];
    if (!Array.isArray(files)) return fail("the feed file lists no files");
    const entries = files.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry["url"] === "string" && entry["url"].toLowerCase().endsWith(`.${input.format}`));
    if (entries.length !== 1) return fail(`the feed file lists ${entries.length} .${input.format} files, not 1`);
    // The updater installs the file under the name its own, unsigned, feed copy gave it, and puts that name into a root shell command: only the signed entry's plain name may stand there.
    const name = entries[0]?.["url"];
    if (typeof name !== "string" || !SAFE_FILE_NAME.test(name) || name !== input.downloadedName) return fail("the downloaded file's name is not the one the signed feed file names");
    return entries[0]?.["sha512"] === input.downloadedSha512 ? { ok: true } : fail("the download is not the file the signed feed file names");
  } catch {
    return fail("the feed file cannot be read");
  }
}

/** The base64 sha512 of a file, read in pieces in one go: the install path is synchronous. */
export function sha512OfFile(path: string): string {
  const hash = createHash("sha512");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("base64");
}

/** What `fetch` of the updater's session is used for: the URL and a way to stop. */
export type Fetcher = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Reads at most `max` bytes of a response; undefined when it is not a 200 or is larger. */
async function readCapped(response: Response, max: number): Promise<Buffer | undefined> {
  if (response.status !== 200 || response.body === null) return undefined;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > max) return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The feed file and its signature, from the feed the app was built with. `allowed` is the
 * updater's own request rule for the first address; the session the fetcher belongs to applies it
 * to redirects. Rejects with a plain message when either is missing, too large or too slow.
 */
export async function fetchFeedFiles(fetcher: Fetcher, feedUrl: string, allowed: (url: string) => boolean, timeoutMs = 30_000): Promise<{ readonly yml: Buffer; readonly sig: string }> {
  const get = async (name: string, max: number): Promise<Buffer> => {
    const url = new URL(name, feedUrl).toString();
    if (!allowed(url)) throw new Error(`${name} is not on an allowed address`);
    // A redirect is checked by the session's own request filter: the url of a session.fetch response is not reliable.
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    const bytes = await readCapped(response, max);
    if (bytes === undefined) throw new Error(`${name} is missing or too large`);
    return bytes;
  };
  const [yml, sig] = await Promise.all([get("latest-linux.yml", MAX_FEED_BYTES), get("latest-linux.yml.sig", MAX_SIGNATURE_BYTES)]);
  return { yml, sig: sig.toString("utf8") };
}
