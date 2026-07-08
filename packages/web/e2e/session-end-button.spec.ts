// "End Session" button e2e (card f55bd338) — the one-click graceful wrap-up on the project Overview's
// Fleet accordion (the SessionActions cluster's newest member, sitting LEFT of Fork). Three witnesses:
//   1. SHOW/HIDE — it renders on a live NON-worker row and is ABSENT on a worker row (live && role !==
//      "worker"). One project + one manager + one nested worker ⇒ exactly ONE End Session button.
//   2. CLICK → INJECT — clicking it POSTs the thin daemon route (POST /api/sessions/:id/end), which
//      enqueues the /session-end + end_me wrap-up turn and returns 200. The seeded session has no real
//      pty (no `[pty] spawn` — the no-spawn invariant), so the enqueue is a benign delivered:false; the
//      route accepting a non-worker target and returning 200 is the witness the button did its job.
//   3. ROLE-GATE BACKSTOP — a direct POST against the WORKER session is refused 403: a human must never
//      end a worker out from under its manager (mirrors `end_me` being absent on the worker surface).
//   4. DISABLED WHILE BUSY — gated on idle like Fork; a busy row's button is disabled.
//
// Seeding follows the no-real-claude invariant: live sessions are `processState:"live"` DB rows via
// POST /internal/test/seed (never startSession → no `[pty] spawn`). All assertions scope to the Fleet
// accordion via the button role/name (the only SessionActions consumer on the page — ProjectTerminals'
// TerminalTile carries Fork/Stop only, no End Session, so the count can't be inflated by another lane).
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test.describe("End Session button (card f55bd338)", () => {
  test("renders on a live non-worker fleet row, is absent on a worker row, injects on click, and the route rejects a worker target", async ({ page, loomDaemon }) => {
    // A live manager + its live worker in one project (the same shape overview-layout.spec seeds).
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "EndMgr" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      parentSessionId: mgr.sessionId, branch: "loom/end-worker",
      task: { title: `end-worker-${Date.now()}` },
    });

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(page.locator("main").getByText(/^Fleet/)).toBeVisible();

    // (1) Exactly ONE End Session button: on the manager row, absent on the worker row.
    const endButtons = page.getByRole("button", { name: "End Session" });
    await expect(endButtons).toHaveCount(1);
    await expect(endButtons.first()).toBeEnabled();

    // (1b) It sits LEFT of Fork on that SAME manager row (a lower x = further left). The page has Forks
    // in more than one lane (the Terminals tiles too), so match the Fork sharing End Session's row — the
    // one whose y is within a few px of End Session's — then assert the x-order within that cluster.
    const endBox = (await endButtons.first().boundingBox())!;
    const forks = page.getByRole("button", { name: "Fork" });
    let rowForkX: number | null = null;
    for (let i = 0; i < (await forks.count()); i++) {
      const b = (await forks.nth(i).boundingBox())!;
      if (Math.abs(b.y - endBox.y) < 6) { rowForkX = b.x; break; }
    }
    expect(rowForkX, "a Fork button shares the End Session row").not.toBeNull();
    expect(endBox.x).toBeLessThan(rowForkX!);

    // (2) Clicking POSTs the wrap-up inject route for the MANAGER session and returns 200.
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${mgr.sessionId}/end`) && r.request().method() === "POST"),
      endButtons.first().click(),
    ]);
    expect(res.status()).toBe(200);

    // (3) Role-gate backstop: a direct POST against the WORKER session is refused 403.
    const workerRes = await page.request.post(`${loomDaemon.baseURL}/api/sessions/${wkr.sessionId}/end`);
    expect(workerRes.status()).toBe(403);
  });

  test("is disabled while the session is busy", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "BusyEndMgr", busy: true });
    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(page.locator("main").getByText(/^Fleet/)).toBeVisible();

    // (4) The row renders, but End Session is idle-gated (disabled while busy) — like Fork.
    const endBtn = page.getByRole("button", { name: "End Session" });
    await expect(endBtn).toHaveCount(1);
    await expect(endBtn).toBeDisabled();
  });
});
