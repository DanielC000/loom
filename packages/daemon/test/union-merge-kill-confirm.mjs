import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7e5b23e7 (Code Review follow-up of 24c0bdba, reviewer 1524daa5) — `mergeMainIntoWorktree`'s two
// mutating merge calls (the plain union's `merge --no-edit`, the HELD-branch owed-landing's
// `merge --ff-only`) ran on a bare `withTimeout`, the SAME class of bug `24c0bdba` already fixed for the
// canonical landing path (`mergeBranchLocked`/`fastForwardCanonicalMain`): on expiry, `withTimeout`
// rejects INDEPENDENTLY of the real git child, so an orphaned child can keep running and move the branch
// tip (or finish the owed-landing fast-forward) well after this function already reported `ok:false`.
//
// A REAL specimen (op `d64d890e`, lead gen 389, 2026-10-02) hit exactly this: under 5-worker build load,
// the union-merge was rejected with "exceeded 15000ms (hung git child?)", but the worktree was found
// clean moments later with a REAL, completed merge commit — the generic 15s floor was simply too tight
// under genuine host load, not actually hung.
//
// The fix (see docs/decisions/7e5b23e7-kill-confirm-worker-worktree-union-merge.md for the full design):
//   1. Both mutating calls route through `killableCanonicalRaw`, kill-confirmed, with `quarantineRepoPath`
//      pinned to the CANONICAL repo (this worktree shares its hooks dir + object database — same hazard
//      `merge-quarantine.ts`'s own header already documents for a batch worktree).
//   2. A CONFIRMED-kill timeout is verified against the worktree (merge-base/HEAD) before being reported
//      as a failure — catching a merge that actually landed right at the kill boundary.
//   3. A dedicated 45s floor (`UNION_MERGE_TIMEOUT_FLOOR_MS`) applies to just these two calls, plus ONE
//      bounded retry gated on (i) a confirmed-kill timeout, (ii) verify-landed said no, (iii) the worktree
//      is independently re-verified back at its own pre-attempt state.
//   4. An UNCONFIRMED kill quarantines the CANONICAL repo (never retried, never further mutated) — every
//      later merge on that repo is refused until a human clears it.
//
// This file proves the GREEN side of all of this (the historical RED proof — a real orphaned commit
// landing after a reported failure, against the pre-fix bare-`withTimeout` code — was reproduced once by
// hand against the pre-fix `dist/git/worktrees.js`, per the project's RED-first doctrine; not re-run here,
// mirroring merge-commit-kill-confirm.mjs's own "historical, never re-run" posture for the identical
// class of proof). One gotcha hit while reproducing it, worth recording for whoever re-derives this: the
// slow hook MUST emit output on every tick (`console.log`) — simple-git's own `block` idle-timeout
// (`boundedSimpleGit`'s own doc) silently kills a hook producing NO output at all, which masks the bug
// (the orphan never gets the chance to survive long enough to land) regardless of the bare-`withTimeout`
// bug being present. Every hook below already does this.
//
// `UNION_MERGE_TIMEOUT_FLOOR_MS` would otherwise force every real-spawn case here to wait out a REAL 45s+
// floor — `BoundedGitDeps.unionMergeTimeoutFloorMs` (card 7e5b23e7, TEST SEAM ONLY) shrinks it so this
// suite settles in seconds, not minutes, while still exercising the REAL kill-confirm spawn path (never
// `deps.gitFactory`, which has no real child to kill at all).
//
// Run: 1) build daemon (pnpm build), 2) node test/union-merge-kill-confirm.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pollUntil, assertNeverWithControl } from "./_timing-guard.mjs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeMainIntoWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { activeMergeQuarantineFor, assertRepoNotQuarantined } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID_ARGV = ["-c", "user.email=unionkc@loom", "-c", "user.name=unionkc"];
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// Card ad72086b (2026-10-06): a real in-gate run (op 4304c43e) saw the [no-retry] case's confirmed-kill
// timeout misclassified as UNCONFIRMED — "exceeded 1200ms, killed, but did not die within 1200ms —
// giving up" — under ordinary host load (CPU ~49%, other workers' own targeted tests sharing the box).
// Root cause (verified directly, reproduced below): on win32, `spawnCanonicalGitTree`'s close handler
// treats a tree-kill as confirmed only once `killGateProcessTree`'s own `taskkill /T /F` subprocess has
// been spawned, scheduled, and awaited to completion — a REAL child process, subject to the SAME OS
// scheduling delay as everything else on a contended host. The outer `withTimeoutKillingChild` give-up
// timer fires at a fixed `ms + killGraceMs` measured from this call's own start, independent of how long
// that confirmation round-trip actually takes — so a kill-confirm window tight enough to keep a
// quiet-host suite fast leaves near-zero slack for taskkill's own real-world latency once the host is
// even moderately busy.
//
// `KILL_CONFIRM_WINDOW_MS` is the ONE lever this card widens — `unionMergeTimeoutFloorMs` forces
// `mergeTimeoutMs = Math.max(timeoutMs, floor) = KILL_CONFIRM_WINDOW_MS` (both pinned to the same value),
// and `killGraceMs` defaults to that SAME value inside `withTimeoutKillingChild` — so one failed
// attempt's worst case is ~2×KILL_CONFIRM_WINDOW_MS. Deliberately NOT a single constant every other wait
// in the file scales off of (a first attempt at this fix raised one `SMALL_MS` shared by the kill window
// AND every hook's own artificial sleep duration, which made the whole file blow its 120s default
// per-file budget under a full, scripts-touching gate — see this card's own history/worker_report for
// that incident). `HOOK_OVERRUN_MS` below is a SEPARATE, fixed margin the slow-hook fixtures must outlast
// the kill timer by, independent of how large `KILL_CONFIRM_WINDOW_MS` needs to be for robustness.
//
// RE-PRODUCED (not just theorized): a synthetic CPU-contention run (28 busy-loop processes on a 16-core
// host) turned this same give-up-too-early shape into a 5/5 failure rate at the old 1200ms window,
// including GREEN-1 itself (not just NO-RETRY) and the GREEN-1 positive control (a real, unkilled git
// merge) missing its own generous settle window. Sized from this card's own moderate-load measurements
// (a more realistic ~50%-CPU synthetic load, matching the incident's reported ~49% CPU — see this card's
// worker_report for the full standalone + under-load timing counts against the file's 120s budget).
const KILL_CONFIRM_WINDOW_MS = 3_000;
const HOOK_OVERRUN_MS = 3_000;
// Every slow-hook fixture below runs this many ticks of this size — total duration
// (HOOK_TICKS × HOOK_TICK_MS) exceeds KILL_CONFIRM_WINDOW_MS by HOOK_OVERRUN_MS, so the real kill always
// lands mid-hook rather than after it would have finished naturally. Ticks stay frequent (console.log on
// every one) well under KILL_CONFIRM_WINDOW_MS so simple-git's own idle `block` timeout (this file's own
// header comment) never mistakes the hook for hung before the REAL kill timer gets a chance to fire.
const HOOK_TICKS = 10;
const HOOK_TICK_MS = Math.ceil((KILL_CONFIRM_WINDOW_MS + HOOK_OVERRUN_MS) / HOOK_TICKS);
const HOOK_TOTAL_MS = HOOK_TICKS * HOOK_TICK_MS;
const DEPS = { timeoutMs: KILL_CONFIRM_WINDOW_MS, unionMergeTimeoutFloorMs: KILL_CONFIRM_WINDOW_MS };
// A fully `gitFactory`-mocked scenario spawns no real child at all — `killableCanonicalRaw` takes the
// plain-`withTimeout` branch, never `withTimeoutKillingChild`, so none of these six scenarios (RETRY,
// ALLOWRETRY-FALSE, QUIT-FAILURE, UNREADABLE-MERGE-HEAD, PRECONDITION-FALSE-A/B) exercises the real
// win32-taskkill robustness this card widens `KILL_CONFIRM_WINDOW_MS` for. Reusing that (now large) value
// for them only pads the suite's wall-clock cost for nothing — a small, fixed, independent timeout
// resolves the SAME mocked promises just as deterministically.
const MOCK_TIMEOUT_MS = 500;
const MOCK_DEPS = { timeoutMs: MOCK_TIMEOUT_MS, unionMergeTimeoutFloorMs: MOCK_TIMEOUT_MS };
const BRANCH = "loom/union-kc-test";

// A clean canonical repo + ONE worker worktree, with canonical main advanced past the worktree's fork
// point by a commit the branch does NOT touch (a clean, conflict-free union every time).
function makeRepoAndWorktree(tag) {
  const repo = mkdtempManaged(`loom-unionkc-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "unionkc@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "unionkc"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "untouched.txt"), "untouched\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "init"], { cwd: repo });

  const wt = mkdtempManaged(`loom-unionkc-wt-${tag}-`);
  execFileSync("git", ["worktree", "add", "-q", "-b", BRANCH, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "branch-file.txt"), "branch content\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "branch work"], { cwd: wt });

  fs.writeFileSync(path.join(repo, "main-file.txt"), "main content\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "main advance"], { cwd: repo });

  return { repo, wt };
}

// Always-slow PRE-MERGE-COMMIT hook (fires on EVERY merge commit attempt, including a retry) — shared
// `.git/hooks` dir, since the worktree above is a LINKED worktree of `repo`. VERIFIED directly against
// real git 2.47: a clean, auto-resolving `git merge --no-edit` invokes `pre-merge-commit`, NOT
// `pre-commit`/`post-commit` (those are `git commit`-specific) — confirmed by a throwaway repro before
// writing this file (a hook named `pre-commit` here silently never fires at all).
// `counterFile`, when given, has ONE LINE APPENDED to it on every invocation of this hook — the real HEAD
// at THAT invocation's own start — a real merge-invocation COUNTER (via `readAttemptHeads` below: its
// array length, never an elapsed-time heuristic — "did it retry?" is answered by how many times the hook
// actually ran, not by how long the call took, which host load can stretch unpredictably either way) that
// ALSO doubles as a MARKER: a test can confirm a 2nd attempt's own recorded HEAD matches the 1st's (and the
// known pre-attempt HEAD), proving the retry fired at the SAME, unmoved tip — never after some stray
// commit had landed in between.
function installAlwaysSlowPreMergeCommitHook(repo, ticks, tickMs, counterFile) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-merge-commit");
  const nodeScript = `(async()=>{for(let i=0;i<${ticks};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${tickMs}));}})();`;
  const counterLine = counterFile ? `git rev-parse HEAD >> "${counterFile}"\n` : "";
  fs.writeFileSync(hookPath, `#!/bin/sh\n${counterLine}node -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}
/** Reads the hook's own marker file back: one HEAD sha per real invocation, oldest first. */
function readAttemptHeads(counterFile) {
  if (!fs.existsSync(counterFile)) return [];
  return fs.readFileSync(counterFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
// A slow POST-MERGE hook: for `git merge --no-edit`, the merge commit (HEAD move) happens BEFORE
// `post-merge` ever runs — so a kill DURING this hook's own run is a kill of a child whose real work (the
// merge) already landed. This is the deterministic (non-racy) way to exercise verify-landed. VERIFIED
// directly: a clean auto-resolving merge invokes `post-merge`, never `post-commit`.
function installSlowPostMergeHook(repo, ticks, tickMs) {
  const hookPath = path.join(repo, ".git", "hooks", "post-merge");
  const nodeScript = `(async()=>{for(let i=0;i<${ticks};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${tickMs}));}})();`;
  fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}
// Code Review repro shape reused from merge-commit-kill-confirm.mjs's own scenario 5 (round 3, B-2): the
// OUTER subshell backgrounds an INNER one and returns immediately, breaking the parent-child chain a
// PPID-walking tree-kill relies on — the escaped descendant survives the kill, so confirmation can never
// positively arrive within grace.
function installDoubleForkedPreMergeCommitHook(repo, markerName, holdMs, mainMs) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-merge-commit");
  fs.writeFileSync(hookPath,
    `#!/bin/sh\n( (sleep ${holdMs / 1000}; echo escaped > ${markerName}) & )\nsleep ${mainMs / 1000}\n`);
  fs.chmodSync(hookPath, 0o755);
}
function removeHooks(repo) {
  for (const name of ["pre-merge-commit", "post-merge"]) {
    fs.rmSync(path.join(repo, ".git", "hooks", name), { force: true });
  }
}

const tag = `${process.pid}-${Date.now()}`;

// ── GREEN 1 — confirmed kill, fails cleanly, no quarantine. The merge's own staged content USUALLY
//    survives the abort (see the note below — a real, VERIFIED git property, not a bug), so the retry
//    gate USUALLY declines and this settles after exactly ONE attempt. MEASURED (card 7e5b23e7 round 2,
//    via this file's own hook-invocation counter): under heavy host load one real run out of five instead
//    saw the kill land AFTER the hook had already returned a failing exit code — the "hook failed, save
//    MERGE_HEAD" branch DOES then run, `merge --abort` has something real to act on, the worktree verifies
//    clean, and the ONE bounded retry correctly fires — so this settles after ONE OR TWO attempts, never
//    more (the retry is bounded to one). Both outcomes are CORRECT; neither is a bug. ──────────────────────
{
  const { repo, wt } = makeRepoAndWorktree(`g1-${tag}`);
  const counterFile = path.join(repo, ".attempt-counter");
  // Outlives KILL_CONFIRM_WINDOW_MS's own kill-timer by HOOK_OVERRUN_MS — see this file's own header.
  installAlwaysSlowPreMergeCommitHook(repo, HOOK_TICKS, HOOK_TICK_MS, counterFile);
  const preHead = git(wt, ["rev-parse", "HEAD"]).trim();
  const result = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  console.log(`[green-1] info: result=${JSON.stringify(result)}`);
  check("[green-1] a confirmed-kill timeout that never lands is reported as a failure", result.ok === false);
  check("[green-1] it is NOT reported as a quarantine (a confirmed kill is not an unconfirmed one)", result.quarantined !== true);
  check("[green-1] the canonical repo is NOT actually quarantined either", !activeMergeQuarantineFor(repo));
  const headAfter = git(wt, ["rev-parse", "HEAD"]).trim();
  let mergeHeadAfter = "";
  try { mergeHeadAfter = git(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim(); } catch { /* absent, as expected */ }
  // Cheap, IMMEDIATE sanity check — but NOT by itself round-1's discriminator (see the assertNeverWithControl
  // block below): checked this fast, an orphaned child from the pre-round-1 bare-`withTimeout` bug has not
  // had time to land yet either, so this alone would pass on BOTH fixed and unfixed code (MEASURED directly
  // against fa694c5c^'s own worktrees.ts — card 7e5b23e7 round 2, Code Review follow-up).
  check("[green-1] HEAD is unchanged immediately after the call returns", headAfter === preHead);
  check("[green-1] no leftover MERGE_HEAD", mergeHeadAfter === "");
  // Card 7e5b23e7 round 2 (Code Review follow-up) — THE actual round-1 discriminator: an orphaned child
  // from the pre-round-1 bare-`withTimeout` bug needs the hook's own REMAINING duration (several more
  // seconds) to land its commit, well past when the IMMEDIATE check above already ran — so proving "nothing
  // lands LATER either" is what actually distinguishes the fix from the bug, not the immediate read.
  // `assertNeverWithControl` (never a bare fixed wait) requires its own `positiveControl` to independently
  // prove this `check()` CAN observe a real violation first: the control reproduces the pre-round-1 hazard
  // SHAPE directly (a bare, un-killed race against a real git child spawned via `node:child_process.spawn`
  // with no kill call at all) on a SEPARATE repo/worktree — never historical dead code — so this stays
  // meaningful even though the actual pre-fix `worktrees.ts` is long gone from the tree.
  const settleWindowMs = HOOK_TOTAL_MS + 3000; // safety margin for process/hook-spawn overhead
  const discriminated = await assertNeverWithControl({
    label: "[green-1] no orphaned commit lands LATER either, even once the hook's own full natural duration has played out",
    check: () => git(wt, ["rev-parse", "HEAD"]).trim() !== preHead,
    positiveControl: async () => {
      const { repo: cRepo, wt: cWt } = makeRepoAndWorktree(`g1disc-${tag}`);
      installAlwaysSlowPreMergeCommitHook(cRepo, HOOK_TICKS, HOOK_TICK_MS);
      const cPreHead = git(cWt, ["rev-parse", "HEAD"]).trim();
      const cMainSha = git(cRepo, ["rev-parse", "HEAD"]).trim();
      // The pre-round-1 hazard's own shape: a real git child, never killed — exactly what a bare
      // `withTimeout` left running in the background after reporting a timeout.
      // Card 7e5b23e7 round 3 (m4) — `child.on("exit")` must also call `resolve()`, not just `clearTimeout`:
      // a fast-exiting child (e.g. this control's own git failing/completing before the 100ms timer fires)
      // would otherwise cancel the ONLY pending resolve and leave this promise hanging forever. VERIFIED
      // directly: the pre-fix shape (`clearTimeout(timer)` alone) hangs indefinitely against a child that
      // exits in well under 100ms.
      await new Promise((resolve) => {
        const child = spawn("git", ["-C", cWt, ...GIT_ID_ARGV, "merge", "--no-edit", cMainSha], { stdio: "ignore" });
        const timer = setTimeout(resolve, 100); // "reports" near-instantly; the child is left running, unkilled
        child.on("exit", () => { clearTimeout(timer); resolve(); });
      });
      return pollUntil(() => git(cWt, ["rev-parse", "HEAD"]).trim() !== cPreHead, { timeoutMs: settleWindowMs, intervalMs: 200 });
    },
    settle: async () => {
      await pollUntil(() => git(wt, ["rev-parse", "HEAD"]).trim() !== preHead, { timeoutMs: settleWindowMs, intervalMs: 200 });
    },
  });
  check("[green-1] no orphaned commit lands LATER either, even once the hook's own full natural duration has played out (RED against fa694c5c^ — MEASURED directly, see this block's header)", discriminated);
  // The hook's own invocation marker (never an elapsed-time heuristic, which host load can stretch
  // unpredictably in either direction) proves exactly how many real attempts ran, AND what HEAD each one
  // saw at its own start — bounded to the ONE retry this function allows, never more, whichever of the two
  // outcomes above actually occurred.
  const attemptHeads = readAttemptHeads(counterFile);
  check("[green-1] the retry gate is correctly BOUNDED — one or two attempts ran, never more (see this block's own header for why either is correct)", attemptHeads.length === 1 || attemptHeads.length === 2);
  // Card 7e5b23e7 round 2 (Code Review follow-up) — when a retry DID fire, prove it fired at the SAME,
  // verified-clean tip the FIRST attempt started from, never after some stray/partial commit had landed in
  // between: a "retried on a dirty (moved) tree" regression would show the 2nd attempt's own recorded HEAD
  // diverging from the 1st's/preHead, which this directly catches (would FAIL if `verifyWorktreeCleanAt`'s
  // own `head === expectedHead` half were ever dropped or short-circuited).
  if (attemptHeads.length === 2) {
    check("[green-1] the 2nd attempt started from the SAME HEAD as the 1st (never a moved/partial tip)", attemptHeads[0] === attemptHeads[1]);
    check("[green-1] ...and that HEAD is the real pre-attempt HEAD (not some other coincidental match)", attemptHeads[1] === preHead);
  }
  // NOT asserted: a clean INDEX — see this block's own header. Usually (VERIFIED directly against real
  // git 2.47): a kill that lands DURING `pre-merge-commit` (before the hook returns an exit code) means
  // git never reaches the "hook failed, save MERGE_HEAD for a manual retry" branch EITHER — so
  // `MERGE_HEAD` is never written at all, and `merge --abort` (which requires `MERGE_HEAD` to have
  // anything to act on) is correctly a genuine no-op against the merge's own already-staged content. This
  // is NOT a cleanup bug either way: the project's own `2eddf573` decision record forbids auto-
  // `reset --hard`ing dirty tracked state here precisely because it cannot distinguish this residue from a
  // human's real uncommitted WIP — refuse (no retry) rather than risk discarding real work, UNLESS the
  // worktree independently verifies clean (the rarer, equally-correct retry path this block's header
  // documents).
}

// ── GREEN 2 — a hook whose own descendant escapes the tree-kill: UNCONFIRMED kill, quarantines the
//    CANONICAL repo (never the worktree), refuses a SECOND merge attempt, and the manager-facing text this
//    project's own sessions/service.ts code splices in (`assertRepoNotQuarantined`) names the concrete
//    remedy — never new prose written at the call site. ────────────────────────────────────────────────
{
  const { repo, wt } = makeRepoAndWorktree(`g2-${tag}`);
  const markerName = "escaped-descendant.marker";
  // Comfortably past KILL_CONFIRM_WINDOW_MS's own kill-timer + its own give-up grace window (killGraceMs
  // defaults to that SAME value, so give-up fires at ~2×KILL_CONFIRM_WINDOW_MS) — the escaped descendant
  // must still be alive then.
  //
  // Card ad72086b (2026-10-06): GREEN2_TRAILING_BUFFER_MS is a SEPARATE race from KILL_CONFIRM_WINDOW_MS
  // itself — it must also outlast the SECOND attempt's own real git reads below (rev-parse HEAD, a
  // merge-base check, hasConfiguredGitIdentity's two `git config` calls), each a real subprocess spawn,
  // before the escaped descendant's natural exit lets the real confirmation arrive and auto-clear the
  // quarantine out from under that second attempt's own quarantine check. REPRODUCED on a quiet host (no
  // synthetic load) at the OLD 1500ms buffer: "a second merge attempt on the SAME canonical repo is
  // refused by the quarantine" (and its three sibling checks) went RED once in 5 standalone runs — the old
  // buffer left too little margin for those few real subprocess spawns to land before the descendant's own
  // exit. Widened to a fixed 10s buffer (independent of KILL_CONFIRM_WINDOW_MS, which only governs the
  // FIRST call's own give-up timing, never this trailing race) — 5/5 green standalone + 5/5 green under
  // synthetic load after widening (see this card's worker_report for the counts).
  const GREEN2_TRAILING_BUFFER_MS = 10_000;
  const holdMs = 2 * KILL_CONFIRM_WINDOW_MS + GREEN2_TRAILING_BUFFER_MS;
  installDoubleForkedPreMergeCommitHook(repo, markerName, holdMs, 10_000);
  const result = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  console.log(`[green-2] info: result=${JSON.stringify(result)}`);
  check("[green-2] an unconfirmable kill is refused", result.ok === false);
  check("[green-2] it IS reported as a quarantine", result.quarantined === true);
  check("[green-2] the CANONICAL repo (not the worktree) is the one actually quarantined", !!activeMergeQuarantineFor(repo));
  check("[green-2] the worktree path itself is never quarantined (quarantineRepoPath was pinned to canonical)", !activeMergeQuarantineFor(wt));

  // A second attempt on the SAME canonical repo (even a different, otherwise-healthy worktree/branch) is
  // refused outright by the quarantine, before any git child is even spawned.
  removeHooks(repo); // the quarantine alone must be sufficient — no live hook needed to prove this refusal
  const second = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  check("[green-2] a second merge attempt on the SAME canonical repo is refused by the quarantine", second.ok === false && second.quarantined === true);
  check("[green-2] the second refusal's own reason names the concrete remedy (reused text, not new prose)",
    /POST \/internal\/merge-quarantine\/clear/.test(second.reason ?? ""));

  // This is the EXACT helper + text sessions/service.ts's own quarantined-result handling splices into its
  // manager-facing detailText (never hand-written prose) — assert it directly, proving the reuse.
  const quarantineCheck = assertRepoNotQuarantined(repo);
  check("[green-2] assertRepoNotQuarantined (the shared helper the manager-facing message reuses) reports the repo quarantined", quarantineCheck.ok === false);
  check("[green-2] its own text names the SAME concrete remedy",
    !quarantineCheck.ok && /refusing further canonical-repo mutations here/.test(quarantineCheck.reason) && /POST \/internal\/merge-quarantine\/clear/.test(quarantineCheck.reason));

  // NOT asserted here: that the escaped descendant's own marker write is externally observed. Windows/MSYS
  // sh-descendant process-tree bookkeeping for a nested-background hook is a DOCUMENTED, already-tracked
  // unreliability on this host (project memory: windows-msys-hook-taskkill-unconfirmed, decision
  // b966962b) — re-proving "a double-forked hook can escape a tree-kill" is already
  // merge-commit-kill-confirm.mjs's job for the canonical-commit path; this file's own job is only to prove
  // that WHEN an unconfirmed kill occurs (for whatever underlying OS reason), quarantine correctly pins to
  // the CANONICAL repo, never the worktree — already asserted above.
  //
  // AUTO-CLEAR: once the descendant's own exit lets real confirmation finally arrive, the quarantine lifts
  // on its own — bounded poll on the real internal state, never a fixed guessed sleep. Best-effort: on this
  // same documented Windows/MSYS unreliability, confirmation may never arrive in-process at all, in which
  // case a human clear is the documented remedy (already asserted above) — so a timeout here is reported,
  // not failed.
  // Card ad72086b: deliberately a SMALL, fixed cap, independent of holdMs's own (much larger) trailing
  // buffer above — this line is informational only (never asserted), so it must never be the thing that
  // makes this file blow its per-file budget. At GREEN2_TRAILING_BUFFER_MS=10s this poll will usually
  // report `false` (the real auto-clear lands a few seconds after this window closes) — that is an
  // accepted, honest trade against keeping the file fast, not a regression: the clear itself is NEVER
  // asserted, only informationally logged.
  const autoClearPollMs = 3_000;
  const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: autoClearPollMs });
  console.log(`[green-2] info: quarantine auto-cleared within ${autoClearPollMs}ms poll: ${autoCleared} (best-effort — see note above)`);
}

// ── GREEN 3 — a hook that is slow enough to trigger the kill-timer, but whose own work (the merge commit
//    itself) ALREADY LANDED before the hook ever started: verify-landed catches it and reports ok:true
//    instead of a false failure. Deterministic via a POST-commit hook (git moves HEAD before running it),
//    never a timing race against a pre-commit hook. ─────────────────────────────────────────────────────
{
  const { repo, wt } = makeRepoAndWorktree(`g3-${tag}`);
  installSlowPostMergeHook(repo, HOOK_TICKS, HOOK_TICK_MS);
  const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
  const result = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  console.log(`[green-3] info: result=${JSON.stringify(result)}`);
  check("[green-3] a merge that already landed before a slow post-merge hook is reported truthfully, not as a false failure", result.ok === true);
  check("[green-3] the reported mainSha is the real main tip this call unioned", result.ok === true && result.mainSha === mainSha);
  check("[green-3] no quarantine was raised for a merge that provably landed", !activeMergeQuarantineFor(repo));
  const headIsMerge = git(wt, ["rev-parse", "HEAD"]).trim() !== git(wt, ["rev-parse", "HEAD^1"]).trim()
    && git(wt, ["rev-parse", "HEAD^2"]).trim() === mainSha;
  check("[green-3] HEAD really is the merge commit (main is its second parent) — not a coincidental pass", headIsMerge);

  // Card 7e5b23e7 round 2 (the blocking Major this round fixes) — a kill landing during a slow
  // `post-merge` hook used to leave MERGE_HEAD/MERGE_MSG/MERGE_MODE/AUTO_MERGE behind even though the
  // merge itself landed (git writes them BEFORE `post-merge` runs, and clears them only once the hook
  // returns — which it never does here, since the hook's own process tree was just killed). RED on
  // fa694c5c: the next `mergeMainIntoWorktree` call on this SAME worktree failed "You have not concluded
  // your merge (MERGE_HEAD exists)" at `reunionAtAdmission`, inside a held gate slot.
  let mergeHeadAfter = "";
  try { mergeHeadAfter = git(wt, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim(); } catch { /* absent, as expected post-fix */ }
  check("[green-3] no leftover MERGE_HEAD after the kill-confirmed success (RED on fa694c5c)", mergeHeadAfter === "");

  // Prove the worktree is genuinely usable afterward, not just "MERGE_HEAD absent" in isolation: advance
  // main again (removing the slow hook first, so this second call is an ordinary fast merge) and confirm
  // mergeMainIntoWorktree still succeeds — RED on fa694c5c, which fails this exact call with "You have not
  // concluded your merge".
  removeHooks(repo);
  fs.writeFileSync(path.join(repo, "main-file-2.txt"), "second main advance\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "second main advance"], { cwd: repo });
  const mainSha2 = git(repo, ["rev-parse", "HEAD"]).trim();
  const result2 = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  console.log(`[green-3] info: second call result=${JSON.stringify(result2)}`);
  check("[green-3] a second mergeMainIntoWorktree call after main advances again succeeds (the worktree was left genuinely concluded, not still mid-merge) — RED on fa694c5c", result2.ok === true && result2.mainSha === mainSha2);
}

// ── RETRY CASE — confirmed kill, did not land, worktree verified clean after abort ⇒ the ONE bounded
//    retry fires and the second attempt lands cleanly.
//
// VERIFIED directly against real git (2.47) while building this file: a kill that lands DURING
// `pre-merge-commit` USUALLY cannot leave the worktree verified clean (see GREEN 1's own header, corrected
// in round 2 — MEASURED one exception in five real runs under heavy host load, where the hook had already
// returned failure before the kill landed) — by the time a real hook-based kill fires, the merge's own
// content is USUALLY already staged, and `MERGE_HEAD` (which `merge --abort` needs to have anything to act
// on) is USUALLY never written for a hook that's killed rather than returning a real exit code. The
// retry's own gate is therefore a real, SAFE conservative design (never
// retries over residue it can't positively clear — the project's own `2eddf573` decision forbids guessing
// here), but it exercises a worktree state a HOOK-based kill cannot deterministically produce: a timeout
// where NOTHING was ever touched (the real-world case this guards: git itself genuinely slow to COMPUTE a
// large union under host load, killed before it ever reaches the staging step at all — the live specimen's
// own root cause, op `d64d890e`). `deps.gitFactory` (the documented test seam for simulating a hanging git
// child with no real child to kill/touch anything) is the deterministic way to construct exactly that
// state: every call EXCEPT the merge's own `merge --no-edit` delegates to REAL git; that one call never
// resolves on its FIRST invocation (so the worktree is genuinely untouched when the timeout fires) and
// delegates to a REAL merge on the retry. ─────────────────────────────────────────────────────────────────
function makeOnceHangingMergeGitFactory() {
  let mergeCallCount = 0;
  return (repoPath) => ({
    raw: (args) => {
      const a = Array.isArray(args) ? args : [args];
      if (a.includes("merge") && a.includes("--no-edit")) {
        mergeCallCount++;
        if (mergeCallCount === 1) return new Promise(() => { /* never resolves — simulates a hang, nothing touched */ });
      }
      try { return Promise.resolve(execFileSync("git", ["-C", repoPath, ...a], { encoding: "utf8" })); }
      catch (e) { return Promise.reject(e); }
    },
  });
}
{
  const { repo, wt } = makeRepoAndWorktree(`retry-${tag}`);
  const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();
  const result = await mergeMainIntoWorktree(repo, wt, { ...MOCK_DEPS, gitFactory: makeOnceHangingMergeGitFactory() }, undefined, BRANCH);
  console.log(`[retry] info: result=${JSON.stringify(result)}`);
  check("[retry] the first attempt's timeout is retried once and the retry lands", result.ok === true);
  check("[retry] the landed mainSha is the real main tip", result.ok === true && result.mainSha === mainSha);
  check("[retry] no quarantine was raised (both attempts were timeout/clean, never unconfirmed)", !activeMergeQuarantineFor(repo));
}

// ── NO-RETRY CASE — confirmed kill, did not land, but the worktree is NOT verified clean afterward (a
//    pre-existing, unrelated uncommitted tracked change survives `merge --abort`, which only resets what
//    THIS merge itself touched) ⇒ no retry is attempted; it fails after exactly ONE attempt. ────────────
{
  const { repo, wt } = makeRepoAndWorktree(`noretry-${tag}`);
  const counterFile = path.join(repo, ".attempt-counter");
  installAlwaysSlowPreMergeCommitHook(repo, HOOK_TICKS, HOOK_TICK_MS, counterFile);
  // Pre-dirty an UNRELATED tracked file (untouched by either branch's or main's own changes, so the merge
  // itself is not blocked by it) — `merge --abort` only reverts what the merge touched, so this survives.
  fs.writeFileSync(path.join(wt, "untouched.txt"), "dirtied before the merge attempt\n");
  // Card 7e5b23e7 round 3 (m3) — the hook's own invocation counter CANNOT discriminate "did it retry?"
  // here: VERIFIED directly (a real repro against this exact residue shape) that a kill mid-pre-merge-
  // commit leaves `main-file.txt` STAGED with no `MERGE_HEAD` to abort, so `merge --abort` fails and this
  // staged residue (plus the pre-existing dirty `untouched.txt`) survives into any later attempt. If the
  // retry gate ever regressed to fire anyway, that SECOND `git merge` would fail "local changes would be
  // overwritten" before `pre-merge-commit` ever runs again — so the hook counter would read 1 whether or
  // not a (buggy) retry actually fired. Count the retry at the CALL level instead, via the function's own
  // "retrying once" log line — the one place a retry decision is actually recorded.
  const logLines = [];
  const origLog = console.log;
  console.log = (...args) => { logLines.push(args.map(String).join(" ")); origLog(...args); };
  let result;
  try {
    result = await mergeMainIntoWorktree(repo, wt, DEPS, undefined, BRANCH);
  } finally {
    console.log = origLog;
  }
  console.log(`[no-retry] info: result=${JSON.stringify(result)}`);
  check("[no-retry] a confirmed-kill timeout against a worktree that can't be verified clean afterward fails", result.ok === false);
  check("[no-retry] it is NOT a quarantine (the kill itself was confirmed, not unconfirmed)", result.quarantined !== true);
  check("[no-retry] no retry was attempted (no \"retrying once\" log line) — the hook-invocation counter alone cannot discriminate this (see header)",
    !logLines.some((l) => l.includes("retrying once")));
  // Informational only (see header): the hook's own counter stays at 1 either way, so it is NOT asserted
  // as the discriminator here, just logged for visibility.
  console.log(`[no-retry] info: hook invocation count (NOT the discriminator — see header): ${readAttemptHeads(counterFile).length}`);
  const dirtyAfter = git(wt, ["status", "--porcelain", "--untracked-files=no"]).trim();
  check("[no-retry] the pre-existing dirt is still there afterward (proves the clean-check genuinely saw it, not vacuous)", dirtyAfter !== "");
}

// ── ALLOWRETRY:FALSE CASE — card 7e5b23e7 round 2 (item 4): `reunionAtAdmission`'s own call passes
//    `allowRetry:false` since it holds a scarce, fleet-shared gate slot. Reuses the EXACT scenario the
//    RETRY case above proves DOES retry and land — this proves `allowRetry:false` suppresses that same
//    retry, failing after exactly ONE attempt instead. ───────────────────────────────────────────────────
{
  const { repo, wt } = makeRepoAndWorktree(`noretryflag-${tag}`);
  const result = await mergeMainIntoWorktree(repo, wt, { ...MOCK_DEPS, gitFactory: makeOnceHangingMergeGitFactory(), allowRetry: false }, undefined, BRANCH);
  console.log(`[allowretry-false] info: result=${JSON.stringify(result)}`);
  check("[allowretry-false] the SAME scenario the RETRY case proves DOES retry and land instead fails after one attempt when allowRetry:false", result.ok === false);
  check("[allowretry-false] it is NOT a quarantine (the kill itself was confirmed, not unconfirmed)", result.quarantined !== true);
}

// ── QUIT-FAILURE CASE — card 7e5b23e7 round 2, Code Review correction to item 1: a landed merge whose
//    `merge --quit` MERGE_HEAD cleanup fails for an ORDINARY (non-quarantine) reason must NOT be silently
//    reported ok:true with MERGE_HEAD still present — it must re-verify MERGE_HEAD and report a loud,
//    accurate failure instead. Fully mocked via `deps.gitFactory` (no real git repo touched beyond the
//    opaque path strings below) — isolates this NEW cleanup-failure branch from the real-spawn kill-confirm
//    mechanics GREEN-1/GREEN-2/GREEN-3/RETRY/NO-RETRY above already prove. RED on fa694c5c (the pre-fix
//    code has no such branch at all — this exact call shape did not exist). ────────────────────────────────
function makeQuitFailureGitFactory(mainSha) {
  let mergeBaseCalls = 0;
  return () => ({
    raw: (args) => {
      const a = Array.isArray(args) ? args : [args];
      if (a.includes("-q") && a.includes("--verify") && (a.includes("MERGE_HEAD") || a.includes("HEAD^2"))) {
        return Promise.resolve(mainSha + "\n"); // MERGE_HEAD and HEAD^2 both always read back as mainSha
      }
      if (a[0] === "merge-base") {
        mergeBaseCalls++;
        // 1st call: the "already caught up?" pre-check — must NOT equal mainSha, or the function would
        // short-circuit before ever attempting a merge. 2nd call: verify-landed, post-timeout — the merge
        // DID land, so this one equals mainSha.
        return Promise.resolve((mergeBaseCalls === 1 ? "0".repeat(40) : mainSha) + "\n");
      }
      if (a.includes("merge") && a.includes("--no-edit")) return new Promise(() => { /* never resolves — forces the confirmed-kill timeout */ });
      if (a[0] === "merge" && a.includes("--quit")) return Promise.reject(new Error("simulated ordinary --quit failure (not quarantine/kill-unconfirmed)"));
      if (a[0] === "rev-parse" && a.length === 2 && a[1] === "HEAD") return Promise.resolve(mainSha + "\n");
      if (a[0] === "config") return Promise.reject(new Error("no identity configured (mocked)"));
      return Promise.reject(new Error(`unexpected git call in quit-failure mock: ${JSON.stringify(a)}`));
    },
  });
}
{
  const mainSha = "a".repeat(40);
  const result = await mergeMainIntoWorktree("Z:\\mock\\repo", "Z:\\mock\\worktree", { ...MOCK_DEPS, gitFactory: makeQuitFailureGitFactory(mainSha) }, undefined, BRANCH);
  console.log(`[quit-failure] info: result=${JSON.stringify(result)}`);
  check("[quit-failure] a landed merge whose --quit cleanup fails for a non-quarantine reason is NOT silently reported ok:true", result.ok === false);
  check("[quit-failure] it is NOT reported as a quarantine (the --quit failure was ordinary, not kill-unconfirmed)", result.quarantined !== true);
  check("[quit-failure] the reason names the leftover MERGE_HEAD, not a bare \"failed\" (a loud, accurate failure)",
    /MERGE_HEAD/.test(result.reason ?? "") && /could not be cleared/.test(result.reason ?? ""));
}

// ── UNREADABLE-MERGE-HEAD CASE — card 7e5b23e7 round 3 (item 1): the post-kill cleanup read of
//    `MERGE_HEAD` itself times out (a real read failure under host load), rather than the ref being
//    genuinely absent. VERIFIED directly against real git/simple-git (see the `readMergeHead` doc comment
//    at its call site): `rev-parse -q --verify MERGE_HEAD` does NOT throw when the ref is genuinely
//    absent — it resolves with an empty string, because `-q` suppresses git's stderr and simple-git's own
//    error-detection plugin only treats a call as failed when BOTH `exitCode` and `stdErr` are non-empty.
//    So the ONLY way this read throws (or the `withTimeout` race around it rejects) is a REAL failure —
//    before this round's fix, that failure was silently mapped to "absent" and reported as a false
//    `ok:true`. RED on fa694c5c (that version's `readMergeHead` catch returns `undefined` unconditionally,
//    identical to the genuine-absence case). ─────────────────────────────────────────────────────────────
function makeUnreadableMergeHeadGitFactory(mainSha) {
  let mergeBaseCalls = 0;
  return () => ({
    raw: (args) => {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "merge-base") {
        mergeBaseCalls++;
        // 1st call: the "already caught up?" pre-check — must NOT equal mainSha, or the function would
        // short-circuit before ever attempting a merge. 2nd call: verify-landed, post-timeout — the merge
        // DID land, so this one equals mainSha.
        return Promise.resolve((mergeBaseCalls === 1 ? "0".repeat(40) : mainSha) + "\n");
      }
      if (a.includes("merge") && a.includes("--no-edit")) return new Promise(() => { /* never resolves — forces the confirmed-kill timeout */ });
      if (a.includes("-q") && a.includes("--verify") && a.includes("MERGE_HEAD")) return new Promise(() => { /* never resolves — the post-kill cleanup READ ITSELF now times out */ });
      if (a[0] === "rev-parse" && a.length === 2 && a[1] === "HEAD") return Promise.resolve(mainSha + "\n");
      if (a[0] === "config") return Promise.reject(new Error("no identity configured (mocked)"));
      return Promise.reject(new Error(`unexpected git call in unreadable-merge-head mock: ${JSON.stringify(a)}`));
    },
  });
}
{
  const mainSha = "b".repeat(40);
  const result = await mergeMainIntoWorktree("Z:\\mock\\repo", "Z:\\mock\\worktree", { ...MOCK_DEPS, gitFactory: makeUnreadableMergeHeadGitFactory(mainSha) }, undefined, BRANCH);
  console.log(`[unreadable-merge-head] info: result=${JSON.stringify(result)}`);
  check("[unreadable-merge-head] a landed merge whose post-kill MERGE_HEAD read itself fails is NOT silently reported ok:true (RED on fa694c5c)", result.ok === false);
  check("[unreadable-merge-head] it is NOT reported as a quarantine (the read failure was an ordinary timeout, not kill-unconfirmed)", result.quarantined !== true);
  check("[unreadable-merge-head] the reason names the read failure, not a bare \"cleared\"/\"present\" claim",
    /could not be read/.test(result.reason ?? ""));
}

// ── PRECONDITION-FALSE CASES — card 7e5b23e7 round 3 (item 5, n1): a landed merge whose leftover
//    MERGE_HEAD does NOT provably belong to THIS merge (MERGE_HEAD ≠ mainSha, or HEAD^2 ≠ mainSha) must
//    never run `merge --quit` — that MERGE_HEAD may belong to some other, unrelated in-progress merge this
//    function has no business touching. Both subcases must still report a loud, accurate `ok:false`
//    (the leftover is real and was never cleared), never a silent `ok:true`. ──────────────────────────────
function makePreconditionFalseGitFactory(mainSha, { mergeHeadSha, headSecondParentSha }) {
  let mergeBaseCalls = 0;
  let quitCalled = false;
  const factory = () => ({
    raw: (args) => {
      const a = Array.isArray(args) ? args : [args];
      if (a.includes("-q") && a.includes("--verify") && a.includes("MERGE_HEAD")) return Promise.resolve(mergeHeadSha + "\n");
      if (a.includes("-q") && a.includes("--verify") && a.includes("HEAD^2")) return Promise.resolve(headSecondParentSha + "\n");
      if (a[0] === "merge-base") {
        mergeBaseCalls++;
        return Promise.resolve((mergeBaseCalls === 1 ? "0".repeat(40) : mainSha) + "\n");
      }
      if (a.includes("merge") && a.includes("--no-edit")) return new Promise(() => { /* never resolves — forces the confirmed-kill timeout */ });
      if (a[0] === "merge" && a.includes("--quit")) { quitCalled = true; return Promise.resolve(""); }
      if (a[0] === "rev-parse" && a.length === 2 && a[1] === "HEAD") return Promise.resolve(mainSha + "\n");
      if (a[0] === "config") return Promise.reject(new Error("no identity configured (mocked)"));
      return Promise.reject(new Error(`unexpected git call in precondition-false mock: ${JSON.stringify(a)}`));
    },
  });
  factory.wasQuitCalled = () => quitCalled;
  return factory;
}
{
  // Subcase A: MERGE_HEAD present, but belongs to an unrelated merge (≠ mainSha) — the `mergeHeadSha ===
  // mainSha` precondition itself is false, so the whole `--quit` branch is skipped outright.
  const mainSha = "c".repeat(40);
  const foreignSha = "d".repeat(40);
  const factory = makePreconditionFalseGitFactory(mainSha, { mergeHeadSha: foreignSha, headSecondParentSha: foreignSha });
  const result = await mergeMainIntoWorktree("Z:\\mock\\repo", "Z:\\mock\\worktree", { ...MOCK_DEPS, gitFactory: factory }, undefined, BRANCH);
  console.log(`[precondition-false-a] info: result=${JSON.stringify(result)}`);
  check("[precondition-false-a] MERGE_HEAD belonging to an unrelated merge is never --quit'd", !factory.wasQuitCalled());
  check("[precondition-false-a] reports a loud ok:false (the leftover was never cleared)", result.ok === false);
  check("[precondition-false-a] it is NOT reported as a quarantine", result.quarantined !== true);
  check("[precondition-false-a] the reason names the leftover MERGE_HEAD still present",
    /MERGE_HEAD/.test(result.reason ?? "") && /still present/.test(result.reason ?? ""));
}
{
  // Subcase B: MERGE_HEAD matches mainSha, but HEAD^2 does not — the merge commit's own second parent
  // doesn't actually confirm this MERGE_HEAD belongs to the union just attempted.
  const mainSha = "e".repeat(40);
  const foreignSha = "f".repeat(40);
  const factory = makePreconditionFalseGitFactory(mainSha, { mergeHeadSha: mainSha, headSecondParentSha: foreignSha });
  const result = await mergeMainIntoWorktree("Z:\\mock\\repo", "Z:\\mock\\worktree", { ...MOCK_DEPS, gitFactory: factory }, undefined, BRANCH);
  console.log(`[precondition-false-b] info: result=${JSON.stringify(result)}`);
  check("[precondition-false-b] a HEAD^2 mismatch is never --quit'd", !factory.wasQuitCalled());
  check("[precondition-false-b] reports a loud ok:false (the leftover was never cleared)", result.ok === false);
  check("[precondition-false-b] it is NOT reported as a quarantine", result.quarantined !== true);
  check("[precondition-false-b] the reason names the leftover MERGE_HEAD still present",
    /MERGE_HEAD/.test(result.reason ?? "") && /still present/.test(result.reason ?? ""));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeMainIntoWorktree's two mutating merge calls are kill-confirmed: a confirmed-kill " +
    "timeout that never lands fails cleanly with no quarantine (GREEN 1), an unconfirmable kill quarantines " +
    "the CANONICAL repo (never the worktree), refuses a second merge, and the manager-facing remedy text is " +
    "reused verbatim from assertRepoNotQuarantined (GREEN 2), a merge that already landed before a slow " +
    "post-merge hook is reported truthfully instead of a false failure AND leaves no leftover MERGE_HEAD, " +
    "proven usable by a real second call after main advances again (GREEN 3, round 2), the one bounded " +
    "retry fires and lands when the worktree is verified clean (RETRY), it correctly refuses to retry when " +
    "the worktree can't be verified clean afterward (NO-RETRY), `allowRetry:false` suppresses that same " +
    "retry on the identical scenario (ALLOWRETRY-FALSE, round 2), a landed merge whose `--quit` cleanup " +
    "fails for an ordinary reason reports a loud, accurate failure instead of a false ok:true (QUIT-FAILURE, " +
    "round 2), a post-kill MERGE_HEAD read that itself fails is never mistaken for a genuine absence " +
    "(UNREADABLE-MERGE-HEAD, round 3), and a leftover MERGE_HEAD that doesn't provably belong to this " +
    "merge (either MERGE_HEAD or HEAD^2 mismatched) is never `--quit`'d (PRECONDITION-FALSE-A/B, round 3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
