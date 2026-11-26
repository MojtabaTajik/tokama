// Id formats.
// - Names are ids the engineer writes in config and templates (`local-investigator`, `app-insights`):
//   lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters.
// - Generated ids are `<prefix>_<lowercase UUID>` (`item_0b9f...`), made by the engine.
import { z } from "zod";

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be lowercase letters, digits and hyphens (at most 64)");
const generated = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`), `must be ${prefix}_<uuid>`);

/** The AI CLIs and model hosts Tokama drives. Clients map the id to a label. */
export const AiCliIdSchema = z.enum(["claude-code", "codex-cli", "ollama"]);
export const TemplateIdSchema = name.brand<"TemplateId">();
export const AgentIdSchema = name.brand<"AgentId">();
export const RepoIdSchema = name.brand<"RepoId">();
/** Template refs are <repo>/<id>; these first words are Tokama's own (built-in and personal templates), so no repo may take them. */
export const RESERVED_REPO_IDS: readonly string[] = ["builtin", "personal"];
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
/** The machine that created a record. Made once per machine and kept in Tokama's home folder. */
export const HostIdSchema = generated("host").brand<"HostId">();
/** One diagnostics entry. */
export const DiagnosticIdSchema = generated("diag").brand<"DiagnosticId">();
/**
 * This install, for diagnostics only: random, never derived from the machine, and replaced when
 * the user resets it. Unlike the host id, it ties no record to a machine for good.
 */
export const InstallIdSchema = generated("install").brand<"InstallId">();
/** One run of the engine, from its start to its stop. */
export const SessionIdSchema = generated("session").brand<"SessionId">();

/** The small AI tasks Tokama runs for itself, by id. Clients map the id to a label. */
export const HelperIdSchema = z.enum(["suggest-checks"]);
/** One run of a helper. */
export const HelperRunIdSchema = generated("hrun").brand<"HelperRunId">();
/** One Try checks run. */
export const CheckTrialIdSchema = generated("trial").brand<"CheckTrialId">();

export type HelperId = z.output<typeof HelperIdSchema>;
export type HelperRunId = z.output<typeof HelperRunIdSchema>;
export type CheckTrialId = z.output<typeof CheckTrialIdSchema>;
export type TemplateId = z.output<typeof TemplateIdSchema>;
export type AgentId = z.output<typeof AgentIdSchema>;
export type RepoId = z.output<typeof RepoIdSchema>;
export type ConnectionId = z.output<typeof ConnectionIdSchema>;
export type StepId = z.output<typeof StepIdSchema>;
export type TemplateRef = z.output<typeof TemplateRefSchema>;
export type ItemId = z.output<typeof ItemIdSchema>;
export type CallId = z.output<typeof CallIdSchema>;
export type DecisionId = z.output<typeof DecisionIdSchema>;
export type HostId = z.output<typeof HostIdSchema>;
export type DiagnosticId = z.output<typeof DiagnosticIdSchema>;
export type InstallId = z.output<typeof InstallIdSchema>;
export type SessionId = z.output<typeof SessionIdSchema>;

/** Milliseconds since the Unix epoch, as the kernel clock returns them. */
export const EpochMsSchema = z.int().nonnegative();

/**
 * A new generated id: `<prefix>_<UUIDv7>`. The first 48 bits are `nowMs`, so ids sort by creation
 * time; the rest is random. Uses Web Crypto, so it runs in every client too.
 */
export function newId<P extends string>(prefix: P, nowMs: number): `${P}_${string}` {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
