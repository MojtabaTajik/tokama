import { describe, expect, it } from "vitest";
import { MAX_ATTEMPT_CHECKS, MAX_CHECK_TAIL_BYTES, parseQueryResult } from "../kernel/schemas/index.js";
import { encodeLine, LineDecoder, MAX_MESSAGE_BYTES } from "./framing.js";

const lines = (decoder: LineDecoder, ...chunks: string[]) =>
  chunks.flatMap((chunk) => {
    const result = decoder.push(Buffer.from(chunk));
    if (!result.ok) throw new Error("unexpected error");
    return result.value;
  });

describe("LineDecoder", () => {
  it("splits lines and keeps a partial line for the next chunk", () => {
    const decoder = new LineDecoder();
    expect(lines(decoder, '{"a":1}\n{"b"', ':2}\n\n{"c":3}')).toEqual(['{"a":1}', '{"b":2}', ""]);
    expect(lines(decoder, "\n")).toEqual(['{"c":3}']);
  });

  it("decodes a multi-byte character split across chunks", () => {
    const bytes = Buffer.from('"crème brûlée €"\n');
    const decoder = new LineDecoder();
    const first = decoder.push(bytes.subarray(0, 3));
    const second = decoder.push(bytes.subarray(3));
    expect(first).toEqual({ ok: true, value: [] });
    expect(second).toEqual({ ok: true, value: ['"crème brûlée €"'] });
  });

  it("accepts a line of exactly the cap", () => {
    const decoder = new LineDecoder(8);
    expect(decoder.push(Buffer.from("12345678\n"))).toEqual({ ok: true, value: ["12345678"] });
  });

  it("fails as soon as buffered bytes pass the cap, before any line break", () => {
    const decoder = new LineDecoder(8);
    expect(decoder.push(Buffer.from("12345")).ok).toBe(true);
    expect(decoder.push(Buffer.from("6789"))).toEqual({ ok: false, error: { code: "message_too_large", maxBytes: 8 } });
    // Stays failed: the stream is out of sync.
    expect(decoder.push(Buffer.from("\n")).ok).toBe(false);
  });

  it("fails on a long line that ends inside the same chunk", () => {
    expect(new LineDecoder(4).push(Buffer.from("12345\n")).ok).toBe(false);
  });
});

describe("encodeLine", () => {
  it("encodes one JSON message per line", () => {
    expect(encodeLine({ kind: "hello" })).toEqual({ ok: true, value: '{"kind":"hello"}\n' });
  });

  it("refuses a message over the cap", () => {
    expect(encodeLine("x".repeat(MAX_MESSAGE_BYTES)).ok).toBe(false);
    expect(encodeLine("x".repeat(MAX_MESSAGE_BYTES - 2)).ok).toBe(true);
  });
});

describe("reply size", () => {
  it("the largest attempt_checks reply fits in one engine message", () => {
    // Every byte invalid UTF-8 (U+FFFD, 3 bytes in JSON), longest command and summary.
    const check = { command: "\ufffd".repeat(500), state: "failed", exitCode: 1, durationMs: 1, summary: "\ufffd".repeat(200), output: { text: "\ufffd".repeat(MAX_CHECK_TAIL_BYTES), truncated: true, totalBytes: 1, totalLines: 1 } };
    const data = { attempt: 1, checks: Array.from({ length: MAX_ATTEMPT_CHECKS }, () => check) };
    expect(parseQueryResult("attempt_checks", data).ok).toBe(true);
    expect(encodeLine({ apiVersion: 5, kind: "reply", requestId: "r".repeat(128), result: { ok: true, data } }).ok).toBe(true);
  });
});
