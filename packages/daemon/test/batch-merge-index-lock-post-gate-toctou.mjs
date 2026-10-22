import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e7a88047 round 2 (Code Review 1260fb58, item 3) — the pre-gate index-lock check
// (batch-merge-index-lock-not-cached.mjs) proves the lock is caught BEFORE the batch worktree is even cut.
// That means a lock PLANTED BEFORE the whole mergeBatchTracked() call can never again reach the POST-gate
// TOCTOU arm (fastForwardCanonicalMain's own re-check, sessions/service.ts ~20618) — the pre-gate check
// always wins the race for a pre-existing lock. This file re-covers that OTHER arm specifically: a lock
// that appears AFTER the pre-gate check already passed clean and AFTER a real gate run, mirroring
// batch-merge-quarantined-not-cached.mjs's own mid-gate technique (plant it from inside the fake runGate
// callback, after assembly has already completed but before the fast-forward).
//
// Proves: the result is TYPED (indexLockPresent:true, same as the pre-gate arm), the refusal is NEVER
// CACHED (a re-fire with the same worker ids re-invokes the gate for real once the lock is removed), and
// the batch worktree is RETAINED on disk (never removed) — same posture as a quarantined batch worktree,
// since something may still need inspecting.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-index-lock-post-gate-toctou.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${Date.now()}-${process.pid}`);
useOwnLoomHome("loom-bmilpg-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, resolveWorktreePath } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmilpg", GIT_AUTHOR_EMAIL: "bmilpg@loom", GIT_COMMITTER_NAME: "bmilpg", GIT_COMMITTER_EMAIL: "bmilpg@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmilpg@loom -c user.name=bmilpg";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmilpg-proj-${sfx}`, agentId: `bmilpg-agent-${sfx}`, mgrId: `bmilpg-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmilpg-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmilpg\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmilpg@loom"); git(P.repo, "config", "user.name", "bmilpg");
commitAll(P.repo, "init", GIT_ID);

const lockPath = path.join(P.repo, ".git", "index.lock");
const plantLock = () => fs.writeFileSync(lockPath, "");
const removeLock = () => fs.rmSync(lockPath);

let gateCalls = 0;
let raiseLockOnGate = true; // flips off before call #2 — call #2 must land for real
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
  runGate: async () => {
    gateCalls++;
    if (raiseLockOnGate) {
      // Simulates a lock APPEARING mid-gate — after the pre-gate check already passed clean and after
      // assembly has already completed, the one window neither the pre-gate check nor assembly's own
      // completion can see. The SUBSEQUENT fastForwardCanonicalMain call is what catches this.
      plantLock();
    }
    return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
  },
});
db.insertProject({ id: P.projId, name: "BMILPG", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

async function addWorker(tag) {
  const taskId = `bmilpg-${tag}-task-${sfx}`, workerId = `bmilpg-${tag}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
  commitAll(worktreePath, `feat(x): change ${tag}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}

try {
  const w1 = await addWorker("a"), w2 = await addWorker("b");
  const baseSha = git(P.repo, "rev-parse", "HEAD");
  const tipBefore1 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };

  // ── call #1: no lock present yet — the pre-gate check passes clean, assembly + a REAL gate run both
  //    happen, and the lock appears FROM INSIDE the gate callback, so only the SUBSEQUENT fast-forward
  //    sees it and refuses ────────────────────────────────────────────────────────────────────────────
  const r1 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
  const v1 = r1.ok ? r1.value : { __unsettled: r1 };
  check("call #1 refused, TYPED indexLockPresent (the post-gate ff-only arm, not the pre-gate one)", v1.ok === false && v1.indexLockPresent === true);
  check("call #1's reason names the specific reason code", /canonical_index_lock_present/.test(v1.reason ?? ""));
  check("call #1 DID invoke the gate (this arm only fires AFTER a real gate run, unlike the pre-gate arm)", gateCalls === 1);
  check("precondition: neither candidate branch moved (no fallback ran)", git(P.repo, "rev-parse", w1.branch) === tipBefore1.a && git(P.repo, "rev-parse", w2.branch) === tipBefore1.b);
  check("precondition: canonical mainline did NOT advance", git(P.repo, "rev-parse", "HEAD") === baseSha);

  // The batch worktree is RETAINED (never removed) on this refusal — same posture as a quarantined batch
  // worktree, since something may still need inspecting (a batched merge was in flight when the lock
  // appeared). `resolveWorktreePath` recomputes the SAME deterministic path createWorktree would have
  // cut it at, from the batch's own task id (`batch-${opId}`).
  const batchWorktreePath = resolveWorktreePath(P.projId, `batch-${v1.opId}`);
  check("call #1's batch worktree is RETAINED on disk (never removed on an indexLockPresent refusal)", fs.existsSync(batchWorktreePath));
  registerForCleanup(batchWorktreePath);

  // Review round 2's Minor: service.ts's own onSettle comment claims this POST-gate arm keeps the REAL
  // gate verdict (`batchGateVerdict` is already set from the real `runGate` call that ran before the
  // fast-forward, so `verdict` is non-null and the synthesis block is skipped entirely) — UNLIKE the
  // pre-gate arm (batch-merge-index-lock-not-cached.mjs), which synthesizes a "skipped" tombstone because
  // no gate ever ran for it. Pin that distinction directly against the real settled row.
  const settled1 = db.findPendingGateOpByOpId(v1.opId);
  check("call #1's tombstone is resolvable by its own opId", settled1.kind === "found");
  if (settled1.kind === "found") {
    check("call #1's tombstone settled (never left pending)", settled1.record.state === "settled");
    check("call #1's tombstone verdict is the REAL gate verdict ('pass') — NOT a synthesized 'skipped' row", settled1.record.verdict === "pass");
    check("call #1's tombstone carries NO 'canonical-index-lock-present' skipReason (that's the pre-gate arm's own synthesis, never this one)", settled1.record.verdictPayload?.skipReason !== "canonical-index-lock-present");
  }

  // ── the human's remedy: remove the lock, exactly as the refusal instructs ───────────────────────────
  check("precondition: the lock really is still on disk before the remedy", fs.existsSync(lockPath));
  removeLock();
  check("precondition: the lock is gone", !fs.existsSync(lockPath));

  // ── call #2: SAME workerSessionIds, unchanged candidate branches ⇒ IDENTICAL verdictIdentity; the fake
  //    gate no longer plants the lock, so this call must land for real ──────────────────────────────────
  raiseLockOnGate = false;
  const tipBefore2 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };
  check("the candidate branch heads are IDENTICAL across both calls (verdictIdentity would match)", tipBefore2.a === tipBefore1.a && tipBefore2.b === tipBefore1.b);
  const r2 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]), { label: "mergeBatchTracked", timeoutMs: 240_000 });
  const v2 = r2.ok ? r2.value : { __unsettled: r2 };

  check("NEVER CACHED: the gate counter INCREMENTED — call #2 ran a REAL gate, not a cache replay", gateCalls === 2);
  check("NEVER CACHED: cacheHit is ABSENT on call #2's AttachResult — a genuinely fresh op, never served from the stale lock-present verdict", !("cacheHit" in r2));
  check("call #2 actually landed this time (lock was removed, no second refusal)", v2.ok === true);
  check("both candidates landed", Array.isArray(v2.landed) && v2.landed.length === 2 && v2.landed.some((l) => l.branch === w1.branch) && v2.landed.some((l) => l.branch === w2.branch));
  check("canonical mainline actually advanced past the pre-batch sha", git(P.repo, "rev-parse", "HEAD") !== baseSha);

  db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the POST-gate index-lock TOCTOU arm (fastForwardCanonicalMain's own re-check) is " +
    "typed (indexLockPresent:true), never cached/replayed, and retains its batch worktree for inspection."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
