import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT (card 975c774b, after a SIGTERM at the 120s per-file ceiling): this file carries scenarios (A)-(D); (E)-(G) live in
// merge-confirm-dirty-gate-verdict-cache-retry-and-guard.mjs. Every assertion was kept (40 PASS in the one file before; see the totals in the card report).
// Card 975c774b — a merge-confirm verdict produced while the worker's worktree carried UNCOMMITTED edits must
// never be cached, and a PASS produced that way must never squash. Code Reviewer's claim on 8b1fb28f: the
// verdict cache keys on the branch REF (commit), but the gate reads the WORKTREE FILES, so a live worker's
// uncommitted edit during the gate could flip the verdict, be discarded afterwards, and leave the verdict cached
// under an unchanged tip. Source reading (sessions/service.ts, confirmWorkerMerge): the gate runs IN the live
// worktree, the worker's pty stays alive across it (@decision 864e79fe), and before this card only the branch
// REF was stamped. The fix (@decision 975c774b) stamps the worktree (`computeWorktreeGateStamp`, the same dirt
// `run_gate` uses) right before each gate spawn and again at settle.
//
// The gate stub simulates the live worker: it drops an UNCOMMITTED file into the worktree, computes its verdict
// from the tree AS IT IS, and LEAVES the file in place; the test then "discards" it after the op settled.
//   (A) FAIL contaminated (verdict = fail only while poison.flag exists; the clean tip would PASS): a re-call
//       must re-gate, not replay the rejection.
//   (B) PASS contaminated (verdict = pass only while fix.flag exists; the committed tip fails alone): the pass
//       must be refused (`gate_worktree_dirty`) and nothing may land on main.
//   (C) CLEAN-tree controls: a clean pass still merges; a clean fail is still cached at the same tip (so the
//       new veto is not vacuously "never cache anything").
//   (D) already-dirty BEFORE the gate: refused up front with the same distinct reason, gate never spawned, and a
//       re-call after cleanup re-gates (the refusal is not cached).
// Each contaminated case carries a positive control (the stub, run against the clean tree, gives the OTHER
// verdict) so a RED is provably the contamination and not a broken stub.
// KNOWN LIMIT (not asserted): an edit created AND removed entirely inside the gate window is invisible to
// start/settle stamps; only running the gate against an immutable snapshot would see it (see the decision record).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-dirty-gate-verdict-cache.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcdg-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcdg-nonexistent-codex");
// Long enough that a test can observe attempt 1 settle and then clean the tree inside the retry settle wait (E2/E4).
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1500";

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcdg@loom -c user.name=mcdg";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcdg\n");
  execSync(`git init -q && git config user.email mcdg@loom && git config user.name mcdg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, { plant } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcdg-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcdg-mgr-${sfx}`, projId = `mcdg-p-${sfx}`, taskId = `mcdg-t-${sfx}`, workerId = `mcdg-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCDG", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcdg-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcdg-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcdg-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCDG-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  // A second worker on the SAME repo (own task + worktree + distinct file) — used to prove the repo guard was released.
  const makeWorker = async (tag, file) => {
    const tId = `${taskId}-${tag}`, wId = `${workerId}-${tag}`;
    db.insertTask({ id: tId, projectId: projId, title: `MCDG-TASK-${tag}`, body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const wt = await createWorktree(repo, projId, tId);
    fs.writeFileSync(path.join(wt.worktreePath, file), "work\n");
    if (plant) { // single-file-retry needs a real-looking test-daemon.mjs + the named test file inside the worktree
      fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
      fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "test"), { recursive: true });
      fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "test", `${plant}.mjs`), "// stub\n");
    }
    commitAll(wt.worktreePath, file, GIT_ID);
    db.insertSession({ id: wId, projectId: projId, agentId: `agent-mcdg-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: tId, worktreePath: wt.worktreePath, branch: wt.branch });
    return { workerId: wId, worktreePath: wt.worktreePath, branch: wt.branch };
  };
  const { workerId: _w0, worktreePath, branch } = await makeWorker("main", "feature.txt");
  return { db, mgrId, workerId: _w0, repo, worktreePath, branch, makeWorker };
}

// Hermetic seam (also used by merge-gate-reuse-admission.mjs): the real process-table reap costs seconds per op on Windows and is not what this file tests.
const openDbs = []; // every Db this file opens, closed before exit (an open handle stalls LOOM_HOME cleanup with EBUSY retries)
const noReap = async () => ({ killedPids: [] });
const PASS = { passed: true, steps: [] };
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });

// ── (A) a verdict flipped to FAIL by an uncommitted file must not be replayed from cache ─────────────────
{
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfxOf("fail"));
  let gateCalls = 0, contaminate = true;
  const verdictOf = (cwd) => (fs.existsSync(path.join(cwd, "poison.flag")) ? FAIL : PASS);
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (contaminate) fs.writeFileSync(path.join(cwd, "poison.flag"), "uncommitted\n"); // the live worker's edit, left in place
      return verdictOf(cwd);
    },
  });
  check("(A) control: stub verdict on the clean tree is PASS", verdictOf(worktreePath).passed === true);

  const r1 = await confirm(sessions, mgrId, workerId);
  check("(A) op 1 settled and was rejected by the contaminated gate", r1.settled === true && r1.ok === true && r1.value.merged === false);
  check("(A) op 1 carries the gateWorktreeDirty flag (phase during-gate) and no gatedIdentity stamp", r1.ok && r1.value.gateWorktreeDirty?.phase === "during-gate" && r1.value.gatedIdentity === undefined);
  check("(A) op 1's rejection text says the verdict is not cached", r1.ok && /NOT cached/.test(r1.value.detailText ?? ""));

  fs.rmSync(path.join(worktreePath, "poison.flag"), { force: true }); // the worker discards its edit after the gate settled
  contaminate = false;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(A) op 2 settled", r2.settled === true && r2.ok === true);
  check("(A) op 2 did NOT replay the contaminated rejection from cache (gate ran again)", gateCalls === 2);
  check("(A) op 2 is not served from cache", r2.cacheHit === undefined);
}

// ── (B) a verdict flipped to PASS by an uncommitted file must not land the committed tip ─────────────────
{
  const { db, mgrId, workerId, repo, worktreePath } = await setupWorkerProject(sfxOf("pass"));
  let gateCalls = 0, contaminate = true;
  const verdictOf = (cwd) => (fs.existsSync(path.join(cwd, "fix.flag")) ? PASS : FAIL);
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (contaminate) fs.writeFileSync(path.join(cwd, "fix.flag"), "uncommitted\n");
      return verdictOf(cwd);
    },
  });
  check("(B) control: stub verdict on the clean tree is FAIL (the committed tip does not pass on its own)", verdictOf(worktreePath).passed === false);

  const r1 = await confirm(sessions, mgrId, workerId);
  check("(B) op 1 settled", r1.settled === true && r1.ok === true);
  check("(B) op 1 refused the pass: merged:false with the distinct gateWorktreeDirty flag", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "during-gate");
  check("(B) op 1's reason names the dirty-worktree refusal", r1.ok && /worktree changed while the gate ran/.test(r1.value.reason ?? ""));
  check("(B) nothing landed on main", !fs.existsSync(path.join(repo, "feature.txt")));

  fs.rmSync(path.join(worktreePath, "fix.flag"), { force: true });
  contaminate = false;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(B) op 2 re-gated for real (refusal was not cached)", gateCalls === 2 && r2.settled === true && r2.cacheHit === undefined);
  check("(B) op 2 on the clean tree is a genuine rejection, still nothing on main", r2.ok && r2.value.merged === false && r2.value.gateWorktreeDirty === undefined && !fs.existsSync(path.join(repo, "feature.txt")));
}

// ── (C) CLEAN-tree controls: the veto must not disable normal caching or merging ─────────────────────────
{
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("cleanpass"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return PASS; } });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(C1) clean tree + passing gate merges normally (gate ran once, feature landed, no dirty flag)", gateCalls === 1 && r1.ok && r1.value.merged === true && r1.value.gateWorktreeDirty === undefined && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  const { db, mgrId, workerId } = await setupWorkerProject(sfxOf("cleanfail"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return FAIL; } });
  const r1 = await confirm(sessions, mgrId, workerId);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(C2) clean tree + failing gate: op 1 rejected without a dirty flag", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty === undefined);
  check("(C2) clean tree: the same-tip re-call is STILL served from cache (gate ran once, cacheHit set)", gateCalls === 1 && r2.cacheHit !== undefined);
}

// ── (D) already dirty BEFORE the gate: refused up front, never cached ────────────────────────────────────
{
  const { db, mgrId, workerId, worktreePath, repo } = await setupWorkerProject(sfxOf("predirty"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return PASS; } });
  fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "uncommitted before the gate\n");
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(D) op 1 refused up front with gateWorktreeDirty phase before-gate", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "before-gate");
  check("(D) it was refused at CONFIRM time, before any queue turn (detail names confirm time, not the in-lane backstop)", /at confirm time/.test(r1.ok ? (r1.value.gateWorktreeDirty?.detail ?? "") : ""));
  check("(D) the gate never spawned and nothing landed on main", gateCalls === 0 && !fs.existsSync(path.join(repo, "feature.txt")));
  fs.rmSync(path.join(worktreePath, "scratch.txt"), { force: true });
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(D) after cleanup a re-call re-gates and merges (the refusal was not cached)", gateCalls === 1 && r2.ok && r2.value.merged === true && r2.cacheHit === undefined);
}

for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
