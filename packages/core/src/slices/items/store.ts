// Item storage: `<home>/items/<item id>/events.jsonl` per item, with the item's other files beside
// it. The store keeps every item folded in memory, appends new events (fsync first, then the
// listeners hear about it), and refuses an event that does not fit the item's history.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "../../kernel/clock/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  HostIdSchema,
  ITEM_EVENT_SCHEMA_VERSION,
  ItemIdSchema,
  newId,
  parseItemEvent,
  type HostId,
  type ItemEvent,
  type ItemEventBody,
  type ItemId,
  type RepoId,
  type StoredItem,
  type TemplateRecord,
  type TemplateSnapshot,
} from "../../kernel/schemas/index.js";
import { applyEvent } from "./fold.js";
import { appendEvents, fsyncDir, readLog, type LogFs } from "./log.js";

export const EVENTS_FILE = "events.jsonl";

export interface ItemStoreOptions {
  /** Tokama's home folder (`~/.tokama`). */
  readonly home: string;
  readonly hostId: HostId;
  readonly clock?: Clock;
  /** File operations of the log; tests pass a recording wrapper. */
  readonly fs?: LogFs;
}

export interface CreateItem {
  /** The validated template; the item keeps a copy, its ref and its step ids. */
  readonly template: TemplateRecord;
  readonly title: string;
  readonly text: string;
  readonly repoIds: readonly RepoId[];
}

export interface StoreError {
  readonly code: "not_found" | "invalid_event" | "rejected" | "other_host" | "write_failed";
  readonly message: string;
}

/** A log the store could not load. Its item is left out and never written to. */
export interface LoadProblem {
  readonly itemId: string;
  readonly message: string;
}

export type ItemListener = (item: StoredItem) => void;

export class ItemStore {
  readonly hostId: HostId;
  private readonly itemsDir: string;
  private readonly clock: Clock;
  private readonly fs: LogFs;
  private readonly items = new Map<ItemId, StoredItem>();
  private readonly listeners = new Set<ItemListener>();

  private constructor(options: ItemStoreOptions) {
    this.hostId = options.hostId;
    this.itemsDir = join(options.home, "items");
    this.clock = options.clock ?? systemClock;
    this.fs = options.fs ?? nodeFs;
  }

  /** Creates the items folder (0700) when missing and loads every item log in it. */
  static open(options: ItemStoreOptions): { store: ItemStore; problems: LoadProblem[] } {
    const store = new ItemStore(options);
    nodeFs.mkdirSync(store.itemsDir, { recursive: true, mode: 0o700 });
    const problems: LoadProblem[] = [];
    for (const entry of nodeFs.readdirSync(store.itemsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = ItemIdSchema.safeParse(entry.name);
      if (!id.success) continue;
      const loaded = store.load(id.data);
      if (loaded.ok) store.items.set(id.data, loaded.value);
      else problems.push({ itemId: entry.name, message: loaded.error });
    }
    return { store, problems };
  }

  list(): StoredItem[] {
    return [...this.items.values()];
  }

  get(id: ItemId): StoredItem | undefined {
    return this.items.get(id);
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: ItemListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts a new item's log with its `item_created` event, and makes the new folder durable. */
  create(input: CreateItem): Result<StoredItem, StoreError> {
    const now = this.clock.now();
    const itemId = ItemIdSchema.parse(newId("item", now));
    const body: ItemEventBody = {
      type: "item_created",
      templateRef: input.template.ref,
      template: templateSnapshot(input.template),
      title: input.title,
      text: input.text,
      repoIds: [...input.repoIds],
      steps: input.template.steps.map((step) => ({ id: step.id })),
    };
    const events = this.envelop(itemId, -1, [body], now);
    if (!events.ok) return events;
    const folded = foldOnto(undefined, events.value);
    if (!folded.ok) return folded;
    const dir = join(this.itemsDir, itemId);
    try {
      nodeFs.mkdirSync(dir, { mode: 0o700 });
      appendEvents(join(dir, EVENTS_FILE), events.value, this.fs);
      fsyncDir(dir, this.fs);
      fsyncDir(this.itemsDir, this.fs);
    } catch (error) {
      return err({ code: "write_failed", message: `cannot write ${itemId}: ${String(error)}` });
    }
    return ok(this.commit(folded.value));
  }

  /**
   * Appends events to an item's log in one write. All or none: if one event does not fit the
   * item's history, nothing is written.
   */
  append(itemId: ItemId, bodies: readonly ItemEventBody[]): Result<StoredItem, StoreError> {
    const current = this.items.get(itemId);
    if (current === undefined) return err({ code: "not_found", message: `no item ${itemId}` });
    if (bodies.length === 0) return err({ code: "invalid_event", message: "no events to append" });
    // One writer per item: the host that created it.
    if (current.hostId !== this.hostId) return err({ code: "other_host", message: `${itemId} belongs to ${current.hostId}` });
    const events = this.envelop(itemId, current.lastSeq, bodies, this.clock.now());
    if (!events.ok) return events;
    const folded = foldOnto(current, events.value);
    if (!folded.ok) return folded;
    try {
      appendEvents(join(this.itemsDir, itemId, EVENTS_FILE), events.value, this.fs);
    } catch (error) {
      // Part of the batch may be on disk; take the item from the log again.
      const reloaded = this.load(itemId);
      if (reloaded.ok) this.items.set(itemId, reloaded.value);
      return err({ code: "write_failed", message: `cannot append to ${itemId}: ${String(error)}` });
    }
    return ok(this.commit(folded.value));
  }

  private envelop(itemId: ItemId, lastSeq: number, bodies: readonly ItemEventBody[], at: number): Result<ItemEvent[], StoreError> {
    const events: ItemEvent[] = [];
    for (const [index, body] of bodies.entries()) {
      // Parsed, not just typed: a line the reader would refuse must never reach the log.
      const event = parseItemEvent({ ...body, schemaVersion: ITEM_EVENT_SCHEMA_VERSION, itemId, seq: lastSeq + 1 + index, hostId: this.hostId, at });
      if (!event.ok) {
        const issue = event.error.issues[0];
        return err({ code: "invalid_event", message: `${body.type}: ${issue?.path ? `${issue.path}: ` : ""}${issue?.message ?? "invalid"}` });
      }
      events.push(event.value);
    }
    return ok(events);
  }

  private load(itemId: ItemId): Result<StoredItem, string> {
    const log = readLog(join(this.itemsDir, itemId, EVENTS_FILE), this.fs);
    if (!log.ok) return err(log.error.message);
    const folded = foldOnto(undefined, log.value.events);
    if (!folded.ok) return err(folded.error.message);
    if (folded.value.id !== itemId) return err(`the log in ${itemId} belongs to ${folded.value.id}`);
    return ok(folded.value);
  }

  private commit(item: StoredItem): StoredItem {
    this.items.set(item.id, item);
    for (const listener of this.listeners) listener(item);
    return item;
  }
}

function foldOnto(item: StoredItem | undefined, events: readonly ItemEvent[]): Result<StoredItem, StoreError> {
  let current = item;
  for (const event of events) {
    const next = applyEvent(current, event);
    if (!next.ok) return err({ code: "rejected", message: `seq ${next.error.seq}: ${next.error.message}` });
    current = next.value;
  }
  return current === undefined ? err({ code: "rejected", message: "the log is empty" }) : ok(current);
}

/** The snapshot of a template record: the record and the SHA-256 of its canonical JSON. */
export function templateSnapshot(record: TemplateRecord): TemplateSnapshot {
  const canonical = canonicalJson(record);
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    record: JSON.parse(canonical) as TemplateSnapshot["record"],
  };
}

/** JSON with object keys sorted, so equal records hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const HOST_FILE = "host.json";
const HOST_SCHEMA_VERSION = 1;

/**
 * This machine's host id, from `<home>/host.json`; made on first use. A file that exists but does
 * not hold a host id is an error, not replaced: a new id would disown the items this host runs.
 */
export function loadHostId(home: string, clock: Clock = systemClock): Result<HostId, string> {
  const file = join(home, HOST_FILE);
  try {
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(file, "utf8"));
    const hostId =
      typeof parsed === "object" && parsed !== null && "schemaVersion" in parsed && parsed.schemaVersion === HOST_SCHEMA_VERSION && "hostId" in parsed
        ? HostIdSchema.safeParse(parsed.hostId)
        : undefined;
    return hostId?.success ? ok(hostId.data) : err(`${file} does not hold a host id`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return err(`cannot read ${file}: ${String(error)}`);
  }
  const hostId = HostIdSchema.parse(newId("host", clock.now()));
  try {
    nodeFs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    nodeFs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: HOST_SCHEMA_VERSION, hostId })}\n`, { mode: 0o600, flag: "w" });
    nodeFs.renameSync(temp, file);
  } catch (error) {
    return err(`cannot write ${file}: ${String(error)}`);
  }
  return ok(hostId);
}
