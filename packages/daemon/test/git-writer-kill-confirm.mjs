import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure real-git exercise.
// Card d8bb2074 (from the Code Review of bde5d1fe) — GitWriter.checkout()/createBranch()/commit() ran
// their canonical-mutating git calls on a bare `withTimeout` (git/bounded.ts): no tree-kill, no
// kill-confirm, no quarantine raise on an unconfirmed kill, and no per-call quarantine re-check — the
// SAME class of gap `24c0bdba`/`bde5d1fe` already closed for `mergeBranchLocked`/`fastForwardCanonicalMain`,
// left open here because nothing on this path had ever driven a real hung/escaped pre-commit hook through
// it. Section [0] (fast, test-seam only, no real git) proves the genuinely NEW per-call re-check inside
// killableCanonicalRaw: a quarantine raised mid-sequence, between `add -A` and `commit`. Sections [1]-[5]
// reproduce the full integration-level gap via `commit()`'s `add -A` + `commit` calls (the same
// double-forked pre-commit hook shape `merge-commit-kill-confirm.mjs` scenario 5 already proved escapes a
// tree-kill's PID-walk) and prove the fix: the repo is QUARANTINED on an unconfirmed kill, every later
// GitWriter call on it (commit/checkout/createBranch) refuses — via the PRE-EXISTING withCanonicalIndexLock
// entry check for those, see section [3]'s own comment — until the escaped descendant's own eventual exit
// lets the auto-clear fire.
//
// Run: 1) build daemon (pnpm build), 2) node test/git-writer-kill-confirm.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { pollUntil } from "./_timing-guard.mjs";

// HERMETICITY (card 500fe2df): sections [1]-[5] below drive real unconfirmed-kill/quarantine paths — a
// real enterMergeQuarantine() raise persists a durable latch under LOOM_HOME. The two dist imports below
// were previously STATIC, which would evaluate before any runtime hermetic setup could run at all
// (static imports are hoisted ahead of every other top-level statement); converted to dynamic
// `await import(...)` so useOwnLoomHome()/requireHermeticEnv() below actually run first, same as every
// other hermetic test in this suite.
useOwnLoomHome("loom-gw-killconfirm-home-");
requireHermeticEnv();

const { GitWriter } = await import("../dist/git/writer.js");
const { activeMergeQuarantineFor, enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Regression guard for the CWD-leak this card fixes (every fixture below must live under a managed OS
// temp dir, never a bare relative path resolved against the checkout) — snapshot BEFORE any fixture is
// created, compare again at the very end, right before exit.
const cwdEntriesBefore = fs.readdirSync(process.cwd());

// ═══════════════════ [0] THE GENUINELY NEW THING THIS CARD ADDS ═══════════════════
// Code Review of a8dbb159: a call against an ALREADY-quarantined repo (sections [3]/[2] below) is refused
// by withCanonicalIndexLock's own PRE-EXISTING entry check (round 6 of 24c0bdba) — that mechanism predates
// this card and says nothing about the per-call re-check this card actually adds inside
// killableCanonicalRaw. The genuinely NEW protection is a quarantine raised MID-SEQUENCE: inside a single
// commit() invocation, AFTER its own `add -A` has already run (and after the entry check already passed
// cleanly) but BEFORE `commit` spawns anything — the exact race the card's own body names ("an UNLOCKED
// batch assembly can quarantine the repo between its add and commit"). Proven here with GitWriter's own
// test-seam `gitFactory` (no real repo/hook needed, no real git process at all): the fake `add` raw() call
// raises the quarantine as a side effect, simulating a SIBLING op quarantining the canonical repo in that
// exact window; the assertion is that `commit` is never invoked.
{
  // Absolute, mkdtemp'd path (never a bare relative literal) — `GitWriter.commit()`'s advisory
  // `pauseVaultAutoCommit` lease write (`vault/versioner.ts`) unconditionally `mkdirSync`s
  // `<repoPath>/.git/` and drops a lease file in it, a REAL fs side effect that fires even against
  // this fake-git seam and even though `canonicalRepoLockKey`/the quarantine map only ever treat
  // `msRepoPath` as a string key. A bare relative literal here resolved that mkdirSync against the
  // process CWD (the checkout itself), leaving a nested, un-removed `.git` behind on every run —
  // `mkdtempManaged` roots it under the OS temp dir instead and registers it for guaranteed cleanup.
  const msRepoPath = path.join(fs.realpathSync(mkdtempManaged("loom-gw-killconfirm-ms-")), "fake-repo");
  let addCalled = false;
  let commitRawCalled = false;
  let commitMethodCalled = false; // the OLD (pre-fix) code shape — git.commit(), never git.raw(["commit",...])
  const fakeGit = {
    status: async () => ({ isClean: () => false, files: [] }),
    raw: async (args) => {
      const argList = Array.isArray(args) ? args : [args];
      if (argList[0] === "add") {
        addCalled = true;
        enterMergeQuarantine(msRepoPath, "mid-sequence-branch", "test: simulated sibling op quarantining mid-sequence");
        return "";
      }
      if (argList[0] === "commit") { commitRawCalled = true; return ""; }
      return "";
    },
    checkout: async () => {},
    checkoutLocalBranch: async () => {},
    branchLocal: async () => ({ current: "main" }),
    commit: async () => { commitMethodCalled = true; return { commit: "" }; },
    revparse: async () => "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  };
  const msWriter = new GitWriter(msRepoPath, { gitFactory: () => fakeGit });
  const msResult = await msWriter.commit("test: mid-sequence quarantine");
  check("[0] add -A was attempted (withCanonicalIndexLock's entry check passed — nothing was quarantined yet)", addCalled === true);
  // Checked against BOTH possible git-commit call shapes (git.commit(), the pre-fix WriterGit method; and
  // git.raw(["commit",...]), killableCanonicalRaw's own shape) — asserting against only the NEW shape would
  // pass VACUOUSLY on pre-fix code, which never reaches this fake's raw() for "commit" at all.
  check("[0] commit was NEVER invoked, through EITHER call shape — killableCanonicalRaw's OWN per-call re-check caught the quarantine a SIBLING op raised between add and commit", commitRawCalled === false && commitMethodCalled === false);
  check("[0] the call is refused, naming the quarantine", msResult.ok === false && /QUARANTINED/.test(msResult.error ?? ""));
  clearMergeQuarantine(msRepoPath); // leave no residual global state behind for the real-repo scenario below
}

// SMALL_MS < HOOK's own natural duration — see merge-commit-kill-confirm.mjs's header doc for the same
// reasoning applied to mergeBranchLocked; identical shape here, just against GitWriter.commit().
const SMALL_MS = 2000;
// Comfortably past withTimeoutKillingChild's own give-up deadline (2*SMALL_MS from call start) — the
// escaped descendant must still be alive when the SECOND write attempt (immediately after) runs.
const HOLD_MS = 2 * SMALL_MS + 4000;
// Keeps the hook's own DIRECT process (the top-level `sh`, reachable by the tree-kill) alive well past
// the SMALL_MS kill-trigger, so the kill genuinely has something live to signal.
const MAIN_MS = 15000;

const root = fs.realpathSync(mkdtempManaged("loom-gw-killconfirm-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
git("init", "-q");
git("config", "user.email", "killconfirm@loom");
git("config", "user.name", "killconfirm");
git("commit", "-q", "--allow-empty", "-m", "init");

// The OUTER subshell backgrounds an INNER one and returns immediately — by the time the kill-trigger's
// tree-kill walks the process tree, the intermediate subshell that spawned the inner one has already
// exited, so the escaped descendant is unreachable by a PID-walking tree-kill (see 24c0bdba's decision
// record, round 3, Code Review B-2, for the full mechanism this reproduces).
const markerName = "escaped-descendant.marker";
const markerPath = path.join(repo, markerName);
const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
fs.writeFileSync(hookPath,
  `#!/bin/sh\n( (sleep ${HOLD_MS / 1000}; echo fixedX > fixedX.txt; git add fixedX.txt; echo done > ${markerName}) & )\nsleep ${MAIN_MS / 1000}\n`);
fs.chmodSync(hookPath, 0o755);

const writer = new GitWriter(repo, { gitLocalMs: SMALL_MS });

// Something real to stage, so `commit()` actually reaches `add -A` + `commit` rather than the "nothing to
// commit" early exit.
fs.writeFileSync(path.join(repo, "a.txt"), "content-a\n");

const first = await writer.commit("test: add a");
const KILL_OR_QUARANTINE_RE = /exceeded \d+ms|QUARANTINED/;
check("[1] first commit() attempt is refused (the hook outlives the kill-confirm timeout)", first.ok === false);
check("[1] refusal names the timeout/kill path specifically (not vacuously some other failure)",
  KILL_OR_QUARANTINE_RE.test(first.error ?? ""));
check("[1] nothing was actually committed — HEAD unchanged (the kill hit `commit`, after `add -A` had already staged a.txt)",
  git("status", "--porcelain").includes("A  a.txt") && !git("log", "--oneline").includes("test: add a"));

const entry = activeMergeQuarantineFor(repo);
check("[2] the repo is QUARANTINED after the unconfirmed kill (not a bare, unprotected failure)", !!entry);
check("[2] the quarantine names GitWriter commit as the reason", /git (add -A|commit)/.test(entry?.reason ?? ""));

// THREE further calls, one per method, against the repo quarantined above by the REAL hook escape. Each
// is refused by withCanonicalIndexLock's own PRE-EXISTING entry check (round 6 of 24c0bdba — a quarantine
// already active when the lock is acquired), NOT by this card's new per-call re-check (see section [0]
// above for the test that actually exercises that mechanism). Still worth proving: each method's own
// try/catch must correctly propagate — never swallow or misreport — a RepoQuarantinedError thrown by the
// lock before its callback ever runs.
const second = await writer.commit("test: add a (retry)");
check("[3] a SECOND commit() attempt is refused by the QUARANTINE, not a fresh independent failure",
  second.ok === false && /QUARANTINED/.test(second.error ?? ""));
const checkoutAttempt = await writer.checkout("nonexistent-branch");
check("[3] checkout() is ALSO refused by the live quarantine (not merely 'branch not found')",
  checkoutAttempt.ok === false && /QUARANTINED/.test(checkoutAttempt.error ?? ""));
const createBranchAttempt = await writer.createBranch("some-new-branch");
check("[3] createBranch() is ALSO refused by the live quarantine",
  createBranchAttempt.ok === false && /QUARANTINED/.test(createBranchAttempt.error ?? ""));
check("[3] createBranch()'s refusal cut no stray branch", !git("branch", "--list", "some-new-branch").trim());

// Wait for the escaped descendant's own marker — proves it genuinely ran (this was a REAL unconfirmed
// kill, not a false positive), then wait for the quarantine's own in-process auto-clear once its exit
// finally lets confirmation arrive.
const markerAppeared = await pollUntil(() => fs.existsSync(markerPath), { timeoutMs: HOLD_MS + 5000, intervalMs: 100 });
check("[4] the escaped descendant's marker write IS eventually observed (proves it genuinely ran)", markerAppeared);
const autoCleared = await pollUntil(() => !activeMergeQuarantineFor(repo), { timeoutMs: 10000, intervalMs: 100 });
check("[4] the quarantine AUTO-CLEARS once the real tree-death confirmation eventually arrives (no human action)", autoCleared);

// Remove the now-stale hook (its job — proving the escape — is done) and confirm a FRESH commit succeeds
// once the repo is no longer quarantined.
fs.rmSync(hookPath, { force: true });
const third = await writer.commit("test: add a (after clear)");
check("[5] once cleared, a fresh commit() succeeds", third.ok === true);
check("[5] the commit actually landed", git("log", "--oneline").includes("test: add a (after clear)"));
// The escaped descendant only ever ran `git add fixedX.txt` (never `git commit`) — confirm its staged
// change rode along into this LEGITIMATE commit rather than being lost or corrupting an earlier one.
check("[5] the escaped descendant's own staged file rode along cleanly (no corruption, nothing lost)",
  git("show", "--stat", "HEAD").includes("fixedX.txt"));

// ═══════════════════ [6] card 8d49c36c — the swept-in residue is now SURFACED, not silent ═══════════════════
// Section [5]'s `third` already proved the escaped descendant's fixedX.txt "rode along cleanly" into a
// legitimate commit — but before card 8d49c36c that was entirely invisible to the caller. Both a.txt
// (staged by the FIRST, killed attempt's own `add -A`, section [1] — never cleared, since the retry in
// section [3] was refused by the quarantine before touching the index at all) and fixedX.txt (the escaped
// descendant's own orphaned `git add`) were ALREADY staged before `third`'s own `add -A` ran.
check("[6] third's result names BOTH already-staged files in a structured `residue` field",
  Array.isArray(third.residue) && third.residue.includes("fixedX.txt") && third.residue.includes("a.txt"));
check("[6] third's `warning` text also mentions the residue count", typeof third.warning === "string" && /already staged/.test(third.warning));

// ═══════════════════ [7] card 8d49c36c review — `paths`-scoped residue matches REAL git pathspec semantics ═══════════════════
// Round-2 Code Review finding: the OLD hand-rolled prefix compare in `preExistingResidue`
// (`p === sp || p.startsWith(sp+"/") || p.startsWith(sp+"\\")`) disagreed with git's own pathspec
// matching. Reproduced: with `paths` of ["docs/"] (trailing slash), ["./docs"] (leading "./"), or
// ["*.md"] (a glob), a pre-staged docs/sub/x.md got swept into the commit by the real
// `add -A -- <paths>` call, but `residue` came back `undefined` for all three — the hand-rolled compare
// didn't recognize ANY of them as matching "docs/sub/x.md" (verified: all three return `false`). Fixed by
// computing residue via a REAL `git diff --cached --name-only -- <paths>` call instead of re-implementing
// pathspec matching by hand. Each spelling also carries the existing no-false-positive controls: an
// UNSTAGED tracked edit and a brand-new UNTRACKED file, both within the same pathspec scope, must NOT be
// reported as residue (git's own `--cached` diff only ever lists what was already in the INDEX).
{
  const pathsRepo = path.join(root, "paths-repo");
  fs.mkdirSync(pathsRepo);
  const pgit = (...args) => execFileSync("git", args, { cwd: pathsRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  pgit("init", "-q");
  pgit("config", "user.email", "paths-residue@loom");
  pgit("config", "user.name", "paths-residue");
  fs.mkdirSync(path.join(pathsRepo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(pathsRepo, "docs", "tracked.md"), "tracked v0\n");
  pgit("add", "docs/tracked.md");
  pgit("commit", "-q", "-m", "init: seed docs/tracked.md");

  const pathsWriter = new GitWriter(pathsRepo);
  const spellings = [
    { label: "trailing slash", paths: ["docs/"] },
    { label: "leading ./", paths: ["./docs"] },
    { label: "glob", paths: ["*.md"] },
  ];
  let i = 0;
  for (const { label, paths } of spellings) {
    i++;
    // (a) pre-existing residue — staged BEFORE this call's own `add -A` runs.
    fs.mkdirSync(path.join(pathsRepo, "docs", "sub"), { recursive: true });
    fs.writeFileSync(path.join(pathsRepo, "docs", "sub", "x.md"), `pre-staged residue ${i}\n`);
    pgit("add", "docs/sub/x.md");
    // (b) unstaged tracked edit — modifies an already-tracked file WITHOUT staging it (no-false-positive control).
    fs.writeFileSync(path.join(pathsRepo, "docs", "tracked.md"), `tracked v${i}\n`);
    // (c) untracked file — brand-new, never staged (no-false-positive control).
    const untrackedName = `untracked-${i}.md`;
    fs.writeFileSync(path.join(pathsRepo, "docs", untrackedName), `untracked ${i}\n`);
    // (d) the file this commit actually "asked for".
    fs.writeFileSync(path.join(pathsRepo, "docs", "intended.md"), `intended ${i}\n`);

    const result = await pathsWriter.commit(`test: paths-scoped commit (${label})`, { paths });
    check(`[7] (${label}) commit succeeds`, result.ok === true);
    check(`[7] (${label}) residue correctly names the pre-staged docs/sub/x.md`,
      Array.isArray(result.residue) && result.residue.includes("docs/sub/x.md"));
    check(`[7] (${label}) residue does NOT include the unstaged tracked edit (docs/tracked.md)`,
      !result.residue || !result.residue.includes("docs/tracked.md"));
    check(`[7] (${label}) residue does NOT include the untracked file (${untrackedName})`,
      !result.residue || !result.residue.includes(untrackedName));
    const stat = pgit("show", "--stat", "HEAD");
    check(`[7] (${label}) every touched file still landed in the commit (nothing lost)`,
      stat.includes("x.md") && stat.includes("tracked.md") && stat.includes(untrackedName) && stat.includes("intended.md"));
  }
}

// The actual regression check for this card: every fixture above lives under a managed OS temp dir, so
// the CWD itself (the checkout, or a merge gate's worktree) must show no new entries at all — the
// pre-fix bug was section [0]'s bare relative `msRepoPath`, whose `pauseVaultAutoCommit` lease write
// `mkdirSync`'d a nested `.git` straight into this directory.
const cwdEntriesAfter = fs.readdirSync(process.cwd());
check(`[cwd] the test created no new entries in the CWD (before: [${cwdEntriesBefore.join(", ")}], after: [${cwdEntriesAfter.join(", ")}])`,
  cwdEntriesAfter.length === cwdEntriesBefore.length && cwdEntriesAfter.every((e) => cwdEntriesBefore.includes(e)));

console.log(failures === 0
  ? "\nALL PASS — GitWriter.commit()/checkout()/createBranch() are kill-confirmed: a quarantine raised MID-SEQUENCE (between add and commit) is caught by the NEW per-call re-check (section [0]); an unconfirmed kill quarantines the canonical repo, and every later call on it (all three methods) refuses — via the pre-existing entry check — until the escaped descendant's own eventual exit lets the auto-clear fire; once cleared, a fresh commit surfaces any swept-in residue structurally (section [6]); `paths`-scoped residue now matches REAL git pathspec semantics across trailing-slash/./glob spellings, with no false positives on an unstaged edit or untracked file (section [7])."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
