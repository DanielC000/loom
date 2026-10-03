import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b89681c2 (discovered from review lane 1, card 2785fbc2, m6) traced a possible false
// `pathSetStamped:true` / `mergedVerification:"pathset"`: the theory was that the batch tip's follow-up
// `git commit --amend` (Loom-Worker-Base/PathSet stamp, git/batch-merge.ts) goes through simple-git's
// `raw()`, which CAN resolve a non-zero exit with empty stderr as success (verified real, but for a
// DIFFERENT call shape: `git merge-base --is-ancestor` / `rev-parse --verify --quiet` EXIT-STATUS reads —
// see docs/decisions/bc2240d7 and 4fa36502) — so a `commit-msg`/`pre-commit` hook exiting 1 on the amend
// would leave `pathSetStamped:true` uncorrected.
//
// batch-merge-robustness.mjs's existing case (9) already proves the DOWNSTREAM handling is correct GIVEN
// a thrown amend error — but it forces that error with a MOCKED `gitFactory` that synchronously throws,
// never exercising the real git child process or a real hook at all. This file closes that gap: a REAL
// `commit-msg` hook, installed in the repo, actually fails the amend's git child, to prove (not assume)
// that the real call path rejects correctly.
//
// VERIFIED FALSE PREMISE (not fixed — nothing to fix):
//   (a) The amend (git/batch-merge.ts, `killableCanonicalRaw(... ["commit", "--amend", ...] ...)`) does
//       NOT go through simple-git's `raw()` at all. Absent a test-seam `gitFactory` (production always
//       omits it — `batchFfGitFactory` is only ever set by test constructor options, sessions/service.ts),
//       `killableCanonicalRaw` (git/bounded.ts) spawns via `spawnCanonicalGitTree`, a bespoke
//       `child_process.spawn` wrapper that BYPASSES simple-git entirely (see that function's own doc) and
//       explicitly checks `code === 0` before resolving — any non-zero exit (hook or otherwise) rejects,
//       regardless of stderr content.
//   (b) Hooks are NOT disabled on the batch merge path — docs/decisions/24c0bdba's own "Do not" section:
//       "Do not 'fix' a slow hook on the canonical/batch merge path with `--no-verify` or
//       `-c core.hooksPath=`... real projects' own commit hooks (husky, commitlint, git-lfs) keep running
//       on this exact path." Only `attemptCodexAutoCommit` (git/worktrees.ts) disables hooks, for an
//       unrelated reason (a different code path entirely).
//   (c) So the amend's rejection on hook failure is real, and `landBranchCommitsIndividually`'s catch
//       handler (git/batch-merge.ts, right after the amend call) ALREADY re-verifies by re-reading the
//       real HEAD + the landed commit's own trailer content (`parseLoomTrailerBlock`) rather than trusting
//       the call's resolution — exactly the DoD's "verify by state, not by the call resolving" shape —
//       before setting `pathSetStamped`.
//
// This file is additional REAL-HOOK regression coverage (not a fix): it proves RED-then-GREEN is not
// needed because there is no red state to produce — this is a POSITIVE test that the real path behaves
// exactly like the mocked case (9) already asserts.
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-amend-real-hook-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-bm-amend-hook-");
requireHermeticEnv();

const { createWorktree, getTaskMergedInfo, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");
const { runBatchedMerge } = await import("../dist/git/batch-merge.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmh@loom -c user.name=bmh";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const passGate = async () => ({ passed: true });

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `bm-amend-hook-proj-${sfx}`;

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# batch-merge-amend-hook\n");
  execSync(`git init -q && git config user.email bmh@loom && git config user.name bmh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranchMultiCommit(repo, label, commits) {
  const taskId = `bm-amend-hook-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  for (const { file, content, message } of commits) {
    fs.writeFileSync(path.join(worktreePath, file), content);
    commitAll(worktreePath, message, GIT_ID);
  }
  return { workerSessionId: `bm-amend-hook-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

/** A REAL `commit-msg` hook: exits 1 ONLY for a proposed message carrying `Loom-Worker-Base:` — present
 *  exclusively in the follow-up amend's message (git/batch-merge.ts), never in either plain landing
 *  commit — so the two ordinary commits land normally and only the amend's own git child fails. */
function installFailingAmendHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
  fs.writeFileSync(
    hookPath,
    "#!/bin/sh\n" +
    'if grep -q "^Loom-Worker-Base:" "$1" 2>/dev/null; then\n' +
    '  echo "simulated hook failure on the pathset amend" >&2\n' +
    "  exit 1\n" +
    "fi\n" +
    "exit 0\n",
  );
  fs.chmodSync(hookPath, 0o755);
}

try {
  // ── (A) REAL hook fails the amend's git child — pathSetStamped:false, no false "pathset" claim ────────
  {
    const repo = path.join(os.tmpdir(), `loom-bm-amend-hook-fail-${sfx}`);
    makeRepo(repo);
    installFailingAmendHook(repo);
    const multi = await cutBranchMultiCommit(repo, "fail", [
      { file: "hf-1.txt", content: "h1\n", message: "feat(test): amend-hook multi 1" },
      { file: "hf-2.txt", content: "h2\n", message: "feat(test): amend-hook multi 2" },
    ]);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-amend-hook-batch-fail-${sfx}`);

    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [multi], passGate);
    check("(A) ok:true — a real hook failing the amend degrades verification, it does NOT fail the merge", result.ok === true);
    check("(A) the branch still landed BOTH its commits (not partially, not dropped)",
      result.landed.length === 1 && result.dropped.length === 0 && git(repo, `rev-list --count ${baseMainSha}..HEAD`) === "2");
    const landed = result.landed[0];
    check("(A) pathSetStamped:false surfaces the real hook's amend failure", landed?.pathSetStamped === false);

    const body = git(repo, `log -1 --format=%B ${landed.sha}`);
    check("(A) the landed commit carries NO Loom-Worker-PathSet/-Base trailer (the amend never landed)",
      !body.includes("Loom-Worker-PathSet:") && !body.includes("Loom-Worker-Base:"));
    check("(A) the landed commit STILL carries its Loom-Worker-Branch trailer (only the follow-up amend failed)",
      body.includes(`Loom-Worker-Branch: ${multi.branch}`));
    check("(A) HEAD is the ORIGINAL (pre-amend) commit, not some corrupted/partial amend result",
      git(repo, "rev-parse HEAD") === landed.sha);

    removeWorktree(repo, multi.worktreePath);
    execSync(`git branch -D ${multi.branch}`, { cwd: repo });
    execSync("git reflog expire --expire=now --all", { cwd: repo });
    execSync("git gc --prune=now -q", { cwd: repo });
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, multi.taskId);
    check("(A) getTaskMergedInfo still resolves the branch (trailer presence alone)", board !== null && landed.sha.startsWith(board.sha));
    check("(A) verification tier degrades to \"trailer-only\" — NEVER a false \"pathset\" claim",
      board?.verification === "trailer-only");
  }

  // ── (B) POSITIVE CONTROL — same shape, hook present but never triggers condition — stamp still lands ──
  //     Proves (A)'s "trailer-only" result comes from the hook's FAILURE specifically, not from some
  //     unrelated side effect of merely having a commit-msg hook installed in the repo at all.
  {
    const repo = path.join(os.tmpdir(), `loom-bm-amend-hook-pass-${sfx}`);
    makeRepo(repo);
    // A REAL commit-msg hook that always exits 0 — exercises the same hook mechanism as (A) (hooks are
    // genuinely invoked, not absent), just never blocks.
    const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
    fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(hookPath, 0o755);
    const multi = await cutBranchMultiCommit(repo, "pass", [
      { file: "hp-1.txt", content: "p1\n", message: "feat(test): amend-hook-pass multi 1" },
      { file: "hp-2.txt", content: "p2\n", message: "feat(test): amend-hook-pass multi 2" },
    ]);
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath: batchWt } = await createWorktree(repo, projId, `bm-amend-hook-batch-pass-${sfx}`);
    const result = await runBatchedMerge(repo, batchWt, baseMainSha, [multi], passGate);
    check("(B) precondition: a non-blocking real hook still lands the stamp normally",
      result.ok === true && result.landed[0]?.pathSetStamped === true);
    const body = git(repo, `log -1 --format=%B ${result.landed[0].sha}`);
    check("(B) the landed commit carries the Loom-Worker-Base/PathSet trailers (amend succeeded)",
      body.includes("Loom-Worker-Base:") && body.includes("Loom-Worker-PathSet:"));

    removeWorktree(repo, multi.worktreePath);
    execSync(`git branch -D ${multi.branch}`, { cwd: repo });
    execSync("git reflog expire --expire=now --all", { cwd: repo });
    execSync("git gc --prune=now -q", { cwd: repo });
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, multi.taskId);
    check("(B) verification tier is \"pathset\" when the amend genuinely lands", board?.verification === "pathset");
  }
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — a REAL (not mocked) commit-msg hook failing the batch tip's Loom-Worker-Base/PathSet amend correctly surfaces pathSetStamped:false and a \"trailer-only\" verification tier, never a false \"pathset\" claim; a non-blocking real hook still lands the stamp normally."
    : `\n❌ ${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}
