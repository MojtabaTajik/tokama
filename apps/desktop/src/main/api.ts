// The bridge's query and command handlers. What the renderer sends is untrusted input: it is
// parsed with the engine API schemas before anything reaches the engine. Failures are reply
// values, like the engine's own errors, never thrown. No Electron here, so it is tested with a
// fake client.
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandReply, EngineClient, QueryReply } from "@tokama/client";
import { type Command, type CommandType, parseCommand, parseQuery, type ParseError, type QueryType } from "@tokama/core";
import { BRIDGE_ERROR_CODES } from "../shared/bridge.js";

type Failure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface EngineApi {
  query(input: unknown): Promise<QueryReply<QueryType>>;
  command(input: unknown): Promise<CommandReply<CommandType>>;
}

/** Queries whose replies carry a full path: only the main process sends them, never its window. */
const MAIN_ONLY_QUERIES: ReadonlySet<string> = new Set<QueryType>(["attempt_file"]);

/**
 * A repo's path in the setup is written for display, with the home folder as `~`, and the engine
 * asks for a full path when it tries a repo's checks or collects its files for a helper. The engine
 * runs as this user on this machine, so the window's `~/` stands for this user's home folder.
 */
function withFullPath(command: Command, home: string): Command {
  const full = (path: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
  if (command.type === "try_checks") return { ...command, path: full(command.path) };
  if (command.type === "run_helper") return { ...command, run: { ...command.run, input: { ...command.run.input, path: full(command.run.input.path) } } };
  return command;
}

/** `client` returns the connected client, or undefined when there is none. */
export function engineApi(client: () => EngineClient | undefined, home: string = homedir()): EngineApi {
  const own = mainQuery(client);
  return {
    query: async (input) => {
      const query = parseQuery(input);
      if (!query.ok) return invalid("query", query.error);
      if (MAIN_ONLY_QUERIES.has(query.value.type)) {
        return { ok: false, error: { code: BRIDGE_ERROR_CODES.invalidRequest, message: `the app asks "${query.value.type}" itself` } };
      }
      return own(query.value);
    },
    command: async (input) => {
      const command = parseCommand(input);
      if (!command.ok) return invalid("command", command.error);
      // The window reports errors and usage through their own narrow channels; the main process
      // composes the report, so the window never names its source or fields.
      if (command.value.type === "report_diagnostic") {
        return { ok: false, error: { code: BRIDGE_ERROR_CODES.invalidRequest, message: "the app sends diagnostics reports itself" } };
      }
      return (await client()?.command(withFullPath(command.value, home))) ?? notConnected();
    },
  };
}

/** Any query, the main-only ones too, validated the same way: for the main process's own use. */
export function mainQuery(client: () => EngineClient | undefined): (input: unknown) => Promise<QueryReply<QueryType>> {
  return async (input) => {
    const query = parseQuery(input);
    if (!query.ok) return invalid("query", query.error);
    return (await client()?.query(query.value)) ?? notConnected();
  };
}

function invalid(what: string, error: ParseError): Failure {
  const issues = error.issues.map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`));
  return { ok: false, error: { code: BRIDGE_ERROR_CODES.invalidRequest, message: `not a valid ${what}: ${issues.join("; ")}` } };
}

function notConnected(): Failure {
  return { ok: false, error: { code: BRIDGE_ERROR_CODES.notConnected, message: "the app is not connected to the engine" } };
}
