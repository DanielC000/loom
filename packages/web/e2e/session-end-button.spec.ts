// "End Session" button e2e (card f55bd338) — the one-click graceful wrap-up. It lived on the classic project
// Overview's Fleet accordion; card 102bc915 gave the Atlas session node its own, and card acbb6df6 deleted the
// Overview, so this spec drives the session node's head (`/session/:id`). Four witnesses:
//   1. SHOW/HIDE — it renders on a live NON-worker session's node and is ABSENT on a worker's (live &&
//      role !== "worker", `canEndSession` in components/SessionActions.tsx). The worker node is the control
//      for the absence: the same locator, on the same build, against the node that must not offer it.
//   2. CLICK → INJECT — clicking it POSTs the thin daemon route (POST /api/sessions/:id/end), which
//      enqueues the /loom-session-end + end_me wrap-up turn and returns 200. The seeded session has no real
//      pty (no `[pty] spawn` — the no-spawn invariant), so the enqueue is a benign delivered:false; the
//      route accepting a non-worker target and returning 200 is the witness the button did its job.
//   3. ROLE-GATE BACKSTOP — a direct POST against the WORKER session is refused 403: a human must never
//      end a worker out from under its manager (mirrors `end_me` being absent on the worker surface).
//   4. DISABLED WHILE BUSY — gated on idle like Fork; a busy session's button is disabled.
//
// Seeding follows the no-real-claude invariant: live sessions are `processState:"live"` DB rows via
// POST /internal/test/seed (never startSession → no `[pty] spawn`).
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const nodeHead = (page: Page) => page.locator(".loom-atlas-nodehead");

test.describe("End Session button (card f55bd338)", () => {
  test("renders on a live non-worker session node, is absent on a worker's, injects on click, and the route rejects a worker target", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "EndMgr" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      id: `e2e-endwkr-${Date.now()}`,
      parentSessionId: mgr.sessionId, branch: "loom/end-worker",
      task: { title: `end-worker-${Date.now()}` },
    });
    await pinActiveProject(page, mgr.projectId);

    // (1) The WORKER node first: the control for the absence below. Fork is offered there, so the head
    // really rendered its lifecycle controls and End Session is genuinely withheld rather than unrendered.
    await page.goto(`${loomDaemon.baseURL}/session/${wkr.sessionId}`);
    await expect(page.getByTestId("session-node")).toBeVisible();
    await expect(nodeHead(page).getByRole("button", { name: "Fork" })).toBeVisible();
    await expect(page.getByRole("button", { name: "End Session" })).toHaveCount(0);

    // ...and the MANAGER node offers exactly one, enabled.
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node")).toBeVisible();
    const endButtons = page.getByRole("button", { name: "End Session" });
    await expect(endButtons).toHaveCount(1);
    await expect(endButtons.first()).toBeEnabled();

    // (2) Clicking POSTs the wrap-up inject route for the MANAGER session and returns 200.
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${mgr.sessionId}/end`) && r.request().method() === "POST"),
      endButtons.first().click(),
    ]);
    expect(res.status()).toBe(200);

    // (3) Role-gate backstop: a direct POST against the WORKER session is refused 403 — NOT 401. `page.request`
    // is Playwright's own network stack, so card 9ccedbee's loopback guard would otherwise 401 this call
    // BEFORE it reaches the role-gate check this assertion means to exercise; the credential is attached
    // explicitly here.
    const workerRes = await page.request.post(`${loomDaemon.baseURL}/api/sessions/${wkr.sessionId}/end`, {
      headers: { authorization: `Bearer ${loomDaemon.loopbackSecret}` },
    });
    expect(workerRes.status()).toBe(403);
  });

  test("is disabled while the session is busy", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "BusyEndMgr", busy: true });
    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/session/${mgr.sessionId}`);
    await expect(page.getByTestId("session-node")).toBeVisible();

    // (4) The node renders, but End Session is idle-gated (disabled while busy) — like Fork.
    const endBtn = page.getByRole("button", { name: "End Session" });
    await expect(endBtn).toHaveCount(1);
    await expect(endBtn).toBeDisabled();
  });
});
