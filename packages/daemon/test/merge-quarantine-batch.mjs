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
  const SMALL_MS = 2000;
  const S_HOLD_MS = 2 * SMALL_MS + 4000; // comfortably past withTimeoutKillingChild's own give-up deadline
  const S_MAIN_MS = 15000;
  const markerName = "escaped-descendant-b.marker";
  function installDoubleForkedPreCommitHook(repo, holdMs, mainMs) {
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hookPath,
      `#!/bin/sh\n( (sleep ${holdMs / 1000}; echo fixedY > fixedY.txt; git add fixedY.txt; echo done > ${markerName}) & )\nsleep ${mainMs / 1000}\n`);
    fs.chmodSync(hookPath, 0o755);
  }
  {
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
    const markerAppeared = await pollUntil(() => fs.existsSync(markerPath), { timeoutMs: S_HOLD_MS + 5000 });
    check("(B) the escaped descendant's marker write IS eventually observed (proves it genuinely ran, not skipped)", markerAppeared);

    // AUTO-CLEAR: once the descendant's own exit lets confirmation finally arrive, the quarantine lifts —
    // bounded poll on the real internal state, never a fixed guessed sleep.
    const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: 20000 });
    check("(B) the quarantine auto-clears once the real tree-death confirmation eventually arrives", autoCleared);

    // Clean up the now-irrelevant slow hook + the (still staged, from the interrupted commit 2) residue
    // before this file's OWN cleanup tries to touch the worktree/repo.
    fs.rmSync(path.join(repo, ".git", "hooks", "pre-commit"), { force: true });
    try { execSync("git reset --hard HEAD", { cwd: repo }); } catch { /* best-effort */ }
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
    const markerNameE = "escaped-descendant-e.marker";
    function installDoubleForkedPostMergeHook(repo, holdMs, mainMs) {
      const hookPath = path.join(repo, ".git", "hooks", "post-merge");
      fs.writeFileSync(hookPath,
        `#!/bin/sh\n( (sleep ${holdMs / 1000}; echo escaped > ${markerNameE}) & )\nsleep ${mainMs / 1000}\n`);
      fs.chmodSync(hookPath, 0o755);
    }

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
    installDoubleForkedPostMergeHook(repo, S_HOLD_MS, S_MAIN_MS);

    const r = await fastForwardCanonicalMain(repo, baseMainSha, targetSha, { timeoutMs: SMALL_MS });
    console.log(`(E) info: fastForwardCanonicalMain -> ${JSON.stringify({ ok: r.ok, quarantined: r.quarantined, reason: r.reason })}`);
    check("(E) fastForwardCanonicalMain refuses", r.ok === false);
    check("(E) the TYPED quarantined flag is set (kill-confirm + quarantine, never a bare timeout failure)", r.quarantined === true);
    check("(E) the repo reads as quarantined via the internal state too", !!activeMergeQuarantineFor(repo));

    // POSITIVE CONTROL: the escaped descendant genuinely ran (this scenario is not vacuous) — a bounded
    // poll on the real event, never a single fixed-length guessed sleep.
    const markerAppeared = await pollUntil(() => fs.existsSync(markerPath), { timeoutMs: S_HOLD_MS + 5000 });
    check("(E) the escaped descendant's marker write IS eventually observed (proves it genuinely ran)", markerAppeared);

    // AUTO-CLEAR: once the descendant's own exit lets confirmation finally arrive, the quarantine lifts.
    const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: 20000 });
    check("(E) the quarantine auto-clears once the real tree-death confirmation eventually arrives", autoCleared);

    fs.rmSync(path.join(repo, ".git", "hooks", "post-merge"), { force: true });
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
