// Parse helpers: invalid input is a value, never a thrown error. Errors are plain issue lists,
// not zod errors. zod still shows in the public .d.ts through the record types (z.output) and
// the id brands.
import type { z } from "zod";
import { err, ok, type Result } from "../result/index.js";

export interface ParseIssue {
  /** Dotted path to the bad field, e.g. `steps.0.state`; empty for the root. */
  readonly path: string;
  readonly message: string;
}

export interface ParseError {
  readonly issues: readonly ParseIssue[];
}

export function parseWith<S extends z.ZodType>(schema: S, input: unknown): Result<z.output<S>, ParseError> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}
