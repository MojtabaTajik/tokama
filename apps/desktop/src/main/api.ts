// The bridge's query and command handlers. What the renderer sends is untrusted input: it is
// parsed with the engine API schemas before anything reaches the engine. Failures are reply
// values, like the engine's own errors, never thrown. No Electron here, so it is tested with a
// fake client.
import type { CommandReply, EngineClient, QueryReply } from "@tokama/client";
import { type CommandType, parseCommand, parseQuery, type ParseError, type QueryType } from "@tokama/core";
import { BRIDGE_ERROR_CODES } from "../shared/bridge.js";

type Failure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface EngineApi {
  query(input: unknown): Promise<QueryReply<QueryType>>;
  command(input: unknown): Promise<CommandReply<CommandType>>;
}

/** Queries whose replies carry a full path: only the main process sends them, never its window. */
const MAIN_ONLY_QUERIES: ReadonlySet<string> = new Set<QueryType>(["attempt_file"]);

/** `client` returns the connected client, or undefined when there is none. */
export function engineApi(client: () => EngineClient | undefined): EngineApi {
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
      return (await client()?.command(command.value)) ?? notConnected();
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
