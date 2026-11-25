import { describe, expect, it } from "vitest";
import { MAX_STACK_CHARS, MAX_STACK_LINES } from "../../kernel/schemas/index.js";
import { cleanStack, describeThrown, fingerprint, nameOfStack, redactText } from "./redact.js";
import { FORBIDDEN, SENTINEL, SENTINEL_CONTEXT, sentinelStack } from "./testing.js";

const none = { codeRoots: [], paths: [], repoNames: [] };

function expectClean(text: string): void {
  for (const fragment of FORBIDDEN) expect(text, `"${fragment}" survived in:\n${text}`).not.toContain(fragment);
}

describe("redactText", () => {
  it("removes every sentinel from a stack", () => {
    const cleaned = cleanStack(sentinelStack(), SENTINEL_CONTEXT);
    expectClean(cleaned);
    // What is left is still useful: the error class, Tokama's own frames and Node's.
    expect(cleaned).toMatch(/^Error: cannot open <path>/);
    expect(cleaned).toContain("at run (<app>/apps/engine/dist/engine.js:120:17)");
    expect(cleaned).toContain("at step (<path>:1:1)");
    expect(cleaned).toContain("(node:internal/process/task_queues:105:5)");
    expect(cleaned).toContain("<email>");
    expect(cleaned).toContain("<url>");
    expect(cleaned).toContain("at readConfig (<path>:10:5)");
    expect(cleaned).toContain("<repo>");
    expect(cleaned).toContain("<user>");
  });

  it("removes paths, emails, URLs and tokens with no context at all", () => {
    const text = [
      "/var/lib/northwind/orders-api/db.sqlite",
      "~/northwind/notes.md",
      SENTINEL.email,
      SENTINEL.url,
      SENTINEL.anthropic,
      SENTINEL.github,
      SENTINEL.githubPat,
      SENTINEL.aws,
      SENTINEL.jwt,
      SENTINEL.hex,
      SENTINEL.base64,
      SENTINEL.windowsPath,
      "\\\\fileserver\\northwind\\orders-api",
      SENTINEL.relativePath,
      SENTINEL.password,
      `Authorization: Bearer ${"x".repeat(10)}northwind`,
    ].join("\n");
    const cleaned = redactText(text, none);
    for (const fragment of ["northwind", "orders-api", "jane", "hunter2", "SENTINEL", "billing", "secret-invoice", "AKIA", "eyJ", "5e47a1c0ffee", "U0VOVElO", "Tr0ub4dor"]) {
      expect(cleaned, cleaned).not.toContain(fragment);
    }
  });

  it("catches a home folder with a space in it as one path", () => {
    expect(redactText(`at x (${SENTINEL.spacedHome}/Code/app.js:1:2)`, SENTINEL_CONTEXT)).toBe("at x (<path>:1:2)");
  });

  it("replaces repo names as words only, case-insensitive", () => {
    const context = { ...none, repoNames: ["orders-api"] };
    expect(redactText("repo Orders-API failed; myorders-api stays a word", context)).toBe("repo <repo> failed; myorders-api stays a word");
  });

  it("keeps a code root's own built files, and only those", () => {
    const context = { ...none, codeRoots: ["/opt/tokama/"] };
    expect(redactText("at a (/opt/tokama/dist/main/index.js:1:1)", context)).toBe("at a (<app>/dist/main/index.js:1:1)");
    expect(redactText("at a (file:///opt/tokama/node_modules/zod/v4/index.js:1:1)", context)).toBe("at a (<app>/node_modules/zod/v4/index.js:1:1)");
    expect(redactText("at a (/opt/tokama/repos/orders-api/x.ts:1:1)", context)).toBe("at a (<path>:1:1)");
  });

  it("keeps an own dependency's pnpm path whole, and a NUL in the input cannot forge it", () => {
    const context = { ...none, codeRoots: ["/opt/tokama"], repoNames: ["0", "zod"] };
    expect(redactText("at x (/opt/tokama/node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js:1:2)", context)).toBe("at x (<app>/node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js:1:2)");
    expect(redactText("\u0000\ue000\u0000 /srv/northwind", context)).toBe("\ue000 <path>");
  });

  it("leaves ordinary words, numbers and placeholders alone", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'length') at 3 of 10";
    expect(redactText(text, none)).toBe(text);
    expect(redactText("<path> <url> <token>", { ...none, repoNames: ["path", "url"] })).toBe("<path> <url> <token>");
  });

  it("does not take a sibling folder for a known one", () => {
    const context = { ...none, paths: ["/Users/jdoe", "/Users/jdoe/src/api"] };
    expect(redactText("ENOENT, open '/Users/jdoe/src/api-gateway/customers/acme-contract.ts'", context)).toBe("ENOENT, open '<path>'");
    expect(redactText("at x (/Users/jdoe/src/api.old/acme.ts:1:2)", context)).toBe("at x (<path>:1:2)");
  });

  it("removes paths and emails in any script", () => {
    for (const text of ["cannot read src/客户合同.ts", "Kundé/Rechnung-Müller.ts", "客户合同/报价单.ts", "mail jürgen.müller@kanzlei-müller.de"]) {
      const cleaned = redactText(text, none);
      for (const fragment of ["客户", "报价", "Rechnung", "Kundé", "jürgen", "kanzlei"]) expect(cleaned, cleaned).not.toContain(fragment);
    }
  });

  it("removes secrets in quotes and JSON", () => {
    expect(redactText(`{"password":"hunter2","api_key":"abcd1234"}`, none)).toBe(`{"password":"<token>","api_key":"<token>"}`);
    expect(redactText("token: 'abc123secret'", none)).toBe("token: '<token>'");
  });

  it("removes paths after a placeholder, and never keeps a path that climbs out of a code root", () => {
    expect(redactText("<path>/acme/secret.ts and cmd >/Volumes/Acme/out.txt", none)).toBe("<path> and cmd ><path>");
    expect(redactText("at a (/opt/tokama/dist/../../../work/acme-corp/orders.js:1:1)", { ...none, codeRoots: ["/opt/tokama"] })).toBe("at a (<path>:1:1)");
  });

  it("stays fast on long runs that look like emails or URLs", () => {
    const started = performance.now();
    redactText("a.".repeat(16_000), none);
    redactText("a+".repeat(16_000), none);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("is idempotent, so entries can be cleaned again when read", () => {
    const once = cleanStack(sentinelStack(), SENTINEL_CONTEXT);
    expect(cleanStack(once, SENTINEL_CONTEXT)).toBe(once);
  });
});

describe("cleanStack", () => {
  it("caps lines and characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `    at f${i} (node:internal/x:${i}:1)`).join("\n");
    expect(cleanStack(many, none).split("\n")).toHaveLength(MAX_STACK_LINES);
    expect(cleanStack("x".repeat(50_000), none).length).toBeLessThanOrEqual(MAX_STACK_CHARS);
  });

  it("drops a secret that the input cut splits, since the output is far shorter", () => {
    const stack = `${"y ".repeat(15_999)}${SENTINEL.github}`;
    expect(cleanStack(stack, none)).not.toContain("ghp_");
  });
});

describe("fingerprint", () => {
  it("is stable across line numbers and messages, and differs between failures", () => {
    const a = "TypeError: x of /a is undefined\n    at f (<app>/dist/a.js:10:5)\n    at g (<app>/dist/b.js:2:1)";
    const b = "TypeError: x of /b is undefined\n    at f (<app>/dist/a.js:11:9)\n    at g (<app>/dist/b.js:3:1)";
    const c = "TypeError: x\n    at h (<app>/dist/a.js:10:5)";
    expect(fingerprint("TypeError", a)).toBe(fingerprint("TypeError", b));
    expect(fingerprint("TypeError", a)).not.toBe(fingerprint("TypeError", c));
    expect(fingerprint("TypeError", a)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint("Error", "Error: failed after 3 tries")).toBe(fingerprint("Error", "Error: failed after 4 tries"));
  });
});

describe("describeThrown", () => {
  it("takes an Error's name, stack and cause", () => {
    const error = new TypeError("outer", { cause: new Error("inner") });
    const described = describeThrown(error);
    expect(described.name).toBe("TypeError");
    expect(described.stack).toMatch(/^TypeError: outer/);
    expect(described.stack).toContain("Caused by: Error: inner");
  });

  it("describes values that are not Errors, and odd names", () => {
    expect(describeThrown("text")).toEqual({ name: "NonError", stack: "NonError: text" });
    const unprintable = { toString: () => { throw new Error("no"); } };
    expect(describeThrown(unprintable).stack).toBe("NonError: (unprintable value)");
    const odd = new Error("m");
    odd.name = "has spaces /Users/x";
    expect(describeThrown(odd).name).toBe("Error");
  });

  it("reads the name of a reported stack", () => {
    expect(nameOfStack("RangeError: too big\n    at x")).toBe("RangeError");
    expect(nameOfStack("something odd happened")).toBe("Error");
    expect(nameOfStack("TypeError [ERR_X]: y\norders_api: boom")).toBe("Error");
  });
});
