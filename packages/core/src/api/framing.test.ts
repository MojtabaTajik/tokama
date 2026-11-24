import { describe, expect, it } from "vitest";
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
