import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 62c4953a round 2 (Code Review 6ed0d5da, B2) — the BATCH `classifyOutcome` (sessions/service.ts,
// `mergeBatchTracked`) had NO arm at all for `quarantined`/`indexLockPresent`: both fell through to the
// generic `"rejected"` string, which IS replayed from the until-superseded verdict cache. So a batch
// refused because the canonical repo had a real `.git/index.lock` present at fast-forward time would, once
// a human removed the lock, still have its re-fire served the STALE refusal verbatim — `runGate` never
// invoked a second time, the lock-removal never actually re-checked.
//
// THE FIX: the batch `classifyOutcome` now checks `quarantined`/`indexLockPresent` before the generic
// fallback, mapping each to its own never-cached string (`"quarantined"`/`"canonical-index-lock-present"`,
// both already in `NEVER_CACHED_OUTCOMES` — reused verbatim from the solo path's own classification). The
// `quarantined` gap predates this card but is fixed on the SAME lines.
//
// Modelled directly on batch-merge-diverted-not-cached.mjs's own setup/mechanism, simplified: this
// scenario plants the lock up front (never a mid-gate injection) since the fast-forward — the only
// canonical-index write on the batch path — runs strictly AFTER a green gate, so a pre-planted lock still
// lets the gate run for real on call #1 before refusing at the ff-only step.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-index-lock-not-cached.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${Date.now()}-${process.pid}`);
useOwnLoomHome("loom-bmil-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmil", GIT_AUTHOR_EMAIL: "bmil@loom", GIT_COMMITTER_NAME: "bmil", GIT_COMMITTER_EMAIL: "bmil@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmil@loom -c user.name=bmil";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmil-proj-${sfx}`, agentId: `bmil-agent-${sfx}`, mgrId: `bmil-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmil-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmil\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmil@loom"); git(P.repo, "config", "user.name", "bmil");
commitAll(P.repo, "init", GIT_ID);

const lockPath = path.join(P.repo, ".git", "index.lock");
const plantLock = () => fs.writeFileSync(lockPath, "");
const removeLock = () => fs.rmSync(lockPath);

let gateCalls = 0;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
  runGate: async () => { gateCalls++; return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] }; },
});
db.insertProject({ id: P.projId, name: "BMIL", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

async function addWorker(tag) {
  const taskId = `bmil-${tag}-task-${sfx}`, workerId = `bmil-${tag}-wkr-${sfx}`;
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

  // ── call #1: a real lock is already present BEFORE the whole batch call — the gate still runs for real
  //    (the lock only blocks the FF-ONLY, which happens strictly after a green gate), then refuses ───────
  plantLock();
  const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #1 settled synchronously", r1.settled === true);
  const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
  check("call #1 refused, typed indexLockPresent", v1.ok === false && v1.indexLockPresent === true);
  check("call #1's reason names the specific reason code", /canonical_index_lock_present/.test(v1.reason ?? ""));
  check("call #1 invoked the gate exactly once (the lock only blocks the LATER ff-only)", gateCalls === 1);
  check("precondition: neither candidate branch moved (no fallback ran)", git(P.repo, "rev-parse", w1.branch) === tipBefore1.a && git(P.repo, "rev-parse", w2.branch) === tipBefore1.b);
  check("precondition: canonical mainline did NOT advance", git(P.repo, "rev-parse", "HEAD") === baseSha);

  // ── the human's remedy: remove the lock, exactly as the refusal instructs ───────────────────────────────
  check("precondition: the lock really is still on disk before the remedy", fs.existsSync(lockPath));
  removeLock();
  check("precondition: the lock is gone", !fs.existsSync(lockPath));

  // ── call #2: SAME workerSessionIds, unchanged candidate branches ⇒ IDENTICAL verdictIdentity ───────────
  const tipBefore2 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };
  check("the candidate branch heads are IDENTICAL across both calls (verdictIdentity would match)", tipBefore2.a === tipBefore1.a && tipBefore2.b === tipBefore1.b);
  const r2 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #2 settled synchronously", r2.settled === true);
  const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };

  check("(B2 FIX) the gate counter INCREMENTED — call #2 ran a REAL gate, not a cache replay", gateCalls === 2);
  check("(B2 FIX) cacheHit is ABSENT on call #2's AttachResult — a genuinely fresh op, never served from the stale lock-present verdict", !("cacheHit" in r2));
  check("(B2 FIX) call #2 actually landed this time (lock was removed, no second refusal)", v2.ok === true);
  check("(B2 FIX) both candidates landed", Array.isArray(v2.landed) && v2.landed.length === 2 && v2.landed.some((l) => l.branch === w1.branch) && v2.landed.some((l) => l.branch === w2.branch));
  check("canonical mainline actually advanced past the pre-batch sha", git(P.repo, "rev-parse", "HEAD") !== baseSha);

  db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch `indexLockPresent` refusal is never cached/replayed: a re-fire with the same " +
    "worker ids (same verdictIdentity) re-invokes the gate for real and lands once the lock is removed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
