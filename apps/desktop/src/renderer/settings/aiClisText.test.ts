import type { AiCli } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { argLine, stateWords } from "./aiClisText.js";

const supported = (state: "ready" | "not_logged_in" | "not_installed" | "no_answer" | "not_checked") => ({ supported: true, state }) as unknown as AiCli;

describe("stateWords", () => {
  it("gives every state its own symbol and a word, so colour is never the only signal", () => {
    const all = [supported("ready"), supported("not_logged_in"), supported("not_installed"), supported("no_answer"), supported("not_checked"), { supported: false } as unknown as AiCli].map(stateWords);
    expect(new Set(all.map((words) => words.symbol)).size).toBe(5);
    expect(all.every((words) => words.word.length > 0)).toBe(true);
    expect(all.at(-1)?.word).toBe("Not supported yet");
  });
});

describe("argLine", () => {
  it("joins plain words and quotes a word with a space, a quote or a shell character", () => {
    expect(argLine(["-p", "--tools=Read,Glob", "--model={model}", "Edit(./**)", "Bash(git diff:*)", 'say "hi"'])).toBe('-p --tools=Read,Glob --model={model} "Edit(./**)" "Bash(git diff:*)" "say \\"hi\\""');
  });
});
