// RECYCLE LINEAGE CONSOLIDATED (card 65294dcc, docs/decisions/65294dcc) — a both-dead halted-recycle
// lineage's consolidation banner (docs/decisions/a4c5f234) surfaces as its own deliberate web attention
// item, never doubling with the generic ORPHANED FLEET item the consolidation branch's reused lastError
// prefix would otherwise also match, and clears once the predecessor is archived.
//
// WHY BEFORE/AFTER, NOT A RENDER CHECK: a filter that always answers true satisfies any "the row is
// visible" assertion forever. The "before" half (predecessor exited + banner-matching, but no
// recycle_split_lineage_consolidated event yet) proves the specific kind genuinely depends on the event —
// and that the GENERIC ORPHANED FLEET item is what renders in its absence, the positive control for the
// exclusion this card adds. The "after" half proves the event makes the specific item appear AND makes the
// generic item for the SAME predecessor disappear — exactly once per lineage, never both.
//
// CROSS-SPEC CLEANUP (mirrors crash-loop-attention-archived.spec.ts's own afterEach): the seeded
// predecessor is archived in afterEach, idempotently, so a failed assertion mid-test still leaves nothing
// for a LATER spec's global "Alerts"/attention count on the shared worker-scoped e2e daemon.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/daemon";

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const consolidatedPredecessorIds: string[] = [];

async function archiveSession(baseURL: string, sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/internal/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archiveSessions: [sessionId] }),
  });
  if (!res.ok) throw new Error(`archiveSessions -> ${res.status}: ${await res.text()}`);
}

test.afterEach(async ({ loomDaemon }) => {
  for (const sessionId of consolidatedPredecessorIds.splice(0)) {
    await archiveSession(loomDaemon.baseURL, sessionId);
  }
});

async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

const attentionRow = (page: Page, kind: string, sessionId: string) =>
  page.locator(`main [data-testid="attention-row"][data-kind="${kind}"][data-session-id="${sessionId}"]`);

test.describe("RECYCLE LINEAGE CONSOLIDATED survives the generic ORPHANED FLEET collision, and clears on archive (card 65294dcc)", () => {
  test("a consolidated lineage gets its own item, never doubles with ORPHANED FLEET, and clears once the predecessor is archived", async ({ page, loomDaemon }) => {
    // The predecessor P, exactly as `finishReconcilingHaltedRecycleSuccessors`'s `consolidated` branch
    // leaves it: processState "exited", un-archived, lastError carrying the reused [loom:orphaned-fleet]
    // banner prefix (docs/decisions/a4c5f234) — but (for now) no recycle_split_lineage_consolidated event.
    const predecessor = await loomDaemon.seedLiveSession({
      id: mintId("rlc-pred"), role: "manager", agentName: `RlcPred${Date.now()}`,
      processState: "exited",
      lastError: "[loom:orphaned-fleet] A halted recycle's successor died too, and this predecessor is also not resumable — consolidated for e2e.",
    });

    await pinActiveProject(page, predecessor.projectId);

    // BEFORE: no event yet — isOrphanedFleet(P) alone renders the GENERIC item, never the specific one.
    // This is the positive control: it proves the exclusion added to the generic loop is reachable at all
    // (it only skips a predecessor id the specific derivation actually covers).
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(attentionRow(page, "RECYCLE LINEAGE CONSOLIDATED", predecessor.sessionId)).toHaveCount(0);
    await expect(attentionRow(page, "ORPHANED FLEET", predecessor.sessionId)).toBeVisible();

    // File the consolidation event — exactly as the real daemon branch does it.
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: predecessor.sessionId, kind: "recycle_split_lineage_consolidated",
      detail: { deadSuccessorId: mintId("rlc-succ") },
    });
    consolidatedPredecessorIds.push(predecessor.sessionId);

    // AFTER: the specific item appears on Mission Control (global queue, route "/") — and the generic
    // ORPHANED FLEET item for the SAME predecessor is gone: exactly one item for this lineage, not two.
    await page.goto(`${loomDaemon.baseURL}/`);
    const mcRow = attentionRow(page, "RECYCLE LINEAGE CONSOLIDATED", predecessor.sessionId);
    await expect(mcRow).toBeVisible();
    await expect(mcRow).toContainText("consolidated back here");
    await expect(attentionRow(page, "ORPHANED FLEET", predecessor.sessionId)).toHaveCount(0);

    // AFTER: the project Overview (project-scoped) shows it too.
    await page.goto(`${loomDaemon.baseURL}/overview`);
    const ovRow = attentionRow(page, "RECYCLE LINEAGE CONSOLIDATED", predecessor.sessionId);
    await expect(ovRow).toBeVisible();
    await expect(attentionRow(page, "ORPHANED FLEET", predecessor.sessionId)).toHaveCount(0);

    // CLEARS: archive the predecessor — one of the banner's own named remedies (start a new manager,
    // retire this one). isStillConsolidated re-derives off the live session row on every poll, so once P
    // is no longer present (archived), both surfaces drop the item with no separate "cleared" event.
    await archiveSession(loomDaemon.baseURL, predecessor.sessionId);
    await page.goto(`${loomDaemon.baseURL}/`);
    await expect(attentionRow(page, "RECYCLE LINEAGE CONSOLIDATED", predecessor.sessionId)).toHaveCount(0);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(attentionRow(page, "RECYCLE LINEAGE CONSOLIDATED", predecessor.sessionId)).toHaveCount(0);
  });
});
