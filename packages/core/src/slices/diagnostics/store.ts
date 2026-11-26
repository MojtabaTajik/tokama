// The diagnostics store: one append-only JSONL file of entries in `<home>/diagnostics/`, its
// settings, and the marker that tells a crash from a clean stop.
//
// Every entry is built here from typed parts; the one text field, an error's stack, goes through
// the redactor before anything is written. The engine that holds the home folder's lock is the
// only writer, so the entries are also kept in memory: lists read from memory, and a delete or
// prune rewrites the file from it. Nothing here throws; a failed write is logged and dropped.
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "../../kernel/clock/index.js";
import { appendTextSync, readJsonFile, readTextFile, replaceTextSync } from "../../kernel/fs-safe/index.js";
import { parseJsonLine } from "../../kernel/json-line/index.js";
import {
  type ClientSource,
  type CrashKind,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticCli,
  DiagnosticCliSchema,
  type DiagnosticEntry,
  DiagnosticEntrySchema,
  type DiagnosticId,
  type DiagnosticReport,
  type DiagnosticsList,
  type DiagnosticSource,
  type DiagnosticsSettings,
  type DiagnosticType,
  EpochMsSchema,
  type ErrorWhere,
  InstallIdSchema,
  type MachineFacts,
  MAX_DIAGNOSTICS_BYTES,
  MAX_LISTED_DIAGNOSTICS,
  newId,
  type SessionId,
  SessionIdSchema,
  type UsageAction,
  VersionLabelSchema,
  type WarningCode,
} from "../../kernel/schemas/index.js";
import { z } from "zod";
import { BODY_OVERHEAD_BYTES, entryBodyBytes } from "./body.js";
import { cleanStack, describeThrown, fingerprint, nameOfStack, type RedactionContext, redactText } from "./redact.js";

export const ENTRIES_FILE = "entries.jsonl";
export const SETTINGS_FILE = "settings.json";
/** Present while an engine runs; found at start, it means the last one did not stop cleanly. */
export const RUNNING_FILE = "engine.running";

const MAX_BYTES = MAX_DIAGNOSTICS_BYTES;
/** What an error's name may be: `Error`, `NonError`, or a class name such as `TypeError` or `DOMException`. */
const ERROR_CLASS = /^(?:NonError|[A-Z][A-Za-z0-9]{0,50}(?:Error|Exception))$/;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const StoredSettingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  collect: z.boolean(),
  installId: InstallIdSchema,
  /** Crashes recorded up to this time were seen; null when none was. */
  crashSeenAt: EpochMsSchema.nullable(),
});
type StoredSettings = z.output<typeof StoredSettingsSchema>;

export interface DiagnosticsStoreOptions {
  /** The diagnostics folder, `<home>/diagnostics`; made 0700 when missing. */
  readonly dir: string;
  readonly engineVersion: string;
  readonly machine: MachineFacts;
  /** What to clean from stacks now: asked on every write and every list, so new repos count at once. */
  readonly redaction: () => RedactionContext;
  readonly clock?: Clock;
  /** Called when the settings or the waiting crash change. */
  readonly onChange?: () => void;
  /** Called when entries are recorded or deleted. */
  readonly onEntries?: () => void;
  readonly log?: (message: string) => void;
  /** Size cap of the entries, counted in bytes of the body that sends them all. Default MAX_DIAGNOSTICS_BYTES (2 MB). */
  readonly maxBytes?: number;
  /** Entries older than this are dropped. Default 30 days. */
  readonly maxAgeMs?: number;
}

export type DiagnosticsFilter = {
  readonly types?: readonly DiagnosticType[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
};

export type DeleteTarget = { readonly ids: readonly DiagnosticId[] } | { readonly all: true };

export interface SettingsChange {
  readonly collect?: boolean;
  readonly resetInstallId?: true;
  readonly crashSeen?: true;
}

type Body =
  | { type: "error"; source: DiagnosticSource; where: ErrorWhere; name: string; fingerprint: string; stack: string }
  | { type: "warning"; source: DiagnosticSource; code: WarningCode }
  | { type: "usage"; day: string; counts: { action: UsageAction; count: number }[] }
  | { type: "crash"; source: DiagnosticSource; kind: CrashKind };

interface Kept {
  readonly entry: DiagnosticEntry;
  /** What the entry adds to the body that sends every entry; the size cap counts this. */
  readonly bytes: number;
}

export class DiagnosticsStore {
  /** The last engine did not stop cleanly; recorded as a crash when collecting is on. */
  readonly crashedLastTime: boolean;
  readonly sessionId: SessionId;
  private readonly options: DiagnosticsStoreOptions;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private settingsValue: StoredSettings;
  private kept: Kept[];
  private bytes: number;
  private appVersion: string | null = null;
  private clis: DiagnosticCli[] = [];
  /** Usage counts not written yet, per UTC day. */
  private readonly pending = new Map<string, Map<UsageAction, number>>();
  /** After close() nothing is written: the home lock may be another engine's by then. */
  private closed = false;

  private constructor(options: DiagnosticsStoreOptions, settings: StoredSettings, kept: Kept[], crashed: boolean) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
    this.settingsValue = settings;
    this.kept = kept;
    this.bytes = kept.reduce((sum, item) => sum + item.bytes, 0);
    this.crashedLastTime = crashed;
    this.sessionId = SessionIdSchema.parse(newId("session", this.clock.now()));
  }

  /**
   * Opens the folder: loads the settings (made on first use) and the entries (lines that do not
   * parse are dropped), prunes, finds a crash marker and sets a new one. A crash is recorded when
   * collecting is on.
   */
  static async open(options: DiagnosticsStoreOptions): Promise<DiagnosticsStore> {
    const clock = options.clock ?? systemClock;
    const log = options.log ?? (() => {});
    const { dir } = options;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log(`cannot create the diagnostics folder: ${String(error)}`);
    }

    const read = await readJsonFile(join(dir, SETTINGS_FILE), { maxBytes: 4096 });
    const parsed = read.ok ? StoredSettingsSchema.safeParse(read.value) : undefined;
    const firstUse = !read.ok && read.error.reason === "not_found";
    // A settings file that is there but does not load (another version wrote it, or it is
    // damaged) fails closed: nothing is collected, and the file is left as it is for the user.
    if (!firstUse && !parsed?.success) log("the diagnostics settings do not load; collecting is off until they are set again");
    const settings: StoredSettings = parsed?.success
      ? parsed.data
      : { schemaVersion: 1, collect: firstUse, installId: InstallIdSchema.parse(newId("install", clock.now())), crashSeenAt: null };

    const kept: Kept[] = [];
    let dropped = false;
    const text = await readTextFile(join(dir, ENTRIES_FILE), { maxBytes: 2 * (options.maxBytes ?? MAX_BYTES) });
    if (text.ok) {
      for (const line of text.value.split("\n")) {
        if (line === "") continue;
        const entry = parseLine(line);
        if (entry === undefined) dropped = true;
        else kept.push({ entry, bytes: entryBodyBytes(entry) });
      }
    } else if (text.error.reason !== "not_found") {
      log(`diagnostics entries are not loaded (${text.error.reason}); starting a new file`);
      dropped = true;
    }

    const marker = join(dir, RUNNING_FILE);
    const crashed = exists(marker);
    const store = new DiagnosticsStore(options, settings, kept, crashed);
    if (firstUse) store.saveSettings();
    const pruned = store.prune();
    if (dropped || !pruned) store.rewrite();
    const written = replaceTextSync(marker, `${process.pid}\n`);
    if (!written.ok) log(`cannot write the diagnostics marker: ${written.error.message}`);
    if (crashed) store.crash("engine", "unclean_exit");
    return store;
  }

  /** The desktop app's version, from its reports; new entries carry it. */
  setAppVersion(version: string): void {
    if (VersionLabelSchema.safeParse(version).success) this.appVersion = version;
  }

  /** The AI CLIs found on this machine; a version that does not fit becomes null. */
  setClis(clis: readonly { cliId: string; version?: string | undefined }[]): void {
    this.clis = clis.flatMap((cli) => {
      const parsed = DiagnosticCliSchema.safeParse({ cliId: cli.cliId, version: VersionLabelSchema.safeParse(cli.version).success ? cli.version : null });
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** Records anything thrown, cleaned. */
  error(source: DiagnosticSource, where: ErrorWhere, thrown: unknown): void {
    try {
      const { name, stack } = describeThrown(thrown);
      this.recordError(source, where, name, stack);
    } catch (error) {
      this.log(`cannot record a diagnostic: ${String(error)}`);
    }
  }

  warning(source: DiagnosticSource, code: WarningCode): void {
    this.record({ type: "warning", source, code });
  }

  crash(source: DiagnosticSource, kind: CrashKind): void {
    this.record({ type: "crash", source, kind });
  }

  /** Adds one to today's count of `action`. Counts are written by flushUsage. */
  count(action: UsageAction): void {
    if (!this.settingsValue.collect) return;
    const today = utcDay(this.clock.now());
    // A new day: the counts of the days before are complete.
    if ([...this.pending.keys()].some((day) => day !== today)) this.flushUsage();
    const counts = this.pending.get(today) ?? new Map<UsageAction, number>();
    counts.set(action, (counts.get(action) ?? 0) + 1);
    this.pending.set(today, counts);
  }

  /** Writes the pending usage counts, one entry per day. */
  flushUsage(): void {
    for (const [day, counts] of this.pending) {
      this.record({ type: "usage", day, counts: [...counts].map(([action, count]) => ({ action, count: Math.min(count, 1_000_000) })) });
    }
    this.pending.clear();
  }

  /** A client's report: its stack is cleaned like the engine's own errors. */
  report(report: DiagnosticReport, appVersion?: string): void {
    if (appVersion !== undefined) this.setAppVersion(appVersion);
    switch (report.type) {
      case "error":
        return this.recordReported(report.source, report.where, report.stack);
      case "warning":
        return this.warning(report.source, report.code);
      case "usage":
        return this.count(report.action);
      case "crash":
        return this.crash(report.source, report.kind);
    }
  }

  /** Newest first. Stacks are cleaned again with what is known now, e.g. a repo added since. */
  list(filter: DiagnosticsFilter = {}): DiagnosticsList {
    const limit = Math.min(filter.limit ?? MAX_LISTED_DIAGNOSTICS, MAX_LISTED_DIAGNOSTICS);
    const context = this.options.redaction();
    // Newest first; entries of the same millisecond, last written first.
    const matching = this.kept
      .map((item, index) => ({ entry: item.entry, index }))
      .filter(({ entry }) => (filter.types === undefined || filter.types.includes(entry.type)) && (filter.since === undefined || entry.at >= filter.since) && (filter.until === undefined || entry.at <= filter.until))
      .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
      .map(({ entry }) => entry);
    const entries = matching.slice(0, limit).map((entry) => (entry.type === "error" ? { ...entry, name: safeName(entry.name, context), stack: cleanStack(entry.stack, context) } : entry));
    return { entries, truncated: matching.length > limit };
  }

  /** Deletes by ids, or every entry; returns how many went. */
  delete(target: DeleteTarget): number {
    if (this.closed) return 0;
    const before = this.kept.length;
    if ("all" in target) {
      // Counts not yet written go too: they belong to what the user deleted.
      this.pending.clear();
      this.kept = [];
    } else {
      const ids = new Set<string>(target.ids);
      this.kept = this.kept.filter((item) => !ids.has(item.entry.id));
    }
    const deleted = before - this.kept.length;
    if (deleted > 0) {
      this.bytes = this.kept.reduce((sum, item) => sum + item.bytes, 0);
      this.rewrite();
      this.options.onChange?.();
      this.options.onEntries?.();
    }
    return deleted;
  }

  settings(): DiagnosticsSettings {
    const { collect, installId, crashSeenAt } = this.settingsValue;
    const crashWaiting = collect && this.kept.some((item) => item.entry.type === "crash" && (crashSeenAt === null || item.entry.at > crashSeenAt));
    return { collect, installId, crashWaiting };
  }

  updateSettings(change: SettingsChange): DiagnosticsSettings {
    if (this.closed) return this.settings();
    const next: StoredSettings = { ...this.settingsValue };
    if (change.collect !== undefined) next.collect = change.collect;
    if (change.resetInstallId === true) next.installId = InstallIdSchema.parse(newId("install", this.clock.now()));
    if (change.crashSeen === true) next.crashSeenAt = this.clock.now();
    // Off means nothing more is written, counts not yet written included; a new install id
    // starts fresh too, so no count from before it is written under it.
    if (!next.collect || change.resetInstallId === true) this.pending.clear();
    this.settingsValue = next;
    this.saveSettings();
    this.options.onChange?.();
    return this.settings();
  }

  /** On a clean stop: writes the pending counts and removes the crash marker. */
  close(): void {
    if (this.closed) return;
    this.flushUsage();
    this.closed = true;
    try {
      unlinkSync(join(this.options.dir, RUNNING_FILE));
    } catch {
      // Already gone.
    }
  }

  /** Drops old entries; returns false when the file must be rewritten. */
  prune(): boolean {
    const now = this.clock.now();
    const before = this.kept.length;
    this.kept = this.kept.filter((item) => item.entry.at >= now - this.maxAgeMs);
    let bytes = this.kept.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes + BODY_OVERHEAD_BYTES > this.maxBytes) {
      // Oldest first, down to 80% so a full file is not rewritten on every write.
      this.kept.sort((a, b) => a.entry.at - b.entry.at);
      let drop = 0;
      while (drop < this.kept.length && bytes > this.maxBytes * 0.8) bytes -= this.kept[drop++]!.bytes;
      this.kept = this.kept.slice(drop);
    }
    this.bytes = bytes;
    return this.kept.length === before;
  }

  private recordError(source: DiagnosticSource, where: ErrorWhere, rawName: string, rawStack: string): void {
    const context = this.options.redaction();
    const stack = cleanStack(rawStack, context);
    // A thrower picks the name. Only an error class name the redactor leaves alone is kept.
    const name = safeName(rawName, context);
    this.record({ type: "error", source, where, name, fingerprint: fingerprint(name, stack), stack });
  }

  private recordReported(source: ClientSource, where: ErrorWhere, stack: string): void {
    this.recordError(source, where, nameOfStack(stack), stack);
  }

  private record(body: Body): void {
    if (!this.settingsValue.collect || this.closed) return;
    try {
      const now = this.clock.now();
      const candidate = {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        id: newId("diag", now),
        at: now,
        installId: this.settingsValue.installId,
        sessionId: this.sessionId,
        appVersion: this.appVersion,
        engineVersion: this.options.engineVersion,
        clis: this.clis,
        machine: this.options.machine,
        ...body,
      };
      const parsed = DiagnosticEntrySchema.safeParse(candidate);
      if (!parsed.success) {
        this.log(`dropped a diagnostic that does not fit its schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        return;
      }
      const line = `${JSON.stringify(parsed.data)}\n`;
      const written = appendTextSync(join(this.options.dir, ENTRIES_FILE), line);
      if (!written.ok) {
        this.log(`cannot write a diagnostic: ${written.error.message}`);
        return;
      }
      const bytes = entryBodyBytes(parsed.data);
      this.kept.push({ entry: parsed.data, bytes });
      this.bytes += bytes;
      if (this.bytes + BODY_OVERHEAD_BYTES > this.maxBytes || (this.kept[0] !== undefined && this.kept[0].entry.at < now - this.maxAgeMs)) {
        if (!this.prune()) this.rewrite();
      }
      this.options.onEntries?.();
      if (body.type === "crash") this.options.onChange?.();
    } catch (error) {
      this.log(`cannot record a diagnostic: ${String(error)}`);
    }
  }

  private rewrite(): void {
    const text = this.kept.map((item) => `${JSON.stringify(item.entry)}\n`).join("");
    const written = replaceTextSync(join(this.options.dir, ENTRIES_FILE), text);
    if (!written.ok) this.log(`cannot rewrite the diagnostics file: ${written.error.message}`);
  }

  private saveSettings(): void {
    const written = replaceTextSync(join(this.options.dir, SETTINGS_FILE), `${JSON.stringify(this.settingsValue)}\n`);
    if (!written.ok) this.log(`cannot save the diagnostics settings: ${written.error.message}`);
  }
}

/** The name if it is an error class name the redactor leaves alone; otherwise `Error`. */
function safeName(name: string, context: RedactionContext): string {
  return ERROR_CLASS.test(name) && redactText(name, context) === name ? name : "Error";
}

function parseLine(line: string): DiagnosticEntry | undefined {
  const json = parseJsonLine(line);
  if (!json.ok) return undefined;
  const parsed = DiagnosticEntrySchema.safeParse(json.value);
  return parsed.success ? parsed.data : undefined;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The UTC day of an epoch time, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
