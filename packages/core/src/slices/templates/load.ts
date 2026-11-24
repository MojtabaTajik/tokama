// Loads every template on the machine: each repo's `.tokama/templates/*.yaml`, then the built-ins.
// Files are read through the kernel's safe reads; a file that is refused or invalid becomes a list
// of problems and never hides the other templates.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isInside, readTextFile, type ReadFailure } from "../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { RepoIdSchema, TemplateIdSchema, type RepoId, type TemplateRecord, type TemplateRef } from "../../kernel/schemas/index.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { validateTemplate, type AgentLocation, type TemplateProblem, type ValidateContext } from "./validate.js";

/** The folder inside a repo that holds its templates. */
export const TEMPLATES_DIR = ".tokama/templates";
const BUILTIN = "builtin";
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_TEMPLATE_LINES = 5_000;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_TEMPLATES_PER_REPO = 100;

export interface RepoLocation {
  readonly id: string;
  /** The repo's folder on this machine. Used to read files; never stored in a record. */
  readonly path: string;
}

export interface LoadInput {
  readonly repos: readonly RepoLocation[];
  readonly agents: ReadonlyMap<string, AgentLocation>;
}

/** One template file, loaded or not. `ref` is absent when the file name is not a valid id. */
export type TemplateLoad =
  | { readonly ok: true; readonly template: TemplateRecord }
  | {
      readonly ok: false;
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
    loads.push(toLoad(await validateTemplate(text, { ref, source: { kind: "builtin" }, agents }), BUILTIN, ref, ref));
  }
  return loads;
}

async function loadRepo(repo: RepoLocation, agents: ReadonlyMap<string, AgentLocation>): Promise<TemplateLoad[]> {
  const fail = (message: string): TemplateLoad[] => [{ ok: false, origin: repo.id, file: TEMPLATES_DIR, problems: [{ line: 1, message }] }];
  if (repo.id === BUILTIN) return fail(`A repo cannot be named "${BUILTIN}": that name is kept for the templates that ship with Tokama.`);
  if (!RepoIdSchema.safeParse(repo.id).success) return fail(`"${repo.id}" is not a valid repo id.`);
  const repoId = repo.id as RepoId;

  const dir = join(repo.path, ...TEMPLATES_DIR.split("/"));
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    return fail(`The templates folder cannot be read (${code ?? "unknown error"}).`);
  }
  // A symlinked templates folder could point anywhere on the machine.
  if (!(await isInside(repo.path, dir))) return fail("The templates folder is a link to a place outside the repo; Tokama does not follow it.");
  if (names.length > MAX_TEMPLATES_PER_REPO) return fail(`The templates folder has more than ${MAX_TEMPLATES_PER_REPO} templates.`);

  const loads: TemplateLoad[] = [];
  for (const name of names) {
    const file = `${TEMPLATES_DIR}/${name}`;
    const id = name.slice(0, -".yaml".length);
    if (!TemplateIdSchema.safeParse(id).success) {
      const message = `The file name "${name}" is not a valid template id: use lowercase letters, digits and hyphens, such as quick-fix.yaml.`;
      loads.push({ ok: false, origin: repoId, file, problems: [{ line: 1, message }] });
      continue;
    }
    const ref = `${repoId}/${id}` as TemplateRef;
    const text = await readTextFile(join(dir, name), { maxBytes: MAX_TEMPLATE_BYTES, maxLines: MAX_TEMPLATE_LINES });
    if (!text.ok) {
      loads.push({ ok: false, ref, origin: repoId, file, problems: [{ line: 1, message: `The template ${readReason(text.error)}.` }] });
      continue;
    }
    const ctx: ValidateContext = {
      ref,
      source: { kind: "repo", repoId, file },
      agents,
      readInstructions: (relative) => readInstructions(dir, relative),
    };
    loads.push(toLoad(await validateTemplate(text.value, ctx), repoId, file, ref));
  }
  return loads;
}

async function readInstructions(dir: string, relative: string): Promise<Result<string, string>> {
  const path = join(dir, ...relative.split("/"));
  const text = await readTextFile(path, { maxBytes: MAX_INSTRUCTION_BYTES });
  if (!text.ok) return err(readReason(text.error));
  // A symlinked folder on the way could lead out of the templates folder.
  if (!(await isInside(dir, path))) return err("is outside the templates folder");
  return ok(text.value);
}

function readReason(failure: ReadFailure): string {
  switch (failure.reason) {
    case "not_found":
      return "does not exist";
    case "symlink":
      return "is a symlink, and Tokama does not follow symlinks in templates";
    case "not_regular_file":
      return "is not a regular file";
    case "too_large":
    case "too_many_lines":
      return `is too big (${failure.message})`;
    case "invalid_utf8":
      return "is not UTF-8 text";
    default:
      return `cannot be read (${failure.message})`;
  }
}

function toLoad(result: Result<TemplateRecord, TemplateProblem[]>, origin: string, file: string, ref: TemplateRef): TemplateLoad {
  return result.ok ? { ok: true, template: result.value } : { ok: false, ref, origin, file, problems: result.error };
}
