import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers create:true (brand-new branch at the watermark's sha), its drift and in-lock re-read cases, and the away-and-back laundering case:
//   - (CREATE) create:true — brand-new branch at W's sha, refusals, trust stamped
//   - (CREATE-DRIFT) create:true branches at W's sha even when HEAD has drifted past it (M3-ii)
//   - (N2) createProjectBranch re-reads W INSIDE the lock, not the stale outer read (n2)
//   - (B1) the genuine away-and-back laundering case (Code Review round 3)
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-create.mjs
import fs from "node:fs";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-create-");

import {
  loadPcbDistModules, makeFixtureKit, git, commitAll, GIT_ID,
} from "./_project-checkout-branch-fixture.mjs";

const mods = await loadPcbDistModules();
const { Db, withCanonicalIndexLock, MW } = mods;

const db = new Db();
const { makeFixture } = makeFixtureKit(db, mods);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // ===================== (CREATE) create:true — brand-new branch at W's sha, refusals, trust stamped =====================
  {
    const fx = makeFixture("create");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(CREATE) setup: a real landing establishes W on main", seeded.settled === true && seeded.ok === true && fx.watermark()?.branch === fx.main);
    const wSha = fx.watermark().sha;

    const r1 = await fx.call("project_checkout_branch", { branch: "feature-x", create: true });
    check("(CREATE) succeeds with created:true", r1.ok === true && r1.created === true && r1.noop === false && r1.branch === "feature-x" && r1.sha === wSha);
    check("(CREATE) canonical is now actually on the new branch, at W's sha (never a different start point)", fx.canonBranch() === "feature-x" && fx.canonHead() === wSha);
    check("(CREATE) W is re-pointed to {feature-x, wSha} immediately", fx.watermark()?.branch === "feature-x" && fx.watermark()?.sha === wSha);
    check("(CREATE) the new branch's own trust record is stamped to the same sha", fx.trust("feature-x") === wSha);
    check("(CREATE) reports the previous branch (main)", r1.previousBranch === fx.main);

    // refuses an existing name
    const r2 = await fx.call("project_checkout_branch", { branch: "feature-x", create: true });
    check("(CREATE) refuses create:true on a name that already exists", r2.ok === false && /already exists/.test(r2.error));

    // refuses an invalid git branch name — round 10: a name containing spaces is now caught by
    // unsafeBranchNameReason's own conservative charset BEFORE check-ref-format ever runs, so the
    // refusal text changed (this is the "outside the conservative branch-name charset" reason, not
    // check-ref-format's "not a valid git branch name" text) — still refused, just one layer earlier.
    const r3 = await fx.call("project_checkout_branch", { branch: "not a valid branch name", create: true });
    check("(CREATE) refuses an invalid git branch name", r3.ok === false && /charset|not a valid git branch name/.test(r3.error));

    // refuses Loom's own reserved worker-branch prefix
    const r4 = await fx.call("project_checkout_branch", { branch: "loom/evil", create: true });
    check("(CREATE) refuses a name starting with Loom's reserved \"loom/\" prefix", r4.ok === false && /reserved worker-branch prefix/.test(r4.error));
    check("(CREATE) canonical untouched by any of the three refusals above", fx.canonBranch() === "feature-x");

    // a real landing on the created branch afterward advances its OWN trust record
    const postCreateWorker = await fx.addWorker("post");
    const postCreateBase = git(postCreateWorker.worktreePath, "rev-parse", "HEAD~1");
    check("(CREATE) the post-create worker's worktree forked from feature-x's own tip (wSha)", postCreateBase === wSha);
    const landed = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, postCreateWorker.workerId);
    check("(CREATE) the landing on the created branch succeeds", landed.settled === true && landed.ok === true && landed.value.merged === true);
    const landedSha = fx.canonHead();
    check("(CREATE) the created branch's trust record advanced past its creation sha", fx.trust("feature-x") === landedSha && landedSha !== wSha);
  }

  // ===================== (CREATE-DRIFT) create:true branches at W's sha even when HEAD has drifted past it (M3-ii) =====================
  {
    const fx = makeFixture("createdrift");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const wSha = fx.watermark().sha;
    // Drift: advance the canonical checkout PAST W with a raw commit — no Loom landing, so W stays at wSha.
    fs.writeFileSync(path.join(fx.repo, "drift.txt"), "drift\n");
    commitAll(fx.repo, "chore(x): drift past W with no Loom landing", GIT_ID);
    const driftedHead = fx.canonHead();
    check("(CREATE-DRIFT) setup: HEAD has drifted past W", driftedHead !== wSha);
    const r = await fx.call("project_checkout_branch", { branch: "feature-drift", create: true });
    check("(CREATE-DRIFT) create:true branches at W's OWN sha, never the drifted HEAD (M3-ii)", r.ok === true && r.sha === wSha && r.sha !== driftedHead);
    check("(CREATE-DRIFT) canonical is actually at W's sha, not the drifted HEAD", fx.canonHead() === wSha);
  }

  // ===================== (N2) createProjectBranch re-reads W INSIDE the lock, not the stale outer read (n2) =====================
  // Round 8 fix (the same shape S2's own M3-i fix closed): the OLD race insertion ran "right after kicking
  // off the call, no await in between" — every step it needs (a real `git commit-tree`, a synchronous
  // `db.repointMainlineWatermark`) is itself synchronous, so it could complete BEFORE `createProjectBranch`
  // ever reached its own outer W read at all (every step ahead of that read — `nonCreatePrecondition`'s
  // real async git spawns — genuinely yields to the event loop first), meaning a disabled in-lock re-read
  // could still read green for the WRONG reason. A `db.getMeta` call-counting hook (the SAME technique (S2)
  // uses, applied to the one hookable point `createProjectBranch`'s own closures expose) proves the
  // ordering instead of assuming it: the FIRST call to this exact watermark key IS the outer read: the
  // repoint lands strictly between it and the SECOND (in-lock) call, never before either.
  {
    const fx = makeFixture("n2");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const staleW = fx.watermark();

    let releaseLock;
    const lockHeld = withCanonicalIndexLock(fx.repo, () => new Promise((res) => { releaseLock = res; }));
    for (let i = 0; i < 200 && releaseLock === undefined; i++) await new Promise((r) => setImmediate(r));
    check("(N2) setup: the canonical-index lock is held by the parallel op", releaseLock !== undefined);

    const wKeyN2 = MW.mainlineWatermarkKey(fx.projId, "primary");
    let firstReadDone;
    const firstReadDoneP = new Promise((res) => { firstReadDone = res; });
    const originalGetMeta = db.getMeta.bind(db);
    db.getMeta = (key) => {
      const result = originalGetMeta(key);
      if (key === wKeyN2) {
        // One-shot: restore immediately so later reads (this test's own repoint + assertions below, and
        // the real in-lock read) are never mistaken for a second "outer" read — this hook only needs to
        // catch the FIRST one.
        db.getMeta = originalGetMeta;
        firstReadDone();
      }
      return result;
    };

    let callSettled = false;
    const callP = fx.call("project_checkout_branch", { branch: "feature-n2", create: true }).then((r) => { callSettled = true; return r; });
    await firstReadDoneP; // PROVABLY after createProjectBranch's own outer W read has already happened.
    check("(N2) ordering actually proven, not assumed: the call is still genuinely mid-flight (blocked on the held lock) when the outer read fires", callSettled === false);
    // Simulate a CONCURRENT repoint (e.g. another switch/create) landing strictly between the outer read
    // (just proven above) and the in-lock re-read — a brand-new, unreferenced-but-real commit object
    // (object creation needs no lock; only a ref/working-tree mutation does), repointed onto W via a
    // direct, lock-free Db write.
    const newTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", staleW.sha, "-m", "N2 concurrent repoint simulation");
    db.repointMainlineWatermark(fx.projId, "primary", fx.main, newTreeCommit, fx.mgrId);
    check("(N2) setup: W was concurrently repointed to a NEW sha strictly between the two reads", fx.watermark()?.sha === newTreeCommit && newTreeCommit !== staleW.sha);
    releaseLock();
    await lockHeld;
    const result = await callP;
    check("(N2) create:true used the FRESH sha read inside the lock, not the stale outer read (RED if the re-read is removed)", result.ok === true && result.sha === newTreeCommit);
    check("(N2) canonical is actually at the fresh sha", fx.canonHead() === newTreeCommit);
    check("(N2) the created branch's own trust record is stamped to the fresh sha, not the stale one", fx.trust("feature-n2") === newTreeCommit);
  }

  // ===================== (B1) the genuine away-and-back laundering case (Code Review round 3) =====================
  {
    const fx = makeFixture("b1");
    const seedWorker = await fx.addWorker("seed");
    const seeded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    check("(B1) setup: a real landing establishes W + trust on main", seeded.settled === true && seeded.ok === true);
    const mainSha = fx.watermark().sha;

    // AWAY: create+switch to atlas, then land a worker on it — main is now DEPARTED and unwatched.
    const created = await fx.call("project_checkout_branch", { branch: "atlas", create: true });
    check("(B1) setup: create:true switches away to atlas", created.ok === true && fx.canonBranch() === "atlas");
    const atlasWorker = await fx.addWorker("atlas");
    const atlasLanded = await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, atlasWorker.workerId);
    check("(B1) setup: a landing on atlas succeeds", atlasLanded.settled === true && atlasLanded.ok === true && atlasLanded.value.merged === true);

    // Switch back to the ORIGINAL (untouched) branch first — this must succeed cleanly, proving the
    // refusal below is specifically about the TAMPERED branch, not switching back as such.
    const backToMain = await fx.call("project_checkout_branch", { branch: fx.main });
    check("(B1) switching back to the untouched original branch succeeds cleanly", backToMain.ok === true && backToMain.branch === fx.main && backToMain.sha === mainSha);
    check("(B1) W is now on main again", fx.watermark()?.branch === fx.main);

    // Now atlas is the DEPARTED branch (main is checked out). Raw-tamper it while nothing watches it.
    const atlasTrustedSha = fx.trust("atlas");
    const rawTreeCommit = git(fx.repo, "commit-tree", git(fx.repo, "write-tree"), "-p", atlasTrustedSha, "-m", "");
    git(fx.repo, "update-ref", "refs/heads/atlas", rawTreeCommit);
    check("(B1) setup control: atlas really moved outside Loom while departed", git(fx.repo, "rev-parse", "atlas") === rawTreeCommit && rawTreeCommit !== atlasTrustedSha);

    // THE POINT: switching back to atlas is refused — the exact B1 repro.
    const back = await fx.call("project_checkout_branch", { branch: "atlas" });
    check("(B1) switching back to the tampered, departed branch is refused", back.ok === false && back.refused === true);
    check("(B1) a HIGH mainline_moved_outside_loom event was filed for atlas", fx.mwEvents().some((e) => e.detail.branch === "atlas" && e.detail.severity === "high" && e.detail.from === atlasTrustedSha && e.detail.to === rawTreeCommit));
    check("(B1) W is left UNCHANGED (still main, not laundered onto the tampered atlas)", fx.watermark()?.branch === fx.main);
    check("(B1) canonical never moved off main", fx.canonBranch() === fx.main);
  }


} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "create:true (brand-new branch at the watermark's sha), its drift and in-lock re-read cases, and the away-and-back laundering case" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
