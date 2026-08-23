import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THROWN-CONFIRM RECOVERY test (card 479f449f).
//
// THE BUG: the dead-owner eviction sweep in confirmWorkerMergeTracked is a STATIC "has the owning manager
// exited" check — it never consults how far the evicted op's own real work had progressed. Evicting a
// RUNNING op and re-minting a fresh confirmWorkerMerge can race the evicted op's own orphaned finalizeMerge
// (worktree-removal-first, per its "ORDER IS CRASH-CRITICAL" doc), which only ever runs AFTER that op's own
// squash already committed. The fresh re-mint can then throw operating on a directory its own predecessor
// just deleted — and the codebase used to report that as a flat `[loom:merge-failed]`, even though the
// branch's work may already be sitting on main. A manager reading "failed" for landed work is worse than no
// signal at all: every plausible response (re-dispatch, re-merge) risks redoing work that's already done.
//
// This file does NOT try to reproduce the exact dead-owner eviction race (merge-rest-route-tracked.mjs
// block (4) already covers that path end-to-end, at its own ~4% natural rate) — it tests the actual FIX
// directly and deterministically: confirmWorkerMerge can throw for ANY reason, at ANY point, including
// after a squash already landed (this method's own long-standing doc says so) — so the recovery wired into
// confirmWorkerMergeTracked's `run` callback must behave correctly regardless of WHY the throw happened, not
// just for this one specific race shape. A thrown exception is forced deterministically via the injectable
// `runGate` seam (an infra bug in the gate runner itself, never wrapped in a try/catch — confirms it
// propagates straight out of confirmWorkerMerge, verified by reading the source at the call site).
//
// Proves:
//   (A) RECOVERABLE: the branch's work is ALREADY on main (a real `git merge --squash` + the exact
//       `Loom-Worker-Branch:` trailer confirmWorkerMerge's own mergeBranch writes) when confirmWorkerMerge
//       throws — the recovery re-derives the truth from git and reports a REAL `merged:true`
//       (ALREADY_MERGED), pushes `[loom:already-merged]`, and NEVER a `[loom:merge-failed]`/
//       `[loom:merge-unknown]` echo for work that actually landed.
//   (B) NEGATIVE CONTROL — genuinely unknown: the SAME thrown error, but the branch's work is NOT anywhere
//       on main — the recovery correctly finds nothing, rethrows, and the manager gets an honest
//       `[loom:merge-unknown]` nudge (never silently swallowed, and — the DoD's own words — NEVER
//       `[loom:merge-failed]`, since a thrown exception can never prove the merge genuinely failed).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-thrown-error-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mtr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME); // this file has NO finally/cleanup block at all — nothing else removes this

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mtr@loom -c user.name=mtr";
const git = (cwd, args) => execSync(`git ${GIT_ID} ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Onward completion nudges (the [loom:merge-unknown]/[loom:already-merged] text this file asserts on) only
// ever push from confirmWorkerMergeTracked's onSettledAfterPending callback — which per PendingOpRegistry's
// own contract fires ONLY for an op that was actually surfaced `{settled:false}` to some caller first (a
// caller that observes the outcome inline within its own sync-wait budget already has it — no push needed).
// A tiny syncAttachBudgetMs + a runGate that outlives it forces every op in this file down that real async
// path — the SAME shape the card's own dead-owner race takes (deep in a retry loop, well past the sync
// budget) — rather than the fast/inline path, which no completion nudge exists to assert on at all.
const TEST_SYNC_BUDGET_MS = 100;
const SLOW_THROW_MS = 400;

function makePtyStub() {
  const calls = [];
  return {
    calls,
    stop() {}, isAlive() { return false; }, getPid() { return undefined; },
    enqueueStdin(sessionId, text) { calls.push({ sessionId, text }); return { delivered: true }; },
  };
}

async function setup(sfx, { preLand } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mtr-repo-${sfx}`);
  registerForCleanup(reposDir); // this file has NO finally/cleanup block at all — nothing else removes this
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mtr\n");
  execSync(`git init -q && git config user.email mtr@loom && git config user.name mtr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  const db = new Db();
  const mgrId = `mtr-mgr-${sfx}`, projId = `mtr-p-${sfx}`, taskId = `mtr-t-${sfx}`, workerId = `mtr-w-${sfx}`;
  const config = { orchestration: { gateCommand: "pnpm gate" } };
  db.insertProject({ id: projId, name: "MTR", repoPath: repo, vaultPath: repo, config, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mtr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mtr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mtr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MTR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mtr-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

  if (preLand) {
    // Mirrors mergeBranch's OWN squash + trailer exactly (worktrees.ts's mergeBranchLocked) — a REAL
    // `git merge --squash` so branchContentLandedInCommit's content check (findLandedSquashCommit's
    // proof-not-just-trailer step) genuinely passes, the same way a real predecessor's landed squash would.
    execSync(`git merge --squash ${branch}`, { cwd: repo });
    // Single-line message (deliberately, not two lines separated by a real blank line): findLandedSquashCommit's
    // `-F` fixed-string --grep only needs the exact trailer text present as a SUBSTRING anywhere in the
    // message body — it doesn't require real newlines — and a single line sidesteps any cross-shell
    // newline-escaping ambiguity in how execSync passes this arg through cmd.exe on Windows.
    execSync(`git ${GIT_ID} commit -q -m "feat: MTR-TASK -- Loom-Worker-Branch: ${branch}"`, { cwd: repo });
  }

  return { db, repo, mgrId, projId, taskId, workerId, branch, worktreePath };
}

// ── (A) RECOVERABLE: confirmWorkerMerge throws, but the branch's work is ALREADY on main ──────────────
{
  const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setup(sfx, { preLand: true });
  const headBefore = git(repo, "rev-parse HEAD");
  const pty = makePtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(A) degrades to pending past the tiny sync budget (forces the real async completion-nudge path)", pending.settled === false);
  // waitBriefly, NOT a nudge-text poll: the recovery path's [loom:already-merged] push fires from INSIDE
  // finishAlreadyMerged, partway through its own body (before its pty.stop/finalizeMerge tail) — well
  // BEFORE the op itself genuinely settles in the registry. Waiting on the nudge text alone raced that
  // tail (observed directly: a second confirmWorkerMergeTracked call landing in that window found the op
  // still 'running' and degraded to pending AGAIN). Wait for the real settle signal instead — mirrors
  // merge-confirm-dead-owner-recovery.mjs's own proven pattern.
  await sessions.pendingOps.waitBriefly(`merge:${workerId}`, 8000);
  const result = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(A) the confirm settles (not a hung pending)", result.settled === true);
  check("(A) it recovers to a REAL merged:true — never reports the landed work as failed", result.ok === true && result.value?.merged === true);
  check("(A) classified as ALREADY_MERGED (the same idempotent path a stale retry uses)", result.ok === true && result.value?.emptyKind === "ALREADY_MERGED");
  check("(A) canonical repo gained NO new commit — recovery only OBSERVED the already-landed squash, never re-merged", git(repo, "rev-parse HEAD") === headBefore);

  const failedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  const unknownNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  const alreadyMergedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:already-merged\]/.test(c.text));
  check("(A) NEGATIVE CONTROL — zero [loom:merge-failed] nudges for work that actually landed", failedNudges.length === 0);
  check("(A) NEGATIVE CONTROL — zero [loom:merge-unknown] nudges either — this case is NOT unknown, it's proven merged", unknownNudges.length === 0);
  check("(A) POSITIVE — exactly one [loom:already-merged] nudge fired", alreadyMergedNudges.length === 1);

  db.close();
}

// ── (B) NEGATIVE CONTROL — genuinely unknown: same thrown error, but the branch never landed anywhere ──
{
  const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { db, mgrId, workerId, repo } = await setup(sfx, { preLand: false });
  const headBefore = git(repo, "rev-parse HEAD");
  const pty = makePtyStub();
  const sessions = new SessionService(db, pty, new OrchestrationControl(), {
    runGate: async () => { await sleep(SLOW_THROW_MS); throw new Error("Cannot use simple-git on a directory that does not exist"); },
    syncAttachBudgetMs: TEST_SYNC_BUDGET_MS,
  });

  const pending = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(B) degrades to pending past the tiny sync budget (forces the real async completion-nudge path)", pending.settled === false);
  await sessions.pendingOps.waitBriefly(`merge:${workerId}`, 8000);
  const result = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
  check("(B) the confirm settles", result.settled === true);
  check("(B) recovery correctly found nothing to recover — the throw surfaces (ok:false)", result.settled === true && result.ok === false);
  check("(B) canonical repo untouched — recovery never invents a merge", git(repo, "rev-parse HEAD") === headBefore);

  const failedNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-failed\]/.test(c.text));
  const unknownNudges = pty.calls.filter((c) => c.sessionId === mgrId && /\[loom:merge-unknown\]/.test(c.text));
  check("(B) CRITICAL — this is NEVER reported as [loom:merge-failed] (card 479f449f DoD 2 — a thrown exception can never prove a genuine failure)", failedNudges.length === 0);
  check("(B) POSITIVE — exactly one honest [loom:merge-unknown] nudge fired instead — never silently swallowed", unknownNudges.length === 1);
  check("(B) the nudge explicitly says this is NOT a confirmed failure", unknownNudges[0] && /NOT a confirmed failure/.test(unknownNudges[0].text));
  check("(B) the nudge still carries the real thrown error text (diagnostic, not vague)", unknownNudges[0] && /Cannot use simple-git on a directory that does not exist/.test(unknownNudges[0].text));

  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a thrown confirmWorkerMerge error is never reported as a flat merge-failed: confirmWorkerMergeTracked's recovery re-derives the truth from git and reports a real 'merged' when the work is already on main (never re-merging, never a bogus failed/unknown nudge), and honestly reports 'unknown' (never 'failed', never silent) when the outcome genuinely cannot be determined either way."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
