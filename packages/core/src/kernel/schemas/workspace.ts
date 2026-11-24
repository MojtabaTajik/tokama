// Workspace records as the engine API serves them: what the workspaces panel, the workspace
// header, the New work input and the per-template board view need (product.md, sections 3
// and 6). Templates here are summaries; the full template file format comes with the
// templates slice.
import { z } from "zod";
import { AgentIdSchema, ConnectionIdSchema, RepoIdSchema, TemplateIdSchema, WorkspaceIdSchema } from "./ids.js";
import { DataRuleSchema, ItemKindSchema, StageSchema } from "./item.js";

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

/** Listed in join order; clients give identity dots by that order. */
export const AgentSummarySchema = z.strictObject({
  id: AgentIdSchema,
  name: label,
  /** The AI CLI that runs it, e.g. "Claude Code". */
  cli: label,
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
});

export const TemplateSummarySchema = z.strictObject({
  id: TemplateIdSchema,
  name: label,
  kind: ItemKindSchema,
  /** The connections the template may use, with the access it asks for ("query", "read-only"). */
  connections: z.array(z.strictObject({ id: ConnectionIdSchema, access: label })),
  steps: z.array(TemplateStepSchema).min(1),
});

export const WorkspaceSummarySchema = z.strictObject({
  id: WorkspaceIdSchema,
  name: label,
  /** The host that runs the workspace. v1: "local" only. */
  host: label,
  repos: z.array(RepoSummarySchema),
  connections: z.array(ConnectionSummarySchema),
  agents: z.array(AgentSummarySchema),
  templates: z.array(TemplateSummarySchema),
});

export type RepoSummary = z.output<typeof RepoSummarySchema>;
export type ConnectionSummary = z.output<typeof ConnectionSummarySchema>;
export type AgentSummary = z.output<typeof AgentSummarySchema>;
export type TemplateStep = z.output<typeof TemplateStepSchema>;
export type TemplateSummary = z.output<typeof TemplateSummarySchema>;
export type WorkspaceSummary = z.output<typeof WorkspaceSummarySchema>;
