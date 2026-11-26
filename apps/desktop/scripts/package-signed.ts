// The release half of `package.ts --signed`: what the signing run needs from its environment, and
// the steps after electron-builder has signed and notarized the app: sign the dmg with a secure
// timestamp, notarize and staple it, and write SHA256SUMS.txt. Nothing here prints a secret; the
// key is only ever a file path.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export interface SignedEnv {
  /** The keychain that holds the Developer ID certificate. */
  readonly keychain: string;
  readonly team: string;
  /** Path of the App Store Connect API key file. */
  readonly apiKey: string;
  readonly keyId: string;
  readonly issuer: string;
}

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** What a signed build needs from the environment. Every missing or wrong variable is named in `problems`. */
export function signedEnv(env: Readonly<Record<string, string | undefined>>, fileExists: (path: string) => boolean): { readonly value: SignedEnv | undefined; readonly problems: string[] } {
  const problems: string[] = [];
  const keychain = env["CSC_KEYCHAIN"];
  if (keychain === undefined || keychain === "") problems.push("CSC_KEYCHAIN is not set (the keychain with the Developer ID certificate)");
  else if (!fileExists(keychain)) problems.push("CSC_KEYCHAIN is not an existing file");
  if (env["CSC_LINK"] !== undefined) problems.push("CSC_LINK must not be set: only the prepared keychain signs");
  const team = env["APPLE_TEAM_ID"];
  if (team === undefined || team === "") problems.push("APPLE_TEAM_ID is not set");
  else if (!/^[A-Z0-9]{10}$/.test(team)) problems.push("APPLE_TEAM_ID must be 10 capital letters or digits");
  const apiKey = env["APPLE_API_KEY"];
  if (apiKey === undefined || apiKey === "") problems.push("APPLE_API_KEY is not set (the path of the App Store Connect API key file)");
  else if (!isAbsolute(apiKey) || !fileExists(apiKey)) problems.push("APPLE_API_KEY must be the absolute path of an existing file");
  const keyId = env["APPLE_API_KEY_ID"];
  if (keyId === undefined || keyId === "") problems.push("APPLE_API_KEY_ID is not set");
  else if (!/^[A-Za-z0-9]+$/.test(keyId)) problems.push("APPLE_API_KEY_ID must be letters and digits only");
  const issuer = env["APPLE_API_ISSUER"];
  if (issuer === undefined || issuer === "") problems.push("APPLE_API_ISSUER is not set");
  else if (!/^[A-Za-z0-9-]+$/.test(issuer)) problems.push("APPLE_API_ISSUER must be letters, digits and hyphens only");
  if (problems.length > 0 || keychain === undefined || team === undefined || apiKey === undefined || keyId === undefined || issuer === undefined) return { value: undefined, problems };
  return { value: { keychain, team, apiKey, keyId, issuer }, problems };
}

/** The SHA-1 hash of the Developer ID Application identity of `team` in the output of `security find-identity -v -p codesigning`. Undefined when there is none. */
export function findIdentityHash(output: string, team: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: .*\(([A-Z0-9]{10})\)"/.exec(line);
    if (match?.[1] !== undefined && match[2] === team) return match[1];
  }
  return undefined;
}

/** The submission id and status in `notarytool submit --output-format json`. */
export function notaryOutcome(stdout: string): { readonly id: string | undefined; readonly status: string | undefined } {
  try {
    const parsed = JSON.parse(stdout) as { id?: unknown; status?: unknown };
    return { id: typeof parsed.id === "string" ? parsed.id : undefined, status: typeof parsed.status === "string" ? parsed.status : undefined };
  } catch {
    return { id: undefined, status: undefined };
  }
}

/** The text of SHA256SUMS.txt: `shasum -a 256` format, `<hex>  <name>` per line, in the order given. */
export function sha256Sums(entries: readonly { readonly name: string; readonly sha256: string }[]): string {
  return entries.map((entry) => `${entry.sha256}  ${entry.name}\n`).join("");
}

function tool(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const credentials = (env: SignedEnv) => ["--key", env.apiKey, "--key-id", env.keyId, "--issuer", env.issuer];

/** Signs the dmg with a secure timestamp, notarizes it (the log goes to release/notary-dmg.json when it is not accepted), and staples the ticket. Throws with the reason. */
export function signNotarizeDmg(release: string, dmg: string, env: SignedEnv): void {
  const identities = tool("security", ["find-identity", "-v", "-p", "codesigning", env.keychain]);
  const identity = findIdentityHash(identities.stdout, env.team);
  if (identity === undefined) throw new Error(`no Developer ID Application identity of team ${env.team} in the keychain`);
  const signed = tool("codesign", ["--force", "--timestamp", "--sign", identity, "--keychain", env.keychain, dmg]);
  if (signed.status !== 0) throw new Error(`codesign of the dmg: ${signed.stderr.trim()}`);

  process.stdout.write(`notarizing ${basename(dmg)}\n`);
  const submitted = tool("xcrun", ["notarytool", "submit", dmg, ...credentials(env), "--wait", "--output-format", "json"]);
  const outcome = notaryOutcome(submitted.stdout);
  process.stdout.write(`notary: status ${outcome.status ?? "unknown"}, submission ${outcome.id ?? "unknown"}\n`);
  if (outcome.status !== "Accepted") {
    if (outcome.id !== undefined) {
      const log = tool("xcrun", ["notarytool", "log", outcome.id, ...credentials(env), join(release, "notary-dmg.json")]);
      if (log.status !== 0) process.stderr.write(`could not fetch the notary log: ${log.stderr.trim()}\n`);
    }
    throw new Error(`the notary service did not accept the dmg (${outcome.status ?? "no status"}): ${submitted.stderr.trim()}`);
  }
  const stapled = tool("xcrun", ["stapler", "staple", dmg]);
  if (stapled.status !== 0) throw new Error(`stapler staple: ${stapled.stdout}${stapled.stderr}`.trim());
}

/** Writes release/SHA256SUMS.txt over the dmg, the zip, the zip's blockmap and latest-mac.yml, in that order. */
export function writeSums(release: string, version: string): void {
  const names = [`Tokama-${version}-arm64.dmg`, `Tokama-${version}-arm64-mac.zip`, `Tokama-${version}-arm64-mac.zip.blockmap`, "latest-mac.yml"];
  const entries = names.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(release, name))).digest("hex") }));
  writeFileSync(join(release, "SHA256SUMS.txt"), sha256Sums(entries));
}
