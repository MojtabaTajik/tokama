// Posts one JSON text, gzipped, and reads a short JSON reply that names what was stored. The text
// goes out as it is: no field, header or cookie is added beyond the fixed headers below. HTTPS
// only (plain HTTP is allowed to the loopback address alone, for local test servers), and a
// redirect is a failure, never followed. Failures are values; nothing here throws.
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { type Clock, systemClock } from "../clock/index.js";
import { err, ok, type Result } from "../result/index.js";

const gzip = promisify(gzipCallback);

/** The most of a reply that is read, in bytes; a longer reply is not a valid one. */
const MAX_REPLY_BYTES = 4096;
/** What a stored report's id may be. */
const REPORT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface PostJsonOptions {
  readonly url: URL;
  /** The JSON text. It is gzipped as it is. */
  readonly text: string;
  /** The text's largest size, in bytes, before gzip; a longer text is not sent. */
  readonly maxBytes: number;
  /** The whole exchange, reply included, ends after this. */
  readonly timeoutMs: number;
  readonly clock?: Clock;
  /** Default: the global fetch. Tests pass their own. */
  readonly fetch?: typeof fetch;
}

export type PostFailure =
  /** Nothing was sent: the text is larger than `maxBytes`. */
  | { readonly kind: "too_large" }
  /** Nothing was sent: the URL is not HTTPS (or HTTP to the loopback address). */
  | { readonly kind: "not_allowed" }
  | { readonly kind: "timeout" }
  /** No answer: offline, a name that does not resolve, a refused connection or a TLS failure. */
  | { readonly kind: "network"; readonly code?: string }
  /**
   * The server answered with a status other than 2xx (a redirect included). `reason`: the short
   * reason a 4xx reply gives as `{ "error": "..." }`, one line of plain text, cut to 200 characters.
   */
  | { readonly kind: "status"; readonly status: number; readonly reason?: string }
  /** A 2xx answer without a report id. */
  | { readonly kind: "bad_reply" };

/** Posts `text` gzipped; a 2xx reply carrying `{ "id": "<report id>" }` is the only success. */
export async function postGzipJson(options: PostJsonOptions): Promise<Result<{ readonly id: string }, PostFailure>> {
  if (!allowedUrl(options.url)) return err({ kind: "not_allowed" });
  const raw = Buffer.from(options.text, "utf8");
  if (raw.byteLength > options.maxBytes) return err({ kind: "too_large" });
  const clock = options.clock ?? systemClock;
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    const body = await gzip(raw);
    const response = await (options.fetch ?? fetch)(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body,
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status > 299) {
      const reason = response.status >= 400 && response.status < 500 ? errorReason(await readCapped(response, MAX_REPLY_BYTES)) : undefined;
      if (reason === undefined) await response.body?.cancel().catch(() => {});
      return err(reason === undefined ? { kind: "status", status: response.status } : { kind: "status", status: response.status, reason });
    }
    const id = reportId(await readCapped(response, MAX_REPLY_BYTES));
    return id === undefined ? err({ kind: "bad_reply" }) : ok({ id });
  } catch (error) {
    if (timedOut) return err({ kind: "timeout" });
    const code = causeCode(error);
    return err(code === undefined ? { kind: "network" } : { kind: "network", code });
  } finally {
    clock.clearTimeout(timer);
  }
}

function allowedUrl(url: URL): boolean {
  if (url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

/** The reply as text, or undefined when it is longer than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reportId(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return undefined;
    const { id } = parsed;
    return typeof id === "string" && REPORT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The `error` of a `{ "error": "..." }` reply as one line of printable text, at most 200 characters. */
function errorReason(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed) || typeof parsed.error !== "string") return undefined;
    // eslint-disable-next-line no-control-regex
    const line = parsed.error.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, " ").trim().slice(0, 200);
    return line === "" ? undefined : line;
  } catch {
    return undefined;
  }
}

/** The system error code under a fetch failure, such as `ENOTFOUND`. */
function causeCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const code = cause?.code;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : undefined;
}
