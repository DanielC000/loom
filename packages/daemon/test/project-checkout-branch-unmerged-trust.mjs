import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers the unmerged-worker refusal (incl. tag/remote-HEAD ambiguity), the no-trust-record refusal, the human-only reset route, and target-branch laundering plus its dedupe:
//   - (UNMRG) an unmerged worker branch (live OR exited) blocks the switch
//   - (UNMRG-TAG) card 1bc9602b — a same-named TAG on the worker's own branch used to
//   - (UNMRG-REMOTEHEAD) card 1bc9602b — a SECOND, independent real-git ambiguity
//   - (TRUST) an existing branch with no trust record is refused outright
//   - (RESET) the human-only reset route re-stamps the adopted branch's trust (M2)
//   - (LNDR-1 / LNDR-2) laundering keyed on the TARGET, not the current branch
//   - (DEDUPE) a repeated refuseIfTargetBranchUntrusted call does not re-file/re-nudge (m4)
//   - (DEDUPE-RESET) round 8 (m4 under-alert fix) — a retry AFTER a human reset gets a FRESH event, not a stale pre-reset match
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-unmerged-trust.mjs

import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-umt-");

import {
  loadPcbDistModules, makeFixtureKit, git,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (UNMRG) an unmerged worker branch (live OR exited) blocks the switch =====================
  {
    const fx = makeFixture("unmrg");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w"); // inserted as processState:"exited" by addWorker — never landed
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG) an exited, unmerged worker branch refuses the switch, hard", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG) canonical untouched", fx.canonBranch() === fx.main);
    check("(UNMRG) the remedy text is TRUE (no 'recycle-and-discard' mechanism is claimed)", /worker_merge_confirm/.test(r1.error) && !/recycle-and-discard/.test(r1.error));
    // negative control: land it, then the same call succeeds.
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (UNMRG-TAG) card 1bc9602b — a same-named TAG on the worker's own branch used to
  // make `listUnmergedWorkerBranches`'s `%(refname:short)` read shorten it to "heads/loom/<id>", never
  // matching the candidate's plain "loom/<id>" — the unmerged-worker refusal silently failed OPEN =====================
  {
    const fx = makeFixture("unmrg-tag");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w"); // inserted as processState:"exited" — never landed, worktree still on disk
    git(fx.repo, "tag", w.branch); // same-named TAG — the real git ambiguity source
    check("(UNMRG-TAG) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${w.branch}`) !== w.branch);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-TAG) an unmerged worker branch shadowed by a same-named tag STILL refuses the switch", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG-TAG) canonical untouched", fx.canonBranch() === fx.main);
    // negative control: land it, then the same call succeeds (same shape as (UNMRG)'s own control, proving
    // the tag-ambiguity fixture itself isn't what's blocking the switch). The tag is deleted FIRST — a
    // same-named tag also defeats `detectStrandedWork`'s own bare-revision `rev-list <mainSha>..<branch>`
    // read (git's rev-parse precedence puts refs/tags/ ahead of refs/heads/ for a bare name, so it silently
    // diffs against the TAG's target instead of the real branch and false-flags "stranded work", refusing
    // the merge) — a SEPARATE, pre-existing ambiguity bug in a different function, out of scope for this
    // card (card 1bc9602b); deleting the tag here keeps this negative control isolated to the ONE concern
    // this scenario exists to prove (listUnmergedWorkerBranches), not entangled with that other one.
    git(fx.repo, "tag", "-d", w.branch);
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG-TAG) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-TAG) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (UNMRG-REMOTEHEAD) card 1bc9602b — a SECOND, independent real-git ambiguity
  // source for `%(refname:short)`: a `refs/remotes/<branch>/HEAD` ref sharing the worker branch's own full
  // name (no configured remote needed — the bare ref is enough) =====================
  {
    const fx = makeFixture("unmrg-remotehead");
    git(fx.repo, "branch", "atlas");
    fx.trustBranch("atlas");
    const w = await fx.addWorker("w");
    git(fx.repo, "update-ref", `refs/remotes/${w.branch}/HEAD`, fx.canonHead());
    check("(UNMRG-REMOTEHEAD) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", `refs/heads/${w.branch}`) !== w.branch);
    const r1 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-REMOTEHEAD) an unmerged worker branch shadowed by a refs/remotes/.../HEAD ref STILL refuses the switch", r1.ok === false && r1.refused === true && Array.isArray(r1.unmergedWorkers) && r1.unmergedWorkers.some((u) => u.workerSessionId === w.workerId && u.branch === w.branch));
    check("(UNMRG-REMOTEHEAD) canonical untouched", fx.canonBranch() === fx.main);
    const confirmed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(UNMRG-REMOTEHEAD) setup: the branch actually landed", confirmed.settled === true && confirmed.ok === true && confirmed.value.merged === true);
    const r2 = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(UNMRG-REMOTEHEAD) negative control: once merged, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (TRUST) an existing branch with no trust record is refused outright =====================
  {
    const fx = makeFixture("trust");
    git(fx.repo, "branch", "stray"); // exists in git, but Loom has never trusted it
    const r1 = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(TRUST) an existing branch with no trust record is refused", r1.ok === false && r1.refused === true && /no trusted baseline/.test(r1.error));
    check("(TRUST) the remedy names BOTH create:true and the owner-adopt route", /create:true/.test(r1.error) && /mainline-watermark\/reset/.test(r1.error));
    check("(TRUST) canonical untouched", fx.canonBranch() === fx.main);
    check("(TRUST) W stays absent (never adopted)", fx.watermark() === null);
    // negative control: the owner-adopt remedy (stamp a trust record directly) — the same call now succeeds.
    fx.trustBranch("stray");
    const r2 = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(TRUST) negative control: once a trust record exists, the SAME call now succeeds", r2.ok === true);
  }

  // ===================== (RESET) the human-only reset route re-stamps the adopted branch's trust (M2) =====================
  {
    const fx = makeFixture("reset");
    git(fx.repo, "branch", "stray"); // exists in git, never trusted — the TRUST refusal's dead end
    git(fx.repo, "checkout", "-q", "stray");
    const strayTip = fx.canonHead();
    // Mirrors the human-only REST reset route's own effect (gateway/server.ts reads the canonical
    // checkout's live head and passes it as `adopt` — this exercises Db.resetMainlineWatermark directly,
    // the git-agnostic half of that fix).
    const resetResult = db.resetMainlineWatermark(fx.projId, "primary", { branch: "stray", sha: strayTip });
    check("(RESET) resetMainlineWatermark reports a reset", resetResult.reset === true);
    check("(RESET) the adopted branch's trust record is stamped immediately (M2)", fx.trust("stray") === strayTip);
    check("(RESET) W itself is still only ever DELETED by a reset, never stamped", fx.watermark() === null);
    git(fx.repo, "checkout", "-q", fx.main);
    // THE DEAD END, closed: switching to the human-adopted branch now succeeds immediately — no real
    // landing needed first, which was the gap before this fix (a reset cleared W but left "stray" itself
    // refusing with "no trusted baseline" on the very next call).
    const r = await fx.call("project_checkout_branch", { branch: "stray" });
    check("(RESET) switching to the human-adopted branch succeeds immediately", r.ok === true && r.branch === "stray" && r.sha === strayTip);
    check("(RESET) W is now re-pointed to the adopted branch", fx.watermark()?.branch === "stray" && fx.watermark()?.sha === strayTip);
  }

  // ===================== (LNDR-1 / LNDR-2) laundering keyed on the TARGET, not the current branch =====================
  {
    const fx = makeFixture("lndr");
    git(fx.repo, "branch", "clean-target");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(LNDR) setup: a real landing established W + a trust record on main", seeded.settled === true && seeded.ok === true && seeded.value.merged === true && fx.watermark()?.branch === fx.main && fx.trust(fx.main) === fx.watermark()?.sha);
    fx.trustBranch("clean-target");
    const wBefore = fx.watermark();
    // A RAW ref-write bypass (mirrors mainline-watch-branch-divert.mjs's own D10/D11 technique). Round 9:
    // this gate no longer distinguishes a raw ref write from an ordinary porcelain commit at all — ANY tip
    // other than an exact trust-record match is refused, so the choice of bypass mechanism here is
    // arbitrary (kept as a raw write only because it's the cheapest way to produce "a tip the trust record
    // doesn't match").
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    check("(LNDR) setup control: main's own trusted branch really moved outside Loom", rawTip === rawTreeCommit && rawTip !== wBefore.sha);

    // (LNDR-1) same-branch call: refused + a HIGH event filed; W left untouched.
    const r1 = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(LNDR-1) a same-branch call after a raw commit is refused", r1.ok === false && r1.refused === true);
    check("(LNDR-1) W is left UNCHANGED (never laundered)", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    const evAfter1 = fx.mwEvents();
    check("(LNDR-1) a HIGH mainline_moved_outside_loom event was filed", evAfter1.some((e) => e.detail.severity === "high" && e.detail.from === wBefore.sha && e.detail.to === rawTip));
    check("(LNDR-1) canonical is untouched (still on main)", fx.canonBranch() === fx.main);

    // (LNDR-2) away-ONLY: targeting a DIFFERENT, perfectly clean, ALREADY-TRUSTED branch is ALSO refused
    // here — NOT because clean-target's own trust is bad (it isn't), but because LNDR-1 already filed a
    // project-wide, UNDELIVERED mainline alert, and hasUnresolvedMainlineAlert blocks EVERY call for this
    // (project, repoKey) regardless of target until the owner resolves it. This is the SAME outcome round
    // 5's own LNDR-2 asserted, now for the correct reason — see (B1) below for a scenario with no
    // pre-existing alert, which is what actually proves target-only classification.
    const r2 = await fx.call("project_checkout_branch", { branch: "clean-target" });
    check("(LNDR-2) switching to an unrelated branch is ALSO refused while LNDR-1's alert is unresolved", r2.ok === false && r2.refused === true && /unresolved mainline alert/.test(r2.error));
    check("(LNDR-2) W is still unchanged", JSON.stringify(fx.watermark()) === JSON.stringify(wBefore));
    check("(LNDR-2) canonical never moved off main", fx.canonBranch() === fx.main);
  }

  // ===================== (DEDUPE) a repeated refuseIfTargetBranchUntrusted call does not re-file/re-nudge (m4) =====================
  {
    const fx = makeFixture("dedupe");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(DEDUPE) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    // Calling the PRIVATE classifier directly, twice in a row, bypasses `hasUnresolvedMainlineAlert`
    // (which would otherwise short-circuit a second real tool call before it ever reached this method
    // again) — this is the ONLY way to exercise the dedupe check itself rather than its usual backstop.
    const a = { projectId: fx.projId, repoKey: "primary", repoPath: fx.repo, branch: fx.main, managerSessionId: fx.mgrId, taskId: null };
    const call1 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    const call2 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE) both direct calls refuse", call1.ok === false && call2.ok === false);
    const evs = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main && e.detail.from === wBefore.sha && e.detail.to === rawTip);
    check("(DEDUPE) only ONE HIGH event was filed across both identical refusals (m4)", evs.length === 1 && evs[0].detail.severity === "high");
  }

  // ===================== (DEDUPE-RESET) round 8 (m4 under-alert fix) — a retry AFTER a human reset gets a FRESH event, not a stale pre-reset match =====================
  {
    const fx = makeFixture("dedupe-reset");
    const w = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, w.workerId);
    check("(DEDUPE-RESET) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const wBefore = fx.watermark();
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", wBefore.sha, "-m", "");
    git(fx.repo, "update-ref", `refs/heads/${fx.main}`, rawTreeCommit);
    const rawTip = fx.canonHead();
    const a = { projectId: fx.projId, repoKey: "primary", repoPath: fx.repo, branch: fx.main, managerSessionId: fx.mgrId, taskId: null };
    const call1 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE-RESET) setup: the first call refuses", call1.ok === false);
    const evsBefore = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main);
    check("(DEDUPE-RESET) setup: exactly one event was filed before the reset", evsBefore.length === 1);
    // The owner resets — clears W + the alert marker, but a PLAIN reset (no `adopt`) never touches main's
    // own per-branch trust record, so the SAME tampered tip is still what the next call classifies
    // against — this is deliberately the SAME (branch, from, to) triple as before the reset.
    const resetResult = db.resetMainlineWatermark(fx.projId, "primary");
    check("(DEDUPE-RESET) setup: the human reset reports reset:true", resetResult.reset === true);
    check("(DEDUPE-RESET) setup: the reset does NOT touch main's own trust record", fx.trust(fx.main) === wBefore.sha);
    const call2 = await fx.sessions.refuseIfTargetBranchUntrusted(a);
    check("(DEDUPE-RESET) the retry (same branch, same from/to) still refuses — nothing about the tamper itself changed", call2.ok === false);
    const evsAfter = fx.mwEvents().filter((e) => e.detail.source === "manager-checkout-precheck" && e.detail.branch === fx.main && e.detail.from === wBefore.sha && e.detail.to === rawTip);
    check("(DEDUPE-RESET) a FRESH event was filed after the reset — the dedupe correctly does NOT match the pre-reset episode (round 8 m4 fix)", evsAfter.length === 2);
    check("(DEDUPE-RESET) the retry's own error text says the event was JUST filed, not that one already exists", /was just filed/.test(call2.error));
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "the unmerged-worker refusal (incl. tag/remote-HEAD ambiguity), the no-trust-record refusal, the human-only reset route, and target-branch laundering plus its dedupe" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
