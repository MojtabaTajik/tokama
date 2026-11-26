import { describe, expect, it } from "vitest";
import { engineAction, olderBuild } from "./version.js";

describe("olderBuild", () => {
  it("is true only when both are plain releases and the engine's is lower", () => {
    expect(olderBuild("0.1.0", "0.1.1")).toBe(true);
    expect(olderBuild("0.1.9", "0.2.0")).toBe(true);
    expect(olderBuild("0.9.9", "1.0.0")).toBe(true);
    expect(olderBuild("0.1.1", "0.1.1")).toBe(false);
    expect(olderBuild("0.1.2", "0.1.1")).toBe(false);
    expect(olderBuild("1.0.0", "0.9.9")).toBe(false);
  });

  it("never compares a dev build, a pre-release or a missing version", () => {
    expect(olderBuild("0.0.0", "0.1.0")).toBe(false);
    expect(olderBuild("0.1.0", "0.0.0")).toBe(false);
    expect(olderBuild("0.1.0-beta.1", "0.1.0")).toBe(false);
    expect(olderBuild("0.1.0", "0.1.0+abc")).toBe(false);
    expect(olderBuild(undefined, "0.1.0")).toBe(false);
    expect(olderBuild("0.1.0", undefined)).toBe(false);
  });
});

describe("engineAction", () => {
  const app = { apiVersion: 15, appVersion: "0.2.0" };

  it("uses an engine of the same build, idle or not", () => {
    expect(engineAction({ apiVersion: 15, engineVersion: "0.2.0", runningItems: 0 }, app)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.2.0", runningItems: 3 }, app)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.2.0" }, app)).toBe("use");
  });

  it("replaces an older idle engine, of an older API or of the same API with a lower build", () => {
    expect(engineAction({ apiVersion: 14, engineVersion: "0.1.0", runningItems: 0 }, app)).toBe("replace");
    expect(engineAction({ apiVersion: 14, runningItems: 0 }, app)).toBe("replace");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.1.0", runningItems: 0 }, app)).toBe("replace");
  });

  it("uses a busy older engine of the same API, and one that did not say how busy it is", () => {
    expect(engineAction({ apiVersion: 15, engineVersion: "0.1.0", runningItems: 2 }, app)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.1.0" }, app)).toBe("use");
  });

  it("asks about a busy older engine of another API, and about one that did not say how busy it is", () => {
    expect(engineAction({ apiVersion: 14, engineVersion: "0.1.0", runningItems: 2 }, app)).toBe("ask");
    expect(engineAction({ apiVersion: 14, engineVersion: "0.1.0" }, app)).toBe("ask");
    expect(engineAction({ apiVersion: 1 }, app)).toBe("ask");
  });

  it("uses a newer engine of the same API, however busy", () => {
    expect(engineAction({ apiVersion: 15, engineVersion: "0.3.0", runningItems: 0 }, app)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.3.0", runningItems: 4 }, app)).toBe("use");
  });

  it("never stops a newer engine of another API", () => {
    expect(engineAction({ apiVersion: 16, engineVersion: "0.3.0", runningItems: 0 }, app)).toBe("newer");
    expect(engineAction({ apiVersion: 16, runningItems: 5 }, app)).toBe("newer");
  });

  it("compares builds only for a packaged app, and only plain releases", () => {
    const dev = { apiVersion: 15 };
    expect(engineAction({ apiVersion: 15, engineVersion: "0.1.0", runningItems: 0 }, dev)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.1.0", runningItems: 0 }, { apiVersion: 15, appVersion: "0.0.0" })).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "0.0.0", runningItems: 0 }, app)).toBe("use");
    expect(engineAction({ apiVersion: 15, engineVersion: "dev", runningItems: 0 }, app)).toBe("use");
  });

  it("still replaces an older API engine in a dev build, which has no build to compare", () => {
    expect(engineAction({ apiVersion: 14, runningItems: 0 }, { apiVersion: 15 })).toBe("replace");
  });
});
