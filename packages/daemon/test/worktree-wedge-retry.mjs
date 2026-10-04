import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worktree wedge-retry test (task dea6728e — the threadpool-safe redo of bd9fc808, owner-refined:
// "quarantine" must NOT mean "dangles forever"). Proves the piece that's new on top of worktrees.mjs's
// killable-removal mechanism proof: a worktree whose removal comes back KILLED (genuinely wedged, not a
// clean reject) is tracked + RETRIED on a slow cadence (every boot-reconcile pass + the background
// sweep) — NOT skipped forever — because removal is now killable, so retrying it can never leak a
// thread or stick the daemon no matter how often it's attempted. Only past a LONG give-up bound (whichever
// of the attempt-count or elapsed-time thresholds trips FIRST) does a dir stop being retried (flipped to
// `needsHuman`, loudly surfaced, on the SAME pass that crosses the bound — task 8e5a7a5e nit fix). Also
// proves the CLEAN-reject case is never tracked as wedged and gets removed once its handle "releases", the
// plain db wedged-set store (list/get/record/markNeedsHuman/clear) at the unit level, and that
// `worktreesPruned` counts only an ACTUAL removal — a still-wedged/left-on-disk outcome is neither pruned
// nor given-up-on and increments neither aggregate counter (the other task 8e5a7a5e nit fix).
//
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() and
// sweepWedgedWorktreesOnce() directly against an isolated LOOM_HOME, injecting SessionService's
// `removeDir` test seam (see merge-finalize-resilient.mjs for the seam's rationale: the killable removal
// runs in a separate OS process now, so a Node fs monkeypatch can no longer fake a busy dir into it).
// Run: 1) build daemon, 2) node test/worktree-wedge-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wwr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { killableRemoveDir, normForCompare } = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wwr@loom -c user.name=wwr";
const now = new Date().toISOString();

// --- (unit) the plain app_meta-backed wedged-worktree store, independent of any session ---
{
  const db = new Db();
  const p1 = path.join(os.tmpdir(), "loom-wwr-unit-1");
  const p2 = path.join(os.tmpdir(), "loom-wwr-unit-2");
  check("(unit) fresh daemon has no wedged worktrees", db.listWedgedWorktrees().length === 0);
  check("(unit) an untracked path reads undefined", db.getWedgedWorktree(p1) === undefined);

  const e1 = db.recordWorktreeWedgeAttempt(p1, "/repo/one", "simulated wedge");
  check("(unit) recordWorktreeWedgeAttempt creates a first-sighting entry (attempts:1, needsHuman:false)",
    e1.attempts === 1 && e1.needsHuman === false && e1.repoPath === "/repo/one" && e1.reason === "simulated wedge");
  check("(unit) firstWedgedAt == lastAttemptAt on first sighting", e1.firstWedgedAt === e1.lastAttemptAt);

  db.recordWorktreeWedgeAttempt(p2, "/repo/two", "another wedge");
  check("(unit) a second entry doesn't clobber the first", db.getWedgedWorktree(p1)?.attempts === 1 && db.getWedgedWorktree(p2)?.attempts === 1);

  const e1b = db.recordWorktreeWedgeAttempt(p1, "/repo/one", "re-wedged with a new reason");
  check("(unit) a REPEAT attempt on the SAME path upserts (still exactly 2 entries total)", db.listWedgedWorktrees().length === 2);
  check("(unit) the repeat bumps attempts to 2", e1b.attempts === 2);
  check("(unit) the repeat keeps the ORIGINAL firstWedgedAt (age is measured from first sighting)", e1b.firstWedgedAt === e1.firstWedgedAt);
  check("(unit) the repeat updates the reason", e1b.reason === "re-wedged with a new reason");

  check("(unit) not yet needsHuman", db.getWedgedWorktree(p1)?.needsHuman === false);
  db.markWorktreeNeedsHuman(p1);
  check("(unit) markWorktreeNeedsHuman flips it", db.getWedgedWorktree(p1)?.needsHuman === true);
  check("(unit) the OTHER entry is untouched", db.getWedgedWorktree(p2)?.needsHuman === false);
  db.markWorktreeNeedsHuman("no-such-path"); // must not throw on an untracked path
  check("(unit) markWorktreeNeedsHuman on an untracked path is a harmless no-op", db.getWedgedWorktree("no-such-path") === undefined);

  db.clearWedgedWorktree(p1);
  check("(unit) clearWedgedWorktree drops just that entry", db.getWedgedWorktree(p1) === undefined && db.getWedgedWorktree(p2) !== undefined);
  db.clearWedgedWorktree(p1); // no-op on an already-cleared path — must not throw
  check("(unit) clearing an already-clear path is a harmless no-op", db.getWedgedWorktree(p1) === undefined);
  db.clearWedgedWorktree(p2); // tidy up so later blocks (sharing this same on-disk db) start clean
  db.close();
}

function seed(db, p) {
  db.insertProject({ id: p.projId, name: "WWR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", worktreePath: p.worktreePath });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wwr\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// A plain, NOT-git-registered leftover dir (mirrors merge-finalize-resilient.mjs's busyDir) — `git
// worktree remove --force` on it fails ("not a working tree") and is swallowed, so it falls through to
// the fs backstop fully intact, letting the injected removeDir seam decide its fate deterministically (a
// REAL registered worktree would just get deleted by the git step itself, since it isn't actually busy —
// the fs backstop would never even be reached).
function leftoverDir(tag, sfx) {
  const dir = path.join(WORKTREES_DIR, "wwr-fixture", `${tag}-leftover-${sfx}`); // under the worktrees root, or gcWorktreeDir's e21cfd5f path guard refuses it
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "leftover.txt"), "dead leftover\n");
  return dir;
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// --- (wedge) a worktree whose removal comes back KILLED — must be RETRIED, not abandoned ---
{
  const db = new Db();
  const W = { projId: `wwr-w-proj-${sfx}`, agentId: `wwr-w-top-${sfx}`, workerId: `wwr-w-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wwr-wedge-${sfx}`) };
  initRepo(W.repo);
  W.worktreePath = leftoverDir("wedge", sfx);
  seed(db, W);

  let removeDirCalls = 0;
  let stillWedged = true; // flips to false once we simulate the handle releasing
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => {
      if (target !== W.worktreePath) return { removed: true, killed: false };
      removeDirCalls++;
      if (stillWedged) return { removed: false, killed: true };
      return killableRemoveDir(target, ms); // "handle released" — the real removal now succeeds
    },
  });

  const r1 = await sessions.reconcileOrchestrationOnBoot();
  check("(wedge) first pass ATTEMPTS the removal", removeDirCalls === 1);
  check("(wedge) worktree dir is LEFT ON DISK (killed, not removed)", fs.existsSync(W.worktreePath));
  check("(wedge) is now TRACKED as wedged, attempts:1, NOT needsHuman", db.getWedgedWorktree(W.worktreePath)?.attempts === 1 && db.getWedgedWorktree(W.worktreePath)?.needsHuman === false);
  // worktreesPruned counts only an ACTUAL removal (not merely an attempt) — a still-wedged dir increments
  // neither counter (it's neither pruned nor given-up-on yet), just tracked in the wedged-set above.
  check("(wedge) first pass attempted but did NOT actually prune (nothing removed yet), NOT gave-up", r1.worktreesPruned === 0 && r1.worktreesNeedsHuman === 0);

  // THE CORE REFINEMENT: a SECOND boot-reconcile pass RETRIES it (does NOT skip) — still wedged.
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(wedge) a SECOND pass RETRIES the removal (NOT skipped forever) — removeDir called again", removeDirCalls === 2);
  check("(wedge) attempts incremented to 2 on the retry", db.getWedgedWorktree(W.worktreePath)?.attempts === 2);
  check("(wedge) second pass STILL attempted but still not actually pruned, not a skip", r2.worktreesPruned === 0 && r2.worktreesNeedsHuman === 0);

  // Now simulate the handle releasing (the whole point: wedges are eventually resolvable). The NEXT
  // retry — via the background sweep, driven directly here rather than waiting on the real interval —
  // must actually remove it and drop it from wedged tracking.
  stillWedged = false;
  await sessions.sweepWedgedWorktreesOnce();
  check("(wedge) once unwedged, the sweep ACTUALLY removes the dir", !fs.existsSync(W.worktreePath));
  check("(wedge) removed → dropped from wedged tracking entirely", db.getWedgedWorktree(W.worktreePath) === undefined);

  db.close();
  fs.rmSync(W.repo, { recursive: true, force: true });
}

// --- (reclaim) card a5d9c458 — a wedge entry whose PATH has since been RE-CLAIMED by a LIVE session
//     must survive a sweep tick untouched, and the stale tracking entry must be dropped. This is the
//     confirmed incident: createWorktree derives worktree paths deterministically per task, so a
//     respawn of the same task creates a brand-new LIVE worktree at the exact path an old
//     WedgedWorktreeEntry still names; without the re-check, the next sweep tick deletes that live
//     worktree (it happened for real — worker 94a6ce86's worktree, with two real commits, 2026-10-04). ---
{
  const db = new Db();
  const R = { projId: `wwr-r-proj-${sfx}`, agentId: `wwr-r-top-${sfx}`, liveId: `wwr-r-live-${sfx}`, repo: path.join(os.tmpdir(), `loom-wwr-reclaim-${sfx}`) };
  initRepo(R.repo);
  R.worktreePath = leftoverDir("reclaim", sfx);
  // Seed a wedge entry for this exact path — mirroring the earlier orphan that was once wedged here.
  db.recordWorktreeWedgeAttempt(R.worktreePath, R.repo, "simulated earlier wedge (now superseded by a live respawn)");
  check("(reclaim setup) path is tracked as wedged before the sweep runs", db.getWedgedWorktree(R.worktreePath) !== undefined);
  // The SAME path is now claimed by a brand-new LIVE session (the respawn shape: a fresh worktree was
  // cut at the exact same deterministic path after the old orphan was superseded).
  db.insertProject({ id: R.projId, name: "WWR-reclaim", repoPath: R.repo, vaultPath: R.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: R.agentId, projectId: R.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: R.liveId, projectId: R.projId, agentId: R.agentId, engineSessionId: null, title: null, cwd: R.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", worktreePath: R.worktreePath });
  fs.writeFileSync(path.join(R.worktreePath, "live-worker-content.txt"), "live worker's real content\n");

  let removeDirCallsForR = 0;
  const sessionsR = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === R.worktreePath) removeDirCallsForR++; return killableRemoveDir(target, ms); },
  });
  await sessionsR.sweepWedgedWorktreesOnce();
  check("(reclaim) RED-PROOF SHAPE: the sweep NEVER attempted removal against the now-live path", removeDirCallsForR === 0);
  check("(reclaim) the live worktree's content SURVIVED the sweep tick untouched", fs.existsSync(path.join(R.worktreePath, "live-worker-content.txt")));
  check("(reclaim) the stale wedge-tracking entry was DROPPED (not left to retry against a live path forever)", db.getWedgedWorktree(R.worktreePath) === undefined);

  db.close();
  fs.rmSync(R.worktreePath, { recursive: true, force: true });
  fs.rmSync(R.repo, { recursive: true, force: true });
}

// --- (reclaim-genuine-orphan) negative control: an UNCLAIMED wedged path (no live session anywhere
//     claims it) must still be removed exactly as before — proves the new live-claim re-check doesn't
//     regress ordinary orphan cleanup. (The "(wedge)" block above already proves this implicitly since
//     sweepWedgedWorktreesOnce now always passes staleKnowledge:true, but this makes it explicit.) ---
{
  const db = new Db();
  const N = { projId: `wwr-n-proj-${sfx}`, agentId: `wwr-n-top-${sfx}`, deadId: `wwr-n-dead-${sfx}`, repo: path.join(os.tmpdir(), `loom-wwr-orphan-${sfx}`) };
  initRepo(N.repo);
  N.worktreePath = leftoverDir("orphan", sfx);
  db.recordWorktreeWedgeAttempt(N.worktreePath, N.repo, "simulated wedge, never reclaimed");
  // A DEAD session row sharing the path (the ordinary "orphan from an exited worker" shape) — no LIVE
  // session claims it, so findLiveSessionClaimingWorktreePath must return null for this path.
  seed(db, N);

  let removeDirCallsForN = 0;
  const sessionsN = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === N.worktreePath) removeDirCallsForN++; return killableRemoveDir(target, ms); },
  });
  await sessionsN.sweepWedgedWorktreesOnce();
  check("(reclaim-genuine-orphan) an unclaimed orphan IS still removed by the sweep", !fs.existsSync(N.worktreePath));
  check("(reclaim-genuine-orphan) removeDir was actually invoked (the live-claim re-check did not short-circuit it)", removeDirCallsForN > 0);
  check("(reclaim-genuine-orphan) removed → dropped from wedged tracking", db.getWedgedWorktree(N.worktreePath) === undefined);

  db.close();
  fs.rmSync(N.repo, { recursive: true, force: true });
}

// --- (in-flight-claim) card a5d9c458 ROUND 2 — Code Review ffc2b31b: the staleKnowledge live-claim guard
//     above (the "(reclaim)" block) can only ever see a SESSION ROW, but spawnWorker/the batch worktree
//     cut both insert that row only AFTER createWorktree + provisioning return, which can run for a long
//     time. A path claimed by such an IN-FLIGHT spawn — no session row exists yet — must ALSO survive a
//     sweep tick. Simulates the claim reclaimWedgedWorktreePathForSpawn adds SYNCHRONOUSLY via the SAME
//     in-memory set it populates (white-box — TS `private` is erased at runtime; same pattern
//     worker-spawn-cap-queue.mjs already uses for `inFlightSpawnTaskIds`). The access is GUARDED so
//     pre-fix code (no such field) reaches a real check() failure instead of a TypeError: pre-fix there
//     is nothing to claim with, so the live-claim guard legitimately sees no claimant and — the real
//     round-2 regression — proceeds to scan/remove the path anyway. ---
{
  const db = new Db();
  const F = { repo: path.join(os.tmpdir(), `loom-wwr-inflight-${sfx}`) };
  initRepo(F.repo);
  F.worktreePath = leftoverDir("inflight", sfx);
  db.recordWorktreeWedgeAttempt(F.worktreePath, F.repo, "simulated earlier wedge, now claimed by an in-flight spawn");

  let scanCalls = 0;
  let removeDirCallsForF = 0;
  const sessionsF = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === F.worktreePath) removeDirCallsForF++; return killableRemoveDir(target, ms); },
    findNestedGitRepos: async () => { scanCalls++; return { repos: [], truncated: false }; },
  });
  // The claim is already in place BEFORE the sweep runs — the EARLY staleKnowledge check (before any
  // scan) should catch it, so the scan should never even run.
  if (sessionsF.claimedWorktreePaths) sessionsF.claimedWorktreePaths.add(normForCompare(F.worktreePath));

  await sessionsF.sweepWedgedWorktreesOnce();
  check("(in-flight-claim) the EARLY check catches it — the nested-repo scan never even ran", scanCalls === 0);
  check("(in-flight-claim) removeDir was NEVER invoked against the claimed path", removeDirCallsForF === 0);
  check("(in-flight-claim) the claimed path's real content SURVIVED the sweep tick untouched", fs.existsSync(path.join(F.worktreePath, "leftover.txt")));
  check("(in-flight-claim) the stale wedge-tracking entry was DROPPED", db.getWedgedWorktree(F.worktreePath) === undefined);

  db.close();
  fs.rmSync(F.worktreePath, { recursive: true, force: true });
  fs.rmSync(F.repo, { recursive: true, force: true });
}

// --- (entry-superseded) card a5d9c458 ROUND 2 — a wedge entry that gets CLEARED and RE-RECORDED (a
//     genuinely different wedge situation — a new firstWedgedAt) WHILE a sweep tick is already acting on
//     the OLD snapshot of it must survive untouched: the sweep must re-check the entry it snapshotted is
//     still CURRENT, not just whether a live session/in-flight spawn claims the path. ---
{
  const db = new Db();
  const S = { repo: path.join(os.tmpdir(), `loom-wwr-superseded-${sfx}`) };
  initRepo(S.repo);
  S.worktreePath = leftoverDir("superseded", sfx);
  // @decision a5d9c458 (round 3 nit) — seed the OLD entry with an EXPLICITLY older firstWedgedAt via a
  // direct app_meta write, bypassing recordWorktreeWedgeAttempt's own `now` stamp. Both this entry and
  // the LATER re-record below (seeded via the ordinary API, which stamps real `now`) would otherwise
  // both carry a millisecond-resolution ISO timestamp — same-millisecond collision is a real, if rare,
  // flake risk, and this test exists specifically to prove the supersede check discriminates on
  // firstWedgedAt, so it must never depend on two Date.now() calls happening to land in different ms.
  const OLD_FIRST_WEDGED_AT = new Date(Date.now() - 3_600_000).toISOString(); // 1h in the past — can never collide with "now"
  db.setMeta("worktree_wedged", JSON.stringify([{
    worktreePath: S.worktreePath, repoPath: S.repo, firstWedgedAt: OLD_FIRST_WEDGED_AT, lastAttemptAt: OLD_FIRST_WEDGED_AT,
    attempts: 1, reason: "the OLD wedge situation, snapshotted by this sweep tick", needsHuman: false,
  }]));
  check("(entry-superseded setup) the OLD entry's firstWedgedAt is the explicit past timestamp, not `now`",
    db.getWedgedWorktree(S.worktreePath)?.firstWedgedAt === OLD_FIRST_WEDGED_AT);

  let removeDirCallsForS = 0;
  const sessionsS = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === S.worktreePath) removeDirCallsForS++; return killableRemoveDir(target, ms); },
    findNestedGitRepos: async () => {
      // Mid-sweep, BEFORE removal: the path is cleared and re-wedged for a genuinely DIFFERENT reason (a
      // new firstWedgedAt) — simulating a concurrent reclaim/re-wedge racing this same sweep tick.
      db.clearWedgedWorktree(S.worktreePath);
      db.recordWorktreeWedgeAttempt(S.worktreePath, S.repo, "a LATER, different wedge situation at the same path");
      return { repos: [], truncated: false };
    },
  });
  await sessionsS.sweepWedgedWorktreesOnce();
  check("(entry-superseded) removeDir was NEVER invoked — the supersession was caught before removal", removeDirCallsForS === 0);
  check("(entry-superseded) the path's real content SURVIVED the sweep tick untouched", fs.existsSync(path.join(S.worktreePath, "leftover.txt")));
  const afterS = db.getWedgedWorktree(S.worktreePath);
  check("(entry-superseded) the NEW (later) wedge entry is still tracked, untouched by the stale sweep tick",
    afterS !== undefined && afterS.reason === "a LATER, different wedge situation at the same path" && afterS.attempts === 1);

  db.close();
  fs.rmSync(S.worktreePath, { recursive: true, force: true });
  fs.rmSync(S.repo, { recursive: true, force: true });
}

// --- (claim-arrives-mid-scan) card a5d9c458 ROUND 2 — a claim that arrives WHILE the sweep's own
//     nested-repo scan is in flight (nothing claimed the path yet when the sweep tick started) must
//     still be caught — by the REPEATED check right before removal, not just the one before the scan. ---
{
  const db = new Db();
  const M = { repo: path.join(os.tmpdir(), `loom-wwr-midscan-${sfx}`) };
  initRepo(M.repo);
  M.worktreePath = leftoverDir("midscan", sfx);
  db.recordWorktreeWedgeAttempt(M.worktreePath, M.repo, "simulated wedge, nothing claims it YET");

  let scanCallsM = 0;
  let removeDirCallsForM = 0;
  const sessionsM = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === M.worktreePath) removeDirCallsForM++; return killableRemoveDir(target, ms); },
    findNestedGitRepos: async () => {
      scanCallsM++;
      // The claim arrives DURING the scan await — AFTER the EARLY check already ran clean.
      if (sessionsM.claimedWorktreePaths) sessionsM.claimedWorktreePaths.add(normForCompare(M.worktreePath));
      return { repos: [], truncated: false };
    },
  });
  await sessionsM.sweepWedgedWorktreesOnce();
  check("(claim-arrives-mid-scan) the scan DID run — the early check passed through clean, as expected", scanCallsM === 1);
  check("(claim-arrives-mid-scan) removeDir was NEVER invoked — the LATE re-check caught the claim", removeDirCallsForM === 0);
  check("(claim-arrives-mid-scan) the path's real content SURVIVED the sweep tick untouched", fs.existsSync(path.join(M.worktreePath, "leftover.txt")));
  check("(claim-arrives-mid-scan) the stale wedge-tracking entry was DROPPED", db.getWedgedWorktree(M.worktreePath) === undefined);

  db.close();
  fs.rmSync(M.worktreePath, { recursive: true, force: true });
  fs.rmSync(M.repo, { recursive: true, force: true });
}

// --- (give-up) a worktree wedged past the long give-up bound flips to needsHuman and STOPS being retried ---
{
  const db = new Db();
  const G = { projId: `wwr-g-proj-${sfx}`, agentId: `wwr-g-top-${sfx}`, workerId: `wwr-g-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wwr-giveup-${sfx}`) };
  initRepo(G.repo);
  G.worktreePath = leftoverDir("giveup", sfx);
  seed(db, G);

  let removeDirCalls = 0;
  const GIVE_UP_ATTEMPTS = 3; // tiny, test-only bound (production default is much larger)
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target) => {
      if (target !== G.worktreePath) return { removed: true, killed: false };
      removeDirCalls++;
      return { removed: false, killed: true }; // NEVER unwedges — proves the give-up bound, not a lucky release
    },
    wedgeGiveUpAttempts: GIVE_UP_ATTEMPTS,
  });

  // Every attempt is genuinely killed (never removed), so worktreesPruned stays 0 throughout — only the
  // FINAL attempt (the one that crosses the give-up bound) should flip worktreesNeedsHuman, on that SAME
  // pass (the nit-2 fix: the crossing pass reports needs-human-skip directly, not one more "wedged").
  for (let i = 1; i < GIVE_UP_ATTEMPTS; i++) {
    const r = await sessions.reconcileOrchestrationOnBoot();
    check(`(give-up) attempt ${i}/${GIVE_UP_ATTEMPTS}: still retried (not yet given up), no prune, no give-up yet`, r.worktreesNeedsHuman === 0 && r.worktreesPruned === 0);
  }
  const rCrossing = await sessions.reconcileOrchestrationOnBoot();
  check(`(give-up) the pass that CROSSES the bound (attempt ${GIVE_UP_ATTEMPTS}) reports needsHuman on the SAME pass, not pruned`,
    rCrossing.worktreesNeedsHuman === 1 && rCrossing.worktreesPruned === 0);
  check(`(give-up) exactly ${GIVE_UP_ATTEMPTS} removal attempts were made before giving up`, removeDirCalls === GIVE_UP_ATTEMPTS);
  check("(give-up) now flipped to needsHuman", db.getWedgedWorktree(G.worktreePath)?.needsHuman === true);

  // ONE MORE pass: must SKIP entirely now (no further removal attempt) and report it via worktreesNeedsHuman.
  const rFinal = await sessions.reconcileOrchestrationOnBoot();
  check("(give-up) a pass AFTER giving up does NOT attempt removal again (no new call)", removeDirCalls === GIVE_UP_ATTEMPTS);
  check("(give-up) reported as worktreesNeedsHuman, not a fresh prune attempt", rFinal.worktreesNeedsHuman === 1 && rFinal.worktreesPruned === 0);
  check("(give-up) the background sweep also leaves it alone (it's excluded from `pending`)", db.listWedgedWorktrees().filter((e) => !e.needsHuman).length === 0);

  db.close();
  fs.rmSync(G.worktreePath, { recursive: true, force: true });
  fs.rmSync(G.repo, { recursive: true, force: true });
}

// --- (clean-reject) a worktree whose removal fails a couple of times (settled, not killed) then
//     succeeds once the "handle releases" — must NEVER be tracked as wedged, and ends up removed. ---
{
  const db = new Db();
  const C = { projId: `wwr-c-proj-${sfx}`, agentId: `wwr-c-top-${sfx}`, workerId: `wwr-c-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-wwr-clean-${sfx}`) };
  initRepo(C.repo);
  C.worktreePath = leftoverDir("clean", sfx);
  seed(db, C);

  let attempts = 0;
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => {
      if (target !== C.worktreePath) return { removed: true, killed: false };
      attempts++;
      if (attempts < 2) return { removed: false, killed: false }; // clean reject: settles, not killed
      return killableRemoveDir(target, ms); // "handle released" — the real removal now succeeds
    },
  });

  const r = await sessions.reconcileOrchestrationOnBoot();
  check("(clean-reject) removeDir was retried (more than one attempt) before succeeding", attempts >= 2);
  check("(clean-reject) worktree was ACTUALLY removed once the handle released", !fs.existsSync(C.worktreePath));
  check("(clean-reject) NEVER tracked as wedged (a clean reject is a different code path entirely)", db.getWedgedWorktree(C.worktreePath) === undefined);
  check("(clean-reject) counted as a normal prune, not a give-up", r.worktreesPruned === 1 && r.worktreesNeedsHuman === 0);

  db.close();
  fs.rmSync(C.repo, { recursive: true, force: true });
}

fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — a genuinely wedged worktree removal is TRACKED and RETRIED on every boot-reconcile pass (never permanently skipped) until it either succeeds (dropped from tracking, self-healing once the handle releases) or crosses a long give-up bound (flipped to needsHuman, then and only then skipped + loudly surfaced); a clean/transient reject is never tracked as wedged at all and is bounded-retried + removed inline; (card a5d9c458) a wedged path re-claimed by a live session survives a sweep tick untouched with its stale tracking dropped, while a genuinely unclaimed orphan is still removed exactly as before; and (round 2) a path claimed by an IN-FLIGHT spawn (no session row yet), an entry SUPERSEDED mid-sweep, and a claim ARRIVING during the scan/reap window all survive too — caught by the early AND the repeated late re-check."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
