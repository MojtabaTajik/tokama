import { describe, expect, it } from "vitest";
import { previewOf } from "./StepOutput.js";

describe("previewOf", () => {
  it("takes the first lines with words, without Markdown marks or fences", () => {
    expect(previewOf("## Plan\n\n```sql\n- Add a table\n3. Call it\n- Test it")).toBe("Plan\nAdd a table\nCall it");
  });
});
