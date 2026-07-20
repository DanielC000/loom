// Instrument-Rail nav cleanup (2026-07-20 Product Review §7): three small, independently-verifiable fixes
// in one nav pass, all asserted against the isolated daemon with NO real claude:
//   1. Archive is `scoped: true` (nav.tsx) — its nav row carries the scope dot, matching the fact that the
//      page rescopes on the active-project picker (Archive.tsx › useActiveProject). A NON-scoped sibling
//      (Requests) has no dot, proving the marker is truthful, not decorative-on-everything.
//   2. Alerts vs Requests badges are non-redundant: Alerts now counts ONLY non-request (heuristic/session)
//      attention, Requests counts pending manager→human requests. Seed 2 pending requests + 1 merge-review
//      (a non-request attention item) → Requests shows "2", Alerts shows "1". Before the fix Alerts double-
//      counted the requests and would have read "3" (or matched Requests when requests were the only queue).
//   3. Companion stays reachable in the rail's Config group in BOTH the inactive (no companion) and active
//      (an enabled companion exists) states — the old vestigial `primary`-promotion was removed, so it's
//      always present, never gated in or out.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// A rail nav item (NavLink) whose label contains `label`; a footer stat row for Alerts.
const navItem = (page: Page, label: string) => page.locator(".loom-rail-item", { hasText: label });
const alertsRow = (page: Page) => page.locator(".loom-rail-statrow", { hasText: "Alerts" });

test.describe("Instrument Rail — nav cleanup (Product Review §7)", () => {
  test("Archive carries the scope dot; a non-scoped sibling (Requests) does not", async ({ page, loomDaemon }) => {
    // A project so the rail is in its normal populated state (the scope dot renders off the `scoped` flag,
    // not off having an active project — but seed one for realism).
    const project = await loomDaemon.createProject(uniq("nav-scope"));
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), project.id);

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.locator(".loom-rail")).toBeVisible();

    // Archive's row now shows the scope marker (the fix: nav.tsx Archive gained `scoped: true`).
    await expect(navItem(page, "Archive").locator(".loom-rail-scopedot")).toHaveCount(1);
    // Requests is deliberately god-eye (NOT scoped) — no dot. Proves the marker is truthful per-page, not
    // slapped on every operate-group row.
    await expect(navItem(page, "Requests").locator(".loom-rail-scopedot")).toHaveCount(0);
    // Runs (also scoped) keeps its dot — the contrast pair within the same Operate group.
    await expect(navItem(page, "Runs").locator(".loom-rail-scopedot")).toHaveCount(1);
  });

  test("Alerts and Requests badges mean different things (Alerts excludes requests)", async ({ page, loomDaemon }) => {
    // A live manager owning a live worker — the shape a genuine merge-review attention item needs (the
    // worker must be live for the merge_request to count as a pending review).
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "NavMgr" });
    const worker = await loomDaemon.seedLiveSession({
      project: mgr.project, role: "worker", agentName: "NavWorker", parentSessionId: mgr.sessionId,
    });
    // One NON-request attention item: a pending merge review (carries a workerSessionId, NOT a questionId).
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mgr.sessionId, kind: "merge_request",
      workerSessionId: worker.sessionId, taskId: "task-nav-cleanup-01",
    });
    // Two pending manager→human requests (each carries a questionId → excluded from Alerts by the fix).
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("ask-a"), type: "decision", options: ["A", "B"] });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("ask-b"), type: "decision", options: ["A", "B"] });

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.locator(".loom-rail")).toBeVisible();

    // Requests badge = the 2 pending requests.
    await expect(navItem(page, "Requests").locator(".loom-rail-badge")).toHaveText("2", { timeout: 10_000 });
    // Alerts badge = the 1 non-request (merge-review) item ONLY — NOT 3, and NOT the same as Requests.
    // Before the fix, Alerts counted every attention item (2 requests + 1 merge = 3), making it redundant
    // with / indistinguishable from the Requests badge.
    await expect(alertsRow(page).locator(".loom-rail-badge")).toHaveText("1", { timeout: 10_000 });
  });

  test("Alerts badge is empty when the only attention is requests (no double-count)", async ({ page, loomDaemon }) => {
    // The exact scenario that produced the identical-badges bug: pending requests dominate the queue with
    // nothing else. After the fix Alerts (non-request) is 0 → no badge, while Requests shows the count.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "ReqOnlyMgr" });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("only-a"), type: "decision", options: ["A", "B"] });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("only-b"), type: "decision", options: ["A", "B"] });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: uniq("only-c"), type: "decision", options: ["A", "B"] });

    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(navItem(page, "Requests").locator(".loom-rail-badge")).toHaveText("3", { timeout: 10_000 });
    // No non-request attention → the Alerts row renders no badge at all.
    await expect(alertsRow(page).locator(".loom-rail-badge")).toHaveCount(0);
  });

  test("Companion is reachable in the rail in both the inactive and active states", async ({ page, loomDaemon }) => {
    // INACTIVE: a fresh daemon with no companion — Companion still lives in the rail's Config group.
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(navItem(page, "Companion")).toHaveCount(1);

    // ACTIVE: seed an enabled companion (config + assistant session). The old gating would have "promoted"
    // it; now it simply stays put and reachable — assert it's still present after a reload.
    await loomDaemon.seedCompanion({ name: uniq("NavCompanion") });
    await page.reload();
    await expect(page.locator(".loom-rail")).toBeVisible();
    await expect(navItem(page, "Companion")).toHaveCount(1);
  });
});
