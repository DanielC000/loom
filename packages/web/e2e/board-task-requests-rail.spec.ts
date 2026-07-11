// Board task-details "Dossier" connected-requests rail e2e (card 8c1f27f0 — Phase 2 build of the owner-
// picked Variant A · Dossier, with the owner's addition that the requests rail be COLLAPSIBLE). The task
// modal (Board.tsx › TaskDrawer) is now a TWO-COLUMN dossier: LEFT = the existing task-editing surface,
// RIGHT = a rail of the card's connected Requests, wired to the same project+task-scoped read the MCP
// pair (commit 9e5a733 / card 988bb585) enforces — here via the global inbox filtered by projectId+taskId.
//
// Each interactive control is driven to an OBSERVABLE before/after state change (not just "renders clean"):
//   1. The rail renders populated (count + by-state summary + one signal row per connected request).
//   2. The collapse toggle flips two-column → full-width single-column (rail → slim strip) and back — the
//      left editing column measurably widens while collapsed.
//   3. A request row inline-EXPANDS to its recorded answer; a CREDENTIAL row shows only the ack + target
//      env var, NEVER a secret value.
//
// Seeding (the no-real-claude invariant, same as requests-inbox.spec.ts): a live manager is a
// `processState:"live"` DB row via the seed endpoint; each request is a seeded row via
// loomDaemon.seedQuestion (deps.db.insertQuestion), soft-linked to a seeded board task by `taskId`.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import path from "node:path";

// Screenshot hook (opt-in via LOOM_E2E_SHOTS, same as board.spec.ts): unset in CI, so this is a no-op
// there. Set it to a dir to persist the rendered dossier states for a visual review.
const shotDir = process.env.LOOM_E2E_SHOTS;
const shoot = async (page: Page, name: string) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, name) }); };

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ISO = "2026-07-11T00:00:00.000Z";

// Seed one project (via a live manager) + a board task + three connected requests spanning the three
// lifecycle states (pending / answered / consumed) and the two answer shapes we assert on (a decision with
// a chosen option + note, and a credential with only an env var). Returns the ids/titles the spec asserts.
async function seedCardWithRequests(loomDaemon: import("./fixtures/daemon").LoomDaemon) {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DossierMgr" });
  const task = await loomDaemon.createTask(mgr.projectId, { title: uniq("dossier-card"), columnKey: "todo" });
  const decTitle = uniq("decision-ask");
  const credTitle = uniq("credential-ask");
  const inpTitle = uniq("input-ask");
  // answered decision — chosen option + note.
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, taskId: task.id, title: decTitle,
    type: "decision", options: ["Ship now", "Wait"], state: "answered",
    chosenOption: "Ship now", note: "go ahead — the gate is green", answeredAt: ISO,
  });
  // consumed credential — env var only; the secret is never a field (never-echo).
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, taskId: task.id, title: credTitle,
    type: "credential", credentialEnvVar: "STRIPE_API_KEY", state: "consumed", answeredAt: ISO,
  });
  // pending input — no answer yet.
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, taskId: task.id, title: inpTitle,
    type: "input", body: "Which region should the bucket live in?", state: "pending",
  });
  return { projectId: mgr.projectId, task, decTitle, credTitle, inpTitle };
}

test("the task modal renders the two-column dossier with a populated connected-requests rail", async ({ page, loomDaemon }) => {
  const seed = await seedCardWithRequests(loomDaemon);
  await pinActiveProject(page, seed.projectId);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(seed.task.id)}`);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The rail (RIGHT column) is present and populated…
  const rail = dialog.getByTestId("task-requests-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByText("Connected requests", { exact: true })).toBeVisible();
  // …with the by-state summary (1 pending / 1 answered / 1 consumed) and one row per request.
  await expect(rail.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(rail.getByText("1 answered", { exact: true })).toBeVisible();
  await expect(rail.getByText("1 consumed", { exact: true })).toBeVisible();
  await expect(rail.getByText(seed.decTitle, { exact: true })).toBeVisible();
  await expect(rail.getByText(seed.credTitle, { exact: true })).toBeVisible();
  await expect(rail.getByText(seed.inpTitle, { exact: true })).toBeVisible();
  // …and the LEFT editing column still carries the task-editing surface (Title/Priority + Save).
  const editCol = dialog.getByTestId("task-edit-column");
  await expect(editCol.getByText("Title", { exact: true })).toBeVisible();
  await expect(editCol.getByRole("button", { name: "Save" })).toBeVisible();
  await shoot(page, "dossier-two-column.png");
});

test("the collapse control flips two-column → full-width single-column and back", async ({ page, loomDaemon }) => {
  const seed = await seedCardWithRequests(loomDaemon);
  await pinActiveProject(page, seed.projectId);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(seed.task.id)}`);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const rail = dialog.getByTestId("task-requests-rail");
  const strip = dialog.getByTestId("task-requests-collapsed");
  const editCol = dialog.getByTestId("task-edit-column");

  // BEFORE: two-column — the rail is shown, the collapsed strip is not, and the editing column is the
  // narrower left slice.
  await expect(rail).toBeVisible();
  await expect(strip).toHaveCount(0);
  const twoColWidth = (await editCol.boundingBox())!.width;
  await shoot(page, "collapse-before-two-column.png");

  // Collapse → the rail is replaced by the slim strip and the editing column takes the full width.
  await dialog.getByTestId("task-requests-collapse").click();
  await expect(rail).toHaveCount(0);
  await expect(strip).toBeVisible();
  const fullColWidth = (await editCol.boundingBox())!.width;
  await shoot(page, "collapse-after-single-column.png");
  // OBSERVABLE: the editing column measurably widened (rail was ~280+px; the column reclaims most of it).
  expect(fullColWidth).toBeGreaterThan(twoColWidth + 120);

  // Expand again via the strip → back to two-column.
  await strip.click();
  await expect(rail).toBeVisible();
  await expect(strip).toHaveCount(0);
  const backWidth = (await editCol.boundingBox())!.width;
  expect(Math.abs(backWidth - twoColWidth)).toBeLessThan(4);
});

// Card c089a959: a Request filed BEFORE commit 76b4bdb (which taught `question_ask` to resolve+store the
// CANONICAL FULL task id) can have a raw 8-char id-PREFIX sitting in its `task_id` column — seeded here by
// bypassing question_ask entirely (seedQuestion writes straight through db.insertQuestion, exactly like a
// legacy pre-fix row would have landed). The rail's `startsWith` fallback must still surface it.
test("a legacy prefix-stored taskId (pre-76b4bdb row) still shows on the card's rail", async ({ page, loomDaemon }) => {
  const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "LegacyPrefixMgr" });
  const task = await loomDaemon.createTask(mgr.projectId, { title: uniq("legacy-prefix-card"), columnKey: "todo" });
  const legacyTitle = uniq("legacy-prefix-ask");
  await loomDaemon.seedQuestion({
    sessionId: mgr.sessionId, projectId: mgr.projectId, taskId: task.id.slice(0, 8), title: legacyTitle,
    type: "decision", options: ["Ship now", "Wait"], state: "answered",
    chosenOption: "Ship now", note: "legacy prefix-linked row", answeredAt: ISO,
  });
  await pinActiveProject(page, mgr.projectId);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(task.id)}`);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const rail = dialog.getByTestId("task-requests-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByText("Connected requests", { exact: true })).toBeVisible();
  await expect(rail.getByText(legacyTitle, { exact: true })).toBeVisible();
});

test("a request row expands to its answer; a credential row shows the ack + env var, never a secret", async ({ page, loomDaemon }) => {
  const seed = await seedCardWithRequests(loomDaemon);
  await pinActiveProject(page, seed.projectId);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${loomDaemon.baseURL}/board?task=${encodeURIComponent(seed.task.id)}`);

  const dialog = page.getByRole("dialog");
  const rail = dialog.getByTestId("task-requests-rail");
  await expect(rail).toBeVisible();

  // BEFORE: the decision row's answer is collapsed (not present).
  await expect(rail.getByText(/go ahead — the gate is green/)).toHaveCount(0);
  await shoot(page, "row-before-collapsed.png");
  // Expand the decision row (clicking its title toggles the row) → the chosen option + note appear.
  await rail.getByText(seed.decTitle, { exact: true }).click();
  await expect(rail.getByText("Ship now", { exact: true })).toBeVisible();
  await expect(rail.getByText(/go ahead — the gate is green/).first()).toBeVisible();

  // Expand the credential row → ONLY the ack + the target env var; NEVER a secret value.
  await expect(rail.getByText(/encrypted, never shown/)).toHaveCount(0);
  await rail.getByText(seed.credTitle, { exact: true }).click();
  await expect(rail.getByText(/provided · encrypted, never shown/).first()).toBeVisible();
  await expect(rail.getByText("STRIPE_API_KEY", { exact: true })).toBeVisible();
  await shoot(page, "row-after-expanded.png");
});
