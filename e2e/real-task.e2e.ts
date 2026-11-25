// The real end-to-end task: the built engine in real mode, the real Claude Code CLI on the
// engineer's own login, one fixture repo in a temp folder. `builtin/quick-fix` fixes a small bug
// on haiku, Tokama runs the repo's check and commits on its `tokama/` branch. Run it with
// `pnpm e2e:real`; it costs a few cents and never runs in CI.
import { afterEach, expect, it } from "vitest";
import {
  claudeProblem,
  createWorkspace,
  expectGoodRun,
  ITEM_DEADLINE_MS,
  mainTree,
  REPO_ID,
  realTokamaHome,
  skipNote,
  startEngine,
  TASK,
  usageLine,
  waitForItem,
  writeRepos,
} from "./support/real.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("fixes a bug with Quick fix and commits it on the item branch", async ({ skip }) => {
  const started = Date.now();
  const workspace = createWorkspace();
  cleanups.push(() => workspace.cleanup());
  writeRepos(workspace);
  const realHomeBefore = realTokamaHome();
  const before = mainTree(workspace);
  expect(before.status, "the fixture starts clean").toBe("");

  const engine = await startEngine(workspace);
  cleanups.push(() => engine.stop());
  const problem = await claudeProblem(engine.client);
  if (problem !== undefined) skip(skipNote(problem));

  const reply = await engine.client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: [REPO_ID], text: TASK });
  if (!reply.ok) throw new Error(`start_item failed: ${reply.error.message}`);
  const { item, timedOut } = await waitForItem(engine.client, reply.data.itemId);
  expect(timedOut, `the item did not end within ${ITEM_DEADLINE_MS} ms and was stopped`).toBe(false);

  const { commit, branch, events } = expectGoodRun(workspace, before, item);
  expect(realTokamaHome(), "the real ~/.tokama is untouched").toEqual(realHomeBefore);

  const attempts = events.filter((event) => event.type === "attempt_started").length;
  const usage = usageLine(item.id) ?? "no usage found: the engine stores none and the session transcript was not found";
  process.stdout.write(`real task: done in ${Math.round((Date.now() - started) / 1000)} s, ${attempts} attempt(s), commit ${commit.slice(0, 7)} on ${branch}, ${usage}\n`);
});
