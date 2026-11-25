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

  it("renders bold and italics inside list items and on a paragraph that is one bold line", async () => {
    await render("**1. index.html (CSS and a little markup)**\n\n- **Shared panel style:** one `panel` class\n- plain and *slanted* words\n\n1. **Add** the *route*");
    expect($$(".st-para strong").map((el) => el.textContent)).toEqual(["1. index.html (CSS and a little markup)"]);
    expect($$(".st-para").map((el) => el.textContent)).toEqual(["1. index.html (CSS and a little markup)"]);
    expect($$("ul li").map((el) => el.textContent)).toEqual(["Shared panel style: one panel class", "plain and slanted words"]);
    expect($$("ul li strong").map((el) => el.textContent)).toEqual(["Shared panel style:"]);
    expect($$("ul li em").map((el) => el.textContent)).toEqual(["slanted"]);
    expect($$("ol li strong, ol li em").map((el) => el.tagName + el.textContent)).toEqual(["STRONGAdd", "EMroute"]);
    expect(container.textContent).not.toContain("*");
  });

  it("nests italics in bold, and leaves loose or spaced stars as written", async () => {
    await render("**bold and *both* here** and 2 * 3 * 4 and a*b*c and x**2 + y**2 and **open and `**` code and *\n\n** spaced **");
    expect($$("strong").map((el) => el.innerHTML)).toEqual(["bold and <em>both</em> here"]);
    const shown = container.textContent ?? "";
    for (const part of ["2 * 3 * 4", "a*b*c", "x**2 + y**2", "**open and ", "** spaced **"]) expect(shown).toContain(part);
    expect($$(".st-code").map((el) => el.textContent)).toEqual(["**"]);
  });

  it("shows emphasis marks inside HTML as characters and never builds elements from them", async () => {
    await render("**<img src=x onerror=alert(1)>** and *<script>alert(2)</script>*");
    expect($$("img, script")).toEqual([]);
    expect($$("strong")[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect($$("em")[0]?.textContent).toBe("<script>alert(2)</script>");
  });

  it("reads a long line of loose stars in one pass", async () => {
    const started = performance.now();
    await render(`${"**a ".repeat(20_000)}${"*b ".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect($$("strong, em")).toEqual([]);
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
