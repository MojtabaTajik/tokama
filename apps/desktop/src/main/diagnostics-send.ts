// The Diagnostics page's load, Send all and Save as file. Load reads every waiting entry from the
// engine and keeps the text it gives the renderer for each; Send all and Save as file put out
// exactly those texts, for the ids the renderer names, and nothing else. The renderer can choose
// which of the shown entries, never the text, the URL or the headers. Electron only as types (the save
// dialog is passed in), so it is tested with a fake client and a local server.
import { writeFile } from "node:fs/promises";
import type { EngineClient } from "@tokama/client";
import { type Clock, type DiagnosticEntry, type DiagnosticId, DiagnosticIdSchema, diagnosticsBody, entryText, MAX_DIAGNOSTICS_BYTES, type PostFailure, postGzipJson } from "@tokama/core";
import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import type { DiagnosticsLoad, DiagnosticsSaveResult, DiagnosticsSendFailure, DiagnosticsSendResult } from "../shared/bridge.js";

/** Where Send all posts. Only a development build may replace it, with a loopback test server. */
export const DIAGNOSTICS_URL = new URL("https://api.tokama.dev/diagnostics");
/**
 * The largest body Send all posts: the receiver's own limit. The store keeps the body of every
 * entry within MAX_DIAGNOSTICS_BYTES; the margin covers stacks that are cleaned again at load with
 * placeholders longer than the names they replace (a repo added later).
 */
export const UPLOAD_LIMIT_BYTES = MAX_DIAGNOSTICS_BYTES + 16 * 1024;
/** Send all gives up after this, reply included. */
export const SEND_TIMEOUT_MS = 30_000;
/** The most ids diagnostics_delete takes in one command. */
const DELETE_CHUNK = 1000;
/** A full store holds a few thousand entries; the list query gives at most 200 per page. */
const MAX_PAGES = 100;

/** More ids than a full store can hold. */
const MAX_IDS = 20_000;

export interface DiagnosticsServiceOptions {
  /** The connected client, or undefined when there is none. */
  readonly client: () => EngineClient | undefined;
  /** Undefined: this build sends nowhere (the sample engine without a local test server). */
  readonly url: URL | undefined;
  /** Shows the save dialog and writes the text; "cancelled" when the user closed the dialog. */
  readonly saveFile: (text: string) => Promise<"saved" | "cancelled" | "failed">;
  readonly clock?: Clock;
  /** Default: postGzipJson. */
  readonly post?: typeof postGzipJson;
}

export interface DiagnosticsService {
  load(): Promise<DiagnosticsLoad>;
  send(ids: unknown): Promise<DiagnosticsSendResult>;
  save(ids: unknown): Promise<DiagnosticsSaveResult>;
}

export function diagnosticsService(options: DiagnosticsServiceOptions): DiagnosticsService {
  /** The texts of the last load, by id, in the order shown. */
  let shown = new Map<DiagnosticId, string>();
  let sending = false;
  /** Loads can overlap; only the one started last sets `shown`. */
  let loads = 0;

  /** The shown texts of the given ids, in the order shown; undefined for input that is not a list of ids. */
  const pick = (input: unknown): { ids: DiagnosticId[]; texts: string[] } | undefined => {
    if (!Array.isArray(input) || input.length > MAX_IDS || !input.every((id) => DiagnosticIdSchema.safeParse(id).success)) return undefined;
    const wanted = new Set<unknown>(input);
    const ids = [...shown.keys()].filter((id) => wanted.has(id));
    return { ids, texts: ids.map((id) => shown.get(id) as string) };
  };

  return {
    load: async () => {
      const client = options.client();
      if (client === undefined) return { ok: false, reason: "not_connected" };
      const load = ++loads;
      const entries = await listAll(client);
      if (entries === undefined) return { ok: false, reason: "unavailable" };
      const items = entries.map((entry) => ({ entry, text: entryText(entry) }));
      if (load === loads) shown = new Map(items.map((item) => [item.entry.id, item.text]));
      return { ok: true, items };
    },
    send: async (input) => {
      const asked = pick(input);
      if (sending) return { ok: false, reason: "busy", count: asked?.ids.length ?? 0 };
      if (asked === undefined || asked.ids.length === 0) return { ok: false, reason: "nothing", count: 0 };
      const client = options.client();
      if (client === undefined) return { ok: false, reason: "not_connected", count: asked.ids.length };
      if (options.url === undefined) return { ok: false, reason: "no_receiver", count: asked.ids.length };
      const url = options.url;
      sending = true;
      try {
        // Only what is still waiting: an entry cleared since the page loaded is not sent.
        const waiting = await listAll(client);
        if (waiting === undefined) return { ok: false, reason: "not_connected", count: asked.ids.length };
        const still = new Set(waiting.map((entry) => entry.id));
        const ids = asked.ids.filter((id) => still.has(id));
        const count = ids.length;
        if (count === 0) return { ok: false, reason: "nothing", count: 0 };
        const posted = await (options.post ?? postGzipJson)({
          url,
          text: diagnosticsBody(ids.map((id) => shown.get(id) as string)),
          maxBytes: UPLOAD_LIMIT_BYTES,
          timeoutMs: SEND_TIMEOUT_MS,
          ...(options.clock !== undefined && { clock: options.clock }),
        });
        if (!posted.ok) {
          const reason = failureReason(posted.error);
          const detail = reason === "rejected" && posted.error.kind === "status" ? posted.error.reason : undefined;
          return detail === undefined ? { ok: false, reason, count } : { ok: false, reason, count, detail };
        }
        // Stored (the receiver answers 201): remove exactly what was sent; entries recorded since
        // stay. A delete that fails leaves its entries listed and says so; a later Send all sends
        // them again, and the receiver ignores the copies.
        let kept = 0;
        for (let start = 0; start < count; start += DELETE_CHUNK) {
          const chunk = ids.slice(start, start + DELETE_CHUNK);
          const deleted = await client.command({ type: "diagnostics_delete", ids: chunk }).catch(() => undefined);
          if (deleted?.ok === true) for (const id of chunk) shown.delete(id);
          else kept += chunk.length;
        }
        return kept === 0 ? { ok: true, sent: count } : { ok: true, sent: count, kept };
      } finally {
        sending = false;
      }
    },
    save: async (input) => {
      const picked = pick(input);
      if (picked === undefined || picked.ids.length === 0) return { ok: false, reason: "nothing" };
      const saved = await options.saveFile(diagnosticsBody(picked.texts));
      return saved === "saved" ? { ok: true } : { ok: false, reason: saved };
    },
  };
}

/**
 * Every entry, newest first, read page by page. The list query has no cursor and `until` is
 * inclusive, so pages overlap at their edge and are merged by id. Undefined when it cannot read
 * them all, so a page never shows less than everything as if it were everything.
 */
export async function listAll(client: EngineClient): Promise<DiagnosticEntry[] | undefined> {
  const found = new Map<string, DiagnosticEntry>();
  let until: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = await client.query({ type: "diagnostics_list", ...(until !== undefined && { until }) });
    if (!reply.ok) return undefined;
    const before = found.size;
    for (const entry of reply.data.entries) if (!found.has(entry.id)) found.set(entry.id, entry);
    if (!reply.data.truncated) return [...found.values()];
    const oldest = reply.data.entries.at(-1);
    // More than a page of entries share one time: the next page would be the same one.
    if (found.size === before || oldest === undefined) return undefined;
    until = oldest.at;
  }
  return undefined;
}

function failureReason(failure: PostFailure): DiagnosticsSendFailure {
  switch (failure.kind) {
    case "too_large":
      return "too_large";
    case "timeout":
      return "timeout";
    case "network":
    case "not_allowed":
      return "network";
    case "bad_reply":
      return "bad_reply";
    case "status":
      return failure.status === 400 ? "rejected" : failure.status === 413 ? "too_large" : failure.status === 415 ? "unsupported" : failure.status === 429 ? "rate_limited" : failure.status === 503 ? "busy_today" : "server";
  }
}

/**
 * Save as file: the system save dialog, then the text as it is. "failed" when it could not be
 * written; the reason stays in the main process's output.
 */
export async function saveToFile(
  text: string,
  show: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>,
  today: Date,
  write: (path: string, text: string) => Promise<void> = (path, data) => writeFile(path, data, { mode: 0o600 }),
): Promise<"saved" | "cancelled" | "failed"> {
  const day = today.toISOString().slice(0, 10);
  const result = await show({ title: "Save diagnostics", defaultPath: `tokama-diagnostics-${day}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (result.canceled || result.filePath === undefined || result.filePath === "") return "cancelled";
  try {
    await write(result.filePath, text);
    return "saved";
  } catch (error) {
    console.error("could not save diagnostics:", error);
    return "failed";
  }
}
