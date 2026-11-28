// The real end-to-end task: the built engine in real mode, the real Claude Code CLI on the
// engineer's own login, one fixture repo in a temp folder. `builtin/quick-fix` fixes a small bug
// on haiku, Tokama runs the repo's check and commits on its `tokama/` branch. Run it with
// `pnpm e2e:real`; it costs a few cents and never runs in CI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

it("asks a plan for its choices, reach and risks, and plans again after a change request", async ({ skip }) => {
  const workspace = createWorkspace();
  cleanups.push(() => workspace.cleanup());
  writeRepos(workspace);
  const engine = await startEngine(workspace);
  cleanups.push(() => engine.stop());
  const problem = await claudeProblem(engine.client);
  if (problem !== undefined) skip(skipNote(problem));

  const reply = await engine.client.command({ type: "start_item", templateId: "builtin/plan-and-build", repoIds: [REPO_ID], text: TASK });
  if (!reply.ok) throw new Error(`start_item failed: ${reply.error.message}`);
  const itemId = reply.data.itemId;
  const waiting = async (attempts: number) => {
    for (;;) {
      const { item, timedOut } = await waitForItem(engine.client, itemId);
      expect(timedOut, `the plan did not wait for you within ${ITEM_DEADLINE_MS} ms`).toBe(false);
      if (item.steps[0]?.attempts?.length === attempts && item.state === "needs_you") return item;
      await new Promise((done) => setTimeout(done, 500));
    }
  };

  const first = await waiting(1);
  const said = first.steps[0]?.attempts?.[0]?.said;
  const call = JSON.parse(readFileSync(join(workspace.tokamaHome, "items", itemId, "attempts", "plan-1", "call.json"), "utf8")) as { prompt: unknown };
  // The record of the prompt as sent; its shape is the engine's, so it is searched as text.
  expect(JSON.stringify(call.prompt), "the plan step was asked for the plan lines").toContain("CHOICE: <what was open>");
  expect(said?.plan, "the plan step stored a plan summary").toBeDefined();
  const summary = said!.plan!;
  process.stdout.write(`real plan: ${summary.choices.length} choice(s), ${summary.reach.length} reach line(s), ${summary.risks.length} risk(s); headline source ${said!.source}\n`);

  // The note Tokama composes quotes a row the way the Change form does; the agent plans again.
  const row = summary.choices[0];
  const note = row === undefined ? "Also: keep the change as small as you can." : `Plan again with these changes. Keep the first part of every CHOICE line exactly as written below.\nChange:\n- ${row.open ?? row.picked}: you picked "${row.picked}". Instead: whatever is simplest`;
  const asked = first.decision;
  expect(asked, "the plan waits with a question").toBeDefined();
  const resolved = await engine.client.command({ type: "resolve_decision", itemId, decisionId: asked!.id, choice: "request_changes", note });
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  const second = await waiting(2);
  expect(second.steps[0]?.attempts?.[1]?.said?.plan, "the second plan stored a plan summary").toBeDefined();
  const again = JSON.parse(readFileSync(join(workspace.tokamaHome, "items", itemId, "attempts", "plan-2", "call.json"), "utf8")) as { prompt: unknown };
  expect(JSON.stringify(again.prompt), "the note came back word for word").toContain(JSON.stringify(`You asked for changes:\n${note}`).slice(1, -1));
  await engine.client.command({ type: "stop_item", itemId });
});

it("asks an answer for its evidence and next step", async ({ skip }) => {
  const workspace = createWorkspace();
  cleanups.push(() => workspace.cleanup());
  writeRepos(workspace);
  const engine = await startEngine(workspace);
  cleanups.push(() => engine.stop());
  const problem = await claudeProblem(engine.client);
  if (problem !== undefined) skip(skipNote(problem));

  const reply = await engine.client.command({ type: "start_item", templateId: "builtin/ask", repoIds: [REPO_ID], text: "Why would lineTotal in src/total.js return the wrong amount?" });
  if (!reply.ok) throw new Error(`start_item failed: ${reply.error.message}`);
  const itemId = reply.data.itemId;
  const { item, timedOut } = await waitForItem(engine.client, itemId);
  expect(timedOut, `the answer did not end within ${ITEM_DEADLINE_MS} ms and was stopped`).toBe(false);
  const said = item.steps[0]?.attempts?.[0]?.said;
  const call = JSON.parse(readFileSync(join(workspace.tokamaHome, "items", itemId, "attempts", "answer-1", "call.json"), "utf8")) as { prompt: unknown };
  expect(JSON.stringify(call.prompt), "the answer step was asked for the findings lines").toContain("EVIDENCE: <where");
  expect(said?.findings, "the answer step stored a findings record").toBeDefined();
  process.stdout.write(`real answer: ${said!.findings!.evidence.length} evidence line(s), next step ${said!.findings!.next === undefined ? "no" : "yes"}; headline source ${said!.source}\n`);
});

it("asks a reviewer for must-fix lines above its verdict", async ({ skip }) => {
  const workspace = createWorkspace();
  cleanups.push(() => workspace.cleanup());
  writeRepos(workspace);
  const engine = await startEngine(workspace);
  cleanups.push(() => engine.stop());
  const problem = await claudeProblem(engine.client);
  if (problem !== undefined) skip(skipNote(problem));

  const reply = await engine.client.command({ type: "start_item", templateId: "builtin/plan-and-build", repoIds: [REPO_ID], text: TASK });
  if (!reply.ok) throw new Error(`start_item failed: ${reply.error.message}`);
  const itemId = reply.data.itemId;
  const waiting = await waitForItem(engine.client, itemId);
  expect(waiting.timedOut, "the plan did not wait for you").toBe(false);
  const asked = waiting.item.decision;
  expect(asked, "the plan waits with a question").toBeDefined();
  const approved = await engine.client.command({ type: "resolve_decision", itemId, decisionId: asked!.id, choice: "approve" });
  expect(approved.ok, JSON.stringify(approved)).toBe(true);
  // Build, its checks and the review run; the item stops running when it is done or waits again.
  const ended = await waitForItem(engine.client, itemId, ITEM_DEADLINE_MS * 2);
  expect(ended.timedOut, "the review did not end in time").toBe(false);
  const said = ended.item.steps[2]?.attempts?.[0]?.said;
  const call = JSON.parse(readFileSync(join(workspace.tokamaHome, "items", itemId, "attempts", "review-1", "call.json"), "utf8")) as { prompt: unknown };
  expect(JSON.stringify(call.prompt), "the review step was asked for must-fix lines").toContain("MUST: <where");
  expect(said?.review, "the review step stored a review record").toBeDefined();
  process.stdout.write(`real review: ${said!.review!.mustFix.length} must-fix line(s); headline source ${said!.source}\n`);
  await engine.client.command({ type: "stop_item", itemId });
});
