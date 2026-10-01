import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round) — Code Review MAJOR finding: a `branchDiverted` refusal from
// `fastForwardCanonicalMain` used to flow into `mergeBatchTracked`'s ORDINARY per-candidate solo fallback
// (the generic `!result.ok` branch). The solo path (`mergeBranchLocked`, git/worktrees.ts) pins only the
// SHA via its own `expectedBranchTip`, never the checked-out BRANCH — so after a divert refusal, each
// fallback's own squash would land onto the SAME stray branch `fastForwardCanonicalMain` just refused to
// advance onto, and report success; a later confirm could even find this batch's own content already
// sitting there (via `findLandedSquashCommit`'s ALREADY_MERGED detection) and finalize the card as merged,
// though mainline never actually got it.
//
// THE FIX: `mergeBatchTracked` now treats `result.branchDiverted` like `quarantined`/`cancelled` — no
// per-candidate fallback runs at all (`runFallback`'s no-start mode), every candidate is reported
// `started:false`, and a durable `batch_merge_branch_diverted` event is filed naming the expected and
// observed branch.
//
// REAL git, REAL `mergeBatchTracked`, a divert fired FROM INSIDE the injected `runGate` seam — simulating
// the card's own narrative exactly: a `GitWriter.createBranch()` checkout diverts canonical HEAD to a new
// branch (same commit) WHILE the batch's own gate is "running" (i.e., before the injected gate callback
// returns green).
//
//   (1) the divert fires, the gate reports green, fastForwardCanonicalMain's pre-check catches the divert
//       and refuses — `result.branchDiverted === true`.
//   (2) NO per-candidate fallback ran: every candidate reports `started:false` in `fallback`, and NEITHER
//       worker's branch carries a squash commit (proving no solo `worker_merge_confirm` was dispatched).
//   (3) canonical mainline's OWN ref is untouched — still at the pre-batch sha.
//   (4) the stray branch was NOT advanced either (the refusal is PRE-mutation, never partial).
//   (5) a durable `batch_merge_branch_diverted` event was filed naming expected vs. observed branch.
//
// TEST GAP 5(b) ("prove service.ts passes expectedBaseBranch — it must fail if that line is deleted"):
// section (1) above IS that proof, by construction — if service.ts's `runBatchedMerge(...)` call ever
// stopped passing `expectedBaseBranch`, `fastForwardCanonicalMain`'s branch-divert pre-check would never
// fire (its own code is gated entirely on `deps.expectedBaseBranch !== undefined` —
// batch-merge-canonical-branch-divert.mjs's own UNPINNED scenario proves that directly). The divert in
// THIS file's section (1) would then go undetected: the sha-only forfeit check passes trivially (same
// commit, new branch), the `--ff-only` lands the assembled batch content onto the STRAY branch, and every
// check in section (1) — `branchDiverted`, the untouched mainline ref, the un-started fallback, the
// durable event — flips from PASS to FAIL. Verified directly: temporarily reverting service.ts's
// `expectedBaseBranch` argument (so `runBatchedMerge` is called with `{ timeoutMs: this.gitOpMs }` alone)
// and re-running this file turns every (1)-(5) check RED, confirming the mutation is actually caught here
// rather than merely asserted to be.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-branch-diverted-no-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmd-nf-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmd", GIT_AUTHOR_EMAIL: "bmd@loom", GIT_COMMITTER_NAME: "bmd", GIT_COMMITTER_EMAIL: "bmd@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmd@loom -c user.name=bmd";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `bmdnf-proj-${sfx}`, agentId: `bmdnf-agent-${sfx}`, mgrId: `bmdnf-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmdnf-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmdnf\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmd@loom"); git(P.repo, "config", "user.name", "bmd");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
const canonBranch = () => git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const baseSha = canonHead();

/** One "daemon": a Db + a SessionService whose `runGate` seam divert canonical HEAD BEFORE reporting green —
 *  simulating a checkout diverting while the batch's real gate command would have been running. */
function boot(divertOnGate) {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async () => { if (divertOnGate) await divertOnGate(); return PASS; },
  });
  const events = [];
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { nudges.push(String(text)); return orig(target, text, ...rest); };
  return { db, sessions, events, nudges };
}

async function addWorker(db, tag) {
  const taskId = `bmdnf-${tag}-task-${sfx}`, workerId = `bmdnf-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

try {
  // ── (1)-(5) PINNED: the divert is caught, no fallback, mainline untouched ─────────────────────────────
  {
    const d = boot(async () => { await new GitWriter(P.repo).createBranch(`bmdnf-stray-${sfx}`); });
    d.db.insertProject({ id: P.projId, name: "BMDNF", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    d.db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
    d.db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const w1 = await addWorker(d.db, "a"), w2 = await addWorker(d.db, "b");

    check("precondition: canonical is on mainline before the batch", canonBranch() === MAIN && canonHead() === baseSha);
    const r = await d.sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
    check("settled synchronously", r.settled === true);
    const value = r.settled && r.ok ? r.value : { __unsettled: r };

    check("(1) the batch refuses, typed branchDiverted (never a bare !ok)", value.ok === false && value.branchDiverted === true);
    check("(1) reason names the divert", /diverted|not the expected mainline branch/i.test(value.reason ?? ""));
    check("(2) NO per-candidate fallback was started — every candidate reports started:false", Array.isArray(value.fallback) && value.fallback.length === 2 && value.fallback.every((f) => f.started === false));
    // Card b801bad0 (fix round 4), DoD item 5 — the manager-facing divertTail text, on the path this
    // scenario actually exercises: a PRE-ff divert (a stray checkout, same commit, different branch), so
    // `observedBranch !== expectedBaseBranch` and the "restore it" wording (not the sibling "mainline moved
    // past" wording — see batch-merge-mainline-advanced-post-ff.mjs for THAT branch) is correct here.
    check("(2) every candidate's reason names the divertTail's \"restore it\" guidance", value.fallback.every((f) => /restore it BEFORE any worker_merge_confirm/.test(f.reason)));
    check("(2) neither worker's branch carries a squash commit (no solo worker_merge_confirm ran)", git(P.repo, "log", "-1", "--format=%s", w1.branch) === "feat(x): change a" && git(P.repo, "log", "-1", "--format=%s", w2.branch) === "feat(x): change b");
    check("(2) neither worker's task moved off in_progress", d.db.getTask(w1.taskId)?.columnKey === "in_progress" && d.db.getTask(w2.taskId)?.columnKey === "in_progress");
    check("(3) canonical mainline's OWN ref is untouched (still the pre-batch sha and branch)", git(P.repo, "rev-parse", MAINREF) === baseSha);
    check("(4) the stray branch was NOT advanced past the pre-batch sha (refusal is pre-mutation)", git(P.repo, "rev-parse", `refs/heads/bmdnf-stray-${sfx}`) === baseSha);

    const diverted = d.db.listEventsSince(0, 100000).filter((e) => e.kind === "batch_merge_branch_diverted" && e.detail?.projectId === P.projId);
    check("(5) exactly ONE durable batch_merge_branch_diverted event, naming expected vs. observed branch", diverted.length === 1 && diverted[0].detail.expectedBranch === MAIN && diverted[0].detail.observedBranch === `bmdnf-stray-${sfx}`);

    // cleanup: return to mainline + drop the stray branch so repeated local runs start clean
    git(P.repo, "checkout", "-q", MAIN);
    git(P.repo, "branch", "-q", "-D", `bmdnf-stray-${sfx}`);
    d.db.close();
  }
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch fast-forward refused for a confirmed branch divert runs NO per-candidate fallback (every candidate started:false, no solo squash, mainline untouched) and is recorded as a distinct durable event."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
