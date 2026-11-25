// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewOf } from "./StepOutput.js";
import { blocksOf, StepText } from "./StepText.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (text: string) => act(async () => root.render(<StepText text={text} />));
const $$ = (selector: string) => [...container.querySelectorAll(selector)];

describe("StepText", () => {
  it("shows HTML, script tags and Markdown links as their characters, never as elements", async () => {
    const text = [
      "# <script>alert(1)</script>",
      '<img src=x onerror="alert(2)"> and <b>bold</b>',
      "- [docs](javascript:alert(3)) and <a href=\"https://example.com\">a link</a>",
      "`<script>alert(4)</script>`",
      "```",
      "<iframe src=x></iframe>",
      "```",
    ].join("\n");
    await render(text);
    expect($$("script, img, b, a, iframe")).toEqual([]);
    const shown = container.textContent ?? "";
    for (const part of ["<script>alert(1)</script>", '<img src=x onerror="alert(2)">', "[docs](javascript:alert(3))", '<a href="https://example.com">a link</a>', "<iframe src=x></iframe>"]) {
      expect(shown).toContain(part);
    }
    expect($$("code").map((el) => el.textContent)).toEqual(["<script>alert(4)</script>"]);
  });

  it("gives headings, lists, code spans and fenced code their own elements, and keeps line breaks", async () => {
    await render("## Plan\n\nWrap the client.\nThen test it.\n\n1. Add `retry()`\n2. Add tests\n\n- one\n- two\n\n```ts\nconst a = 1;\n  indented();\n```");
    expect($$(".st-heading").map((el) => [el.getAttribute("data-level"), el.textContent])).toEqual([["2", "Plan"]]);
    expect($$(".st-para").map((el) => el.textContent)).toEqual(["Wrap the client.\nThen test it."]);
    expect($$("ol li").map((el) => el.textContent)).toEqual(["Add retry()", "Add tests"]);
    expect($$("ul li").map((el) => el.textContent)).toEqual(["one", "two"]);
    expect($$(".st-code").map((el) => el.textContent)).toEqual(["retry()"]);
    expect($$(".st-pre").map((el) => el.textContent)).toEqual(["const a = 1;\n  indented();"]);
  });

  it("shows characters that reorder text as visible escapes in code", async () => {
    await render("`a‮b`\n```\nc⁦d\n```");
    expect($$("code, pre").map((el) => el.textContent)).toEqual(["a<U+202E>b", "c<U+2066>d"]);
  });
});

describe("blocksOf", () => {
  it("keeps an unpaired backtick, an unclosed fence and a '#' without a space as written", () => {
    expect(blocksOf("#tag and `one")).toEqual([{ kind: "text", lines: ["#tag and `one"] }]);
    expect(blocksOf("```\nlast")).toEqual([{ kind: "code", lines: ["last"] }]);
  });

  it("starts an ordered list at the agent's first number and joins a wrapped item's next line", () => {
    expect(blocksOf("3. three\n   more\n4. four")).toEqual([{ kind: "list", ordered: true, start: 3, items: ["three\nmore", "four"] }]);
  });

  it("reads a long line in one pass", () => {
    const long = `${"`".repeat(1)}${"#".repeat(100_000)}${"- ".repeat(100_000)}`;
    const started = performance.now();
    expect(blocksOf(long)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("previewOf", () => {
  it("takes the first lines with words, without Markdown marks or fences", () => {
    expect(previewOf("## Plan\n\n```sql\n- Add a table\n3. Call it\n- Test it")).toBe("Plan\nAdd a table\nCall it");
  });
});
