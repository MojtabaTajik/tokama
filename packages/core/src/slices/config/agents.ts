// Agents: `<id>.md` files with YAML front matter (name, runs_on, model, tools) and the role text
// as the body. Personal agents (`<tokama home>/agents/`) win over the repo's shared ones
// (`<repo>/.tokama/agents/`), which win over the built-ins. Links are followed in the home
// folder only: a repo's content can come from anyone.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { rulePrefixes } from "../../kernel/command-policy/index.js";
import type { ToolLimits } from "../../kernel/ports/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { type AgentId, AgentIdSchema, type AiCliId, AiCliIdSchema, type RepoId } from "../../kernel/schemas/index.js";
import { LINK_REFUSED, readConfigFile, readHomeConfigFile, resolveHomePath } from "./read.js";
import type { Repo } from "./repos.js";
import { clean, CONFIG_FORMAT, type ConfigProblem, parseYaml, quote } from "./yaml-file.js";

/** Who owns an agent definition. Never a path: records stay valid on another machine. */
export type AgentOwner = { readonly kind: "builtin" } | { readonly kind: "personal" } | { readonly kind: "repo"; readonly repoId: RepoId };

/** The CLIs that can drive a local model. */
export type ModelDriverId = Exclude<AiCliId, "ollama">;

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  /** The AI CLI or model host it runs on (`runs_on`). */
  readonly cliId: AiCliId;
  /** For `ollama`: the CLI that drives the local model. */
  readonly drivenBy?: ModelDriverId;
  readonly model: string;
  readonly limits: ToolLimits;
  readonly icon?: string;
  /** The role instructions: the file's body. */
  readonly role: string;
  readonly owner: AgentOwner;
}

const DRIVERS = ["claude-code", "codex-cli"] as const satisfies readonly ModelDriverId[];
const text = (max: number) => z.string().trim().min(1).max(max);

const AgentFileSchema = z
  .strictObject({
    format: z.literal(CONFIG_FORMAT),
    name: text(100).regex(/^[^\p{Cc}]*$/u, "must be one line, with no control characters"),
    runs_on: AiCliIdSchema,
    driven_by: z.enum(DRIVERS).optional(),
    model: text(100).refine((model) => !model.startsWith("-") && !/\s/.test(model), "must be a model name: no spaces, not starting with '-'"),
    tools: z.enum(["read-only", "edit"]),
    commands: z.array(z.string().refine((rule) => rulePrefixes([rule]).length > 0, "has no command words")).optional(),
    web: z.boolean().optional(),
    icon: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "must be an icon name: lowercase letters, digits and hyphens")
      .optional(),
  })
  .superRefine((agent, ctx) => {
    if (agent.runs_on === "ollama" && agent.driven_by === undefined) {
      ctx.addIssue({ code: "custom", path: ["runs_on"], message: "is ollama, so driven_by is needed: claude-code or codex-cli, the CLI that drives the local model" });
    }
    if (agent.runs_on !== "ollama" && agent.driven_by !== undefined) {
      ctx.addIssue({ code: "custom", path: ["driven_by"], message: "only applies when runs_on is ollama" });
    }
  });

const FENCE = /^---[ \t]*$/;

/** Parses one agent file's text. `file` is the name problems show; `id` comes from the file name. */
export function parseAgentFile(content: string, id: AgentId, owner: AgentOwner, file: string): Result<Agent, ConfigProblem[]> {
  const lines = content.split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? "")) {
    return err([{ file, line: 1, message: "must start with a '---' line, then the settings (name, runs_on, model, tools), then '---'" }]);
  }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  if (close === -1) return err([{ file, line: 1, message: "the settings at the top are never closed: add a '---' line after them" }]);

  const parsed = parseYaml(AgentFileSchema, lines.slice(1, close).join("\n"), file, 2);
  if (!parsed.ok) return parsed;
  const front = parsed.value;
  return ok({
    id,
    name: front.name,
    cliId: front.runs_on,
    ...(front.driven_by === undefined ? {} : { drivenBy: front.driven_by }),
    model: front.model,
    limits: { edit: front.tools === "edit", commands: front.commands ?? [], web: front.web ?? false },
    ...(front.icon === undefined ? {} : { icon: front.icon }),
    role: lines.slice(close + 1).join("\n").trim(),
    owner,
  });
}

// Built-ins are agent files like any other, so they pass the same validation.
export const BUILTIN_AGENT_FILES: Readonly<Record<string, string>> = {
  builder: `---
format: 1
name: Builder
runs_on: claude-code
model: sonnet
tools: edit
icon: hammer
---
You are Builder. Make the change the task asks for, in this worktree only.
Read the code around the change first and follow the repo's conventions.
Keep the diff small: no unrelated refactors, renames or reformatting.
Add or update tests for what you change.
Do not commit, push or change git settings; Tokama runs the checks and commits.
`,
};

export interface LoadAgentsOptions {
  /** Tokama's home folder (`~/.tokama`); personal agents are in its `agents/` folder. */
  readonly tokamaHome: string;
  /** The repo whose shared agents (`.tokama/agents/`) apply. Without one: personal and built-in only. */
  readonly repo?: Pick<Repo, "id" | "path">;
}

/** An id whose winning file is invalid. A step that uses it fails with these problems. */
export interface BrokenAgent {
  readonly id: AgentId;
  readonly owner: AgentOwner;
  readonly problems: readonly ConfigProblem[];
}

export interface LoadedAgents {
  /** The usable agents, sorted by id. */
  readonly agents: readonly Agent[];
  /** Ids claimed by an invalid file, sorted by id. A lower-precedence agent never takes their place. */
  readonly broken: readonly BrokenAgent[];
  /** Every problem found, in folder order: broken agents', shadowed files' and folders'. */
  readonly problems: readonly ConfigProblem[];
}

type Entry = { readonly ok: true; readonly agent: Agent } | { readonly ok: false; readonly broken: BrokenAgent };

/**
 * The agents a step can use: personal, then the repo's shared ones, then the built-ins; on the
 * same id the first file wins, valid or not. A missing folder has no agents. A bad file never
 * blocks the others: it is reported, and it still claims its id.
 */
export async function loadAgents(options: LoadAgentsOptions): Promise<LoadedAgents> {
  const problems: ConfigProblem[] = [];
  const entries: Entry[] = [];

  // The home folder is the engineer's own: links in it are followed, so dotfile managers work.
  const personal = await resolveHomePath(join(options.tokamaHome, "agents"), "agents");
  if (!personal.ok) problems.push(personal.error);
  else if (personal.value !== undefined) entries.push(...(await loadFolder(personal.value, "agents", { kind: "personal" }, problems, readHomeConfigFile)));
  if (options.repo !== undefined) {
    const { id, path } = options.repo;
    // The repo itself is the engineer's; a linked .tokama in it could lead anywhere.
    if (await isLink(join(path, ".tokama"))) problems.push({ file: `${id}/.tokama`, message: LINK_REFUSED });
    else entries.push(...(await loadFolder(join(path, ".tokama", "agents"), `${id}/.tokama/agents`, { kind: "repo", repoId: id }, problems, readConfigFile)));
  }
  for (const [id, content] of Object.entries(BUILTIN_AGENT_FILES)) {
    entries.push(toEntry(parseAgentFile(content, AgentIdSchema.parse(id), { kind: "builtin" }, `builtin/${id}.md`), AgentIdSchema.parse(id), { kind: "builtin" }, problems));
  }

  const winners = new Map<AgentId, Entry>();
  for (const entry of entries) {
    const id = entry.ok ? entry.agent.id : entry.broken.id;
    if (!winners.has(id)) winners.set(id, entry);
  }
  const won = [...winners.values()];
  return {
    agents: won.flatMap((entry) => (entry.ok ? [entry.agent] : [])).sort(byId),
    broken: won.flatMap((entry) => (entry.ok ? [] : [entry.broken])).sort(byId),
    problems,
  };
}

const byId = (a: { id: AgentId }, b: { id: AgentId }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function toEntry(result: Result<Agent, ConfigProblem[]>, id: AgentId, owner: AgentOwner, problems: ConfigProblem[]): Entry {
  if (result.ok) return { ok: true, agent: result.value };
  problems.push(...result.error);
  return { ok: false, broken: { id, owner, problems: result.error } };
}

/** Names never read as agents: a README for the folder, and dotfiles (editor and OS files). */
const isSkipped = (name: string): boolean => name.startsWith(".") || name.toLowerCase() === "readme.md";

type ReadFile = typeof readConfigFile;

/** `read` decides whether a linked file is followed; a linked folder is never listed. */
async function loadFolder(folder: string, shown: string, owner: AgentOwner, problems: ConfigProblem[], read: ReadFile): Promise<Entry[]> {
  if (await isLink(folder)) {
    problems.push({ file: shown, message: LINK_REFUSED });
    return [];
  }
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith(".md") && !isSkipped(name)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") problems.push({ file: shown, message: code === "ENOTDIR" ? "isn't a folder" : `can't be listed (${code ?? "unknown error"})` });
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    // A file name can hold any character but "/": escape it like a value.
    const file = `${shown}/${clean(name, 100)}`;
    const stem = name.slice(0, -".md".length);
    const id = AgentIdSchema.safeParse(stem);
    if (!id.success) {
      problems.push({ file, message: `${quote(stem)} isn't a valid agent id: use lowercase letters, digits and hyphens (at most 64)` });
      continue;
    }
    const content = await read(join(folder, name), file);
    // Removed between the listing and the read.
    if (content.ok && content.value === undefined) continue;
    const parsed = content.ok ? parseAgentFile(content.value!, id.data, owner, file) : err([content.error]);
    entries.push(toEntry(parsed, id.data, owner, problems));
  }
  return entries;
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}
