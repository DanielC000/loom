import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// node_modules reclaim test (card 1008e305 — reclaim node_modules from retained worker worktrees that
// hold no live session). Two layers:
//   (A) reclaimNodeModulesDir/measureDirSize (git/worktrees.js) — direct, real-fs + real-git tests,
//       including the load-bearing never-settling-rm case (bd9fc808's own hazard class) via a REAL
//       hanging child process, mirroring worktrees.mjs's (l2) pattern.
//   (B) SessionService.listNodeModulesReclaimCandidates/reclaimNodeModules — liveness/age eligibility and
//       end-to-end reclaim, against real session rows in an isolated Db.
// REAL git on temp repos, NO claude + NO live daemon. Run: 1) build daemon, 2) node test/node-modules-reclaim.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-nmr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { reclaimNodeModulesDir, measureDirSize, killableRemoveDir } = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const TIMER_SLACK_MS = 50; // mirrors worktrees.mjs's own bounded-op timing slack
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const GIT_ID = "-c user.email=nmr@loom -c user.name=nmr";

function writeFile(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function makeWorktree(tag) {
  const repo = path.join(WORKTREES_DIR, "nmr-fixture", `repo-${tag}-${Math.random().toString(36).slice(2, 7)}`); // under the worktrees root, or reclaimNodeModulesDir's e21cfd5f path guard refuses it
  fs.mkdirSync(repo, { recursive: true });
  writeFile(path.join(repo, "README.md"), "# nmr\n");
  writeFile(path.join(repo, ".gitignore"), "node_modules/\n"); // committed, matching a real project's own gitignore
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// ==================== (A) reclaimNodeModulesDir / measureDirSize — direct ====================

// (a) fast-successful removal: node_modules with known content is measured + removed; tracked git state
//     (HEAD, branch, tracked-file status) is byte-identical before/after (node_modules is gitignored, so
//     there is nothing for git to have ever known about it).
{
  const repo = makeWorktree("fast");
  writeFile(path.join(repo, "node_modules", "pkg-a", "index.js"), "a".repeat(1000));
  writeFile(path.join(repo, "node_modules", "pkg-b", "nested", "index.js"), "b".repeat(2500));

  const headBefore = git(repo, "rev-parse HEAD");
  const branchBefore = git(repo, "rev-parse --abbrev-ref HEAD");
  const statusBefore = git(repo, "status --porcelain"); // node_modules untracked but .gitignore'd → empty

  const outcome = await reclaimNodeModulesDir(repo, 5000);

  check("(a) outcome is 'removed'", outcome.outcome === "removed");
  check("(a) measured bytes match the real file content (>= 3500B, exact sum of the two files)", outcome.bytesReclaimed === 1000 + 2500);
  check("(a) sizeTruncated is false (well under the scan cap)", outcome.sizeTruncated === false);
  check("(a) node_modules is actually gone from disk", !fs.existsSync(path.join(repo, "node_modules")));

  const headAfter = git(repo, "rev-parse HEAD");
  const branchAfter = git(repo, "rev-parse --abbrev-ref HEAD");
  const statusAfter = git(repo, "status --porcelain");
  check("(a) HEAD sha is byte-identical after reclaim (no commit lost/altered)", headBefore === headAfter);
  check("(a) branch is byte-identical after reclaim", branchBefore === branchAfter);
  check("(a) git status is byte-identical after reclaim (nothing tracked was touched)", statusBefore === statusAfter && statusAfter === "");

  fs.rmSync(repo, { recursive: true, force: true });
}

// (a2) fast-successful removal on a worktree that ALSO carries real uncommitted/staged tracked-file work
//      — proves the reclaim touches ONLY node_modules, never any tracked content, dirty or clean.
{
  const repo = makeWorktree("dirty");
  writeFile(path.join(repo, "node_modules", "pkg-c", "index.js"), "c".repeat(777));
  writeFile(path.join(repo, "work.txt"), "uncommitted worker edit\n"); // untracked, real work
  writeFile(path.join(repo, "README.md"), "# nmr\nedited\n"); // tracked, modified, unstaged

  const statusBefore = git(repo, "status --porcelain");
  check("(a2) precondition: real tracked+untracked dirt is present before reclaim", statusBefore.includes("work.txt") && statusBefore.includes("README.md"));

  const outcome = await reclaimNodeModulesDir(repo, 5000);
  check("(a2) node_modules removed", outcome.outcome === "removed" && outcome.bytesReclaimed === 777);

  const statusAfter = git(repo, "status --porcelain");
  check("(a2) the real dirty/untracked tracked-file state is BYTE-IDENTICAL after reclaim", statusBefore === statusAfter);
  check("(a2) the untracked work file itself is untouched on disk", fs.readFileSync(path.join(repo, "work.txt"), "utf8") === "uncommitted worker edit\n");

  fs.rmSync(repo, { recursive: true, force: true });
}

// (b) missing node_modules → "missing", no removal attempted, no bytes reclaimed.
{
  const repo = makeWorktree("missing");
  let removeDirCalls = 0;
  const outcome = await reclaimNodeModulesDir(repo, 5000, { removeDir: async () => { removeDirCalls++; return { removed: true, killed: false }; } });
  check("(b) outcome is 'missing'", outcome.outcome === "missing");
  check("(b) bytesReclaimed is null", outcome.bytesReclaimed === null);
  check("(b) removeDir was never even called (nothing to remove)", removeDirCalls === 0);
  fs.rmSync(repo, { recursive: true, force: true });
}

// (c) THE LOAD-BEARING CASE — a never-settling removal (genuinely wedged, card bd9fc808's own hazard
//     class). A REAL OS child process that never exits, standing in for a wedged rmdir/rm -rf. Must:
//     return within the bound (not hang the caller forever), report 'wedged' (never 'removed'), leave
//     node_modules ON DISK, and — critically — make exactly ONE removal attempt (never retry a hang).
{
  const repo = makeWorktree("wedged");
  writeFile(path.join(repo, "node_modules", "pkg-d", "index.js"), "d".repeat(400));

  const HANG_TIMEOUT_MS = 300;
  let spawnCalls = 0;
  const hangingChild = () => {
    spawnCalls++;
    return spawn(process.execPath, ["-e", "setInterval(() => {}, 999999)"], { stdio: "ignore" });
  };
  const removeDir = (target, ms) => killableRemoveDir(target, ms, hangingChild);

  const t0 = performance.now(); // MONOTONIC — see worktrees.mjs's own TIMER_SLACK_MS rationale
  const outcome = await reclaimNodeModulesDir(repo, HANG_TIMEOUT_MS, { removeDir });
  const elapsed = performance.now() - t0;

  check("(c) outcome is 'wedged' (genuinely stuck, NOT removed)", outcome.outcome === "wedged");
  check("(c) bytesReclaimed is null on a wedged outcome", outcome.bytesReclaimed === null);
  check("(c) node_modules is STILL ON DISK (never touched by a killed removal)", fs.existsSync(path.join(repo, "node_modules", "pkg-d", "index.js")));
  check(`(c) returned within the bound (~${HANG_TIMEOUT_MS}ms), not an infinite hang: ${Math.round(elapsed)}ms`,
    elapsed >= HANG_TIMEOUT_MS - TIMER_SLACK_MS && elapsed < HANG_TIMEOUT_MS * 4 + 1500);
  check("(c) exactly ONE removal attempt was made — a hung removal is NEVER retried in-process (bd9fc808)", spawnCalls === 1);

  fs.rmSync(repo, { recursive: true, force: true });
}

// (c2) card 3640abf5 — raceRemoval's OWN outer timeout, distinct from (c) above: (c) exercises
//      killableRemoveDir's own INNER timer settling the promise with {killed:true} (kind:"result"); this
//      case uses a removeDir stub whose promise NEVER settles at all, so only raceRemoval's OUTER timer
//      can resolve it. Both must report the same "wedged" outcome to the caller, but they are genuinely
//      distinct seams — a never-settling stub does not exercise (c)'s path, and vice versa.
{
  const repo = makeWorktree("outer-timeout");
  writeFile(path.join(repo, "node_modules", "pkg-e", "index.js"), "e".repeat(200));

  const RACE_TIMEOUT_MS = 200;
  let removeDirCalls = 0;
  const removeDir = () => { removeDirCalls++; return new Promise(() => { /* never settles */ }); };

  const t0 = performance.now();
  const outcome = await reclaimNodeModulesDir(repo, RACE_TIMEOUT_MS, { removeDir });
  const elapsed = performance.now() - t0;

  check("(c2) a removeDir promise that never settles still resolves via raceRemoval's OUTER timeout, reported as 'wedged'", outcome.outcome === "wedged");
  check("(c2) bytesReclaimed is null", outcome.bytesReclaimed === null);
  check(`(c2) returned within the outer bound (~${RACE_TIMEOUT_MS}ms), not an infinite hang: ${Math.round(elapsed)}ms`,
    elapsed >= RACE_TIMEOUT_MS - TIMER_SLACK_MS && elapsed < RACE_TIMEOUT_MS * 4 + 1500);
  check("(c2) exactly ONE removeDir call was made", removeDirCalls === 1);
  check("(c2) node_modules is STILL on disk", fs.existsSync(path.join(repo, "node_modules", "pkg-e", "index.js")));

  fs.rmSync(repo, { recursive: true, force: true });
}

// (c3) card 3640abf5 — THE REJECTION SEAM this card exists for: removeDir's returned promise REJECTS
//      synchronously (standing in for a real spawn() failure inside killableRemoveDir's own executor —
//      see raceRemoval's own doc). Before this card's fix, this propagated straight out of
//      reclaimNodeModulesDir as an unhandled rejection; it must now settle as a structured "rejected"
//      outcome, distinct from "wedged" (no kill ever happened), and never retried.
{
  const repo = makeWorktree("rejected");
  writeFile(path.join(repo, "node_modules", "pkg-f", "index.js"), "f".repeat(300));

  let removeDirCalls = 0;
  const removeDir = () => { removeDirCalls++; return Promise.reject(new Error("ENOENT: spawn rmdir ENOENT (synthetic)")); };

  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.join(" ")); };
  let outcome;
  try {
    outcome = await reclaimNodeModulesDir(repo, 5000, { removeDir });
  } finally {
    console.warn = realWarn;
  }

  check("(c3) a rejected removeDir promise settles as outcome 'rejected', never throws past this function", outcome.outcome === "rejected");
  check("(c3) bytesReclaimed is null on a rejected outcome", outcome.bytesReclaimed === null);
  check("(c3) rejectionMessage carries the real error text", outcome.rejectionMessage === "ENOENT: spawn rmdir ENOENT (synthetic)");
  check("(c3) NEGATIVE CONTROL: a 'rejected' outcome is never reported as 'wedged' — the two must stay distinguishable", outcome.outcome !== "wedged");
  check("(c3) node_modules is STILL on disk (a never-started removal touches nothing)", fs.existsSync(path.join(repo, "node_modules", "pkg-f", "index.js")));
  check("(c3) a rejection WARNS, mirroring every sibling raceRemoval caller (removeWorktree/removeRunSnapshot)", warns.some((w) => w.includes("[worktree] could not reclaim") && w.includes(path.join(repo, "node_modules")) && w.includes("ENOENT: spawn rmdir ENOENT (synthetic)")));
  check("(c3) exactly ONE removeDir call was made (never retried)", removeDirCalls === 1);

  fs.rmSync(repo, { recursive: true, force: true });
}

// (d) measureDirSize truncation is honestly signalled — a scan capped mid-walk reports truncated:true,
//     and the partial sum is still returned (a lower bound), never silently dropped to 0.
{
  const dir = path.join(os.tmpdir(), `loom-nmr-measure-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  writeFile(path.join(dir, "a.txt"), "x".repeat(10));
  writeFile(path.join(dir, "b.txt"), "y".repeat(20));
  const result = await measureDirSize(dir);
  check("(d) measureDirSize sums real file bytes", result.bytes === 30);
  check("(d) not truncated under the real cap", result.truncated === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ==================== (B) SessionService candidate listing + reclaim ====================

const now = new Date();
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
const HOUR = 3_600_000;

function seedProject(db, projId, name) {
  db.insertProject({ id: projId, name, repoPath: `/repo/${projId}`, vaultPath: `/repo/${projId}`, config: {}, createdAt: now.toISOString(), archivedAt: null });
}
function seedSession(db, s) {
  db.insertSession({
    id: s.id, projectId: s.projectId, agentId: s.agentId, engineSessionId: null, title: null,
    cwd: s.worktreePath, processState: s.processState, resumability: s.resumability, busy: false,
    createdAt: s.lastActivity, lastActivity: s.lastActivity, lastError: null, role: "worker",
    worktreePath: s.worktreePath, taskId: s.taskId ?? null, branch: s.branch ?? null,
  });
}

// (e) liveness excludes a candidate even with an old lastActivity + node_modules present.
// (f) too-fresh (under minAgeHours) is excluded.
// (g) a genuinely eligible worktree (resumability:"dead", old, node_modules present) IS returned.
// (h) a worktree with no node_modules at all is excluded.
// (e2) review finding [1]: an EXITED-but-RESUMABLE session (worker_stop'd / merge-rejected-and-parked /
//      crash-orphaned) is EXCLUDED even though it's old enough to pass the age threshold — resume()
//      spawns straight into session.cwd with no reinstall trigger of its own, so a resumable worktree's
//      deps must never be reclaimed out from under it.
{
  const db = new Db();
  const projId = "nmr-proj-e";
  seedProject(db, projId, "NMR Project E");
  db.insertAgent({ id: "nmr-agent-e", projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const liveWt = makeWorktree("live");
  writeFile(path.join(liveWt, "node_modules", "x", "i.js"), "x");
  seedSession(db, { id: "nmr-s-live", projectId: projId, agentId: "nmr-agent-e", worktreePath: liveWt, processState: "running", resumability: "resumable", lastActivity: iso(72 * HOUR), taskId: "task-live" });

  const exitedResumableWt = makeWorktree("exited-resumable");
  writeFile(path.join(exitedResumableWt, "node_modules", "x", "i.js"), "x");
  seedSession(db, { id: "nmr-s-exited-resumable", projectId: projId, agentId: "nmr-agent-e", worktreePath: exitedResumableWt, processState: "exited", resumability: "resumable", lastActivity: iso(72 * HOUR), taskId: "task-exited-resumable" });

  const freshWt = makeWorktree("fresh");
  writeFile(path.join(freshWt, "node_modules", "x", "i.js"), "x");
  seedSession(db, { id: "nmr-s-fresh", projectId: projId, agentId: "nmr-agent-e", worktreePath: freshWt, processState: "exited", resumability: "dead", lastActivity: iso(1 * HOUR), taskId: "task-fresh" });

  const eligibleWt = makeWorktree("eligible");
  writeFile(path.join(eligibleWt, "node_modules", "x", "i.js"), "x".repeat(50));
  seedSession(db, { id: "nmr-s-eligible", projectId: projId, agentId: "nmr-agent-e", worktreePath: eligibleWt, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-eligible", branch: "loom/eligible" });

  const noDepsWt = makeWorktree("nodeps");
  seedSession(db, { id: "nmr-s-nodeps", projectId: projId, agentId: "nmr-agent-e", worktreePath: noDepsWt, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-nodeps" });

  const sessions = new SessionService(db, {}, new OrchestrationControl());
  const { count, entries } = await sessions.listNodeModulesReclaimCandidates(24);

  check("(e) a LIVE session's worktree is EXCLUDED even with old lastActivity + node_modules present", !entries.some((e) => e.worktreePath === liveWt));
  check("(e2) an EXITED-but-RESUMABLE session's worktree is EXCLUDED despite being old enough (finding [1])", !entries.some((e) => e.worktreePath === exitedResumableWt));
  check("(f) a too-FRESH (under minAgeHours) resumability:dead worktree is excluded", !entries.some((e) => e.worktreePath === freshWt));
  check("(g) a genuinely eligible worktree IS included", entries.some((e) => e.worktreePath === eligibleWt));
  const eligibleEntry = entries.find((e) => e.worktreePath === eligibleWt);
  check("(g) the eligible entry carries the right sessionId/taskId/projectId/projectName", eligibleEntry
    && eligibleEntry.sessionId === "nmr-s-eligible" && eligibleEntry.taskId === "task-eligible"
    && eligibleEntry.projectId === projId && eligibleEntry.projectName === "NMR Project E");
  check("(g) ageHours is floored and >= 24", eligibleEntry && eligibleEntry.ageHours >= 24);
  check("(h) a worktree with NO node_modules at all is excluded", !entries.some((e) => e.worktreePath === noDepsWt));
  check("(count) count matches entries.length", count === entries.length);

  db.close();
  for (const wt of [liveWt, exitedResumableWt, freshWt, eligibleWt, noDepsWt]) fs.rmSync(wt, { recursive: true, force: true });
}

// (i) a worktree path SHARED across two session rows (a worker_recycle chain) — eligibility is decided
//     from the UNION of every session that ever held the path, so a resumability:"resumable" SUCCESSOR
//     row correctly excludes it even though an older, resumability:"dead" predecessor row alone would
//     suggest it's eligible.
{
  const db = new Db();
  const projId = "nmr-proj-i";
  seedProject(db, projId, "NMR Project I");
  db.insertAgent({ id: "nmr-agent-i", projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const sharedWt = makeWorktree("shared");
  writeFile(path.join(sharedWt, "node_modules", "x", "i.js"), "x");
  seedSession(db, { id: "nmr-s-pred", projectId: projId, agentId: "nmr-agent-i", worktreePath: sharedWt, processState: "exited", resumability: "dead", lastActivity: iso(72 * HOUR), taskId: "task-shared" });
  seedSession(db, { id: "nmr-s-succ", projectId: projId, agentId: "nmr-agent-i", worktreePath: sharedWt, processState: "running", resumability: "resumable", lastActivity: iso(1 * HOUR), taskId: "task-shared" });

  const sessions = new SessionService(db, {}, new OrchestrationControl());
  const { entries } = await sessions.listNodeModulesReclaimCandidates(24);
  check("(i) a recycle-chain worktree with a LIVE successor row is excluded, despite an old exited predecessor row", !entries.some((e) => e.worktreePath === sharedWt));

  db.close();
  fs.rmSync(sharedWt, { recursive: true, force: true });
}

// (j) end-to-end reclaimNodeModules: removes the eligible candidate, aggregates measured bytes, and
//     leaves an ineligible (live) one untouched.
// (k) worktreePaths narrowing: only the explicitly named path is touched even though more candidates exist.
// (l) noLongerEligible: an explicitly-requested path that is NOT currently eligible (still live) is
//     reported, never acted on.
{
  const db = new Db();
  const projId = "nmr-proj-j";
  seedProject(db, projId, "NMR Project J");
  db.insertAgent({ id: "nmr-agent-j", projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const wtA = makeWorktree("j-a");
  writeFile(path.join(wtA, "node_modules", "pkg", "i.js"), "a".repeat(123));
  seedSession(db, { id: "nmr-s-ja", projectId: projId, agentId: "nmr-agent-j", worktreePath: wtA, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-ja" });

  const wtB = makeWorktree("j-b");
  writeFile(path.join(wtB, "node_modules", "pkg", "i.js"), "b".repeat(456));
  seedSession(db, { id: "nmr-s-jb", projectId: projId, agentId: "nmr-agent-j", worktreePath: wtB, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-jb" });

  const wtLive = makeWorktree("j-live");
  writeFile(path.join(wtLive, "node_modules", "pkg", "i.js"), "c".repeat(999));
  seedSession(db, { id: "nmr-s-jlive", projectId: projId, agentId: "nmr-agent-j", worktreePath: wtLive, processState: "running", resumability: "resumable", lastActivity: iso(1 * HOUR), taskId: "task-jlive" });

  const sessions = new SessionService(db, {}, new OrchestrationControl());

  // (k) narrowed to wtA only — wtB stays untouched despite being equally eligible.
  const narrowed = await sessions.reclaimNodeModules({ minAgeHours: 24, worktreePaths: [wtA] });
  check("(k) narrowed reclaim touches only the requested path — candidatesConsidered:1", narrowed.candidatesConsidered === 1);
  check("(k) wtA's node_modules is gone", !fs.existsSync(path.join(wtA, "node_modules")));
  check("(k) wtB's node_modules is UNTOUCHED (not in the requested set)", fs.existsSync(path.join(wtB, "node_modules")));
  check("(k) removed:1, bytesReclaimed:123 (measured, not estimated)", narrowed.removed === 1 && narrowed.bytesReclaimed === 123);

  // (l) requesting the live worktree explicitly — it's not in the fresh candidate set, so it's reported
  //     noLongerEligible and never touched.
  const liveAttempt = await sessions.reclaimNodeModules({ minAgeHours: 24, worktreePaths: [wtLive] });
  check("(l) requesting a currently-LIVE worktree reclaims nothing", liveAttempt.removed === 0);
  check("(l) it's reported as noLongerEligible:1", liveAttempt.noLongerEligible === 1);
  check("(l) the live worktree's node_modules is untouched", fs.existsSync(path.join(wtLive, "node_modules")));

  // (j) unscoped reclaim now picks up wtB (the one remaining eligible candidate).
  const full = await sessions.reclaimNodeModules({ minAgeHours: 24 });
  check("(j) unscoped reclaim removes the remaining eligible candidate (wtB)", full.removed === 1 && full.bytesReclaimed === 456);
  check("(j) wtB's node_modules is now gone", !fs.existsSync(path.join(wtB, "node_modules")));
  const wtBResult = full.results.find((r) => r.worktreePath === wtB);
  check("(j) the per-entry result names the right project/task", wtBResult && wtBResult.projectId === projId && wtBResult.taskId === "task-jb" && wtBResult.outcome === "removed");

  db.close();
  for (const wt of [wtA, wtB, wtLive]) fs.rmSync(wt, { recursive: true, force: true });
}

// (m) reclaimNodeModules routes a wedged removal through SessionService's OWN removeDirOverride seam
//     (the same seam whole-worktree removal already uses) — a hang is reported, never retried, and the
//     other candidate in the same run is unaffected.
{
  const db = new Db();
  const projId = "nmr-proj-m";
  seedProject(db, projId, "NMR Project M");
  db.insertAgent({ id: "nmr-agent-m", projectId: projId, name: "t", startupPrompt: "", position: 0 });

  const wtWedge = makeWorktree("m-wedge");
  writeFile(path.join(wtWedge, "node_modules", "pkg", "i.js"), "w".repeat(50));
  seedSession(db, { id: "nmr-s-mwedge", projectId: projId, agentId: "nmr-agent-m", worktreePath: wtWedge, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-mwedge" });

  const wtOk = makeWorktree("m-ok");
  writeFile(path.join(wtOk, "node_modules", "pkg", "i.js"), "o".repeat(75));
  seedSession(db, { id: "nmr-s-mok", projectId: projId, agentId: "nmr-agent-m", worktreePath: wtOk, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-mok" });

  let removeDirCalls = 0;
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => {
      removeDirCalls++;
      if (target === path.join(wtWedge, "node_modules")) return { removed: false, killed: true }; // wedged
      return killableRemoveDir(target, ms); // real removal for everything else
    },
  });

  const result = await sessions.reclaimNodeModules({ minAgeHours: 24 });
  check("(m) both candidates were attempted", removeDirCalls === 2);
  check("(m) the wedged one is reported wedged:1, not removed", result.wedged === 1);
  check("(m) the wedged worktree's node_modules is STILL on disk", fs.existsSync(path.join(wtWedge, "node_modules")));
  check("(m) the OTHER candidate still succeeded (removed:1) — one wedge doesn't block the rest of the run", result.removed === 1 && fs.existsSync(path.join(wtWedge, "node_modules")) && !fs.existsSync(path.join(wtOk, "node_modules")));
  check("(m) bytesReclaimed only counts the actually-removed one", result.bytesReclaimed === 75);

  db.close();
  for (const wt of [wtWedge, wtOk]) fs.rmSync(wt, { recursive: true, force: true });
}

// (n) card 3640abf5 — THE BATCH-CONTINUATION CASE: a candidate in the MIDDLE of reclaimNodeModules's
//     batch whose removeDir call REJECTS must be reported as rejected:1 (never abort the whole batch),
//     and the candidates both BEFORE and AFTER it in iteration order must still be attempted and
//     succeed. Before this card's fix, a rejection here would throw out of the for-loop in
//     SessionService.reclaimNodeModules, losing every already-accumulated result and leaving every
//     later candidate (wtAfter below) completely untouched and unreported.
{
  const db = new Db();
  const projId = "nmr-proj-n";
  seedProject(db, projId, "NMR Project N");
  db.insertAgent({ id: "nmr-agent-n", projectId: projId, name: "t", startupPrompt: "", position: 0 });

  // Named/seeded in the exact order they must be ITERATED in (listNodeModulesReclaimCandidates has no
  // sort of its own beyond insertion/Map-iteration order) so "middle" is actually the middle of the batch.
  const wtBefore = makeWorktree("n-before");
  writeFile(path.join(wtBefore, "node_modules", "pkg", "i.js"), "x".repeat(10));
  seedSession(db, { id: "nmr-s-nbefore", projectId: projId, agentId: "nmr-agent-n", worktreePath: wtBefore, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-nbefore" });

  const wtRejected = makeWorktree("n-rejected");
  writeFile(path.join(wtRejected, "node_modules", "pkg", "i.js"), "y".repeat(20));
  seedSession(db, { id: "nmr-s-nrejected", projectId: projId, agentId: "nmr-agent-n", worktreePath: wtRejected, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-nrejected" });

  const wtAfter = makeWorktree("n-after");
  writeFile(path.join(wtAfter, "node_modules", "pkg", "i.js"), "z".repeat(30));
  seedSession(db, { id: "nmr-s-nafter", projectId: projId, agentId: "nmr-agent-n", worktreePath: wtAfter, processState: "exited", resumability: "dead", lastActivity: iso(48 * HOUR), taskId: "task-nafter" });

  let removeDirCalls = 0;
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => {
      removeDirCalls++;
      if (target === path.join(wtRejected, "node_modules")) throw new Error("ENOENT: spawn rmdir ENOENT (synthetic, n-test)");
      return killableRemoveDir(target, ms); // real removal for the other two
    },
  });

  const result = await sessions.reclaimNodeModules({ minAgeHours: 24 });
  check("(n) all THREE candidates were attempted — the rejection did not abort the batch", removeDirCalls === 3);
  check("(n) the rejected one is reported rejected:1", result.rejected === 1);
  check("(n) candidatesConsidered still counts all three", result.candidatesConsidered === 3);
  check("(n) the BEFORE candidate (iterated ahead of the rejection) succeeded", !fs.existsSync(path.join(wtBefore, "node_modules")));
  check("(n) THE CASE THIS TEST EXISTS FOR: the AFTER candidate (iterated past the rejection) ALSO succeeded — proving the loop continued", !fs.existsSync(path.join(wtAfter, "node_modules")));
  check("(n) the rejected worktree's node_modules is STILL on disk (never even started)", fs.existsSync(path.join(wtRejected, "node_modules")));
  check("(n) removed:2 (before + after), bytesReclaimed sums only those two", result.removed === 2 && result.bytesReclaimed === 10 + 30);
  const rejectedRow = result.results.find((r) => r.worktreePath === wtRejected);
  check("(n) the per-entry result row carries outcome:'rejected' with the real rejectionMessage", rejectedRow && rejectedRow.outcome === "rejected" && rejectedRow.rejectionMessage === "ENOENT: spawn rmdir ENOENT (synthetic, n-test)");
  check("(n) NEGATIVE CONTROL: the rejected row's bytesReclaimed is null, never a measured quantity", rejectedRow && rejectedRow.bytesReclaimed === null);

  db.close();
  for (const wt of [wtBefore, wtRejected, wtAfter]) fs.rmSync(wt, { recursive: true, force: true });
}

fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — node_modules reclaim measures real bytes, removes only node_modules (git/tracked state byte-identical), never retries a genuinely wedged removal, classifies a rejected (never-started) removeDir call distinctly from a wedged one and never lets it abort the batch, and SessionService's candidate list/reclaim correctly excludes live sessions, too-fresh worktrees, and re-derives eligibility fresh at reclaim time rather than trusting a caller-supplied list."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
