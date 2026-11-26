// What the `ai_clis` query answers: each AI CLI Tokama knows, with its state on this machine and
// what Tokama runs. Plain data and no secrets: argument words with placeholders (`{model}`,
// `{role}`), and environment variable names, never values.
import { z } from "zod";
import { AiCliIdSchema } from "./ids.js";

const text = z.string().min(1).max(500);
const words = z.array(z.string().min(1).max(1000)).max(50);

/** How far the CLI can run agents. `not_checked`: this engine runs no health checks (sample mode). */
export const AiCliStateSchema = z.enum(["ready", "not_installed", "not_logged_in", "no_answer", "not_checked"]);

const base = { cliId: AiCliIdSchema, name: text, description: text };

export const AiCliSchema = z.discriminatedUnion("supported", [
  /** Listed so the page names it; Tokama cannot run it yet. */
  z.strictObject({ supported: z.literal(false), ...base }),
  z.strictObject({
    supported: z.literal(true),
    ...base,
    state: AiCliStateSchema,
    version: text.optional(),
    /** The file that runs, on the PATH a call gets; absent when not found. */
    path: z.string().min(1).max(4096).optional(),
    /** What is wrong, in plain words: why the CLI cannot run agents, or which steps it cannot run. */
    message: z.string().min(1).max(1000).optional(),
    /** What to type in a terminal to sign in. */
    loginCommand: text,
    command: text,
    headlessArgs: words,
    modelArgs: words,
    /** For a read-only step; steps that edit, run commands or use the web add to it. */
    permissionArgs: words,
    /** Where the step's prompt goes. */
    promptVia: z.enum(["stdin", "argument"]),
    /** The agent's role, as arguments. */
    roleArgs: words,
    /** Names of the environment variables the CLI gets. */
    envNames: z.array(z.string().min(1).max(100)).max(50),
    /** Names of the agents that run on this CLI. */
    usedBy: z.array(z.string().min(1).max(100)).max(200),
  }),
]);

export const AiCliListSchema = z.strictObject({ clis: z.array(AiCliSchema).max(10) });

export type AiCliState = z.output<typeof AiCliStateSchema>;
export type AiCli = z.output<typeof AiCliSchema>;
export type AiCliList = z.output<typeof AiCliListSchema>;
