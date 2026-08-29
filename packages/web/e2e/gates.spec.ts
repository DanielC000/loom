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

  // Card 04cef8d7 — the human surface consumes `gateRan` (card 3a6f04cc). A row where no gate PROCESS
  // spawned still carries a real durationMs, but it measures op overhead, not gate execution; rendered
  // plain it contaminates a duration trend. The acceptance evidence is the CONTRAST: the two row types
  // must LOOK DIFFERENT. Each absence assertion below is paired with the same locator returning a hit on
  // the non-run row in the same test, so a silently-broken locator can't pass as a clean absence.
  test("a non-run row's duration is de-emphasised and labelled; a real run's is not", async ({ page, loomDaemon }) => {
    // A REUSED merge gate: detail.reused → gateRan:false, outcome "pass" (db.ts's gateRanFromDetail).
    const reused = await loomDaemon.seedLiveSession({
      role: "worker", agentName: "Dev", branch: "loom/gate-reused", task: { title: `reused-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: reused.sessionId, workerSessionId: reused.sessionId, taskId: reused.taskId,
      kind: "build_gate", detail: { passed: true, reused: true, durationMs: 2034 },
    });
    // An INERT-DIFF skip (card db9b0130): outcome "skipped" + an explicit gateSpawned:false stamp.
    const skipped = await loomDaemon.seedLiveSession({
      project: reused.project, agentId: reused.agentId, role: "worker",
      branch: "loom/gate-inert", task: { title: `inert-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: skipped.sessionId, workerSessionId: skipped.sessionId, taskId: skipped.taskId,
      kind: "build_gate", detail: { skipped: true, gateSpawned: false, durationMs: 4100 },
    });
    // A REAL merge gate on the same project: no reuse/skip signal → gateRan:true, a plain duration.
    const real = await loomDaemon.seedLiveSession({
      project: reused.project, agentId: reused.agentId, role: "worker",
      branch: "loom/gate-real-run", task: { title: `real-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: real.sessionId, workerSessionId: real.sessionId, taskId: real.taskId,
      kind: "build_gate", detail: { passed: true, durationMs: 872000 },
    });

    await page.goto(`${loomDaemon.baseURL}/gates`);
    await page.getByRole("button", { name: reused.projectName, exact: true }).click();

    // The reused row: the duration is PARENTHESISED (2034ms → "(2s)") and carries the marker.
    const reusedRow = page.locator("tr", { hasText: "loom/gate-reused" });
    await expect(reusedRow.getByText("(2s)", { exact: true })).toBeVisible();
    await expect(reusedRow.getByText("no gate ran", { exact: true })).toBeVisible();
    // …and it is still a PASS, not a failure — the row is not dropped or recoloured as an error.
    await expect(reusedRow.getByText("pass", { exact: true })).toBeVisible();

    // The inert-diff row: same treatment, and its outcome reads "skipped" (a non-verdict), not a reject.
    const skippedRow = page.locator("tr", { hasText: "loom/gate-inert" });
    await expect(skippedRow.getByText("(4s)", { exact: true })).toBeVisible();
    await expect(skippedRow.getByText("no gate ran", { exact: true })).toBeVisible();
    await expect(skippedRow.getByText("skipped", { exact: true })).toBeVisible();

    // The REAL run: a bare, unparenthesised duration (872000ms → "14m 32s") and NO marker. The two
    // getByText patterns here are the SAME ones that just matched above, so a zero here is a real
    // absence rather than a broken locator.
    const realRow = page.locator("tr", { hasText: "loom/gate-real-run" });
    await expect(realRow.getByText("14m 32s", { exact: true })).toBeVisible();
    await expect(realRow.getByText("no gate ran", { exact: true })).toHaveCount(0);
    await expect(realRow.getByText("(14m 32s)", { exact: true })).toHaveCount(0);

    // The always-visible legend explains the convention without a hover, and says the duration is a
    // real number measuring the wrong thing — never that it is missing or broken.
    await expect(page.getByText(/real number measuring op overhead, not gate execution/)).toBeVisible();
  });
});
