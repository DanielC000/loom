import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 6325bc74 — an ownership refusal ("not your worker") thrown by
// `confirmWorkerMerge` used to be classified as the generic "unknown" outcome (service.ts's
// `classifyOutcome`), which is NOT in `NEVER_CACHED_OUTCOMES` — so it got written into the process-local,
// manager-agnostic `untilSupersededVerdicts` cache (keyed only on the worker/branch identity, never on
// `managerSessionId`) and replayed verbatim to ANY later caller at the same branch tip, including the
// worker's genuinely-correct, current parent.
//
// THE INCIDENT SHAPE (Platform-escalated, 2026-09-18, card 6325bc74): a worker recycled from a
// predecessor manager to a successor. A stale/wrong-identity confirm attempt got cached as a "not your
// worker" refusal; the RIGHTFUL successor's own plain re-confirm was then served that same stale
// rejection from cache — even though it genuinely owns the worker (every sibling tool — worker_status,
// worker_merge — already agreed it did). This test constructs that shape directly rather than
// reproducing the original recycle timing: call confirmWorkerMergeTracked as a manager that does NOT own
// the worker (so `confirmWorkerMerge`'s ownership guard throws for real, and that throw gets cached under
// the worker's own merge key), then call it again as the worker's ACTUAL parent at the identical branch
// tip — asserting the second call is NOT served the first call's cached rejection.
//
// THE FIX: `confirmWorkerMergeTracked`'s `classifyOutcome` (service.ts) now classifies a `NotYourWorkerError`
// throw distinctly as "not-your-worker" (a typed sentinel, not a message string-match — see that class's
// own doc), and `NEVER_CACHED_OUTCOMES` (orchestration/pending-ops.ts) now excludes it — the same
// never-cache treatment "cancelled"/"stale-base" already get, for the same reason: none of the three is a
// verdict about the branch, and this one specifically is a fact about the CALLING MANAGER, a dimension
// this cache doesn't key on at all.
//
// Uses a REAL git repo/worktree (mirrors merge-confirm-verdict-cache.mjs) with a stubbed ALWAYS-PASSING
// gate command, so the rightful parent's re-confirm — once the fix stops it from being cache-poisoned —
// runs a real, observable merge rather than merely avoiding a thrown error.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-ownership-refusal-not-cached.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-morc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=morc@loom -c user.name=morc";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const reposDir = path.join(os.tmpdir(), `loom-morc-repo-${sfx}`);
registerForCleanup(reposDir);

const repo = path.join(reposDir, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# morc\n");
execSync(`git init -q && git config user.email morc@loom && git config user.name morc`, { cwd: repo });
commitAll(repo, "init", GIT_ID);

const db = new Db();
// TWO manager sessions: `wrongMgrId` never owns the worker at all — its confirm attempt is the one whose
// ownership refusal must never poison the cache; `rightMgrId` is the worker's REAL, current parent (the
// stand-in for "the rightful/inherited successor" in the real incident — this test doesn't need to model
// the recycle itself, only the manager-agnostic-cache consequence it produces).
const wrongMgrId = "morc-wrong-mgr", rightMgrId = "morc-right-mgr", projId = "morc-p", taskId = "morc-t", workerId = "morc-w";
db.insertProject({ id: projId, name: "MORC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agent-morc-wrong", projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: wrongMgrId, projectId: projId, agentId: "agent-morc-wrong", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertAgent({ id: "agent-morc-right", projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: rightMgrId, projectId: projId, agentId: "agent-morc-right", engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertAgent({ id: "agent-morc-w", projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "MORC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
commitAll(worktreePath, "feature.txt", GIT_ID);
// The worker's REAL parent is `rightMgrId` — `wrongMgrId` never owns it, at any point in this test.
db.insertSession({ id: workerId, projectId: projId, agentId: "agent-morc-w", engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: rightMgrId, taskId, worktreePath, branch });

let gateCalls = 0;
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
});

// op1: a manager that does NOT own this worker calls confirm — a genuine, correct-at-the-time ownership
// refusal. This is what must never get cached and replayed to someone else.
const op1 = await settleTracked(() => sessions.confirmWorkerMergeTracked(wrongMgrId, workerId), { label: "op1" });
check("(op1, wrong manager) settled", op1.settled === true);
check("(op1, wrong manager) refused with a genuine ownership error, not some other failure", op1.settled && op1.ok === false && op1.error instanceof Error && op1.error.message === "not your worker");
check("(op1, wrong manager) this is a genuinely fresh mint — nothing cached before this call", op1.settled && op1.freshMint?.reason === "genuinely-new");
check("(op1, wrong manager) no gate ever ran — the refusal fires before any git/gate work", gateCalls === 0);

// op2: the worker's ACTUAL, current parent calls confirm at the IDENTICAL branch tip (nothing changed
// about the worker/branch between op1 and op2 — only the caller differs). THE DEFECT this card fixes:
// before the fix, this was served op1's cached "not your worker" rejection verbatim (same opId, a
// cacheHit marker) even though this caller genuinely owns the worker. After the fix, this must run for
// real and land a merge.
const op2 = await settleTracked(() => sessions.confirmWorkerMergeTracked(rightMgrId, workerId), { label: "op2" });
check("(op2, rightful parent) settled", op2.settled === true);
// THE CORE ASSERTION — verify the red would be for the RIGHT reason: a pre-fix run of this exact block
// fails here specifically because op2.ok===false / op2.error.message==="not your worker", not because of
// an unrelated crash. See this file's own header for the revert-and-rerun proof.
check("(op2, rightful parent) NOT refused as \"not your worker\" — this caller genuinely owns the worker", !(op2.settled && op2.ok === false && op2.error instanceof Error && op2.error.message === "not your worker"));
check("(op2, rightful parent) a real merge actually ran and succeeded", op2.settled === true && op2.ok === true && op2.value.merged === true);
check("(op2, rightful parent) carries NO cacheHit — this was a genuine fresh mint, never a replay of op1's rejection", op2.cacheHit === undefined);
check("(op2, rightful parent) is a genuinely fresh mint (op1's ownership refusal was never cached)", op2.freshMint?.reason === "genuinely-new");
check("(op2, rightful parent) the gate ran for real exactly once", gateCalls === 1);

console.log(failures === 0
  ? "\n✅ ALL PASS — an ownership refusal (\"not your worker\") thrown by confirmWorkerMerge is never cached/replayed across a different (or since-corrected) calling manager (card 6325bc74): a wrong-manager confirm's genuine, correct-at-the-time refusal (op1) does not poison the worker's merge-verdict cache for its ACTUAL, current parent's own plain re-confirm at the identical branch tip (op2) — op2 runs a real, fresh gate and lands the merge instead of being served op1's stale rejection."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
