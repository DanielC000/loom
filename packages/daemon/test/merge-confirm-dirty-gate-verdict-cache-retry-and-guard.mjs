import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SPLIT (card 975c774b, after a SIGTERM at the 120s per-file ceiling): this file carries scenarios (E)-(G); (A)-(D) live in
// merge-confirm-dirty-gate-verdict-cache.mjs. Every assertion was kept (40 PASS in the one file before; see the totals in the card report).
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

// ── (E) RETRY LINKS after dirt at settle (Code Review minors 1+2 on bc2f718a) ────────────────────────────
const KILL = { passed: false, failedStep: "test", failedStatus: null, failedSignal: "SIGKILL", steps: [] };
// Runs `fn` SYNCHRONOUSLY inside the first append of an event of `kind` (before the append returns to the daemon, hence before the next
// chain link can start): deterministic ordering with no polling and no floating promise that could reject later.
const onEvent = (db, kind, fn) => { const orig = db.appendEvent.bind(db); let fired = false; db.appendEvent = (ev) => { const r = orig(ev); if (!fired && ev.kind === kind) { fired = true; fn(); } return r; }; };
const genuineFail = { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1, failTierTest: "FAIL  flaky-one", failTierTestCount: 1, failTierAll: ["FAIL  flaky-one"] };
{
  // (E1) transient link, dirt PERSISTS: the retry's pre-check throws. It must stay a during-gate outcome that keeps attempt 1's
  // kill classification and its build_gate row, never a before-gate refusal that erases a gate that really ran.
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfxOf("tr-dirty"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => { gateCalls++; fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n"); return KILL; },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  const v = r1.ok ? r1.value : {};
  check("(E1) op 1 refused with gateWorktreeDirty phase during-gate (not before-gate)", v.merged === false && v.gateWorktreeDirty?.phase === "during-gate");
  check("(E1) the kill classification survived (reason names SIGKILL)", /killed by SIGKILL/.test(v.reason ?? ""));
  check("(E1) attempt 1's build_gate row was written (a gate that really ran leaves a gate_history row)", db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.passed === false && e.detail?.gateSpawned === true));
  check("(E1) the retry never spawned a second gate", gateCalls === 1);
  check("(E1) the rejection does NOT claim a retry ran, and says the retry did not run because the tree was dirty", !/retried once/.test(v.reason ?? "") && /retry not run: the worktree was dirty/.test(v.reason ?? ""));
  check("(E1) the merge_rejected row records retried:false + retryNotRun (no build_gate_retry row exists to contradict it)", (() => { const ev = db.listEvents(mgrId).find((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate"); return ev?.detail?.retried === false && ev?.detail?.retryNotRun === "worktree-dirty" && !db.listEvents(mgrId).some((e) => e.kind === "build_gate_retry"); })());
  check("(E1) no before-gate refusal event was filed", !db.listEvents(mgrId).some((e) => e.kind === "merge_rejected" && e.detail?.phase === "before-gate"));
  fs.rmSync(path.join(worktreePath, "dirty.flag"), { force: true });
}
{
  // (E2) transient link on a tree that is CLEAN again: attempt 1's dirt must not taint the retry's own clean pass.
  const { db, mgrId, workerId, repo, worktreePath } = await setupWorkerProject(sfxOf("tr-clean"));
  onEvent(db, "build_gate_retry_attempt", () => fs.rmSync(path.join(worktreePath, "dirty.flag"), { force: true })); // worker discards its edit inside the settle wait
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (gateCalls === 1) {
        fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n");
        // The worker discards its edit once attempt 1's verdict is recorded (observable: the retry-attempt event), inside the settle wait.
        return KILL;
      }
      return PASS;
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(E2) the transient retry ran and its clean-tree PASS merged (attempt 1's dirt did not stick)", gateCalls === 2 && r1.ok && r1.value.merged === true && r1.value.gateWorktreeDirty === undefined && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (E3) single-file link, dirt PERSISTS: same during-gate / keeps-the-verdict contract as E1.
  const { db, mgrId, workerId, worktreePath } = await setupWorkerProject(sfxOf("sf-dirty"), { plant: "flaky-one" });
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => { gateCalls++; fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n"); return genuineFail; },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  const v = r1.ok ? r1.value : {};
  check("(E3) op 1 refused during-gate (the single-file link's pre-check did not become a before-gate refusal)", v.merged === false && v.gateWorktreeDirty?.phase === "during-gate" && gateCalls === 1);
  check("(E3) attempt 1's genuine-failure headline survived", /build gate failed/.test(v.reason ?? ""));
  check("(E3) attempt 1's build_gate row was written even though the single-file link never ran", db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.passed === false && e.detail?.gateSpawned === true));
  fs.rmSync(path.join(worktreePath, "dirty.flag"), { force: true });
}
{
  // (E4) single-file link on a tree that is clean again: dirt from attempt 1 stays STICKY there (the single-file run covers one
  // file, so it cannot vouch for a tree attempt 1 saw dirty): the retry's pass is refused and nothing lands.
  const { db, mgrId, workerId, repo, worktreePath } = await setupWorkerProject(sfxOf("sf-clean"), { plant: "flaky-one" });
  onEvent(db, "build_gate_single_file_retry_attempt", () => fs.rmSync(path.join(worktreePath, "dirty.flag"), { force: true })); // cleaned BEFORE the single-file link can spawn
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (gateCalls === 1) {
        fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n");
        return genuineFail;
      }
      return PASS;
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(E4) the single-file retry ran (2 gate calls) and its pass was refused as dirty: sticky on this link", gateCalls === 2 && r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "during-gate");
  check("(E4) nothing landed on main", !fs.existsSync(path.join(repo, "feature.txt")));
}

{
  // (E5) THE RESET ORDERING: attempt 1 is a clean KILL, then the transient retry itself leaves dirt at settle and returns PASS. The flag is reset
  // BEFORE the retry spawns and set again by its settle stamp, so the pass is refused. Resetting AFTER runGateSeq would wipe that verdict and merge.
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("tr-reset-order"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => { gateCalls++; if (gateCalls === 1) return KILL; fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n"); return PASS; },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(E5) the transient retry ran and its PASS was refused: dirt at ITS settle survives the reset", gateCalls === 2 && r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "during-gate");
  check("(E5) nothing landed on main", !fs.existsSync(path.join(repo, "feature.txt")));
}

// ── (F) UNREADABLE stamp at settle fails CLOSED: a PASS whose worktree could not be read is refused ───────────
{
  const { db, mgrId, workerId, worktreePath, repo } = await setupWorkerProject(sfxOf("unreadable"));
  const gitdir = fs.readFileSync(path.join(worktreePath, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  const head = path.join(gitdir, "HEAD");
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { fs.renameSync(head, `${head}.bak`); return PASS; }, // the worktree's HEAD vanishes: the settle stamp cannot be read
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  if (fs.existsSync(`${head}.bak`)) fs.renameSync(`${head}.bak`, head);
  check("(F) control: HEAD is readable again once restored", execSync("git rev-parse HEAD", { cwd: worktreePath }).toString().trim().length === 40);
  check("(F) an unreadable settle stamp refuses the PASS (during-gate, 'unreadable') and nothing lands", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "during-gate" && /unreadable/.test(r1.value.gateWorktreeDirty?.detail ?? "") && !fs.existsSync(path.join(repo, "feature.txt")));
}

// ── (G) after a during-gate PASS refusal the per-repo guard is RELEASED: a second same-repo op is admitted ────
{
  const { db, mgrId, workerId, worktreePath, makeWorker } = await setupWorkerProject(sfxOf("guard"));
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => { gateCalls++; if (gateCalls === 1) fs.writeFileSync(path.join(cwd, "dirty.flag"), "x\n"); return PASS; },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(G) op 1's pass was refused as dirty (the gate passed, so it took the hold-on-exit path)", r1.ok && r1.value.merged === false && r1.value.gateWorktreeDirty?.phase === "during-gate");
  fs.rmSync(path.join(worktreePath, "dirty.flag"), { force: true });
  const w2 = await makeWorker("second", "second.txt");
  const r2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, w2.workerId), { label: "confirmWorkerMergeTracked (second same-repo op)" });
  check("(G) a second same-repo merge is ADMITTED and lands: the refused op did not leak the repo guard", r2.settled === true && r2.ok === true && r2.value.merged === true);
}

for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
