import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision c395b4fb — the residue-clear block's reset-merge failure must never say "squash was
// attempted … Re-task a rebase"; it has its own honest flag, distinct from a trust refusal at the SAME
// call site.
//
// PROVES: (1) an ORDINARY clear failure ⇒ preSquashResidueUnclearable + residuePossible, residue left
// unchanged; (2) a REAL CanonicalGitRefusal at the SAME site ⇒ canonicalTrustRefusal instead; (3)
// confirmWorkerMerge's own new branch never reaches the generic fallthrough; (4) NEVER_CACHED_OUTCOMES
// membership is load-bearing here (pre-squash, HEAD never moves ⇒ op2's identity equals op1's): op1
// refuses, the real residue clears, op2 genuinely RE-ATTEMPTS and LANDS, never replaying op1's
// rejection. Narrative: docs/decisions/c395b4fb-residue-flags-and-pre-squash-trust-refusal-sites.md
// ("Test design").
//
// RED/GREEN: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts
// --file packages/daemon/src/sessions/service.ts --test
// packages/daemon/test/merge-pre-squash-residue-unclearable.mjs --ref 16af28e9`.
// Run: pnpm build, then node test/merge-pre-squash-residue-unclearable.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

useOwnLoomHome("loom-psru-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { mergeBranch, createWorktree } = await import("../dist/git/worktrees.js");
const { registerCommondirTrustPinLookup, canonicalGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=psru@loom -c user.name=psru";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const confirmTracked = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000 });

function freshDir(tag) {
  const dir = path.join(os.tmpdir(), `loom-psru-${tag}-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  registerForCleanup(dir);
  return dir;
}
function gitAllowFail(cwd, args) { try { execFileSync("git", args, { cwd, stdio: "pipe" }); return 0; } catch (e) { return e.status ?? 1; } }
function gitMaybe(cwd, args) { try { return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim(); } catch { return ""; } }

/** A real, unresolved merge conflict directly in the canonical checkout — MERGE_HEAD set, unmerged
 *  entries present — mirroring merge-mergehead-residue-preserves-unstaged.mjs's own scenario (A) setup.
 *  Deliberately left UNRESOLVED (never `git merge --abort`'d) so mergeBranch's residue-clear block
 *  encounters a genuine affirmative signal. */
function makeConflictedRepo(tag) {
  const repo = freshDir(`repo-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "psru@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "psru"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
  commitAll(repo, "base", GIT_ID);
  execFileSync("git", ["checkout", "-qb", "side-conflict"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "conflict.txt"), "side-change\n");
  commitAll(repo, "side", GIT_ID);
  execFileSync("git", ["checkout", "-q", "-"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "conflict.txt"), "main-change\n");
  commitAll(repo, "main-conflicting", GIT_ID);
  const mergeExit = gitAllowFail(repo, ["-c", "user.email=psru@loom", "-c", "user.name=psru", "merge", "side-conflict", "--no-edit"]);
  if (mergeExit === 0) throw new Error(`setup error: the direct merge did not conflict (tag=${tag})`);
  if (gitMaybe(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) === "") throw new Error(`setup error: MERGE_HEAD not set (tag=${tag})`);
  if (execFileSync("git", ["ls-files", "--unmerged"], { cwd: repo }).toString() === "") throw new Error(`setup error: no unmerged entries (tag=${tag})`);
  // A target branch mergeBranch can resolve via resolveBranchTip — never reached as far as the squash in
  // either scenario, since both refuse inside the residue-clear block, before the squash.
  execFileSync("git", ["branch", "loom/psru-target"], { cwd: repo });
  return repo;
}

/** Delegates every call to the REAL canonicalGit, except the targeted `git reset --merge HEAD` call,
 *  which throws a PLAIN ordinary Error — never shaped like a confirmed/unconfirmed kill, never a
 *  RepoQuarantinedError, never a CanonicalGitRefusal. */
function ordinaryResetMergeFailureFactory() {
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const argv = Array.isArray(args) ? args : [args];
      if (argv[0] === "reset" && argv.includes("--merge")) {
        throw new Error("simulated ordinary git failure: reset --merge HEAD");
      }
      const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}

/** Flips `untrusted` the first time the targeted `reset --merge HEAD` call is seen, delegating every
 *  call (including that one) to the real canonicalGit, which re-checks trust fresh each time. */
function trustFlipOnResetMergeFactory() {
  let untrusted = false;
  registerCommondirTrustPinLookup((_p) => (untrusted
    ? { toplevel: "C:\\fake\\pinned", pinnedAt: "2026-01-01T00:00:00.000Z", source: "bind", projectId: "p", repoKey: "r" }
    : null));
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const argv = Array.isArray(args) ? args : [args];
      if (!untrusted && argv[0] === "reset" && argv.includes("--merge")) untrusted = true;
      const real = canonicalGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return real.raw(args);
    },
  });
}

try {
  // ── (1) ORDINARY FAILURE — preSquashResidueUnclearable + residuePossible ──────────────────────────
  {
    console.log("\n— (1) the residue-clear call fails ordinarily: preSquashResidueUnclearable + residuePossible —");
    const repo = makeConflictedRepo("1");
    const result = await mergeBranch(repo, "loom/psru-target", "Fix 1", { gitFactory: ordinaryResetMergeFailureFactory() });
    check("(1) refused, never merged", result.ok === false);
    check("(1) carries preSquashResidueUnclearable:true", result.preSquashResidueUnclearable === true);
    check("(1) carries residuePossible:true (residue IS present — no squash attempted does not mean nothing changed)", result.residuePossible === true);
    check("(1) is NOT quarantined/transient (an ordinary failure, not a kill/quarantine)", !result.quarantined && !result.transient);
    check("(1) is NOT the structural canonicalTrustRefusal (a different cause)", result.canonicalTrustRefusal !== true);
    check("(1) reason says no squash was attempted", /no squash was attempted/.test(result.reason ?? ""));
    check("(1) reason says residue is present", /residue is present/.test(result.reason ?? ""));
    check("(1) reason names the human remedy (git merge --abort / git status)", /git merge --abort/.test(result.reason ?? "") && /git status/.test(result.reason ?? ""));
    check("(1) reason says a rebase will not help", /a rebase will not help/.test(result.reason ?? ""));
    check("(1) never says 'squash was attempted' in the OLD misleading sense (no 'but never committed')", !/squash was attempted but never committed/.test(result.reason ?? ""));
    // The real conflict residue is genuinely unchanged — the fake factory's throw means the real `git
    // reset --merge HEAD` never ran against this repo at all.
    check("(1) MERGE_HEAD is still set (the clear genuinely never ran)", gitMaybe(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) !== "");
    check("(1) unmerged entries still present", execFileSync("git", ["ls-files", "--unmerged"], { cwd: repo }).toString() !== "");
  }

  // ── (2) TRUST REFUSAL AT THE SAME SITE — canonicalTrustRefusal, never preSquashResidueUnclearable ──
  {
    console.log("\n— (2) the SAME residue-clear call instead hits a real structural trust refusal —");
    const repo = makeConflictedRepo("2");
    const result = await mergeBranch(repo, "loom/psru-target", "Fix 2", { gitFactory: trustFlipOnResetMergeFactory() });
    check("(2) refused, never merged", result.ok === false);
    check("(2) carries canonicalTrustRefusal:true", result.canonicalTrustRefusal === true);
    check("(2) is NOT preSquashResidueUnclearable (a different cause at the same call site)", result.preSquashResidueUnclearable !== true);
    check("(2) is NOT quarantined/transient", !result.quarantined && !result.transient);
    check("(2) never says 'squash was attempted'", !/squash was attempted/.test(result.reason ?? ""));
    check("(2) never says 'Re-task a rebase'", !/Re-task a rebase/.test(result.reason ?? ""));
    check("(2) reason carries the structural refusal's own text", /canonicalGit: refusing/.test(result.reason ?? ""));
    registerCommondirTrustPinLookup(undefined);
  }

  // ── (3) SERVICE.TS WORDING — confirmWorkerMerge's own new branch ─────────────────────────────────
  {
    console.log("\n— (3) confirmWorkerMerge's own preSquashResidueUnclearable branch avoids the generic fallthrough —");
    const sfx = `3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeConflictedRepo(sfx);
    const db = new Db(); openDbs.push(db);
    const mgrId = `psru-mgr-${sfx}`, projId = `psru-p-${sfx}`, taskId = `psru-t-${sfx}`, workerId = `psru-w-${sfx}`;
    db.insertProject({ id: projId, name: "PSRU", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-psru-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-psru-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertAgent({ id: `agent-psru-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    // Worker cut from the (already-conflicted) canonical repo's current checked-out tip — its own content
    // never matters here: confirmWorkerMerge refuses inside the residue-clear block, before the squash.
    const wt = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work");
    commitAll(wt.worktreePath, "feature", GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: "PSRU-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: projId, agentId: `agent-psru-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, soloMergeGitFactory: ordinaryResetMergeFailureFactory() });
    const confirm = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(3) refused, never merged", confirm.merged === false);
    check("(3) carries preSquashResidueUnclearable:true", confirm.preSquashResidueUnclearable === true);
    check("(3) detailText never says 'squash was attempted ... Re-task a rebase' (the generic fallthrough)", !/squash was attempted but never committed/.test(confirm.detailText ?? "") && !/Re-task a rebase/.test(confirm.detailText ?? ""));
    check("(3) detailText says residue is present (never 'canonical repo untouched')", /residue is present/.test(confirm.detailText ?? ""));
    check("(3) detailText says worktree retained", /worktree retained/.test(confirm.detailText ?? ""));
  }

  // ── (4) NEVER_CACHED_OUTCOMES — op1 refuses, residue clears for real, op2 re-attempts and lands ────
  // Code Review round 2, finding 3 (minor, but load-bearing here): this refusal is PRE-SQUASH and
  // `git merge --abort` doesn't move HEAD, so op1's and op2's `verdictIdentity` (branch tip + main tip)
  // are IDENTICAL by construction — the ONLY thing that can make op2 genuinely re-attempt instead of
  // replaying op1's cached rejection is `pre-squash-residue-unclearable`'s membership in
  // `NEVER_CACHED_OUTCOMES`. Mirrors merge-confirm-canonical-trust-refusal.mjs's own part (B).
  {
    console.log("\n— (4) NEVER_CACHED_OUTCOMES: op1 refuses, the real residue clears, op2 re-attempts and lands —");
    const sfx = `4-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeConflictedRepo(sfx);
    const db = new Db(); openDbs.push(db);
    const mgrId = `psru-mgr-${sfx}`, projId = `psru-p-${sfx}`, taskId = `psru-t-${sfx}`, workerId = `psru-w-${sfx}`;
    db.insertProject({ id: projId, name: "PSRU4", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `agent-psru4-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-psru4-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertAgent({ id: `agent-psru4-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    // A CLEAN, non-conflicting worker change — once the real residue genuinely clears on op2, the
    // squash must actually be able to land.
    const wt = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(wt.worktreePath, "feature4.txt"), "worker 4 work\n");
    commitAll(wt.worktreePath, "feature 4", GIT_ID);
    db.insertTask({ id: taskId, projectId: projId, title: "PSRU4-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: workerId, projectId: projId, agentId: `agent-psru4-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, soloMergeGitFactory: ordinaryResetMergeFailureFactory() });

    const r1 = await confirmTracked(sessions, mgrId, workerId);
    check("(4) op1: refused via preSquashResidueUnclearable (a genuine fresh mint)", r1.ok === true && r1.value?.merged === false && r1.value?.preSquashResidueUnclearable === true);
    check("(4) op1: the real residue is still present (the fake factory never ran the real clear)", gitMaybe(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) !== "");

    // Clear the fault — the actual remedy: the FACTORY override comes off, so the next attempt's
    // `git reset --merge HEAD` is the REAL one, genuinely clearing the real conflict residue.
    sessions.soloMergeGitFactory = undefined;
    const r2 = await confirmTracked(sessions, mgrId, workerId);
    check("(4) op2: genuinely re-attempted and LANDED (not a replayed rejection)", r2.ok === true && r2.value?.merged === true);
    check("(4) THE NEVER-CACHED PROOF (structural): op2 carries NO cacheHit — pre-squash-residue-unclearable is excluded from the until-superseded cache", r2.cacheHit === undefined);
    check("(4) the real content actually landed in the canonical repo", fs.existsSync(path.join(repo, "feature4.txt")));
    check("(4) the residue genuinely cleared (MERGE_HEAD gone)", gitMaybe(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) === "");
  }
} finally {
  registerCommondirTrustPinLookup(undefined);
  for (const db of openDbs) { try { db.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the residue-clear call's ordinary failure classifies as preSquashResidueUnclearable with honest wording, a trust refusal at the same site classifies separately as canonicalTrustRefusal, and confirmWorkerMerge's own new branch never reaches the generic merge_failed/\"Re-task a rebase\" fallthrough."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
