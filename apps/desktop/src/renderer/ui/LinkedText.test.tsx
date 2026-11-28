// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { isWebsiteUrl } from "../../main/policy.js";
import { LINKABLE_URLS, LinkedText, splitLinkable } from "./LinkedText.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SANDBOX = "https://tokama.dev/docs/linux-sandbox";
const BLOCKED = `Claude Code could not start its sandbox: x. Ubuntu's AppArmor can stop bubblewrap from creating a user namespace. How to allow it: ${SANDBOX} Then check again.`;

function render(text: string): HTMLElement {
  const host = document.createElement("div");
  act(() => createRoot(host).render(<LinkedText text={text} />));
  return host;
}

describe("LinkedText", () => {
  it("only lists pages the main process opens", () => {
    for (const url of LINKABLE_URLS) expect(isWebsiteUrl(url)).toBe(true);
  });

  it("turns the sandbox page in a problem text into a link and keeps the rest as text", () => {
    const host = render(BLOCKED);
    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([SANDBOX]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(host.textContent).toBe(BLOCKED.replace(SANDBOX, `${SANDBOX} ↗`));
  });

  it("links the address before a final full stop", () => {
    expect(splitLinkable(`See ${SANDBOX}.`)).toEqual([
      { text: "See ", link: false },
      { text: SANDBOX, link: true },
      { text: ".", link: false },
    ]);
  });

  it.each([
    `${SANDBOX}-evil`,
    `${SANDBOX}/more`,
    `${SANDBOX}?a=1`,
    `${SANDBOX}#x`,
    `${SANDBOX}.html`,
    `x${SANDBOX}`,
    `https://evil.example/?u=${SANDBOX}`,
    "http://tokama.dev/docs/linux-sandbox",
    "https://tokama.dev/docs/install-git",
    "https://tokama.dev.evil.example/docs/linux-sandbox",
    "javascript:alert(1)",
  ])("leaves %s as plain text", (text) => {
    const host = render(text);
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe(text);
  });

  it("never renders markup from the text", () => {
    const host = render(`<a href="https://evil.example">x</a> <b>y</b> ${SANDBOX}`);
    expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([SANDBOX]);
    expect(host.querySelector("b")).toBeNull();
  });
});
