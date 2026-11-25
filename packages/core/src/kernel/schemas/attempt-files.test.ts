import { describe, expect, it } from "vitest";
import { terminalText } from "./attempt-files.js";

describe("terminalText", () => {
  it("removes colours, cursor moves, titles and links", () => {
    expect(terminalText("\u001b[31m FAIL \u001b[39m test\u001b[2K\u001b[1A")).toBe(" FAIL  test");
    expect(terminalText("\u001b]0;title\u0007done \u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\")).toBe("done link");
    expect(terminalText("\u009b1mbold\u009b0m \u001b(Bplain \u001b=keypad")).toBe("bold plain keypad");
  });

  it("ends an unterminated title at the line's end, so the lines after it stay", () => {
    expect(terminalText("FAIL a\n\u001b]0 rest\nline2\nERROR real failure\n")).toBe("FAIL a\n\nline2\nERROR real failure\n");
  });

  it("keeps tabs and line feeds, drops other control characters and the marks that reorder text", () => {
    expect(terminalText("a\tb\nc\u0000d\u0007e\u007ff\u0085g‮h⁦i‏j")).toBe("a\tb\ncdefghij");
  });

  it("shows what a carriage return wrote over, as a terminal does", () => {
    expect(terminalText("10%\r50%\r100%\nnext\r\nlast")).toBe("100%\nnext\nlast");
  });

  it("leaves markup as it is: it is text", () => {
    expect(terminalText("<script>alert(1)</script> & <b>")).toBe("<script>alert(1)</script> & <b>");
  });
});
