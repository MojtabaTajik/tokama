// The first checks of the release workflow, on a runner with Node and nothing installed:
//   node scripts/release-check.ts --ref <github.ref> --notes-out <file> [--github-output <file>]
// The ref must be a v<x.y.z> tag, the tag must name the version in apps/desktop/package.json, and
// the release must have notes: `whats-new/<version>.md` when that file exists (it must parse, and
// becomes the notes), else the CHANGELOG.md section for the version. With
// --github-output the version, the feed URL and the lowest safe version (empty when no note up to
// this version says `security: true`; see minSafeVersionFor) are appended there as `version=`,
// `feed_url=` and `min_safe_version=`.
// The feed URL is the default, or on a manual run the one in FEED_URL_INPUT; GITHUB_EVENT_NAME
// tells the two apart. Any problem ends the script with a message that names it.
import { appendFileSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compareVersions, isVersion, MAX_NOTE_BYTES, parseNote, releaseNotes } from "../src/shared/whats-new.ts";
import { DEFAULT_FEED_URL, appVersion, feedUrlProblem } from "./package.ts";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");

/** The version a tag ref names: `refs/tags/v0.1.0` gives `0.1.0`. Throws, with the way to run the workflow, for any other ref. */
export function tagVersion(ref: string): string {
  const match = /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(ref);
  if (match?.[1] === undefined) throw new Error(`${JSON.stringify(ref)} is not a v<x.y.z> tag. Run this workflow on a v* tag: gh workflow run release.yml --ref vX.Y.Z`);
  return match[1];
}

/** The body of the `## <version>` section of a changelog: from its heading to the next `## ` heading, trimmed. Throws when the section is missing or empty. `## 0.0.1` does not match 0.0.10, and `## Unreleased` is no version. */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")}(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") throw new Error(`the "## ${version}" section of CHANGELOG.md is empty`);
  return body;
}

/**
 * The release notes of `version` in the checkout at `repoDir`: the note `whats-new/<version>.md`
 * when there is one, else the CHANGELOG.md section. A note that is not a plain file of at most
 * 8 KiB, or does not parse, throws with every problem named; it never falls back to the changelog.
 */
export function releaseNotesFor(repoDir: string, version: string): { readonly notes: string; readonly source: string } {
  const name = `${version}.md`;
  const path = join(repoDir, "whats-new", name);
  const source = `whats-new/${name}`;
  let size: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`${source} is not a plain file`);
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size === undefined) return { notes: changelogSection(readFileSync(join(repoDir, "CHANGELOG.md"), "utf8"), version), source: "CHANGELOG.md" };
  if (size > MAX_NOTE_BYTES) throw new Error(`${source}: the file is ${size} bytes, at most ${MAX_NOTE_BYTES}`);
  const parsed = parseNote(readFileSync(path, "utf8"), name);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.problems.join("; ")}`);
  return { notes: releaseNotes(parsed.note), source };
}

/**
 * The lowest version that is safe, as the feed names it: the newest note at or below `version`
 * that says `security: true`, or undefined when no such note exists. It carries forward, so a
 * normal release after a security release keeps the flag for everyone still below it. Every note
 * file must parse, as in `releaseNotesFor`: a broken note could hide a security release. A
 * security release must have a note; the CHANGELOG cannot mark one.
 */
export function minSafeVersionFor(repoDir: string, version: string): string | undefined {
  const folder = join(repoDir, "whats-new");
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let newest: string | undefined;
  for (const name of names) {
    const match = /^(\d+\.\d+\.\d+)\.md$/.exec(name);
    if (match?.[1] === undefined || !isVersion(match[1]) || compareVersions(match[1], version) > 0) continue;
    const path = join(folder, name);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`whats-new/${name} is not a plain file`);
    if (stat.size > MAX_NOTE_BYTES) throw new Error(`whats-new/${name}: the file is ${stat.size} bytes, at most ${MAX_NOTE_BYTES}`);
    const parsed = parseNote(readFileSync(path, "utf8"), name);
    if (!parsed.ok) throw new Error(`whats-new/${name}: ${parsed.problems.join("; ")}`);
    if (parsed.note.security && (newest === undefined || compareVersions(match[1], newest) > 0)) newest = match[1];
  }
  return newest;
}

/** The feed URL baked into the app: the default for a tag push, the input (when given) for a manual run. Throws when the input is not a valid feed URL. */
export function feedUrlFor(event: string | undefined, input: string | undefined): string {
  if (event !== "workflow_dispatch" || input === undefined || input === "") return DEFAULT_FEED_URL;
  // A manual run may bake in a local test feed; a tag push never reaches this line.
  const problem = feedUrlProblem(input, true);
  if (problem !== undefined) throw new Error(problem);
  return input;
}

function main(): void {
  const { values } = parseArgs({ options: { ref: { type: "string" }, "notes-out": { type: "string" }, "github-output": { type: "string" } } });
  const { ref, "notes-out": notesOut, "github-output": githubOutput } = values;
  if (ref === undefined || notesOut === undefined) throw new Error("--ref and --notes-out are required");
  const version = tagVersion(ref);
  const packaged = appVersion(appDir);
  if (version !== packaged) throw new Error(`the tag names ${version}, apps/desktop/package.json says ${packaged}`);
  const { notes, source } = releaseNotesFor(repoDir, version);
  const minSafe = minSafeVersionFor(repoDir, version) ?? "";
  const feedUrl = feedUrlFor(process.env["GITHUB_EVENT_NAME"], process.env["FEED_URL_INPUT"]);
  writeFileSync(notesOut, `${notes}\n`);
  if (githubOutput !== undefined) appendFileSync(githubOutput, `version=${version}\nfeed_url=${feedUrl}\nmin_safe_version=${minSafe}\n`);
  process.stdout.write(`release-check: ${version}, feed ${feedUrl}, ${notes.split("\n").length} lines of notes from ${source}, lowest safe version ${minSafe === "" ? "none" : minSafe}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
