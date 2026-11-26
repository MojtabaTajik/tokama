import { describe, expect, it } from "vitest";
import { releaseNotesUrl, updateNotesUrl } from "./notes.js";

describe("releaseNotesUrl", () => {
  it("builds an https release address from a plain version", () => {
    expect(releaseNotesUrl("0.2.0")).toBe("https://tokama.dev/releases/v0.2.0");
  });

  it.each(["", "0.2", "v0.2.0", "0.2.0-beta", "0.2.0/../../x", "0.2.0?x=1", "0.2.0#a", "a.b.c", "0.2.0\n", " 0.2.0"])("refuses %j", (version) => {
    expect(releaseNotesUrl(version)).toBeUndefined();
  });
});

describe("updateNotesUrl", () => {
  it("opens the page of a downloading or ready update only", () => {
    expect(updateNotesUrl({ status: "ready", version: "0.2.0" })).toMatch(/v0\.2\.0$/);
    expect(updateNotesUrl({ status: "downloading", version: "0.2.0", percent: 1, transferred: 1, total: 2 })).toMatch(/v0\.2\.0$/);
    expect(updateNotesUrl({ status: "stalled", version: "0.2.0" })).toMatch(/v0\.2\.0$/);
    expect(updateNotesUrl({ status: "idle" })).toBeUndefined();
    expect(updateNotesUrl({ status: "installing", version: "0.2.0" })).toBeUndefined();
    expect(updateNotesUrl({ status: "error", stage: "check", at: 1 })).toBeUndefined();
  });
});
