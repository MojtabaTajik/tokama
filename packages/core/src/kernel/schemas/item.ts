// Item and step records (product.md, section 3). Steps are stored inside their item, so the
// item's schema version covers them.
import { z } from "zod";
import { AgentIdSchema, EpochMsSchema, ItemIdSchema, TemplateIdSchema, WorkspaceIdSchema } from "./ids.js";

/** The board column a step counts as. */
export const StageSchema = z.enum(["queued", "working", "verifying", "review", "done"]);
export const ItemKindSchema = z.enum(["task", "investigation"]);
export const StepStateSchema = z.enum(["pending", "running", "needs_you", "passed", "failed", "stopped"]);
export const ItemStateSchema = z.enum(["queued", "running", "needs_you", "done", "failed", "stopped"]);

export const StepRecordSchema = z.strictObject({
  name: z.string().min(1),
  stage: StageSchema,
  state: StepStateSchema,
  /** Absent for steps Tokama runs itself, such as checks. */
  agentId: AgentIdSchema.optional(),
});

export const ITEM_SCHEMA_VERSION = 1;

export const ItemRecordSchema = z.strictObject({
  schemaVersion: z.literal(ITEM_SCHEMA_VERSION),
  id: ItemIdSchema,
  kind: ItemKindSchema,
  workspaceId: WorkspaceIdSchema,
  templateId: TemplateIdSchema,
  title: z.string().min(1).max(200),
  state: ItemStateSchema,
  createdAt: EpochMsSchema,
  steps: z.array(StepRecordSchema),
});

export type Stage = z.output<typeof StageSchema>;
export type ItemKind = z.output<typeof ItemKindSchema>;
export type StepState = z.output<typeof StepStateSchema>;
export type ItemState = z.output<typeof ItemStateSchema>;
export type StepRecord = z.output<typeof StepRecordSchema>;
export type ItemRecord = z.output<typeof ItemRecordSchema>;
