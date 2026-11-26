// One line of a JSON Lines file or stream, parsed without throwing.
import { err, ok, type Result } from "../result/index.js";

/** The line's JSON value, or why it is not JSON. */
export function parseJsonLine(line: string): Result<unknown, string> {
  try {
    return ok(JSON.parse(line) as unknown);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
