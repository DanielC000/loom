import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH MERGE GATE — ROLLBACK VERIFICATION (card 0d372516, Full review lane 1 finding M3): a candidate's
// own FAILED rollback (`reset --hard batchHeadBefore` inside `landBranchCommitsIndividually`) used to be
// reported as an ordinary per-candidate drop — `assembleBatchBranches` just `continue`d onto the next
// candidate against a batch worktree never actually verified clean, and `runBatchedMerge` would proceed
// straight to the gate (and, on green, the fast-forward) if an EARLIER candidate had already landed. See
// git/batch-merge.ts's own header doc and docs/decisions/0d372516-rollback-unverified-is-distinct-from-quarantined.md.
//
// REAL git on temp repos, no claude, no live daemon, no Db/SessionService — same harness shape as the
// sibling batch-merge*.mjs files. Split into its own file (rather than appended to the already
// near-ceiling batch-merge-robustness.mjs — see that file's own split history) per this card's own test
// plan.
//
// Proves:
//   (A) a rollback whose `reset --hard` call THROWS (a plain timeout/Windows-lock/CanonicalGitRefusal
//       shape, never a confirmed/unconfirmed tree-kill) aborts the WHOLE batch assembly — not just the
//       one candidate — and `runBatchedMerge` never reaches the gate.
//   (B) a rollback whose `reset --hard` call does NOT throw (reports success) but the batch worktree's
//       real HEAD is still wrong afterward is caught by the SAME unconditional post-rollback verification
//       — proving the fix checks HEAD after every rollback, not only after a thrown reset.
//   (C) card 0d372516 round 2, test gap 2(a): the post-rollback VERIFICATION PROBE itself throws (the
//       `reset --hard` call succeeds for real, but the follow-up `rev-parse HEAD` read throws) — proving
//       the `catch` at the bottom of `rollback()`'s verification block (not just a failed comparison) sets
//       `rollbackUnverified` too, since "cannot prove it clean" must fail closed exactly like "proved it
//       dirty".
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-rollback-abort.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

// Card aac489a2: this file calls the REAL production createWorktree() (imported below), which resolves
// WORKTREES_DIR as a SIBLING of LOOM_HOME (paths.ts) — a bare `node batch-merge-rollback-abort.mjs` run
// with no LOOM_HOME set would otherwise leak real worktrees into the owner's real ~/.loom-worktrees.
useOwnLoomHome("loom-bmra-parent-");
requireHermeticEnv();

const { createWorktree } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches, runBatchedMerge } = await import("../dist/git/batch-merge.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmra@loom -c user.name=bmra";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bmra-proj-${sfx}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# batch-merge-rollback-abort\n");
  execSync(`git init -q && git config user.email bmra@loom && git config user.name bmra`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, label, file, content) {
  const taskId = `bmra-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, label, GIT_ID);
  return { workerSessionId: `bmra-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

async function cutBranchMultiCommit(repo, label, commits) {
  const taskId = `bmra-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  for (const { file, content, message } of commits) {
    fs.writeFileSync(path.join(worktreePath, file), content);
    commitAll(worktreePath, message, GIT_ID);
  }
  return { workerSessionId: `bmra-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

/** A gate spy — records whether it was ever invoked, so a test can prove the gate never ran against an
 *  unverified batch worktree (the whole point of this card's fix). */
function makeGateSpy() {
  let calls = 0;
  const gate = async () => { calls++; return { passed: true }; };
  return { gate, calls: () => calls };
}

try {
  // ── (A) reset --hard THROWS — the gap the card's reviewer actually found ──────────────────────────────
  //     X1 (a), X2 (b) land cleanly. X3 (c)'s cherry-pick applies CLEANLY (no real conflict — keeps the
  //     repro deterministic and avoids also having to fake `cherry-pick --abort`), but the MANUAL `git
  //     commit` call that would land it is made to throw; the follow-up `reset --hard batchHeadBefore`
  //     rollback is ALSO made to throw a plain (non-quarantine-worthy) error. X4 (d) is an independent,
  //     non-conflicting 4th candidate included ONLY to prove the loop stopped (never attempted), not just
  //     that c was dropped.
  {
    const repo = path.join(os.tmpdir(), `loom-bmra-throw-${sfx}`);
    makeRepo(repo);
    const a = await cutBranch(repo, "ra", "rollback-a.txt", "work a\n");
    const b = await cutBranch(repo, "rb", "rollback-b.txt", "work b\n");
    const c = await cutBranch(repo, "rc", "rollback-c.txt", "work c\n");
    const d = await cutBranch(repo, "rd", "rollback-d.txt", "work d\n");
    const baseMainSha = git(repo, "rev-parse HEAD");

    function throwingResetGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args.includes("commit") && args.includes("--author") &&
              args.some((x) => typeof x === "string" && x.startsWith("rc"))) {
            throw new Error("simulated commit failure (test A)");
          }
          if (Array.isArray(args) && args.includes("reset") && args.includes("--hard")) {
            throw new Error("simulated reset --hard failure (test A, e.g. Windows lock)");
          }
          return real.raw(args);
        },
      };
    }

    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmra-batch-throw-direct-${sfx}`);
    const assembled = await assembleBatchBranches(repo, batchWt, [a, b, c, d], { gitFactory: throwingResetGitFactory });
    check("(A) a and b land", assembled.landed.length === 2 &&
      assembled.landed.every((l) => l.branch === a.branch || l.branch === b.branch));
    check("(A) exactly c is dropped", assembled.dropped.length === 1 && assembled.dropped[0].branch === c.branch);
    check("(A) c's drop reason carries the ROLLBACK FAILED annotation", assembled.dropped[0].reason.includes("ROLLBACK FAILED"));
    check("(A) d was NEVER attempted (not landed, not dropped) — the loop stopped, not just one drop",
      !assembled.landed.some((l) => l.branch === d.branch) && !assembled.dropped.some((x) => x.branch === d.branch));
    check("(A) assembleBatchBranches reports rollbackUnverified:true", assembled.rollbackUnverified === true);
    check("(A) assembleBatchBranches does NOT report quarantined (the mess is confined to this worktree, not canonical)",
      assembled.quarantined !== true);

    const { gate, calls } = makeGateSpy();
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bmra-batch-throw-run-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt2, baseMainSha, [a, b, c, d], gate, { gitFactory: throwingResetGitFactory });
    check("(A) the gate NEVER ran — never proceeds to the gate on an unverified base", calls() === 0);
    check("(A) result.ok === false", result.ok === false);
    check("(A) result.quarantined is NOT true (eligible for the ordinary per-candidate solo fallback)", result.quarantined !== true);
    check("(A) result.reason names the cause plainly for the manager-facing fallback",
      result.reason === "batch assembly aborted: a candidate's rollback could not be verified clean");
    check("(A) result.assemblyAborted is the TYPED signal (card 0d372516 round 2), never inferred from reason text",
      result.assemblyAborted === "rollback-unverified");
    check("(A) canonical main is COMPLETELY untouched", git(repo, "rev-parse HEAD") === baseMainSha);
  }

  // ── (B) reset --hard does NOT throw, but HEAD is wrong afterward ──────────────────────────────────────
  //     a2/b2 land cleanly. c2 is a MULTI-COMMIT branch: its FIRST commit lands for REAL (batch worktree
  //     HEAD genuinely advances past batchHeadBefore), then its SECOND commit's cherry-pick is made to
  //     fail (a non-conflict injected failure) — triggering rollback(). The injected `reset --hard` call
  //     reports SUCCESS without touching the real tree at all, so HEAD is left exactly where the (real,
  //     already-landed) first commit put it — NOT at batchHeadBefore. Old code's rollback() trusted a
  //     non-throwing reset outright and never re-checked; this is the exact gap the fix's unconditional
  //     post-rollback verification closes. d2 again proves the loop stopped.
  {
    const repo = path.join(os.tmpdir(), `loom-bmra-lie-${sfx}`);
    makeRepo(repo);
    const a2 = await cutBranch(repo, "la", "lie-a.txt", "work a2\n");
    const b2 = await cutBranch(repo, "lb", "lie-b.txt", "work b2\n");
    const c2 = await cutBranchMultiCommit(repo, "lc", [
      { file: "lie-c1.txt", content: "c1\n", message: "lc-commit-1" },
      { file: "lie-c2.txt", content: "c2\n", message: "lc-commit-2" },
    ]);
    const c2SecondSha = git(c2.worktreePath, "rev-parse HEAD");
    const d2 = await cutBranch(repo, "ld", "lie-d.txt", "work d2\n");
    const baseMainSha = git(repo, "rev-parse HEAD");

    let resetCalled = false;
    function lyingResetGitFactory(repoPath, blockTimeoutMs) {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args.includes("cherry-pick") && args.includes(c2SecondSha)) {
            throw new Error("simulated cherry-pick failure (test B, c2's 2nd commit)");
          }
          if (Array.isArray(args) && args.includes("reset") && args.includes("--hard")) {
            resetCalled = true;
            return ""; // reports success WITHOUT actually resetting anything — the "lie" under test
          }
          return real.raw(args);
        },
      };
    }

    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmra-batch-lie-direct-${sfx}`);
    const assembled = await assembleBatchBranches(repo, batchWt, [a2, b2, c2, d2], { gitFactory: lyingResetGitFactory });
    check("(B) precondition: the faked reset --hard actually fired", resetCalled === true);
    check("(B) a2 and b2 land", assembled.landed.length === 2 &&
      assembled.landed.every((l) => l.branch === a2.branch || l.branch === b2.branch));
    check("(B) exactly c2 is dropped", assembled.dropped.length === 1 && assembled.dropped[0].branch === c2.branch);
    check("(B) c2's drop reason carries the ROLLBACK FAILED annotation (a non-throwing reset is not proof of a clean tree)",
      assembled.dropped[0].reason.includes("ROLLBACK FAILED"));
    check("(B) d2 was NEVER attempted — the loop stopped on the unverified (lied-about) rollback",
      !assembled.landed.some((l) => l.branch === d2.branch) && !assembled.dropped.some((x) => x.branch === d2.branch));
    check("(B) assembleBatchBranches reports rollbackUnverified:true", assembled.rollbackUnverified === true);
    check("(B) assembleBatchBranches does NOT report quarantined", assembled.quarantined !== true);

    const { gate, calls } = makeGateSpy();
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bmra-batch-lie-run-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt2, baseMainSha, [a2, b2, c2, d2], gate, { gitFactory: lyingResetGitFactory });
    check("(B) the gate NEVER ran", calls() === 0);
    check("(B) result.ok === false", result.ok === false);
    check("(B) result.quarantined is NOT true", result.quarantined !== true);
    check("(B) result.reason names the cause plainly",
      result.reason === "batch assembly aborted: a candidate's rollback could not be verified clean");
    check("(B) result.assemblyAborted is the TYPED signal (card 0d372516 round 2), never inferred from reason text",
      result.assemblyAborted === "rollback-unverified");
    check("(B) canonical main is COMPLETELY untouched", git(repo, "rev-parse HEAD") === baseMainSha);
  }

  // ── (C) card 0d372516 round 2, test gap 2(a): the post-rollback VERIFICATION PROBE ITSELF throws ──────
  //     a3/b3 land cleanly. c3's own commit call is made to throw (the trigger for rollback()), the
  //     injected `reset --hard` is left to run for REAL (it succeeds — the worktree genuinely goes back to
  //     batchHeadBefore), but the FIRST `rev-parse HEAD` call made AFTER that real reset (the verification
  //     probe inside rollback(), never the earlier per-candidate pre-land probe) is made to throw. This is
  //     the `catch (e)` branch at the bottom of rollback()'s verification block — distinct from (A)/(B),
  //     which both exercise the "ran the probe, got a wrong answer" branch. d3 again proves the loop
  //     stopped.
  {
    const repo = path.join(os.tmpdir(), `loom-bmra-probe-${sfx}`);
    makeRepo(repo);
    const a3 = await cutBranch(repo, "pa", "probe-a.txt", "work a3\n");
    const b3 = await cutBranch(repo, "pb", "probe-b.txt", "work b3\n");
    const c3 = await cutBranch(repo, "probe-c", "probe-c.txt", "work c3\n");
    const d3 = await cutBranch(repo, "pd", "probe-d.txt", "work d3\n");
    const baseMainSha = git(repo, "rev-parse HEAD");

    // A FRESH `resetSucceeded` flag per call — `gitFactory` is invoked repeatedly (once per git child) for
    // BOTH the direct assembleBatchBranches() call below AND the separate runBatchedMerge() call further
    // down; a single closure-wide flag shared across both calls would leak `true` from the first call into
    // the second, making its own EARLIER (pre-rollback) rev-parse HEAD reads throw too.
    function makeProbeThrowsGitFactory() {
      let resetSucceeded = false;
      const gitFactory = (repoPath, blockTimeoutMs) => {
        const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        return {
          raw: async (args) => {
            if (Array.isArray(args) && args.includes("commit") && args.includes("--author") &&
                args.some((x) => typeof x === "string" && x.startsWith("probe-c"))) {
              throw new Error("simulated commit failure (test C)");
            }
            if (Array.isArray(args) && args.includes("reset") && args.includes("--hard")) {
              const out = await real.raw(args); // the REAL reset — succeeds, genuinely clean afterward
              resetSucceeded = true;
              return out;
            }
            if (resetSucceeded && Array.isArray(args) && args[0] === "rev-parse" && args[1] === "HEAD") {
              throw new Error("simulated rev-parse HEAD failure (test C, post-rollback verification probe)");
            }
            return real.raw(args);
          },
        };
      };
      return { gitFactory, resetSucceeded: () => resetSucceeded };
    }

    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bmra-batch-probe-direct-${sfx}`);
    const probe1 = makeProbeThrowsGitFactory();
    const assembled = await assembleBatchBranches(repo, batchWt, [a3, b3, c3, d3], { gitFactory: probe1.gitFactory });
    check("(C) precondition: the real reset --hard actually succeeded", probe1.resetSucceeded() === true);
    check("(C) a3 and b3 land", assembled.landed.length === 2 &&
      assembled.landed.every((l) => l.branch === a3.branch || l.branch === b3.branch));
    check("(C) exactly c3 is dropped", assembled.dropped.length === 1 && assembled.dropped[0].branch === c3.branch);
    check("(C) c3's drop reason carries the ROLLBACK FAILED annotation (a reset that succeeded is not proof the VERIFICATION could run)",
      assembled.dropped[0].reason.includes("ROLLBACK FAILED"));
    check("(C) d3 was NEVER attempted — the loop stopped on the unverifiable (probe-threw) rollback",
      !assembled.landed.some((l) => l.branch === d3.branch) && !assembled.dropped.some((x) => x.branch === d3.branch));
    check("(C) assembleBatchBranches reports rollbackUnverified:true (cannot prove clean fails closed, same as proving dirty)",
      assembled.rollbackUnverified === true);
    check("(C) assembleBatchBranches does NOT report quarantined", assembled.quarantined !== true);

    const { gate, calls } = makeGateSpy();
    const { worktreePath: batchWt2 } = await createWorktree(repo, projId, `bmra-batch-probe-run-${sfx}`);
    const probe2 = makeProbeThrowsGitFactory();
    const result = await runBatchedMerge(repo, batchWt2, baseMainSha, [a3, b3, c3, d3], gate, { gitFactory: probe2.gitFactory });
    check("(C) the gate NEVER ran", calls() === 0);
    check("(C) result.ok === false", result.ok === false);
    check("(C) result.quarantined is NOT true", result.quarantined !== true);
    check("(C) result.reason names the cause plainly",
      result.reason === "batch assembly aborted: a candidate's rollback could not be verified clean");
    check("(C) result.assemblyAborted is the TYPED signal (card 0d372516 round 2), never inferred from reason text",
      result.assemblyAborted === "rollback-unverified");
    check("(C) canonical main is COMPLETELY untouched", git(repo, "rev-parse HEAD") === baseMainSha);
  }
} finally {
  // No per-test worktree cleanup needed: LOOM_HOME is now a temp dir (useOwnLoomHome, above), so
  // _guard.mjs's own exit hook removes its WORKTREES_DIR sibling (where createWorktree() put everything
  // this file created) automatically — see card aac489a2.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a candidate's failed rollback (thrown OR lied-about) aborts the whole batch assembly, never proceeds to the gate on an unverified base, and stays eligible for the ordinary per-candidate solo fallback (never the quarantined/leave-for-human path)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
