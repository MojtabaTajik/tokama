// The template file format: what an engineer writes in `.tokama/templates/<id>.yaml`. Field names
// are snake_case and most fields are optional; `validate.ts` fills the defaults and turns a parsed
// file into a TemplateRecord.
import { z } from "zod";
import {
  AgentIdSchema,
  ConnectionAccessSchema,
  ConnectionIdSchema,
  DataRuleSchema,
  DoneWhenSchema,
  FinishSchema,
  IconNameSchema,
  RepoAccessSchema,
  RepoIdSchema,
  StartNeedSchema,
  StepIdSchema,
  TagColorSchema,
} from "../../kernel/schemas/index.js";

/** `90m`, `2h`, `1h30m`. */
export const DURATION = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?$/;

const MAX_ENTRIES = 20;
const fewEntries = (value: object) => Object.keys(value).length <= MAX_ENTRIES;
const tooMany = `has more than ${MAX_ENTRIES} entries`;
const connections = z.record(ConnectionIdSchema, ConnectionAccessSchema).refine(fewEntries, tooMany);
const back = z.strictObject({ back: StepIdSchema });

export const StepFileSchema = z.strictObject({
  id: StepIdSchema,
  name: z.string().min(1).max(100),
  agent: AgentIdSchema,
  /** A `.md` file next to the template (one line, no spaces), or the instruction text itself. */
  instructions: z.string().min(1).max(65_536),
  done_when: DoneWhenSchema.optional(),
  /** `from-repo` runs the checks the repo's config lists; a list names the commands. */
  checks: z.union([z.literal("from-repo"), z.array(z.string().min(1).max(500)).max(20)]).optional(),
  if_failed: z.union([z.enum(["retry", "ask", "stop"]), back]).optional(),
  if_changes_requested: z.union([z.literal("ask"), back]).optional(),
  max_attempts: z.int().min(1).max(10).optional(),
  data: DataRuleSchema.optional(),
  sees: z.array(StepIdSchema).max(20).optional(),
  uses: z.strictObject({ connections: connections.optional() }).optional(),
  icon: IconNameSchema.optional(),
  color: TagColorSchema.optional(),
});

/** The file format's version; a later format can be migrated from it. */
export const TEMPLATE_FORMAT = 1;

export const TemplateFileSchema = z.strictObject({
  format: z.literal(TEMPLATE_FORMAT),
  name: z.string().min(1).max(100),
  icon: IconNameSchema.optional(),
  color: TagColorSchema.optional(),
  uses: z
    .strictObject({
      /** A word gives that access to the repos picked at Start; a map names repos. */
      repos: z.union([RepoAccessSchema, z.record(RepoIdSchema, RepoAccessSchema).refine(fewEntries, tooMany)]).optional(),
      connections: connections.optional(),
    })
    .optional(),
  start: z
    .strictObject({
      needs: z.array(StartNeedSchema).max(3).optional(),
      ask_before_cloud: z.boolean().optional(),
      notify: z.boolean().optional(),
    })
    .optional(),
  setup: z.string().min(1).max(500).optional(),
  budget: z.strictObject({ time: z.string().regex(DURATION, "must be a time such as 90m, 2h or 1h30m") }).optional(),
  steps: z.array(StepFileSchema).min(1).max(20),
  finish: z.array(FinishSchema).min(1).max(5),
});

export type StepFile = z.output<typeof StepFileSchema>;
export type TemplateFile = z.output<typeof TemplateFileSchema>;

/** The fixed words each field takes, for "did you mean" and for messages. */
export const FIELD_WORDS: Readonly<Record<string, readonly string[]>> = {
  color: TagColorSchema.options,
  format: ["1"],
  repos: RepoAccessSchema.options,
  needs: StartNeedSchema.options,
  finish: FinishSchema.options,
  done_when: DoneWhenSchema.options,
  data: DataRuleSchema.options,
  if_failed: ["retry", "ask", "stop", "back: <step id>"],
  if_changes_requested: ["ask", "back: <step id>"],
  checks: ["from-repo", "a list of commands"],
};

/** The field names allowed at a place in the file, for "did you mean" on an unknown field. */
export function knownFields(path: readonly PropertyKey[]): readonly string[] {
  const shape = (schema: z.ZodObject) => Object.keys(schema.shape);
  const [first, , third] = path;
  if (path.length === 0) return shape(TemplateFileSchema);
  if (first === "uses" && path.length === 1) return ["repos", "connections"];
  if (first === "start" && path.length === 1) return ["needs", "ask_before_cloud", "notify"];
  if (first === "budget" && path.length === 1) return ["time"];
  if (first === "steps" && path.length === 2) return shape(StepFileSchema);
  if (first === "steps" && path.length === 3 && third === "uses") return ["connections"];
  if (first === "steps" && path.length === 3) return ["back"];
  return [];
}
