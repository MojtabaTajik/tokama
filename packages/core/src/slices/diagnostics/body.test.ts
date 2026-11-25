import { describe, expect, it } from "vitest";
import { DiagnosticEntrySchema, DiagnosticsBodySchema, type DiagnosticEntry } from "../../kernel/schemas/index.js";
import { BODY_OVERHEAD_BYTES, diagnosticsBody, entryBodyBytes, entryText } from "./body.js";

const base = {
  schemaVersion: 1,
  installId: "install_0197a3b0-0000-7000-8000-000000000001",
  sessionId: "session_0197a3b0-0000-7000-8000-000000000002",
  appVersion: "0.1.0",
  engineVersion: "0.1.0",
  clis: [{ cliId: "claude-code", version: "2.1.3" }],
  machine: { os: "macos", osVersion: "15.2", distro: null, arch: "arm64", cpu: { family: "Apple M3 Pro", cores: 12 }, ramGb: "16-32", gpu: null },
};
const entries: DiagnosticEntry[] = [
  DiagnosticEntrySchema.parse({ ...base, id: "diag_0197a3b0-0000-7000-8000-000000000003", at: 1, type: "warning", source: "engine", code: "index_rebuilt" }),
  DiagnosticEntrySchema.parse({ ...base, id: "diag_0197a3b0-0000-7000-8000-000000000004", at: 2, type: "crash", source: "desktop", kind: "unclean_exit" }),
];

describe("diagnostics body", () => {
  it("is valid JSON that parses back to the entries, and holds each entry's text as it is", () => {
    const texts = entries.map(entryText);
    const body = diagnosticsBody(texts);
    expect(JSON.parse(body)).toEqual(entries);
    for (const text of texts) expect(body).toContain(text);
    expect(texts[0]).toContain('\n  "code": "index_rebuilt"');
  });

  it("is exactly the entries' byte counts plus the overhead", () => {
    const body = diagnosticsBody(entries.map(entryText));
    expect(Buffer.byteLength(body)).toBe(entries.reduce((sum, entry) => sum + entryBodyBytes(entry), 0) + BODY_OVERHEAD_BYTES);
  });
});

describe("DiagnosticsBodySchema", () => {
  it("takes a body of entries and refuses an empty one", () => {
    expect(DiagnosticsBodySchema.safeParse(JSON.parse(diagnosticsBody(entries.map(entryText)))).success).toBe(true);
    expect(DiagnosticsBodySchema.safeParse([]).success).toBe(false);
  });
});
