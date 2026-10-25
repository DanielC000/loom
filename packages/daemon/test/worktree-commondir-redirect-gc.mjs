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
// Run: 1) pnpm build, 2) node packages/daemon/test/worktree-commondir-redirect-gc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("b4cc-gc-home-");

const { worktreeHasWork, detectStrandedWork, readWorktreeUncommittedState } = await import("../dist/git/worktrees.js");

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

await finishAndExit(failures === 0 ? 0 : 1);
