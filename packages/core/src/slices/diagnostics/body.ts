// The one text form of diagnostics entries: what the Diagnostics page shows as "exactly what is
// sent", what Save as file writes and what Send all posts (before gzip). The body is
// `{"entries": [...]}` with the entries' texts as they are, so each entry's text is a verbatim
// slice of the body and nothing is added but that wrapper.
import type { DiagnosticEntry } from "../../kernel/schemas/index.js";

/** One entry as indented JSON, in the field order of its schema. */
export const entryText = (entry: DiagnosticEntry): string => JSON.stringify(entry, null, 2);

/** The body of entry texts made by `entryText`; at least one. */
export const diagnosticsBody = (texts: readonly string[]): string => `{"entries": [\n${texts.join(",\n")}\n]}\n`;

/** What one entry adds to a body, in bytes: its text and the separator. */
export const entryBodyBytes = (entry: DiagnosticEntry): number => Buffer.byteLength(entryText(entry)) + 2;

/** A body's bytes beyond the sum of `entryBodyBytes`: the wrapper, less the last separator. */
export const BODY_OVERHEAD_BYTES = 16;
