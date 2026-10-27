import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure git
// CARD b4cc7114 — a worker-plantable, redirected SIBLING worktree's own private `.git/worktrees/<name>/
// commondir` pointer must never make a GC/merge-admission safety check read real work as absent.
// Investigated empirically on scratch repos (not here — see docs/decisions/b4cc7114-*.md for the measured
// hijack, the GC call-path trace, and why the fix is correct): `worktreeHasWork` (boot-reconcile Pass B's
// own GC gate) and `detectStrandedWork` (the merge-admission "stranded on a self-created branch" backstop)
// both used to construct their worktree-scoped `wt` git handle via the 3a5c5d4a advisory-read opt-out,
// skipping commondir verification entirely for a read that steers a real destructive/consequential
// decision. This file proves the FIX: both now thread the real trusted main (`defaultTrustedMainRoot`)
// instead, so a redirected private commondir is detected and fails safe toward RETAINING/REFUSING rather
// than toward silently reporting "no work".
//
// Scenarios: (1) worktreeHasWork, a CRAFTED decoy (pre-baked blob matching the victim's current dirty
// content — the "attacker can read the victim worktree's files directly" capability the project's own
// not-a-sandbox threat model already accepts) → now still reports work (fixed; was false before). (2)
// detectStrandedWork, a BLIND decoy (just a same-named branch pointing at/behind mainSha, no content
// matching needed) → now reports stranded:true, verificationRefused:true (fixed; was stranded:false
// before). (3) readWorktreeUncommittedState, the SAME crafted-decoy redirect → now reports a non-"clean"
// state (dirty, or unknown on a refusal) — either of which the ONE real caller (`gcWorktreeDir`'s
// `retainIfUncommitted` branch, used only by `finalizeMerge`) already RETAINS on, per decision 6796c9ea's
// own "Do not remove on unknown" rule (not re-verified here — this file asserts the function's own return
// value, not the full finalizeMerge integration). (4) detectStrandedWork, round 2 (Code Review, m1): a
// refusal from the REPO-level `git` handle (not the `wt` probe) is worded via `refusalText`, never
// `verificationRefused`'s worktree-commondir sentence. A no-redirect control accompanies each scenario.
//
// Card fa56549d adds: (5, inside scenario 1's own block) worktreeHasWorkDetailed names the same redirect
// as verificationRefused:true, while worktreeHasWork itself stays byte-identical. (6) precheckWorkerDone
// against a redirected worktree still ALLOWs (per decision 907b9f50) but no longer degrades SILENTLY — a
// captured console.warn names the worktree and the refusal. (7) mergeMainIntoWorktree's merge-base early-
// return against a redirected worktree whose BELIEVABLE decoy would make an UNVERIFIED read wrongly
// conclude "already caught up" — proves the pre-fix silent wrongly-skipped-union-forward is closed (now a
// clean refusal, never a false ok:true). (8) mergeMainIntoWorktree, a REAL non-redirected worktree with a
// genuine pending union — succeeds unchanged under the newly-threaded verification (regression control).
//
// Run: 1) pnpm build, 2) node packages/daemon/test/worktree-commondir-redirect-gc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("b4cc-gc-home-");

const { worktreeHasWork, worktreeHasWorkDetailed, detectStrandedWork, readWorktreeUncommittedState, precheckWorkerDone, mergeMainIntoWorktree } = await import("../dist/git/worktrees.js");
const { CanonicalGitRefusal, boundedSimpleGit } = await import("../dist/git/bounded.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-b4cc-gc-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=b4cc@loom -c user.name=b4cc";

function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q -b main");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}-content\n`);
  git(dir, "add f.txt");
  git(dir, `${GIT_ID} commit -q -m "${name}: initial commit"`);
  return dir;
}

function redirectPrivateCommondir(mainRepo, worktreeName, decoyGitDir) {
  const privateCommondir = path.join(mainRepo, ".git", "worktrees", worktreeName, "commondir");
  try { fs.unlinkSync(privateCommondir); } catch { /* not hidden on every host; ignore */ }
  fs.writeFileSync(privateCommondir, decoyGitDir + "\n");
}

const A = initRepo("A");

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) worktreeHasWork — CRAFTED decoy (pre-baked blob matching the current dirty content).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  git(A, "branch loom/case1");
  const WT = path.join(SCRATCH, "wt1");
  git(A, `worktree add "${WT}" loom/case1`);
  fs.writeFileSync(path.join(WT, "dirty.txt"), "uncommitted worker content\n");
  git(WT, "add dirty.txt");

  check("(1a control) no redirect: worktreeHasWork TRUE for staged-but-uncommitted dirt", await worktreeHasWork(A, WT, "loom/case1") === true);

  // A BELIEVABLE decoy — cloned from A (shares every blob A has, so an UNTOUCHED file like f.txt still
  // matches and can't accidentally leak a spurious "dirty" signal) — plus a pre-baked commit on the SAME
  // branch name matching the victim's CURRENT dirty content (the attacker read the victim's worktree
  // files off disk directly; the project's own threat model already accepts this capability).
  const decoy = path.join(SCRATCH, "B1-decoy");
  git(SCRATCH, `clone -q "${A}" "${decoy}"`);
  git(decoy, "checkout -q -b loom/case1");
  fs.writeFileSync(path.join(decoy, "dirty.txt"), "uncommitted worker content\n"); // matching content
  git(decoy, "add dirty.txt");
  git(decoy, `${GIT_ID} commit -q -m "decoy: pre-baked matching blob"`);
  redirectPrivateCommondir(A, "wt1", path.join(decoy, ".git"));

  check("(1b fixed) AFTER redirecting to a crafted decoy: worktreeHasWork still reports work (was defeatable pre-fix)", await worktreeHasWork(A, WT, "loom/case1") === true);

  // Card fa56549d (5): worktreeHasWorkDetailed names the SAME redirected read as a verification refusal,
  // distinct from a genuinely dirty tree — worktreeHasWork (above) stays byte-identical either way.
  const detailed = await worktreeHasWorkDetailed(A, WT, "loom/case1");
  check("(5 fixed) worktreeHasWorkDetailed.hasWork mirrors worktreeHasWork under the same redirect", detailed.hasWork === true);
  check("(5 fixed) ...and names it verificationRefused:true (not a fabricated 'genuinely dirty' read)", detailed.verificationRefused === true);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (2) detectStrandedWork — BLIND decoy (same-named branch, no content matching needed).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  git(A, "branch loom/case2"); // the assigned branch — stays empty, exactly like incident worker 712fd5aa
  const WT = path.join(SCRATCH, "wt2");
  git(A, `worktree add "${WT}" loom/case2`);
  git(WT, "checkout -q -b evil-self-created-2");
  fs.writeFileSync(path.join(WT, "stranded.txt"), "real work committed to the WRONG branch\n");
  git(WT, "add stranded.txt");
  git(WT, `${GIT_ID} commit -q -m "stranded commit"`);

  const before = await detectStrandedWork(A, WT, "loom/case2");
  check("(2a control) no redirect: detectStrandedWork reports stranded:true for the real incident shape", before.stranded === true && before.verificationRefused === undefined);

  // A BLIND decoy — cloned from A (so A's own mainSha object genuinely exists in it, letting the
  // ahead-count read resolve CLEANLY to 0 instead of erroring on an unknown revision) with a same-named
  // branch pointing at mainSha itself. No content-matching or victim-file knowledge needed at all — the
  // cheaper, more realistic attack shape.
  const decoy = path.join(SCRATCH, "B2-decoy");
  git(SCRATCH, `clone -q "${A}" "${decoy}"`);
  git(decoy, "branch evil-self-created-2 main"); // decoy's branch sits AT mainSha — zero ahead
  redirectPrivateCommondir(A, "wt2", path.join(decoy, ".git"));

  const after = await detectStrandedWork(A, WT, "loom/case2");
  check("(2b fixed) AFTER a blind redirect: detectStrandedWork now fails safe to stranded:true (was stranded:false pre-fix)", after.stranded === true);
  check("(2b fixed) …and names it as a verification refusal, not a fabricated branch/commit", after.verificationRefused === true && after.branch === undefined && after.commit === undefined);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (3) readWorktreeUncommittedState — the SAME crafted-decoy redirect as (1).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  git(A, "branch loom/case3");
  const WT = path.join(SCRATCH, "wt3");
  git(A, `worktree add "${WT}" loom/case3`);
  fs.writeFileSync(path.join(WT, "dirty3.txt"), "uncommitted worker content 3\n");
  git(WT, "add dirty3.txt");

  const before = await readWorktreeUncommittedState(A, WT);
  check("(3a control) no redirect: readWorktreeUncommittedState reports dirty", before.state === "dirty");

  const decoy = path.join(SCRATCH, "B3-decoy");
  git(SCRATCH, `clone -q "${A}" "${decoy}"`);
  git(decoy, "checkout -q -b loom/case3");
  fs.writeFileSync(path.join(decoy, "dirty3.txt"), "uncommitted worker content 3\n"); // matching content
  git(decoy, "add dirty3.txt");
  git(decoy, `${GIT_ID} commit -q -m "decoy: pre-baked matching blob"`);
  redirectPrivateCommondir(A, "wt3", path.join(decoy, ".git"));

  const after = await readWorktreeUncommittedState(A, WT);
  // RETAIN means "not clean" — gcWorktreeDir's own retainIfUncommitted branch (decision 6796c9ea) already
  // keeps the worktree on EITHER "dirty" or "unknown"; this test asserts the function itself, not the
  // full finalizeMerge integration (already covered by batch-merge-dirty-worktree-retained.mjs).
  check("(3b fixed) AFTER redirecting to a crafted decoy: readWorktreeUncommittedState no longer reports clean (was 'clean' pre-fix)", after.state !== "clean");
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (4) detectStrandedWork — round 2 (Code Review, m1): a refusal from the REPO-level `git` handle (NOT the
// worktree's own `wt` probe) must be worded via `refusalText`, never `verificationRefused`'s worktree-
// commondir sentence — scoping the fix to the probe that actually failed. Reproduced by planting a
// `commondir` file inside the MAIN repo's own DIRECTORY-shaped `.git` (the shape `checkCommondirTrust`
// refuses unconditionally, regardless of advisory-read/trustedMainRoot — see docs/decisions/3a5c5d4a) —
// so the VERY FIRST read (`git rev-parse HEAD` against repoPath) throws, before the `wt` probe is ever
// constructed.
{
  const D = initRepo("D");
  git(D, "branch loom/case4");
  const WT = path.join(SCRATCH, "wt4");
  git(D, `worktree add "${WT}" loom/case4`);

  const before = await detectStrandedWork(D, WT, "loom/case4");
  check("(4a control) no redirect: detectStrandedWork reports stranded:false (nothing committed anywhere)", before.stranded === false && before.refusalText === undefined && before.verificationRefused === undefined);

  const decoyD = initRepo("D-decoy");
  fs.writeFileSync(path.join(D, ".git", "commondir"), path.join(decoyD, ".git") + "\n");

  const after = await detectStrandedWork(D, WT, "loom/case4");
  check("(4b fixed) a REPO-level refusal still refuses (stranded:true)", after.stranded === true);
  check("(4b fixed) …via refusalText, NEVER verificationRefused (that sentence would misdescribe the WRONG object)", typeof after.refusalText === "string" && after.refusalText.length > 0 && after.verificationRefused === undefined);
  check("(4b fixed) refusalText does NOT borrow the worktree-commondir wording", !/worktree's own commondir/.test(after.refusalText));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (6) Card fa56549d — precheckWorkerDone against the SAME crafted-decoy redirect as (1)/(3): still ALLOWs
// (decision 907b9f50's ruling is unchanged), but a classified refusal is no longer SILENT — a distinct
// console.warn names the worktree and that commondir verification was refused.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const E = initRepo("E");
  git(E, "branch loom/case6");
  const WT = path.join(SCRATCH, "wt6");
  git(E, `worktree add "${WT}" loom/case6`);
  fs.writeFileSync(path.join(WT, "dirty6.txt"), "uncommitted worker content 6\n");
  git(WT, "add dirty6.txt");

  const before = await precheckWorkerDone(E, WT, "loom/case6");
  check("(6a control) no redirect: precheckWorkerDone reports the real uncommitted file", before.uncommitted === true && before.files.includes("dirty6.txt"));

  const decoy = path.join(SCRATCH, "B6-decoy");
  git(SCRATCH, `clone -q "${E}" "${decoy}"`);
  git(decoy, "checkout -q -b loom/case6");
  fs.writeFileSync(path.join(decoy, "dirty6.txt"), "uncommitted worker content 6\n"); // matching content
  git(decoy, "add dirty6.txt");
  git(decoy, `${GIT_ID} commit -q -m "decoy: pre-baked matching blob"`);
  redirectPrivateCommondir(E, "wt6", path.join(decoy, ".git"));

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let after;
  try {
    after = await precheckWorkerDone(E, WT, "loom/case6");
  } finally {
    console.warn = origWarn;
  }
  // Card fa56549d (round 2, SF2): asserted INDEPENDENTLY, not folded into one check — ALLOW is 907b9f50's
  // existing ruling, unchanged; zeroAhead/aheadCount is the RECOVERED signal (round 1 wrongly returned
  // early on the dirty-tree refusal, losing it — check (2) reads the main repo, unaffected by the redirect).
  check("(6b fixed) AFTER redirecting to a crafted decoy: precheckWorkerDone still ALLOWs — uncommitted:false (907b9f50 unchanged)", after.uncommitted === false && after.files.length === 0);
  check("(6b fixed) ...AND falls through to check (2): zeroAhead:true, aheadCount:0 (was lost by round 1's early return)", after.zeroAhead === true && after.aheadCount === 0);
  check("(6b fixed) ...and the refusal is named on the result too (verificationRefused:true)", after.verificationRefused === true);
  check("(6b fixed) ...and the refusal is named distinctly (not silent) — a console.warn names the worktree and the real refusal kind (a redirected commondir)", warnings.some((w) => w.includes(WT) && /redirected commondir/.test(w)));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (7) Card fa56549d — mergeMainIntoWorktree's merge-base early-return, widened scope (item 2): pre-fix,
// this read used the 3a5c5d4a advisory-read opt-out and so NEVER verified the worktree's commondir at all
// — a BELIEVABLE decoy (same construction as scenario 1) can make the UNVERIFIED read wrongly compute
// merge-base(HEAD,mainSha)===mainSha ("already caught up"), silently skipping a union-forward the REAL
// worktree genuinely still needs (the real bug this closes). Post-fix, the read is refused
// (CanonicalGitRefusal) BEFORE it can compute anything, falls through to attempt the REAL merge via the
// already-protected killableCanonicalRaw path — which, since the SAME worktree is still redirected, also
// refuses — so the function reports a clean ok:false, never a false ok:true/merged:false.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const F = initRepo("F");
  git(F, "branch loom/case7");
  const WT = path.join(SCRATCH, "wt7");
  git(F, `worktree add "${WT}" loom/case7`);
  // Main advances past what the worktree's branch has — a genuine pending union.
  fs.writeFileSync(path.join(F, "main-advance.txt"), "a later main commit\n");
  git(F, "add main-advance.txt");
  git(F, `${GIT_ID} commit -q -m "F: a later main commit the worktree has not merged"`);

  // A BELIEVABLE decoy (same construction as scenario 1): a clone of F with a LOCAL branch named EXACTLY
  // "loom/case7" (without this, a bare clone has no local refs/heads/loom/case7 at all, and HEAD's own
  // resolution fails for an unrelated reason that masks whether the merge-base check's own trust is what's
  // actually being exercised) — created AT the decoy's current HEAD, i.e. F's ADVANCED main tip, so an
  // UNVERIFIED read of "HEAD" via the redirected worktree would wrongly compute merge-base(HEAD,mainSha)
  // === mainSha (falsely "already caught up"), exactly the pre-fix exploit shape.
  const decoy = path.join(SCRATCH, "B7-decoy");
  git(SCRATCH, `clone -q "${F}" "${decoy}"`);
  git(decoy, "branch loom/case7"); // at the decoy's own HEAD === F's mainSha
  redirectPrivateCommondir(F, "wt7", path.join(decoy, ".git"));

  const result = await mergeMainIntoWorktree(F, WT, {});
  check("(7 fixed) a redirected worktree whose decoy would wrongly read 'already caught up' now REFUSES, never a false ok:true/merged:false", result.ok === false);
  // Card fa56549d (round 2, NIT3) — assert the CLASSIFIED redirect reason, not merely ok:false (which an
  // unrelated ordinary failure could also produce) — the real merge attempt's own trust check names it.
  check("(7 fixed) ...and the refusal reason is the CLASSIFIED redirect (not a generic/unrelated failure)", !result.ok && typeof result.reason === "string" && /redirect/i.test(result.reason));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (8) Card fa56549d — REGRESSION/SAFETY CONTROL (manager's explicit ask): a REAL, non-redirected worktree
// with a genuine pending union succeeds UNCHANGED under the newly-threaded verification — proves the fix
// does not introduce a false refusal for a legitimate worktree (incl. on Windows path normalization, the
// same already-production-proven checkCommondirTrust mechanism killableCanonicalRaw's own mutating calls
// already use unconditionally today).
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const G = initRepo("G");
  git(G, "branch loom/case8");
  const WT = path.join(SCRATCH, "wt8");
  git(G, `worktree add "${WT}" loom/case8`);
  fs.writeFileSync(path.join(G, "main-advance8.txt"), "a later main commit\n");
  git(G, "add main-advance8.txt");
  git(G, `${GIT_ID} commit -q -m "G: a later main commit the worktree has not merged"`);

  const result = await mergeMainIntoWorktree(G, WT, {});
  check("(8 fixed) a REAL non-redirected worktree's union-forward still succeeds", result.ok === true && result.merged === true);
  if (result.ok) {
    let mainIsAncestor = false;
    try { git(WT, `merge-base --is-ancestor ${result.mainSha} HEAD`); mainIsAncestor = true; } catch { /* exit 1 ⇒ not an ancestor */ }
    check("(8 fixed) ...and main's tip is now an ancestor of the worktree's HEAD", mainIsAncestor);
    check("(8 fixed) ...and the worktree's own advancing file is present", fs.existsSync(path.join(WT, "main-advance8.txt")));
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────
// (9) Card fa56549d (round 2, SF1, Code Review) — the reviewer's own repro: inject a CanonicalGitRefusal on
// the POST-mutation `ls-files --unmerged` read AFTER a REAL, successful union-forward (no redirect — this
// is a different injected fault, not the commondir-redirect family above). Pre-fix, this read's catch said
// a bare "failed to inspect worktree merge state", misdescribing a merge that had ACTUALLY LANDED as a
// failure. Fixed: the message now says the union may already have landed, and a re-confirm (no injection)
// is idempotent — the merge-base early-return sees HEAD already past mainSha and reports ok:true,merged:
// false with the worktree's HEAD byte-unchanged by the retry.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const H = initRepo("H");
  git(H, "branch loom/case9");
  const WT = path.join(SCRATCH, "wt9");
  git(H, `worktree add "${WT}" loom/case9`);
  fs.writeFileSync(path.join(WT, "w.txt"), "w\n");
  git(WT, "add w.txt");
  git(WT, `${GIT_ID} commit -q -m "worker commit"`);
  fs.writeFileSync(path.join(H, "m.txt"), "m\n");
  git(H, "add m.txt");
  git(H, `${GIT_ID} commit -q -m "main2"`);
  const headBefore = git(WT, "rev-parse HEAD");

  let injected = 0;
  const factory = (p, ms) => {
    const real = boundedSimpleGit(p, ms);
    return {
      raw: async (args) => {
        if (args.includes("ls-files") && args.includes("--unmerged")) { injected++; throw new CanonicalGitRefusal("INJECTED post-mutation refusal"); }
        return real.raw(args);
      },
    };
  };
  const r1 = await mergeMainIntoWorktree(H, WT, { gitFactory: factory });
  const headAfter1 = git(WT, "rev-parse HEAD");
  check("(9a) the fault was actually injected", injected > 0);
  check("(9a) the union-forward ACTUALLY LANDED (HEAD moved) despite the post-mutation read refusing", headAfter1 !== headBefore);
  check("(9a) the result is a REFUSAL (ok:false) — the post-mutation read genuinely could not confirm cleanliness", r1.ok === false);
  check("(9a fixed) ...worded as MAY HAVE LANDED, never a bare 'failed' (was defeatable pre-fix)", !r1.ok && typeof r1.reason === "string" && /may have already landed/.test(r1.reason));

  const r2 = await mergeMainIntoWorktree(H, WT, {});
  const headAfter2 = git(WT, "rev-parse HEAD");
  check("(9b) a re-confirm (no injection) is idempotent: ok:true", r2.ok === true);
  check("(9b) ...merged:false (the merge-base early-return sees HEAD already past mainSha)", r2.ok === true && r2.merged === false);
  check("(9b) ...and HEAD is byte-unchanged by the re-confirm (no double-apply)", headAfter2 === headAfter1);
}

await finishAndExit(failures === 0 ? 0 : 1);
