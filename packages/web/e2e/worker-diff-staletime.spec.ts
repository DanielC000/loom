// The worker-diff query's client-side freshness window (`workerDiffQuery` / WORKER_DIFF_STALE_MS in
// lib/api.ts). react-query's default staleTime is 0, so before this every MOUNT of a diff consumer
// re-issued GET /api/sessions/:id/diff immediately — a git call over a live worktree. The real load on
// that endpoint is therefore a BURST (a wave of refetches as consumers mount: landing on Overview,
// opening a review card, coming back) rather than a steady poll, and it is the client-side half of the
// daemon-wide freeze the 12s daemon-side fingerprint TTL (5cd78d92) only half-fixed.
//
// This spec MEASURES that, it doesn't assert it in the abstract: `page.route` intercepts the endpoint,
// counts every request the app actually issues, and serves a canned diff, so the numbers below are real
// client network traffic under a stated navigation scenario — not a proxy signal. The per-checkpoint
// trace is logged (not just the total) and every hard assertion is deferred to the END, so running this
// against a pre-fix build walks the WHOLE scenario and prints the real before-number instead of aborting
// on the first divergence.
//
// Seeding mirrors overview-layout.spec.ts (the no-real-claude invariant): a live manager + its live
// worker as seeded `processState:"live"` DB rows, and the MERGE REQUEST attention item driven by a seeded
// `merge_request` orchestration_events row — the exact signal that makes Overview render the worker as a
// rich Review-queue card with a "Review →" button. The worker has no real worktree, which is precisely
// why the diff payload is intercepted rather than produced.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";

// Keep in sync with WORKER_DIFF_STALE_MS (packages/web/src/lib/api.ts). The spec asserts BOTH sides of
// this boundary: no refetch inside the window, a refetch once past it.
const WORKER_DIFF_STALE_MS = 10_000;

// One file changed: +2 / −1. Parsed CLIENT-side by lib/diff.analyzeDiff, so it must be a real unified
// diff, not a placeholder string — the rendered "1 file" is the witness that the payload actually landed.
const PATCH_V1 = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "",
].join("\n");

// A SECOND file appears — the "the worktree genuinely changed" payload. The card renders the parsed file
// COUNT, so 1 file → 2 files is an unambiguous witness that a refetch landed and re-rendered.
const PATCH_V2 = PATCH_V1 + [
  "diff --git a/src/panel.ts b/src/panel.ts",
  "index 3333333..4444444 100644",
  "--- a/src/panel.ts",
  "+++ b/src/panel.ts",
  "@@ -1,2 +1,2 @@",
  " const p = 1;",
  "-const q = 2;",
  "+const q = 5;",
  "",
].join("\n");

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

test.describe("worker-diff query freshness window (client-side burst fix)", () => {
  // The correctness half deliberately sits out the full staleTime window, so this one test is longer than
  // the config's 30s default by design.
  test.setTimeout(90_000);

  test("a remount inside the window issues NO new /diff request; past it, a genuine change still surfaces", async ({ page, loomDaemon }) => {
    const mgr = await loomDaemon.seedLiveSession({ role: "manager", agentName: "DiffStaleMgr" });
    const wkr = await loomDaemon.seedLiveSession({
      project: mgr.project, agentId: mgr.agentId, role: "worker",
      parentSessionId: mgr.sessionId, branch: "loom/diff-staletime",
      task: { title: `diff-staletime-${Date.now()}` },
    });
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mgr.sessionId, kind: "merge_request",
      workerSessionId: wkr.sessionId, taskId: wkr.taskId,
    });

    // THE INSTRUMENT: count every worker-diff request the app issues, and serve a canned payload so the
    // count reflects client behaviour alone (the seeded worker has no worktree for the daemon to diff).
    let diffRequests = 0;
    let patch = PATCH_V1;
    await page.route("**/api/sessions/*/diff", async (route) => {
      diffRequests++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ filesChanged: 1, insertions: 2, deletions: 1, patch, uncommitted: false }),
      });
    });
    const trace: string[] = [];
    const mark = (label: string) => trace.push(`${label}=${diffRequests}`);

    await pinActiveProject(page, mgr.projectId);
    // Wall-clock is stamped at the first navigation, NOT at the fixture's daemon boot/seeding, so the
    // logged rate covers the app's own load + navigation phase and nothing else — otherwise boot time
    // would dilute it differently on every run and the before/after numbers wouldn't be comparable.
    const startedAt = performance.now();
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // MOUNT 1 — Overview's Attention block renders the worker as a Review-queue card, which fetches and
    // renders the diff. This is the one request the whole scenario is allowed to make.
    const reviewBtn = page.getByRole("button", { name: "Review →" });
    await expect(reviewBtn).toBeVisible();
    const card = page.locator("main").getByText("1 file", { exact: true });
    await expect(card).toBeVisible();
    mark("overview-mount");

    // MOUNT 2 — client-side navigate into the full ReviewPanel. Same query key, fresh consumer, fresh
    // mount. Pre-fix this refetched immediately; the header chip proves the panel rendered the diff.
    const panelChip = page.locator("main").getByText(/files . \+2/);
    await reviewBtn.click();
    await expect(page).toHaveURL(/\/review\//);
    await expect(panelChip).toBeVisible();
    mark("review-mount");

    // MOUNTS 3-5 — history navigation (pushState pops, NOT reloads, so the QueryClient survives) unmounts
    // and remounts the diff consumers repeatedly. Each of these was its own request pre-fix.
    await page.goBack();
    await expect(card).toBeVisible();
    mark("back");
    await page.goForward();
    await expect(panelChip).toBeVisible();
    mark("forward");
    await page.goBack();
    await expect(card).toBeVisible();
    mark("back");

    // THE MEASUREMENT. Scenario: land on Overview, open the review, back, forward, back — 5 mounts of a
    // worker-diff consumer, navigating as fast as the app settles, with no dwell long enough for the
    // Review-queue cards' own 8s refetchInterval to fire. Pre-fix (staleTime 0) the untuned consumers
    // refetch on every mount; with the window the whole scenario costs 1 request.
    const elapsedMs = performance.now() - startedAt;
    const perMin = (diffRequests / (elapsedMs / 60_000)).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(
      `[measure] worker-diff requests over 5 consumer mounts — ${trace.join(" ")} ` +
      `| total=${diffRequests} in ${Math.round(elapsedMs)}ms = ${perMin}/min (expected total: 1)`,
    );
    expect(diffRequests).toBe(1);

    // ── No correctness regression: the window delays a refetch, it does not suppress one. ──────────────
    // Dwell on the ReviewPanel (which has NO refetchInterval, unlike the Review-queue cards) until the
    // window has elapsed, with the worktree "changed" underneath. Then remount → the refetch fires and the
    // new diff renders. This is what bounds the staleness to the window rather than forever.
    await page.goForward();
    await expect(page).toHaveURL(/\/review\//);
    patch = PATCH_V2;
    await page.waitForTimeout(WORKER_DIFF_STALE_MS + 1_000);
    const beforeRefetch = diffRequests;

    await page.goBack();
    await expect(page.locator("main").getByText("2 files", { exact: true })).toBeVisible();
    expect(diffRequests).toBeGreaterThan(beforeRefetch);
  });
});
