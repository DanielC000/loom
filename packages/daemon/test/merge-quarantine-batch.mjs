import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MERGE QUARANTINE — BATCH-PATH CONVERGENCE + RESTART DURABILITY (round 4, card 24c0bdba, Code Review
// b2ebf41f). Round 3 raised a quarantine by reusing the in-flight/crash-recovery tracker directly, keyed
// on whatever repoPath the CALLER happened to pass — for the batch path, that was the ephemeral batch
// worktree, never the canonical repo, and a plain restart silently discarded it (never re-armed it). Both
// were real bypasses: canonical main could still be fast-forwarded (or a fresh worktree still created)
// while "quarantined", and an agent-callable daemon_restart could trivially defeat the whole mechanism.
//
// This file drives the SAME two shapes the reviewer's own repro used (`runBatchedMerge`/
// `fastForwardCanonicalMain` directly, git/batch-merge.ts — not a full daemon/HTTP harness; the round-3
// sibling `merge-commit-kill-confirm.mjs` already proves the SOLO path + the underlying kill-confirm
// mechanism end to end through the real `mergeBranch`), plus a third scenario for restart durability
// against the new `git/merge-quarantine.ts` module directly.
//
// SCENARIO A: the canonical repo is ALREADY quarantined ⇒ runBatchedMerge refuses BEFORE assembly (no
//   candidate is even attempted) — with a negative control proving the SAME call succeeds once cleared.
// SCENARIO B: a candidate's own commit dies with an unconfirmed tree-kill MID-BATCH (the reviewer's own
//   "commits 0..i-1 ride onto main" concern, card 24c0bdba round 4) ⇒ the WHOLE batch aborts: no gate
//   ever runs, canonical HEAD is untouched, and the batch worktree is left on disk (round 3's own
//   double-forked hook repro, applied to a multi-commit batch candidate instead of a solo squash).
// SCENARIO C: a quarantine latch found at boot RE-ARMS the refusal (never silently discarded), and only
//   the human clear (`clearMergeQuarantine` — the same call the loopback REST route makes) lifts it; a
//   plain in-memory reset (simulating "restart discarded it") must NOT be enough on its own.
//
// Every scenario negative-controls its own guard: SCENARIO A's positive control is the same call
// succeeding once cleared; SCENARIO B's is scenario 5's own proven-positive-control marker check
// (reused from merge-commit-kill-confirm.mjs's own pattern — the escaped descendant genuinely runs);
// SCENARIO C's is an explicit assertion that merely resetting the in-memory map (never durably clearing
// it) does NOT survive a second re-entry, proving the durable half is load-bearing, not decorative.
//
// SCENARIO E (card bde5d1fe item 2, added after round 6/7) — `fastForwardCanonicalMain`'s own `git merge
// --ff-only` used to run on a bare `withTimeout` (simple-git's single-process kill only): no tree-kill, no
// quarantine raise on an unconfirmed kill, unlike every other mutating call on this path. Reuses SCENARIO
// B's own double-forked-hook shape (a post-merge hook this time, since ff-only triggers that, not
// pre-commit) to prove the ff-only call now gets the SAME kill-confirm + quarantine treatment, via the
// SAME `killableCanonicalRaw` helper — never a second tree-killer.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-batch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

useOwnLoomHome("loom-mqb-parent-");
requireHermeticEnv();

const { createWorktree } = await import("../dist/git/worktrees.js");
const { runBatchedMerge, fastForwardCanonicalMain } = await import("../dist/git/batch-merge.js");
const {
  enterMergeQuarantine, clearMergeQuarantine, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR,
} = await import("../dist/git/merge-quarantine.js");
// Card 4966d70c — SCENARIO B/E's own "an unconfirmed-kill descendant escapes ⇒ quarantine" premise only
// holds on the taskkill-based fallback path (card 24c0bdba); on win32, when win-job-launcher.exe (card
// 1718416d) is built, the escaping descendant is a member of the SAME Job Object as the git child it
// tried to escape, so the tree-kill reaches it too, confirmation succeeds, and NO quarantine is ever
// raised — a real, host-dependent (not a regression) divergence this file had no case for. `setWinJobLauncherOverrideForTest`
// (git/bounded.ts, test-only — never a production env var/config knob; already used the same way by
// git-writer-kill-confirm.mjs/merge-commit-kill-confirm.mjs) is the SANCTIONED seam for forcing the
// fallback path WITHOUT touching the real `win-job-launcher.exe` the live self-hosting daemon uses.
// SCENARIO B/E below now force fallback explicitly via that seam (so they test what they claim on every
// checkout, launcher built or not), and SCENARIO B-LAUNCHER/E-LAUNCHER assert the launcher-mode outcome
// explicitly as its own case, SKIPping (like the win-job-launcher-*.mjs tests' own top-of-file guard)
// when the exe isn't built — so plain worktrees and ubuntu CI (which never build it) stay green and the
// launcher-mode behavior still gets a real assertion on a host that HAS it built.
const { setWinJobLauncherOverrideForTest } = await import("../dist/git/bounded.js");
const { WIN_JOB_LAUNCHER_PATH } = await import("../dist/paths.js");
const launcherBuilt = process.platform === "win32" && fs.existsSync(WIN_JOB_LAUNCHER_PATH);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqb@loom -c user.name=mqb";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mqb-proj-${sfx}`;
const tmpDirs = [];

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqb-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# merge-quarantine-batch\n");
  execSync(`git init -q && git config user.email mqb@loom && git config user.name mqb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
async function cutBranch(repo, label, file, content) {
  const taskId = `mqb-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
  return { workerSessionId: `mqb-wkr-${label}-${sfx}`, taskId, branch, taskTitle: `feat(test): ${label}`, worktreePath };
}
async function cutBatchWorktree(repo, tag) {
  const { worktreePath } = await createWorktree(repo, projId, `mqb-batch-${tag}-${sfx}`);
  return worktreePath;
}

const passGate = async () => ({ passed: true });

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO A — canonical repo ALREADY quarantined ⇒ runBatchedMerge refuses before assembly
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("a");
    const a = await cutBranch(repo, "a1", "a1.txt", "a1\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const batchWt = await cutBatchWorktree(repo, "a");

    let gateInvoked = false;
    const trackedGate = async (...args) => { gateInvoked = true; return passGate(...args); };

    enterMergeQuarantine(repo, "unrelated-branch", "manufactured for SCENARIO A");
    check("(A) precondition: the repo reads as quarantined", !!activeMergeQuarantineFor(repo));

    const r1 = await runBatchedMerge(repo, batchWt, baseMainSha, [a], trackedGate);
    check("(A) runBatchedMerge refuses", r1.ok === false);
    check("(A) the TYPED quarantined flag is set (not inferred from reason text)", r1.quarantined === true);
    check("(A) the gate callback was NEVER invoked (no shared gate slot burned)", gateInvoked === false);
    check("(A) canonical HEAD is untouched", git(repo, "rev-parse HEAD") === baseMainSha);
    check("(A) landed/dropped are both empty — assembly never even started", r1.landed.length === 0 && r1.dropped.length === 0);

    // NEGATIVE CONTROL: clearing the quarantine lets the SAME call succeed — proves the refusal above was
    // the quarantine specifically, not some unrelated/vacuous failure.
    clearMergeQuarantine(repo);
    check("(A) control precondition: the repo no longer reads as quarantined", !activeMergeQuarantineFor(repo));
    const r2 = await runBatchedMerge(repo, batchWt, baseMainSha, [a], trackedGate);
    check("(A) control: once cleared, the SAME batch lands normally", r2.ok === true && gateInvoked === true);
    check("(A) control: the landed branch is on canonical main now", git(repo, "rev-parse HEAD") !== baseMainSha);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO B — a candidate's own commit dies unconfirmed MID-BATCH ⇒ the whole batch aborts
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Reuses merge-commit-kill-confirm.mjs's own double-forked hook shape (Code Review B-2's exact repro):
  // the OUTER subshell backgrounds an INNER one and returns immediately, so by the time the kill-trigger's
  // tree-kill walks the tree, the escaped descendant is already unreachable by a PPID-walking kill. Here
  // it's installed on a branch's SECOND commit, landing mid-batch (not the solo squash path).
  // @decision f59ca98a — this file's own copy of the shape was missed by that record's fix (which only
  // touched git-writer-kill-confirm.mjs/merge-commit-kill-confirm.mjs/union-merge-kill-confirm.mjs): without
  // `setsid`, the escaped descendant stays in the SAME process group as git's own hook child (bounded.ts's
  // `spawnCanonicalGitTree` spawns with `detached: process.platform !== "win32"`, making the git child its
  // own group leader) — POSIX's tree-kill is a process-GROUP kill (`process.kill(-pid, "SIGKILL")`,
  // gate-runner.ts's `killGateProcessTree`), which reaches every member of that group regardless of PPID,
  // so the "escapes a PPID-walking kill" framing above is win32-only; on POSIX the descendant must `setsid`
  // to actually escape the SAME tree-kill. Confirmed by direct repro (real WSL Ubuntu-22.04): pre-fix, this
  // scenario reproduces CI's exact failure set (TYPED quarantined flag unset, repo not quarantined, marker
  // never observed, `runBatchedMerge` reports "every candidate was dropped" instead) — the descendant is
  // killed by the group kill before it can write its marker, so the kill-confirm's tree death IS confirmed
  // and no quarantine is ever raised.
  // Card 5126718f: these were 2000/8000/15000, then raised to 10000 (~40% headroom over a measured 7.2s
  // worst case under "100%-CPU, 14 genuine OS processes" synthetic contention). Card cceb62fd: that 10000
  // figure still reliably reproduces the SAME documented failure shape — a bare `{ok:true}` with no hook
  // invocation at all (the hook-invoked marker absent) — on real ubuntu-latest CI (every push since
  // 2026-10-03) AND under this worker's own local Linux repro (WSL, both a synthetic multi-process CPU
  // stress and a REALISTIC concurrent-real-test-file load, CPU-constrained to 2 cores to approximate a
  // weaker CI runner): the pre-hook git-spawn-and-complete overhead this scenario races against evidently
  // exceeds 7.2s under real CI/suite-wide contention, not just the narrower synthetic stress the 10000
  // figure was sized against. Raised to 20000 (2x) — the hook only needs to OUTLIVE the kill-trigger
  // deadline (2*SMALL_MS) by a margin, not hold for some large multiple of it, so S_HOLD_MS keeps the
  // ORIGINAL file's own margin convention (+4000 over the give-up deadline) scaled to the new SMALL_MS, to
  // bound this file's own standalone wall time (merge-quarantine-batch.mjs carries a test-daemon.mjs
  // per-file timeout override sized off a measured max — see that file's own comment, raised alongside
  // this change). This is a MITIGATION, not a structural fix — the test still races a wall-clock budget
  // against host load; a signal-based redesign (confirm the hook has started before the kill-trigger's
  // clock matters) would close the residual gap but is a larger change, left to a follow-up.
  const SMALL_MS = 20000;
  const S_HOLD_MS = 2 * SMALL_MS + 4000; // comfortably past withTimeoutKillingChild's own give-up deadline (2*SMALL_MS)
  const S_MAIN_MS = SMALL_MS + 10000;
  const AUTO_CLEAR_POLL_MS = S_HOLD_MS + 10000;
  const markerName = "escaped-descendant-b.marker";
  // Hoisted to top level (was originally scoped inside SCENARIO E's own block) and parameterized on the
  // marker filename, so both SCENARIO E and its SCENARIO E-LAUNCHER counterpart can call it — mirrors
  // installDoubleForkedPreCommitHook just above, which was already top-level for the same reason (B's
  // own launcher counterpart needed it too).
  const markerNameE = "escaped-descendant-e.marker";
  function installDoubleForkedPreCommitHook(repo, holdMs, mainMs) {
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hookPath,
      `#!/bin/sh\n` +
      `if command -v setsid >/dev/null 2>&1; then\n` +
      `  ( setsid sh -c 'sleep ${holdMs / 1000}; echo fixedY > fixedY.txt; git add fixedY.txt; echo done > ${markerName}' & )\n` +
      `else\n` +
      `  ( (sleep ${holdMs / 1000}; echo fixedY > fixedY.txt; git add fixedY.txt; echo done > ${markerName}) & )\n` +
      `fi\n` +
      `sleep ${mainMs / 1000}\n`);
    fs.chmodSync(hookPath, 0o755);
  }
  // @decision f59ca98a — same POSIX setsid requirement as the pre-commit hook above: without it, the
  // escaped descendant shares git's own process GROUP (bounded.ts spawns the canonical git child
  // `detached` on POSIX) and dies along with it under the tree-kill's process-group kill. Moved to top
  // level (was originally scoped inside SCENARIO E's own block) and given a `markerFileName` parameter so
  // SCENARIO E-LAUNCHER can reuse it too.
  function installDoubleForkedPostMergeHook(repo, holdMs, mainMs, markerFileName) {
    const hookPath = path.join(repo, ".git", "hooks", "post-merge");
    fs.writeFileSync(hookPath,
      `#!/bin/sh\n` +
      `if command -v setsid >/dev/null 2>&1; then\n` +
      `  ( setsid sh -c 'sleep ${holdMs / 1000}; echo escaped > ${markerFileName}' & )\n` +
      `else\n` +
      `  ( (sleep ${holdMs / 1000}; echo escaped > ${markerFileName}) & )\n` +
      `fi\n` +
      `sleep ${mainMs / 1000}\n`);
    fs.chmodSync(hookPath, 0o755);
  }
  {
    // Force the taskkill fallback path (card 4966d70c) — this scenario's premise ("an unconfirmed-kill
    // descendant escapes ⇒ quarantine") only holds there; see SCENARIO B-LAUNCHER below for the launcher
    // mode's own, different, explicitly-asserted outcome.
    setWinJobLauncherOverrideForTest(null);
    const repo = makeRepo("b");
    const taskId = `mqb-task-b-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    // Commit 1 lands fine (no hook yet installed) — this is the "commits 0..i-1" the reviewer's own
    // finding warned could otherwise ride onto main unverified.
    fs.writeFileSync(path.join(worktreePath, "b1.txt"), "b1\n");
    commitAll(worktreePath, "feat(test): b1", GIT_ID);
    // Commit 2 is the one whose LANDING (during batch assembly, not this authoring step) will hit the
    // escaping hook — installed on the CANONICAL repo's shared hooks dir now, before assembly ever runs.
    fs.writeFileSync(path.join(worktreePath, "b2.txt"), "b2\n");
    commitAll(worktreePath, "feat(test): b2", GIT_ID);
    const cand = { workerSessionId: `mqb-wkr-b-${sfx}`, taskId, branch, taskTitle: "feat(test): b" };
    installDoubleForkedPreCommitHook(repo, S_HOLD_MS, S_MAIN_MS);

    const baseMainSha = git(repo, "rev-parse HEAD");
    const batchWt = await cutBatchWorktree(repo, "b");
    // The hook's own CWD when it fires is wherever the COMMIT happens — the batch WORKTREE during batch
    // landing, never the bare canonical repo (hooks are SHARED via the common .git/hooks dir, but each
    // invocation's cwd is whichever worktree triggered it) — the marker (and fixedY.txt) land there.
    const markerPath = path.join(batchWt, markerName);
    let gateInvoked = false;
    const trackedGate = async () => { gateInvoked = true; return passGate(); };

    const r = await runBatchedMerge(repo, batchWt, baseMainSha, [cand], trackedGate, { timeoutMs: SMALL_MS });
    console.log(`(B) info: runBatchedMerge -> ${JSON.stringify({ ok: r.ok, quarantined: r.quarantined, reason: r.reason })}`);
    check("(B) runBatchedMerge refuses", r.ok === false);
    check("(B) the TYPED quarantined flag is set", r.quarantined === true);
    check("(B) the gate NEVER ran (no gate, per round-4 ruling 1c)", gateInvoked === false);
    check("(B) canonical HEAD is UNCHANGED (no fast-forward, not even b1's own commit)", git(repo, "rev-parse HEAD") === baseMainSha);
    check("(B) the batch worktree is still on disk (runBatchedMerge itself never removes it — the caller's own job, verified separately in sessions/service.ts)", fs.existsSync(batchWt));
    check("(B) the repo now reads as quarantined via the internal state too", !!activeMergeQuarantineFor(repo));

    // POSITIVE CONTROL: prove the escaped descendant genuinely ran (this scenario is not vacuous) — a
    // bounded poll on the real event, never a single fixed-length guessed sleep.
    const markerAppeared = await pollUntil(() => fs.existsSync(markerPath), { timeoutMs: S_HOLD_MS + 10000 });
    check("(B) the escaped descendant's marker write IS eventually observed (proves it genuinely ran, not skipped)", markerAppeared);

    // AUTO-CLEAR: once the descendant's own exit lets confirmation finally arrive, the quarantine lifts —
    // bounded poll on the real internal state, never a fixed guessed sleep.
    const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: AUTO_CLEAR_POLL_MS });
    check("(B) the quarantine auto-clears once the real tree-death confirmation eventually arrives", autoCleared);

    // Clean up the now-irrelevant slow hook + the (still staged, from the interrupted commit 2) residue
    // before this file's OWN cleanup tries to touch the worktree/repo.
    fs.rmSync(path.join(repo, ".git", "hooks", "pre-commit"), { force: true });
    try { execSync("git reset --hard HEAD", { cwd: repo }); } catch { /* best-effort */ }
    setWinJobLauncherOverrideForTest(undefined); // restore real detection before SCENARIO B-LAUNCHER
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO B-LAUNCHER (card 4966d70c) — the SAME escaped-descendant shape as SCENARIO B, but with the
  // real win-job-launcher.exe (Job Object containment, card 1718416d) in play: the escaping descendant is
  // a member of the SAME Job as the git child it tried to escape, so the tree-kill reaches it too, the
  // kill-confirm succeeds, and NO quarantine is ever raised — the candidate's own commit is simply
  // dropped as an ordinary (non-quarantining) failure. Asserts that outcome explicitly rather than
  // leaving it uncovered. SKIPs (prints SKIP, does not count as a failure) when win-job-launcher.exe
  // isn't built — plain worktrees and ubuntu CI never build it, so this case never runs there.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  if (!launcherBuilt) {
    console.log("SKIP  (B-launcher) win-job-launcher.exe not built — run `pnpm --filter @loom/daemon build:native` first.");
  } else {
    setWinJobLauncherOverrideForTest(undefined); // real detection — picks up the built launcher
    const repo = makeRepo("bl");
    const taskId = `mqb-task-bl-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    fs.writeFileSync(path.join(worktreePath, "bl1.txt"), "bl1\n");
    commitAll(worktreePath, "feat(test): bl1", GIT_ID);
    fs.writeFileSync(path.join(worktreePath, "bl2.txt"), "bl2\n");
    commitAll(worktreePath, "feat(test): bl2", GIT_ID);
    const cand = { workerSessionId: `mqb-wkr-bl-${sfx}`, taskId, branch, taskTitle: "feat(test): bl" };
    installDoubleForkedPreCommitHook(repo, S_HOLD_MS, S_MAIN_MS);

    const baseMainSha = git(repo, "rev-parse HEAD");
    const batchWt = await cutBatchWorktree(repo, "bl");
    const markerPath = path.join(batchWt, markerName);
    let gateInvoked = false;
    const trackedGate = async () => { gateInvoked = true; return passGate(); };

    const r = await runBatchedMerge(repo, batchWt, baseMainSha, [cand], trackedGate, { timeoutMs: SMALL_MS });
    console.log(`(B-launcher) info: runBatchedMerge -> ${JSON.stringify({ ok: r.ok, quarantined: r.quarantined, reason: r.reason })}`);
    check("(B-launcher) runBatchedMerge still refuses (the candidate's own commit failed and was dropped)", r.ok === false);
    check("(B-launcher) the TYPED quarantined flag is NOT set — the Job Object's confirmed kill means this is an ordinary drop, never a quarantine", r.quarantined !== true);
    check("(B-launcher) the gate NEVER ran", gateInvoked === false);
    check("(B-launcher) canonical HEAD is UNCHANGED (no fast-forward, not even bl1's own commit)", git(repo, "rev-parse HEAD") === baseMainSha);
    check("(B-launcher) the repo does NOT read as quarantined via the internal state", !activeMergeQuarantineFor(repo));
    // The escaped descendant never gets the chance to run: by the time runBatchedMerge resolves, the
    // launcher's Job Object kill-confirm has ALREADY settled synchronously (unlike SCENARIO B's fallback
    // path, where the descendant genuinely escapes and keeps running in the background) — so this is an
    // immediate check on already-settled state, not a race requiring its own bounded wait.
    check("(B-launcher) the escaped descendant's marker write is NEVER observed — the Job Object kills it before it can run", !fs.existsSync(markerPath));

    fs.rmSync(path.join(repo, ".git", "hooks", "pre-commit"), { force: true });
    try { execSync("git reset --hard HEAD", { cwd: repo }); } catch { /* best-effort */ }
    setWinJobLauncherOverrideForTest(undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO C — restart durability: a quarantine latch found at boot RE-ARMS, never silently discarded
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("c");
    const a = await cutBranch(repo, "c1", "c1.txt", "c1\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const batchWt = await cutBatchWorktree(repo, "c");

    enterMergeQuarantine(repo, "restart-test-branch", "manufactured for SCENARIO C");
    check("(C) precondition: the repo reads as quarantined pre-restart", !!activeMergeQuarantineFor(repo));
    const latchPath = fs.readdirSync(MERGE_QUARANTINE_DIR).find((f) => f.endsWith(".json"));
    check("(C) precondition: a durable latch file exists on disk", !!latchPath && fs.existsSync(path.join(MERGE_QUARANTINE_DIR, latchPath)));

    // This process's own in-memory map already has the entry `enterMergeQuarantine` just set — a real
    // restart would instead start from a FRESH, empty map, with only the durable FILE surviving. This
    // test can't spawn a genuinely separate process, but `reenterMergeQuarantinesAtBoot` re-populates
    // from disk regardless of whatever is already in memory (see its own doc), so calling it here still
    // exercises the real read path; SCENARIO C's later assertions (a THIRD re-entry after the human
    // clear finding nothing) are what actually prove the file — not a residual in-memory entry — is what
    // re-entry depends on.
    const reentered = reenterMergeQuarantinesAtBoot();
    const reenteredForThisRepo = reentered.find((q) => q.repoPath === repo);
    check("(C) reenterMergeQuarantinesAtBoot() reports this repo's latch", !!reenteredForThisRepo);
    check("(C) after re-entry, the repo STILL reads as quarantined (re-armed, not silently discarded)", !!activeMergeQuarantineFor(repo));

    // The refusal itself still works post-"restart" (re-entry), at the SAME convergence point batch uses.
    let gateInvoked = false;
    const r1 = await runBatchedMerge(repo, batchWt, baseMainSha, [a], async () => { gateInvoked = true; return passGate(); });
    check("(C) a merge attempt after re-entry still refuses", r1.ok === false && r1.quarantined === true);
    check("(C) still no gate burned", gateInvoked === false);

    // A restart-simulated re-entry that finds NOTHING to re-enter must NOT fabricate a quarantine —
    // negative control on the re-entry mechanism itself (a fresh, never-quarantined repo).
    const cleanRepo = makeRepo("c-clean");
    check("(C) control: a repo that was NEVER quarantined does not appear in a re-entry sweep", !reenterMergeQuarantinesAtBoot().some((q) => q.repoPath === cleanRepo));

    // HUMAN CLEAR (the only way to lift a re-entered quarantine — the same call the loopback REST route
    // makes): a bare in-memory clear alone is not exposed; `clearMergeQuarantine` is authoritative and
    // durable (also removes the file), so no THIRD re-entry could ever resurrect it.
    clearMergeQuarantine(repo);
    check("(C) after the human clear, the repo no longer reads as quarantined", !activeMergeQuarantineFor(repo));
    check("(C) after the human clear, the durable latch file is gone too", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, latchPath)));
    const reenteredAfterClear = reenterMergeQuarantinesAtBoot();
    check("(C) a THIRD re-entry (simulating yet another restart) finds nothing left to re-arm for this repo", !reenteredAfterClear.some((q) => q.repoPath === repo));

    const r2 = await runBatchedMerge(repo, batchWt, baseMainSha, [a], passGate);
    check("(C) once humanly cleared, a fresh merge attempt succeeds", r2.ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO D (round 6, Code Review NC1) — a quarantine raised MID-GATE (after runBatchedMerge's own
  // entry check already passed, and after assembly finished) must still refuse at fastForwardCanonicalMain.
  // Round-5 review: "no test hits the fastForwardCanonicalMain assert" — scenarios A/B/C above ALL raise
  // (or pre-exist) their quarantine BEFORE runBatchedMerge is even called, or during ASSEMBLY (which
  // itself aborts the batch before the gate ever runs) — none of them ever reach fastForwardCanonicalMain
  // with an ACTIVE quarantine. This scenario raises it from INSIDE the gate callback itself — the one
  // window neither runBatchedMerge's own entry check (already passed) nor assembly's own abort (already
  // finished cleanly) can see.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = makeRepo("d");
    const a = await cutBranch(repo, "d1", "d1.txt", "d1\n");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const batchWt = await cutBatchWorktree(repo, "d");

    let gateInvoked = false;
    const gateThatRaisesQuarantineMidRun = async () => {
      gateInvoked = true;
      // Simulates a genuinely independent op (a different merge/batch) quarantining this SAME canonical
      // repo WHILE this batch's own (minutes-long, in reality) gate is running — the exact race
      // fastForwardCanonicalMain's own check exists to close.
      enterMergeQuarantine(repo, "unrelated-branch", "manufactured MID-GATE for SCENARIO D / NC1");
      return passGate();
    };

    const r1 = await runBatchedMerge(repo, batchWt, baseMainSha, [a], gateThatRaisesQuarantineMidRun);
    check("(D) the gate DID run (this quarantine could not have been seen before it)", gateInvoked === true);
    check("(D) runBatchedMerge refuses AT THE FAST-FORWARD STEP, not vacuously", r1.ok === false);
    check("(D) the TYPED quarantined flag is set", r1.quarantined === true);
    check("(D) assembly itself succeeded (landed, not dropped) — this is specifically a POST-assembly refusal", r1.landed.length === 1 && r1.dropped.length === 0);
    check("(D) canonical HEAD did NOT advance despite a green gate and clean assembly", git(repo, "rev-parse HEAD") === baseMainSha);

    // NEGATIVE CONTROL: the identical shape, but the gate does NOT raise a quarantine — proves scenario D's
    // refusal above is caused BY the mid-gate quarantine, not some other defect in this exact call shape.
    // Cleared FIRST — SCENARIO D's own quarantine would otherwise also refuse cutting this control's batch
    // worktree (createWorktree is itself a covered convergence point — see merge-quarantine-lock-convergence.mjs).
    clearMergeQuarantine(repo);
    const batchWt2 = await cutBatchWorktree(repo, "d-control");
    const r2 = await runBatchedMerge(repo, batchWt2, baseMainSha, [a], passGate);
    check("(D) control: the IDENTICAL shape with no mid-gate quarantine lands normally", r2.ok === true);
    check("(D) control: canonical HEAD now advances", git(repo, "rev-parse HEAD") !== baseMainSha);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO E (card bde5d1fe item 2) — the ff-only merge ITSELF dies unconfirmed ⇒ tree-kill + QUARANTINE,
  // not a bare withTimeout abandoning the orphan (which pre-fix left NO tree-kill and NO quarantine raise
  // on this one call, unlike every other mutating call on this path).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    // Force the taskkill fallback path (card 4966d70c) — see the top-of-file note; SCENARIO E-LAUNCHER
    // below is this scenario's launcher-mode counterpart.
    setWinJobLauncherOverrideForTest(null);
    const repo = makeRepo("e");
    const baseMainSha = git(repo, "rev-parse HEAD");
    // A real, linear-descendant commit sha to fast-forward onto — cut from a SEPARATE worktree of the SAME
    // repo (shares the object database), exactly like a batch's own `batchHeadSha` is never a named ref.
    const { worktreePath } = await createWorktree(repo, projId, `mqb-task-e-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "e1.txt"), "e1\n");
    commitAll(worktreePath, "feat(test): e1", GIT_ID);
    const targetSha = git(worktreePath, "rev-parse HEAD");

    // post-merge's own cwd is the repo the merge ran IN — the canonical repo itself here, never a worktree.
    const markerPath = path.join(repo, markerNameE);
    installDoubleForkedPostMergeHook(repo, S_HOLD_MS, S_MAIN_MS, markerNameE);

    const r = await fastForwardCanonicalMain(repo, baseMainSha, targetSha, { timeoutMs: SMALL_MS });
    console.log(`(E) info: fastForwardCanonicalMain -> ${JSON.stringify({ ok: r.ok, quarantined: r.quarantined, reason: r.reason })}`);
    check("(E) fastForwardCanonicalMain refuses", r.ok === false);
    check("(E) the TYPED quarantined flag is set (kill-confirm + quarantine, never a bare timeout failure)", r.quarantined === true);
    check("(E) the repo reads as quarantined via the internal state too", !!activeMergeQuarantineFor(repo));

    // POSITIVE CONTROL: the escaped descendant genuinely ran (this scenario is not vacuous) — a bounded
    // poll on the real event, never a single fixed-length guessed sleep.
    const markerAppeared = await pollUntil(() => fs.existsSync(markerPath), { timeoutMs: S_HOLD_MS + 10000 });
    check("(E) the escaped descendant's marker write IS eventually observed (proves it genuinely ran)", markerAppeared);

    // AUTO-CLEAR: once the descendant's own exit lets confirmation finally arrive, the quarantine lifts.
    const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: AUTO_CLEAR_POLL_MS });
    check("(E) the quarantine auto-clears once the real tree-death confirmation eventually arrives", autoCleared);

    fs.rmSync(path.join(repo, ".git", "hooks", "post-merge"), { force: true });
    setWinJobLauncherOverrideForTest(undefined); // restore real detection before SCENARIO E-LAUNCHER
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO E-LAUNCHER (card 4966d70c) — launcher-mode counterpart to SCENARIO E: the ff-only merge's
  // own commits already landed (git completed the fast-forward itself) before the post-merge hook ever
  // ran, so when the hook's escaped descendant dies confirmed (same Job Object as SCENARIO B-LAUNCHER)
  // fastForwardCanonicalMain reports success from the merge that had already completed, rather than
  // refusing+quarantining. SKIPs when win-job-launcher.exe isn't built, same as SCENARIO B-LAUNCHER.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  if (!launcherBuilt) {
    console.log("SKIP  (E-launcher) win-job-launcher.exe not built — run `pnpm --filter @loom/daemon build:native` first.");
  } else {
    setWinJobLauncherOverrideForTest(undefined); // real detection — picks up the built launcher
    const repo = makeRepo("el");
    const baseMainSha = git(repo, "rev-parse HEAD");
    const { worktreePath } = await createWorktree(repo, projId, `mqb-task-el-${sfx}`);
    fs.writeFileSync(path.join(worktreePath, "el1.txt"), "el1\n");
    commitAll(worktreePath, "feat(test): el1", GIT_ID);
    const targetSha = git(worktreePath, "rev-parse HEAD");

    const markerPath = path.join(repo, markerNameE);
    installDoubleForkedPostMergeHook(repo, S_HOLD_MS, S_MAIN_MS, markerNameE);

    const r = await fastForwardCanonicalMain(repo, baseMainSha, targetSha, { timeoutMs: SMALL_MS });
    console.log(`(E-launcher) info: fastForwardCanonicalMain -> ${JSON.stringify({ ok: r.ok, quarantined: r.quarantined, reason: r.reason })}`);
    check("(E-launcher) fastForwardCanonicalMain SUCCEEDS — the ff-only merge itself had already landed before the hook ran", r.ok === true);
    check("(E-launcher) the TYPED quarantined flag is NOT set", r.quarantined !== true);
    check("(E-launcher) canonical HEAD now matches the fast-forward target", git(repo, "rev-parse HEAD") === targetSha);
    check("(E-launcher) the repo does NOT read as quarantined via the internal state", !activeMergeQuarantineFor(repo));
    // Same reasoning as SCENARIO B-LAUNCHER: the Job Object's kill-confirm has already settled
    // synchronously by the time fastForwardCanonicalMain resolves, so this is an immediate check on
    // already-settled state, not a race requiring its own bounded wait.
    check("(E-launcher) the escaped descendant's marker write is NEVER observed — the Job Object kills it before it can run", !fs.existsSync(markerPath));

    fs.rmSync(path.join(repo, ".git", "hooks", "post-merge"), { force: true });
    setWinJobLauncherOverrideForTest(undefined);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — runBatchedMerge refuses BEFORE assembly against an already-quarantined canonical repo " +
    "(scenario A), a candidate dying unconfirmed mid-batch aborts the WHOLE batch with no gate/fast-forward " +
    "and canonical HEAD untouched (scenario B), and a quarantine latch found at boot RE-ARMS the refusal " +
    "rather than being silently discarded by a restart, lifted only by the human clear (scenario C)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
