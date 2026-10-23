import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers round 9's exact-trust-match-only rule: every untrailered or forged-trailer bypass onto a non-matching tip is refused identically (incl. the SAME forged tip reached via the already-checked-out fixup path, which shares this file's own m1Fixture/m1Evidence helpers):
//   - (M1) round 8's CRITICAL fix: an untrailered-descendant bypass, caught on ITS OWN classification
//   - (M1) negative control: ONLY an exact trust-record match is allowed
//   - (FORGED) round 9 — a FORGED Loom-Worker-Branch trailer is no longer special-cased
//   - (FORGED-FIXUP) round 9 — the SAME forged tip, reached via the "already checked out, W disagrees" fixup path
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-bypass-m1.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-m1-");

import {
  loadPcbDistModules, makeFixtureKit, git, commitAll, GIT_ID, registerForCleanup,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (M1) round 8's CRITICAL fix: an untrailered-descendant bypass, caught on ITS OWN classification =====================
  // Round 7's own fix (reflog-reach + forward-only) never actually needed the reflog-reach half: every
  // repro it was meant to catch lands an UNTRAILERED descendant of the trusted sha, and `branch -f` (no
  // delete) keeps that branch's reflog fully intact while staying forward — so round 7's own fix MISSED
  // it entirely (the fourth Code Review's finding). Each repro below gets its OWN fresh fixture (a shared
  // fixture let round 7's own M1 test pass for the WRONG reason — a sibling repro's leftover project-wide
  // alert marker, not that repro's own classification) and asserts the SPECIFIC filed event's `evidence`
  // tag, never just `refused === true`.
  async function m1Fixture(label) {
    const fx = makeFixture(label);
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check(`(M1 ${label}) setup: a real landing establishes W + trust on main`, seeded.settled === true && seeded.ok === true);
    const target = `m1-${label}`;
    git(fx.repo, "branch", target, fx.main);
    const trustedSha = git(fx.repo, "rev-parse", target);
    fx.trustBranch(target);
    return { fx, target, trustedSha };
  }
  const m1Evidence = (fx, target) => fx.mwEvents().filter((e) => e.detail.branch === target && e.detail.severity === "high");

  // -- repro 1: delete-and-recreate (git update-ref -d, then onto a descendant) --
  {
    const { fx, target, trustedSha } = await m1Fixture("del-recreate");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "update-ref", "-d", `refs/heads/${target}`);
    git(fx.repo, "update-ref", `refs/heads/${target}`, foreign);
    check("(M1 del-recreate) setup: the branch really moved via delete-and-recreate", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 del-recreate) is refused", r.ok === false && r.refused === true);
    check("(M1 del-recreate) the filed event's evidence names untrusted-tip-mismatch (the SPECIFIC reason, never just refused===true)", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
    check("(M1 del-recreate) W was NOT laundered onto the foreign tip", fx.watermark()?.branch !== target);
  }

  // -- repro 2: `git branch -f` onto a descendant — no delete happens, so the branch's reflog stays fully
  //    intact; round 9 no longer reads the reflog at all for this gate, so that is irrelevant here. --
  {
    const { fx, target, trustedSha } = await m1Fixture("force-descendant");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "branch", "-f", target, foreign);
    check("(M1 force-descendant) setup: the branch really moved via branch -f onto a descendant (reflog intact, forward)", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 force-descendant) is refused — any tip other than an exact trust-record match is refused", r.ok === false && r.refused === true);
    check("(M1 force-descendant) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 3: `git branch -D` then recreate under the SAME name, onto a descendant --
  {
    const { fx, target, trustedSha } = await m1Fixture("delete-recreate2");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "branch", "-D", target);
    git(fx.repo, "branch", target, foreign);
    check("(M1 delete-recreate2) setup: the branch really moved via branch -D + recreate", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 delete-recreate2) is refused", r.ok === false && r.refused === true);
    check("(M1 delete-recreate2) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 4: a FORGED `update-ref -m "commit: …"` message onto a descendant — the message LOOKS
  //    porcelain (matches PORCELAIN_REFLOG) but no porcelain commit ever happened --
  {
    const { fx, target, trustedSha } = await m1Fixture("forged-message");
    const foreign = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "");
    git(fx.repo, "update-ref", "-m", "commit: a forged message that looks porcelain", `refs/heads/${target}`, foreign);
    check("(M1 forged-message) setup: the branch really moved via a forged, porcelain-looking update-ref message", git(fx.repo, "rev-parse", target) === foreign);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 forged-message) is refused — a forged porcelain-looking reflog message does not launder a mismatched tip", r.ok === false && r.refused === true);
    check("(M1 forged-message) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 5: a GENUINE porcelain commit made on the parked branch from a SECOND `git worktree add` —
  //    the exact Code Review repro, a real commit (not a simulated commit-tree graft) --
  {
    const { fx, target } = await m1Fixture("parked-worktree-commit");
    const wtDir = path.join(os.tmpdir(), `loom-pcb-m1-wtadd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    registerForCleanup(wtDir);
    git(fx.repo, "worktree", "add", "-q", wtDir, target);
    fs.writeFileSync(path.join(wtDir, "wtadd.txt"), "x\n");
    commitAll(wtDir, "feat(x): a real porcelain commit on the parked branch via worktree add", GIT_ID);
    git(fx.repo, "worktree", "remove", "--force", wtDir);
    check("(M1 parked-worktree-commit) setup: the branch really moved via a genuine porcelain commit", git(fx.repo, "rev-parse", target) !== git(fx.repo, "rev-parse", fx.main));
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 parked-worktree-commit) is refused — a real commit with no matching trust record is not a clean move", r.ok === false && r.refused === true);
    check("(M1 parked-worktree-commit) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // -- repro 6: `git branch -f` onto a GENUINELY non-ancestor tip — proves the exact-match rule refuses
  //    regardless of forward/backward relationship, not just a forward-descendant shape --
  {
    const { fx, target, trustedSha } = await m1Fixture("force-non-ancestor");
    // An unrelated ROOT commit (no -p parent at all) — provably neither an ancestor nor a descendant of
    // trustedSha, regardless of any coincidental tree-content overlap.
    const unrelated = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-m", "");
    git(fx.repo, "branch", "-f", target, unrelated);
    check("(M1 force-non-ancestor) setup: the branch really moved onto a tip that is NOT a descendant of the trusted sha", git(fx.repo, "rev-parse", target) === unrelated && unrelated !== trustedSha);
    const r = await fx.call("project_checkout_branch", { branch: target });
    check("(M1 force-non-ancestor) is refused — any non-matching tip is refused, ancestor relationship irrelevant", r.ok === false && r.refused === true);
    check("(M1 force-non-ancestor) the filed event's evidence names untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // ===================== (M1) negative control: ONLY an exact trust-record match is allowed =====================
  {
    const cleanFx = makeFixture("m1clean");
    const cleanSeed = await cleanFx.addWorker("seed");
    const cleanSeeded = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, cleanSeed.workerId);
    check("(M1 negative control) setup: a real landing establishes W + trust on main", cleanSeeded.settled === true && cleanSeeded.ok === true);

    // -- round 9: a REAL, multi-commit Loom-trailered chain is now REFUSED the instant trust lags even ONE
    //    landing behind the live tip — the accepted cost of deleting all git-derived classification (see
    //    the decision record's round-9 section). This REPLACES round 8's own negative control, which
    //    asserted the OPPOSITE (that such a chain was still allowed) — that was precisely the behaviour a
    //    forged trailer could exploit. --
    const created = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing", create: true });
    check("(M1 negative control) setup: create:true switches to a brand-new branch", created.ok === true);
    const w1 = await cleanFx.addWorker("landing1");
    const landed1 = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, w1.workerId);
    check("(M1 negative control) setup: a FIRST real landing lands on the new branch", landed1.settled === true && landed1.ok === true && landed1.value.merged === true);
    const s1 = cleanFx.canonHead();
    const w2 = await cleanFx.addWorker("landing2");
    const landed2 = await cleanFx.sessions.confirmWorkerMergeTracked(cleanFx.mgrId, w2.workerId);
    check("(M1 negative control) setup: a SECOND real landing lands on top", landed2.settled === true && landed2.ok === true && landed2.value.merged === true);
    const s2 = cleanFx.canonHead();
    check("(M1 negative control) setup: two real landings produced two distinct, chained tips", s1 !== s2 && s1 !== null && s2 !== null);
    const backToMain = await cleanFx.call("project_checkout_branch", { branch: cleanFx.main });
    check("(M1 negative control) setup: switch back to main", backToMain.ok === true);
    // Roll the branch's own trust record BACK to the FIRST landing's tip.
    db.setMainlineBranchTrust(cleanFx.projId, "primary", "m1-clean-landing", s1);
    check("(M1 negative control) setup: trust rolled back one landing behind the live branch tip", cleanFx.trust("m1-clean-landing") === s1 && s1 !== s2);
    const r1 = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing" });
    check("(M1) round 9: a real, multi-commit, Loom-trailered chain is now ALSO refused once trust lags behind the live tip (the accepted cost of exact-match-only — see the decision record)", r1.ok === false && r1.refused === true);
    check("(M1) the lagged-trust refusal's filed event names untrusted-tip-mismatch too", m1Evidence(cleanFx, "m1-clean-landing").some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
    // -- the POSITIVE control: once trust is rolled forward to the actual live tip (an exact match), the
    //    SAME call succeeds — proving the refusal above is about tip equality, not a broken branch/fixture.
    //    The refusal above filed a project-wide, UNDELIVERED mainline alert (same mechanism (LNDR-2)
    //    documents) — clear it first, the same way the owner's own reset route would, or EVERY later call
    //    in this fixture (including the ordinary-commit check below) would be blocked by it regardless of
    //    target, for an unrelated reason. --
    db.deleteMeta(cleanFx.alertKey);
    db.setMainlineBranchTrust(cleanFx.projId, "primary", "m1-clean-landing", s2);
    const r1b = await cleanFx.call("project_checkout_branch", { branch: "m1-clean-landing" });
    check("(M1) positive control: once trust exactly matches the live tip, the SAME call succeeds", r1b.ok === true && r1b.sha === s2);

    // -- an ORDINARY, non-trailered commit (intact reflog, true ancestor, a real porcelain commit) is
    //    refused too — unchanged from round 8, now for the SAME reason as every other mismatch. --
    git(cleanFx.repo, "branch", "m1-ordinary", cleanFx.main);
    cleanFx.trustBranch("m1-ordinary");
    git(cleanFx.repo, "checkout", "-q", "m1-ordinary");
    fs.writeFileSync(path.join(cleanFx.repo, "m1ordinary.txt"), "ok\n");
    commitAll(cleanFx.repo, "chore(x): an ordinary, non-trailered commit", GIT_ID);
    git(cleanFx.repo, "checkout", "-q", cleanFx.main);
    const r2 = await cleanFx.call("project_checkout_branch", { branch: "m1-ordinary" });
    check("(M1) an ordinary non-trailered commit is refused — stricter than the shared tripwire, by design", r2.ok === false && r2.refused === true);
    check("(M1) the ordinary-commit refusal's filed event names untrusted-tip-mismatch too", m1Evidence(cleanFx, "m1-ordinary").some((e) => e.detail.evidence.includes("untrusted-tip-mismatch")));
  }

  // ===================== (FORGED) round 9 — a FORGED Loom-Worker-Branch trailer is no longer special-cased =====================
  // The fifth Code Review's repro: a real commit whose message plants the EXACT trailer text a genuine
  // Loom landing writes, with no actual landing ever having happened. Under round 8's own "forward + every
  // commit trailered" rule this was silently ADOPTED (ok:true, W + trust laundered onto the forged sha, no
  // event filed) — `parseLoomTrailerBlock` is pure, unauthenticated text matching. Round 9 deletes all
  // trailer-reading from this gate, so a forged trailer buys the attacker nothing: it is refused exactly
  // like repro 1-6 above, for the identical reason.
  {
    // -- P1: git branch -f onto the forged-trailer commit --
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-force");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "branch", "-f", target, forged);
    check("(FORGED P1) setup: the branch really moved via branch -f onto a commit carrying a FORGED Loom-Worker-Branch trailer", git(fx.repo, "rev-parse", target) === forged);
    const wBeforeP1 = fx.watermark();
    const r1 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED P1) is refused — a forged trailer is NOT adopted (round 8 would have returned ok:true here)", r1.ok === false && r1.refused === true);
    check("(FORGED P1) W was NOT laundered onto the forged tip", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP1));
    check("(FORGED P1) the branch's OWN trust record was NOT advanced onto the forged tip", fx.trust(target) === trustedSha);
    check("(FORGED P1) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === forged));
  }
  {
    // -- P2: the SAME forged-trailer commit, reached via a forged `update-ref -m "commit: …"` direct ref
    //    write instead of branch -f --
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-updateref");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "update-ref", "-m", "commit: x", `refs/heads/${target}`, forged);
    check("(FORGED P2) setup: the branch really moved via a forged update-ref onto a commit carrying a FORGED trailer", git(fx.repo, "rev-parse", target) === forged);
    const wBeforeP2 = fx.watermark();
    const r2 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED P2) is refused — a forged trailer via a forged update-ref message is NOT adopted either", r2.ok === false && r2.refused === true);
    check("(FORGED P2) W was NOT laundered onto the forged tip", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP2));
    check("(FORGED P2) a HIGH mainline_moved_outside_loom event was filed, naming untrusted-tip-mismatch", m1Evidence(fx, target).some((e) => e.detail.evidence.includes("untrusted-tip-mismatch") && e.detail.to === forged));
  }

  // ===================== (FORGED-FIXUP) round 9 — the SAME forged tip, reached via the "already checked out, W disagrees" fixup path =====================
  // Round 8's MAJOR #2 fixup path (checkoutProjectBranch, "already checked out" + W disagreeing) re-runs
  // the FULL precondition in-lock before repointing — including the target-branch trust check this file
  // exercises above via an ordinary switch. This proves the SAME forged-trailer bypass is closed on THAT
  // entry point too, not just the ordinary-switch one.
  {
    const { fx, target, trustedSha } = await m1Fixture("forged-trailer-fixup");
    const forged = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", trustedSha, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
    git(fx.repo, "branch", "-f", target, forged);
    // Reach the forged branch OUT OF BAND (a raw checkout, never through this tool) so the canonical repo
    // is already sitting on it while W still points at main — exactly the "already checked out, W
    // disagrees" shape the fixup path exists for.
    git(fx.repo, "checkout", "-q", target);
    check("(FORGED-FIXUP P3) setup: canonical is already on the forged branch out-of-band, W still points elsewhere", fx.canonBranch() === target && fx.watermark()?.branch !== target);
    const wBeforeP3 = fx.watermark();
    const r3 = await fx.call("project_checkout_branch", { branch: target });
    check("(FORGED-FIXUP P3) the fixup path ALSO refuses — a forged trailer buys nothing via either entry point", r3.ok === false && r3.refused === true);
    check("(FORGED-FIXUP P3) W was NOT re-pointed onto the forged tip by the fixup path", JSON.stringify(fx.watermark()) === JSON.stringify(wBeforeP3));
    check("(FORGED-FIXUP P3) the branch's own trust record was NOT advanced onto the forged tip", fx.trust(target) === trustedSha);

    // -- P4 (control): an ORDINARY, untrailered commit on the SAME fixup path is ALSO refused — the fixup
    //    path's own precondition re-run genuinely runs the full check, not a weaker one. --
    const { fx: fx4, target: target4, trustedSha: trustedSha4 } = await m1Fixture("ordinary-fixup");
    git(fx4.repo, "checkout", "-q", target4);
    fs.writeFileSync(path.join(fx4.repo, "fixup-ordinary.ts"), "export const x = 1;\n");
    commitAll(fx4.repo, "chore(x): an ordinary commit on the fixup target", GIT_ID);
    const ordinaryTip = fx4.canonHead();
    check("(FORGED-FIXUP P4) setup: canonical is on an untrailered-commit branch out-of-band, W still points elsewhere", fx4.canonBranch() === target4 && ordinaryTip !== trustedSha4);
    const r4 = await fx4.call("project_checkout_branch", { branch: target4 });
    check("(FORGED-FIXUP P4) control: an ordinary, untrailered commit on the fixup path is ALSO refused", r4.ok === false && r4.refused === true);
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "round 9's exact-trust-match-only rule: every untrailered or forged-trailer bypass onto a non-matching tip is refused identically (incl. the SAME forged tip reached via the already-checked-out fixup path, which shares this file's own m1Fixture/m1Evidence helpers)" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
