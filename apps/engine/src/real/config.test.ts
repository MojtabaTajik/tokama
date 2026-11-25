import { describe, expect, it } from "vitest";
import { displayPath } from "./config.js";

describe("displayPath", () => {
  it("shows the home folder as ~, and nothing else", () => {
    expect(displayPath("/Users/sam/code/orders-api", "/Users/sam")).toBe("~/code/orders-api");
    expect(displayPath("/Users/sam", "/Users/sam")).toBe("~");
    expect(displayPath("/Users/samuel/code/x", "/Users/sam")).toBe("/Users/samuel/code/x");
    expect(displayPath("/srv/repos/x", "/Users/sam")).toBe("/srv/repos/x");
    expect(displayPath("/x", "/")).toBe("/x");
  });
});
