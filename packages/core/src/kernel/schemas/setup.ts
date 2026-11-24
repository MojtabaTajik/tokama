// The records the engine API serves for what is set up on this machine: what the sidebar, the New
// work input and the per-template board view need. Templates here are summaries; the full
// template file format comes with the templates slice.
import { z } from "zod";
import { AgentIdSchema, ConnectionIdSchema, RepoIdSchema, TemplateIdSchema } from "./ids.js";
import { ConnectionUsesSchema, DataRuleSchema, ItemKindSchema, StageSchema } from "./item.js";

const label = z.string().min(1).max(100);

export const RepoSummarySchema = z.strictObject({
  id: RepoIdSchema,
  baseBranch: label,
});

export const ConnectionSummarySchema = z.strictObject({
  id: ConnectionIdSchema,
  name: label,
  /** The connector, e.g. "App Insights", "Postgres", "MCP server". */
  type: label,
});

/** The AI CLIs and model hosts Tokama drives. Clients map the id to a label. */
export const AiCliIdSchema = z.enum(["claude-code", "codex-cli", "ollama"]);

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
});

export const TemplateSummarySchema = z.strictObject({
  id: TemplateIdSchema,
  name: label,
  kind: ItemKindSchema,
  /** The connections the template may use, with the access it asks for ("query", "read-only"). */
  connections: ConnectionUsesSchema,
  steps: z.array(TemplateStepSchema).min(1),
});

/** Everything set up on this machine: one set of repos, connections, agents and templates. */
export const SetupSchema = z.strictObject({
  repos: z.array(RepoSummarySchema),
  connections: z.array(ConnectionSummarySchema),
  agents: z.array(AgentSummarySchema),
  templates: z.array(TemplateSummarySchema),
});

export type AiCliId = z.output<typeof AiCliIdSchema>;
export type RepoSummary = z.output<typeof RepoSummarySchema>;
export type ConnectionSummary = z.output<typeof ConnectionSummarySchema>;
export type AgentSummary = z.output<typeof AgentSummarySchema>;
export type TemplateStep = z.output<typeof TemplateStepSchema>;
export type TemplateSummary = z.output<typeof TemplateSummarySchema>;
export type Setup = z.output<typeof SetupSchema>;
