import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round 3) — REVERTED: a prior round of this fix (Code Review MINOR 4) made the branch
// half of the batch fast-forward's pin (`expectedBaseBranch`) prefer the STORED mainline watermark over a
// LIVE read of canonical HEAD taken at batch-cut time (sessions/service.ts ~17268). That caught a divert
// that PREDATED the batch's own dispatch — but it also made the pin vulnerable to a separate, pre-existing
// quirk: `checkMainlineMove` (sessions/service.ts) re-stamps the watermark to WHATEVER branch is currently
// checked out on any branch CHANGE, silently, on "first sight" of that branch — including the very stray
// branch a batch's own divert refusal just correctly caught, since that check runs mid-batch (after the
// gate closure, before the fast-forward) while canonical is still diverted. A watermark-preferred pin
// therefore lasts exactly ONE batch: the NEXT batch's cut reads the now-corrupted watermark and either
// spuriously refuses (canonical is actually back on mainline, the stale pin still says stray) or
// fast-forwards onto the stray branch (canonical is still diverted, the stale pin now agrees with it).
//
// THIS FILE NOW PROVES THE REVERT, not the watermark-preferring behavior it used to prove:
//
//   (W1) the stored watermark has NO bearing on the pin any more — corrupt it to a branch that doesn't even
//        exist, confirm an ordinary (non-diverted) batch still lands normally (the pin comes from the LIVE
//        read alone, never consulting the stale/corrupted watermark).
//   (P1) a divert BEFORE the batch is even dispatched (no divert during the gate itself) is — by design of
//        this revert — NOT caught: the live read at cut time captures the STRAY branch as "expected", so
//        the pre-check agrees with itself and the batch proceeds, landing onto the stray branch rather than
//        mainline. This is the exact self-defeating case the watermark-preferred pin existed to catch, and
//        reintroducing it is the deliberate, accepted cost of this revert — closing it properly is owned by
//        card 2a6a292a (stop checkMainlineMove's silent re-stamp first), not by restoring the preference.
//   (P2) control: a divert DURING the gate run (after cut, before the fast-forward) is UNAFFECTED by this
//        revert and is still caught — the live read at cut time pins the real branch, and the fast-forward
//        later finds canonical checked out elsewhere. (Already covered end-to-end by
//        batch-merge-branch-diverted-no-fallback.mjs; this is a brief confirming control, not a duplicate.)
//   (P3) no live branch available (canonical HEAD is DETACHED) — neither the live read nor (now) any
//        watermark fallback exists: this is LOGGED (not silently degraded), and the batch still proceeds
//        WITHOUT a branch-divert check (the sha-only forfeit check alone still applies).
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-watermark-branch-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmwp-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmwp", GIT_AUTHOR_EMAIL: "bmwp@loom", GIT_COMMITTER_NAME: "bmwp", GIT_COMMITTER_EMAIL: "bmwp@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmwp@loom -c user.name=bmwp";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `bmwp-proj-${sfx}`, agentId: `bmwp-agent-${sfx}`, mgrId: `bmwp-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmwp-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmwp\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmwp@loom"); git(P.repo, "config", "user.name", "bmwp");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const canonBranch = () => { try { return git(P.repo, "symbolic-ref", "--short", "HEAD"); } catch { return null; } };

const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
db.insertProject({ id: P.projId, name: "BMWP", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const KEY = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); realWarn(...a); };

let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `bmwp-${n}-task-${sfx}`, workerId = `bmwp-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const batch = async (ws) => { const r = await sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };

try {
  // ── seed the watermark with a real, ordinary first landing (branch = MAIN) ─────────────────────────────
  const seed1 = await addWorker("seed"), seed2 = await addWorker("seed");
  const seedResult = await batch([seed1, seed2]);
  check("seed: the first batch lands normally", seedResult.ok === true && seedResult.landed?.length === 2);
  check("seed: the watermark is now stored at branch MAIN", watermark()?.branch === MAIN);

  // ── (W1) the stored watermark is IGNORED for the pin: corrupt it to a branch that doesn't exist ─────────
  const bogusBranch = `bmwp-bogus-watermark-branch-${sfx}`;
  db.setMeta(KEY, JSON.stringify({ branch: bogusBranch, sha: canonHead() }));
  check("(W1) precondition: canonical is genuinely on MAIN (no divert in effect)", canonBranch() === MAIN);
  const w1a = await addWorker("w1a"), w1b = await addWorker("w1b");
  const rw1 = await batch([w1a, w1b]);
  check("(W1) a corrupted/stale stored watermark does NOT cause a spurious branchDiverted refusal — the pin comes from the LIVE read, never the watermark", rw1.ok === true && rw1.landed?.length === 2 && rw1.branchDiverted === undefined);
  // Restore a sane watermark for the rest of this file (the batch above already re-advanced it to MAIN via
  // checkMainlineMove's own self-correction, but make that explicit rather than relying on it).
  check("(W1) the watermark self-corrected back to MAIN despite the corruption (checkMainlineMove's own, separate mechanism)", watermark()?.branch === MAIN);

  // ── (P1) divert BEFORE dispatching the next batch — no divert during the gate this time ────────────────
  // By design of this revert, this is the SELF-DEFEATING case: the live read at cut time captures the
  // ALREADY-diverted stray branch as "expected", so the pre-check agrees with itself and the batch proceeds
  // — landing its content onto the stray branch instead of refusing. Accepted regression; see this file's
  // own header.
  const preCutSha = canonHead();
  const strayBranch = `bmwp-stray-${sfx}`;
  git(P.repo, "checkout", "-q", "-b", strayBranch); // same-commit divert, entirely before the batch call
  check("(P1) precondition: canonical is on the stray branch BEFORE the batch is even dispatched", canonBranch() === strayBranch && canonHead() === preCutSha);

  const w1 = await addWorker("p1a"), w2 = await addWorker("p1b");
  const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
  check("(P1) the batch does NOT refuse — the live-read-only pin agrees with the already-diverted checkout", v1.ok === true && v1.landed?.length === 2 && v1.branchDiverted === undefined);
  check("(P1) mainline's own ref was NOT advanced — the content landed on the stray branch instead", git(P.repo, "rev-parse", MAINREF) === preCutSha);
  check("(P1) the stray branch WAS advanced (this is the accepted, reverted-to-pre-MINOR-4 behavior)", git(P.repo, "rev-parse", `refs/heads/${strayBranch}`) !== preCutSha);

  // ── (P2) control: a divert DURING the gate (after cut, before the fast-forward) is unaffected by this
  //         revert and is still caught — confirming the pin itself still works, just not for a pre-existing
  //         divert. (Full no-fallback/event coverage lives in batch-merge-branch-diverted-no-fallback.mjs.) ─
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch);
  const preCutSha2 = canonHead();
  const strayBranch2 = `bmwp-stray2-${sfx}`;
  let divertedDuringGate = false;
  const sessions2 = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { if (!divertedDuringGate) { git(P.repo, "checkout", "-q", "-b", strayBranch2); divertedDuringGate = true; } return PASS; },
  });
  const w3 = await addWorker("p2a"), w4 = await addWorker("p2b");
  const r2 = await sessions2.mergeBatchTracked(P.mgrId, [w3.workerId, w4.workerId]);
  const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };
  check("(P2) a divert DURING the gate run is still caught: branchDiverted", v2.ok === false && v2.branchDiverted === true);
  check("(P2) mainline's own ref is untouched", git(P.repo, "rev-parse", MAINREF) === preCutSha2);
  check("(P2) the stray branch was NOT advanced (refused pre-mutation)", git(P.repo, "rev-parse", `refs/heads/${strayBranch2}`) === preCutSha2);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayBranch2);
} finally {
  try { db.close(); } catch { /* already closed */ }
}

// ── (P3) a FRESH project (no watermark) + a DETACHED canonical HEAD — no pin source is available ─────────
{
  const P3 = { projId: `bmwp3-proj-${sfx}`, agentId: `bmwp3-agent-${sfx}`, mgrId: `bmwp3-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmwp3-repo-${sfx}`) };
  fs.mkdirSync(P3.repo, { recursive: true }); registerForCleanup(P3.repo);
  fs.writeFileSync(path.join(P3.repo, "README.md"), "# bmwp3\n");
  git(P3.repo, "init", "-q"); git(P3.repo, "config", "core.autocrlf", "false"); git(P3.repo, "config", "user.email", "bmwp@loom"); git(P3.repo, "config", "user.name", "bmwp");
  commitAll(P3.repo, "init", GIT_ID);
  const main3 = git(P3.repo, "rev-parse", "--abbrev-ref", "HEAD");
  git(P3.repo, "checkout", "-q", "--detach", "HEAD");
  check("(P3) precondition: canonical HEAD is genuinely detached", canonBranchOf(P3.repo) === null);

  const db3 = new Db();
  const sessions3 = new SessionService(db3, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  db3.insertProject({ id: P3.projId, name: "BMWP3", repoPath: P3.repo, vaultPath: P3.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db3.insertAgent({ id: P3.agentId, projectId: P3.projId, name: "t", startupPrompt: "", position: 0 });
  db3.insertSession({ id: P3.mgrId, projectId: P3.projId, agentId: P3.agentId, engineSessionId: null, title: null, cwd: P3.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  async function addWorker3(tag) {
    const n = `${tag}${++seq}`;
    const taskId = `bmwp3-${n}-task-${sfx}`, workerId = `bmwp3-${n}-wkr-${sfx}`;
    db3.insertTask({ id: taskId, projectId: P3.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(P3.repo, P3.projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
    commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
    db3.insertSession({ id: workerId, projectId: P3.projId, agentId: P3.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P3.mgrId, taskId, worktreePath, branch });
    return { taskId, workerId, worktreePath, branch };
  }

  try {
    const warnedBefore = warned.length;
    const w1 = await addWorker3("p3a"), w2 = await addWorker3("p3b");
    const r3 = await sessions3.mergeBatchTracked(P3.mgrId, [w1.workerId, w2.workerId]);
    const v3 = r3.settled && r3.ok ? r3.value : { __unsettled: r3 };
    check("(P3) no live branch (detached HEAD): this is LOGGED (not silent)", warned.slice(warnedBefore).some((w) => /no mainline branch available to pin/.test(w)));
    // No branch pin at all ⇒ fastForwardCanonicalMain's branch-divert check never runs (same as the
    // pre-card, unpinned behavior) — only the sha-only forfeit check applies, and nothing diverted here, so
    // the batch lands normally (never reads `branchDiverted` at all).
    check("(P3) with no pin available, the batch still proceeds (sha-only forfeit check alone) and lands", v3.ok === true && v3.landed?.length === 2 && v3.branchDiverted === undefined);
  } finally {
    try { db3.close(); } catch { /* already closed */ }
  }
}

function canonBranchOf(repo) { try { return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }

console.warn = realWarn;
console.log(failures === 0
  ? "\n✅ ALL PASS — the batch's branch-divert pin now comes from a LIVE read alone (the stored mainline watermark is never consulted, so a stale/corrupted watermark cannot cause a spurious refusal or a wrong-branch landing), still catches a divert that happens DURING a batch's own gate run, accepts the reintroduced self-defeating case for a divert that PREDATES dispatch, and logs (never silently degrades) when no live branch is available."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
