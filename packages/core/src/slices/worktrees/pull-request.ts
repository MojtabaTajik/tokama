// Pull requests through the engineer's own `gh` CLI and its login: Tokama holds no token. Every
// call is `gh api` against the named repo, run outside any repo folder, so gh never runs git in
// the engineer's checkout or reads its config. gh never prompts. Only the title and a fixed line
// go into the pull request: the item's description stays on the machine.
import { tmpdir } from "node:os";
import type { ProcessRunner } from "../../kernel/process/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { type ItemId, PullRequestUrlSchema } from "../../kernel/schemas/index.js";
import { type HostedRepo, pushTarget } from "./remote.js";

export interface GhOptions {
  readonly runner: ProcessRunner;
  /** argv that starts gh. Default: `["gh"]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  /** Per call. Default: 60 s. */
  readonly timeoutMs?: number;
}

/** Whether gh can open pull requests on a host, as the setup shows it. */
export interface GhStatus {
  readonly installed: boolean;
  readonly loggedIn: boolean;
  /** Why Open PR can't be used, in plain words; absent when it can. */
  readonly message?: string;
}

const OUTPUT_CAP = 4_000;
const TITLE_MAX = 200;

const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GH_SPINNER_DISABLED: "1" };

async function gh(options: GhOptions, args: readonly string[]): Promise<{ started: boolean; exitCode: number | null; out: string; error: string }> {
  const out: string[] = [];
  const error: string[] = [];
  const keep = (lines: string[]) => (line: string) => void (lines.join("\n").length < OUTPUT_CAP && lines.push(line));
  const result = await options.runner.run({
    command: { argv: [...(options.command ?? ["gh"]), ...args] },
    cwd: tmpdir(),
    env: GH_ENV,
    timeoutMs: options.timeoutMs ?? 60_000,
    stdout: { onLine: keep(out) },
    stderr: { onLine: keep(error) },
  });
  if (result.kind === "not-started") return { started: false, exitCode: null, out: "", error: result.message };
  return { started: true, exitCode: result.timedOut ? null : result.exitCode, out: out.join("\n").trim(), error: error.join("\n").trim().slice(0, OUTPUT_CAP) };
}

/** Read-only: `gh --version`, then `gh auth status --hostname <host>`. */
export async function ghStatus(options: GhOptions, host = "github.com"): Promise<GhStatus> {
  const version = await gh(options, ["--version"]);
  if (!version.started || version.exitCode !== 0) {
    return { installed: false, loggedIn: false, message: "The GitHub CLI (gh) is not installed, or `gh` is not on the PATH. Install it to open pull requests." };
  }
  const status = await gh(options, ["auth", "status", "--hostname", host]);
  if (status.exitCode === 0) return { installed: true, loggedIn: true };
  return { installed: true, loggedIn: false, message: `gh is not logged in to ${host}. Run \`gh auth login\` in a terminal, then check again.` };
}

export interface PullRequestInput {
  readonly repo: HostedRepo;
  readonly itemId: ItemId;
  readonly title: string;
  /** The pushed item branch. */
  readonly head: string;
  readonly base: string;
}

/**
 * Opens the pull request and returns its URL. When one is open for the branch already (a retry
 * after a restart), that one's URL comes back instead.
 */
export async function openPullRequest(options: GhOptions, input: PullRequestInput): Promise<Result<string, string>> {
  const { repo } = input;
  const path = `repos/${repo.owner}/${repo.name}/pulls`;
  const title = input.title.replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, TITLE_MAX) || input.itemId;
  const created = await gh(options, [
    "api", "--hostname", repo.host, "--method", "POST", path,
    "-f", `title=${title}`, "-f", `head=${input.head}`, "-f", `base=${input.base}`,
    "-f", `body=Opened by Tokama for item ${input.itemId}.`,
    "--jq", ".html_url",
  ]);
  if (!created.started) return err("The GitHub CLI (gh) is not installed, or `gh` is not on the PATH.");
  if (created.exitCode === 0) return url(created.out);
  const existing = await gh(options, ["api", "--hostname", repo.host, "--method", "GET", path, "-f", `head=${repo.owner}:${input.head}`, "-f", "state=open", "--jq", ".[0].html_url // empty"]);
  if (existing.exitCode === 0 && existing.out !== "") return url(existing.out);
  return err(`gh could not open the pull request on ${pushTarget(repo)}: ${created.error || created.out || `exit ${created.exitCode ?? "timeout"}`}`);
}

function url(out: string): Result<string, string> {
  const parsed = PullRequestUrlSchema.safeParse(out.trim());
  return parsed.success ? ok(parsed.data) : err(`gh answered with something that is not a pull request URL: ${out.slice(0, 200)}`);
}
