// The records the engine API serves for what is set up on this machine: what the sidebar, the New
// work input and the per-template board view need. Templates here are summaries; the full
// template file format comes with the templates slice.
import { z } from "zod";
import { AgentIdSchema, AiCliIdSchema, ConnectionIdSchema, RepoIdSchema, TemplateRefSchema } from "./ids.js";
import { ConnectionUsesSchema, DataRuleSchema, ItemKindSchema, StageSchema } from "./item.js";
import { IconNameSchema, StartNeedSchema, TagColorSchema } from "./template.js";

const label = z.string().min(1).max(100);

const command = z.string().min(1).max(500);

export const RepoSummarySchema = z.strictObject({
  id: RepoIdSchema,
  baseBranch: label,
  /** Set only on the fake engine's sample repos: they aren't in repos.yaml, so they can't be removed. */
  sample: z.literal(true).optional(),
  /** The repo's own check commands; a step with checks from the repo runs these. */
  checks: z.array(command).max(20),
  /** The repo's folder on the engine's machine, for display, with the home folder as `~`. */
  path: z.string().min(1).max(4096).optional(),
});

export const ConnectionSummarySchema = z.strictObject({
  id: ConnectionIdSchema,
  name: label,
  /** The connector, e.g. "App Insights", "Postgres", "MCP server". */
  type: label,
});

/** Listed in join order; clients give identity dots by that order. */
export const AgentSummarySchema = z.strictObject({
  id: AgentIdSchema,
  name: label,
  /** The AI CLI that runs it. */
  cliId: AiCliIdSchema,
  model: label,
  /** Where the model runs: on this machine or at a cloud provider. */
  runsOn: z.enum(["local", "cloud"]),
});

export const TemplateStepSchema = z.strictObject({
  name: label,
  stage: StageSchema,
  /** Absent for steps Tokama runs itself, such as checks. */
  agentId: AgentIdSchema.optional(),
  data: DataRuleSchema,
  /** The connections this step may use: a subset of the template's. */
  uses: ConnectionUsesSchema.optional(),
  /**
   * The agent this step would run now, by the file that defines it: whose it is and what it may do.
   * Absent when the agent cannot run (not set up, broken, or not supported yet).
   */
  agentAccess: z
    .strictObject({
      name: label,
      /** Built in, the engineer's own, or shared by the template's repo. */
      owner: z.enum(["builtin", "personal", "repo"]),
      /** For a repo agent: the repo that shares it. */
      repoId: RepoIdSchema.optional(),
      /** The AI CLI and model this agent runs on, as resolved for this step. */
      cliId: AiCliIdSchema.optional(),
      model: label.optional(),
      /** The first line of the agent's role text, cut to fit. */
      role: z.string().min(1).max(200).optional(),
      edit: z.boolean(),
      /** Shell commands it may run, as command-policy rules. */
      commands: z.array(z.string().min(1).max(200)).max(50),
      web: z.boolean(),
    })
    .optional(),
  /** The checks Tokama runs after the step's agent: the picked repo's, or the template's own commands. */
  checks: z.union([z.strictObject({ from: z.literal("repo") }), z.strictObject({ commands: z.array(command).min(1).max(20) })]).optional(),
});

export const TemplateSummarySchema = z.strictObject({
  /** The template's ref: `<repo>/<id>` or `builtin/<id>`. */
  id: TemplateRefSchema,
  name: label,
  kind: ItemKindSchema,
  /** A Font Awesome Free icon name; clients draw a neutral icon for a name they do not know. */
  icon: IconNameSchema.optional(),
  /** The tag colour of the icon. */
  color: TagColorSchema.optional(),
  /** The connections the template may use, with the access it asks for ("query", "read-only"). */
  connections: ConnectionUsesSchema,
  steps: z.array(TemplateStepSchema).min(1),
  /** What New work asks for, and whether the template waits for approval before cloud steps. */
  start: z.strictObject({ needs: z.array(StartNeedSchema).max(3), askBeforeCloud: z.boolean() }),
  /** Runs in the item's new worktree before the first step, with the engineer's rights. */
  setup: command.optional(),
  /** Things the template does that the engineer may not expect, or why a step cannot run now. */
  warnings: z.array(z.string().min(1).max(1000)).max(50),
});

/** The state of one AI CLI on this machine, as the engine last checked it. */
export const CliHealthSchema = z.strictObject({
  cliId: AiCliIdSchema,
  installed: z.boolean(),
  loggedIn: z.boolean(),
  /** The check did not finish in time, so `installed` and `loggedIn` are not known. */
  timedOut: z.literal(true).optional(),
  version: label.optional(),
  /** What is wrong, in plain words, when the CLI cannot run agents. */
  message: z.string().min(1).max(1000).optional(),
});

/** What the engine found wrong with this machine: tools, AI CLIs and config files. */
export const HealthSchema = z.strictObject({
  git: z.strictObject({ ok: z.boolean(), version: label.optional(), message: z.string().min(1).max(1000).optional() }),
  clis: z.array(CliHealthSchema).max(10),
  /** The GitHub CLI, which opens pull requests; absent when the engine did not check it. */
  gh: z.strictObject({ installed: z.boolean(), loggedIn: z.boolean(), message: z.string().min(1).max(1000).optional() }).optional(),
  /** Config files that did not load (repos.yaml, agents, templates), each with its problem. */
  config: z.array(z.strictObject({ file: z.string().min(1).max(300), message: z.string().min(1).max(1000) })).max(100),
});

/** Everything set up on this machine: one set of repos, connections, agents and templates. */
export const SetupSchema = z.strictObject({
  repos: z.array(RepoSummarySchema),
  connections: z.array(ConnectionSummarySchema),
  agents: z.array(AgentSummarySchema),
  templates: z.array(TemplateSummarySchema),
  health: HealthSchema,
});

export type AiCliId = z.output<typeof AiCliIdSchema>;
export type RepoSummary = z.output<typeof RepoSummarySchema>;
export type ConnectionSummary = z.output<typeof ConnectionSummarySchema>;
export type AgentSummary = z.output<typeof AgentSummarySchema>;
export type TemplateStep = z.output<typeof TemplateStepSchema>;
export type TemplateSummary = z.output<typeof TemplateSummarySchema>;
export type CliHealth = z.output<typeof CliHealthSchema>;
export type Health = z.output<typeof HealthSchema>;
export type Setup = z.output<typeof SetupSchema>;
