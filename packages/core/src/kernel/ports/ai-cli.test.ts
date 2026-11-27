import { describe, expect, it } from "vitest";
import type { AiCliId } from "../schemas/index.js";
import { type AiCliAdapter, collectAiCliAdapters } from "./ai-cli.js";

const adapter = (id: AiCliId): AiCliAdapter => ({
  kind: "ai-cli",
  id,
  name: id,
  description: "",
  loginCommand: `${id} login`,
  createRuntime: () => ({ launch: () => (async function* () {})() }),
  status: async () => ({ cliId: id, installed: true, loggedIn: true }),
  launch: () => ({ command: id, headlessArgs: [], modelArgs: [], permissionArgs: [], promptVia: "stdin", roleArgs: [], envNames: [] }),
});

describe("collectAiCliAdapters", () => {
  it("keeps the adapters and ignores every other export", () => {
    const claude = adapter("claude-code");
    expect(collectAiCliAdapters(["LOGIN_COMMAND", 3, undefined, null, { id: "claude-code" }, { kind: "runtime", id: "codex-cli" }, claude])).toEqual([claude]);
  });

  it("orders the adapters by id, whatever the order of the exports", () => {
    const list = collectAiCliAdapters([adapter("ollama"), adapter("claude-code"), adapter("codex-cli")]);
    expect(list.map((a) => a.id)).toEqual(["claude-code", "codex-cli", "ollama"]);
  });

  it("is empty when no adapter is wired", () => {
    expect(collectAiCliAdapters([])).toEqual([]);
  });

  it("throws when two adapters have one id", () => {
    expect(() => collectAiCliAdapters([adapter("codex-cli"), adapter("codex-cli")])).toThrow("Two AI CLI adapters have the id codex-cli.");
  });
});
