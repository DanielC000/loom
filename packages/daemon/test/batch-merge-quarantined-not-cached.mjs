import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 62c4953a round 2 (Code Review 6ed0d5da, B2) — the BATCH `classifyOutcome` (sessions/service.ts,
// `mergeBatchTracked`) had NO arm at all for `quarantined`/`indexLockPresent`: both fell through to the
// generic `"rejected"` string, which IS replayed from the until-superseded verdict cache. So a batch
// refused because the canonical repo was quarantined would, once a human cleared it, still have its
// re-fire served the STALE refusal verbatim — `runGate` never invoked a second time, the clear never
// actually re-checked. THE FIX: the batch `classifyOutcome` now checks `quarantined`/`indexLockPresent`
// before the generic fallback, mapping each to its own never-cached string. This file is the `quarantined`
// twin of batch-merge-index-lock-not-cached.mjs (card e7a88047, item 4) — no prior test exercised this
// specific arm through `mergeBatchTracked`'s OWN caching layer (`merge-quarantine-batch.mjs` drives
// `runBatchedMerge`/`fastForwardCanonicalMain` directly, never through the attach/verdict-cache wrapper).
//
// WHY THE QUARANTINE IS RAISED MID-GATE, NOT PRE-PLANTED: unlike a `.git/index.lock`, `createWorktree`
// itself ALREADY checks quarantine on entry (`git/worktrees.ts`, its own `assertRepoNotQuarantined` call,
// predating this card) and throws a PLAIN (untyped) `Error` if the repo is already quarantined — a
// pre-planted quarantine would never even reach `runBatchedMerge`'s own typed `quarantined:true` return at
// all, so call #1 would classify as "unknown" instead, proving nothing about THIS arm. Raising it from
// INSIDE the fake `runGate` callback (mirroring merge-quarantine-batch.mjs's own SCENARIO D) means the
// worktree cut and the gate both run for real first, and only the SUBSEQUENT `fastForwardCanonicalMain`
// call sees the quarantine and returns the typed `{ok:false, quarantined:true}` shape this test is for.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-quarantined-not-cached.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${Date.now()}-${process.pid}`);
useOwnLoomHome("loom-bmqnc-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmqnc", GIT_AUTHOR_EMAIL: "bmqnc@loom", GIT_COMMITTER_NAME: "bmqnc", GIT_COMMITTER_EMAIL: "bmqnc@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmqnc@loom -c user.name=bmqnc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmqnc-proj-${sfx}`, agentId: `bmqnc-agent-${sfx}`, mgrId: `bmqnc-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmqnc-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmqnc\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmqnc@loom"); git(P.repo, "config", "user.name", "bmqnc");
commitAll(P.repo, "init", GIT_ID);

let gateCalls = 0;
let raiseQuarantineOnGate = true; // flips off before call #2 — call #2 must land for real
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
  runGate: async () => {
    gateCalls++;
    if (raiseQuarantineOnGate) {
      // Simulates a genuinely independent op (a different merge/batch) quarantining this SAME canonical
      // repo WHILE this batch's own gate is running — the exact race fastForwardCanonicalMain's own
      // re-check (raised AFTER runBatchedMerge's own entry check already passed) exists to close.
      enterMergeQuarantine(P.repo, "unrelated-branch", "manufactured for batch-merge-quarantined-not-cached test");
    }
    return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
  },
});
db.insertProject({ id: P.projId, name: "BMQNC", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

async function addWorker(tag) {
  const taskId = `bmqnc-${tag}-task-${sfx}`, workerId = `bmqnc-${tag}-wkr-${sfx}`;
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

  // ── call #1: the gate itself quarantines the repo MID-RUN — the worktree cut + gate both run for
  //    real, and the SUBSEQUENT fast-forward sees the quarantine and refuses ─────────────────────────
  const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #1 settled synchronously", r1.settled === true);
  const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
  check("call #1 refused, typed quarantined", v1.ok === false && v1.quarantined === true);
  check("call #1 invoked the gate exactly once (the quarantine only blocks the LATER fast-forward)", gateCalls === 1);
  check("precondition: neither candidate branch moved (no fallback ran)", git(P.repo, "rev-parse", w1.branch) === tipBefore1.a && git(P.repo, "rev-parse", w2.branch) === tipBefore1.b);
  check("precondition: canonical mainline did NOT advance", git(P.repo, "rev-parse", "HEAD") === baseSha);
  check("precondition: the repo really does read as quarantined right now", !!activeMergeQuarantineFor(P.repo));

  // ── the human's remedy: clear the quarantine, exactly as the refusal instructs ───────────────────────
  clearMergeQuarantine(P.repo);
  check("precondition: the repo no longer reads as quarantined", !activeMergeQuarantineFor(P.repo));

  // ── call #2: SAME workerSessionIds, unchanged candidate branches ⇒ IDENTICAL verdictIdentity; the fake
  //    gate no longer re-quarantines, so this call must land for real ───────────────────────────────────
  raiseQuarantineOnGate = false;
  const tipBefore2 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };
  check("the candidate branch heads are IDENTICAL across both calls (verdictIdentity would match)", tipBefore2.a === tipBefore1.a && tipBefore2.b === tipBefore1.b);
  const r2 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #2 settled synchronously", r2.settled === true);
  const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };

  check("(B2 FIX) the gate counter INCREMENTED — call #2 ran a REAL gate, not a cache replay", gateCalls === 2);
  check("(B2 FIX) cacheHit is ABSENT on call #2's AttachResult — a genuinely fresh op, never served from the stale quarantined verdict", !("cacheHit" in r2));
  check("(B2 FIX) call #2 actually landed this time (quarantine was cleared, no second refusal)", v2.ok === true);
  check("(B2 FIX) both candidates landed", Array.isArray(v2.landed) && v2.landed.length === 2 && v2.landed.some((l) => l.branch === w1.branch) && v2.landed.some((l) => l.branch === w2.branch));
  check("canonical mainline actually advanced past the pre-batch sha", git(P.repo, "rev-parse", "HEAD") !== baseSha);

  db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch `quarantined` refusal is never cached/replayed: a re-fire with the same " +
    "worker ids (same verdictIdentity) re-invokes the gate for real and lands once the quarantine clears."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
