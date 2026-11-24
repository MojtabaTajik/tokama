// Id formats.
// - Names are ids the engineer writes in config and templates (`local-investigator`, `app-insights`):
//   lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters.
// - Generated ids are `<prefix>_<lowercase UUID>` (`item_0b9f...`), made by the engine.
import { z } from "zod";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be lowercase letters, digits and hyphens (at most 64)");
const generated = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`), `must be ${prefix}_<uuid>`);

export const TemplateIdSchema = name.brand<"TemplateId">();
export const AgentIdSchema = name.brand<"AgentId">();
export const RepoIdSchema = name.brand<"RepoId">();
export const ConnectionIdSchema = name.brand<"ConnectionId">();
/** A step's id inside its template (`build`); `back: <id>` and references use it. */
export const StepIdSchema = name.brand<"StepId">();
/**
 * A template as the engine refers to it: `<repo id>/<template id>` for a repo's template,
 * `builtin/<template id>` for one that ships with Tokama. Two repos can each have a `quick-fix`.
 */
export const TemplateRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/, "must be <repo>/<template id> or builtin/<template id>")
  .brand<"TemplateRef">();
export const ItemIdSchema = generated("item").brand<"ItemId">();
export const CallIdSchema = generated("call").brand<"CallId">();
/** A question the engine put to the engineer (plan approval, cloud-step approval, retry or stop, quota). */
export const DecisionIdSchema = generated("decision").brand<"DecisionId">();

export type TemplateId = z.output<typeof TemplateIdSchema>;
export type AgentId = z.output<typeof AgentIdSchema>;
export type RepoId = z.output<typeof RepoIdSchema>;
export type ConnectionId = z.output<typeof ConnectionIdSchema>;
export type StepId = z.output<typeof StepIdSchema>;
export type TemplateRef = z.output<typeof TemplateRefSchema>;
export type ItemId = z.output<typeof ItemIdSchema>;
export type CallId = z.output<typeof CallIdSchema>;
export type DecisionId = z.output<typeof DecisionIdSchema>;

/** Milliseconds since the Unix epoch, as the kernel clock returns them. */
export const EpochMsSchema = z.int().nonnegative();
