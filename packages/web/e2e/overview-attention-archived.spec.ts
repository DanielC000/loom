// Project-Overview attention items survive their session being ARCHIVED (card 5ced500b).
//
// THE DEFECT: `Overview.tsx`'s `projAttention` and `MissionControl.tsx`'s `attnByProject` both resolved an
// attention item's owning project SOLELY by looking its session id up in the live session feed
// (`api.allSessions` -> `db.listAllSessions`, which is `WHERE s.archived_at IS NULL`). Sessions auto-archive
// on exit, so any item that outlives its session silently dropped off the project Overview — the owner's
// PRIMARY board — while still showing on the global Mission Control queue.
//
// WHY EACH CASE IS A BEFORE/AFTER, NOT A RENDER CHECK: a filter that always answers true satisfies any
// "the row is visible" assertion forever. So every test here pairs its PRESENT assertion with controls that
// a no-op filter would FAIL:
//   * the archive is proven to have actually taken effect, by reading the session back off the REAL live
//     feed (`GET /api/sessions`) and requiring it to be GONE. Without that, a silently-failed archive would
//     leave the session live and the row would render for the OLD reason — the test would pass green while
//     proving nothing at all. This is the "after" half's teeth.
//   * a FOREIGN project's item is asserted ABSENT from this project's Overview, on the same page and the
//     same poll. That is what proves the filter still filters.
//
// FIXTURE IDENTITY (load-bearing): the e2e daemon is SHARED across spec files, so a sibling spec's session
// renders a byte-identical row. Every locator is therefore scoped to this test's own session id, or — for
// VAULT LOCK STUCK, whose item carries no session id at all — to a unique repo-path sentinel minted per run.
//
// CLEANUP (load-bearing, and NOT symmetrical across the three kinds): a CODEX ISOLATION GAP and a VAULT
// LOCK STUCK both deliberately lack a liveness filter, so unlike a `merge_request` item neither self-cleans
// when `archiveSeededSessions` runs. Each is superseded explicitly in an afterEach, by the same paired
// "cleared"/managed row a real resolution would file. A pending Request needs no such handling — the
// fixture's own `autoIsolation` answers every seeded question after each test.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, type LoomDaemon } from "./fixtures/daemon";

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Pin the header-selected active project, exactly as overview-layout.spec.ts does. */
async function pinActiveProject(page: Page, projectId: string) {
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

/**
 * Archive ONE session by id, through the same `archiveSessions` seed verb the fixture's own
 * `archiveSeededSessions` uses (which archives EVERY seeded session at once — too coarse here, since these
 * tests need a live control session alongside an archived one). Kept in the spec rather than added to the
 * shared fixture, matching overview-layout.spec.ts's precedent for spec-local REST helpers.
 */
async function archiveSession(baseURL: string, sessionId: string): Promise<void> {
  const res = await fetch(`${baseURL}/internal/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archiveSessions: [sessionId] }),
  });
  if (!res.ok) throw new Error(`archiveSessions -> ${res.status}: ${await res.text()}`);
}

/**
 * THE CONTROL THAT GIVES THIS SPEC ITS TEETH: assert the session is genuinely absent from the LIVE feed the
 * old resolver read. If an archive silently no-opped, the row would still render — for the pre-fix reason —
 * and every assertion downstream would pass while proving nothing.
 */
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

/** The Attention section heading — the positive control for any ABSENT assertion on this page. */
const attentionHeading = (page: Page) => page.locator("main").getByText(/^Attention \(/);

// ── codex isolation-gap seeding, in the daemon's own shape ─────────────────────────────────────────────
const GAP_ITEMS = [{ id: "settingsDirReadDeny", reason: "codex has no filesystem-deny lever for this directory." }];
const ITEMS_KEY = "settingsDirReadDeny";

const seededGaps: { agentSentinel: string; workerSessionId: string }[] = [];
const seededVaultLocks: { repoPath: string; projectId: string }[] = [];

test.afterEach(async ({ loomDaemon }) => {
  // A MANAGED-shape disclosure for the same (agent, item-set) supersedes the parentless row — the same path
  // a real hand-off to a manager takes. Without it the item persists into every later spec's queue.
  for (const { agentSentinel, workerSessionId } of seededGaps.splice(0)) {
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: mintId("oaa-cleanup-mgr"),
      workerSessionId,
      kind: "codex_isolation_gap_disclosed",
      detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: workerSessionId, itemsKey: ITEMS_KEY, nudged: true },
    });
  }
  // The paired `vault_index_lock_cleared` for the same repoPath — latest-wins per repo path, so this is
  // exactly how a real lock release clears the alert.
  for (const { repoPath, projectId } of seededVaultLocks.splice(0)) {
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: "",
      kind: "vault_index_lock_cleared",
      detail: { repoPath, projectId },
    });
  }
});

test.describe("project Overview keeps attention items after archive (card 5ced500b)", () => {
  test("a pending owner REQUEST whose asking session is ARCHIVED still shows on the project Overview", async ({ page, loomDaemon }) => {
    // THE MOST VALUABLE CASE, and one the card's own list of known-affected kinds did not name: a Request
    // routed to a manager that has since exited and archived. `QuestionInboxItem` has carried `projectId`
    // all along; nothing read it, so the owner's own pending decision vanished from the owner's own board.
    const TITLE = `oaa-request-${randomUUID().slice(0, 8)}`; // the fixture sentinel
    const mgr = await loomDaemon.seedLiveSession({ id: mintId("oaa-mgr"), role: "manager", agentName: `OaaMgr${Date.now()}` });
    await loomDaemon.seedQuestion({ sessionId: mgr.sessionId, projectId: mgr.projectId, title: TITLE });

    // A SECOND project's Request — the cross-project control. Same page, same poll; it must never show here.
    const foreignMgr = await loomDaemon.seedLiveSession({ id: mintId("oaa-fgn"), role: "manager", agentName: `OaaFgn${Date.now()}` });
    const FOREIGN_TITLE = `oaa-foreign-${randomUUID().slice(0, 8)}`;
    await loomDaemon.seedQuestion({ sessionId: foreignMgr.sessionId, projectId: foreignMgr.projectId, title: FOREIGN_TITLE });
    expect(foreignMgr.projectId, "the control must be a genuinely DIFFERENT project").not.toBe(mgr.projectId);

    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // BEFORE: the asking manager is still live, so the row resolves by the pre-existing path.
    const row = attentionRow(page, "DECISION NEEDED", mgr.sessionId);
    await expect(row).toBeVisible();
    await expect(row).toContainText(TITLE);

    // Now ARCHIVE the asking manager — the exact transition that used to hide the row.
    await archiveSession(loomDaemon.baseURL, mgr.sessionId);
    await expectArchivedOutOfLiveFeed(loomDaemon.baseURL, mgr.sessionId);

    // AFTER: still on the project Overview, resolved off the Request's own projectId.
    await page.reload();
    await expect(attentionRow(page, "DECISION NEEDED", mgr.sessionId)).toBeVisible();
    await expect(attentionRow(page, "DECISION NEEDED", mgr.sessionId)).toContainText(TITLE);

    // THE FILTER STILL FILTERS: the foreign project's Request is absent, with the section itself visible as
    // the positive control for that absence.
    await expect(attentionHeading(page)).toBeVisible();
    await expect(page.locator("main").getByText(FOREIGN_TITLE)).toHaveCount(0);
  });

  test("a CODEX ISOLATION GAP for an ARCHIVED session still shows on the project Overview", async ({ page, loomDaemon }) => {
    // This kind deliberately has NO liveness filter (card ed0858dc): it reports a standing CONFIGURATION
    // fact whose remedy — the agent's profile harness — outlives the session that disclosed it. A codex run
    // is short-lived, so in practice the session is archived by the time a human looks.
    const AGENT_NAME = `OaaCodex${Date.now()}`;
    const agentSentinel = `oaa-agent-${randomUUID()}`;
    const codex = await loomDaemon.seedLiveSession({
      id: mintId("oaa-cdx"), role: "plain", harness: "codex", agentName: AGENT_NAME,
      // NO parentSessionId: a parentless session is the whole point — there was no manager to nudge.
    });
    await loomDaemon.seedOrchestrationEvent({
      // The daemon files `managerSessionId: parentSessionId ?? sessionId`, so for a parentless session the
      // two ids coincide. That equality is what identifies it as parentless downstream.
      managerSessionId: codex.sessionId,
      workerSessionId: codex.sessionId,
      kind: "codex_isolation_gap_disclosed",
      detail: { items: GAP_ITEMS, agentId: agentSentinel, lineageRootId: codex.sessionId, itemsKey: ITEMS_KEY, nudged: false },
    });
    seededGaps.push({ agentSentinel, workerSessionId: codex.sessionId });

    await pinActiveProject(page, codex.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);

    // BEFORE: live session, row resolves by the pre-existing path.
    await expect(attentionRow(page, "CODEX ISOLATION GAP", codex.sessionId)).toBeVisible();

    await archiveSession(loomDaemon.baseURL, codex.sessionId);
    await expectArchivedOutOfLiveFeed(loomDaemon.baseURL, codex.sessionId);

    // AFTER: still present. Resolved via the project's archived page (the agent-id fallback behind it
    // covers the narrower case of a session aged past that page, which no e2e can stage — it is unit-tested
    // in packages/web/test/fleet.mjs instead).
    await page.reload();
    const row = attentionRow(page, "CODEX ISOLATION GAP", codex.sessionId);
    await expect(row).toBeVisible();
    await expect(row).toContainText("claude protection");
  });

  test("a VAULT LOCK STUCK alert reaches its project's Overview, and only that project's", async ({ page, loomDaemon }) => {
    // This item carries NO session id at all (it keys on `detail.repoPath`; no session owns a vault
    // watcher), so the old session-id-only resolver could never place it — it showed on NO project
    // Overview, ever. The daemon has always filed `detail.projectId` alongside repoPath.
    const mgr = await loomDaemon.seedLiveSession({ id: mintId("oaa-vmgr"), role: "manager", agentName: `OaaVault${Date.now()}` });
    const foreign = await loomDaemon.seedLiveSession({ id: mintId("oaa-vfgn"), role: "manager", agentName: `OaaVaultFgn${Date.now()}` });
    expect(foreign.projectId, "the control must be a genuinely DIFFERENT project").not.toBe(mgr.projectId);

    // The row carries no session id, so the repo path IS this test's fixture sentinel.
    const repoPath = `C:\\oaa-vault-${randomUUID().slice(0, 8)}`;
    await loomDaemon.seedOrchestrationEvent({
      managerSessionId: "", // daemon-global, exactly as vault/versioner.ts files it
      kind: "vault_index_lock_stale",
      detail: { projectId: mgr.projectId, repoPath, lockPath: `${repoPath}\\.git\\index.lock`, ageMs: 600_000, command: `rm "${repoPath}\\.git\\index.lock"` },
    });
    seededVaultLocks.push({ repoPath, projectId: mgr.projectId });

    // PRESENT on the owning project's Overview. Scoped by the repo-path sentinel, since `data-session-id`
    // is the empty string for this kind.
    await pinActiveProject(page, mgr.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    const row = page.locator(`main [data-testid="attention-row"][data-kind="VAULT LOCK STUCK"]`).filter({ hasText: repoPath });
    await expect(row).toBeVisible();
    await expect(row).toContainText("index.lock stuck");

    // ABSENT on a DIFFERENT project's Overview — the cross-project control, which is also what proves the
    // item is being PLACED by its projectId rather than shown to everyone. The Attention heading is the
    // positive control: "not found" here means filtered, not "the page never rendered the section".
    await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), foreign.projectId);
    await page.goto(`${loomDaemon.baseURL}/overview`);
    await expect(attentionHeading(page)).toBeVisible();
    await expect(page.locator(`main [data-testid="attention-row"][data-kind="VAULT LOCK STUCK"]`).filter({ hasText: repoPath })).toHaveCount(0);
  });
});
