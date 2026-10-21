import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eaaa693 round 2 (reworded round 3, Code Review 2026-10-21 Major finding) — the fork-point
// ancestry check through the REAL SERVICE-LAYER paths, not the bare git-layer calls
// fork-point-ancestry.mjs already covers (mergeBranch/assembleBatchBranches directly, with cutBaseSha
// handed in as a literal). ⚠️ HONEST SCOPE: both scenarios below are caught by the ADVISORY pre-gate
// check (which reads `worker.cutBaseSha`/`r.cutBaseSha` DIRECTLY from the resolved session/candidate
// list, never via `mergeBranch`'s own parameter or `batchCandidates`'s own field) — a real CR finding was
// that this does NOT exercise, and therefore does NOT prove, the SEPARATE in-lock wiring (passing
// `worker.cutBaseSha` into `mergeBranch`, service.ts ~19818; building `batchCandidates` with
// `cutBaseSha: c.cutBaseSha`, ~21346) — reverting either would stay GREEN here, since the advisory
// already decides the outcome before the in-lock wiring is ever consulted. See
// cut-base-sha-confirm-in-lock-wiring-solo.mjs / cut-base-sha-confirm-in-lock-wiring-batch.mjs /
// cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs (split three ways by card d10f1f92, each under its
// own per-file gate budget) for tests that isolate and actually prove THAT wiring.
//
//   (1) a confirm-level refusal through the REAL `worker_merge_confirm` path
//       (confirmWorkerMergeTracked -> confirmWorkerMerge) — proves the ADVISORY check reads a REAL
//       spawnWorker-stamped session's `cutBaseSha` (not a literal handed in by the test) and refuses on
//       it correctly. Does NOT prove the in-lock `mergeBranch` call received it (see scope note above).
//   (2) a merge_batch-level test through the REAL `mergeBatchTracked` path (with a real gateCommand
//       configured, so the batch actually reaches assembly rather than degrading to per-candidate solo
//       fallback), with THREE real spawnWorker candidates (two ordinary, one cross-lineage) — proves the
//       ADVISORY pre-filter reads a REAL candidate's `cutBaseSha` and pulls only the diverged one before
//       assembly. The two ORDINARY candidates landing via the real `batchCandidates`/
//       `assembleBatchBranches` path is consistent with correct wiring there, but does NOT isolate it —
//       they would land identically even if `cutBaseSha` were dropped from `batchCandidates` entirely,
//       since they are not actually diverged (see scope note above).
//       ⚠️ Manager redirect (gate op e0a9731e, 2026-10-21) — the real `mergeBatchTracked` call here can
//       legitimately degrade to `{settled:false, op}` (a documented, supported async path, see
//       `_settle-tracked.mjs`'s own doc) once its own `syncAttachBudgetMs` elapses before the real
//       3-worker batch assembly + gate finishes; asserting `settled===true` on the first result measures
//       host speed, not the code under test, and reddened the gate under real contention. Fixed by
//       forcing the degrade DETERMINISTICALLY on every run (`syncAttachBudgetMs: 1`, the same seam
//       batch-merge-divert-unverified-nudge-text.mjs/batch-merge-gate-history.mjs already use for this)
//       and polling the SAME closure via `awaitBatchSettle` (re-attaches to the in-flight op rather than
//       re-running it) until it genuinely settles, bounded with `performance.now()` (monotonic, never
//       `Date.now()`) so a clock adjustment can't silently turn a real wedge into a hang. Verified via a
//       real RED/GREEN cycle: the bare pre-fix call (`await sessionsBatch.mergeBatchTracked(...)`, no
//       poll) under this SAME forced budget reproducibly fails "(2) the real batch settles" and its four
//       dependents; restoring the poll passes every time, in both env states, with the forced degrade
//       empirically confirmed (13+ pending polls observed before settling).
//   (3) `cutBaseUnknown:true` is stamped on the `merge_done` event for a LEGACY worker (no recorded
//       cutBaseSha) that lands normally — the grandfathering signal confirmWorkerMerge's finalizeMerge
//       call emits, verified end-to-end through a real merge, not asserted from the source alone.
//   (4) round 5 (Code Review ff5de408, item 1) — REFUTES the decision record's "confirmed UNTESTABLE"
//       claim about canonicalGit vs this.boundedGit at the advisory call sites: a PLANTED `git replace`
//       object changes `git merge-base`'s own answer depending on whether replace refs are honored, and
//       `core.useReplaceRefs=false` (canonicalGit's own config) is exactly the knob that decides it. The
//       POSITIVE case (no factory override) proves production's real canonicalGit isn't fooled; the
//       CONTROL (a replace-honoring factory via the SAME soloMergeGitFactory seam) proves the choice is
//       genuinely load-bearing, not an untestable hardening posture.
//
// REAL Db + SessionService driven against a FAKE pty (createPty seam), real temp git repos behind
// createWorktree — mirrors worker-spawn-taskless.mjs's own harness (scenario 7 in particular, which
// already proves a taskless REAL confirmWorkerMergeTracked merge this same way). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE.
//
// Run: 1) build (turbo builds shared first), 2) node test/cut-base-sha-confirm-and-batch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist — paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-cbscb-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const simpleGit = (await import("simple-git")).default;

const GIT_ID = "-c user.email=cbscb@loom -c user.name=cbscb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function freshRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-cbscb-repo-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# cbscb ${tag}\n`);
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// Round 5 (Code Review ff5de408, item 7) — SAME rationale + mechanism as merge-spawn-tracked.mjs's own
// `stopSeamPty`: SeamHost's `write()` is an inert no-op, so a worker spawned here and never explicitly
// stopped keeps running the REAL production submit/retry/give-up machinery in the background (a ~20s
// READY_FALLBACK_MS wait, then real setTimeout-paced retry cycles) for the rest of this process's
// lifetime. The measured flake root cause: scenario (1)'s worker (spawned at the top of this file) was
// never stopped, so its own ~20s readiness-fallback timer fired WHILE a later scenario's own assertions
// were running, inside the SAME process. `host.stop(id, "hard")` kills the fake pty SYNCHRONOUSLY
// (SeamHost's `kill()` invokes the tracked onExit callback inline), so every still-pending timer for that
// session's generation becomes a no-op on its very next check. Best-effort: a worker already stopped by
// a successful merge (finalizeMerge's own teardown) is a redundant, harmless re-stop here.
function stopSeamPty(sessionId) {
  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup — see this function's own doc */ }
}

// Round 5 (manager redirect, gate op e0a9731e) — a real `mergeBatchTracked` call can legitimately
// degrade to `{settled:false, op}` under host contention: the default `syncAttachBudgetMs` elapses
// before the real batch assembly + gate finishes. This is a documented, SUPPORTED path (see
// `_settle-tracked.mjs`'s own doc — the same shape several batch-merge-*.mjs siblings already handle),
// never a test failure. Scenario (2) below used to assert `batch.settled === true` on the FIRST result,
// which measures the host's speed, not the code — the exact flake the manager's gate run caught.
//
// Re-calling the SAME closure RE-ATTACHES to the in-flight op (`PendingOpRegistry.attach` dedupes by
// key) instead of re-running it, so this is a condition wait on genuine settlement, bounded so a real
// wedge throws loudly and names the op — never a blind sleep, and never a fabricated value for the
// unsettled case. Deliberately NOT a call to the shared `_settle-tracked.mjs` helper (which this file
// could otherwise reuse) — this helper uses `performance.now()` (monotonic) for its deadline instead of
// that helper's own `Date.now()`, so a system-clock adjustment mid-wait can never silently defeat the
// bound and turn a genuine wedge into a hang; `_settle-tracked.mjs` is a widely-shared file this card has
// no reason to touch, and its own `Date.now()` deadline is an orthogonal, pre-existing choice.
async function awaitBatchSettle(callFn, { label = "mergeBatchTracked", timeoutMs = 120_000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  let r = await callFn();
  let lastOpId = r.op?.opId;
  while (!r.settled) {
    if (performance.now() > deadline) {
      throw new Error(`${label} did not settle within ${timeoutMs}ms (last op: ${JSON.stringify(r.op)})`);
    }
    r = await callFn();
    // Mirrors `_settle-tracked.mjs`'s own RE-MINT GUARD: a re-poll that mints a SECOND op instead of
    // re-attaching to the first would silently race two real batches — detect it and throw loudly rather
    // than let it surface as an unrelated later assertion failure.
    if (!r.settled && r.op?.opId !== undefined && lastOpId !== undefined && r.op.opId !== lastOpId) {
      throw new Error(`${label}: re-poll minted a fresh op ${r.op.opId} instead of re-attaching to ${lastOpId} (the op settled between polls and its identity moved)`);
    }
    if (!r.settled) lastOpId = r.op?.opId;
  }
  return r;
}

const allRepos = [];
const allWorktrees = [];
try {
  // ===================================================================================
  // (1) CONFIRM-LEVEL: a REAL spawnWorker-stamped cutBaseSha refuses via REAL confirmWorkerMergeTracked.
  // ===================================================================================
  {
    const P = "pConfirm";
    const repo = freshRepo("confirm");
    allRepos.push(repo);
    db.insertProject({ id: P, name: "Confirm", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: `${P}-mgr1`, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "confirm task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    // Main advances to C1 BEFORE the worker is cut — C1 is the worker's RECORDED cut base (real spawn).
    fs.writeFileSync(path.join(repo, "main-only.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    const worker = await svc.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    allWorktrees.push({ repo, path: worker.worktreePath });
    check("(1 setup) the real spawn stamped cutBaseSha to c1", worker.cutBaseSha === c1);
    // A real, unmerged commit on the worker's own branch — something that WOULD land if not refused.
    fs.writeFileSync(path.join(worker.worktreePath, "work.txt"), "real work\n");
    commitAll(worker.worktreePath, "confirm-task work", GIT_ID);

    // Canonical checkout now diverts to an UNRELATED branch "atlas", cut from the repo's ORIGINAL init
    // commit (base) — BEFORE c1 ever existed — so c1 (the worker's recorded cut base) is NOT an ancestor.
    const base = git(repo, "rev-list --max-parents=0 HEAD"); // the repo's own root commit
    execFileSync("git", ["checkout", "-q", "-b", "atlas", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse HEAD");
    check("(1 setup) c1 is NOT an ancestor of atlas (the cross-lineage precondition)",
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", c1, atlasTip], { cwd: repo }); return false; } catch { return true; } })());

    const merge = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, worker.id);
    check("(1) the real confirm settles (not a throw)", merge.settled === true && merge.ok === true);
    check("(1) refused — merged:false", merge.value?.merged === false);
    check("(1) classified forkPointDiverged (never branchDiverted) — proves the ADVISORY check read a REAL session's cutBaseSha (NOT the separate in-lock mergeBranch wiring — see cut-base-sha-confirm-in-lock-wiring-solo.mjs)",
      merge.value?.forkPointDiverged === true && !merge.value?.branchDiverted);
    check("(1) the refusal says recycling/rebasing can NEVER clear it (the round-2 remedy fix)",
      /cannot be cleared by recycling/i.test(merge.value?.reason ?? merge.value?.detailText ?? ""));
    check("(1) the refusal names a fresh worker from current mainline as the real remedy",
      /fresh worker/.test(merge.value?.reason ?? merge.value?.detailText ?? ""));
    check("(1) canonical repo untouched — still on atlas's tip", git(repo, "rev-parse HEAD") === atlasTip);
    check("(1) the worker's own unmerged commit is untouched (branch retained, not reset)",
      fs.existsSync(path.join(worker.worktreePath, "work.txt")));
    stopSeamPty(worker.id);
  }

  // ===================================================================================
  // (2) BATCH-LEVEL: a REAL mergeBatchTracked threads cutBaseSha from TWO real spawnWorker candidates.
  // ===================================================================================
  {
    const P = "pBatch";
    const repo = freshRepo("batch");
    allRepos.push(repo);
    // A real (trivial, always-passing) gateCommand — mergeBatchTracked degrades every candidate straight
    // to an individual solo-confirm fallback when a project has NO gateCommand (nothing to share a gate
    // over), which would never reach assembleBatchBranches/batchCandidates at all. A script file (not an
    // inline shell builtin) for cross-platform safety, mirroring batch-merge-branch-advanced-during-gate.mjs.
    const gateScript = path.join(os.tmpdir(), `loom-cbscb-gate-${Date.now()}-${randomUUID()}.mjs`);
    registerForCleanup(gateScript);
    fs.writeFileSync(gateScript, "process.exit(0);\n");
    db.insertProject({ id: P, name: "Batch", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 20, gateCommand: `node "${gateScript}"` } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: `${P}-mgr1`, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const taskGood = randomUUID();
    db.insertTask({ id: taskGood, projectId: P, title: "good", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    const defaultBranch = git(repo, "symbolic-ref --short HEAD");
    const c0 = git(repo, "rev-parse HEAD");

    // TWO ordinary "good" candidates (spawned WHILE canonical is still on the default branch at c0 — a
    // real, ordinary cut base) — a SECOND one is needed alongside "good" so the batch still has >= 2
    // eligible candidates once the advisory pre-filter below pulls the stray one out; with only 1 left,
    // mergeBatchTracked's own "fewer than 2 eligible — batching buys nothing over a solo confirm" path
    // would degrade this into a plain solo confirm, never reaching `batchCandidates`/assembleBatchBranches
    // at all — which is exactly the real, intended behavior (mirrors the pre-existing stranded-work pull's
    // own identical "fewer than 2 eligible" degrade), but NOT what this scenario needs to exercise.
    const goodWorker = await svc.spawnWorker(`${P}-mgr1`, { taskId: taskGood, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    allWorktrees.push({ repo, path: goodWorker.worktreePath });
    check("(2 setup) good worker's real cut base is c0", goodWorker.cutBaseSha === c0);
    fs.writeFileSync(path.join(goodWorker.worktreePath, "good.txt"), "good work\n");
    commitAll(goodWorker.worktreePath, "good work", GIT_ID);

    const taskGood2 = randomUUID();
    db.insertTask({ id: taskGood2, projectId: P, title: "good2", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
    const good2Worker = await svc.spawnWorker(`${P}-mgr1`, { taskId: taskGood2, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    allWorktrees.push({ repo, path: good2Worker.worktreePath });
    check("(2 setup) good2 worker's real cut base is also c0", good2Worker.cutBaseSha === c0);
    fs.writeFileSync(path.join(good2Worker.worktreePath, "good2.txt"), "good2 work\n");
    commitAll(good2Worker.worktreePath, "good2 work", GIT_ID);

    // Canonical checkout diverts to "atlas" (cut from c0) — while on atlas, spawn "stray": its real cut
    // base becomes atlas's tip, which the FINAL mainline (back on the default branch, still at c0) never
    // incorporates.
    execFileSync("git", ["checkout", "-q", "-b", "atlas", c0], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse HEAD");

    const taskStray = randomUUID();
    db.insertTask({ id: taskStray, projectId: P, title: "stray", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
    const strayWorker = await svc.spawnWorker(`${P}-mgr1`, { taskId: taskStray, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    allWorktrees.push({ repo, path: strayWorker.worktreePath });
    check("(2 setup) stray worker's real cut base is atlas's tip", strayWorker.cutBaseSha === atlasTip);
    fs.writeFileSync(path.join(strayWorker.worktreePath, "stray.txt"), "stray work\n");
    commitAll(strayWorker.worktreePath, "stray work", GIT_ID);

    // Canonical checkout returns to the default branch (still at c0, atlas never incorporated).
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });
    check("(2 setup) canonical is back on the default branch at c0 — atlas's tip is NOT an ancestor",
      git(repo, "rev-parse HEAD") === c0 &&
      (() => { try { execFileSync("git", ["merge-base", "--is-ancestor", atlasTip, c0], { cwd: repo }); return false; } catch { return true; } })());

    // DI seam `syncAttachBudgetMs: 1` (the same seam batch-merge-divert-unverified-nudge-text.mjs /
    // batch-merge-gate-history.mjs already use for this exact purpose) FORCES the real
    // `mergeBatchTracked` call below to degrade to `{settled:false, op}` on EVERY run, deterministically
    // — never relying on ambient host speed to happen to reproduce the manager's gate failure. This
    // turns the flake into a permanent, always-exercised regression test for the awaitBatchSettle
    // re-attach path below, rather than a one-off manual demonstration. A separate SessionService
    // instance (same shared `db`/`host`) — spawning stays on `svc`, only this merge call needs the
    // forced-tiny budget; mirrors scenario (4)'s own `sessionsReplace`/`sessionsControl` split.
    const sessionsBatch = new SessionService(db, host, new OrchestrationControl(), { syncAttachBudgetMs: 1 });
    const batch = await awaitBatchSettle(
      () => sessionsBatch.mergeBatchTracked(`${P}-mgr1`, [goodWorker.id, good2Worker.id, strayWorker.id]),
      { label: "(2) mergeBatchTracked", timeoutMs: 180_000 },
    );
    check("(2) the real batch settles", batch.settled === true && batch.ok === true);
    check("(2) BOTH good candidates landed via the REAL batch assembly path (batch.value.landed) — consistent with correct `batchCandidates` wiring, but does NOT isolate it (they'd land the same way even if cutBaseSha were dropped — see cut-base-sha-confirm-in-lock-wiring-batch.mjs for that)",
      (batch.value?.landed ?? []).some((l) => l.workerSessionId === goodWorker.id) && (batch.value?.landed ?? []).some((l) => l.workerSessionId === good2Worker.id));
    const strayFallback = (batch.value?.fallback ?? []).find((f) => f.workerSessionId === strayWorker.id);
    check("(2) the STRAY candidate was pulled to fallback BEFORE assembly (the advisory pre-filter, card 0eaaa693) — proves the ADVISORY read a REAL session's cutBaseSha and refused it",
      !!strayFallback && !(batch.value?.landed ?? []).some((l) => l.workerSessionId === strayWorker.id));
    check("(2) the stray's fallback reason names the fork-point divergence + the corrected remedy",
      /not an ancestor|cut from/.test(strayFallback?.reason ?? "") && /cannot be cleared by recycling/i.test(strayFallback?.reason ?? ""));
    // Discriminates WHICH check caught it: the advisory pre-filter's own message (service.ts) starts
    // directly with "this worker's branch..."; the in-lock landBranchCommitsIndividually message
    // (batch-merge.ts, pre-existing from round 1) instead starts with "<branch>: this worker's branch...".
    // A plain substring match alone can't tell these apart — only the exact START can.
    check("(2) the stray was caught by the ADVISORY pre-filter specifically (not the in-lock assembly check) — the reason has no branch-name prefix",
      (strayFallback?.reason ?? "").startsWith("this worker's branch was cut from"));
    check("(2) both good candidates' files actually landed on the default branch",
      fs.existsSync(path.join(repo, "good.txt")) && fs.existsSync(path.join(repo, "good2.txt")));
    check("(2) the stray candidate's file did NOT land", !fs.existsSync(path.join(repo, "stray.txt")));
    stopSeamPty(goodWorker.id); stopSeamPty(good2Worker.id); stopSeamPty(strayWorker.id);
  }

  // ===================================================================================
  // (3) cutBaseUnknown:true is stamped on merge_done for a LEGACY (null cutBaseSha) worker.
  // ===================================================================================
  {
    const P = "pLegacy";
    const repo = freshRepo("legacy");
    allRepos.push(repo);
    db.insertProject({ id: P, name: "Legacy", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: `${P}-mgr1`, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // A legacy worker's session row carries NO cutBaseSha (predates card 0eaaa693) — constructed directly
    // (mirrors worker-spawn-taskless.mjs scenario 7's own pattern for exercising the merge path without a
    // live pty), never through spawnWorker, which always stamps a real value now.
    const { worktreePath, branch } = await createWorktree(repo, P, `legacy-${randomUUID()}`);
    allWorktrees.push({ repo, path: worktreePath });
    fs.writeFileSync(path.join(worktreePath, "legacy-work.txt"), "legacy worker's work\n");
    commitAll(worktreePath, "legacy work", GIT_ID);
    const workerId = "cbscb-legacy-worker";
    db.insertSession({ id: workerId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null,
      cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker", parentSessionId: `${P}-mgr1`, taskId: null, worktreePath, branch });
    check("(3 setup) the legacy worker's cutBaseSha reads null", db.getSession(workerId)?.cutBaseSha == null);

    const merge = await svc.confirmWorkerMergeTracked(`${P}-mgr1`, workerId);
    check("(3) the legacy worker's branch lands normally (grandfathered, never refused)",
      merge.settled === true && merge.ok === true && merge.value?.merged === true);
    check("(3) the file actually landed", fs.existsSync(path.join(repo, "legacy-work.txt")));

    const mergeDoneEvents = db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done");
    check("(3) a merge_done event was recorded", mergeDoneEvents.length > 0);
    check("(3) the merge_done event carries cutBaseUnknown:true (the grandfathering signal)",
      mergeDoneEvents.some((e) => e.detail?.cutBaseUnknown === true));
  }

  // ===================================================================================
  // (4) round 5 (Code Review ff5de408, item 1) — REFUTES the decision record's "confirmed UNTESTABLE"
  // claim about the canonicalGit-vs-this.boundedGit choice at the advisory call sites (record ~:150).
  // CANONICAL_GIT_CONFIG's one entry is `core.useReplaceRefs=false` (git/bounded.ts), and a PLANTED
  // `git replace` object on the diverged branch's own tip changes `git merge-base`'s answer depending on
  // whether replace refs are honored — a real, constructible condition, not a theoretical one. Mirrors
  // scenario (1)'s own shape (a real spawnWorker + confirmWorkerMergeTracked) for the POSITIVE case (NO
  // factory override — production's real canonicalGit), then re-confirms the SAME (still-unmerged,
  // untouched) worker through a SECOND SessionService using the soloMergeGitFactory seam to swap in a
  // plain, replace-honoring git wrapper (this.boundedGit's own shape) as the CONTROL.
  // ===================================================================================
  {
    const P = "pReplace";
    const repo = freshRepo("replace");
    allRepos.push(repo);
    const gateScript = path.join(os.tmpdir(), `loom-cbscb-replace-gate-${Date.now()}-${randomUUID()}.mjs`);
    registerForCleanup(gateScript);
    fs.writeFileSync(gateScript, "process.exit(0);\n");
    db.insertProject({ id: P, name: "Replace", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${gateScript}"` } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
    db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 1, profileId: null });
    db.insertSession({ id: `${P}-mgr1`, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null,
      cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const taskId = randomUUID();
    db.insertTask({ id: taskId, projectId: P, title: "replace task", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

    fs.writeFileSync(path.join(repo, "main-only.txt"), "main advanced\n");
    commitAll(repo, "main advances to c1", GIT_ID);
    const c1 = git(repo, "rev-parse HEAD");

    let gateCalls = 0;
    const sessionsReplace = new SessionService(db, host, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
    });

    const worker = await sessionsReplace.spawnWorker(`${P}-mgr1`, { taskId, agentId: `${P}-dev`, kickoffPrompt: "GO" });
    allWorktrees.push({ repo, path: worker.worktreePath });
    check("(4 setup) the real spawn stamped cutBaseSha to c1", worker.cutBaseSha === c1);
    fs.writeFileSync(path.join(worker.worktreePath, "work.txt"), "real work\n");
    commitAll(worker.worktreePath, "replace-task work", GIT_ID);

    const base = git(repo, "rev-list --max-parents=0 HEAD");
    execFileSync("git", ["checkout", "-q", "-b", "atlas", base], { cwd: repo });
    fs.writeFileSync(path.join(repo, "atlas-only.txt"), "atlas work\n");
    commitAll(repo, "atlas work", GIT_ID);
    const atlasTip = git(repo, "rev-parse HEAD");

    // Forge a commit carrying atlas's OWN tree but c1 as its PARENT, then plant it as a `git replace`
    // for atlasTip. A tool that honors replace refs now resolves `merge-base c1 atlasTip` to c1 itself
    // (wrongly: "c1 is an ancestor"); a tool that doesn't (canonicalGit's own core.useReplaceRefs=false)
    // still correctly resolves to the true, un-replaced base. Uses execFileSync (argv, no shell) for
    // every `^{...}`-bearing arg — Windows cmd.exe (execSync's default shell) treats `^` as its own
    // escape character and silently drops it, corrupting the revision spec.
    const atlasTree = execFileSync("git", ["rev-parse", `${atlasTip}^{tree}`], { cwd: repo }).toString().trim();
    // `commit-tree` creates a real commit object, so it needs an author identity — same inline `-c`
    // override `commitAll` already uses, since the sandboxed test repo has no global git identity.
    const forged = execFileSync("git", ["-c", "user.email=cbscb@loom", "-c", "user.name=cbscb", "commit-tree", atlasTree, "-p", c1], { cwd: repo }).toString().trim();
    execFileSync("git", ["replace", atlasTip, forged], { cwd: repo });
    check("(4 setup) WITH replace refs honored, merge-base is fooled into resolving to c1 (the forgery's own effect, harness sanity)",
      execFileSync("git", ["merge-base", c1, atlasTip], { cwd: repo }).toString().trim() === c1);
    check("(4 setup) WITH -c core.useReplaceRefs=false, merge-base still correctly resolves to the true base (NOT c1)",
      execFileSync("git", ["-c", "core.useReplaceRefs=false", "merge-base", c1, atlasTip], { cwd: repo }).toString().trim() !== c1);

    // POSITIVE: no factory override at all — the advisory and in-lock checks both run through
    // production's REAL canonicalGit, which disables replace refs. Refused PRE-GATE; the gate never runs.
    const merge = await sessionsReplace.confirmWorkerMergeTracked(`${P}-mgr1`, worker.id);
    check("(4) WITH real canonicalGit, the advisory correctly refuses PRE-GATE (gateCalls stays 0 — the forgery never fools it)", gateCalls === 0);
    check("(4) classified forkPointDiverged", merge.settled === true && merge.ok && merge.value?.merged === false && merge.value?.forkPointDiverged === true);
    const rejected4 = db.listEventsForWorker(worker.id).filter((e) => e.kind === "merge_rejected");
    check("(4) the merge_rejected event carries phase:\"advisory-pre-gate\" (caught by the advisory, never reaching the in-lock check)",
      rejected4.some((e) => e.detail?.phase === "advisory-pre-gate"));
    check("(4) nothing landed — canonical repo untouched, still on atlas's tip", git(repo, "rev-parse HEAD") === atlasTip);

    // CONTROL — the negative control for the WHOLE mechanism: re-confirm the SAME worker (refused above,
    // so its worktree/branch are untouched and safe to re-try) through a DIFFERENT SessionService whose
    // soloMergeGitFactory swaps in a plain, replace-honoring `simpleGit` wrapper — the SAME shape
    // `this.boundedGit` has (no core.useReplaceRefs=false). The forgery now fools BOTH the advisory and
    // the in-lock check, so the gate actually runs — proving canonicalGit's own config IS load-bearing
    // here, refuting the record's "confirmed UNTESTABLE" claim.
    let gateCallsControl = 0;
    const sessionsControl = new SessionService(db, host, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, soloMergeGitFactory: (p) => simpleGit(p),
      runGate: async () => { gateCallsControl++; return { passed: true, steps: [] }; },
    });
    await sessionsControl.confirmWorkerMergeTracked(`${P}-mgr1`, worker.id);
    check("(4 control) WITH a plain, replace-honoring git wrapper (this.boundedGit's own shape), the advisory is FOOLED and falls through to a REAL gate run (gateCallsControl === 1, not 0) — RED exactly where the positive case was green",
      gateCallsControl === 1);
    stopSeamPty(worker.id);
  }
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const { repo, path: wt } of allWorktrees) { if (wt) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const repo of allRepos) { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL spawnWorker-stamped cutBaseSha refuses a cross-lineage landing through the REAL confirmWorkerMergeTracked path (with the corrected, reachable remedy), a REAL mergeBatchTracked (gated, so it actually reaches assembly) threads THREE real candidates' cutBaseSha through — landing both ordinary candidates via batchCandidates/assembleBatchBranches and dropping only the diverged one via the advisory pre-filter — a legacy (null cutBaseSha) worker lands normally with cutBaseUnknown:true stamped on its merge_done event — and a planted `git replace` object proves canonicalGit's own core.useReplaceRefs=false is genuinely load-bearing at the advisory call sites (refuting the 'confirmed UNTESTABLE' record claim) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
