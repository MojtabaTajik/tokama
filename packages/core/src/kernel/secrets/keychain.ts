import { createProcessRunner, type ProcessRunner } from "../process/index.js";
import { err, ok, type Result } from "../result/index.js";
import { Secret } from "./secret.js";
import { checkValue, storeName, type SecretError, type SecretStore } from "./store.js";

// macOS Keychain through the built-in `security` tool, run by the kernel process runner with argv
// only. The value never goes on an argv (every local user can read argvs with `ps`):
// - set runs `security -i` and writes `add-generic-password -U ... -X <hex>` to its stdin, one
//   command per process. Hex needs no quoting and carries any byte. `-w` as the last option
//   would prompt instead, but then no keychain argument fits and a one-line prompt cannot carry a
//   newline.
// - get reads the `password:` line that `find-generic-password -g` prints on stderr. `-w` is
//   ambiguous: it prints a value with a non-printable byte as hex, the same as a printable value
//   that looks like hex. The `-g` line tells them apart: `password: "text"` or `password: 0x<HEX> ...`.
// Errors carry the exit code only: `security` output can echo the input line, hence the value.

export interface KeychainStoreOptions {
  readonly runner?: ProcessRunner;
  /** Keychain file to use instead of the default keychain (tests use a throwaway one). */
  readonly keychain?: string;
  /** Kills `security` if it hangs, e.g. on a keychain unlock dialog. Default 30 s. */
  readonly timeoutMs?: number;
}

/** Absolute, so a PATH entry cannot stand in for it. */
const SECURITY = "/usr/bin/security";

/** `security -i` reads at most 4095 bytes per line and splits a longer one into several commands. */
const MAX_LINE = 4000;

/** `security` exits with the low byte of the Security framework status. */
const NOT_FOUND = 44; // errSecItemNotFound (-25300)
const UNAVAILABLE = new Map([
  [36, "the keychain is locked or does not allow user interaction"], // errSecInteractionNotAllowed (-25308)
  [50, "the keychain does not exist"], // errSecNoSuchKeychain (-25294)
  [51, "the keychain refused access"], // errSecAuthFailed (-25293)
]);

type Outcome = { readonly code: number; readonly stderr: readonly string[] };

export function createKeychainStore(options: KeychainStoreOptions = {}): SecretStore {
  const runner = options.runner ?? createProcessRunner();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const keychain = options.keychain === undefined ? [] : [options.keychain];
  // Goes into a `security -i` line, which splits on whitespace and treats quotes specially.
  if (options.keychain !== undefined && !/^\/[^\s"'\\]+$/.test(options.keychain)) {
    throw new TypeError("keychain must be an absolute path without whitespace, quotes or backslashes");
  }

  async function run(command: string, args: readonly string[], stdin?: string): Promise<Result<Outcome, SecretError>> {
    const stderr: string[] = [];
    try {
      const result = await runner.run({
        command: { argv: [SECURITY, ...args] },
        cwd: "/",
        timeoutMs,
        ...(stdin !== undefined && { stdin }),
        stderr: { onLine: (line) => stderr.push(line) },
      });
      if (result.kind === "not-started") {
        return err({ code: "unavailable", message: `could not start ${SECURITY}${result.code === undefined ? "" : ` (${result.code})`}` });
      }
      if (result.timedOut) return err({ code: "unavailable", message: `security ${command} timed out after ${timeoutMs} ms` });
      if (result.exitCode === null) return err({ code: "failed", message: `security ${command} was killed by ${result.signal}` });
      return ok({ code: result.exitCode, stderr });
    } catch {
      return err({ code: "failed", message: `security ${command} could not be run` });
    }
  }

  function failure(command: string, code: number): Result<never, SecretError> {
    if (code === NOT_FOUND) return err({ code: "not_found", message: "no secret stored under this ref" });
    const reason = UNAVAILABLE.get(code);
    if (reason !== undefined) return err({ code: "unavailable", message: `security ${command}: ${reason} (exit ${code})` });
    return err({ code: "failed", message: `security ${command} exited with code ${code}` });
  }

  return {
    async set(ref, value) {
      const name = storeName(ref);
      if (!name.ok) return name;
      const text = checkValue(value);
      if (!text.ok) return text;
      const hex = Buffer.from(text.value, "utf8").toString("hex");
      const line = ["add-generic-password", "-U", "-s", name.value.service, "-a", name.value.account, "-X", hex, ...keychain].join(" ");
      if (Buffer.byteLength(line, "utf8") > MAX_LINE) {
        return err({ code: "invalid_value", message: "secret value is too long for the keychain path in use" });
      }
      const outcome = await run("add-generic-password", ["-i"], `${line}\n`);
      if (!outcome.ok) return outcome;
      return outcome.value.code === 0 ? ok(undefined) : failure("add-generic-password", outcome.value.code);
    },

    async get(ref) {
      const name = storeName(ref);
      if (!name.ok) return name;
      const args = ["find-generic-password", "-g", "-s", name.value.service, "-a", name.value.account, ...keychain];
      const outcome = await run("find-generic-password", args);
      if (!outcome.ok) return outcome;
      if (outcome.value.code !== 0) return failure("find-generic-password", outcome.value.code);
      const text = parsePasswordLine(outcome.value.stderr);
      if (text === undefined) return err({ code: "failed", message: "security find-generic-password printed no readable password line" });
      return ok(new Secret(text));
    },

    async delete(ref) {
      const name = storeName(ref);
      if (!name.ok) return name;
      const args = ["delete-generic-password", "-s", name.value.service, "-a", name.value.account, ...keychain];
      const outcome = await run("delete-generic-password", args);
      if (!outcome.ok) return outcome;
      const { code } = outcome.value;
      return code === 0 || code === NOT_FOUND ? ok(undefined) : failure("delete-generic-password", code);
    },

    async has(ref) {
      const name = storeName(ref);
      if (!name.ok) return name;
      const args = ["find-generic-password", "-s", name.value.service, "-a", name.value.account, ...keychain];
      const outcome = await run("find-generic-password", args);
      if (!outcome.ok) return outcome;
      const { code } = outcome.value;
      if (code === 0) return ok(true);
      if (code === NOT_FOUND) return ok(false);
      return failure("find-generic-password", code);
    },
  };
}

/**
 * The value from the `password:` line of `find-generic-password -g`. A value of printable ASCII
 * prints raw between quotes (`password: "a"b"`, nothing escaped); any other value prints as hex
 * (`password: 0x615C62  "a\134b"`), so a newline in a value never splits the line.
 */
export function parsePasswordLine(stderr: readonly string[]): string | undefined {
  const line = stderr.find((entry) => entry.startsWith("password: "));
  if (line === undefined) return undefined;
  const rest = line.slice("password: ".length);
  const hex = /^0x((?:[0-9A-Fa-f]{2})+)(?:\s|$)/.exec(rest);
  if (hex?.[1] !== undefined) return Buffer.from(hex[1], "hex").toString("utf8");
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  return undefined;
}
