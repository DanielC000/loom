// CRASH-LOOPED survives its subject session being ARCHIVED (card 7be85378).
//
// THE DEFECT: `attention.ts`'s CRASH-LOOPED derivation was ONLY `all.filter(isCrashLooped)` — iterating
// the live session feed (`api.allSessions` -> `db.listAllSessions`, `WHERE archived_at IS NULL`).
// `SessionService.archiveOnExit` archives every worker (and any manager/platform with zero live workers)
// on every exit, including the exit that pushes a crash-loop past its cap — and nothing un-archives the
// row before the watcher's own give-up tick stamps the `[loom:crash-loop]` banner. So the item could
// never be built for exactly the population it exists to warn about: a worker that crash-looped to
// exhaustion. Mirrors overview-attention-archived.spec.ts's structure (same daemon fixture, same
// archive-then-assert shape) for the kind that card's own list did not cover.
//
// WHY BEFORE/AFTER, NOT A RENDER CHECK: a filter that always answers true satisfies any "the row is
// visible" assertion forever. The "before" half proves the row genuinely does not exist yet (so "after"
// isn't just a row that was there all along); the "after" half proves the real daemon write path
// (`db.appendEvent`'s session_recovery_abandoned, filed AFTER the session is already archived, exactly as
// CrashRecoveryWatcher.tick's give-up branch does it) makes the row appear on BOTH Mission Control (the
// global queue) and the project Overview (project-scoped) — the two surfaces `useAttention` feeds.
//
// CROSS-SPEC CLEANUP (card 9703fcd9 — load-bearing, same shape as codex-isolation-gap-attention.spec.ts's
// own afterEach): a `session_recovery_abandoned` row has NO liveness filter and no automatic expiry
// (lib/fleet.ts's `activeCrashLoopAbandonments` keys purely off the event stream), so unlike `merge_request`
// it does NOT self-clean when `archiveSeededSessions` archives the subject session — the CRASH-LOOPED item
// persists globally into every later spec's "Alerts" count (nav.tsx's badge is daemon-wide, not
// project-scoped) until a later `session_recovered` for the same session supersedes it. Without this
// afterEach, this file's own seeded row leaked into nav-cleanup.spec.ts's "Alerts excludes requests"
// assertion (expected 1, observed 2) on the shared worker-scoped e2e daemon.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// Every worker session id this file seeded a `session_recovery_abandoned` row for, so the afterEach can
// supersede each one. Recorded at seed time (not rebuilt from the page) so a test that fails mid-way still
// gets its row cleaned up — mirrors codex-isolation-gap-attention.spec.ts's `seededGaps`.
const abandonedWorkerIds: string[] = [];

test.afterEach(async ({ loomDaemon }) => {
  for (const workerSessionId of abandonedWorkerIds.splice(0)) {
    // A `session_recovered` for the SAME session, filed AFTER the abandoned row — exactly the shape
    // CrashRecoveryWatcher.tick's own stable-resume branch writes (managerSessionId: parentSessionId ??
    // sessionId, workerSessionId: sessionId). `activeCrashLoopAbandonments` keys the latest-by-ts event
    // per session, so this supersedes the abandoned row and the item clears — the real "it recovered"
    // path, not a fixture-only shortcut.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: workerSessionId, workerSessionId, kind: "session_recovered", detail: { afterAttempts: 3 },
    });
    // Fail loudly: a cleanup that quietly no-ops breaks a LATER spec, not this one.
    const res = await fetch(`${loomDaemon.baseURL}/api/orchestration/events?kinds=session_recovery_abandoned,session_recovered`);
    if (!res.ok) throw new Error(`cleanup read-back: GET events -> ${res.status}`);
    const rows = (await res.json()) as { kind: string; workerSessionId: string | null; managerSessionId: string }[];
    // The route orders ts DESC, so the newest row for this session must now be the superseding recovery.
    const newest = rows.find((r) => (r.workerSessionId ?? r.managerSessionId) === workerSessionId);
    if (newest?.kind !== "session_recovered") {
      throw new Error(`cleanup: expected session_recovered to supersede session_recovery_abandoned for ${workerSessionId}, got ${JSON.stringify(newest)}`);
    }
  }
});

/** Pin the header-selected active project, exactly as overview-attention-archived.spec.ts does. */
async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/** Same helper as overview-attention-archived.spec.ts — archives ONE session via the test-only seed route. */
async function archiveSession(baseURL: string, sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/internal/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archiveSessions: [sessionId] }),
  });
  if (!res.ok) throw new Error(`archiveSessions -> ${res.status}: ${await res.text()}`);
}

/** THE CONTROL THAT GIVES THIS SPEC ITS TEETH: the session is genuinely gone from the live feed the
 *  pre-fix CRASH-LOOPED derivation read exclusively. If the archive silently no-opped, the row would
 *  still render for the OLD reason and every assertion downstream would prove nothing. */
async function expectArchivedOutOfLiveFeed(baseURL: string, sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/sessions`);
  expect(res.ok, "GET /api/sessions must answer").toBe(true);
  const live = (await res.json()) as { id: string }[];
  expect(
    live.map((s) => s.id),
    "the archived session must be GONE from the live feed — otherwise the row renders for the old reason",
  ).not.toContain(sessionId);
}

const attentionRow = (page: Page, kind: string, sessionId: string) =>
  page.locator(`main [data-testid="attention-row"][data-kind="${kind}"][data-session-id="${sessionId}"]`);

const attentionHeading = (page: Page) => page.locator("main").getByText(/^Attention \(/);

test.describe("CRASH-LOOPED survives archive, on both Mission Control and the project Overview (card 7be85378)", () => {
  test("an archived crash-looped worker's item appears on MC + its Overview, never on a foreign project's", async ({ page, loomDaemon }) => {
    // The minted session id IS this test's sentinel — unique per run, and what every locator below scopes
    // on, so a sibling spec's row on the SHARED e2e daemon can never be mistaken for this one's.
    const worker = await loomDaemon.seedLiveSession({ id: mintId("cla-wkr"), role: "worker", agentName: `ClaWkr${Date.now()}` });

    // A SECOND project — the cross-project control, same as overview-attention-archived.spec.ts.
    const foreign = await loomDaemon.seedLiveSession({ id: mintId("cla-fgn"), role: "worker", agentName: `ClaFgn${Date.now()}` });
    expect(foreign.projectId, "the control must be a genuinely DIFFERENT project").not.toBe(worker.projectId);

    // BEFORE: no crash-loop signal filed yet. Nothing for this session on either surface.
    await pinActiveProject(page, worker.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(attentionRow(page, "CRASH-LOOPED", worker.sessionId)).toHaveCount(0);
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(attentionRow(page, "CRASH-LOOPED", worker.sessionId)).toHaveCount(0);

    // Now ARCHIVE the worker — the exact transition that happens before the real watcher's give-up tick
    // ever runs (archiveOnExit fires synchronously on the exit that pushed it past the cap).
    await archiveSession(loomDaemon.baseURL, worker.sessionId);
    await expectArchivedOutOfLiveFeed(loomDaemon.baseURL, worker.sessionId);

    // THEN file the give-up event, exactly as CrashRecoveryWatcher.tick's give-up branch does it —
    // AFTER the archive, never before. detail.projectId is deliberately OMITTED: db.appendEvent's own
    // DURABLE_AUDIT_EVENT_KINDS backstop (9f7f2b50) stamps it from workerSessionId, exactly as it does
    // in production — this spec exercises that real write path, not a fixture shortcut around it.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: worker.sessionId,
      workerSessionId: worker.sessionId,
      kind: "session_recovery_abandoned",
      detail: { role: "worker", attempts: 3 },
    });
    abandonedWorkerIds.push(worker.sessionId);

    // AFTER: Mission Control (the global queue, route "/") shows it.
    await page.goto(`${loomDaemon.baseURL}/`);
    const mcRow = attentionRow(page, "CRASH-LOOPED", worker.sessionId);
    await expect(mcRow).toBeVisible();
    await expect(mcRow).toContainText("died 3");
    await expect(mcRow).toContainText("archived");

    // AFTER: the project Overview (project-scoped) shows it too — resolved via the event's own
    // appendEvent-backstopped projectId, not a session lookup (the session is no longer live).
    await page.goto(`${loomDaemon.baseURL}/overview`);
    const ovRow = attentionRow(page, "CRASH-LOOPED", worker.sessionId);
    await expect(ovRow).toBeVisible();
    await expect(ovRow).toContainText("died 3");

    // THE FILTER STILL FILTERS: the foreign project's Overview never shows this worker's row, with the
    // section itself visible as the positive control for that absence.
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), foreign.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(attentionHeading(page)).toBeVisible();
    await expect(attentionRow(page, "CRASH-LOOPED", worker.sessionId)).toHaveCount(0);
  });
});
