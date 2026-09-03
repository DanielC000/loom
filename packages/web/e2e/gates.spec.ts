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

  // Card 10fd660b — a BATCHED merge (`merge_batch`) lands N worker branches under ONE gate, so its row
  // legitimately carries `branch: null` + `taskId: null` and its subject session is the MANAGER. The UI had
  // never been told batches exist, so all three render sites degraded, differently: the history table
  // printed a bare em-dash (indistinguishable from missing data), the queued card fell through to the bare
  // agent name, and the active lane hero rendered no identity line at all.
  //
  // Only ONE real batch exists on record and it predates the durationMs stamping, so both tests below are
  // FIXTURE-driven. Each absence assertion is paired with the SAME locator returning a hit elsewhere in the
  // same test, so a silently-broken locator can never pass as a clean absence.
  test("the history table renders a batch as a batch, never an em-dash, and expands to name its branches", async ({ page, loomDaemon }) => {
    // The batch gates key the MANAGER (no branch, no task) — exactly what mergeBatch's own evtBatch writes.
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "Orchestrator" });
    const branchIdentity = (n: number) => ({ workerSessionId: `w${n}`, taskId: `t${n}`, branch: `loom/batch-${n}` });
    const seedBatch = (durationMs: number, detail: Record<string, unknown>) =>
      loomDaemon.seedOrchestrationEvent({
        managerSessionId: mgr.sessionId, kind: "build_gate",
        detail: { durationMs, gateCap: 2, concurrentGates: 1, ...detail },
      });
    // (1) A passing batch, K=3, all three landed.
    await seedBatch(183000, { passed: true, batched: true, branchCount: 3, branches: [1, 2, 3].map(branchIdentity) });
    // (2) A REJECTED batch, K=2 — the batch identity must survive a rejection.
    await seedBatch(254000, { passed: false, batched: true, branchCount: 2, branches: [4, 5].map(branchIdentity) });
    // (3) A batch that DROPPED a branch at assembly: 4 REQUESTED, 3 LANDED. The two numbers deliberately
    // disagree, so a UI that derived the landed count from `branches.length` (card cf0e2e3b's denominator
    // trap) would render "4 branches" here and fail.
    await seedBatch(325000, { passed: true, batched: true, branchCount: 3, branches: [6, 7, 8, 9].map(branchIdentity) });
    // (4) THE CONTRAST ROW + the em-dash locator's own positive control: a NON-batched gate that genuinely
    // has no branch. It still renders the bare em-dash, which is precisely what a batch must no longer look
    // like — and it proves the em-dash assertions below are not silently matching nothing.
    await seedBatch(47000, { passed: true });
    // (5) THE SOLO POSITIVE CONTROL: an ordinary single-branch worker gate must render exactly as before.
    const solo = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      branch: "loom/batch-solo-control", task: { title: `solo-control-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: solo.sessionId, workerSessionId: solo.sessionId, taskId: solo.taskId,
      kind: "build_gate", detail: { passed: true, durationMs: 96000, gateCap: 2, concurrentGates: 1 },
    });

    await page.goto(`${loomDaemon.baseURL}/gates`);
    await page.getByRole("button", { name: mgr.projectName, exact: true }).click();
    // FIXTURE IDENTITY: the server-side filter must leave EXACTLY this spec's five rows, so nothing below
    // can be a coincidental match against another spec's rows on the shared daemon.
    await expect(page.locator("table tbody tr")).toHaveCount(5);

    // (1) The passing batch: the chip + a real count, and NOT an em-dash anywhere in the row.
    const passRow = page.locator("tr", { hasText: "3m 03s" });
    await expect(passRow.getByText("batch", { exact: true })).toBeVisible();
    await expect(passRow.getByText("3 branches", { exact: true })).toBeVisible();
    await expect(passRow.getByText("\u2014", { exact: true })).toHaveCount(0);
    // (4) …and the SAME em-dash locator DOES hit the non-batched, branchless contrast row, so that zero
    // above is a real absence rather than a broken locator.
    const contrastRow = page.locator("tr", { hasText: "47s" });
    await expect(contrastRow.getByText("\u2014", { exact: true })).toBeVisible();
    await expect(contrastRow.getByText("batch", { exact: true })).toHaveCount(0);

    // (2) The rejected batch keeps its batch identity and is still rendered as a rejection.
    const rejectRow = page.locator("tr", { hasText: "4m 14s" });
    await expect(rejectRow.getByText("2 branches", { exact: true })).toBeVisible();
    await expect(rejectRow.getByText("reject", { exact: true })).toBeVisible();

    // (3) THE DENOMINATOR ASSERTION: 3 landed of 4 requested reads "3 of 4 branches", never "4 branches".
    const dropRow = page.locator("tr", { hasText: "5m 25s" });
    await expect(dropRow.getByText("3 of 4 branches", { exact: true })).toBeVisible();
    await expect(dropRow.getByText("4 branches", { exact: true })).toHaveCount(0);

    // EXERCISE the disclosure control — a render-only check would pass forever on a dead button, so assert
    // an observable BEFORE / AFTER / BEFORE-again state change, not merely that the row drew.
    await expect(dropRow.getByText("loom/batch-6", { exact: true })).toHaveCount(0);
    const disclosure = dropRow.getByRole("button", { name: /3 of 4 branches/ });
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    for (const n of [6, 7, 8, 9]) {
      await expect(dropRow.getByText(`loom/batch-${n}`, { exact: true })).toBeVisible();
    }
    // The expansion is honest about the limit of what the row records: a landed COUNT, never a landed SET.
    await expect(dropRow.getByText(/records how many landed, not which/)).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(dropRow.getByText("loom/batch-6", { exact: true })).toHaveCount(0);

    // (5) THE POSITIVE CONTROL: the solo row is untouched — its real branch name, no batch chrome.
    const soloRow = page.locator("tr", { hasText: "loom/batch-solo-control" });
    await expect(soloRow.getByText("1m 36s", { exact: true })).toBeVisible();
    await expect(soloRow.getByText("batch", { exact: true })).toHaveCount(0);

    // The standing note explains the empty Branch cell without needing a hover (mirrors the non-run legend).
    await expect(page.getByText(/no single branch to name/)).toBeVisible();
  });

  // The ACTIVE half. The GateSemaphore registry is in-memory with no seed path (see this file's header), so
  // the two live sites are driven by fulfilling /api/gates/active with a synthetic GatesActive payload —
  // the same contract the daemon's own snapshotGates builds. Both sites are asserted with a solo control in
  // the SAME payload, so "the batch renders" can never be confused with "the whole lane changed".
  test("the active lane hero and the queued card render a batch instead of losing its identity", async ({ page, loomDaemon }) => {
    const since = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    const base = {
      gateType: "merge" as const, projectId: "p-active-fixture", projectName: "Active Lane Fixture",
      sessionId: "s-active-fixture", taskId: null, priority: null,
    };
    await page.route("**/api/gates/active", (route) => route.fulfill({
      json: {
        cap: 2, activeCount: 2, queuedCount: 2,
        gates: [
          // A RUNNING batch: pre-fix this hero rendered NO identity line at all.
          { ...base, id: "g-run-batch", phase: "running", branch: null, workerLabel: "Orchestrator", since: since(30), queuePosition: null,
            batched: true, branchCount: 3, batchBranches: ["loom/lane-a", "loom/lane-b", "loom/lane-c"] },
          // A RUNNING solo gate — the hero's unchanged path, and the control for the branch-name locator.
          { ...base, id: "g-run-solo", phase: "running", branch: "loom/lane-solo-running", workerLabel: "Dev", since: since(20), queuePosition: null,
            batched: false, branchCount: null, batchBranches: null },
          // A QUEUED batch that dropped one branch: pre-fix this card printed the bare agent name.
          { ...base, id: "g-queued-batch", phase: "queued", branch: null, workerLabel: "Batch Worker Label", since: since(10), queuePosition: 1,
            batched: true, branchCount: 2, batchBranches: ["loom/lane-d", "loom/lane-e", "loom/lane-f"] },
          // A QUEUED branchless SOLO gate — still falls back to its workerLabel, which is BOTH the
          // unchanged-behaviour control and the positive control for the workerLabel locator asserted
          // absent on the batch card above.
          { ...base, id: "g-queued-solo", phase: "queued", branch: null, workerLabel: "Fallback Worker Label", since: since(5), queuePosition: 2,
            batched: false, branchCount: null, batchBranches: null },
        ],
      },
    }));

    await page.goto(`${loomDaemon.baseURL}/gates`);
    // Every assertion below is scoped to the ACTIVE section. The shared daemon carries the sibling
    // history rows this file seeds, and an unscoped "3 branches" would match one of those table cells
    // just as happily as the lane it is meant to be reading.
    const activeSection = page.locator("section").filter({ hasText: "Lane occupancy" }).first();
    // FIXTURE IDENTITY: the fulfilled payload is on screen, not the real (empty) registry.
    await expect(activeSection.getByText("Active Lane Fixture").first()).toBeVisible();

    // SITE 1 — the running lane hero. The batch lane names itself; pre-fix it showed nothing here.
    await expect(activeSection.getByText("3 branches", { exact: true })).toBeVisible();
    await expect(activeSection.getByText("batch", { exact: true }).first()).toBeVisible();
    // …and the solo lane still prints its branch name, unchanged.
    await expect(activeSection.getByText("loom/lane-solo-running", { exact: true })).toBeVisible();

    // SITE 2 — the queued card. The batch shows its landed-of-requested count, NOT its worker label.
    await expect(activeSection.getByText("2 of 3 branches", { exact: true })).toBeVisible();
    await expect(activeSection.getByText("Batch Worker Label", { exact: true })).toHaveCount(0);
    // The SAME workerLabel locator shape DOES hit the branchless solo card, proving that zero is a real
    // absence and that the pre-existing workerLabel fallback is untouched for a non-batched run.
    await expect(activeSection.getByText("Fallback Worker Label", { exact: true })).toBeVisible();
  });
});
