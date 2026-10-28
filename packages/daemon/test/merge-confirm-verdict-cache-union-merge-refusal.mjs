import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 57f9cdd9 — the PRE-GATE union-merge's own bare-refusal fallthrough never carried a distinguishing
// flag (unlike the POST-squash sites card 08c36dae already fixed): a structural `CanonicalGitRefusal`
// (commondir redirect / pin mismatch) during `mergeMainIntoWorktree`'s own main-tip read, identity probe,
// or `merge --no-edit` call fell through to the generic "union merge failed" shape, which
// `classifyOutcome` (sessions/service.ts) classified plain `"rejected"` — NOT in `NEVER_CACHED_OUTCOMES` —
// so a re-confirm at the same (branch tip, main tip) identity after a human repaired the canonical repo
// replayed the stale rejection forever instead of genuinely re-attempting the union-merge.
//
// The fix REUSES the existing post-squash `canonicalTrustRefusal`/"canonical-trust-refusal" classification
// (card 08c36dae) rather than minting a new one — that outcome is already `NEVER_CACHED_OUTCOMES`, and its
// wording ("nothing was squashed … untouched … a canonical-git TRUST refusal") is equally true here.
//
// (A) SOLO — mirrors merge-confirm-canonical-trust-refusal.mjs's own real commondir-trust-pin-mismatch
//     fault (via registerCommondirTrustPinLookup, tripped at the identity-fallback probe) but threaded
//     through `unionMergeGitFactory` instead of `soloMergeGitFactory`, so it fires at the PRE-GATE
//     union-merge's own identity probe (git/worktrees.ts ~:9688) rather than the post-squash one.
// (B) BATCH — mirrors merge-landing-aborted-batch-refusal.mjs's own boot/addWorker recipe; injects a bare
//     CanonicalGitRefusal directly at the batch fast-forward's `--ff-only` call via a PROXYING
//     `batchFfGitFactory` (real canonicalGit for every other call, same shape as the `-transient` sibling's
//     own ADMISSION-TIME scenario).
//
// Both scenarios assert: (1) the refusal carries NO quarantined/dirtyWorktree/transient/branchDiverted/etc
// flag — just canonicalTrustRefusal:true; (2) op 2, after the fault clears with branch/main tips
// UNCHANGED, carries NO cacheHit and genuinely re-attempts (a real merge/ff call count rises, and it lands).
//
// RED-PROOFED: this file's own op-2 "no cacheHit" + "mergeAttempts rose" assertions fail against the
// pre-fix code (verified via `negative-control` — see the card's own report).
//
// Run: 1) pnpm build, 2) node packages/daemon/test/merge-confirm-verdict-cache-union-merge-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";
import { awaitTrackedSettle } from "./_settle-tracked-monotonic.mjs";

useOwnLoomHome("loom-mcvcumr-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit, CanonicalGitRefusal } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcvcumr@loom -c user.name=mcvcumr";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A) SOLO — the pre-gate union-merge's own identity probe trips a real commondir-trust-pin mismatch
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (A) SOLO: a real commondir-trust-pin mismatch at the pre-gate union-merge's identity probe —");
    const sfx = sfxOf("a");
    const reposDir = path.join(os.tmpdir(), `loom-mcvcumr-${sfx}`);
    registerForCleanup(reposDir);
    const db = new Db(); openDbs.push(db);
    const mgrId = `mcvcumr-mgr-${sfx}`, projId = `mcvcumr-p-${sfx}`, taskId = `mcvcumr-t-${sfx}`, workerId = `mcvcumr-w-${sfx}`;
    const repo = path.join(reposDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumr\n");
    execSync("git init -q && git config user.email mcvcumr@loom && git config user.name mcvcumr", { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    // A gateCommand is REQUIRED for the pre-gate union-merge to run at all (card c0aeb5b2: with no gate to
    // validate the worktree, mergeMainIntoWorktree is skipped entirely); `runGate` below always passes so
    // the test isolates the union-merge's own refusal, never a real gate failure.
    db.insertProject({ id: projId, name: "MCVCUMR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-mcvcumr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcvcumr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertAgent({ id: `agent-mcvcumr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "MCVCUMR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    commitAll(worktreePath, "feature.txt", GIT_ID);
    // Advance MAIN past the worktree's own fork point (on a file the branch never touches) so
    // mergeMainIntoWorktree's own "already caught up" merge-base shortcut does NOT fire — without this
    // the real identity probe (and the merge call after it) is never reached at all.
    fs.writeFileSync(path.join(repo, "main-advance.txt"), "main advance\n");
    execSync(`git ${GIT_ID} add -A && git ${GIT_ID} commit -q -m "main advance"`, { cwd: repo });
    db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcvcumr-w-${sfx}`, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    // PRODUCTION-SHAPED fault — same real mechanism as merge-confirm-canonical-trust-refusal.mjs's own
    // (A)/(B): checkCommondirTrust disagrees with a planted pin the instant the identity-fallback probe's
    // own `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` call runs. Also counts how many times the real
    // `git merge --no-edit` call actually ran, the cache-independent observable this file uses to tell
    // "replayed" (count stays flat) apart from "genuinely re-attempted" (count rises).
    const state = { untrusted: false, mergeAttempts: 0 };
    function unionIdentityProbeTrustFlipFactory() {
      registerCommondirTrustPinLookup((_p) => (state.untrusted
        ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
        : null));
      return (repoPath, blockTimeoutMs) => ({
        raw: async (args) => {
          const a = Array.isArray(args) ? args : [args];
          if (a[0] === "var" && (a[1] === "GIT_AUTHOR_IDENT" || a[1] === "GIT_COMMITTER_IDENT")) state.untrusted = true;
          if (a.includes("merge") && a.includes("--no-edit")) state.mergeAttempts++;
          // `repoPath` here is the WORKTREE path (a FILE-shaped .git) — trustedMainRoot must be threaded
          // through to the real canonical repo, or every call is refused structurally regardless of the
          // deliberate fault below (mirrors mergeMainIntoWorktree's own `resolvedTrustedMainRoot` usage).
          const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv(), undefined, undefined, repo);
          return real.raw(args);
        },
      });
    }
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      unionMergeGitFactory: unionIdentityProbeTrustFlipFactory(),
    });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(A, op 1) settled, not merged, never reached the gate", r1.ok === true && r1.value?.merged === false);
    check("(A, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", r1.value?.canonicalTrustRefusal === true);
    check("(A, op 1) carries NO quarantined/dirtyWorktree/unionMergeTransient flag", !r1.value?.quarantined && !r1.value?.dirtyWorktree && !r1.value?.unionMergeTransient);
    check("(A, op 1) detailText states squash phase never reached / canonical repo untouched", /squash phase never reached, canonical repo untouched/.test(r1.value?.detailText ?? ""));
    check("(A, op 1) detailText names this a canonical-git TRUST refusal, never 'Re-task a rebase'", /TRUST refusal/.test(r1.value?.detailText ?? "") && !/Re-task a rebase/.test(r1.value?.detailText ?? ""));
    const attemptsAfterOp1 = state.mergeAttempts;

    // Simulate the human's repair of the canonical repo — branch tip and main tip stay UNCHANGED.
    registerCommondirTrustPinLookup(undefined);
    state.untrusted = false;

    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(A, op 2 — re-confirm) NOT served from the until-superseded verdict cache", r2.cacheHit === undefined);
    check("(A, op 2 — re-confirm) a REAL new merge attempt happened (count rose), not a replay", state.mergeAttempts > attemptsAfterOp1);
    check("(A, op 2 — re-confirm) genuinely re-attempted and LANDED", r2.ok === true && r2.value?.merged === true);
  }
  registerCommondirTrustPinLookup(undefined);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B) BATCH — the batch fast-forward's own `--ff-only` call is refused by a bare CanonicalGitRefusal
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    console.log("\n— (B) BATCH: a bare CanonicalGitRefusal at the batch fast-forward's --ff-only call —");
    const sfx = sfxOf("b");
    const repo = path.join(os.tmpdir(), `loom-mcvcumr-b-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    registerForCleanup(repo);
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "mcvcumr", GIT_AUTHOR_EMAIL: "mcvcumr@loom", GIT_COMMITTER_NAME: "mcvcumr", GIT_COMMITTER_EMAIL: "mcvcumr@loom" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
    fs.writeFileSync(path.join(repo, "README.md"), "# mcvcumr-b\n");
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "user.email", "mcvcumr@loom");
    git(repo, "config", "user.name", "mcvcumr");
    commitAll(repo, "init", GIT_ID);
    git(repo, "branch", "-M", "main");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const state = { ffAttempts: 0, refused: true };
    const batchFfProxyFactory = (p, ms) => {
      const real = canonicalGit(p, ms, undefined, undefined, undefined, repo);
      return {
        async raw(args) {
          const a = Array.isArray(args) ? args : [args];
          if (a.includes("merge") && a.includes("--ff-only")) {
            state.ffAttempts++;
            if (state.refused) throw new CanonicalGitRefusal("refused: a commondir redirect was detected for this repo (simulated)");
          }
          return real.raw(args);
        },
      };
    };

    const db = new Db(); openDbs.push(db);
    const projId = `mcvcumr-b-proj-${sfx}`, agentId = `mcvcumr-b-agent-${sfx}`, mgrId = `mcvcumr-b-mgr-${sfx}`;
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
      runGate: async () => ({ passed: true, steps: [] }),
      batchFfGitFactory: batchFfProxyFactory,
    });
    db.insertProject({ id: projId, name: "MCVCUMR-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // mergeBatchTracked needs AT LEAST 2 eligible candidates — with just 1, it short-circuits straight to
    // a per-candidate solo fallback ("fewer than 2 eligible candidates — batching buys nothing over a solo
    // confirm") and never reaches assembly/fast-forward at all, so this test's own fault injection (wired
    // only at the BATCH level) would never fire.
    async function addBatchWorker(tag) {
      const taskId = `mcvcumr-b-task-${tag}-${sfx}`, workerId = `mcvcumr-b-wkr-${tag}-${sfx}`;
      db.insertTask({ id: taskId, projectId: projId, title: `feat(x): batch change ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      fs.writeFileSync(path.join(worktreePath, `batch-feature-${tag}.txt`), `batch work ${tag}\n`);
      commitAll(worktreePath, `feat(x): batch change ${tag}`, GIT_ID);
      db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
      return workerId;
    }
    const workerId1 = await addBatchWorker("1");
    const workerId2 = await addBatchWorker("2");

    const r1 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    const v1 = r1.ok ? r1.value : { __unsettled: r1 };
    check("(B, op 1) refused, nothing landed", v1.ok === false && (v1.landed ?? []).length === 0);
    check("(B, op 1) carries its OWN distinct flag, canonicalTrustRefusal:true", v1.canonicalTrustRefusal === true);
    check("(B, op 1) carries NO quarantined/indexLockPresent/branchDiverted/unverified/batchHeadMoved flag", !v1.quarantined && !v1.indexLockPresent && !v1.branchDiverted && !v1.unverified && !v1.batchHeadMoved);
    check("(B, op 1) NO per-candidate fallback was started (same no-fallback posture as quarantined)", (v1.fallback ?? []).every((f) => f.started === false));
    const attemptsAfterOp1 = state.ffAttempts;

    // Simulate the human's repair — the candidate's branch tip and canonical main's tip stay UNCHANGED.
    state.refused = false;

    const r2 = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [workerId1, workerId2]), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: sessions.pendingOps });
    check("(B, op 2 — re-fire) NOT served from the until-superseded verdict cache", r2.ok === true && r2.cacheHit === undefined);
    check("(B, op 2 — re-fire) a REAL new fast-forward attempt happened (count rose), not a replay", state.ffAttempts > attemptsAfterOp1);
    const v2 = r2.ok ? r2.value : { __unsettled: r2 };
    check("(B, op 2 — re-fire) genuinely re-attempted and LANDED", v2.ok === true && (v2.landed ?? []).length === 2);
  }
} finally {
  registerCommondirTrustPinLookup(undefined);
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a structural CanonicalGitRefusal during the pre-gate union-merge (solo) or the batch " +
    "fast-forward classifies as the existing never-cached canonicalTrustRefusal/\"canonical-trust-refusal\" " +
    "outcome, never the generic cacheable \"rejected\" fallthrough, so a re-confirm/re-fire after a human " +
    "repairs the canonical repo genuinely re-attempts instead of replaying the stale refusal."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
