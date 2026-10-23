import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers the courtesy-pre-check-vs-lock-admission TOCTOU race, the in-lock alert re-check, and GitWriter.checkout()'s post-checkout sha:null degrade (both the raw-method and checkoutProjectBranch-service shapes) plus the in-lock classified-tip mismatch:
//   - (S2) TOCTOU: a race between the courtesy pre-check and lock admission
//   - (ALERT-LOCK) the unresolved-alert check now runs in-lock too, not just outside (m3)
//   - (N1) GitWriter.checkout()'s post-checkout sha read degrades to sha:null
//   - (N1-SERVICE) checkoutProjectBranch's OWN sha:null handling, through the real method (M3-iii)
//   - (N1-MISMATCH) the landed sha is compared against the in-lock classified tip (n1)
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-toctou-n1.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-toctou-");

import {
  loadPcbDistModules, makeFixtureKit, git, registerForCleanup,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db, withCanonicalIndexLock, GitWriter } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (S2) TOCTOU: a race between the courtesy pre-check and lock admission =====================
  // @decision 2a6a292a round 7 (M3-i) — a plain "insert right after kicking off the call, no await in
  // between" race is UNRELIABLE: every step in between (the real `git branch`/`db.insertSession` the
  // race needs) is SYNCHRONOUS and therefore runs to completion in the SAME tick BEFORE the call's own
  // async chain (MCP transport connect → tool dispatch → the courtesy pre-check's own async git reads)
  // gets a chance to run at all — the insertion can land BEFORE the outer pre-check, not strictly after
  // it, so a disabled in-lock hook could still read green for the WRONG reason (the outer pre-check
  // catching it instead). A call-counting hook on `checkoutProjectBranchPrecondition` itself removes the
  // ambiguity: it resolves a promise the instant the FIRST (outer, courtesy) invocation actually
  // completes, so the race insertion is provably ordered after it and before the SECOND (in-lock)
  // invocation, which is the one this test actually means to exercise.
  {
    const fx = makeFixture("s2");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(S2) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    let preCheckCalls = 0;
    let firstPreCheckDone;
    const firstPreCheckDoneP = new Promise((res) => { firstPreCheckDone = res; });
    const originalPrecondition = fx.sessions.checkoutProjectBranchPrecondition.bind(fx.sessions);
    fx.sessions.checkoutProjectBranchPrecondition = async (...a) => {
      const result = await originalPrecondition(...a);
      preCheckCalls++;
      if (preCheckCalls === 1) firstPreCheckDone();
      return result;
    };

    // The real call's courtesy pre-check (outside the lock) runs and passes immediately — nothing blocks
    // it yet. It then calls writer.checkout(), which queues behind the held lock.
    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // PROVABLY after the outer courtesy pre-check has already run and passed.
    // Insert the unmerged worker NOW — guaranteed strictly after pre-check #1, and (since the lock is
    // still held) strictly before pre-check #2 (the in-lock one). Deliberately NOT via addWorker()/
    // createWorktree(): a FRESH worktree cut ALSO acquires withCanonicalIndexLock, so using it here would
    // deadlock against the lock THIS scenario is deliberately holding open. A plain `git branch` (no
    // lock) plus a direct DB session row carries everything listUnmergedWorkerBranches actually reads
    // (role/processState/worktreePath-on-disk/branch), with no lock involved.
    const raceBranch = "loom/pcb-s2-race";
    git(fx.repo, "branch", raceBranch);
    const raceWorktreeDir = path.join(os.tmpdir(), `loom-pcb-s2-race-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(raceWorktreeDir, { recursive: true });
    registerForCleanup(raceWorktreeDir);
    const raceWorkerId = "pcb-s2-race-wkr", raceTaskId = "pcb-s2-race-task";
    const nowIso = new Date().toISOString();
    db.insertTask({ id: raceTaskId, projectId: fx.projId, title: "feat(x): race", body: "", columnKey: "in_progress", position: 1, createdAt: nowIso, updatedAt: nowIso });
    db.insertSession({ id: raceWorkerId, projectId: fx.projId, agentId: fx.agentId, engineSessionId: null, title: null, cwd: raceWorktreeDir, processState: "exited", resumability: "unknown", busy: false, createdAt: nowIso, lastActivity: nowIso, lastError: null, role: "worker", parentSessionId: fx.mgrId, taskId: raceTaskId, worktreePath: raceWorktreeDir, branch: raceBranch });
    const w = { workerId: raceWorkerId };
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(S2) the outer courtesy pre-check ran exactly once before the race insertion, and the in-lock one ran after (ordering actually proven, not assumed)", preCheckCalls === 2);
    check("(S2) a worker inserted between the courtesy pre-check and lock admission is still caught (RED if the in-lock precondition hook is removed)", result.ok === false && result.refused === true && result.unmergedWorkers?.some((u) => u.workerSessionId === w.workerId));
    check("(S2) canonical untouched by the refusal", fx.canonBranch() === fx.main);
  }

  // ===================== (ALERT-LOCK) the unresolved-alert check now runs in-lock too, not just outside (m3) =====================
  {
    const fx = makeFixture("alertlock");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(ALERT-LOCK) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    let preCheckCalls = 0;
    let firstPreCheckDone;
    const firstPreCheckDoneP = new Promise((res) => { firstPreCheckDone = res; });
    const originalPrecondition = fx.sessions.checkoutProjectBranchPrecondition.bind(fx.sessions);
    fx.sessions.checkoutProjectBranchPrecondition = async (...a) => {
      const result = await originalPrecondition(...a);
      preCheckCalls++;
      if (preCheckCalls === 1) firstPreCheckDone();
      return result;
    };

    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // the outer courtesy pre-check already ran and passed (no alert existed yet)
    // NOW set the alert marker — strictly after pre-check #1, strictly before pre-check #2 (in-lock).
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["reflog-raw-write"], suspectShas: ["b".repeat(40)], nudgedAt: new Date().toISOString() }));
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(ALERT-LOCK) ordering actually proven: both pre-check invocations ran", preCheckCalls === 2);
    check("(ALERT-LOCK) a marker set between the outer pre-check and lock admission is still caught by the IN-LOCK check (RED if m3's move is reverted)", result.ok === false && result.refused === true && /unresolved mainline alert/.test(result.error));
    check("(ALERT-LOCK) canonical untouched by the refusal", fx.canonBranch() === fx.main);
  }

  // ===================== (N1) GitWriter.checkout()'s post-checkout sha read degrades to sha:null =====================
  {
    const fx = makeFixture("n1");
    git(fx.repo, "branch", "atlas");
    // A fully FAKE WriterGit (mirrors git-writer-kill-confirm.mjs's own test-seam convention — no real
    // simple-git instance, no real child process at all): `checkout`/`raw(["checkout",...])` succeed
    // without touching the real repo (this is a pure unit check on GitWriter's OWN degrade logic, not a
    // claim about a real mutation), `branchLocal` reports the target branch, and `revparse` throws —
    // simulating the post-checkout `git rev-parse HEAD` read timing out/erroring AFTER a checkout that
    // (in production) already succeeded.
    const fakeGit = {
      checkout: async () => {}, checkoutLocalBranch: async () => {},
      // @decision 59e53710 (round 3) — `checkout()`'s PRE-spawn existence check reads `refs/heads/` via
      // `raw(["for-each-ref",...])`, not `branchLocal()` — the response must list "refs/heads/atlas" or
      // that check refuses first, before ever reaching the simulated POST-checkout revparse failure below.
      branchLocal: async () => ({ current: "atlas", all: ["atlas"] }),
      status: async () => ({ isClean: () => true, files: [] }),
      raw: async (args) => (Array.isArray(args) && args[0] === "for-each-ref" ? "refs/heads/atlas\n" : ""),
      commit: async () => ({ commit: "" }),
      // `revparse` is ALSO used for the unrelated operational-home toplevel probe
      // (`["--show-toplevel"]`) earlier in checkout() — only the post-checkout `["HEAD"]` read must fail.
      revparse: async (args) => {
        if (Array.isArray(args) && args[0] === "HEAD") throw new Error("simulated rev-parse HEAD failure (N1 test seam)");
        return fx.repo;
      },
    };
    const writer = new GitWriter(fx.repo, { gitFactory: () => fakeGit });
    const result = await writer.checkout("atlas");
    check("(N1) checkout() still reports ok:true for a mutation that (in production) already happened", result.ok === true && result.branch === "atlas");
    check("(N1) sha degrades to null instead of the whole call failing", result.ok === true && result.sha === null);
    // checkoutProjectBranch's OWN handling of this exact shape (refuse the repoint, name that the
    // checkout itself succeeded) has no test seam to reach via a fake GitWriter — it is exercised
    // directly in sessions/service.ts's own code path and covered by this file's other scenarios
    // constructing a REAL GitWriter; this scenario's job is proving GitWriter.checkout() itself degrades
    // instead of throwing, which is the one new behavior round 6 adds. (M3-iii closes the gap this
    // comment used to describe — see (N1-SERVICE) below, which DOES reach checkoutProjectBranch's own
    // handling, through the real method, via a `GitWriter.prototype.checkout` patch instead of a fake.)
  }

  // ===================== (N1-SERVICE) checkoutProjectBranch's OWN sha:null handling, through the real method (M3-iii) =====================
  {
    const fx = makeFixture("n1service");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Patches the CLASS prototype (checkoutProjectBranch constructs its own GitWriter instance, so there
    // is no instance to inject into) — forwards to the REAL checkout() (so the real precondition hook,
    // the real git mutation, and the real branch read all still happen exactly as in production), then
    // forces `sha` to `null` on an otherwise-successful result — simulating the post-checkout rev-parse
    // timing out AFTER the checkout already succeeded, without weakening any check along the way.
    const originalCheckout = GitWriter.prototype.checkout;
    GitWriter.prototype.checkout = async function (branch, opts) {
      const real = await originalCheckout.call(this, branch, opts);
      return real.ok ? { ...real, sha: null } : real;
    };
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    GitWriter.prototype.checkout = originalCheckout;
    check("(N1-SERVICE) checkoutProjectBranch refuses to repoint when the sha could not be confirmed (M3-iii)", r1.ok === false && /could not be confirmed/.test(r1.error));
    check("(N1-SERVICE) the checkout itself DID actually succeed (canonical really moved)", fx.canonBranch() === "atlas");
    check("(N1-SERVICE) W was NOT re-pointed despite the real mutation succeeding", fx.watermark() === null);
    // negative control (round 8 MAJOR #2): with real sha reporting restored, the same call now succeeds —
    // and, because W was left stuck on the OLD (absent) watermark by the refusal above while the canonical
    // checkout genuinely moved to atlas, this is NOT a bare untouched noop: it re-validates the full
    // precondition in-lock and actually RE-POINTS W, which the old noop path never did.
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-SERVICE) negative control: the SAME call now succeeds and actually re-points the previously-stuck watermark (round 8 MAJOR #2, not a bare noop)", r2.ok === true && r2.noop === false && fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === fx.canonHead());
  }

  // ===================== (N1-MISMATCH) the landed sha is compared against the in-lock classified tip (n1) =====================
  {
    const fx = makeFixture("n1mismatch");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Patches the INSTANCE method (unlike (N1-SERVICE) above, which patches the GitWriter class) so the
    // real checkout still happens unmodified — only the CLASSIFIED tip `refuseIfTargetBranchUntrusted`
    // reports is deliberately wrong, simulating a genuine divergence between what was classified and what
    // actually landed.
    const original = fx.sessions.refuseIfTargetBranchUntrusted.bind(fx.sessions);
    fx.sessions.refuseIfTargetBranchUntrusted = async (a) => {
      const real = await original(a);
      return real.ok ? { ok: true, classifiedTip: "0".repeat(40) } : real;
    };
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    fx.sessions.refuseIfTargetBranchUntrusted = original;
    check("(N1-MISMATCH) refuses when the landed sha does not match the classified tip (n1)", r1.ok === false && /does not match/.test(r1.error));
    check("(N1-MISMATCH) W was NOT re-pointed on the mismatch", fx.watermark() === null);
    // @decision 2a6a292a round 11 (CR8, item 2) — this mismatch is now direct evidence of a concurrent
    // ref write and files the SAME HIGH event/alert every other refusal in this gate files, so a bare
    // retry is refused too (see immediately below) until a human clears it — round 8's own "a bare retry
    // silently succeeds" no longer holds; see the decision record's round-11 section.
    check("(N1-MISMATCH) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", fx.mwEvents().some((e) => e.detail.evidence?.includes("untrusted-tip-mismatch")));
    const r1b = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-MISMATCH) a bare retry is refused by the newly-filed alert, not silently re-admitted", r1b.ok === false && /unresolved mainline alert/.test(r1b.error));
    // negative control (round 8 MAJOR #2, now gated behind clearing the alert — the human-only reset's
    // own effect, see (ALERT) above): once cleared, a retry re-validates the full precondition in-lock and
    // actually RE-POINTS the previously-stuck watermark, not a bare untouched noop.
    db.deleteMeta(fx.alertKey);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(N1-MISMATCH) negative control: once the alert is cleared, the SAME call now succeeds and actually re-points the previously-stuck watermark (round 8 MAJOR #2, not a bare noop)", r2.ok === true && r2.noop === false && fx.watermark()?.branch === "atlas" && fx.watermark()?.sha === fx.canonHead());
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "the courtesy-pre-check-vs-lock-admission TOCTOU race, the in-lock alert re-check, and GitWriter.checkout()'s post-checkout sha:null degrade (both the raw-method and checkoutProjectBranch-service shapes) plus the in-lock classified-tip mismatch" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
