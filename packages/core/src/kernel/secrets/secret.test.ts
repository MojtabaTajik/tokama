import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret } from "./secret.js";

const VALUE = "hunter2-Zq9";

describe("Secret", () => {
  const secret = new Secret(VALUE);

  it("reveals its value only through reveal()", () => {
    expect(secret.reveal()).toBe(VALUE);
  });

  it("never prints its value", () => {
    const renderings = [
      String(secret),
      `${secret}`,
      "" + secret,
      secret.toString(),
      JSON.stringify(secret),
      JSON.stringify({ connection: { password: secret } }),
      inspect(secret),
      inspect({ nested: [{ secret }] }, { depth: Infinity, showHidden: true }),
      format("%s %o %O %j", secret, secret, secret, secret),
    ];
    for (const text of renderings) {
      expect(text).not.toContain(VALUE);
      expect(text).toContain("[secret]");
    }
  });

  it("does not expose its value as an own property", () => {
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.values(secret)).toEqual([]);
    expect({ ...secret }).toEqual({});
  });
});
