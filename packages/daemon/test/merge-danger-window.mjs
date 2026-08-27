import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 5a7692a4 DoD-3: REAL exercise of the in-process merge-danger-window tracker
// (git/merge-danger-window.ts) — a hermetic unit test that only asserts a mock was called would prove the
// wiring, not the behavior, per this card's own verification requirement. This test drives the ACTUAL
// exported functions against REAL git (mergeBranch, via temp repos/worktrees — same harness pattern as
// merge-repo-mutex.mjs) and observes the real side effect: the window entering/exiting, and
// waitForMergeDangerWindowsToClear() actually polling real state rather than sleeping a fixed duration.
//
// Covers:
//   (1) A real successful merge (squash → commit lands) leaves the window CLEARED afterward.
//   (2) A real merge that hits a genuine conflict (its own resetOrSkip cleanup runs) ALSO leaves the
//       window CLEARED afterward — the finally covers the failure path too, not just success.
//   (3) waitForMergeDangerWindowsToClear resolves near-INSTANTLY when nothing is in the window (the
//       common case — must not add latency to an ordinary shutdown).
//   (4) waitForMergeDangerWindowsToClear, given an ARTIFICIALLY-entered window, resolves EARLY (well
//       before its grace ceiling) once the window is cleared from a background timer — proving it polls
//       real state rather than blocking for the fixed duration (a fixed sleep here would be exactly the
//       unfalsifiable "cleared vs. hasn't cleared yet" shape fixed-wait-negative-guard.mjs rejects).
//   (5) waitForMergeDangerWindowsToClear, given a window that never clears, exits anyway once its grace
//       elapses (fail-open — never a hard refusal, never hangs past the ceiling).
// Run: 1) build daemon (pnpm build), 2) node test/merge-danger-window.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

// mergeBranchLocked now ALSO durably latches (merge-danger-latch.ts), which resolves its file path from
// LOOM_HOME at import time — isolate it BEFORE importing dist/git/worktrees.js (which transitively imports
// it), same reason/pattern as shutdown-marker.mjs. Without this, running this file directly (outside the
// test runner, which assigns its own LOOM_HOME per file) would write real latch files under the REAL
// ~/.loom — confirmed happening before this fix was added.
useOwnLoomHome("loom-mdw-home-");

const worktreesUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const dangerWindowUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "merge-danger-window.js")).href;
const { mergeBranch } = await import(worktreesUrl);
const { enterMergeDangerWindow, exitMergeDangerWindow, listActiveMergeDangerWindows, waitForMergeDangerWindowsToClear } = await import(dangerWindowUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mdw@loom -c user.name=mdw";
const tmpDirs = [];

function makeRepo(sfx) {
  const repo = path.join(os.tmpdir(), `loom-mdw-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mdw@loom && git config user.name mdw && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, sfx) {
  const wt = path.join(os.tmpdir(), `loom-mdw-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  // ── (1) Real success: window entered + cleared around a genuine squash→commit ────────────────────────
  {
    const sfx = `ok-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeRepo(sfx);
    makeWorktree(repo, "loom/mdw-a", "file-a.txt", `content-${sfx}\n`, sfx);

    check("[success] window empty BEFORE the merge starts", listActiveMergeDangerWindows().every((w) => w.repoPath !== repo));
    const res = await mergeBranch(repo, "loom/mdw-a", "MDW success title", {}, undefined, undefined, "op-success");
    check("[success] merge actually succeeded (sanity check on the fixture)", res.ok === true);
    check("[success] window is CLEARED after a successful merge", listActiveMergeDangerWindows().every((w) => w.repoPath !== repo));
  }

  // ── (2) Real conflict: window still entered + cleared even though the merge is REJECTED ────────────────
  {
    const sfx = `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = makeRepo(sfx);
    fs.writeFileSync(path.join(repo, "README.md"), `base\n`);
    execSync(`git add -A && git ${GIT_ID} commit -q -m "base readme"`, { cwd: repo });
    // Branch off the SAME base, THEN diverge both sides — README.md changes on BOTH main and the branch
    // since that common divergence point → a guaranteed real merge conflict (same recipe + ordering as
    // merge-gate.mjs's project C: worktree created BEFORE main moves, or main's own later edit is never
    // actually divergent from the branch's fork point).
    const wt = makeWorktree(repo, "loom/mdw-b", "other.txt", `content-${sfx}\n`, sfx);
    fs.writeFileSync(path.join(wt, "README.md"), "branch version\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "branch readme"`, { cwd: wt });
    fs.writeFileSync(path.join(repo, "README.md"), "main version\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "main readme"`, { cwd: repo });

    const res = await mergeBranch(repo, "loom/mdw-b", "MDW conflict title", {}, undefined, undefined, "op-conflict");
    check("[conflict] merge actually reports a conflict (sanity check on the fixture)", res.ok === false && res.conflict === true);
    check("[conflict] window is CLEARED after a rejected (conflict) merge too", listActiveMergeDangerWindows().every((w) => w.repoPath !== repo));
    check("[conflict] canonical repo left clean by the conflict's own cleanup", execSync("git status --porcelain", { cwd: repo }).toString().trim() === "");
  }

  // ── (3) waitForMergeDangerWindowsToClear: nothing active resolves near-instantly ────────────────────────
  {
    const start = Date.now();
    await waitForMergeDangerWindowsToClear(5_000);
    const elapsed = Date.now() - start;
    check(`[wait/empty] resolves near-instantly when nothing is active (took ${elapsed}ms, expected < 500ms)`, elapsed < 500);
  }

  // ── (4) waitForMergeDangerWindowsToClear: POLLS real state — clears early, not after the full grace ────
  {
    const repo = "/tmp/loom-mdw-fake-repo-for-wait-test";
    enterMergeDangerWindow(repo, "loom/fake-branch", "op-wait-clears");
    check("[wait/clears-early] window is active immediately after entering", listActiveMergeDangerWindows().some((w) => w.repoPath === repo));
    const clearAfterMs = 400;
    setTimeout(() => exitMergeDangerWindow(repo), clearAfterMs);
    const start = Date.now();
    await waitForMergeDangerWindowsToClear(5_000); // grace is 5s; the window clears after ~400ms
    const elapsed = Date.now() - start;
    check(
      `[wait/clears-early] resolved AFTER the real clear (~${clearAfterMs}ms) and well BEFORE the 5000ms grace ceiling (took ${elapsed}ms) — proves polling, not a fixed sleep`,
      elapsed >= clearAfterMs - 50 && elapsed < 5_000,
    );
    check("[wait/clears-early] window is gone after the wait resolves", listActiveMergeDangerWindows().every((w) => w.repoPath !== repo));
  }

  // ── (5) waitForMergeDangerWindowsToClear: fail-open — exits at the grace ceiling if never cleared ───────
  {
    const repo = "/tmp/loom-mdw-fake-repo-never-clears";
    enterMergeDangerWindow(repo, "loom/fake-branch-2", "op-wait-hangs");
    const graceMs = 500;
    const start = Date.now();
    await waitForMergeDangerWindowsToClear(graceMs);
    const elapsed = Date.now() - start;
    check(
      `[wait/never-clears] resolves at (not before, not long after) the grace ceiling ${graceMs}ms (took ${elapsed}ms)`,
      elapsed >= graceMs - 20 && elapsed < graceMs + 500,
    );
    check("[wait/never-clears] the window is STILL marked active — waiting never silently clears it itself", listActiveMergeDangerWindows().some((w) => w.repoPath === repo));
    exitMergeDangerWindow(repo); // cleanup for this test process
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — merge-danger-window tracks real squash/commit windows and waitForMergeDangerWindowsToClear polls real state, bounded and fail-open."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
