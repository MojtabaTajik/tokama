// @vitest-environment happy-dom
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOpenSections, Section, SectionList, useOpenSections } from "./Section.js";
import { markOf } from "./status.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  resetOpenSections();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = (selector: string) => container.querySelector(selector);
const render = (node: ReactNode) => act(async () => root.render(node));
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());

/** A section that keeps its own open state, the body counted. */
function Toggling({ body, disabled = false, summary }: { readonly body: () => ReactNode; readonly disabled?: boolean; readonly summary?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Build" agent={<span>Builder</span>} state={markOf("failed")} facts="3 attempts · 4 m 12 s" spokenFacts="3 attempts, 4 minutes 12 seconds" open={open} onToggle={() => setOpen(!open)} disabled={disabled} summary={summary}>
      {body}
    </Section>
  );
}

describe("Section", () => {
  it("is a button in a heading that says its name, who, state and facts, spelled out for a screen reader", async () => {
    await render(<Toggling body={() => <p>body</p>} />);
    const head = $("h3 > button.sec-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.querySelector(".sec-name")?.textContent).toBe("Build");
    expect(head.querySelector(".sec-agent")?.textContent).toBe("Builder");
    expect(head.querySelector(".sec-state")?.textContent).toBe("✕failed");
    expect(head.querySelector(".mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(head.querySelector(".sec-facts")?.getAttribute("aria-hidden")).toBe("true");
    expect(head.querySelector(".visually-hidden")?.textContent).toBe(", 3 attempts, 4 minutes 12 seconds");
  });

  it("opens and closes on a click, and labels its body by its line", async () => {
    await render(<Toggling body={() => <p id="inside">body</p>} />);
    const head = $("button.sec-head")!;
    expect($("#inside")).toBeNull();
    await click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const region = $('[role="region"]')!;
    expect(region.getAttribute("aria-labelledby")).toBe(head.id);
    expect(head.getAttribute("aria-controls")).toBe(region.id);
    expect(region.textContent).toBe("body");
    await click(head);
    expect($('[role="region"]')).toBeNull();
    expect(head.hasAttribute("aria-controls")).toBe(false);
  });

  it("is a native button, so Enter and Space toggle it: no key handler of its own to get wrong", async () => {
    await render(<Toggling body={() => <p>body</p>} />);
    const head = $("button.sec-head") as HTMLButtonElement;
    expect(head.type).toBe("button");
    expect(head.tabIndex).toBe(0);
  });

  it("does not build its body while it is closed", async () => {
    const body = vi.fn(() => <p>body</p>);
    await render(<Toggling body={body} />);
    expect(body).not.toHaveBeenCalled();
    await click($("button.sec-head"));
    expect(body).toHaveBeenCalled();
  });

  it("is a plain line with no button and no arrow showing when disabled, and never builds its body", async () => {
    const body = vi.fn(() => <p>body</p>);
    await render(<Toggling body={body} disabled />);
    expect($("button")).toBeNull();
    expect($(".sec-head")?.getAttribute("data-plain")).toBe("true");
    expect($(".sec-head")?.querySelector(".sec-chev")?.getAttribute("aria-hidden")).toBe("true");
    expect($(".sec-head")?.textContent).toContain("Build");
    expect(body).not.toHaveBeenCalled();
  });

  it("shows its summary under the line only while it is closed", async () => {
    await render(<Toggling body={() => <p>body</p>} summary="approve" />);
    expect($(".sec-sum")?.textContent).toBe("approve");
    await click($("button.sec-head"));
    expect($(".sec-sum")).toBeNull();
  });

  it("is an h4 at the attempt level", async () => {
    await render(
      <Section level="attempt" title="Attempt 2" open={false} onToggle={() => undefined}>
        {() => null}
      </Section>,
    );
    expect($("h4 > button.sec-head")).not.toBeNull();
    expect($(".sec")?.classList.contains("sec-sub")).toBe(true);
  });

  it("sits in the heading the page asks for", async () => {
    await render(
      <Section heading="h2" title="File" open={false} onToggle={() => undefined}>
        {() => null}
      </Section>,
    );
    expect($("h2 > button.sec-head")).not.toBeNull();
  });

  it("gives the line's button to its parent for the deep link", async () => {
    let button: HTMLButtonElement | null = null;
    await render(
      <Section title="Build" open={false} onToggle={() => undefined} buttonRef={(element) => void (button = element)}>
        {() => null}
      </Section>,
    );
    expect(button).toBe($("button.sec-head"));
  });
});

describe("SectionList", () => {
  it("draws the bar with Expand all and Collapse all, each disabled when it would do nothing", async () => {
    const expand = vi.fn();
    const collapse = vi.fn();
    await render(
      <SectionList facts="3 steps · 5 attempts" allOpen noneOpen={false} onExpandAll={expand} onCollapseAll={collapse}>
        <Section title="Plan" open onToggle={() => undefined}>
          {() => null}
        </Section>
      </SectionList>,
    );
    expect($(".sec-bar span")?.textContent).toBe("3 steps · 5 attempts");
    const [expandAll, collapseAll] = [...container.querySelectorAll(".sec-bar .btn")] as HTMLButtonElement[];
    expect([expandAll?.textContent, expandAll?.disabled, collapseAll?.textContent, collapseAll?.disabled]).toEqual(["Expand all", true, "Collapse all", false]);
    await click(collapseAll!);
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(expand).not.toHaveBeenCalled();
  });

  it("has no bar without the two actions", async () => {
    await render(
      <SectionList>
        <Section title="File" open={false} onToggle={() => undefined}>
          {() => null}
        </Section>
      </SectionList>,
    );
    expect($(".sec-bar")).toBeNull();
    expect($(".sec-list")).not.toBeNull();
  });
});

describe("useOpenSections", () => {
  function Keys({ scope, defaults }: { readonly scope: string; readonly defaults: readonly string[] }) {
    const { open, update } = useOpenSections(scope, defaults);
    return (
      <>
        <output>{[...open].join(",")}</output>
        <button type="button" onClick={() => update((keys) => keys.add("x"))}>
          add x
        </button>
      </>
    );
  }

  it("starts from the defaults the screen computes, which follow its data until something is changed", async () => {
    await render(<Keys scope="a:Log" defaults={["s:0"]} />);
    expect($("output")?.textContent).toBe("s:0");
    await render(<Keys scope="a:Log" defaults={["s:1"]} />);
    expect($("output")?.textContent).toBe("s:1");
  });

  it("remembers a change per scope, through a remount and apart from other scopes", async () => {
    await render(<Keys scope="a:Log" defaults={["s:0"]} />);
    await click($("button"));
    expect($("output")?.textContent).toBe("s:0,x");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<Keys scope="a:Log" defaults={[]} />);
    expect($("output")?.textContent).toBe("s:0,x");
    await render(<Keys scope="b:Log" defaults={[]} />);
    expect($("output")?.textContent).toBe("");
  });

  it("forgets everything on reset", async () => {
    await render(<Keys scope="a:Log" defaults={[]} />);
    await click($("button"));
    resetOpenSections();
    await render(<Keys scope="a:Log" defaults={[]} />);
    expect($("output")?.textContent).toBe("");
  });
});
