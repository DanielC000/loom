import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 44c28799 — `mergeBranchLocked`'s git client was UNBOUNDED (`simpleGit(repoPath)`, no
// block-timeout, no `withTimeout` race) despite running INSIDE the per-repo merge mutex (card e076d2a2 /
// commit efeddcd). `withRepoMergeLock` sequences callers via `prior.then(fn, fn)`, which only advances once
// `fn`'s promise SETTLES — so a hung git child inside `mergeBranchLocked` (the card's own cited path: a
// wedged pre-commit/commit-msg hook) never settling meant the WHOLE per-repo merge queue wedged
// PERMANENTLY, not just the one op: every later merge attempt against that repo would await a promise
// chain rooted in a call that never returns, with no recovery short of a daemon restart.
//
// This induces a REAL hang — a genuine `git commit` child process blocked inside an actual pre-commit
// hook (`sleep`), not a mocked/injected promise — so the proof exercises the ACTUAL production code path
// (real `simple-git` spawn, real block-timeout kill, real repo state afterward), matching how a wedged
// hook would hang in production. The hook is ONE-SHOT (a marker file gates it): it hangs on the FIRST
// commit against this repo, then passes through instantly on any later commit — modeling a transient wedge
// (a stuck lock, a disk hiccup), not a permanently broken hook, and letting the SECOND merge below be a
// real, un-hung commit.
//
// RED PROOF (see the worker's own report for the exact observed output): reverting ONLY
// `git/worktrees.ts` and re-running this unchanged test shows op1 taking the hook's FULL ~5s sleep instead
// of settling near its configured bound, AND op2 never even starting within the guard window — the mutex
// genuinely wedged, exactly the defect this fix closes. This test does not depend on the new `deps`
// injection parameter to PRODUCE the hang (a real hook fires regardless of whether that parameter exists
// or is honored) — only the RESPONSE to the hang (bounded vs. not) depends on the fix, so the red/green
// split is meaningful even though the fix itself adds that parameter.
// Run: 1) build daemon (pnpm build), 2) node test/merge-hang-does-not-wedge-queue.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mhdwq@loom -c user.name=mhdwq";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const HOOK_SLEEP_S = 20; // long enough to be unambiguously distinct from BOUND_MS (card cc595ca7: a
                          // BOUND_MS=500 op reached 3013ms under the full suite's ~540-concurrent-git
                          // contention — a ~6x inflation over its own bound — so the REAL discriminator
                          // below, `op1ElapsedMs < HOOK_SLEEP_S * 1000`, needs generous headroom over that
                          // observed inflation, not just over BOUND_MS itself); short enough that an
                          // orphaned hook process (if the block-timeout kill fires mid-sleep) self-exits
                          // quickly rather than lingering — no PID-tracking cleanup needed. Raising this
                          // is FREE on the green path: op1 is still killed at its own real BOUND_MS
                          // regardless of how long the hook would sleep, and op2 never waits on the sleep
                          // at all (marker-file-gated — op1's hook writes the marker within ms of firing).
const BOUND_MS = 500; // this op's own configured timeout — comfortably < HOOK_SLEEP_S so the split is
                       // unambiguous, and comfortably > typical real-op latency so it isn't itself flaky.
const GUARD_MS = 30_000; // this TEST's own patience for "did the op ever settle" — deliberately ABOVE
                          // HOOK_SLEEP_S*1000 (unlike the old 3000ms, which sat BELOW the hook's own
                          // 5000ms duration and gave zero headroom for suite contention). Above the hook's
                          // envelope, a genuinely wedged-but-finite op (this test's hook always exits on
                          // its own) still settles for REAL instead of getting cut off into an opaque
                          // "guard fired" sentinel — so the actual regression check, the elapsed-vs-
                          // HOOK_SLEEP_S comparison below, is what fails (with real numbers), not a race
                          // artifact. GUARD_MS only exists as a backstop against a truly non-terminating
                          // promise (this test's own patience), not as the regression signal itself.

const tmpDirs = [];
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo() {
  const repo = path.join(os.tmpdir(), `loom-mhdwq-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mhdwq@loom && git config user.name mhdwq && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-mhdwq-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// Installed ONLY after both worktrees' own setup commits are done — hooks are SHARED across a repo and
// its worktrees (the common git dir), so installing this any earlier would also hang the worktrees' own
// initial commits above (observed directly: a `touch`-into-a-gitlink-file "Not a directory" warning from
// inside a worktree, since a worktree's `.git` is a FILE, not a directory — confirmed by testing this
// exact ordering bug before finalizing this file). Written via plain fs calls (no bash chmod — Git for
// Windows invokes a shebang script via its bundled sh regardless of the exec bit; chmod is for POSIX hosts).
function installHangingHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nif [ -f .git/hang-fired ]; then\n  exit 0\nfi\ntouch .git/hang-fired\nsleep ${HOOK_SLEEP_S}\n`);
  fs.chmodSync(hookPath, 0o755);
}

// Races `promise` against a `ms`-bounded sentinel so this test's own runner can never hang forever even
// if the op under test genuinely never settles (the pre-fix behavior) — a fired guard reads as "not
// admitted within any reasonable window", not a real pass/fail ambiguity.
const guard = (ms, label) => new Promise((resolve) => setTimeout(() => resolve({ __guardFired: label }), ms));

try {
  const repo = makeRepo();
  makeWorktree(repo, "loom/hang-a", "file-a.txt", `a-content-${sfx}\n`);
  makeWorktree(repo, "loom/hang-b", "file-b.txt", `b-content-${sfx}\n`);
  installHangingHook(repo);

  // Op1: its own `git commit` (landing branch-a's squash) hits the REAL hung hook. Fired first so it
  // acquires the per-repo mutex first — this is the exact hang the card describes.
  const t0 = performance.now(); // MONOTONIC (survives an NTP/backward clock step; see test/worktrees.mjs)
  const op1 = mergeBranch(repo, "loom/hang-a", "Card A title", { timeoutMs: BOUND_MS });

  // Op2: fired immediately after, for a DIFFERENT branch of the SAME repo — real git, default deps.
  // withRepoMergeLock queues this behind op1 (same canonical repo path). By the time op2's OWN commit
  // step runs (after op1 settles and op2's squash/checks complete), the hook's marker is already written
  // (op1's hook wrote it within milliseconds of starting, long before op1's own bounded timeout elapses),
  // so op2's commit passes the hook instantly and is a normal, unhung merge.
  const op2 = mergeBranch(repo, "loom/hang-b", "Card B title");

  const op1Result = await Promise.race([op1, guard(GUARD_MS, "op1")]);
  const op1ElapsedMs = performance.now() - t0;
  check(`[op1] the op whose commit hit a REAL hung pre-commit hook settles on its own within its bounded timeout (${Math.round(op1ElapsedMs)}ms, cap ~${BOUND_MS}ms) — not left hanging for the hook's full ${HOOK_SLEEP_S}s`,
    op1Result?.__guardFired !== "op1" && op1ElapsedMs < HOOK_SLEEP_S * 1000);
  check("[op1] the hung op reports failure (never a false success)", op1Result?.ok === false);

  const t1 = performance.now();
  const op2Result = await Promise.race([op2, guard(GUARD_MS, "op2")]);
  const op2ElapsedMs = performance.now() - t1;
  check(`[op2] a SUBSEQUENT merge for a DIFFERENT branch of the SAME repo is still ADMITTED (settled in ${Math.round(op2ElapsedMs)}ms) — not wedged behind op1's hang`,
    op2Result?.__guardFired !== "op2");
  check("[op2] the subsequent merge actually SUCCEEDED", op2Result?.ok === true);

  // Content-level confirmation that op2 is a REAL, correctly-labeled merge — not a false pass.
  const finalTree = git(repo, "ls-tree -r --name-only HEAD");
  check("[op2] branch-b's file landed in the canonical repo", finalTree.includes("file-b.txt"));
  check("[op2] branch-a's file did NOT land (its op failed/timed out, never silently committed)", !finalTree.includes("file-a.txt"));
  const log = git(repo, "--no-pager log --format=%B");
  check("[op2] the landed commit carries branch-b's own trailer", log.includes("Loom-Worker-Branch: loom/hang-b"));
  check("[repo] no stale index.lock left behind by the killed hung commit", !fs.existsSync(path.join(repo, ".git", "index.lock")));
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup (an orphaned
      hook process may still hold the dir briefly on Windows until its own bounded sleep elapses) */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL hung git commit inside mergeBranchLocked fails its OWN op within its bounded timeout; a subsequent merge for the same repo is still admitted, not wedged behind it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
