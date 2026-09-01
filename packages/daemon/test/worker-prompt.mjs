import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af902717 — a manager-spawned worker must receive its agent BASE BRIEF (agent.startupPrompt)
// composed ahead of the dynamic part, on BOTH paths (spawn kickoff + recycle handoff). Before this,
// `composeWorkerStartupPrompt` didn't exist and workers only ever got the dynamic text — so the
// Dev/Bugfix/Web-Designer briefs ("Step 0: run `/worker`", "CLAUDE.md is law") were dead config.
//
// DETERMINISTIC + CLAUDE-FREE, hermetic like manager-context-block.mjs: isolated LOOM_HOME, a REAL Db +
// SessionService driven against a FAKE pty injected via PtyHost's createPty() seam — no real claude, no
// daemon, no network. A real temp git repo backs the project so spawnWorker/recycleWorker's worktree git
// is real. The fake pty fires its onExit on kill() so recycleWorker's hard-stop wait resolves instantly.
//
// Proves the DoD:
//   (1) pure composeWorkerStartupPrompt: brief leads, dynamic follows; empty/whitespace/undefined ⇒ dynamic-only.
//   (2) SPAWN: a brief-bearing worker's opts.startupPrompt = brief THEN kickoff; an empty-brief worker = kickoff alone.
//   (3) RECYCLE: a brief-bearing worker's successor opts.startupPrompt = brief THEN handoff; empty-brief = handoff alone.
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, needle) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && (!needle || String(threw.message).includes(needle));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
};

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-wprompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { composeWorkerStartupPrompt } = await import("../dist/sessions/worker-prompt.js");
const { removeWorktree } = await import("../dist/git/worktrees.js");

// --- a real temp git repo so worktree git (real) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-wprompt-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# worker-prompt test\n");
execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pW", name: "WProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgr", projectId: "pW", name: "Orchestrator", startupPrompt: "MGR_DOCTRINE", position: 0, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pW", name: "Dev", startupPrompt: "DEV_BRIEF", position: 1, profileId: null });
db.insertAgent({ id: "agentQA", projectId: "pW", name: "QA", startupPrompt: "", position: 2, profileId: null }); // empty brief (like the shipped QA agent)
db.insertSession({
  id: "mgr1", projectId: "pW", agentId: "agentMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
const taskA = "11111111-1111-1111-8111-111111111111";
const taskB = "22222222-2222-2222-8222-222222222222";
db.insertTask({ id: taskA, projectId: "pW", title: "A", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
db.insertTask({ id: taskB, projectId: "pW", title: "B", body: "", columnKey: "todo", position: 2, createdAt: now, updatedAt: now });

// --- fake pty (shared _seam-host-fixture.mjs base): captures every SpawnOpts; kill() fires onExit so
// recycleWorker's hard-stop wait resolves fast ---
class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return super.createPty(opts); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);
const order = (s, a, b) => s.includes(a) && s.includes(b) && s.indexOf(a) < s.indexOf(b);

const worktrees = [];
const worktreesR = [];
let repoR = null;
try {
  // ===================== (1) pure composeWorkerStartupPrompt =====================
  const composed = composeWorkerStartupPrompt("BRIEF", "DYNAMIC");
  check("(1) pure: brief leads, dynamic follows", order(composed, "BRIEF", "DYNAMIC"));
  check("(1) pure: undefined brief ⇒ dynamic-only", composeWorkerStartupPrompt(undefined, "DYNAMIC") === "DYNAMIC");
  check("(1) pure: whitespace brief ⇒ dynamic-only (trimmed away)", composeWorkerStartupPrompt("   \n  ", "DYNAMIC") === "DYNAMIC");
  check("(1) pure: empty brief ⇒ dynamic-only", composeWorkerStartupPrompt("", "DYNAMIC") === "DYNAMIC");
  // 2-arg form (no cwd) stays byte-identical — backward-compat for the pure callers/tests.
  check("(1) pure: 2-arg form (no cwd) is byte-unchanged — no location block", composeWorkerStartupPrompt("BRIEF", "DYNAMIC") === "BRIEF\n\n---\n\nDYNAMIC");
  // 3-arg form prepends the worktree location block ahead of the brief, naming the cwd as the edit dir.
  const composedCwd = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path");
  check("(1) pure: cwd ⇒ worktree block leads, then brief, then dynamic", order(composedCwd, "/wt/path", "BRIEF") && order(composedCwd, "BRIEF", "DYNAMIC"));
  check("(1) pure: cwd ⇒ block names the worktree as the edit dir", composedCwd.includes("make ALL edits here") && composedCwd.includes("`/wt/path`"));
  // Block is present even with an EMPTY brief (the QA startupPrompt:"" case) — block then dynamic.
  const composedEmptyCwd = composeWorkerStartupPrompt("", "DYNAMIC", "/wt/path");
  check("(1) pure: empty brief + cwd ⇒ block still present, leads the dynamic part", composedEmptyCwd.includes("`/wt/path`") && order(composedEmptyCwd, "/wt/path", "DYNAMIC"));

  // ===================== (1e) reference-repos epic Phase 3: referenceRepos block =====================
  check("(1e) pure: no referenceRepos (undefined) ⇒ byte-identical to the pre-Phase-3 composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path") === composedCwd);
  check("(1e) pure: empty referenceRepos ⇒ byte-identical to omitted", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", []) === composedCwd);
  check("(1e) pure: no referenceRepos ⇒ no 'Also referenced' block", !composedCwd.includes("Also referenced"));
  const composedWithRefs = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", ["/abs/refA", "/abs/refB"]);
  check("(1e) pure: non-empty referenceRepos ⇒ 'Also referenced' block present", composedWithRefs.includes("Also referenced"));
  check("(1e) pure: both reference repo paths listed", composedWithRefs.includes("/abs/refA") && composedWithRefs.includes("/abs/refB"));
  check("(1e) pure: read-only framing present (never commit there)", /never commit there/i.test(composedWithRefs));
  check("(1e) pure: worktree location block + brief + dynamic all still present alongside the ref block", composedWithRefs.includes("/wt/path") && composedWithRefs.includes("BRIEF") && composedWithRefs.includes("DYNAMIC"));
  // no cwd ⇒ no location block ⇒ referenceRepos is moot too (there's nowhere to anchor it) — still byte-identical to the 2-arg form.
  check("(1e) pure: no cwd ⇒ referenceRepos is ignored, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, ["/abs/refA"]) === "BRIEF\n\n---\n\nDYNAMIC");

  // ===================== (1f) board card 2250836c: reusedDirtyWorktree reconcile-note block =====================
  check("(1f) pure: no reusedDirtyWorktree (undefined) ⇒ byte-identical to the pre-card composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", ["/abs/refA", "/abs/refB"]) === composedWithRefs);
  check("(1f) pure: no reusedDirtyWorktree ⇒ no reconcile block", !composedCwd.includes("Reused worktree"));
  const dirtyInfo = { statusSummary: "?? leftover.txt\n M modified.txt", fileCount: 2, truncated: false };
  const composedDirty = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo);
  check("(1f) pure: reusedDirtyWorktree set ⇒ reconcile block present", composedDirty.includes("Reused worktree"));
  check("(1f) pure: reconcile block names the leftover paths", composedDirty.includes("leftover.txt") && composedDirty.includes("modified.txt"));
  check("(1f) pure: reconcile block tells the worker to finish or revert before new edits", /finish|revert/i.test(composedDirty));
  check("(1f) pure: worktree location block + brief + dynamic still all present alongside the reconcile block", composedDirty.includes("/wt/path") && composedDirty.includes("BRIEF") && composedDirty.includes("DYNAMIC"));
  check("(1f) pure: no cwd ⇒ reusedDirtyWorktree is ignored too, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, undefined, dirtyInfo) === "BRIEF\n\n---\n\nDYNAMIC");
  const truncatedInfo = { statusSummary: "?? a.txt\n?? b.txt", fileCount: 40, truncated: true };
  const composedTruncated = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, truncatedInfo);
  check("(1f) pure: truncated summary surfaces the true total count", composedTruncated.includes("40"));

  // ===================== (1g) card 5150fdc2: staleBase forward-merge-note block =====================
  check("(1g) pure: no staleBase (undefined) ⇒ byte-identical to the pre-card composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo) === composedDirty);
  check("(1g) pure: no staleBase ⇒ no stale-base block", !composedCwd.includes("Stale branch base"));
  const staleInfo = { baseSha: "abc123def456", behindBy: 3, changedFiles: ["src/a.ts", "src/b.ts"], truncated: false };
  const composedStale = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, undefined, staleInfo);
  check("(1g) pure: staleBase set ⇒ stale-base block present", composedStale.includes("Stale branch base"));
  check("(1g) pure: block names the behind-by count", composedStale.includes("3 commit(s) behind"));
  check("(1g) pure: block names the fork-point sha", composedStale.includes("abc123def456"));
  check("(1g) pure: block names the changed files", composedStale.includes("src/a.ts") && composedStale.includes("src/b.ts"));
  check("(1g) pure: block instructs merging/rebasing the mainline forward", /merge|rebase/i.test(composedStale));
  check("(1g) pure: worktree location block + brief + dynamic still all present alongside the stale-base block", composedStale.includes("/wt/path") && composedStale.includes("BRIEF") && composedStale.includes("DYNAMIC"));
  check("(1g) pure: no cwd ⇒ staleBase is ignored too, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, undefined, undefined, staleInfo) === "BRIEF\n\n---\n\nDYNAMIC");
  const staleTruncatedInfo = { baseSha: "deadbeef0000", behindBy: 50, changedFiles: Array.from({ length: 30 }, (_, i) => `f${i}.ts`), truncated: true };
  const composedStaleTruncated = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, undefined, staleTruncatedInfo);
  check("(1g) pure: truncated changedFiles surfaces a 'more files changed' note", /more files changed/i.test(composedStaleTruncated));
  // BOTH a dirty reuse note AND a stale-base note can co-exist (independent signals) — order: dirty then stale.
  const composedBoth = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo, staleInfo);
  check("(1g) pure: dirtyBlock + staleBlock can co-exist", composedBoth.includes("Reused worktree") && composedBoth.includes("Stale branch base"));
  check("(1g) pure: dirty block leads the stale-base block", order(composedBoth, "Reused worktree", "Stale branch base"));

  // ===================== (1h) card 47bbdc3f: reviewOf mechanically-injected block =====================
  check("(1h) pure: no reviewOf (undefined) ⇒ byte-identical to the pre-card composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo, staleInfo) === composedBoth);
  check("(1h) pure: no reviewOf ⇒ no review block", !composedCwd.includes("REVIEW spawn"));
  const reviewInfo = { branch: "loom/abc123def456", headSha: "cafebabe1234" };
  const composedReview = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, undefined, undefined, undefined, reviewInfo);
  check("(1h) pure: reviewOf set ⇒ review block present", composedReview.includes("REVIEW spawn"));
  check("(1h) pure: block names the reviewed branch", composedReview.includes("loom/abc123def456"));
  check("(1h) pure: block names the resolved tip sha", composedReview.includes("cafebabe1234"));
  check("(1h) pure: block tells the worker ordinary Read/Grep already shows the reviewed content", /Read.*Grep/i.test(composedReview));
  check("(1h) pure: block flags the pinned-snapshot caveat (a later push is not reflected)", /pinned snapshot|pushed.*commits/i.test(composedReview));
  check("(1h) pure: worktree location block + brief + dynamic still all present alongside the review block", composedReview.includes("/wt/path") && composedReview.includes("BRIEF") && composedReview.includes("DYNAMIC"));
  check("(1h) pure: no cwd ⇒ reviewOf is ignored too, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, undefined, undefined, undefined, undefined, reviewInfo) === "BRIEF\n\n---\n\nDYNAMIC");

  // ===================== (1i) board card 13cc2300: discardedOnRecut destroyed-work note block =====================
  check("(1i) pure: no discardedOnRecut (undefined, 8-arg call) ⇒ byte-identical to the pre-card composition", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, undefined, undefined, undefined, undefined) === composedCwd);
  check("(1i) pure: no discardedOnRecut ⇒ no discarded block", !composedCwd.includes("was DISCARDED"));
  const discardedInfo = { statusSummary: "M destroyed-tracked.txt", fileCount: 1, truncated: false };
  const composedDiscarded = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, undefined, undefined, undefined, undefined, discardedInfo);
  check("(1i) pure: discardedOnRecut set (9th/LAST param) ⇒ discarded block present", composedDiscarded.includes("was DISCARDED"));
  check("(1i) pure: discarded block names the destroyed path", composedDiscarded.includes("destroyed-tracked.txt"));
  check("(1i) pure: discarded block tells the worker there's nothing left to reconcile", /nothing (here )?to (finish or revert|reconcile)/i.test(composedDiscarded));
  check("(1i) pure: worktree location block + brief + dynamic still all present alongside the discarded block", composedDiscarded.includes("/wt/path") && composedDiscarded.includes("BRIEF") && composedDiscarded.includes("DYNAMIC"));
  check("(1i) pure: no cwd ⇒ discardedOnRecut is ignored too, output unchanged from the 2-arg form", composeWorkerStartupPrompt("BRIEF", "DYNAMIC", undefined, undefined, undefined, undefined, undefined, undefined, discardedInfo) === "BRIEF\n\n---\n\nDYNAMIC");
  // dirtyBlock (SURVIVED) + discardedBlock (DESTROYED) are DISTINCT, independent signals and can co-exist —
  // never merged into one field/block. Order: dirty leads discarded (mirrors the dirty-then-stale ordering
  // proven above).
  const composedDirtyAndDiscarded = composeWorkerStartupPrompt("BRIEF", "DYNAMIC", "/wt/path", undefined, dirtyInfo, undefined, undefined, undefined, discardedInfo);
  check("(1i) pure: dirtyBlock + discardedBlock can co-exist (survived vs. destroyed are independent signals)", composedDirtyAndDiscarded.includes("reconcile before you start") && composedDirtyAndDiscarded.includes("was DISCARDED"));
  check("(1i) pure: dirty block leads the discarded block", order(composedDirtyAndDiscarded, "reconcile before you start", "was DISCARDED"));

  // ===================== (2) SPAWN composes the worktree block + brief ahead of the kickoff =====================
  const wA = await svc.spawnWorker("mgr1", { taskId: taskA, agentId: "agentDev", kickoffPrompt: "KICKOFF_A" });
  worktrees.push(wA.worktreePath);
  const oWA = optsFor(wA.id);
  check("(2) spawn (brief): startupPrompt carries the agent brief THEN the kickoff", order(oWA?.startupPrompt ?? "", "DEV_BRIEF", "KICKOFF_A"));
  check("(2) spawn (brief): startupPrompt names the worktree cwd as the edit dir, ahead of the brief", (oWA?.startupPrompt ?? "").includes(wA.worktreePath) && (oWA?.startupPrompt ?? "").includes("make ALL edits here") && order(oWA?.startupPrompt ?? "", wA.worktreePath, "DEV_BRIEF"));

  const wQ = await svc.spawnWorker("mgr1", { taskId: taskB, agentId: "agentQA", kickoffPrompt: "KICKOFF_B" });
  worktrees.push(wQ.worktreePath);
  const oWQ = optsFor(wQ.id);
  check("(2) spawn (empty brief): startupPrompt is the worktree block THEN the kickoff (block present even with empty brief)", (oWQ?.startupPrompt ?? "").includes(wQ.worktreePath) && (oWQ?.startupPrompt ?? "").includes("KICKOFF_B") && order(oWQ?.startupPrompt ?? "", wQ.worktreePath, "KICKOFF_B"));
  check("(2) project pW has no referenceRepos ⇒ worker spawns carry NO 'Also referenced' block (byte-identical guarantee)", !(oWA?.startupPrompt ?? "").includes("Also referenced") && !(oWQ?.startupPrompt ?? "").includes("Also referenced"));

  // ===================== (3) RECYCLE composes the worktree block + brief ahead of the handoff =====================
  const rA = await svc.recycleWorker("mgr1", wA.id, "HANDOFF_A");
  const oRA = optsFor(rA.id);
  check("(3) recycle (brief): successor startupPrompt carries the agent brief THEN the handoff", order(oRA?.startupPrompt ?? "", "DEV_BRIEF", "HANDOFF_A"));
  check("(3) recycle (brief): the handoff frame is preserved after the brief", (oRA?.startupPrompt ?? "").includes("[loom:handoff]"));
  check("(3) recycle (brief): successor startupPrompt names the SAME worktree cwd as the edit dir, ahead of the brief", (oRA?.startupPrompt ?? "").includes(rA.worktreePath) && (oRA?.startupPrompt ?? "").includes("make ALL edits here") && order(oRA?.startupPrompt ?? "", rA.worktreePath, "DEV_BRIEF"));

  const rQ = await svc.recycleWorker("mgr1", wQ.id, "HANDOFF_B");
  const oRQ = optsFor(rQ.id);
  check("(3) recycle (empty brief): successor startupPrompt is the worktree block THEN the handoff (block present, no brief prefix)", (oRQ?.startupPrompt ?? "").includes(rQ.worktreePath) && (oRQ?.startupPrompt ?? "").includes("[loom:handoff]") && (oRQ?.startupPrompt ?? "").includes("HANDOFF_B") && order(oRQ?.startupPrompt ?? "", rQ.worktreePath, "[loom:handoff]"));
  check("(3) project pW has no referenceRepos ⇒ recycle successors carry NO 'Also referenced' block (byte-identical guarantee)", !(oRA?.startupPrompt ?? "").includes("Also referenced") && !(oRQ?.startupPrompt ?? "").includes("Also referenced"));

  // ===================== (4) reference-repos epic Phase 3: a project WITH referenceRepos injects the =====
  // 'Also referenced (read-only)' block into REAL worker spawn AND recycle (not just the pure function).
  const refRepoA = path.join(os.tmpdir(), `loom-wprompt-refA-${Date.now()}-${process.pid}`);
  const refRepoB = path.join(os.tmpdir(), `loom-wprompt-refB-${Date.now()}-${process.pid}`);
  fs.mkdirSync(refRepoA, { recursive: true });
  fs.mkdirSync(refRepoB, { recursive: true });
  repoR = path.join(os.tmpdir(), `loom-wprompt-repoR-${Date.now()}-${process.pid}`);
  fs.mkdirSync(repoR, { recursive: true });
  fs.writeFileSync(path.join(repoR, "README.md"), "# ref-repos worker test\n");
  execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repoR });
  db.insertProject({ id: "pWR", name: "WRefProj", repoPath: repoR, vaultPath: repoR, config: {}, createdAt: now, archivedAt: null, referenceRepos: [refRepoA, refRepoB] });
  db.insertAgent({ id: "agentDevRef", projectId: "pWR", name: "Dev", startupPrompt: "DEV_REF_BRIEF", position: 0, profileId: null });
  db.insertSession({
    id: "mgrR", projectId: "pWR", agentId: "agentDevRef", engineSessionId: null, title: null,
    cwd: repoR, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const taskR = "33333333-3333-3333-8333-333333333333";
  db.insertTask({ id: taskR, projectId: "pWR", title: "R", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });

  const wR = await svc.spawnWorker("mgrR", { taskId: taskR, agentId: "agentDevRef", kickoffPrompt: "KICKOFF_R" });
  worktreesR.push(wR.worktreePath);
  const oWR = optsFor(wR.id);
  check("(4) referenceRepos worker spawn carries the 'Also referenced' block", (oWR?.startupPrompt ?? "").includes("Also referenced"));
  check("(4) referenceRepos worker spawn lists BOTH reference repo absolute paths", (oWR?.startupPrompt ?? "").includes(refRepoA) && (oWR?.startupPrompt ?? "").includes(refRepoB));
  check("(4) referenceRepos worker spawn carries the read-only framing (never commit there)", /never commit there/i.test(oWR?.startupPrompt ?? ""));
  check("(4) referenceRepos worker spawn still carries its own worktree edit-dir block + brief + kickoff", (oWR?.startupPrompt ?? "").includes(wR.worktreePath) && (oWR?.startupPrompt ?? "").includes("DEV_REF_BRIEF") && (oWR?.startupPrompt ?? "").includes("KICKOFF_R"));

  const rR = await svc.recycleWorker("mgrR", wR.id, "HANDOFF_R");
  worktreesR.push(rR.worktreePath);
  const oRR = optsFor(rR.id);
  check("(4) referenceRepos recycle successor carries the 'Also referenced' block", (oRR?.startupPrompt ?? "").includes("Also referenced"));
  check("(4) referenceRepos recycle successor lists BOTH reference repo absolute paths", (oRR?.startupPrompt ?? "").includes(refRepoA) && (oRR?.startupPrompt ?? "").includes(refRepoB));
  check("(4) referenceRepos recycle successor still carries its handoff + worktree edit-dir block", (oRR?.startupPrompt ?? "").includes("[loom:handoff]") && (oRR?.startupPrompt ?? "").includes(rR.worktreePath));
  try { fs.rmSync(refRepoA, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(refRepoB, { recursive: true, force: true }); } catch { /* best-effort */ }
  // repoR itself is removed in `finally`, AFTER its worktrees are torn down (git worktree remove needs
  // the main repo present).

  // ===================== (5) board card 2250836c: a HARD-STOPPED worker's retained worktree, re-spawned =====
  // onto the SAME task, surfaces reusedDirtyWorktree on the result AND injects a reconcile note into the
  // new worker's OWN kickoff — end-to-end through the real spawnWorker/createWorktree path (no fakes for
  // the git side), same style as the referenceRepos section above.
  const taskD = "44444444-4444-4444-8444-444444444444";
  db.insertTask({ id: taskD, projectId: "pW", title: "D", body: "", columnKey: "todo", position: 3, createdAt: now, updatedAt: now });

  // First spawn: fresh worktree — must NOT carry any reconcile note.
  const wD1 = await svc.spawnWorker("mgr1", { taskId: taskD, agentId: "agentDev", kickoffPrompt: "KICKOFF_D1" });
  worktrees.push(wD1.worktreePath);
  check("(5) fresh spawn never sets reusedDirtyWorktree", wD1.reusedDirtyWorktree === undefined);
  const oWD1 = optsFor(wD1.id);
  check("(5) fresh spawn's kickoff carries NO reconcile block", !(oWD1?.startupPrompt ?? "").includes("Reused worktree"));

  // Simulate worker_stop(hard): the worktree is RETAINED (never removed) and the worker just leaves
  // real uncommitted work behind mid-edit — the exact card 2250836c repro shape.
  fs.writeFileSync(path.join(wD1.worktreePath, "leftover.txt"), "in-progress edit from the hard-stopped worker\n");
  db.setProcessState(wD1.id, "exited"); // frees the one-live-worker-per-task guard for the re-spawn below

  // Re-spawn onto the SAME task → reuses the SAME worktree (dirty).
  const wD2 = await svc.spawnWorker("mgr1", { taskId: taskD, agentId: "agentDev", kickoffPrompt: "KICKOFF_D2" });
  check("(5) re-spawn reuses the SAME worktree path", wD2.worktreePath === wD1.worktreePath);
  check("(5) re-spawn RESULT carries reusedDirtyWorktree", wD2.reusedDirtyWorktree !== undefined);
  check("(5) reusedDirtyWorktree names the leftover file", wD2.reusedDirtyWorktree?.statusSummary.includes("leftover.txt"));
  check("(5) reusedDirtyWorktree.fileCount is 1", wD2.reusedDirtyWorktree?.fileCount === 1);

  const oWD2 = optsFor(wD2.id);
  check("(5) the NEW worker's OWN kickoff carries the reconcile note", (oWD2?.startupPrompt ?? "").includes("Reused worktree"));
  check("(5) the reconcile note names the leftover file", (oWD2?.startupPrompt ?? "").includes("leftover.txt"));
  check("(5) the reconcile note still leads into the manager's kickoff", order(oWD2?.startupPrompt ?? "", "Reused worktree", "KICKOFF_D2"));
  check("(5) the leftover file is STILL ON DISK — spawning never cleaned it", fs.existsSync(path.join(wD2.worktreePath, "leftover.txt")));
  db.setProcessState(wD2.id, "exited"); // free a concurrency-cap slot under mgr1 for section (6) below

  // ===================== (6) card 5150fdc2: a re-spawn onto a commits-ahead branch whose base fell =====
  // behind main (and can't be cleanly auto-forwarded — a real conflict) surfaces staleBase on the spawn
  // result AND injects the forward-merge note into the new worker's OWN kickoff — end-to-end through the
  // real spawnWorker/createWorktree path, same style as section (5).
  const taskE = "55555555-5555-5555-8555-555555555555";
  db.insertTask({ id: taskE, projectId: "pW", title: "E", body: "", columnKey: "todo", position: 4, createdAt: now, updatedAt: now });

  const wE1 = await svc.spawnWorker("mgr1", { taskId: taskE, agentId: "agentDev", kickoffPrompt: "KICKOFF_E1" });
  worktrees.push(wE1.worktreePath);
  check("(6) fresh spawn never sets staleBase", wE1.staleBase === undefined);
  // Worker commits on its branch (>0 ahead ⇒ recutStaleReusedBranch's fail-safe leaves it untouched later).
  fs.writeFileSync(path.join(wE1.worktreePath, "README.md"), "branch version E\n");
  execSync(`git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m "E branch commit"`, { cwd: wE1.worktreePath });
  // Main advances with a CONFLICTING edit to the SAME file — the auto-forward attempt can't merge clean.
  fs.writeFileSync(path.join(repo, "README.md"), "main version E\n");
  execSync(`git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m "E main commit"`, { cwd: repo });
  db.setProcessState(wE1.id, "exited"); // frees the one-live-worker-per-task guard for the re-spawn below

  const wE2 = await svc.spawnWorker("mgr1", { taskId: taskE, agentId: "agentDev", kickoffPrompt: "KICKOFF_E2" });
  check("(6) re-spawn reuses the SAME worktree path", wE2.worktreePath === wE1.worktreePath);
  check("(6) re-spawn RESULT carries staleBase (auto-forward hit a real conflict)", wE2.staleBase !== undefined);
  check("(6) staleBase.behindBy is 1 (main's one commit since the fork)", wE2.staleBase?.behindBy === 1);
  check("(6) staleBase.changedFiles names README.md", wE2.staleBase?.changedFiles.includes("README.md"));

  const oWE2 = optsFor(wE2.id);
  check("(6) the NEW worker's OWN kickoff carries the stale-base note", (oWE2?.startupPrompt ?? "").includes("Stale branch base"));
  check("(6) the stale-base note names the behind-by count", (oWE2?.startupPrompt ?? "").includes("1 commit(s) behind"));
  check("(6) the stale-base note still leads into the manager's kickoff", order(oWE2?.startupPrompt ?? "", "Stale branch base", "KICKOFF_E2"));
  // The conflicting auto-forward attempt aborted cleanly — the branch's own committed content survives.
  const normE = (s) => s.replace(/\r\n/g, "\n");
  check("(6) the branch's own committed content survived the aborted auto-forward attempt",
    normE(fs.readFileSync(path.join(wE2.worktreePath, "README.md"), "utf8")) === "branch version E\n");
  db.setProcessState(wE2.id, "exited"); // free a concurrency-cap slot under mgr1 for section (8) below

  // ===================== (8) board card 13cc2300: a 0-ahead reused worktree's DESTROYED tracked work is
  // captured (before the recut discards it) and reported DISTINCTLY from whatever SURVIVES the same
  // recut — end-to-end through the real spawnWorker/createWorktree path, same style as sections (5)/(6).
  const taskF = "66666666-6666-6666-8666-666666666666";
  db.insertTask({ id: taskF, projectId: "pW", title: "F", body: "", columnKey: "todo", position: 5, createdAt: now, updatedAt: now });

  const wF1 = await svc.spawnWorker("mgr1", { taskId: taskF, agentId: "agentDev", kickoffPrompt: "KICKOFF_F1" });
  worktrees.push(wF1.worktreePath);
  check("(8) fresh spawn never sets discardedOnRecut", wF1.discardedOnRecut === undefined);

  // Simulate worker_stop(hard) BEFORE any commit (0 commits ahead — exactly the scenario the card names):
  // a TRACKED modification (README.md, already committed on main) the reset below WILL discard, plus an
  // UNTRACKED leftover that a `reset --hard` never touches and so survives.
  fs.writeFileSync(path.join(wF1.worktreePath, "README.md"), "TRACKED EDIT ABOUT TO BE DISCARDED\n");
  fs.writeFileSync(path.join(wF1.worktreePath, "f-untracked.txt"), "survives the reset\n");
  db.setProcessState(wF1.id, "exited"); // frees the one-live-worker-per-task guard for the re-spawn below

  // Re-spawn onto the SAME task → 0-ahead branch ⇒ recutStaleReusedBranch resets --hard onto main.
  const wF2 = await svc.spawnWorker("mgr1", { taskId: taskF, agentId: "agentDev", kickoffPrompt: "KICKOFF_F2" });
  check("(8) re-spawn reuses the SAME worktree path", wF2.worktreePath === wF1.worktreePath);
  check("(8) re-spawn RESULT carries discardedOnRecut", wF2.discardedOnRecut !== undefined);
  check("(8) discardedOnRecut names the destroyed TRACKED path", wF2.discardedOnRecut?.statusSummary.includes("README.md"));
  check("(8) discardedOnRecut does NOT include the untracked survivor (it was never discarded)", !wF2.discardedOnRecut?.statusSummary.includes("f-untracked.txt"));
  check("(8) discardedOnRecut.fileCount is 1 (only the tracked path)", wF2.discardedOnRecut?.fileCount === 1);
  check("(8) re-spawn RESULT ALSO carries reusedDirtyWorktree for what SURVIVED (the untracked leftover)", wF2.reusedDirtyWorktree !== undefined);
  check("(8) reusedDirtyWorktree names the SURVIVING untracked file, not the destroyed tracked one",
    wF2.reusedDirtyWorktree?.statusSummary.includes("f-untracked.txt") && !wF2.reusedDirtyWorktree?.statusSummary.includes("README.md"));
  check("(8) the tracked edit is GONE on disk — reverted to the main-branch version",
    normE(fs.readFileSync(path.join(wF2.worktreePath, "README.md"), "utf8")) === normE(fs.readFileSync(path.join(repo, "README.md"), "utf8")));
  check("(8) the untracked leftover IS STILL on disk — reset --hard never touches it", fs.existsSync(path.join(wF2.worktreePath, "f-untracked.txt")));

  const oWF2 = optsFor(wF2.id);
  check("(8) the NEW worker's OWN kickoff carries the discarded-work note", (oWF2?.startupPrompt ?? "").includes("was DISCARDED"));
  check("(8) the discarded-work note names the destroyed path", (oWF2?.startupPrompt ?? "").includes("README.md"));
  check("(8) the kickoff ALSO carries the reconcile note for what survived", (oWF2?.startupPrompt ?? "").includes("reconcile before you start"));
  check("(8) the reconcile note names the surviving untracked path", (oWF2?.startupPrompt ?? "").includes("f-untracked.txt"));
  check("(8) both notes still lead into the manager's own kickoff text",
    order(oWF2?.startupPrompt ?? "", "was DISCARDED", "KICKOFF_F2") && order(oWF2?.startupPrompt ?? "", "reconcile before you start", "KICKOFF_F2"));
  db.setProcessState(wF2.id, "exited"); // free a concurrency-cap slot under mgr1 for anything after

  // ===================== (7) REVIEW SPAWN (card 47bbdc3f) =====================
  // A review-only worker's own branch is cut from the TIP of the branch under review — not from HEAD —
  // so its worktree's content is byte-identical to what's under review at spawn time, and the resolved
  // branch+sha reaches its kickoff mechanically (no manager hand-typing, the bdc05c55 failure mode).
  // A fresh isolated project (generous cap) so this section's bookkeeping never interacts with the cap
  // arithmetic the earlier sections already manage carefully.
  const repoRev = path.join(os.tmpdir(), `loom-wprompt-repoRev-${Date.now()}-${process.pid}`);
  fs.mkdirSync(repoRev, { recursive: true });
  fs.writeFileSync(path.join(repoRev, "README.md"), "# review-spawn test — mainline\n");
  execSync(`git init -q && git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m init`, { cwd: repoRev });
  db.insertProject({ id: "pRev", name: "RevProj", repoPath: repoRev, vaultPath: repoRev, config: { orchestration: { maxConcurrentWorkers: 10 } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentDevRev", projectId: "pRev", name: "Dev", startupPrompt: "DEV_REV_BRIEF", position: 0, profileId: null });
  db.insertSession({
    id: "mgrRev", projectId: "pRev", agentId: "agentDevRev", engineSessionId: null, title: null,
    cwd: repoRev, processState: "live", resumability: "unknown", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const worktreesRev = [];

  // --- (7a) reviewOfWorkerSessionId: happy path, author still LIVE ---
  const taskRevA = "77777777-7777-7777-8777-777777777701";
  db.insertTask({ id: taskRevA, projectId: "pRev", title: "RevA", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const authorA = await svc.spawnWorker("mgrRev", { taskId: taskRevA, agentId: "agentDevRev", kickoffPrompt: "AUTHOR_A_KICKOFF" });
  worktreesRev.push(authorA.worktreePath);
  fs.writeFileSync(path.join(authorA.worktreePath, "feature.txt"), "author A change\n");
  execSync(`git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m "author A commit"`, { cwd: authorA.worktreePath });
  const authorASha = execSync("git rev-parse HEAD", { cwd: authorA.worktreePath }).toString().trim();

  const reviewerA = await svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "REVIEW_A_KICKOFF", reviewOfWorkerSessionId: authorA.id });
  worktreesRev.push(reviewerA.worktreePath);
  check("(7a) reviewOfWorkerSessionId spawn succeeds, taskless", reviewerA.role === "worker" && reviewerA.taskId === null);
  check("(7a) result carries reviewOf naming the author's branch + its committed tip sha", reviewerA.reviewOf?.branch === authorA.branch && reviewerA.reviewOf?.headSha === authorASha);
  check("(7a) reviewer gets its OWN fresh branch (never the author's — no checkout conflict)", reviewerA.branch !== authorA.branch);
  check("(7a) reviewer's worktree is cut FROM the author's tip — its HEAD sha matches exactly",
    execSync("git rev-parse HEAD", { cwd: reviewerA.worktreePath }).toString().trim() === authorASha);
  check("(7a) reviewer's worktree content IS the author's committed file (not mainline, which never had it)",
    fs.readFileSync(path.join(reviewerA.worktreePath, "feature.txt"), "utf8").includes("author A change"));
  check("(7a) the still-live author's own worktree is untouched by the review spawn",
    fs.existsSync(authorA.worktreePath) && fs.readFileSync(path.join(authorA.worktreePath, "feature.txt"), "utf8").includes("author A change"));
  const oReviewerA = optsFor(reviewerA.id);
  check("(7a) reviewer's kickoff carries the reviewed branch name — server-resolved, not hand-typed by the manager's kickoffPrompt",
    (oReviewerA?.startupPrompt ?? "").includes(authorA.branch));
  check("(7a) reviewer's kickoff carries the resolved tip sha", (oReviewerA?.startupPrompt ?? "").includes(authorASha));
  check("(7a) reviewer's kickoff tells it ordinary Read/Grep already shows the reviewed content",
    /already IS the reviewed content/i.test(oReviewerA?.startupPrompt ?? ""));
  check("(7a) reviewer's kickoff still carries the manager's own dynamic kickoff text", (oReviewerA?.startupPrompt ?? "").includes("REVIEW_A_KICKOFF"));

  // --- (7b) reviewOfTaskId: resolves the task's DETERMINISTIC branch, works even after the author exited ---
  const taskRevB = "77777777-7777-7777-8777-777777777702";
  db.insertTask({ id: taskRevB, projectId: "pRev", title: "RevB", body: "", columnKey: "todo", position: 2, createdAt: now, updatedAt: now });
  const authorB = await svc.spawnWorker("mgrRev", { taskId: taskRevB, agentId: "agentDevRev", kickoffPrompt: "AUTHOR_B_KICKOFF" });
  worktreesRev.push(authorB.worktreePath);
  fs.writeFileSync(path.join(authorB.worktreePath, "feature-b.txt"), "author B change\n");
  execSync(`git add . && git -c user.email=wp@loom -c user.name=wp commit -q -m "author B commit"`, { cwd: authorB.worktreePath });
  const authorBSha = execSync("git rev-parse HEAD", { cwd: authorB.worktreePath }).toString().trim();
  db.setProcessState(authorB.id, "exited"); // the author is GONE — reviewOfTaskId must still resolve (no session lookup needed)

  const reviewerB = await svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "REVIEW_B_KICKOFF", reviewOfTaskId: taskRevB });
  worktreesRev.push(reviewerB.worktreePath);
  check("(7b) reviewOfTaskId resolves the task's OWN deterministic branch (matches the exited author's)", reviewerB.reviewOf?.branch === authorB.branch);
  check("(7b) reviewOfTaskId resolves the correct committed tip sha even though the author has since exited", reviewerB.reviewOf?.headSha === authorBSha);
  check("(7b) reviewer's worktree content is the author's committed file", fs.readFileSync(path.join(reviewerB.worktreePath, "feature-b.txt"), "utf8").includes("author B change"));

  // --- (7c) a NORMAL spawn (no reviewOf) is completely unaffected — still forks the repo's current HEAD ---
  const taskRevC = "77777777-7777-7777-8777-777777777703";
  db.insertTask({ id: taskRevC, projectId: "pRev", title: "RevC", body: "", columnKey: "todo", position: 3, createdAt: now, updatedAt: now });
  const normalC = await svc.spawnWorker("mgrRev", { taskId: taskRevC, agentId: "agentDevRev", kickoffPrompt: "NORMAL_C_KICKOFF" });
  worktreesRev.push(normalC.worktreePath);
  check("(7c) a normal (non-review) spawn carries no reviewOf on the result", normalC.reviewOf === undefined);
  check("(7c) a normal spawn's worktree is forked from the repo's current mainline, not any reviewed branch",
    fs.readFileSync(path.join(normalC.worktreePath, "README.md"), "utf8").includes("mainline")
    && !fs.existsSync(path.join(normalC.worktreePath, "feature.txt"))
    && !fs.existsSync(path.join(normalC.worktreePath, "feature-b.txt")));
  const oNormalC = optsFor(normalC.id);
  check("(7c) a normal spawn's kickoff carries NO review block", !(oNormalC?.startupPrompt ?? "").includes("REVIEW spawn"));

  // --- (7d) validation: bad/ambiguous input FAILS LOUDLY — never silently degrades to a HEAD-forked spawn ---
  const liveBeforeRev = db.listWorkers("mgrRev").filter((w) => w.processState === "live").length;
  await rejects("(7d) both reviewOfWorkerSessionId AND reviewOfTaskId ⇒ rejected", () =>
    svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "X", reviewOfWorkerSessionId: authorA.id, reviewOfTaskId: taskRevA }),
    "EITHER reviewOfWorkerSessionId OR reviewOfTaskId");
  await rejects("(7d) an unresolvable reviewOfWorkerSessionId ⇒ rejected", () =>
    svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "X", reviewOfWorkerSessionId: "does-not-exist" }),
    "does not resolve to a session");
  await rejects("(7d) reviewOfWorkerSessionId naming a branch-less session (the manager itself) ⇒ rejected", () =>
    svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "X", reviewOfWorkerSessionId: "mgrRev" }),
    "no branch");
  await rejects("(7d) an unresolvable reviewOfTaskId ⇒ rejected", () =>
    svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "X", reviewOfTaskId: "00000000-0000-0000-8000-000000000000" }),
    "does not resolve to an existing task");
  const taskRevNoWorker = "77777777-7777-7777-8777-777777777704";
  db.insertTask({ id: taskRevNoWorker, projectId: "pRev", title: "RevNoWorker", body: "", columnKey: "todo", position: 4, createdAt: now, updatedAt: now });
  await rejects("(7d) reviewOfTaskId naming a task that never had a worker (branch never created) ⇒ rejected", () =>
    svc.spawnWorker("mgrRev", { agentId: "agentDevRev", kickoffPrompt: "X", reviewOfTaskId: taskRevNoWorker }),
    "does not exist");
  check("(7d) every rejected review spawn left NO new live worker (no side effect on failure)",
    db.listWorkers("mgrRev").filter((w) => w.processState === "live").length === liveBeforeRev);

  for (const wt of worktreesRev) { try { await removeWorktree(repoRev, wt); } catch { /* best-effort */ } }
  try { fs.rmSync(repoRev, { recursive: true, force: true }); } catch { /* best-effort */ }
} finally {
  for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  if (repoR) { for (const wt of worktreesR) { try { await removeWorktree(repoR, wt); } catch { /* best-effort */ } } }
  db.close(); // free the WAL handle before removing the temp dir (Windows)
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (repoR) { try { fs.rmSync(repoR, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — workers receive their agent base brief composed ahead of the dynamic part on BOTH spawn and recycle; an empty brief degrades to the dynamic part alone; a review spawn (reviewOfWorkerSessionId/reviewOfTaskId) cuts its own branch from the reviewed branch's committed tip — content matches exactly, the branch+sha reach its kickoff mechanically, a normal spawn is untouched, and bad input is rejected with no side effect — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
