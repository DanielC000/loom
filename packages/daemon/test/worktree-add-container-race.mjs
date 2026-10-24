import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure real-git exercise
// Card 83e0573a — a concurrent, Loom-UNLOCKED remover's own `git worktree prune` can delete the shared
// `$GIT_DIR/worktrees` container (git's `delete_worktrees_dir_if_empty`, confirmed on the installed
// version below) out from under a DIFFERENT, concurrent `createWorktree` add's own mkdir of its own
// entry — producing the exact fatal shapes this file reproduces and the fix recovers. Full investigation:
// `docs/decisions/83e0573a-worktree-add-container-race.md`.
//
// Uses a temp LOOM_HOME (createworktree-loom-home-guard.mjs's own chokepoint: this file calls the real
// createWorktree(/removeWorktree(, so WORKTREES_DIR — a sibling of LOOM_HOME — must be test-owned).
//
//   (1) THE LOOM-INTERNAL PAIRING: a real removeWorktree racing a real createWorktree on the same repo,
//       N iterations — with the fix, zero failures (proves (a′): every Loom-owned remover is now
//       serialized against createWorktree's own locked prune→branch→add).
//   (2) THE FS REMOVAL IS NOT UNDER THE LOCK: a stub-slow removeDir must not block a concurrent
//       createWorktree on the same repo — proves (a′) only locks the git-metadata steps, never the
//       filesystem removal that can wedge. Bounded: if a future regression moved the fs removal INSIDE
//       the lock, the concurrent createWorktree call would queue behind it — this scenario races that
//       call against a timeout short enough to fail loudly instead of hanging the test suite.
//
// NOTE: an earlier round of this card also carried a (b) — createWorktree retrying its own add once on
// two specific error shapes, as defence in depth for an EXTERNAL remover (a human/CI `git worktree
// prune`) racing a spawn. DROPPED after Code Review: real git creates the `-b` branch BEFORE making the
// worktree's own admin directory and does NOT delete that branch on a failed add, so on a fresh cut (the
// production shape) the retry's own second attempt always died with "a branch named '<branch>' already
// exists" — masking the real error instead of recovering from it. See the decision record for the full
// finding and why the external-remover case is an accepted, documented gap instead.
// Run: 1) build (pnpm build), 2) node test/worktree-add-container-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";
import { gitSubSubcommand } from "./_git-argv.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wacr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { createWorktree, removeWorktree } = await import("../dist/git/worktrees.js");
const { canonicalGit } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-wacr-repo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  execSync(`git init -q && git config user.email t@t && git config user.name t`, { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  execSync(`git -c core.autocrlf=false add -A && git -c core.autocrlf=false commit -q -m init`, { cwd: repo });
  return repo;
}

console.log(`[wacr] installed git: ${execSync("git --version").toString().trim()}`);

// ── (1) THE LOOM-INTERNAL PAIRING ──────────────────────────────────────────────────────────────────────
// A bare `Promise.allSettled([removeWorktree(...), createWorktree(...)])` does NOT reliably overlap the
// two real git CHILD PROCESSES — both sides have several git round-trips before reaching their own
// critical call (createWorktree: toplevel-guard, rev-parse-HEAD, its own internal prune, branch-list,
// THEN add; removeWorktree: at most one, unlock), so removeWorktree's prune naturally finishes well
// before createWorktree even reaches add — measured 0/60 (plain) and 0/30 (a bounded, one-way JS-level
// signal attempting to narrow the gap) against the UNFIXED code: native-process scheduling at that grain
// is finer than anything controllable from this side of two separate `git.exe` processes.
//
// So this scenario forces the SAME destructive effect `git worktree prune` performs (deleting the now-
// empty `$GIT_DIR/worktrees` container — confirmed empirically in the investigation this card's decision
// record carries) deterministically, via `removeWorktree`'s own `gitFactory` seam: its `unlock` call still
// goes through to REAL git (harmless no-op here); its `prune` call, instead of racing a second real `git`
// process, performs prune's own real-world EFFECT directly (`fs.rmSync` the container) a SHORT, CALIBRATED
// delay after `createWorktree`'s own `add` call signals it is about to fire its real child — a bare
// instant-on-signal fire (0ms) landed BEFORE the real `add` child had even started executing, measured
// 0/90 across several delays; a timing probe of the real call sequence found `add`'s own child runs for
// roughly 90ms once started, and firing the effect partway through that window (not at either edge)
// reliably lands inside it — measured 13/20 at +40ms (this scenario cycles several offsets across
// iterations for robustness against host-speed variance, never a single brittle constant). So the one
// git process genuinely under test here (`createWorktree`'s own `add`) races a REAL, synchronous
// filesystem event timed into its vulnerable window, not a second unpredictable child process.
// `createWorktree`'s own signal is fire-and-forget (it never waits on anything), so this can never
// deadlock either side.
//
// ⚠️ This probe surfaced MORE failure shapes than the two `WORKTREE_ADD_CONTAINER_RACE_RE` matches
// (`could not create directory of '.git/worktrees/`, `failed to read .../commondir`) — depending on
// exactly where in `add`'s own sequence the container vanishes, git can also report "not a git
// repository", "error: couldn't set 'HEAD'", or an `index.lock`-shaped ENOENT. All are the SAME
// underlying race; this scenario counts ANY add rejection as a hit (never narrowed to the two named
// shapes) — see this card's decision record for why (b)'s own retry regex is intentionally narrower.
//
// This is a genuine no-op on the FIXED code: `createWorktree` holds `withCanonicalIndexLock` for its
// ENTIRE prune→branch-list→add sequence, so `removeWorktree`'s own locked `prune` (now serialized behind
// it) cannot even be ATTEMPTED — let alone fire its effect — while `add`'s real child is in flight.
{
  const N = 24;
  const DELAY_OFFSETS_MS = [20, 30, 40, 50, 60, 80];
  let addFailures = 0;
  let removeFailures = 0;
  let addSignalFiredCount = 0;
  for (let i = 0; i < N; i++) {
    const repo = makeRepo(`internal-${i}`);
    const projectId = `wacr-internal-proj-${i}`;
    const wtA = await createWorktree(repo, projectId, `wacr-internal-taskA-${i}`);
    const addAboutToFire = deferred();
    const addGitFactory = (repoPath, ms) => ({
      raw: async (args) => {
        const { sub, subSub } = gitSubSubcommand(args);
        if (sub === "worktree" && subSub === "add") { addSignalFiredCount++; addAboutToFire.resolve(); } // signal only — never waits
        return canonicalGit(repoPath, ms).raw(args);
      },
    });
    const offsetMs = DELAY_OFFSETS_MS[i % DELAY_OFFSETS_MS.length];
    const removeGitFactory = (repoPath, ms) => ({
      raw: async (args) => {
        const { sub, subSub } = gitSubSubcommand(args);
        if (sub === "worktree" && subSub === "prune") {
          // TIMING-GUARD-SAFE: non-gating-settle-pause — neither wait below decides this scenario's own
          // check() outcome; that outcome is the REAL, directly-observed settlement of the real
          // `createWorktree` promise (rejected vs resolved), read via `Promise.allSettled` further down.
          // Both waits only POSITION when the injected effect two lines below fires — a shorter or longer
          // wait changes the HIT RATE (whether the race actually triggers this iteration), never HOW the
          // check evaluates truth, and the real gate (varying `offsetMs` across 50 iterations) is named
          // and lives in this scenario's own header, not in either wait's duration.
          await Promise.race([addAboutToFire.promise, new Promise((r) => setTimeout(r, 500))]); // bounded — never hangs
          await new Promise((r) => setTimeout(r, offsetMs)); // TIMING-GUARD-SAFE: non-gating-settle-pause — see the comment block above this block's first wait
          // The deterministic stand-in for prune's own real-world effect — see this scenario's header.
          fs.rmSync(path.join(repoPath, ".git", "worktrees"), { recursive: true, force: true });
          return "";
        }
        return canonicalGit(repoPath, ms).raw(args);
      },
    });
    const [removeRes, addRes] = await Promise.allSettled([
      removeWorktree(repo, wtA.worktreePath, { gitFactory: removeGitFactory }),
      createWorktree(repo, projectId, `wacr-internal-taskB-${i}`, {}, null, undefined, { gitFactory: addGitFactory }),
    ]);
    if (addRes.status === "rejected") {
      addFailures++;
      console.log(`[internal ${i}] add REJECTED: ${addRes.reason instanceof Error ? addRes.reason.message : String(addRes.reason)}`);
    }
    if (removeRes.status === "rejected") {
      // removeWorktree's own established contract is "never throws" — a rejection here would itself be
      // a regression, distinct from (and more surprising than) the add-side race this file targets.
      removeFailures++;
      console.log(`[internal ${i}] remove REJECTED (unexpected — removeWorktree's contract is never-throws): ${removeRes.reason instanceof Error ? removeRes.reason.message : String(removeRes.reason)}`);
    }
  }
  check(`(1) the add-about-to-fire stub signal actually fired on every iteration (${addSignalFiredCount}/${N} — card 7557fac7: a silent argv-shape mismatch would leave this stuck at 0, degrading the whole scenario to a bare 500ms wait that may no longer land inside the real race window)`,
    addSignalFiredCount === N);
  check(`(1) the Loom-internal (removeWorktree, createWorktree) pairing never fails the ADD across ${N} FORCED-overlap iterations (add failures: ${addFailures})`, addFailures === 0);
  check(`(1) removeWorktree itself never rejected across ${N} iterations (its own established contract)`, removeFailures === 0);
}

// ── (2) THE FS REMOVAL IS NOT UNDER THE LOCK ───────────────────────────────────────────────────────────
{
  const repo = makeRepo("slowrm");
  const projectId = "wacr-slowrm-proj";
  const wtA = await createWorktree(repo, projectId, "wacr-slowrm-taskA");
  let removeDirEntered = false;
  let removeDirFinished = false;
  const release = deferred();
  const slowRemoveDir = async (p) => {
    removeDirEntered = true;
    await release.promise; // deliberately stuck until the test below releases it
    fs.rmSync(p, { recursive: true, force: true });
    removeDirFinished = true;
    return { removed: true, killed: false };
  };
  const removePromise = removeWorktree(repo, wtA.worktreePath, { removeDir: slowRemoveDir });
  await waitUntil(() => removeDirEntered, { label: "(2) [setup] the slow removeDir has been entered" });
  // While removeWorktree is stuck inside the slow fs-rm — BEFORE it would even reach its own
  // withCanonicalIndexLock acquisition — a concurrent createWorktree on the SAME repo must complete
  // without waiting for it. Bounded by a watchdog: if a future regression moved the fs removal INSIDE
  // the lock, this createWorktree call would queue behind it and never resolve until `release` fires
  // (which this scenario deliberately holds open) — race it against a timeout so that regression FAILS
  // this check loudly instead of hanging the whole suite.
  const wtBPromise = createWorktree(repo, projectId, "wacr-slowrm-taskB");
  const watchdog = new Promise((_, reject) => setTimeout(
    () => reject(new Error("createWorktree did not complete within the 5000ms watchdog — the fs removal may have moved inside the lock, blocking a concurrent create")),
    5000,
  ));
  try {
    const wtB = await Promise.race([wtBPromise, watchdog]);
    check("(2) createWorktree completed WHILE the slow fs removal was still stuck (removeDirFinished is still false) — proves the fs rm is not under the lock", removeDirFinished === false);
    check("(2) createWorktree actually succeeded", fs.existsSync(wtB.worktreePath));
  } catch (err) {
    check(`(2) createWorktree completed within the watchdog bound — it did NOT (${err instanceof Error ? err.message : String(err)})`, false);
  }
  release.resolve();
  const removeResult = await removePromise;
  check("(2) the slow removal eventually completed too, once released", removeDirFinished === true && removeResult.removed === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
