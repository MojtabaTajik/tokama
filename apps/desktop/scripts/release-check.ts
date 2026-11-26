// The first checks of the release workflow, on a runner with Node and nothing installed:
//   node scripts/release-check.ts --ref <github.ref> --notes-out <file> [--github-output <file>]
// The ref must be a v<x.y.z> tag, the tag must name the version in apps/desktop/package.json, and
// CHANGELOG.md must hold a section for it. The section becomes the release notes. With
// --github-output the version and the feed URL are appended there as `version=` and `feed_url=`.
// The feed URL is the default, or on a manual run the one in FEED_URL_INPUT; GITHUB_EVENT_NAME
// tells the two apart. Any problem ends the script with a message that names it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
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

/** The feed URL baked into the app: the default for a tag push, the input (when given) for a manual run. Throws when the input is not a valid feed URL. */
export function feedUrlFor(event: string | undefined, input: string | undefined): string {
  if (event !== "workflow_dispatch" || input === undefined || input === "") return DEFAULT_FEED_URL;
  const problem = feedUrlProblem(input);
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
  const notes = changelogSection(readFileSync(join(repoDir, "CHANGELOG.md"), "utf8"), version);
  const feedUrl = feedUrlFor(process.env["GITHUB_EVENT_NAME"], process.env["FEED_URL_INPUT"]);
  writeFileSync(notesOut, `${notes}\n`);
  if (githubOutput !== undefined) appendFileSync(githubOutput, `version=${version}\nfeed_url=${feedUrl}\n`);
  process.stdout.write(`release-check: ${version}, feed ${feedUrl}, ${notes.split("\n").length} lines of notes\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
