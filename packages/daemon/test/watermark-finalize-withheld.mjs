import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 1d9674c9 — a one-shot per-(project, repoKey) finalize-withheld signal, deliberately PARALLEL
// to MAINLINE_BOOT_ALERT_PREFIX/mainlineMovedNudgeText (never reuses either). See the card's own decision
// record for the full design (hook point, delivery shape, re-arm routes, no dedupe with card 1fae1b98).
//
// REAL git on a temp repo, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly,
// same harness shape as stale-generation-watermark-unresolved.mjs (the sibling card's own test), but
// deliberately leaner: Pass A's watermark check runs BEFORE squash-detection ever touches a worker's own
// worktree/branch, so this fixture needs no real createWorktree() cut at all — an ordinary worker session
// row (role, branch, taskId, a `merge_request` event, no worktreePath so staleGeneration stays false) is
// enough to reach the exact same code path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("wfw-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };
const warnsMatching = (needle) => warns.filter((w) => w.includes(needle));
const GIT_ID = "-c user.email=wfw@loom -c user.name=wfw";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Captures every enqueueDurableMessage's own full text, keyed by recipient — the DURABLE nudge, not just
// the shorter per-boot console.warn line (mirrors the sibling card's own sentMessages/sentMatching idiom).
const sentMessages = [];
const pty = { enqueueStdin: (recipientId, text) => { sentMessages.push({ recipientId, text }); return { delivered: false, deliveryState: "queued" }; } };
const sentMatching = (needle) => sentMessages.filter((m) => m.text.includes(needle));
// Raw app_meta key literal — same convention stale-generation-watermark-unresolved.mjs's own UPGRADED_STORE
// scenario uses for `stale_generation_merge_unresolved` — never imported, since the key-builder is a
// module-private `db.ts` function by design (only the public record/clear/list methods are exported).
const wfwKey = (projectId, repoKey) => `watermark-finalize-skip:${projectId}:${repoKey}`;

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wfw\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
}

/**
 * ONE project with a manager (optionally LIVE, so deliverPendingWatermarkFinalizeSkipNotices actually has
 * someone to tell) and N ordinary worker sessions sharing the SAME (project, repoKey="primary") — each
 * with a real `merge_request` event (so `neverRequestedMerge` is false) and no `worktreePath` (so
 * `staleGeneration` stays false; `cwd` points at the repo itself, so `worktreeOnDisk` is harmlessly true,
 * never gating any early-out branch here since this fixture never hits merge_done/no-merge-request at
 * all). Deliberately never calls createWorktree() or cuts a real branch — Pass A's watermark check
 * short-circuits before any of that would ever be touched.
 */
function setupProjectWithWorkers(dbInst, tag, repo, workerCount, managerLive) {
  initRepo(repo);
  const projId = `wfw-${tag}-proj-${sfx}`, agentId = `wfw-${tag}-agent-${sfx}`, mgrId = `wfw-${tag}-mgr-${sfx}`;
  dbInst.insertProject({ id: projId, name: `WFW-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbInst.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  dbInst.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: managerLive ? "live" : "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD");
  const workerIds = [];
  for (let i = 0; i < workerCount; i++) {
    const taskId = `wfw-${tag}-task${i}-${sfx}`, workerId = `wfw-${tag}-worker${i}-${sfx}`, branch = `loom/wfw-${tag}-${i}-${sfx}`;
    dbInst.insertTask({ id: taskId, projectId: projId, title: `WFW-${tag}-${i}`, body: "", columnKey: "in_progress", position: i, createdAt: now, updatedAt: now });
    dbInst.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, branch });
    dbInst.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId, kind: "merge_request", detail: { branch } });
    workerIds.push(workerId);
  }
  return { projId, mgrId, repo, genesisSha, workerIds };
}

// --- DEDUPE_PER_PAIR + DELIVERY: 2 workers sharing ONE (project, repoKey), watermark corrupt, manager
// LIVE. Exactly ONE event + ONE durable nudge for the PAIR, never one per worker, even though BOTH
// workers independently hit the skip branch. watermarkSkipAffectedPairs counts PAIRS, not sessions. ---
let dedupeCtx, dedupeDb, dedupeSessions, dedupeR, dedupeDbPath;
{
  dedupeR = path.join(os.tmpdir(), `loom-wfw-dedupe-${sfx}`);
  dedupeDbPath = path.join(os.tmpdir(), `loom-wfw-dedupe-db-${sfx}.db`);
  try {
    dedupeDb = new Db(dedupeDbPath);
    dedupeSessions = new SessionService(dedupeDb, pty, new OrchestrationControl());
    dedupeCtx = setupProjectWithWorkers(dedupeDb, "dedupe", dedupeR, 2, true);
    dedupeDb.setMeta(mainlineWatermarkKey(dedupeCtx.projId, "primary"), "this is not valid watermark JSON");

    const r1 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("DEDUPE_PER_PAIR reconcile result (boot 1):", JSON.stringify(r1));
    check("(DEDUPE_PER_PAIR boot 1) watermarkSkipAffectedPairs counts the PAIR once, not per worker", r1.watermarkSkipAffectedPairs === 1);
    check("(DEDUPE_PER_PAIR boot 1) exactly ONE watermark_finalize_withheld event, not two",
      dedupeDb.listEvents("").filter((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId).length === 1);
    check("(DEDUPE_PER_PAIR boot 1) the event detail names cause:unreadable and this project/repoKey",
      dedupeDb.listEvents("").some((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId && e.detail?.repoKey === "primary" && e.detail?.cause === "unreadable"));
    check("(DEDUPE_PER_PAIR boot 1) exactly ONE durable nudge sent to the live manager, not two",
      sentMessages.filter((m) => m.recipientId === dedupeCtx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")).length === 1);
    check("(DEDUPE_PER_PAIR boot 1) the nudge names the human remedy: checkout first, then the reset route",
      sentMatching("[loom:watermark-finalize-withheld]").some((m) => m.text.includes("check out the correct mainline branch") && m.text.includes(`mainline-watermark/reset`)));
    check("(DEDUPE_PER_PAIR boot 1) the per-worker aggregate console.warn still names BOTH workers skipped this pass",
      warnsMatching("worker(s) skipped the landed-lookup/finalize").some((w) => w.includes("2 worker(s)")));
    check("(DEDUPE_PER_PAIR boot 1) the marker is nudged (claimed) in the store",
      JSON.parse(dedupeDb.getMeta(wfwKey(dedupeCtx.projId, "primary"))).nudgedAt !== null);

    // --- PERSISTS_ACROSS_BOOTS_NO_REFIRE: boot 2, SAME break still present — no new event, no new nudge. ---
    const r2 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("PERSISTS_ACROSS_BOOTS_NO_REFIRE reconcile result (boot 2):", JSON.stringify(r2));
    check("(PERSISTS_ACROSS_BOOTS_NO_REFIRE boot 2) watermarkSkipAffectedPairs still counts the pair (still broken)", r2.watermarkSkipAffectedPairs === 1);
    check("(PERSISTS_ACROSS_BOOTS_NO_REFIRE boot 2) still exactly ONE event total (no re-fire)",
      dedupeDb.listEvents("").filter((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId).length === 1);
    check("(PERSISTS_ACROSS_BOOTS_NO_REFIRE boot 2) still exactly ONE durable nudge total (no re-fire)",
      sentMessages.filter((m) => m.recipientId === dedupeCtx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")).length === 1);

    // --- REARM_ON_RESOLVE: boot 3, repoint the watermark to a resolvable ref — the marker clears. ---
    dedupeDb.setMeta(mainlineWatermarkKey(dedupeCtx.projId, "primary"), JSON.stringify({ branch: "main", sha: dedupeCtx.genesisSha }));
    const r3 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("REARM_ON_RESOLVE reconcile result (boot 3, watermark now resolves):", JSON.stringify(r3));
    check("(REARM_ON_RESOLVE boot 3) watermarkSkipAffectedPairs drops to 0", r3.watermarkSkipAffectedPairs === 0);
    check("(REARM_ON_RESOLVE boot 3) the marker is cleared (absent) from the store", dedupeDb.getMeta(wfwKey(dedupeCtx.projId, "primary")) === undefined);

    // --- FRESH_BREAK_AFTER_REARM: boot 4, break it again with the OTHER cause — a FRESH event+nudge
    // fires (the one-shot is per-episode, never a permanent lifetime ban on the pair). ---
    dedupeDb.setMeta(mainlineWatermarkKey(dedupeCtx.projId, "primary"), JSON.stringify({ branch: "ghost-branch-never-existed", sha: "0".repeat(40) }));
    const r4 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("FRESH_BREAK_AFTER_REARM reconcile result (boot 4, ref-unresolvable):", JSON.stringify(r4));
    check("(FRESH_BREAK_AFTER_REARM boot 4) watermarkSkipAffectedPairs counts the pair again", r4.watermarkSkipAffectedPairs === 1);
    check("(FRESH_BREAK_AFTER_REARM boot 4) a SECOND, distinct watermark_finalize_withheld event fires (cause: ref-unresolvable)",
      dedupeDb.listEvents("").filter((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId).length === 2
      && dedupeDb.listEvents("").some((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId && e.detail?.cause === "ref-unresolvable" && e.detail?.branch === "ghost-branch-never-existed"));
    check("(FRESH_BREAK_AFTER_REARM boot 4) a SECOND durable nudge fires, naming the conditional (renamed/deleted) remedy",
      sentMessages.filter((m) => m.recipientId === dedupeCtx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")).length === 2
      && sentMatching("[loom:watermark-finalize-withheld]").some((m) => m.text.includes("renamed or deleted")));

    // --- REF_UNRESOLVABLE_PERSISTS_ACROSS_BOOTS_NO_REFIRE: boots 5 and 6, the SAME ref-unresolvable
    // break from boot 4 still present — no new event, no new nudge. Round 2 (Code Review MAJOR): a
    // well-formed watermark naming a dead branch resolves to `state:"ok"` (the row parses fine), so the
    // first hook used to clear the marker unconditionally there, racing the ref-resolvability check below
    // it and re-filing a FRESH marker (isNew:true) every boot — unlike the "unreadable" cause above
    // (PERSISTS_ACROSS_BOOTS_NO_REFIRE), which never hit that race. RED at 628dad89
    // (negative-control --ref 628dad89): boots 5 and 6 each add a THIRD/FOURTH event + nudge instead of
    // staying at two. ---
    const r5 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("REF_UNRESOLVABLE_PERSISTS_ACROSS_BOOTS_NO_REFIRE reconcile result (boot 5):", JSON.stringify(r5));
    check("(REF_UNRESOLVABLE_PERSISTS boot 5) watermarkSkipAffectedPairs still counts the pair (still broken)", r5.watermarkSkipAffectedPairs === 1);
    check("(REF_UNRESOLVABLE_PERSISTS boot 5) still exactly TWO events total (no re-fire for the same ref-unresolvable episode)",
      dedupeDb.listEvents("").filter((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId).length === 2);
    check("(REF_UNRESOLVABLE_PERSISTS boot 5) still exactly TWO durable nudges total (no re-fire)",
      sentMessages.filter((m) => m.recipientId === dedupeCtx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")).length === 2);

    const r6 = await dedupeSessions.reconcileOrchestrationOnBoot(new Set());
    console.log("REF_UNRESOLVABLE_PERSISTS_ACROSS_BOOTS_NO_REFIRE reconcile result (boot 6):", JSON.stringify(r6));
    check("(REF_UNRESOLVABLE_PERSISTS boot 6) watermarkSkipAffectedPairs still counts the pair (still broken)", r6.watermarkSkipAffectedPairs === 1);
    check("(REF_UNRESOLVABLE_PERSISTS boot 6) still exactly TWO events total across 2 more boots (no re-fire)",
      dedupeDb.listEvents("").filter((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === dedupeCtx.projId).length === 2);
    check("(REF_UNRESOLVABLE_PERSISTS boot 6) still exactly TWO durable nudges total across 2 more boots (no re-fire)",
      sentMessages.filter((m) => m.recipientId === dedupeCtx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")).length === 2);
  } finally {
    try { dedupeDb?.close(); } catch { /* best-effort */ }
    for (const p of [dedupeR, dedupeDbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- NO_LIVE_MANAGER_DEFERS_THEN_FIRST_MCP_SEEN_DELIVERS: the project has NO live manager at detection
// time — the event still files (durable, independent of delivery), but the nudge stays pending
// (nudgedAt:null) until onOrchestrationMcpFirstSeen is called for a (now-live) manager session, mirroring
// deliverPendingBootAlerts' own two-caller shape exactly. ---
{
  const R = path.join(os.tmpdir(), `loom-wfw-defer-${sfx}`);
  const dbPath = path.join(os.tmpdir(), `loom-wfw-defer-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const sessions = new SessionService(dbInst, pty, new OrchestrationControl());
    const ctx = setupProjectWithWorkers(dbInst, "defer", R, 1, false); // manager NOT live
    dbInst.setMeta(mainlineWatermarkKey(ctx.projId, "primary"), "not valid watermark JSON either");

    const r1 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("NO_LIVE_MANAGER_DEFERS reconcile result:", JSON.stringify(r1));
    check("(NO_LIVE_MANAGER_DEFERS) the event still files even with no live manager to tell",
      dbInst.listEvents("").some((e) => e.kind === "watermark_finalize_withheld" && e.detail?.projectId === ctx.projId));
    check("(NO_LIVE_MANAGER_DEFERS) the marker stays pending (nudgedAt:null) — nobody has been told yet",
      JSON.parse(dbInst.getMeta(wfwKey(ctx.projId, "primary"))).nudgedAt === null);
    check("(NO_LIVE_MANAGER_DEFERS) no durable nudge was sent (no live recipient existed)",
      sentMessages.filter((m) => m.text.includes("[loom:watermark-finalize-withheld]") && m.text.includes(ctx.projId)).length === 0);

    // The manager comes up later and its first /mcp-orch/ hit fires the chokepoint.
    dbInst.setProcessState(ctx.mgrId, "live");
    sessions.onOrchestrationMcpFirstSeen(ctx.mgrId);
    check("(NO_LIVE_MANAGER_DEFERS) onOrchestrationMcpFirstSeen delivers the deferred nudge once the manager is live",
      sentMessages.some((m) => m.recipientId === ctx.mgrId && m.text.includes("[loom:watermark-finalize-withheld]")));
    check("(NO_LIVE_MANAGER_DEFERS) the marker is now claimed (nudgedAt set)",
      JSON.parse(dbInst.getMeta(wfwKey(ctx.projId, "primary"))).nudgedAt !== null);
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    for (const p of [R, dbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- MALFORMED_MARKER_RECOVERS (the "legacy/absent bookkeeping state" line of the DoD): an absent key, and
// a key holding garbage bytes, must both be treated as "no existing marker" — never thrown, never read as
// already-nudged. Pure DB-level unit check, no boot needed. ---
{
  const dbPath = path.join(os.tmpdir(), `loom-wfw-malformed-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const projId = `wfw-malformed-proj-${sfx}`;

    check("(MALFORMED_MARKER_RECOVERS) an ABSENT key: recordWatermarkFinalizeSkip returns isNew:true, never throws",
      dbInst.recordWatermarkFinalizeSkip(projId, "primary", "unreadable").isNew === true);
    dbInst.clearWatermarkFinalizeSkip(projId, "primary");

    dbInst.setMeta(wfwKey(projId, "primary"), "{{{not json at all");
    const rec = dbInst.recordWatermarkFinalizeSkip(projId, "primary", "ref-unresolvable", "some-branch");
    check("(MALFORMED_MARKER_RECOVERS) a GARBAGE key: still treated as no-existing-marker (isNew:true), never thrown", rec.isNew === true);
    check("(MALFORMED_MARKER_RECOVERS) the garbage bytes are overwritten with a clean marker",
      JSON.parse(dbInst.getMeta(wfwKey(projId, "primary"))).cause === "ref-unresolvable");
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// --- PURGE_COVERAGE: the three required purge sites (card c013e8a5's rule) each clear the marker. ---
{
  const dbPath = path.join(os.tmpdir(), `loom-wfw-purge-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);

    // (1) purgeMainlineWatermarkState — exercised via the human-only resetMainlineWatermark route.
    const p1 = `wfw-purge1-proj-${sfx}`;
    dbInst.recordWatermarkFinalizeSkip(p1, "primary", "unreadable");
    dbInst.resetMainlineWatermark(p1, "primary");
    check("(PURGE_COVERAGE) resetMainlineWatermark (purgeMainlineWatermarkState) clears the marker",
      dbInst.getMeta(wfwKey(p1, "primary")) === undefined);

    // (2) resetMainlineBaselinesForRepoChange — exercised via updateProject changing repoPath.
    const R2a = path.join(os.tmpdir(), `loom-wfw-purge2a-${sfx}`), R2b = path.join(os.tmpdir(), `loom-wfw-purge2b-${sfx}`);
    try {
      initRepo(R2a); initRepo(R2b);
      const p2 = `wfw-purge2-proj-${sfx}`;
      dbInst.insertProject({ id: p2, name: "WFW-purge2", repoPath: R2a, vaultPath: R2a, config: {}, createdAt: now, archivedAt: null });
      dbInst.recordWatermarkFinalizeSkip(p2, "primary", "ref-unresolvable", "ghost");
      dbInst.updateProject(p2, { repoPath: R2b }); // a real path CHANGE — the rebind path
      check("(PURGE_COVERAGE) updateProject repoPath change (resetMainlineBaselinesForRepoChange) clears the marker",
        dbInst.getMeta(wfwKey(p2, "primary")) === undefined);
    } finally {
      for (const p of [R2a, R2b]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
    }

    // (3) deleteProject's purge sweep.
    const R3 = path.join(os.tmpdir(), `loom-wfw-purge3-${sfx}`);
    try {
      initRepo(R3);
      const p3 = `wfw-purge3-proj-${sfx}`;
      dbInst.insertProject({ id: p3, name: "WFW-purge3", repoPath: R3, vaultPath: R3, config: {}, createdAt: now, archivedAt: null });
      dbInst.recordWatermarkFinalizeSkip(p3, "primary", "unreadable");
      dbInst.deleteProject(p3);
      check("(PURGE_COVERAGE) deleteProject's sweep clears the marker", dbInst.getMeta(wfwKey(p3, "primary")) === undefined);
    } finally {
      try { fs.rmSync(R3, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (failures > 0) {
  console.error(`\n❌ ${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log("\n✅ ALL PASS");
}
