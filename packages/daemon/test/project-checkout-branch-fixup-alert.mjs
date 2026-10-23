import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers a real-but-stale tip, the fixup path's own in-lock TOCTOU re-run, every mainline-alert-marker refusal (and the one marker that does NOT block), the already-checked-out no-op, and the LIVE/worktree-on-disk unmerged-worker scope:
//   - (REWIND) round 9 — a genuinely REAL (trailered) but STALE tip is refused, same as any mismatch
//   - (FIXUP-TOCTOU) round 9 — the fixup path's OWN in-lock precondition re-run actually matters
//   - (ALERT) any existing mainline alert marker blocks the switch outright
//   - (S3) a purely-informational first-sight-declined marker does NOT block
//   - (NOOP) the branch already checked out is a no-op
//   - (S1) the unmerged-worker refusal scopes to LIVE or worktree-still-on-disk
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-fixup-alert.mjs
import fs from "node:fs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-fixup-");

import {
  loadPcbDistModules, makeFixtureKit, git,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db, withCanonicalIndexLock } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (REWIND) round 9 — a genuinely REAL (trailered) but STALE tip is refused, same as any mismatch =====================
  {
    const fx = makeFixture("rewind");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(REWIND) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const created = await fx.call("project_checkout_branch", { branch: "rw-target", create: true });
    check("(REWIND) setup: create:true switches to a brand-new rw-target", created.ok === true && fx.canonBranch() === "rw-target");
    const w1 = await fx.addWorker("rw1");
    const landed1 = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w1.workerId);
    check("(REWIND) setup: a FIRST real landing lands on the target branch", landed1.settled === true && landed1.ok === true && landed1.value.merged === true);
    const firstLandingSha = fx.canonHead();
    const w2 = await fx.addWorker("rw2");
    const landed2 = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w2.workerId);
    check("(REWIND) setup: a SECOND real landing lands on top — trust now tracks this one", landed2.settled === true && landed2.ok === true && landed2.value.merged === true);
    check("(REWIND) setup: trust tracks the SECOND landing, not the first", fx.trust("rw-target") !== firstLandingSha && fx.trust("rw-target") === fx.canonHead());
    const backToMain = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(REWIND) setup: switch back to main, parking rw-target", backToMain.ok === true);
    // Force the parked branch BACKWARD onto its own, genuinely real, FIRST (trailered) landing — not the
    // current trust record (the second landing). No delete, no foreign content — a real but STALE tip.
    git(fx.repo, "branch", "-f", "rw-target", firstLandingSha);
    check("(REWIND) setup: the branch really moved BACKWARD onto its own first (real) landing", git(fx.repo, "rev-parse", "rw-target") === firstLandingSha);
    const wBefore = fx.watermark();
    const r = await fx.call("project_checkout_branch", { branch: "rw-target" });
    check("(REWIND) a real but STALE tip (an earlier real landing, not the current trust record) is refused — no special-case rewind logic exists, this is just the exact-match rule", r.ok === false && r.refused === true);
    check("(REWIND) W was NOT re-pointed", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(REWIND) the filed event names untrusted-tip-mismatch", fx.mwEvents().some((e) => e.detail.branch === "rw-target" && e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === firstLandingSha));
  }

  // ===================== (FIXUP-TOCTOU) round 9 — the fixup path's OWN in-lock precondition re-run actually matters =====================
  // Mirrors (S2)'s call-counting technique, but targets the DIFFERENT in-lock precondition call inside
  // checkoutProjectBranch's "already checked out, W disagrees" fixup branch (not the ordinary-switch
  // GitWriter.checkout() precondition hook (S2) already covers).
  {
    const fx = makeFixture("fixuptoctou");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    git(fx.repo, "checkout", "-q", "atlas"); // canonical already on atlas, out-of-band; W is still absent/elsewhere
    check("(FIXUP-TOCTOU) setup: canonical is already on atlas with no watermark yet, routing into the fixup path", fx.canonBranch() === "atlas" && fx.watermark() === null);

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

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(FIXUP-TOCTOU) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    const callP = fx.call("project_checkout_branch", { branch: "atlas" });
    await firstPreCheckDoneP; // PROVABLY after the fixup path's own outer courtesy pre-check has run and passed
    // Raw-tamper atlas NOW — strictly after pre-check #1, strictly before pre-check #2 (the fixup's own
    // in-lock re-run) — so the SECOND call is what must catch it, not the stale outer read. `branch -f`
    // refuses on a branch checked out in ANY worktree (including this one, the primary checkout) — use
    // `update-ref` instead (the same plumbing bypass (LNDR)/(B1) use to tamper the CURRENTLY checked-out
    // branch), which has no such restriction.
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", git(fx.repo, "rev-parse", "atlas"), "-m", "");
    git(fx.repo, "update-ref", "refs/heads/atlas", foreign);
    releaseLock();
    await lockHeld;
    const result = await callP;
    fx.sessions.checkoutProjectBranchPrecondition = originalPrecondition;
    check("(FIXUP-TOCTOU) ordering actually proven: both pre-check invocations ran", preCheckCalls === 2);
    check("(FIXUP-TOCTOU) a tamper inserted between the fixup path's outer pre-check and its OWN in-lock re-run is still caught (RED if that in-lock re-run is removed)", result.ok === false && result.refused === true);
    check("(FIXUP-TOCTOU) W was never re-pointed onto the tampered tip", fx.watermark() === null || fx.watermark()?.sha !== foreign);
  }

  // ===================== (ALERT) any existing mainline alert marker blocks the switch outright =====================
  {
    const fx = makeFixture("alert");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(ALERT) setup: W established on main", seeded.settled === true && seeded.ok === true && fx.watermark()?.branch === fx.main);
    // Seed an UNRELATED, already-DELIVERED alert marker directly — proves the gate is "does a marker
    // exist at all", not "is it still undelivered".
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["reflog-raw-write"], suspectShas: ["b".repeat(40)], nudgedAt: new Date().toISOString() }));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(ALERT) an existing (even DELIVERED) alert marker refuses the switch outright", r1.ok === false && r1.refused === true && /unresolved mainline alert/.test(r1.error));
    check("(ALERT) W untouched by the refusal", fx.watermark()?.branch === fx.main);
    check("(ALERT) canonical untouched", fx.canonBranch() === fx.main);
    // negative control: clear the marker (the human-only reset's own effect) and the same call succeeds.
    db.deleteMeta(fx.alertKey);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(ALERT) negative control: once the marker is cleared, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (S3) a purely-informational first-sight-declined marker does NOT block =====================
  {
    const fx = makeFixture("s3");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    // Mirrors recordFirstSightDeclined's own marker shape exactly (nudgedAt stamped immediately).
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "", to: fx.main, evidence: ["first-sight-declined"], suspectShas: [], expectedBranch: "origin-default", source: "boot", nudgedAt: new Date().toISOString() }));
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S3) a first-sight-declined marker does NOT block the switch", r1.ok === true);
    // negative control: a REAL evidence kind in the same slot still blocks.
    db.setMeta(fx.alertKey, JSON.stringify({ branch: fx.main, from: "a".repeat(40), to: "b".repeat(40), evidence: ["branch-diverted"], suspectShas: ["b".repeat(40)], expectedBranch: fx.main, nudgedAt: new Date().toISOString() }));
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S3) negative control: a REAL evidence kind in the same marker slot still blocks", r2.ok === false && r2.refused === true);
  }

  // ===================== (NOOP) the branch already checked out is a no-op =====================
  {
    const fx = makeFixture("noop");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(NOOP) setup: W established on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const evBefore = fx.mwEvents().length;
    const r1 = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(NOOP) calling checkout on the branch already checked out is a noop", r1.ok === true && r1.noop === true && r1.branch === fx.main && r1.sha === wBefore.sha);
    check("(NOOP) W is NOT re-pointed (identical before/after)", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(NOOP) no new audit event was filed for a noop", fx.mwEvents().length === evBefore);
  }

  // ===================== (S1) the unmerged-worker refusal scopes to LIVE or worktree-still-on-disk =====================
  {
    const fx = makeFixture("s1");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");

    const live = await fx.addWorker("live");
    db.setProcessState(live.workerId, "live"); // addWorker always inserts "exited" — flip it

    const gone = await fx.addWorker("gone");
    fs.rmSync(gone.worktreePath, { recursive: true, force: true }); // exited AND worktree removed

    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S1) a LIVE unmerged worker still blocks", r1.ok === false && r1.refused === true && r1.unmergedWorkers?.some((u) => u.workerSessionId === live.workerId));
    check("(S1) an exited worker whose worktree was already removed does NOT block", !r1.unmergedWorkers?.some((u) => u.workerSessionId === gone.workerId));

    // negative control: once the live one is also stopped AND its worktree removed, the call succeeds.
    db.setProcessState(live.workerId, "exited");
    fs.rmSync(live.worktreePath, { recursive: true, force: true });
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(S1) negative control: once BOTH are gone, the SAME call now succeeds", r2.ok === true);
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "a real-but-stale tip, the fixup path's own in-lock TOCTOU re-run, every mainline-alert-marker refusal (and the one marker that does NOT block), the already-checked-out no-op, and the LIVE/worktree-on-disk unmerged-worker scope" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
