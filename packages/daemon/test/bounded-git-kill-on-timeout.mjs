import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8e75ee20 — `createWorktree`'s `withCanonicalIndexLock` block (git/worktrees.ts) bounds its three
// git calls (prune/branch-list/add) with `withTimeout`, which REJECTS THE WRAPPER PROMISE on expiry but
// does NOT kill the underlying git child — the child (if still running) keeps mutating shared on-disk
// state (`.git/worktrees/`) even after the lock that's supposed to serialize access to it has released.
//
// THE TEST TRAP (this card's own DoD item 3): every existing bounded-git test in this codebase injects a
// NEVER-SETTLING fake promise as its "hung git". simple-git's own `block` timeout is an IDLE timeout (see
// [[simple-git-block-timeout-is-idle-not-elapsed]], read at source from
// node_modules/.pnpm/simple-git@3.36.0/.../timeoutPlugin) — it would never fire against such a fixture
// either, so a fixture built that way CANNOT DISTINGUISH a real total-elapsed kill from a bare
// promise-race timeout: both leave the never-settling fake exactly as unsettled as before. To prove
// anything here, the fixture must be a REAL, SLOW-BUT-TALKING child — one that keeps emitting output
// (so the idle `block` timer keeps resetting and can never be what does the killing) while a mutation it
// is responsible for is GENUINELY STILL PENDING.
//
// FIXTURE CHOICE, AND WHY NOT A HOOK ON THE MUTATING COMMAND ITSELF: `post-checkout` (the natural hook
// for `git worktree add`) fires AFTER git has already finished checking out files and writing worktree
// admin state — by the time such a hook is even running, the specific mutation card 8e75ee20 is worried
// about has ALREADY landed, so a slow post-checkout hook cannot demonstrate anything about stopping an
// in-flight mutation (verified empirically during development: killing the top-level git.exe process on
// Windows does NOT kill its hook's own child processes — an orphaned post-checkout hook keeps running
// either way, so "does the hook eventually finish" is not a discriminator at all). A PRE-commit hook is
// the correct shape instead (same idiom as test/merge-writer-index-lock.mjs): git creates `commit`'s
// pre-commit hook BEFORE the commit object/ref update happens, and that update is performed by the SAME
// git.exe process, only AFTER the hook returns — so whether the commit ever actually LANDS is a clean,
// git-native observable for "was the parent process's own pending mutation actually stopped", regardless
// of what happens to the (possibly orphaned) hook child itself.
//
// NEGATIVE-ASSERTION DISCIPLINE (fixed-wait-negative-guard.mjs / fixed-wait-witness-guard.mjs): "the
// commit never lands" is a negative claim, so it goes through `_timing-guard.mjs`'s `assertNeverWithControl`
// — a `positiveControl` first proves this exact check() CAN observe a real violation (the UNKILLED case
// really does land once its hook finishes), and the real (killed) run polls fail-fast, bounded by the
// hook's own KNOWN natural duration (never a guessed literal) — never a bare fixed sleep immediately
// followed by a one-shot check.
//
// Run: 1) build daemon (pnpm build), 2) node test/bounded-git-kill-on-timeout.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { assertNeverWithControl, pollUntil } from "./_timing-guard.mjs";

const { withTimeout, withTimeoutKillingChild, boundedSimpleGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=killtest@loom -c user.name=killtest";

const TIMEOUT_MS = 300; // tiny bound under test — our OWN kill-trigger timer.
const HOOK_TICKS = 50;
const HOOK_TICK_MS = 100; // hook emits output every 100ms — well under TIMEOUT_MS, so the IDLE `block`
                           // timer (also configured at TIMEOUT_MS) never independently fires; only a real
                           // total-elapsed kill can stop this child before it finishes on its own.
const HOOK_TOTAL_MS = HOOK_TICKS * HOOK_TICK_MS; // ~5000ms — the child's natural (uninterrupted) duration
                                                  // ON AN IDLE HOST, ~16.7x TIMEOUT_MS. This ratio (not
                                                  // TIMEOUT_MS's absolute size) is what has to survive host
                                                  // contention: under load, OUR OWN kill-trigger timer can
                                                  // itself fire late (event-loop scheduling delay, not the
                                                  // child's fault), and if it fires so late it lands AFTER
                                                  // the child would have finished naturally anyway, the
                                                  // "kill" is a no-op on an already-exited process and the
                                                  // commit legitimately lands — a real, pre-existing
                                                  // characteristic of ANY total-elapsed timer bound (see
                                                  // bounded.ts's own `withTimeout`, unchanged by this card),
                                                  // not a defect this fixture is trying to hide. A LARGE
                                                  // absolute gap between "when we intend to kill" and "when
                                                  // the child would finish anyway" is the only real defense
                                                  // (verified empirically: a 32-worker CPU-saturation
                                                  // reproduction on a 16-core host reds the OLD 300ms/2000ms
                                                  // ~6.7x ratio; this wider ratio holds under the same
                                                  // reproduction — see this card's worker_report).
const RED_POLL_WINDOW_MS = HOOK_TOTAL_MS * 3; // generous margin for the POSITIVE (RED) poll — pollUntil
                                               // fails fast the moment red-commit lands, so a wide ceiling
                                               // here costs nothing on a fast host and only buys robustness
                                               // against the hook's own execution being stretched by load.
const GREEN_POLL_WINDOW_MS = 1500; // deliberately SMALL and FIXED, NOT scaled with HOOK_TOTAL_MS: unlike
                                    // the positive poll above, a NEGATIVE poll can only return `false` by
                                    // exhausting its ENTIRE window on every passing run (there is no
                                    // "found early" exit for an absence) — so this window's cost is paid
                                    // unconditionally, every green run, forever. It can stay small because
                                    // the claim it's proving isn't actually a race — ONLY ON ONE OF
                                    // withTimeoutKillingChild's TWO rejection paths, though: PATH 1
                                    // ("(git child killed)") settles only once simple-git's
                                    // completion-detection plugin observes the child's REAL close/exit, so
                                    // the parent is CONFIRMED dead; PATH 2 (the `giveUpTimer` "...giving up
                                    // (hung git child?)" fallback) is a BARE TIMER with NO child
                                    // confirmation at all — the documented residual-risk backstop, where the
                                    // child may still be alive. A short window is only sound for path 1, so
                                    // the [green] check below asserts the actual rejection message matches
                                    // path 1 (not path 2) BEFORE this window is trusted — turning that
                                    // precondition into something this test verifies, not just claims in a
                                    // comment (card 8e75ee20 merge review).

const repo = path.join(os.tmpdir(), `loom-killtest-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
execSync(`git init -q "${repo}"`);
execSync(`git -C "${repo}" ${GIT_ID} commit -q --allow-empty -m init`);

function installSlowTalkingPreCommitHook(repoPath) {
  // A single `node` child does ALL the ticking (not a shell loop spawning `sleep`/`echo` as SEPARATE
  // processes per tick) — deliberately, after measuring the difference under load: a 50-iteration shell
  // loop forks 100 short-lived processes, and under heavy host CPU contention (verified: a 32-worker
  // CPU-saturation reproduction on a 16-core host) fork/exec latency ITSELF stretches enough per-tick to
  // blow well past even a generous multi-second polling window — a artifact of this fixture's OWN
  // process-creation overhead under load, not of anything under test. One process paying Node's own
  // (contended, but not fork-multiplied) timer delay is far more robust.
  const hookPath = path.join(repoPath, ".git", "hooks", "pre-commit");
  const nodeScript = `(async()=>{for(let i=0;i<${HOOK_TICKS};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${HOOK_TICK_MS}));}})();`;
  fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}

function commitSubjectsOnRepo(repoPath) {
  return execSync(`git -C "${repoPath}" log --format=%s`, { encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Attempt one `git commit` against the shared `repo`, fresh slow-talking hook each time. `kill:true`
 *  routes through the new abort-wired path under test; `kill:false` is today's only mechanism elsewhere
 *  in this codebase (bare `withTimeout`, no kill). Returns the settled elapsed ms, whether it rejected,
 *  and the rejection's own message (so a caller can tell WHICH of withTimeoutKillingChild's two rejection
 *  paths actually fired — see the [green] path-1 check below for why this matters). */
async function attemptCommit({ kill, message }) {
  installSlowTalkingPreCommitHook(repo);
  const t0 = performance.now(); // MONOTONIC
  let rejected = false, rejectMessage = null;
  if (kill) {
    const controller = new AbortController();
    const git = boundedSimpleGit(repo, TIMEOUT_MS, undefined, controller.signal);
    await withTimeoutKillingChild(git.raw(["commit", "--allow-empty", "-m", message]), TIMEOUT_MS, `git commit (${message})`, controller)
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
  } else {
    const git = boundedSimpleGit(repo, TIMEOUT_MS);
    await withTimeout(git.raw(["commit", "--allow-empty", "-m", message]), TIMEOUT_MS, `git commit (${message})`)
      .catch((e) => { rejected = true; rejectMessage = e?.message ?? String(e); });
  }
  return { elapsed: performance.now() - t0, rejected, rejectMessage };
}

const RED_MSG = "red-commit";
const GREEN_MSG = "green-commit";

try {
  check("[setup] baseline: exactly 1 commit (init) before either case runs",
    commitSubjectsOnRepo(repo).length === 1);

  // [setup] NEGATIVE CONTROL for the PATH 1 / PATH 2 discrimination used in the [green] check below:
  // manufacture a genuine PATH 2 (giveUpTimer) rejection — a promise that NEVER settles, with a REAL
  // AbortController whose signal is wired to nothing (so abort() is inert, exactly mimicking a child that
  // does not die on signal) — and confirm the regexes correctly classify it as path 2, NOT path 1. Without
  // this, the [green] check could be silently vacuous (e.g. a typo'd regex that never matches either
  // message) and no run would ever reveal it, since the real fixture only ever exercises path 1.
  {
    const neverSettles = new Promise(() => {});
    const inertController = new AbortController();
    let giveUpMessage = null;
    await withTimeoutKillingChild(neverSettles, 50, "negative-control", inertController, 50)
      .catch((e) => { giveUpMessage = e?.message ?? String(e); });
    const looksLikePathOne = /\(git child killed\)/.test(giveUpMessage ?? "");
    const looksLikePathTwo = /giving up \(hung git child\?\)/.test(giveUpMessage ?? "");
    check(`[setup] negative control: a manufactured give-up (path 2) rejection is classified as path 2, ` +
      `NOT path 1 — actual message: "${giveUpMessage}"`, looksLikePathTwo && !looksLikePathOne);
  }

  const result = await assertNeverWithControl({
    label: "a killed git commit never lands, even past the hook's own full natural duration",
    check: () => commitSubjectsOnRepo(repo).includes(GREEN_MSG),

    // positiveControl — bare `withTimeout` (today's only mechanism at every OTHER bounded-git call site):
    // proves THIS check() shape (a commit appearing once its hook finishes) CAN observe a real violation
    // before the real run below is trusted to prove its absence.
    positiveControl: async () => {
      const red = await attemptCommit({ kill: false, message: RED_MSG });
      check("[red] the wrapper REJECTS near the bound (not a hang)", red.rejected);
      check(`[red] settled in ${Math.round(red.elapsed)}ms (bound ${TIMEOUT_MS}ms, well under the hook's ${HOOK_TOTAL_MS}ms)`,
        red.elapsed < HOOK_TOTAL_MS / 2);
      // fail-fast poll, bounded by the hook's own KNOWN natural duration — not a guess: RED's git.exe is
      // never touched, so once its hook finishes naturally, the still-pending commit lands.
      return pollUntil(() => commitSubjectsOnRepo(repo).includes(RED_MSG), { timeoutMs: RED_POLL_WINDOW_MS, intervalMs: 50 });
    },

    // the real run — withTimeoutKillingChild + an abort-wired boundedSimpleGit.
    settle: async () => {
      const green = await attemptCommit({ kill: true, message: GREEN_MSG });
      check("[green] the wrapper REJECTS near the bound (not a hang)", green.rejected);
      check(`[green] settled in ${Math.round(green.elapsed)}ms (bound ${TIMEOUT_MS}ms, well under the hook's ${HOOK_TOTAL_MS}ms — ` +
        `proves it did NOT wait for the hook to finish naturally)`, green.elapsed < HOOK_TOTAL_MS / 2);
      // GREEN_POLL_WINDOW_MS's own doc justifies its small size on ONE precondition: the rejection came
      // from withTimeoutKillingChild's PATH 1 (`p.then(...)`, the "(git child killed)" message) — which
      // only settles once simple-git's completion-detection plugin observes the child's REAL close/exit,
      // so the parent is CONFIRMED dead. That precondition does NOT hold for PATH 2 (`giveUpTimer`, the
      // "...giving up (hung git child?)" message) — a bare timer with NO child confirmation at all, the
      // documented residual-risk backstop. A path-2 settlement gives NO deterministic guarantee the child
      // is dead, so trusting a short window on that path would be exactly the silent-pass negative-window
      // class this whole discipline exists to catch — reachable specifically under the contention this
      // card is about. So: CHECK which path actually fired before trusting the short window at all,
      // converting the precondition from an assumed comment into something this test actually verifies.
      const isPathOneKilled = /\(git child killed\)/.test(green.rejectMessage ?? "");
      const isPathTwoGaveUp = /giving up \(hung git child\?\)/.test(green.rejectMessage ?? "");
      check(`[green] settled via PATH 1 ("(git child killed)" — the child-confirmed-dead path), not the ` +
        `PATH 2 give-up fallback (no child confirmation) — actual message: "${green.rejectMessage}"`,
        isPathOneKilled && !isPathTwoGaveUp);
      // Belt-and-braces second leg (tighter than the elapsed check above, which only rules out a hang):
      // a genuine give-up would fire at TIMEOUT_MS + killGraceMs (both default to TIMEOUT_MS here) — a
      // clean path-1 settlement should land well under that.
      check(`[green] settled in ${Math.round(green.elapsed)}ms, under the give-up threshold (${TIMEOUT_MS * 2}ms) too`,
        green.elapsed < TIMEOUT_MS * 2);
      // Still poll (fail-fast, a SHORT fixed window — see GREEN_POLL_WINDOW_MS's own doc) as extra
      // robustness — nothing else in this fixture's design SHOULD be able to land the commit late, GIVEN
      // the path-1 check above just confirmed the precondition that makes this short window sound; this
      // proves that rather than assuming it.
      await pollUntil(() => commitSubjectsOnRepo(repo).includes(GREEN_MSG), { timeoutMs: GREEN_POLL_WINDOW_MS, intervalMs: 50 });
    },
  });

  check("[control] the positive control confirms this exact check() CAN observe a real violation " +
    "(red-commit landed once its own hook finished naturally)", commitSubjectsOnRepo(repo).includes(RED_MSG));
  check("[green] ✅ THE FIX: the commit NEVER lands — the real kill stopped the parent git process " +
    "before it could resume and complete the still-pending commit, even after polling past the hook's " +
    "full natural duration", result === true);
  check("[green] no OTHER unexpected commit landed either (still just init + red-commit)",
    commitSubjectsOnRepo(repo).length === 2);
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort: a killed git.exe can
    leave transient lock files; a stale orphaned hook may still hold something briefly */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — withTimeoutKillingChild actually kills a real, slow-but-talking (never-hanging) git " +
    "child on total-elapsed expiry and only settles once that child is confirmed dead, unlike a bare " +
    "withTimeout race which abandons the child and lets its pending mutation land anyway."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
