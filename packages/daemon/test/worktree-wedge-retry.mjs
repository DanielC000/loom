import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worktree wedge-retry test (task dea6728e — the threadpool-safe redo of bd9fc808, owner-refined:
// "quarantine" must NOT mean "dangles forever"). Proves the piece that's new on top of worktrees.mjs's
// killable-removal mechanism proof: a worktree whose removal comes back KILLED (genuinely wedged, not a
// clean reject) is tracked + RETRIED on a slow cadence (every boot-reconcile pass + the background
// sweep) — NOT skipped forever — because removal is now killable, so retrying it can never leak a
// thread or stick the daemon no matter how often it's attempted. Only past a LONG give-up bound does a
// dir stop being retried (flipped to `needsHuman`, loudly surfaced). Also proves the CLEAN-reject case
// is never tracked as wedged and gets removed once its handle "releases", and the plain db wedged-set
// store (list/get/record/markNeedsHuman/clear) at the unit level.
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

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wwr-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { killableRemoveDir } = await import("../dist/git/worktrees.js");

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
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

// A plain, NOT-git-registered leftover dir (mirrors merge-finalize-resilient.mjs's busyDir) — `git
// worktree remove --force` on it fails ("not a working tree") and is swallowed, so it falls through to
// the fs backstop fully intact, letting the injected removeDir seam decide its fate deterministically (a
// REAL registered worktree would just get deleted by the git step itself, since it isn't actually busy —
// the fs backstop would never even be reached).
function leftoverDir(tag, sfx) {
  const dir = path.join(os.tmpdir(), `loom-wwr-${tag}-leftover-${sfx}`);
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
  check("(wedge) first pass counts it as an attempt (worktreesPruned), NOT gave-up", r1.worktreesPruned === 1 && r1.worktreesNeedsHuman === 0);

  // THE CORE REFINEMENT: a SECOND boot-reconcile pass RETRIES it (does NOT skip) — still wedged.
  const r2 = await sessions.reconcileOrchestrationOnBoot();
  check("(wedge) a SECOND pass RETRIES the removal (NOT skipped forever) — removeDir called again", removeDirCalls === 2);
  check("(wedge) attempts incremented to 2 on the retry", db.getWedgedWorktree(W.worktreePath)?.attempts === 2);
  check("(wedge) second pass STILL counts it as an attempt, not a skip", r2.worktreesPruned === 1 && r2.worktreesNeedsHuman === 0);

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

  for (let i = 1; i <= GIVE_UP_ATTEMPTS; i++) {
    const r = await sessions.reconcileOrchestrationOnBoot();
    check(`(give-up) attempt ${i}/${GIVE_UP_ATTEMPTS}: still retried (not yet given up)`, r.worktreesNeedsHuman === 0 && r.worktreesPruned === 1);
  }
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
  ? "\n✅ ALL PASS — a genuinely wedged worktree removal is TRACKED and RETRIED on every boot-reconcile pass (never permanently skipped) until it either succeeds (dropped from tracking, self-healing once the handle releases) or crosses a long give-up bound (flipped to needsHuman, then and only then skipped + loudly surfaced); a clean/transient reject is never tracked as wedged at all and is bounded-retried + removed inline."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
