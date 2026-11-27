// What the macOS and Linux package checks share: the report, the readers of the small YAML files
// (app-update.yml and the latest-*.yml update feeds), and the checks on the files that sit in the
// resources folder of every platform: its layout, the engine's Node and hook, the fuses and the feed.
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appVersion, run } from "./package.ts";

const appDir = resolve(import.meta.dirname, "..");

/** Collects the outcome of each check: one line per check, and every failure for the summary. */
export class Report {
  readonly failures: string[] = [];

  /** Runs one check; its problem text, or an exception, is a failure. The run goes on. */
  async check(name: string, check: () => string | undefined | Promise<string | undefined>): Promise<void> {
    let problem: string | undefined;
    try {
      problem = await check();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem === undefined) {
      process.stdout.write(`ok ${name}\n`);
    } else {
      process.stdout.write(`FAIL ${name}: ${problem}\n`);
      this.failures.push(`${name}: ${problem}`);
    }
  }

  skip(name: string, reason: string): void {
    process.stdout.write(`skip ${name} (${reason})\n`);
  }
}

// ---- Parsers ----

const unquote = (value: string) => (/^'.*'$/.test(value) ? value.slice(1, -1) : value);

/** The top-level `key: value` lines of a small YAML file (app-update.yml, latest-mac.yml), with single quotes removed. */
export function parseYamlScalars(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) map.set(match[1], unquote(match[2]));
  }
  return map;
}

export interface LatestFeed {
  readonly version: string | undefined;
  readonly path: string | undefined;
  readonly sha512: string | undefined;
  readonly files: readonly { readonly url?: string; readonly sha512?: string; readonly size?: string }[];
}

/** Reads an update feed file (latest-mac.yml, latest-linux.yml): its top-level fields and its `files` entries. */
export function parseLatestFeed(text: string): LatestFeed {
  const top = parseYamlScalars(text);
  const files: { url?: string; sha512?: string; size?: string }[] = [];
  for (const line of text.split("\n")) {
    const first = /^ {2}- ([a-z0-9]+):\s*(.+?)\s*$/.exec(line);
    if (first?.[1] !== undefined && first[2] !== undefined) {
      files.push({ [first[1]]: unquote(first[2]) });
      continue;
    }
    const next = /^ {4}([a-z0-9]+):\s*(.+?)\s*$/.exec(line);
    const current = files[files.length - 1];
    if (next?.[1] !== undefined && next[2] !== undefined && current !== undefined) (current as Record<string, string>)[next[1]] = unquote(next[2]);
  }
  return { version: top.get("version"), path: top.get("path"), sha512: top.get("sha512"), files };
}

/** The `vendor: tokama: minSafeVersion` entry of an update feed file: whether a top-level `vendor` key exists, and the version under `vendor.tokama` if there is one. */
export function parseVendorMinSafe(text: string): { readonly hasVendor: boolean; readonly minSafeVersion: string | undefined } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^vendor:/.test(line));
  if (start < 0) return { hasVendor: false, minSafeVersion: undefined };
  let inTokama = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^ {2}\S/.test(line)) {
      inTokama = /^ {2}tokama:\s*$/.test(line);
      continue;
    }
    const field = /^ {4}minSafeVersion:\s*(.+?)\s*$/.exec(line);
    if (inTokama && field?.[1] !== undefined) return { hasVendor: true, minSafeVersion: unquote(field[1]) };
  }
  return { hasVendor: true, minSafeVersion: undefined };
}

/** Why an update feed file does not name the lowest safe version exactly as asked, or undefined. `minSafe` is the version the build was asked to name, or undefined for none, which means no `vendor` key at all. */
export function minSafeProblem(text: string, minSafe: string | undefined): string | undefined {
  const { hasVendor, minSafeVersion } = parseVendorMinSafe(text);
  if (minSafe === undefined) return hasVendor ? "it carries a vendor key, but no lowest safe version was asked for" : undefined;
  if (minSafeVersion === undefined) return `it has no vendor.tokama.minSafeVersion, but ${minSafe} was asked for`;
  return minSafeVersion === minSafe ? undefined : `vendor.tokama.minSafeVersion is ${minSafeVersion}, not ${minSafe}`;
}

export function sha512Base64(file: string): string {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

// ---- Checks on the resources folder ----

/** The release notes in the repo's whats-new folder, by file name. The packaged app must hold each one: without a note the folder is not packed at all, and a filter that drops notes would go unseen. */
function repoNotes(): string[] {
  try {
    return readdirSync(join(appDir, "..", "..", "whats-new")).filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name));
  } catch {
    return [];
  }
}

/** Why the resources folder of a packaged app lacks a file every platform ships, or undefined. `feed` says whether the build has an update feed (app-update.yml). */
export function resourcesProblem(resources: string, feed: boolean): string | undefined {
  const engine = join(resources, "engine");
  const files = [...repoNotes().map((name) => join(resources, "whats-new", name)), join(engine, "tokama-engine"), join(engine, "LICENSE-node"), join(engine, "package.json"), join(engine, "dist", "main.js"), join(engine, "dist", "hook.js"), join(resources, "LICENSE-electron"), join(resources, "LICENSES.chromium.html"), join(resources, "THIRD_PARTY_NOTICES.md"), join(resources, "app.asar"), ...["needs-you", "finished", "failed", "tokay-call"].map((name) => join(resources, `tokama-${name}.wav`))];
  for (const file of feed ? [...files, join(resources, "app-update.yml")] : files) {
    try {
      statSync(file);
    } catch {
      return `${file} is missing`;
    }
  }
  const dist = readdirSync(join(engine, "dist")).sort().join(",");
  if (dist !== "hook.js,main.js") return `engine/dist holds ${dist}`;
  try {
    accessSync(join(engine, "tokama-engine"), constants.X_OK);
  } catch {
    return "tokama-engine is not executable";
  }
  try {
    statSync(join(resources, "default_app.asar"));
    return "Electron's default_app.asar ships in the app";
  } catch {
    return undefined;
  }
}

/** Why the bundled Node (the engine folder's `tokama-engine`) is not the pinned version, or undefined. */
export function nodeVersionProblem(engine: string): string | undefined {
  const expected = (JSON.parse(readFileSync(join(appDir, "packaging", "node-runtime.json"), "utf8")) as { version: string }).version;
  const reported = run(join(engine, "tokama-engine"), ["--version"]).stdout.trim();
  return reported === `v${expected}` ? undefined : `tokama-engine reports ${reported}, not v${expected}`;
}

/** Why the engine folder's package.json does not hold the build's version, or undefined. */
export function engineVersionProblem(engine: string, version: string): string | undefined {
  const found = appVersion(engine);
  return found === version ? undefined : `the engine's package.json says ${found}, not ${version}`;
}

/** Why the fuses of the Electron executable are not as electron-builder.yml sets them, or undefined. */
export async function fusesProblem(executable: string): Promise<string | undefined> {
  const { FuseV1Options, getCurrentFuseWire } = await import("@electron/fuses");
  const wire = await getCurrentFuseWire(executable);
  // The wire holds the characters "0" and "1": 48 is off and 49 is on.
  const ON = 49;
  const OFF = 48;
  const expected = [
    ["RunAsNode", FuseV1Options.RunAsNode, OFF],
    ["EnableNodeOptionsEnvironmentVariable", FuseV1Options.EnableNodeOptionsEnvironmentVariable, OFF],
    ["EnableNodeCliInspectArguments", FuseV1Options.EnableNodeCliInspectArguments, OFF],
    ["EnableEmbeddedAsarIntegrityValidation", FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ON],
    ["OnlyLoadAppFromAsar", FuseV1Options.OnlyLoadAppFromAsar, ON],
  ] as const;
  const wrong = expected.filter(([, option, state]) => wire[option] !== state).map(([name]) => name);
  return wrong.length === 0 ? undefined : `fuses not as configured: ${wrong.join(", ")}`;
}

/** Why app-update.yml (in `resources`) does not name the generic feed at `feedUrl`, or undefined. */
export function feedProblem(resources: string, feedUrl: string): string | undefined {
  const feed = parseYamlScalars(readFileSync(join(resources, "app-update.yml"), "utf8"));
  if (feed.get("provider") !== "generic") return `app-update.yml provider is ${feed.get("provider") ?? "missing"}`;
  return feed.get("url") === feedUrl ? undefined : `app-update.yml url is ${feed.get("url") ?? "missing"}, not ${feedUrl}`;
}

/** The bundled Node runs the bundled hook: a command no rule allows is denied. */
export function hookProblem(engine: string): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "tk-verify-"));
  try {
    const rules = join(scratch, "rules.json");
    writeFileSync(rules, JSON.stringify({ commands: [] }));
    const hook = run(join(engine, "tokama-engine"), [join(engine, "dist", "hook.js"), rules], JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }));
    return hook.status === 42 && hook.stdout.includes('"permissionDecision":"deny"') ? undefined : `unexpected reply: ${hook.stdout}${hook.stderr}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
