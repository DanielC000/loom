// Gates page e2e (card a1c86452) — the god-eye view of Loom's daemon-executed gates. Verifies the hybrid
// layout renders and, crucially, that HISTORY reads the real /api/gates/history endpoint END TO END: the
// JOIN enrichment (projectName / branch / worker label resolved from the keyed session + task), the outcome
// derivation from the event detail, the run-time `durationMs` render, and the per-project filter's
// server-side scoping.
//
// Seeding (the no-real-claude invariant): each gate run is a seeded worker session (a `processState:"live"`
// DB row via POST /internal/test/seed — never startSession, so no `[pty] spawn`) plus a `worker_gate`
// orchestration_events row (seedOrchestrationEvent — the SAME appendEvent writer runWorkerGate itself uses).
// The ACTIVE lane-hero reads the in-memory GateSemaphore registry, which has no seed path — with no real
// gate in flight it correctly renders its empty state, which this spec also asserts.
import { expect, test } from "./fixtures/daemon";

test.describe("Gates page (card a1c86452)", () => {
  test("renders the hybrid layout; history reads the real endpoint with enriched rows; the per-project filter scopes it", async ({ page, loomDaemon }) => {
    // Project A: a PASS worker gate + a TIMEOUT (SIGKILL) worker gate, both on the SAME project. A worker
    // gate keys BOTH manager_session_id and worker_session_id to the worker (mirrors runWorkerGate).
    const passWkr = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "QA Tester", branch: "loom/gate-pass", task: { title: `gate-pass-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: passWkr.sessionId, workerSessionId: passWkr.sessionId, taskId: passWkr.taskId,
      kind: "worker_gate", detail: { passed: true, durationMs: 107000 },
    });
    const timeoutWkr = await loomDaemon.seedLiveSession({
      project: passWkr.project, agentId: passWkr.agentId, role: "worker",
      branch: "loom/gate-timeout", task: { title: `gate-timeout-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: timeoutWkr.sessionId, workerSessionId: timeoutWkr.sessionId, taskId: timeoutWkr.taskId,
      kind: "worker_gate", detail: { passed: false, timedOut: true, signal: "SIGKILL", durationMs: 900000, failingTest: "migrate.spec.ts" },
    });

    // Project B: a SEPARATE project with its own PASS gate — the witness that the filter scopes server-side.
    const otherWkr = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "Dev", branch: "loom/other-proj", task: { title: `other-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: otherWkr.sessionId, workerSessionId: otherWkr.sessionId, taskId: otherWkr.taskId,
      kind: "worker_gate", detail: { passed: true, durationMs: 61000 },
    });

    await page.goto(`${loomDaemon.baseURL}/gates`);

    // Layout: both halves of the approved hybrid render (scoped to <main> so the nav can't be mistaken).
    await expect(page.locator("main").getByText(/Lane occupancy/)).toBeVisible();
    await expect(page.locator("main").getByText(/^History/).first()).toBeVisible();
    // Active lane-hero: no real gate is in flight (the registry has no seed path) → the empty state renders.
    await expect(page.getByText(/No gate is running or queued/)).toBeVisible();

    // History reads the real endpoint: all three seeded runs render, enriched via the JOIN (branch column).
    await expect(page.getByText("loom/gate-pass")).toBeVisible();
    await expect(page.getByText("loom/gate-timeout")).toBeVisible();
    await expect(page.getByText("loom/other-proj")).toBeVisible();

    // The timeout row carries the DERIVED outcome (timedOut → "timeout"), the run-time duration
    // (900000ms → 15m 00s), and the failing test — exact match on "timeout" so the branch cell
    // ("loom/gate-timeout", which CONTAINS "timeout") isn't a second match.
    const timeoutRow = page.locator("tr", { hasText: "loom/gate-timeout" });
    await expect(timeoutRow.getByText("timeout", { exact: true })).toBeVisible();
    await expect(timeoutRow.getByText("15m 00s")).toBeVisible();
    await expect(timeoutRow.getByText("migrate.spec.ts")).toBeVisible();
    // The pass row's run-time duration renders (107000ms → 1m 47s).
    await expect(page.locator("tr", { hasText: "loom/gate-pass" }).getByText("1m 47s")).toBeVisible();

    // Per-project filter scopes HISTORY server-side (the ?projectId= param): clicking Project A's chip
    // drops Project B's run; "All" brings it back.
    await page.getByRole("button", { name: passWkr.projectName, exact: true }).click();
    await expect(page.getByText("loom/gate-pass")).toBeVisible();
    await expect(page.getByText("loom/other-proj")).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText("loom/other-proj")).toBeVisible();
  });
});
