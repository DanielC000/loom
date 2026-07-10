// Requests-modal-everywhere e2e (owner report: "request detail is only modal from the Requests page —
// make it modal on Overview and Mission too"). The fix routes every IN-APP request-answer affordance
// through ONE shared RequestModalProvider / useOpenRequest, so a pending Request opens the detail dialog
// IN PLACE over the current page instead of navigating to /question/:id. This spec is the regression
// witness for the two surfaces the owner hit — the project Overview and the god-eye Mission Control —
// plus proof the standalone /question/:id deep-link still works.
//
// Seeding (the no-real-claude invariant): a live manager is a `processState:"live"` DB row via the seed
// endpoint; the pending decision Request is a seeded row via loomDaemon.seedQuestion (deps.db.insertQuestion,
// the same writer question_ask uses). The "Answer →" affordance is a real click; no `[pty] spawn` runs.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}
const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe("Request detail opens as an in-place modal everywhere (owner report)", () => {
  test("Overview 'Answer →' opens the Request modal in place — URL stays /overview, Esc closes it", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "OvReqMgr" });
    const title = uniq("overview-decision");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Ship the release now, or hold for the audit?", options: ["Ship", "Hold"],
    });

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // The Attention section renders the pending Request as an AttentionRow with an "Answer →" affordance.
    const answer = page.locator("main").getByRole("button", { name: "Answer →" }).first();
    await expect(answer).toBeVisible();

    // Clicking it opens the shared modal IN PLACE — a dialog appears and the URL never leaves /overview.
    const urlBefore = page.url();
    await answer.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(title, { exact: true })).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await expect(page).toHaveURL(/\/overview$/);

    // Esc dismisses it (observable close), still without a navigation.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/overview$/);
  });

  test("Mission Control 'Answer →' opens the Request modal in place — URL stays / (no route push)", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "McReqMgr" });
    const title = uniq("mission-decision");
    await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "decision",
      body: "Approve the risky migration, or split it?", options: ["Approve", "Split"],
    });

    await page.goto(`${loomDaemon.baseURL}/`);

    // The god-eye attention queue renders the pending Request with an "Answer →" affordance (first in DOM,
    // above the Fleet cards). Clicking it opens the shared modal over "/" — no push to /question/:id.
    const answer = page.locator("main").getByRole("button", { name: "Answer →" }).first();
    await expect(answer).toBeVisible();

    const urlBefore = page.url();
    await answer.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(title, { exact: true })).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await expect(page).not.toHaveURL(/\/question\//);

    // The ✕ close button dismisses it in place.
    await dialog.getByRole("button", { name: "✕" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/question\//);
  });

  test("/question/:id still works as a standalone deep-link (the modal did not replace it)", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DeepReqMgr" });
    const title = uniq("deeplink-decision");
    const qId = await loomDaemon.seedQuestion({
      sessionId: mgr.sessionId, projectId: mgr.projectId, title, type: "input",
      body: "What should the new agent be named?",
    });

    await page.goto(`${loomDaemon.baseURL}/question/${qId}`);
    // The standalone route renders the same RequestDetail body (no dialog wrapper) — the ask + its control.
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "← back" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/question/${qId}$`));
  });
});
