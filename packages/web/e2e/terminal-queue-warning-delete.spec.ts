// Queue mutability — a Loom `kind:"warning"` operational nudge (e.g. [loom:worker-idle]) is DELETABLE and
// reorderable from the SessionQueue drawer, while an agent-AUTHORED entry (source:"system" + kind:"agent" —
// a worker report / manager direction) stays READ-ONLY. Owner complaint (2026-07-11): "I literally just see
// a [loom:worker-idle] in your queue that I can't delete. I meant all messages in queue not only the users."
// The fix widened the daemon's mutability gate + the UI from source:"human"-only to (source:"human" OR
// kind:"warning"); this spec LOCKS the end-to-end behavior the owner asked for.
//
// Drives the REAL render + delete hop hermetically — no real claude spawn:
//   • Seed the End-User Platform "Operator session" as a CANNED-pty tile (the same canned-session recipe as
//     terminal-queue-ledger.spec.ts), so a real terminal renders with no metered spawn.
//   • Arm the canned session busy with ONE POST /input (it delivers immediately; reconcile SKIPS canned, so
//     busy never self-clears), then seed THREE HELD entries via the test-only enqueue seam:
//       - a HUMAN composer turn (source:"human"      — fully adjustable: reorder + edit + delete),
//       - a LOOM NUDGE  ([loom:worker-idle], kind:"warning" — reorder + delete, NOT edit),
//       - an AGENT report ([loom:from-worker], kind:"agent"  — READ-ONLY).
//   • Expand the drawer and assert: the warning row carries a "loom" tag + a Remove control; the agent row
//     is read-only ("worker" tag, no Remove); there are exactly TWO Remove controls (human + warning) and
//     ONE Edit control (human only).
//   • DELETE the warning specifically, then assert the queue actually CHANGED — count 3 → 2, the
//     [loom:worker-idle] text is gone from both the drawer AND the GET /queue API, and the agent + human
//     entries survive untouched.
import { expect, test } from "./fixtures/daemon";

const WARNING_TEXT = "[loom:worker-idle] worker sat idle 8m — nudge or reassign";
const AGENT_TEXT = "[loom:from-worker] report: finished task, branch pushed";
const HUMAN_TEXT = "human composer turn — my own queued message";

test("a Loom kind:'warning' nudge is deletable from the queue drawer; an agent-authored entry stays read-only", async ({ page, loomDaemon }) => {
  // Resolve the reserved Platform home + its operator agent (same discovery the end-user PlatformView uses).
  const home = await (await fetch(`${loomDaemon.baseURL}/api/setup/home`)).json();
  const profiles = await (await fetch(`${loomDaemon.baseURL}/api/profiles`)).json();
  const roleOf = (a: { profileId?: string | null }) =>
    profiles.find((p: { id: string; role: string }) => p.id === a.profileId)?.role ?? null;
  const operator = home.agents.find((a: { profileId?: string | null }) => roleOf(a) === "setup")
    ?? home.agents.find((a: { name: string }) => a.name === "Platform");
  expect(operator, "the reserved Platform home should seed an operator agent").toBeTruthy();

  // Seed the operator session as a CANNED-pty tile with a real (tall) rendered grid.
  const seeded = await loomDaemon.seedLiveSession({
    project: { id: home.project.id, name: home.project.name },
    agentId: operator.id,
    role: "setup",
    ptyGeometry: { cols: 80, rows: 40 },
    ptyBytes: "LOOM-QUEUE-WARNING-DELETE\r\na warning nudge should be deletable here\r\n",
  });

  await page.goto(`${loomDaemon.baseURL}/platform`);
  await expect(page.getByText("Operator session", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".xterm-accessibility-tree > div").filter({ hasText: "LOOM-QUEUE-WARNING-DELETE" })).toBeVisible();

  // Arm busy with a delivered turn, then seed the three HELD entries (all held while busy).
  const armed = await (await fetch(`${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/input`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "first turn — delivers and arms busy" }),
  })).json();
  expect(armed.delivered, "the first input delivers and arms the canned session busy").toBe(true);

  const human = await (await fetch(`${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/input`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: HUMAN_TEXT }),
  })).json();
  expect(human.delivered, "the human composer turn is held while busy").toBe(false);

  const warn = await loomDaemon.enqueueMessage({ sessionId: seeded.sessionId, text: WARNING_TEXT, source: "system", kind: "warning" });
  expect(warn.delivered, "the Loom warning nudge is held while busy").toBe(false);
  const agent = await loomDaemon.enqueueMessage({ sessionId: seeded.sessionId, text: AGENT_TEXT, source: "system", kind: "agent" });
  expect(agent.delivered, "the agent-authored entry is held while busy").toBe(false);

  // The ledger bar shows all three queued. Expand the drawer.
  await expect(page.getByText(/Queued \(3\)/)).toBeVisible({ timeout: 8000 });
  const bar = page.getByTestId("queue-ledger-bar");
  await bar.click({ force: true });
  const drawer = page.getByTestId("queue-drawer");
  await expect(drawer).toBeVisible();

  // The warning row carries a "loom" tag + a Remove control; the agent row is read-only ("worker" tag).
  await expect(drawer.getByText("loom", { exact: true })).toBeVisible();
  await expect(drawer.getByText("worker", { exact: true })).toBeVisible();
  // Exactly TWO Remove controls (human + warning) and ONE Edit control (human only) — the agent row has neither.
  await expect(page.getByTitle("Remove from queue")).toHaveCount(2);
  await expect(page.getByTitle("Edit this queued message")).toHaveCount(1);

  // BEFORE: the warning entry is present in the drawer.
  const warnRow = drawer.locator("> div").filter({ hasText: "[loom:worker-idle]" });
  await expect(warnRow).toBeVisible();

  // DELETE the warning specifically (its own row's Remove control).
  await warnRow.getByTitle("Remove from queue").click({ force: true });

  // AFTER: the queue actually changed — count 3 → 2 and the warning text is gone from the drawer.
  await expect(page.getByText(/Queued \(2\)/)).toBeVisible({ timeout: 8000 });
  await expect(drawer.getByText("[loom:worker-idle]", { exact: false })).toHaveCount(0);
  // The agent + human entries survive; only ONE Remove control remains (the human's).
  await expect(drawer.getByText("worker", { exact: true })).toBeVisible();
  await expect(drawer.locator("> div").filter({ hasText: "human composer turn" })).toBeVisible();
  await expect(page.getByTitle("Remove from queue")).toHaveCount(1);

  // Ground-truth via the API: the warning is gone from the FIFO; the agent + human entries remain.
  const queue = await (await fetch(`${loomDaemon.baseURL}/api/sessions/${seeded.sessionId}/queue`)).json();
  const texts = (queue.pending as { text: string }[]).map((p) => p.text);
  expect(texts, "the warning text is deleted from the pty FIFO").not.toContain(WARNING_TEXT);
  expect(texts, "the agent-authored entry survives").toContain(AGENT_TEXT);
  expect(texts, "the human composer entry survives").toContain(HUMAN_TEXT);
});
