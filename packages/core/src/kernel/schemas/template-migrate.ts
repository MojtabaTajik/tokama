// Brings a stored template record up to the current schema version before the strict parse, so an
// item started under an older version still opens after the record changes.
import { err, ok, type Result } from "../result/index.js";
import type { ParseError } from "./parse.js";
import { TEMPLATE_SCHEMA_VERSION } from "./template.js";

/** Why a stored template record cannot be read. */
export interface TemplateRecordError extends ParseError {
  /** Set when a newer Tokama wrote the record: its schemaVersion. */
  readonly newerVersion?: number;
}

/**
 * One step of the chain: takes a record of version n and returns it as version n + 1. Pure, and it
 * never changes its input. The chain sets `schemaVersion` itself.
 */
export type TemplateRecordStep = (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/**
 * The steps by the version they upgrade from: `{ 1: v1ToV2 }`. Every change to TemplateRecord bumps
 * TEMPLATE_SCHEMA_VERSION and adds one tested step here. Empty while the version is 1.
 */
export const TEMPLATE_RECORD_STEPS: Readonly<Record<number, TemplateRecordStep>> = {};

export const newerTemplateRecordMessage = (version: number): string =>
  `This item was started by a newer Tokama (template record version ${version}). Update Tokama to open it.`;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Brings a stored record up to `current` through `steps`. Input that is not a record with a usable
 * version passes through unchanged for the strict parse to report. The input is never changed,
 * because the item log's hash covers the stored JSON.
 */
export function migrateRecord(
  input: unknown,
  steps: Readonly<Record<number, TemplateRecordStep>>,
  current: number,
): Result<unknown, TemplateRecordError> {
  if (!isPlainObject(input)) return ok(input);
  let version = input.schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return ok(input);
  if (version > current) {
    return err({ issues: [{ path: "schemaVersion", message: newerTemplateRecordMessage(version) }], newerVersion: version });
  }
  let record: Record<string, unknown> = input;
  while (version < current) {
    const step = steps[version];
    if (step === undefined) return err({ issues: [{ path: "schemaVersion", message: `No migration from template record version ${version}.` }] });
    version += 1;
    record = { ...step(record), schemaVersion: version };
  }
  return ok(record);
}

/** Brings a stored template record up to the current schema version before the strict parse. */
export const migrateTemplateRecord = (input: unknown): Result<unknown, TemplateRecordError> =>
  migrateRecord(input, TEMPLATE_RECORD_STEPS, TEMPLATE_SCHEMA_VERSION);
