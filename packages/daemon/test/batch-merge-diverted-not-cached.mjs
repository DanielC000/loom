import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round 4), DoD item 1 — the MISSING test batch-merge-branch-diverted-no-fallback.mjs
// never wrote: that file proves a `branchDiverted` refusal runs no per-candidate fallback, but it never
// re-fires `merge_batch` afterward, so nothing in this repo actually exercised the reason "branch-diverted"/
// "ff-unverified" are in `NEVER_CACHED_OUTCOMES` (orchestration/pending-ops.ts) in the first place: without
// it, a re-call under the SAME dedupe key with the SAME `verdictIdentity` would be served the STALE divert
// verdict straight out of `untilSupersededVerdicts` — never re-running the gate — even though the human
// fixed the exact thing the refusal was about (the checkout) in between.
//
// THE MECHANISM THIS PROVES (sessions/service.ts, `mergeBatchTracked`): the batch's `verdictIdentity` is
// `heads.slice().sort().join(",") + mergeGateIdentitySuffix(...)` — the resolved CANDIDATE BRANCH HEADS,
// never anything about the canonical checkout. A `branchDiverted` refusal runs no per-candidate fallback
// (batch-merge-branch-diverted-no-fallback.mjs), so neither candidate branch moves — meaning a re-fire
// with the SAME workerSessionIds resolves the IDENTICAL `verdictIdentity` the diverted call minted. Absent
// `NEVER_CACHED_OUTCOMES`'s veto, that identity match is EXACTLY what `PendingOpRegistry.attach`'s
// `untilSupersededVerdicts` cache hit requires (pending-ops.ts ~607) — the re-fire would short-circuit to
// the stale `branchDiverted` verdict, `cacheHit` set, `runGate` never invoked a second time, even after a
// human restored the checkout. This file proves the opposite: the re-fire re-mints, re-invokes `runGate`,
// and — because the checkout really is restored by the time it runs — actually lands.
//
// REAL git, REAL `mergeBatchTracked`, same divert-from-inside-`runGate` seam as
// batch-merge-branch-diverted-no-fallback.mjs, but the divert fires ONLY on the gate's FIRST invocation:
//   (1) call #1 diverts the checkout mid-gate ⇒ `branchDiverted:true`, gate invoked once.
//   (2) the test (standing in for the human) restores the checkout to mainline and deletes the stray branch.
//   (3) call #2, SAME workerSessionIds, unchanged worker branches (no fallback ran after (1), so nothing on
//       either candidate branch moved — the identity really is identical, not merely assumed to be):
//       `cacheHit` is ABSENT (a genuinely fresh op, not a cache replay), `runGate` is invoked a SECOND time
//       (the counter incremented — proof the gate actually ran, not merely that SOME value came back), and
//       the batch now lands for real (`ok:true`, both candidates in `landed`).
//
// FALSIFIABILITY (verified directly, mirroring this file's siblings): temporarily removing "branch-diverted"
// from `NEVER_CACHED_OUTCOMES` (orchestration/pending-ops.ts) and rebuilding turns call #2 into a cache hit:
// `gateCalls` stays at 1 (never incremented a second time), `r2.value.cacheHit` is PRESENT, and
// `r2.value.ok` reads `false`/`branchDiverted:true` — the STALE verdict from call #1, replayed verbatim even
// though the checkout was already restored. Confirmed RED on that reverted build, confirmed GREEN again
// after restoring "branch-diverted" to the set and rebuilding.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/batch-merge-diverted-not-cached.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-bmdc-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "bmdc", GIT_AUTHOR_EMAIL: "bmdc@loom", GIT_COMMITTER_NAME: "bmdc", GIT_COMMITTER_EMAIL: "bmdc@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=bmdc@loom -c user.name=bmdc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const P = { projId: `bmdc-proj-${sfx}`, agentId: `bmdc-agent-${sfx}`, mgrId: `bmdc-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-bmdc-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# bmdc\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "bmdc@loom"); git(P.repo, "config", "user.name", "bmdc");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const canonBranch = () => git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const strayName = `bmdc-stray-${sfx}`;
const baseSha = git(P.repo, "rev-parse", "HEAD");

let gateCalls = 0;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
  runGate: async () => {
    gateCalls++;
    // Divert ONLY on the first invocation — the second call's gate must see a clean, restored checkout.
    if (gateCalls === 1) await new GitWriter(P.repo).createBranch(strayName);
    return { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };
  },
});
db.insertProject({ id: P.projId, name: "BMDC", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

async function addWorker(tag) {
  const taskId = `bmdc-${tag}-task-${sfx}`, workerId = `bmdc-${tag}-wkr-${sfx}`;
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
  const tipBefore1 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };

  // ── call #1: diverts mid-gate ────────────────────────────────────────────────────────────────────────
  const r1 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #1 settled synchronously", r1.settled === true);
  const v1 = r1.settled && r1.ok ? r1.value : { __unsettled: r1 };
  check("call #1 refused, typed branchDiverted", v1.ok === false && v1.branchDiverted === true);
  check("call #1 invoked the gate exactly once", gateCalls === 1);
  check("precondition: neither candidate branch moved (no fallback ran)", git(P.repo, "rev-parse", w1.branch) === tipBefore1.a && git(P.repo, "rev-parse", w2.branch) === tipBefore1.b);

  // ── the human's remedy: restore the checkout exactly as the manager guidance (divertTail) instructs ───
  check("precondition: canonical really is diverted before the restore", canonBranch() === strayName);
  git(P.repo, "checkout", "-q", MAIN);
  git(P.repo, "branch", "-q", "-D", strayName);
  check("precondition: checkout is restored to mainline", canonBranch() === MAIN);

  // ── call #2: SAME workerSessionIds, unchanged candidate branches ⇒ IDENTICAL verdictIdentity ───────────
  const tipBefore2 = { a: git(P.repo, "rev-parse", w1.branch), b: git(P.repo, "rev-parse", w2.branch) };
  check("the candidate branch heads are IDENTICAL across both calls (verdictIdentity would match)", tipBefore2.a === tipBefore1.a && tipBefore2.b === tipBefore1.b);
  const r2 = await sessions.mergeBatchTracked(P.mgrId, [w1.workerId, w2.workerId]);
  check("call #2 settled synchronously", r2.settled === true);
  const v2 = r2.settled && r2.ok ? r2.value : { __unsettled: r2 };

  check("(DoD-1) the gate counter INCREMENTED — call #2 ran a REAL gate, not a cache replay", gateCalls === 2);
  check("(DoD-1) cacheHit is ABSENT on call #2's AttachResult — a genuinely fresh op, never served from the stale divert verdict", !("cacheHit" in r2));
  check("(DoD-1) call #2 actually landed this time (checkout was restored, no second divert)", v2.ok === true);
  check("(DoD-1) both candidates landed", Array.isArray(v2.landed) && v2.landed.length === 2 && v2.landed.some((l) => l.branch === w1.branch) && v2.landed.some((l) => l.branch === w2.branch));
  check("canonical mainline actually advanced past the pre-batch sha", git(P.repo, "rev-parse", MAIN) !== baseSha);

  db.close();
} finally {
  // (db instance closed above)
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a `branchDiverted` batch refusal is never cached/replayed: a re-fire with the same worker ids (same verdictIdentity) re-invokes the gate for real and lands once the checkout is restored."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
