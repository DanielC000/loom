import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 091de765 — bound the unbounded simpleGit( calls in git/reader.ts (isGitRepo/checkCommitIdentity/
// GitReader), runs/snapshot.ts (createRunSnapshot), and vault/versioner.ts's resolveVaultGitTarget
// (:724, folded in from the pre-merge review of card 9df3ea71).
//
// Every one of these five sites ALREADY had a try/catch around it (fail-safe to false/null/a default
// result) — a test that only proves a THROW is caught does NOT cover this defect: the whole point is
// that a try/catch catches a THROW and is BLIND to a HANG. So this file uses the SAME injected-hang proof
// shape as test/worktrees.mjs's (j)/(k1)/(k2) and vault-commit-hang-bound.mjs: a fake git whose relevant
// method returns a promise that NEVER settles, injected via each site's own `gitFactory` deps seam
// (mirrors git/worktrees.ts's BoundedGitDeps), asserting the call still RETURNS within its bound instead
// of hanging forever — deterministic and cross-platform, no real busy handle or hook needed.
//
// Each hang case is paired with a FAST-git positive control under the SAME tiny timeout, proving the
// bound doesn't itself break the ordinary (non-hung) path — same shape as vault-commit-hang-bound.mjs's
// Case B.
//
// Run after build: node test/bounded-git-reader-snapshot-vault.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-bounded-git-rsv-home-");

const { isGitRepo, checkCommitIdentity, GitReader } = await import("../dist/git/reader.js");
const { createRunSnapshot } = await import("../dist/runs/snapshot.js");
const { resolveVaultGitTarget } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Same slack reasoning as test/worktrees.mjs's TIMER_SLACK_MS: performance.now() is monotonic, but a
// setTimeout can fire a hair early under load.
const TIMER_SLACK_MS = 50;
const TINY_MS = 250;
// Generous upper bound for a SINGLE bounded op under TINY_MS (mirrors worktrees.mjs's own `tinyMs * 8 +
// 1500` margin for suite contention).
const SINGLE_OP_CEILING_MS = TINY_MS * 8 + 1500;
// resolveVaultGitTarget chains TWO sequential bounded checkIsRepo calls (resolveVaultRepoContext's own,
// then its own) when the first fails/hangs — double the single-op ceiling, still a small absolute cap.
const DOUBLE_OP_CEILING_MS = TINY_MS * 16 + 1500;

const scratch = mkdtempManaged("loom-bounded-git-rsv-scratch-");

// --- (1) isGitRepo — fails safe to `false`, never hangs. ---
{
  const neverGit = { checkIsRepo: () => new Promise(() => {}) }; // a hung child: never settles
  const t0 = performance.now(); // MONOTONIC
  const result = await isGitRepo(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const elapsed = performance.now() - t0;
  check("(1) isGitRepo RETURNS despite a never-resolving git op (not an infinite hang)", elapsed < SINGLE_OP_CEILING_MS);
  check(`(1) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`, elapsed >= TINY_MS - TIMER_SLACK_MS);
  check("(1) a hung checkIsRepo fails safe to false", result === false);

  // Control: a FAST (non-hung) checkIsRepo under the SAME tiny timeout still returns the real answer.
  const fastGit = { checkIsRepo: async () => true };
  const controlResult = await isGitRepo(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  check("(1c) control — a fast checkIsRepo under the same tiny bound still returns true", controlResult === true);
}

// --- (2) checkCommitIdentity — fails safe to resolvable:false, never hangs. ---
{
  const neverGit = { getConfig: () => new Promise(() => {}) };
  const t0 = performance.now();
  const result = await checkCommitIdentity(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const elapsed = performance.now() - t0;
  check("(2) checkCommitIdentity RETURNS despite a never-resolving git op (not an infinite hang)", elapsed < SINGLE_OP_CEILING_MS);
  check(`(2) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`, elapsed >= TINY_MS - TIMER_SLACK_MS);
  check("(2) a hung getConfig fails safe to resolvable:false", result.resolvable === false);

  // Control: fast getConfig + a "no origin remote" raw rejection resolve to a real, resolvable identity.
  const fastGit = {
    getConfig: async (key) => ({ value: key === "user.name" ? "Test User" : "test@example.com" }),
    raw: async () => { throw new Error("fatal: No such remote 'origin'"); },
  };
  const controlResult = await checkCommitIdentity(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  check("(2c) control — fast git under the same tiny bound resolves a real identity",
    controlResult.resolvable === true && controlResult.name === "Test User" && controlResult.email === "test@example.com");
}

// --- (3) GitReader.log() — REJECTS (bounded), never hangs. This is the site on the worker_spawn
//     dispatch path (findShippedCardMatch, sessions/service.ts) — its own try/catch degrades the
//     rejection to `null`; here we verify the REJECTION itself is bounded, which is the part that try/
//     catch alone cannot prove. ---
{
  const neverGit = { revparse: async () => "abc123", log: () => new Promise(() => {}) };
  const reader = new GitReader(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const t0 = performance.now();
  let threw;
  try { await reader.log(); } catch (e) { threw = e; }
  const elapsed = performance.now() - t0;
  check("(3) GitReader.log() REJECTS despite a never-resolving git op (not an infinite hang)", threw !== undefined);
  check(`(3) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`,
    elapsed >= TINY_MS - TIMER_SLACK_MS && elapsed < SINGLE_OP_CEILING_MS);
  check("(3) the rejection names a bound timeout (not some unrelated git error)", String(threw?.message ?? "").includes("exceeded"));

  // Control: a fast, real-shaped log() still returns the mapped commits.
  const fastGit = {
    revparse: async () => "abc123",
    log: async () => ({ all: [{ hash: "deadbeef", date: "2026-01-01", message: "chore: test", author_name: "Test" }] }),
  };
  const controlReader = new GitReader(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  const controlLog = await controlReader.log();
  check("(3c) control — a fast log() under the same tiny bound returns the real commit",
    controlLog.length === 1 && controlLog[0].hash === "deadbeef" && controlLog[0].message === "chore: test");
}

// --- (4) GitReader.branches() — REJECTS (bounded), never hangs. ---
{
  const neverGit = { branchLocal: () => new Promise(() => {}) };
  const reader = new GitReader(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const t0 = performance.now();
  let threw;
  try { await reader.branches(); } catch (e) { threw = e; }
  const elapsed = performance.now() - t0;
  check("(4) GitReader.branches() REJECTS despite a never-resolving git op (not an infinite hang)", threw !== undefined);
  check(`(4) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`,
    elapsed >= TINY_MS - TIMER_SLACK_MS && elapsed < SINGLE_OP_CEILING_MS);

  // Control: a fast branchLocal() still returns the real branch list.
  const fastGit = { branchLocal: async () => ({ current: "main", all: ["main", "loom/xyz"] }) };
  const controlReader = new GitReader(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  const controlBranches = await controlReader.branches();
  check("(4c) control — a fast branchLocal() under the same tiny bound returns the real branches",
    controlBranches.current === "main" && controlBranches.all.length === 2);
}

// --- (5) createRunSnapshot — REJECTS (bounded), never hangs. sessions/service.ts's own caller
//     (startRun) already wraps this in a try/catch that records a failed run — verified at source, not
//     re-tested here; this proves the call ITSELF is bounded, which that try/catch alone cannot. ---
{
  const neverGit = { raw: () => new Promise(() => {}) };
  const sessionId = `hang-${Date.now()}`;
  const t0 = performance.now();
  let threw;
  try {
    await createRunSnapshot(scratch, sessionId, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  } catch (e) {
    threw = e;
  }
  const elapsed = performance.now() - t0;
  check("(5) createRunSnapshot REJECTS despite a never-resolving git op (not an infinite hang)", threw !== undefined);
  check(`(5) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`,
    elapsed >= TINY_MS - TIMER_SLACK_MS && elapsed < SINGLE_OP_CEILING_MS);
  check("(5) the rejection names a bound timeout (not some unrelated git error)", String(threw?.message ?? "").includes("exceeded"));

  // Control: a fast raw() under the same tiny bound still produces the snapshot dir.
  const fastSessionId = `fast-${Date.now()}`;
  const fastGit = { raw: async () => "" };
  const snapshotDir = await createRunSnapshot(scratch, fastSessionId, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  check("(5c) control — a fast git under the same tiny bound still produces the snapshot dir", fs.existsSync(snapshotDir));
}

// --- (6) resolveVaultGitTarget (vault/versioner.ts:724, folded into this card) — fails safe to
//     {ok:false, reason:"no-repo"}, never hangs. Chains resolveVaultRepoContext's own bounded checkIsRepo
//     (which fails safe to `false` on the SAME hang, returning fast) and then this function's OWN bounded
//     checkIsRepo — so this hangs TWICE in series under the injected fake, hence the wider ceiling. ---
{
  const neverGit = { checkIsRepo: () => new Promise(() => {}) };
  const t0 = performance.now();
  const result = await resolveVaultGitTarget(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const elapsed = performance.now() - t0;
  check("(6) resolveVaultGitTarget RETURNS despite a never-resolving git op (not an infinite hang)", elapsed < DOUBLE_OP_CEILING_MS);
  check(`(6) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`, elapsed >= TINY_MS - TIMER_SLACK_MS);
  check("(6) a hung checkIsRepo fails safe to {ok:false, reason:'no-repo'}", result.ok === false && result.reason === "no-repo");

  // Control: fast checkIsRepo (both calls) + a real toplevel resolve to ok:true.
  const fastGit = { checkIsRepo: async () => true, revparse: async () => scratch };
  const controlResult = await resolveVaultGitTarget(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  check("(6c) control — a fast git under the same tiny bound resolves ok:true", controlResult.ok === true && controlResult.repoPath === path.resolve(scratch));
}

// --- (7) GitReader.show() — REJECTS (bounded), never hangs. Review finding on 0d6e4757: `show()` got the
//     type widening to `ReaderGit` but was left un-wrapped — the ONE method in this class missing
//     withTimeout. `show()` has ZERO callers anywhere in packages/daemon/src (grepped), so THIS case is
//     the only thing that will ever exercise it — the control is not optional here. ---
{
  const neverGit = { show: () => new Promise(() => {}) };
  const reader = new GitReader(scratch, { gitFactory: () => neverGit, timeoutMs: TINY_MS });
  const t0 = performance.now();
  let threw;
  try { await reader.show("HEAD"); } catch (e) { threw = e; }
  const elapsed = performance.now() - t0;
  check("(7) GitReader.show() REJECTS despite a never-resolving git op (not an infinite hang)", threw !== undefined);
  check(`(7) bounded by the timeout (${Math.round(elapsed)}ms, floor ${TINY_MS}ms)`,
    elapsed >= TINY_MS - TIMER_SLACK_MS && elapsed < SINGLE_OP_CEILING_MS);
  check("(7) the rejection names a bound timeout (not some unrelated git error)", String(threw?.message ?? "").includes("exceeded"));

  // Control: a fast show() under the same tiny bound still returns the real content.
  const fastGit = { show: async () => "commit deadbeef\n\n    a real commit\n" };
  const controlReader = new GitReader(scratch, { gitFactory: () => fastGit, timeoutMs: TINY_MS });
  const controlShow = await controlReader.show("HEAD");
  check("(7c) control — a fast show() under the same tiny bound returns the real content",
    controlShow === "commit deadbeef\n\n    a real commit\n");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — isGitRepo, checkCommitIdentity, GitReader.log()/.branches()/.show(), createRunSnapshot, " +
    "and resolveVaultGitTarget are all bounded: a genuinely never-settling git op (not merely a thrown " +
    "error, which every one of these already caught) still returns/rejects within the injected timeout, " +
    "each degrading to its documented fail-safe result, and a fast (non-hung) git call under the SAME " +
    "tiny bound still produces the real, correct result."
  : `\n❌ ${failures} FAILURE(S).`);

await finishAndExit(failures === 0 ? 0 : 1);
