import { describe, expect, it } from "vitest";
import { suggestFrom } from "./suggest.js";

const MANY = ["builtin/quick-fix", "builtin/ask", "builtin/review-only"];

describe("suggestFrom", () => {
  it("suggests the only template that can start, even for a question", () => {
    expect(suggestFrom(["builtin/quick-fix"], "Why is the export slow?")).toEqual({ templateId: "builtin/quick-fix" });
    expect(suggestFrom(["builtin/quick-fix"], "Fix the export")).toEqual({ templateId: "builtin/quick-fix" });
  });

  it("suggests Ask, with the reason, for a question when several can start", () => {
    expect(suggestFrom(MANY, "Why is the export slow?")).toEqual({ templateId: "builtin/ask", reason: "question" });
  });

  it("suggests nothing for a request or when Ask cannot start", () => {
    expect(suggestFrom(MANY, "Can you add CSV export?")).toEqual({ templateId: null });
    expect(suggestFrom(["builtin/quick-fix", "builtin/review-only"], "Why is the export slow?")).toEqual({ templateId: null });
    expect(suggestFrom([], "Why is the export slow?")).toEqual({ templateId: null });
  });
});
