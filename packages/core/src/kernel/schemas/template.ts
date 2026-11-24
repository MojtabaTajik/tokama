// A template as the engine runs it: every default filled in, every reference checked, instruction
// files read into text. Items keep a copy of it from their start, so it holds no absolute paths and
// carries its own schema version. The YAML file format that produces it belongs to the templates
// slice.
import { z } from "zod";
import { AgentIdSchema, ConnectionIdSchema, RepoIdSchema, StepIdSchema, TemplateIdSchema, TemplateRefSchema, type StepId } from "./ids.js";
import { DataRuleSchema } from "./item.js";

/** The 8 tag colours; a template or step colours its icon with one. */
export const TagColorSchema = z.enum(["slate", "sky", "teal", "moss", "sand", "clay", "rose", "plum"]);
/** A Font Awesome Free icon name, e.g. `screwdriver-wrench`. */
export const IconNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be an icon name such as screwdriver-wrench");
export const RepoAccessSchema = z.enum(["read", "edit"]);
export const DoneWhenSchema = z.enum(["agent finishes", "checks pass", "reviewer approves", "you approve"]);
/** What the New work input asks for: the text, exactly one repo, or one or more repos. */
export const StartNeedSchema = z.enum(["text", "repo", "repos"]);
export const FinishSchema = z.enum(["commit", "pull-request", "findings", "document", "update-tickets"]);

/** A connection a template or step may use, with the access it asks for ("query", "write"). */
export const ConnectionUseSchema = z.strictObject({ connectionId: ConnectionIdSchema, access: z.string().min(1).max(100) });

const back = z.strictObject({ action: z.literal("back"), stepId: StepIdSchema });
export const IfFailedSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("retry") }),
  back,
  z.strictObject({ action: z.literal("ask") }),
  z.strictObject({ action: z.literal("stop") }),
]);
export const IfChangesRequestedSchema = z.discriminatedUnion("action", [back, z.strictObject({ action: z.literal("ask") })]);

export const TemplateStepDefSchema = z.strictObject({
  id: StepIdSchema,
  name: z.string().min(1).max(100),
  agentId: AgentIdSchema,
  instructions: z.strictObject({
    /** The instruction file, relative to the template file; absent for inline text. */
    file: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(65_536),
  }),
  doneWhen: DoneWhenSchema,
  /**
   * Only on a `checks pass` step: the checks Tokama runs itself after the agent, either the ones
   * the repo's config lists or the template's own commands.
   */
  checks: z.union([z.strictObject({ from: z.literal("repo") }), z.strictObject({ commands: z.array(z.string().min(1).max(500)).min(1).max(20) })]).optional(),
  ifFailed: IfFailedSchema,
  /** Only on a `reviewer approves` step. */
  ifChangesRequested: IfChangesRequestedSchema.optional(),
  /** How often the step may run in one item; at the limit the item asks the engineer. */
  maxAttempts: z.int().min(1).max(10),
  data: DataRuleSchema,
  /** The earlier steps whose results this step gets. */
  sees: z.array(StepIdSchema).max(20),
  /** The template connections this step may use. */
  connections: z.array(ConnectionUseSchema).max(20),
  /** The template commands this step's agent may run. */
  commands: z.array(z.string().min(1).max(200)).max(50),
  icon: IconNameSchema.optional(),
  color: TagColorSchema.optional(),
});

export const TEMPLATE_SCHEMA_VERSION = 1;

export const TemplateRecordSchema = z.strictObject({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  ref: TemplateRefSchema,
  id: TemplateIdSchema,
  /** Where the file lives: shipped with Tokama, or a repo-relative path in a repo. */
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("builtin") }),
    z.strictObject({ kind: z.literal("repo"), repoId: RepoIdSchema, file: z.string().min(1).max(300) }),
  ]),
  name: z.string().min(1).max(100),
  icon: IconNameSchema.optional(),
  color: TagColorSchema.optional(),
  uses: z.strictObject({
    repos: z.strictObject({
      /** The access the repos picked at Start get; absent when Start picks none. */
      picked: RepoAccessSchema.optional(),
      /** Repos the template names itself. */
      named: z.array(z.strictObject({ repoId: RepoIdSchema, access: RepoAccessSchema })).max(20),
    }),
    connections: z.array(ConnectionUseSchema).max(20),
    /** Allowlisted CLI commands the agents may run, e.g. `gh`, `az boards`. */
    commands: z.array(z.string().min(1).max(200)).max(50),
  }),
  start: z.strictObject({
    needs: z.array(StartNeedSchema).max(3),
    askBeforeCloud: z.boolean(),
    notify: z.boolean(),
  }),
  /** Runs in a new worktree before the first step, e.g. `pnpm install`. */
  setup: z.string().min(1).max(500).optional(),
  steps: z.array(TemplateStepDefSchema).min(1).max(20),
  finish: z.array(FinishSchema).min(1).max(5),
  budget: z.strictObject({ timeMinutes: z.int().min(1).max(1440) }).optional(),
});

export type TagColor = z.output<typeof TagColorSchema>;
export type RepoAccess = z.output<typeof RepoAccessSchema>;
export type DoneWhen = z.output<typeof DoneWhenSchema>;
export type StartNeed = z.output<typeof StartNeedSchema>;
export type Finish = z.output<typeof FinishSchema>;
export type ConnectionUse = z.output<typeof ConnectionUseSchema>;
export type IfFailed = z.output<typeof IfFailedSchema>;
export type IfChangesRequested = z.output<typeof IfChangesRequestedSchema>;
export type TemplateStepDef = z.output<typeof TemplateStepDefSchema>;
export type TemplateRecord = z.output<typeof TemplateRecordSchema>;

/**
 * The steps whose results come from connections: steps that use a connection, and steps that see
 * one of those, followed until nothing changes, so a `sees` that points forward cannot hide a chain.
 */
export function connectionDerivedSteps(steps: readonly Pick<TemplateStepDef, "id" | "connections" | "sees">[]): Set<StepId> {
  const derived = new Set<StepId>(steps.filter((step) => step.connections.length > 0).map((step) => step.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const step of steps) {
      if (!derived.has(step.id) && step.sees.some((seen) => derived.has(seen))) {
        derived.add(step.id);
        grew = true;
      }
    }
  }
  return derived;
}
