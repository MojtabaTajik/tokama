// What the `agents_list` query answers: every agent the engineer has, with where its file is and
// what is wrong with the files that do not load. Plain data: no paths, so a record stays valid on
// another machine; `source` is relative to Tokama's home or the repo.
import { z } from "zod";
import { AgentIdSchema, RepoIdSchema } from "./ids.js";
import { AiCliIdSchema } from "./setup.js";
import { IconNameSchema } from "./template.js";

const label = z.string().min(1).max(100);

/** Most entries of each list; the engine tells when it left some out. */
export const MAX_LISTED_AGENTS = 200;
/** Longest role text sent; the page shows the start of a longer one. */
export const MAX_ROLE_CHARS = 4000;

export const AgentOwnerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("builtin") }),
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("repo"), repoId: RepoIdSchema }),
]);

export const AgentDetailSchema = z.strictObject({
  id: AgentIdSchema,
  name: label,
  cliId: AiCliIdSchema,
  /** For a local model: the CLI that drives it. */
  drivenBy: z.enum(["claude-code", "codex-cli"]).optional(),
  model: label,
  runsOn: z.enum(["local", "cloud"]),
  limits: z.strictObject({
    edit: z.boolean(),
    commands: z.array(z.string().min(1).max(500)).max(100),
    web: z.boolean(),
  }),
  icon: IconNameSchema.optional(),
  /** The role instructions, cut to MAX_ROLE_CHARS. */
  role: z.string().max(MAX_ROLE_CHARS),
  roleCut: z.boolean(),
  owner: AgentOwnerSchema,
  /** A personal or shared file with the id of a built-in agent: the built-in is not used. */
  replacesBuiltin: z.boolean(),
  /** The agent's file: `builtin/<id>.md`, `agents/<id>.md` in Tokama's home, or `<repo>/.tokama/agents/<id>.md`. */
  source: z.string().min(1).max(300),
});

/** An agent file that does not load; it still claims its id. */
export const BrokenAgentDetailSchema = z.strictObject({
  id: AgentIdSchema,
  owner: AgentOwnerSchema,
  source: z.string().min(1).max(300),
  replacesBuiltin: z.boolean(),
  /** In plain words, with line numbers. The last entry says how many more there were, when some are left out. */
  problems: z.array(z.string().min(1).max(1000)).min(1).max(50),
});

export const AgentsListSchema = z.strictObject({
  agents: z.array(AgentDetailSchema).max(MAX_LISTED_AGENTS),
  broken: z.array(BrokenAgentDetailSchema).max(MAX_LISTED_AGENTS),
  /** Problems that belong to no listed agent: a bad file name, a refused link, an unreadable folder. */
  problems: z.array(z.string().min(1).max(1000)).max(MAX_LISTED_AGENTS),
});

export type AgentOwner = z.output<typeof AgentOwnerSchema>;
export type AgentDetail = z.output<typeof AgentDetailSchema>;
export type BrokenAgentDetail = z.output<typeof BrokenAgentDetailSchema>;
export type AgentsList = z.output<typeof AgentsListSchema>;
