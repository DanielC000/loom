import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// CARD b4cc7114, round 2 (Code Review, M1 BLOCKING + m3) — the solo-confirm `verificationRefused`
// refusal (detectStrandedWork's commondir-trust check itself being refused) returned no distinguishing
// result flag, so `classifyOutcome` fell through to a plain "rejected" — which IS cached/replayed by
// `retainVerdictUntilSuperseded` (orchestration/pending-ops.ts), keyed on branch HEAD. Repairing the
// shared `.git` doesn't move HEAD, so every re-confirm after the human fix would replay the STALE
// refusal forever: the documented remedy ("escalate, then re-confirm") dead-ended.
//
// The fix: `ConfirmMergeResult.strandedVerificationRefused` is now set on the RESULT (not just the event
// detail), `classifyOutcome` checks it BEFORE the generic "rejected" fallthrough (mirroring
// `canonicalRepoShallow`/`quarantined`/`canonical-index-lock-present`), and `"stranded-verification-
// refused"` is in `NEVER_CACHED_OUTCOMES`.
//
// This file proves it end to end through `confirmWorkerMergeTracked` (the cached/tracked entry point —
// NOT the bare `confirmWorkerMerge`, which has no cache to defeat), mirroring
// merge-confirm-verdict-cache-quarantine.mjs's own setup/assertion pattern for the sibling NEVER_CACHED
// exception: (1) a REAL worktree, genuinely stranded (committed to a self-created branch, exactly the
// worker-712fd5aa incident shape) whose PRIVATE commondir pointer is then redirected so
// detectStrandedWork's OWN `wt` probe throws a classified CanonicalGitCommondirRefusal — reproducing the
// real attack construction from worktree-commondir-redirect-gc.mjs, not a stubbed throw. (2) confirm
// refuses BEFORE the gate ever runs (gateCalls===0), the result carries strandedVerificationRefused:true,
// and the merge_rejected event carries the SAME flag. (3) "repair the shared .git" (restore the private
// commondir to the real worktree-registry pointer) then re-confirm: the re-call must NOT replay the
// cached "rejected" verdict (cacheHit===undefined) — it genuinely re-evaluates and this time reaches the
// REAL stranded-work refusal (stranded:true, naming the real divergent branch), proving a fresh
// detectStrandedWork run happened, not a stale replay.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-verdict-cache-stranded-verification.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcvcsv-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcsv@loom -c user.name=mcvcsv";
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcvcsv\n");
  execSync(`git init -q && git config user.email mcvcsv@loom && git config user.name mcvcsv`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const reposDir = path.join(os.tmpdir(), `loom-mcvcsv-${sfx}`);
registerForCleanup(reposDir);
const db = new Db();
const mgrId = `mcvcsv-mgr-${sfx}`, projId = `mcvcsv-p-${sfx}`, taskId = `mcvcsv-t-${sfx}`, workerId = `mcvcsv-w-${sfx}`;
const repo = path.join(reposDir, "repo");
makeRepo(repo);
db.insertProject({ id: projId, name: "MCVCSV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: `agent-mcvcsv-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcsv-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertAgent({ id: `agent-mcvcsv-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "MCVCSV-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });

// The real worker-712fd5aa incident shape: commit lands on a SELF-CREATED branch, leaving the ASSIGNED
// branch empty — exactly the case detectStrandedWork's step (2) (the `wt`-probing phase) reaches.
const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
const worktreeName = path.basename(worktreePath);
git(worktreePath, "checkout -q -b my-own-branch");
fs.writeFileSync(path.join(worktreePath, "stranded.txt"), "real work on the wrong branch\n");
commitAll(worktreePath, "stranded.txt", GIT_ID);
db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcsv-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

let gateCalls = 0;
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, runGate: async () => { gateCalls++; return { passed: true, steps: [] }; },
});

// Redirect the worktree's OWN private commondir pointer to a decoy — the real attack construction
// (worktree-commondir-redirect-gc.mjs's scenario 2), reproduced here through the full service layer so
// detectStrandedWork's `wt` probe genuinely throws a CanonicalGitCommondirRefusal mid-confirm.
const privateCommondirPath = path.join(repo, ".git", "worktrees", worktreeName, "commondir");
const realCommondirContent = fs.readFileSync(privateCommondirPath, "utf8");
const decoy = path.join(reposDir, "decoy");
fs.mkdirSync(decoy, { recursive: true });
execSync(`git init -q && git config user.email mcvcsv@loom && git config user.name mcvcsv`, { cwd: decoy });
fs.writeFileSync(path.join(decoy, "decoy.txt"), "decoy repo\n");
commitAll(decoy, "decoy-init", GIT_ID);
try { fs.unlinkSync(privateCommondirPath); } catch { /* not hidden on every host; ignore */ }
fs.writeFileSync(privateCommondirPath, path.join(decoy, ".git") + "\n");

const r1 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
check("(m3) op 1 settled, NOT merged, refused BEFORE any gate lane", r1.settled === true && r1.ok && r1.value.merged === false && gateCalls === 0);
check("(M1/m3) op 1's result carries strandedVerificationRefused:true", r1.ok && r1.value.strandedVerificationRefused === true);
check("(m3) the merge_rejected event carries the SAME flag", db.listEvents(mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "stranded" && e.detail.strandedVerificationRefused === true));

// A plain re-call while STILL redirected is refused again — isolates "the redirect persists" from "the
// verdict cache serves a stale reply", exactly like merge-confirm-verdict-cache-quarantine.mjs's own
// pre-clear sanity check.
const rStillRedirected = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
check("(m3) a re-call while STILL redirected is refused again, still no gate lane", rStillRedirected.settled === true && rStillRedirected.ok && rStillRedirected.value.merged === false && rStillRedirected.value.strandedVerificationRefused === true && gateCalls === 0);

// "Repair the shared .git" — restore the worktree's own private commondir to its real registry pointer.
fs.writeFileSync(privateCommondirPath, realCommondirContent);

const r2 = await sessions.confirmWorkerMergeTracked(mgrId, workerId);
check("(M1) after repairing the commondir, the re-call does NOT replay the stale cached refusal (cacheHit undefined — a genuine re-evaluation happened)", r2.cacheHit === undefined);
check("(M1) …and THIS TIME reaches the REAL stranded-work refusal (not the verification-refused one) — proving it actually re-ran detectStrandedWork, not a replay", r2.settled === true && r2.ok && r2.value.merged === false && r2.value.strandedVerificationRefused === undefined && typeof r2.value.reason === "string" && r2.value.reason.includes("my-own-branch"));
check("(M1) still no gate lane (the stranded backstop is a pre-gate refusal either way)", gateCalls === 0);

db.close();
console.log(failures === 0
  ? "\n✅ ALL PASS — a classified commondir refusal on detectStrandedWork's own `wt` probe refuses the solo " +
    "confirm BEFORE the gate (strandedVerificationRefused:true, named on both the result and the event), " +
    "and — the round-2 fix this file proves — it is NEVER cached: once the shared .git is repaired, a plain " +
    "re-confirm at the SAME branch HEAD genuinely re-evaluates instead of replaying the stale refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
