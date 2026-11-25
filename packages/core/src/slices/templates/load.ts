// Loads every template on the machine: each repo's `.tokama/templates/*.yaml`, then the built-ins.
// Files are read through the kernel's safe reads; a file that is refused or invalid becomes a list
// of problems and never hides the other templates.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { listFiles, readTextFileInside, type ReadFailure } from "../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { MAX_TEMPLATE_FILE_BYTES, RepoIdSchema, TemplateIdSchema, type RepoId, type TemplateRecord, type TemplateRef } from "../../kernel/schemas/index.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { quote } from "./quote.js";
import { templateWarnings } from "./warnings.js";
import { validateTemplate, type AgentLocation, type TemplateProblem, type ValidateContext } from "./validate.js";

/** The folder inside a repo that holds its templates. */
export const TEMPLATES_DIR = ".tokama/templates";
const BUILTIN = "builtin";
const MAX_TEMPLATE_BYTES = MAX_TEMPLATE_FILE_BYTES;
const MAX_TEMPLATE_LINES = 5_000;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_TEMPLATES_PER_REPO = 100;
const LINK_REFUSED = "Tokama doesn't follow links in config folders";

/** The problem message for a linked file or folder; `file` is repo-relative. */
const linkRefused = (file: string): string => `${LINK_REFUSED}: ${quote(file)}`;

export interface RepoLocation {
  readonly id: string;
  /** The repo's folder on this machine. Used to read files; never stored in a record. */
  readonly path: string;
}

export interface LoadInput {
  readonly repos: readonly RepoLocation[];
  readonly agents: ReadonlyMap<string, AgentLocation>;
}

/**
 * One template file, loaded or not. `ref` is absent when the file name is not a valid id. `text`
 * is the file as read, absent when it could not be read.
 */
export type TemplateLoad =
  | { readonly ok: true; readonly template: TemplateRecord; readonly warnings: readonly string[]; readonly text: string }
  | {
      readonly ok: false;
      readonly text?: string;
      readonly ref?: TemplateRef;
      /** `builtin`, or the repo id. */
      readonly origin: string;
      /** Repo-relative, e.g. `.tokama/templates/quick-fix.yaml`; the built-in's ref for a built-in. */
      readonly file: string;
      readonly problems: readonly TemplateProblem[];
    };

export async function loadTemplates(input: LoadInput): Promise<TemplateLoad[]> {
  const loads: TemplateLoad[] = [];
  for (const repo of input.repos) loads.push(...(await loadRepo(repo, input.agents)));
  loads.push(...(await loadBuiltins(input.agents)));
  return loads;
}

export async function loadBuiltins(agents: ReadonlyMap<string, AgentLocation>): Promise<TemplateLoad[]> {
  const loads: TemplateLoad[] = [];
  for (const [id, text] of BUILTIN_TEMPLATES) {
    const ref = `${BUILTIN}/${id}` as TemplateRef;
    loads.push(toLoad(await validateTemplate(text, { ref, source: { kind: "builtin" }, agents }), BUILTIN, ref, ref, text));
  }
  return loads;
}

async function loadRepo(repo: RepoLocation, agents: ReadonlyMap<string, AgentLocation>): Promise<TemplateLoad[]> {
  const fail = (message: string): TemplateLoad[] => [{ ok: false, origin: repo.id, file: TEMPLATES_DIR, problems: [{ line: 1, message }] }];
  if (repo.id === BUILTIN) return fail(`A repo cannot be named "${BUILTIN}": that name is kept for the templates that ship with Tokama.`);
  if (!RepoIdSchema.safeParse(repo.id).success) return fail(`${quote(repo.id)} is not a valid repo id.`);
  const repoId = repo.id as RepoId;

  const dir = join(repo.path, ...TEMPLATES_DIR.split("/"));
  // A linked .tokama or templates folder is never listed, even one that stays inside the repo.
  const link = await firstLink(repo.path, TEMPLATES_DIR);
  if (link !== undefined) return fail(linkRefused(link));
  const listed = await listFiles(repo.path, TEMPLATES_DIR, { max: MAX_TEMPLATES_PER_REPO });
  if (!listed.ok) {
    switch (listed.error.reason) {
      case "not_found":
        return [];
      case "symlink":
      case "outside_root":
        return fail(linkRefused(TEMPLATES_DIR));
      case "too_many_entries":
        return fail(`The templates folder has more than ${MAX_TEMPLATES_PER_REPO} files.`);
      default:
        return fail(`The templates folder cannot be read (${listed.error.message}).`);
    }
  }

  const loads: TemplateLoad[] = [];
  for (const name of listed.value) {
    const file = `${TEMPLATES_DIR}/${name}`;
    if (name.endsWith(".yml")) {
      const message = `The file ${quote(name)} ends in .yml; Tokama reads only .yaml templates, so rename it to ${quote(`${name.slice(0, -".yml".length)}.yaml`)}.`;
      loads.push({ ok: false, origin: repoId, file, problems: [{ line: 1, message }] });
      continue;
    }
    if (!name.endsWith(".yaml")) continue;
    const id = name.slice(0, -".yaml".length);
    if (!TemplateIdSchema.safeParse(id).success) {
      const message = `The file name ${quote(name)} is not a valid template id: use lowercase letters, digits and hyphens, such as quick-fix.yaml.`;
      loads.push({ ok: false, origin: repoId, file, problems: [{ line: 1, message }] });
      continue;
    }
    const ref = `${repoId}/${id}` as TemplateRef;
    const text = await readTextFileInside(dir, join(dir, name), { maxBytes: MAX_TEMPLATE_BYTES, maxLines: MAX_TEMPLATE_LINES });
    if (!text.ok) {
      const message = text.error.reason === "symlink" ? linkRefused(file) : `The template ${readReason(text.error)}.`;
      loads.push({ ok: false, ref, origin: repoId, file, problems: [{ line: 1, message }] });
      continue;
    }
    const ctx: ValidateContext = {
      ref,
      source: { kind: "repo", repoId, file },
      agents,
      readInstructions: (relative) => readInstructions(dir, relative),
    };
    loads.push(toLoad(await validateTemplate(text.value, ctx), repoId, file, ref, text.value));
  }
  return loads;
}

async function readInstructions(dir: string, relative: string): Promise<Result<string, string>> {
  // No link anywhere on the path, and inside the templates folder before it is opened.
  const link = await firstLink(dir, relative);
  if (link !== undefined) return err(`is not read. ${linkRefused(`${TEMPLATES_DIR}/${link}`)}`);
  const text = await readTextFileInside(dir, join(dir, ...relative.split("/")), { maxBytes: MAX_INSTRUCTION_BYTES });
  return text.ok ? ok(text.value) : err(readReason(text.error));
}

function readReason(failure: ReadFailure): string {
  switch (failure.reason) {
    case "not_found":
      return "does not exist";
    case "symlink":
      return `is a link, and ${LINK_REFUSED}`;
    case "not_regular_file":
      return "is not a regular file";
    case "too_large":
    case "too_many_lines":
      return `is too big (${failure.message})`;
    case "invalid_utf8":
      return "is not UTF-8 text";
    case "outside_root":
      return "is outside the templates folder";
    default:
      return `cannot be read (${quote(failure.message)})`;
  }
}

/** The first part of `relative` (a "/" path under `base`) that is a link, or `undefined`. */
async function firstLink(base: string, relative: string): Promise<string | undefined> {
  const parts = relative.split("/");
  for (let end = 1; end <= parts.length; end++) {
    try {
      if ((await lstat(join(base, ...parts.slice(0, end)))).isSymbolicLink()) return parts.slice(0, end).join("/");
    } catch {
      // Missing: the read that follows reports it.
      return undefined;
    }
  }
  return undefined;
}

function toLoad(result: Result<TemplateRecord, TemplateProblem[]>, origin: string, file: string, ref: TemplateRef, text: string): TemplateLoad {
  return result.ok ? { ok: true, template: result.value, warnings: templateWarnings(result.value), text } : { ok: false, ref, origin, file, problems: result.error, text };
}
