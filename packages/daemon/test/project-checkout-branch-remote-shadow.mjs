import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Split of the former project-checkout-branch.mjs (card 0b00aa6a — the original, single ~7-10 min / 299-
// check file could never fit the advisory dist-importer check's per-file run under contention). This file
// covers create:true's remote-name-shadow refusal (incl. multi-segment + origin/main), and the refs/heads %(refname:short) ambiguity bugs (same-named tag, and refs/remotes/.../HEAD) for both switch and create:true:
//   - (REMOTE-PREFIX-CI) create:true refuses a remote-name-shadowing prefix
//   - (CREATE-REMOTE-SHADOW) create:true "origin/main" is refused; switching to an
//   - (R13-TAG-CREATE) create:true "FEAT" over a PACKED, trusted "feat" that ALSO has a
//   - (R13-TAG-SWITCH) switching to the EXACT existing name "feat" still succeeds when a
//   - (R13-REMOTEHEAD) a refs/remotes/<name>/HEAD ref sharing "feat"'s own name is a
// Full round-by-round history (every (TAG) above, which split file it now lives in, and the full incident/
// decision narrative) lives in docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-
// signal.md — not repeated here. Shared fixture/helper kit: _project-checkout-branch-fixture.mjs.
//
// Run: 1) build daemon (pnpm build), 2) node test/project-checkout-branch-remote-shadow.mjs

import { useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-pcb-remote-");

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
  // ===================== (REMOTE-PREFIX-CI) create:true refuses a remote-name-shadowing prefix
  // case-insensitively, and against a multi-segment remote name (seventh CR, MINOR 3) =====================
  {
    const fx = makeFixture("remote-prefix-ci");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    const r1 = await fx.call("project_checkout_branch", { branch: "Origin/main", create: true });
    check("(REMOTE-PREFIX-CI) create:true \"Origin/main\" is refused case-insensitively against remote \"origin\"", r1.ok === false && /configured remote/.test(r1.error));
  }
  {
    const fx = makeFixture("remote-prefix-slash");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    // A remote literally named "a/b" — configured directly (git remote add's own name validation is
    // untested for this shape), same technique this record's round-10 section already documented.
    git(fx.repo, "config", "remote.a/b.url", "https://example.invalid/repo.git");
    git(fx.repo, "config", "remote.a/b.fetch", "+refs/heads/*:refs/remotes/a/b/*");
    const r2 = await fx.call("project_checkout_branch", { branch: "a/b/c", create: true });
    check("(REMOTE-PREFIX-CI) create:true \"a/b/c\" is refused against the multi-segment remote \"a/b\"", r2.ok === false && /configured remote/.test(r2.error));
  }

  // ===================== (CREATE-REMOTE-SHADOW) create:true "origin/main" is refused; switching to an
  // EXISTING "origin/main" branch (once trusted) stays allowed — round 11's own promised test, actually
  // written (seventh CR, MAJOR 1 finding: the record claimed this existed and it did not) =====================
  {
    const fx = makeFixture("create-remote-shadow");
    git(fx.repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    const refused = await fx.call("project_checkout_branch", { branch: "origin/main", create: true });
    check("(CREATE-REMOTE-SHADOW) create:true \"origin/main\" is refused", refused.ok === false && /configured remote/.test(refused.error));
    git(fx.repo, "branch", "origin/main", fx.main);
    fx.trustBranch("origin/main");
    const switched = await fx.call("project_checkout_branch", { branch: "origin/main" });
    check("(CREATE-REMOTE-SHADOW) negative control: switching to an EXISTING \"origin/main\" branch stays allowed", switched.ok === true && fx.canonBranch() === "origin/main");
  }

  // ===================== (R13-TAG-CREATE) create:true "FEAT" over a PACKED, trusted "feat" that ALSO has a
  // same-named TAG ⇒ refused, naming "feat" — ninth CR (CR9) MAJOR: `%(refname:short)` shortens a branch to
  // `heads/<name>` (never the bare name) whenever the short name would be AMBIGUOUS with another ref (a
  // same-named tag here); the for-each-ref listing this gate reads then never matches "feat" against
  // anything, so the case-fold collision check (and the plain exact-name check) went blind to "feat"
  // entirely, letting create:true plant a real refs/heads/FEAT sibling beside it =====================
  {
    const fx = makeFixture("r13-tag-create");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "pack-refs", "--all");
    git(fx.repo, "tag", "feat"); // same-named TAG — the real git ambiguity source (CR9 MAJOR)
    check("(R13-TAG-CREATE) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(R13-TAG-CREATE) create:true \"FEAT\" over a tag-shadowed, packed \"feat\" is refused", r.ok === false);
    check("(R13-TAG-CREATE) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(R13-TAG-CREATE) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
    check("(R13-TAG-CREATE) no local \"FEAT\" ref was ever created", (() => { try { git(fx.repo, "rev-parse", "--verify", "--quiet", "refs/heads/FEAT"); return false; } catch { return true; } })());
  }

  // ===================== (R13-TAG-SWITCH) switching to the EXACT existing name "feat" still succeeds when a
  // same-named tag makes %(refname:short) shorten it to "heads/feat" — CR9's MAJOR false-refuse: the old
  // code compared a.branch ("feat") against that shortened "heads/feat", never found a match, and refused a
  // real, trusted, existing branch as "no local branch exists" =====================
  {
    const fx = makeFixture("r13-tag-switch");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "tag", "feat");
    check("(R13-TAG-SWITCH) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "feat" });
    // NOTE: fx.canonBranch() itself calls `git symbolic-ref --short HEAD`, which is ALSO ambiguity-prone
    // against a same-named tag (verified directly) — asserting on it here would test the wrong thing. The
    // unshortened `git symbolic-ref HEAD` is never ambiguity-shortened, so it's the sound check for this
    // scenario specifically (every OTHER scenario in this file keeps using fx.canonBranch(), which is fine
    // there since nothing else manufactures this exact tag-name collision).
    check("(R13-TAG-SWITCH) switching to the exact existing name \"feat\" succeeds despite the tag-ambiguous shortening (not a false \"no local branch exists\")", r.ok === true && git(fx.repo, "symbolic-ref", "HEAD") === "refs/heads/feat" && !/no local branch/.test(JSON.stringify(r)));
  }

  // ===================== (R13-REMOTEHEAD) a refs/remotes/<name>/HEAD ref sharing "feat"'s own name is a
  // SECOND, independent real-git ambiguity source for %(refname:short) — git's own DWIM rev-parse rules
  // include "refs/remotes/%.*s/HEAD" alongside "refs/tags/%.*s", so a bare ref (even one never registered as
  // a configured remote, just the ref existing) is enough to trigger the same shortening bug =====================
  {
    const fx = makeFixture("r13-remotehead-switch");
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    git(fx.repo, "update-ref", "refs/remotes/feat/HEAD", fx.canonHead());
    check("(R13-REMOTEHEAD-SWITCH) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "feat" });
    check("(R13-REMOTEHEAD-SWITCH) switching to \"feat\" succeeds despite a refs/remotes/feat/HEAD ambiguity", r.ok === true && fx.canonBranch() === "feat");
  }
  {
    const fx = makeFixture("r13-remotehead-create");
    const seedWorker = await fx.addWorker("seed");
    await fx.sessions.confirmWorkerMergeTracked(fx.mgrId, seedWorker.workerId);
    git(fx.repo, "branch", "feat");
    fx.trustBranch("feat");
    const featShaBefore = git(fx.repo, "rev-parse", "feat");
    git(fx.repo, "update-ref", "refs/remotes/feat/HEAD", featShaBefore);
    check("(R13-REMOTEHEAD-CREATE) setup control: git's own ambiguous shortening is really present", git(fx.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/feat") !== "feat");
    const r = await fx.call("project_checkout_branch", { branch: "FEAT", create: true });
    check("(R13-REMOTEHEAD-CREATE) create:true \"FEAT\" over a remote-HEAD-shadowed \"feat\" is refused", r.ok === false);
    check("(R13-REMOTEHEAD-CREATE) the refusal names the real existing branch \"feat\"", /"feat"/.test(r.error));
    check("(R13-REMOTEHEAD-CREATE) feat's own sha is unchanged", git(fx.repo, "rev-parse", "feat") === featShaBefore);
  }

} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_checkout_branch: " + "create:true's remote-name-shadow refusal (incl. multi-segment + origin/main), and the refs/heads %(refname:short) ambiguity bugs (same-named tag, and refs/remotes/.../HEAD) for both switch and create:true" + "."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
