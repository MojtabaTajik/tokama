// Proves the preset's own `boundaries/root-path` setting. The fixture test sets
// ESLINT_PLUGIN_BOUNDARIES_ROOT_PATH, which the plugin reads first, so a wrong setting would pass
// there. This file runs in its own worker without that variable, against the real repo layout.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

beforeAll(() => {
  delete process.env["ESLINT_PLUGIN_BOUNDARIES_ROOT_PATH"];
});

it("classifies core files from the repo root without the env override", async () => {
  const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, "eslint.config.js") });
  // A slice must not import composition.ts, which exists in the real repo, so the import resolves.
  const [result] = await eslint.lintText('export * from "../../composition.js";', {
    filePath: join(repoRoot, "packages/core/src/slices/probe/virtual.ts"),
  });
  expect(result?.messages.map((m) => m.ruleId)).toEqual(["boundaries/dependencies"]);
});
