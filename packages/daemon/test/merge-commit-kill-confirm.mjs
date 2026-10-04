import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 24c0bdba — mergeBranchLocked's squash `commit` (and merge --squash / reset) ran under a bare
// `withTimeout` (git/bounded.ts) while holding the per-repo canonical index lock (withCanonicalIndexLock,
// git/repo-lock.ts). withTimeout REJECTS INDEPENDENTLY of the underlying git child on expiry (@decision
// 8e75ee20) — so on a commit whose pre-commit hook outlives the timeout, mergeBranchLocked's own promise
// settles (ok:false, lock released) long before the REAL git.exe child actually dies. That orphaned child
// keeps running, still able to write a commit once its hook finishes — and by then, a SECOND merge (queued
// no longer, since the lock released early) may have staged its OWN diff. If the orphan resumes and
// finalizes BEFORE that second merge's own (pre-fix) cleanup clears its staged diff, the orphan commits the
// SECOND branch's content under the FIRST branch's message + Loom-Worker-Branch trailer — the exact
// incident this card fixes (card body: "main then held feat(x): add x [Loom-Worker-Branch: loom/x] whose
// only change was branch Y's y.txt").
//
// SCENARIO 1 (below) reproduces that INTEGRATION-level race end to end through the real, public
// `mergeBranch` — NOT re-testing withTimeoutKillingChild's own kill mechanism, already proven directly
// against a real slow pre-commit hook by test/bounded-git-kill-on-timeout.mjs. This file tests that
// mergeBranchLocked actually WIRES its commit/squash/reset calls through it, and that no lock release lets
// an orphan corrupt a LATER merge.
//
// TIMING DESIGN for scenario 1 (why these specific numbers, not arbitrary): the FIRST merge's own
// commit-call timeout (SMALL_MS) must fire BEFORE its pre-commit hook's natural duration (HOOK_TOTAL_MS) —
// that is the bug's own precondition. For the corruption to actually manifest (not just an inert orphan
// finding nothing staged), the FIRST hook must finish and let its orphaned git.exe resume WHILE the SECOND
// merge's own squash diff is still staged but not yet cleared by ITS OWN (bare-withTimeout, pre-fix)
// cleanup — which fires at ~2x SMALL_MS after the second merge's own commit call starts. So HOOK_TOTAL_MS
// must sit STRICTLY BETWEEN SMALL_MS and 2xSMALL_MS. This window only needs to reproduce reliably ONCE, by
// hand, against the pre-fix code (a one-time historical RED proof, never re-run against pre-fix code
// again) — the POST-FIX GREEN outcome does NOT depend on this window at all: once the commit call is
// kill-CONFIRMED, the first merge's orphan structurally never resumes to write anything, regardless of
// hook/reset timing, so the committed version of this test is robust to host jitter going forward even
// though the historical RED proof needed a specific ratio to land.
//
// SCENARIO 2 exercises a DIFFERENT, timing-robust corner of the same fix: a POST-commit hook (runs AFTER
// the ref has already moved; its exit is ignored by git) that outlives the commit-call timeout. Here HEAD
// genuinely moves before the hang even starts, on BOTH pre-fix and post-fix code — the only difference is
// whether mergeBranchLocked notices and reports it truthfully (ok:true) instead of a false ok:false.
//
// Code Review (same card): a SINGLE-PROCESS kill of git's own direct child is NOT enough — verified on
// Windows 11 and Linux/WSL that a hook's own descendants (`sh`, and whatever it spawns) are a SEPARATE
// process tree that survives it and can keep mutating the repo afterwards. The fix now tree-kills (see
// `killableCanonicalRaw`/`spawnCanonicalGitTree`, `git/bounded.ts`) rather than signalling one process.
// SCENARIO 3 and SCENARIO 4 (below) reproduce the two repros that found this: a BACKGROUNDED grandchild
// that must not touch the repo after the kill, and a lint-staged-shaped hook (`sleep; git add`) whose own
// unprompted staging must never land in either merge's real commit. Neither claim is "closed regardless
// of hook speed" — the tree-kill's own confirmation can itself go unconfirmed (`treeDeathUnconfirmed`,
// `git/bounded.ts`) on a descendant not reaped within grace; every caller checks that and fails CLOSED
// (no further mutating cleanup) rather than claiming safety it hasn't verified.
//
// Round 3 (Code Review 7f08579d) found that fail-CLOSED path could never actually fire: `treeDeathUnconfirmed`
// only matched a message no caller ever received (the give-up timer's own generic message went
// unrecognised), and even when it did fire, the repo was left otherwise unprotected — the NEXT merge on
// the same repo proceeded normally, racing whatever might still be alive. The round-3 fix (1) tags BOTH
// the give-up path and a genuinely-unconfirmed tree-kill with one typed marker (`bounded.ts`), and (2)
// QUARANTINES the repo on either, so every LATER merge/batch attempt on that repo refuses until the
// orphan's own eventual confirmed death auto-clears it, or a human resolves the repo by hand. SCENARIO 5
// (below) drives this path directly with the reviewer's own double-forked hook tail (finding B-2) and
// proves the full lifecycle: refused-with-the-right-reason, quarantined, a second merge refused, no
// corruption, and the quarantine auto-clearing once the escaped descendant's own exit lets confirmation
// finally arrive.
//
// Round 4 (Code Review b2ebf41f) found the round-3 quarantine itself had two more bypasses: it was keyed
// on the (per-attempt, ephemeral) worktree path for the batch caller instead of the canonical repo, and a
// plain daemon restart silently LIFTED it instead of re-arming it. The round-4 fix moved quarantine state
// into its own module (`git/merge-quarantine.ts`, separate from the in-flight/crash-recovery tracker this
// file's OWN header used to describe), keyed ALWAYS to the canonical repo, durable across a restart
// (re-entered at boot, cleared only by a human REST call or an in-process auto-clear), and checked at
// every canonical-mutating entry point (`mergeBranchLocked`, `createWorktree`, `runBatchedMerge`,
// `fastForwardCanonicalMain`, `finalizeMerge`, and before gate admission in both the solo and batch
// paths) — see that module's own doc and docs/decisions/24c0bdba-*.md for the full mechanism.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-commit-kill-confirm.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNeverWithControl, pollUntil } from "./_timing-guard.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df): scenarios 3-5 below drive REAL unconfirmed-kill/quarantine paths through
// the real mergeBranch() — a genuine enterMergeQuarantine() raise persists a durable latch under
// LOOM_HOME. Isolate BEFORE the dist import below, same as every other hermetic test in this suite.
useOwnLoomHome("loom-mckc-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeBranch } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { activeMergeQuarantineFor } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID_ARGV = ["-c", "user.email=killconfirm@loom", "-c", "user.name=killconfirm"];
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

// SMALL_MS < HOOK_TOTAL_MS < 2*SMALL_MS — see header doc for why this specific window matters for
// scenario 1's RED reproduction (not for its GREEN outcome, which is timing-independent).
const SMALL_MS = 2000;
const HOOK_TICKS = 13;
const HOOK_TICK_MS = 200;
const HOOK_TOTAL_MS = HOOK_TICKS * HOOK_TICK_MS; // 2600ms, 1.3x SMALL_MS
const SETTLE_MARGIN_MS = 3000; // extra wait AFTER both merges settle, comfortably past either hook's own
                                // natural completion (see header doc's timeline) before we trust check().

const BRANCH_A = "loom/kc-card-a";
const BRANCH_B = "loom/kc-card-b";

// B2 (Code Review, card 24c0bdba): a REPO-LOCAL identity, not just a `-c` override on THIS file's OWN
// direct git calls — mergeBranch's internal commit calls carry no identity override of their own, so on
// a host with no global git identity (a likely CI shape) they'd fail "Author identity unknown" and
// scenario 1 would PASS VACUOUSLY (both merges just fail, for the wrong reason, before ever reaching the
// kill-confirm path this file exists to prove). `git config` (no --global) persists into THIS repo's own
// `.git/config`, so every later commit here — including one mergeBranch fires with no `-c` of its own —
// resolves an identity regardless of the host's ambient config.
//
// Card a6b1c4c7: both `repo` and `wt` used to be FIXED paths (`os.tmpdir()/loom-killconfirm-<tag>` /
// `-wt-<branch>-<tag>`) with no per-run suffix — two concurrent invocations of this file (two worker
// run_gates admitted at once) shared those dirs, so one run's writes made the other's commit empty and
// either run's cleanup deleted the other's live repo. `mkdtempManaged` (`_tmp-fixture.mjs`) mints an
// atomically-unique dir per call (kernel-guaranteed, not a hand-rolled Date.now()/pid suffix) and
// registers it for guaranteed cleanup in the same call — confirmed empirically that `git worktree add`
// accepts a pre-existing EMPTY directory as its target, so minting the worktree dir this way needs no
// special-casing.
function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-killconfirm-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "killconfirm@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "killconfirm"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}
function makeWorktree(repo, branch, file, content, tag) {
  const wt = mkdtempManaged(`loom-killconfirm-wt-${branch.replace(/\//g, "-")}-${tag}-`);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", `${branch} work`], { cwd: wt });
  return wt;
}

// Always-slow, output-emitting PRE-commit hook — runs on EVERY invocation (not one-shot): the second
// merge's own commit must ALSO be delayed for scenario 1's corruption window (see header doc) to open.
function installAlwaysSlowPreCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const nodeScript = `(async()=>{for(let i=0;i<${HOOK_TICKS};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${HOOK_TICK_MS}));}})();`;
  fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}
// Slow, output-emitting POST-commit hook (scenario 2) — runs AFTER the ref has already moved.
function installSlowPostCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "post-commit");
  const nodeScript = `(async()=>{for(let i=0;i<${HOOK_TICKS};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${HOOK_TICK_MS}));}})();`;
  fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}

// Code Review repro 1 (card 24c0bdba, B1): a BACKGROUNDED grandchild (`&`, still in the SAME process
// group as git's own hook child — a plain shell background job does not setsid/detach) must not survive
// the tree-kill. `killGraceMs` window aside, `markerDelayMs` MUST exceed `SMALL_MS` — scheduled to fire
// AFTER the kill-trigger, not before it, or the write would race ahead of anything under test.
function installBackgroundingPreCommitHook(repo, markerPath, markerDelayMs) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const writeMarker = `require("fs").writeFileSync(${JSON.stringify(markerPath)},String(Date.now()))`;
  const tickScript = `(async()=>{for(let i=0;i<${HOOK_TICKS};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${HOOK_TICK_MS}));}})();`;
  fs.writeFileSync(hookPath,
    `#!/bin/sh\n(sleep ${markerDelayMs / 1000}; node -e '${writeMarker}') &\nnode -e '${tickScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
}
// Code Review repro 2 (card 24c0bdba, B1): the reviewer's own lint-staged-shaped hook — sleep, then the
// hook's OWN shell stages a NEW file via `git add`, independent of anything either merge asked for.
function installLintStagedShapedPreCommitHook(repo, sleepMs) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nsleep ${sleepMs / 1000}\necho fixedA > fixedA.txt\ngit add fixedA.txt\n`);
  fs.chmodSync(hookPath, 0o755);
}
// A short, output-emitting hook of a CONFIGURABLE total duration — used for branch B in scenario 4 to
// keep B's own commit PENDING (staged, uncommitted) just long enough for A's orphaned hook's `git add`
// to land while B is still in that window, without B's own wrapper ever timing out (totalMs must stay
// well under SMALL_MS).
//
// Routes through a SEPARATE `core.hooksPath` directory rather than overwriting `.git/hooks/pre-commit`
// in place: A's own orphaned hook process (still sleeping, per the lint-staged repro above) is STILL
// READING that same file from disk — a `sh` script does not fully buffer itself before executing, so
// overwriting the file out from under it (verified directly: A's own script silently never completed
// past the point of the overwrite) corrupts what it reads next. A distinct hooksPath means A's own file
// is never touched again once installed, and B's later commit reads its own, separate file instead.
function installTimedPreCommitHook(repo, totalMs, ticks = 6) {
  const tickMs = Math.max(20, Math.round(totalMs / ticks));
  const altHooksDir = path.join(repo, ".git", "hooks-b");
  fs.mkdirSync(altHooksDir, { recursive: true });
  const hookPath = path.join(altHooksDir, "pre-commit");
  const nodeScript = `(async()=>{for(let i=0;i<${ticks};i++){console.log("tick",i);` +
    `await new Promise(r=>setTimeout(r,${tickMs}));}})();`;
  fs.writeFileSync(hookPath, `#!/bin/sh\nnode -e '${nodeScript}'\n`);
  fs.chmodSync(hookPath, 0o755);
  execFileSync("git", ["-C", repo, "config", "core.hooksPath", altHooksDir.replace(/\\/g, "/")]);
}

function trailerCommits(repo, branch) {
  const shas = git(repo, ["log", "--all", "--format=%H"]).trim().split("\n").filter(Boolean);
  const re = new RegExp(`^Loom-Worker-Branch:\\s*${branch.replace(/\//g, "\\/")}\\s*$`, "m");
  return shas.filter((sha) => re.test(git(repo, ["log", "-1", "--format=%B", sha])));
}
function commitHasPath(repo, sha, relPath) {
  // stdio:"ignore" — an absent path is the EXPECTED, common case (most commits don't carry it), so git's
  // own "fatal: path does not exist" belongs in the try/catch's control flow, not in the test's own log.
  try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${sha}:${relPath}`], { stdio: "ignore" }); return true; } catch { return false; }
}
function anyCommitHasPath(repo, relPath) {
  return git(repo, ["log", "--all", "--format=%H"]).trim().split("\n").filter(Boolean)
    .some((sha) => commitHasPath(repo, sha, relPath));
}
// THE CORRUPTION SIGNATURE (card 24c0bdba's own incident): a commit bearing branch A's trailer whose tree
// ALSO/INSTEAD contains branch B's file — branch A never touched file-b.txt, so its presence proves the
// commit's content came from a DIFFERENT merge attempt than the one its own trailer claims.
function corruptionExists(repo) {
  return trailerCommits(repo, BRANCH_A).some((sha) => commitHasPath(repo, sha, "file-b.txt"));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario1(tag) {
  const repo = makeRepo(`s1-${tag}`);
  makeWorktree(repo, BRANCH_A, "file-a.txt", "content-a\n", tag);
  makeWorktree(repo, BRANCH_B, "file-b.txt", "content-b\n", tag);
  installAlwaysSlowPreCommitHook(repo);

  const merge1 = await mergeBranch(repo, BRANCH_A, "feat(a): add a", { timeoutMs: SMALL_MS });
  const merge2 = await mergeBranch(repo, BRANCH_B, "feat(b): add b", { timeoutMs: SMALL_MS });
  await wait(HOOK_TOTAL_MS + SETTLE_MARGIN_MS);

  return { repo, merge1, merge2 };
}

function assertTruthfulIfLanded(repo, result, branch, relPath, expectedContent) {
  if (result?.ok !== true || !result.sha) return;
  const msg = git(repo, ["log", "-1", "--format=%B", result.sha]);
  check(`[${branch}] reported landed sha truthfully carries its OWN trailer`,
    new RegExp(`^Loom-Worker-Branch:\\s*${branch.replace(/\//g, "\\/")}\\s*$`, "m").test(msg));
  let content = null;
  try { content = execFileSync("git", ["-C", repo, "show", `${result.sha}:${relPath}`], { encoding: "utf8" }); } catch { /* absent */ }
  check(`[${branch}] reported landed sha truthfully contains its OWN file with correct content (not a swap)`,
    content === expectedContent);
}

async function runScenario2(tag) {
  const repo = makeRepo(`s2-${tag}`);
  makeWorktree(repo, BRANCH_A, "file-a.txt", "content-a\n", `pc-${tag}`);
  installSlowPostCommitHook(repo);
  const initHead = git(repo, ["rev-parse", "HEAD"]).trim();
  const result = await mergeBranch(repo, BRANCH_A, "feat(a): add a", { timeoutMs: SMALL_MS });
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  return { repo, result, initHead, head };
}

// SCENARIO 3 (Code Review repro 1): does the tree-kill reach a BACKGROUNDED grandchild, not just git's
// own direct child? `markerDelayMs` is scheduled well AFTER SMALL_MS's kill-trigger.
const GRANDCHILD_DELAY_MS = SMALL_MS + 1000;
async function runScenario3(tag) {
  const repo = makeRepo(`s3-${tag}`);
  makeWorktree(repo, BRANCH_A, "file-a.txt", "content-a\n", `s3-${tag}`);
  const markerPath = path.join(repo, "grandchild-touched.marker");
  installBackgroundingPreCommitHook(repo, markerPath, GRANDCHILD_DELAY_MS);
  const merge = await mergeBranch(repo, BRANCH_A, "feat(a): add a", { timeoutMs: SMALL_MS });
  return { repo, merge, markerPath };
}

// SCENARIO 4 (Code Review repro 2, the reviewer's own lint-staged-shaped repro): "Merge A is killed at
// 1s -> reset --hard -> merge B stages cardB.txt and commits -> B's commit (B's subject + trailer)
// CONTAINS fixedA.txt from A's hook." For fixedA.txt to SURVIVE into B's landed commit, A's own `git add`
// must fire AFTER A's OWN commit-failure `reset --hard` has already run (that reset clears whatever is
// staged AT THAT MOMENT — landing the add any earlier just gets it discarded there, harmlessly) — so
// `A_ADD_DELAY_MS` is set to a WORST-CASE bound on A's own settle+reset (2x the kill-trigger, the give-up
// grace window, plus margin), not a guess. B then needs its OWN commit to still be PENDING when that add
// lands — measured DYNAMICALLY from how long A's attempt actually took on THIS host/run (`merge1ElapsedMs`),
// so this reproduces reliably regardless of host speed, rather than two independently-guessed constants
// that can only ever agree by luck. B's own `timeoutMs` is deliberately decoupled from `SMALL_MS`
// (generously larger than its own hook) — this scenario is not testing B's kill behaviour at all, only
// that whatever DOES land in B's real commit is exactly what it staged, nothing A's hook added later.
const A_ADD_DELAY_MS = 2 * SMALL_MS + 2000;
async function runScenario4(tag) {
  const repo = makeRepo(`s4-${tag}`);
  makeWorktree(repo, BRANCH_A, "file-a.txt", "content-a\n", `s4-${tag}`);
  makeWorktree(repo, BRANCH_B, "file-b.txt", "content-b\n", `s4-${tag}`);
  installLintStagedShapedPreCommitHook(repo, A_ADD_DELAY_MS);
  const t1 = Date.now();
  const merge1 = await mergeBranch(repo, BRANCH_A, "feat(a): add a", { timeoutMs: SMALL_MS });
  const merge1ElapsedMs = Date.now() - t1;
  // B's hook must still be running when A's add lands (A_ADD_DELAY_MS, measured from A's OWN start —
  // the SAME clock, since B fires immediately after merge1 settles) — with a margin on top so ordinary
  // scheduling jitter can't flip it.
  const bHookMs = Math.max(800, A_ADD_DELAY_MS - merge1ElapsedMs + 1500);
  installTimedPreCommitHook(repo, bHookMs); // swap AFTER merge1 settles — a later file overwrite never
  // affects an already-running orphaned hook process, only future invocations (merge2's own commit).
  const merge2 = await mergeBranch(repo, BRANCH_B, "feat(b): add b", { timeoutMs: bHookMs + SMALL_MS });
  await wait(A_ADD_DELAY_MS + SETTLE_MARGIN_MS);
  return { repo, merge1, merge2 };
}

// SCENARIO 5 (round 3, Code Review B-2's own exact repro shape): the OUTER subshell backgrounds an INNER
// one and returns immediately — by the time the kill-trigger's tree-kill walks the tree, the intermediate
// subshell that spawned the inner one has already exited, breaking the parent-child chain a PPID-walking
// tree-kill (win32 `taskkill /T`) relies on to find it (measured on Windows 11: git.exe dies ~300ms after
// the kill, but the escaped descendant survives and keeps the pipe open for tens of seconds). On POSIX
// without `setsid` the inner subshell stays in the SAME process group and IS still reached by
// `process.kill(-pid, SIGKILL)` — an accepted, documented residual difference (see the decision record),
// not a bug in this test.
// `markerName` is written via a plain relative shell redirect (git always invokes a hook with cwd at the
// worktree root, so `repo`-relative is all that's needed) — NOT `node -e` with an embedded absolute path:
// a Windows-absolute path threaded through Git-Bash's MSYS argv translation for a NATIVE (non-MSYS)
// program corrupted the path entirely in manual testing (a real footgun, not a hypothetical one — see
// CLAUDE.md's own "isolated-daemon testing on Windows" section for the sibling class of this bug).
function installDoubleForkedPreCommitHook(repo, markerName, holdMs, mainMs) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath,
    `#!/bin/sh\n( (sleep ${holdMs / 1000}; echo fixedX > fixedX.txt; git add fixedX.txt; echo done > ${markerName}) & )\nsleep ${mainMs / 1000}\n`);
  fs.chmodSync(hookPath, 0o755);
}
// Comfortably past withTimeoutKillingChild's own give-up deadline (2*SMALL_MS from call start) — the
// escaped descendant must still be alive when BOTH merge1 and merge2 (attempted immediately after) run.
const S5_HOLD_MS = 2 * SMALL_MS + 4000;
// Keeps the hook's own DIRECT process (the top-level `sh`, still reachable by the tree-kill) alive well
// past the SMALL_MS kill-trigger, so the kill genuinely has something live to signal.
const S5_MAIN_MS = 15000;
async function runScenario5(tag) {
  const repo = makeRepo(`s5-${tag}`);
  makeWorktree(repo, BRANCH_A, "file-a.txt", "content-a\n", `s5-${tag}`);
  makeWorktree(repo, BRANCH_B, "file-b.txt", "content-b\n", `s5-${tag}`);
  const markerName = "escaped-descendant.marker";
  const markerPath = path.join(repo, markerName);
  installDoubleForkedPreCommitHook(repo, markerName, S5_HOLD_MS, S5_MAIN_MS);
  const merge1 = await mergeBranch(repo, BRANCH_A, "feat(a): add a", { timeoutMs: SMALL_MS });
  const merge2 = await mergeBranch(repo, BRANCH_B, "feat(b): add b", { timeoutMs: SMALL_MS });
  return { repo, merge1, merge2, markerPath };
}

// POSITIVE CONTROL — proves corruptionExists() can actually observe the violation shape, independent of
// mergeBranch: manufacture the exact signature directly (branch A's trailer, branch B's file) in a
// throwaway repo with no merges involved at all.
const controlRepo = makeRepo("positive-control");
fs.writeFileSync(path.join(controlRepo, "file-b.txt"), "content-b\n");
execFileSync("git", ["-C", controlRepo, "add", "-A"]);
execFileSync("git", ["-C", controlRepo, ...GIT_ID_ARGV, "commit", "-q", "-m",
  `feat(a): add a\n\nLoom-Worker-Branch: ${BRANCH_A}\n`]);
check("[setup] positive control: a manufactured commit carrying branch A's trailer but branch B's file " +
  "IS detected as corruption by corruptionExists()", corruptionExists(controlRepo));

const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let scenario;
const result = await assertNeverWithControl({
  label: "an orphaned squash commit from a timed-out merge never lands a LATER merge's content under its own trailer",
  check: () => corruptionExists(scenario.repo),
  positiveControl: async () => corruptionExists(controlRepo),
  settle: async () => { scenario = await runScenario1(tag); },
});

check("[scenario 1] outcome: no corruption — no commit exists bearing branch A's trailer with branch B's file",
  result === true);
assertTruthfulIfLanded(scenario.repo, scenario.merge1, BRANCH_A, "file-a.txt", "content-a\n");
assertTruthfulIfLanded(scenario.repo, scenario.merge2, BRANCH_B, "file-b.txt", "content-b\n");
// "no ok:false-then-later-landing": if a merge reported failure, no commit for that side should exist
// bearing its trailer at all — a false ok:false with a real commit lurking anyway is exactly the
// silent-success-reported-as-failure shape this card's DoD calls out (the flip side of scenario 2 below).
// B2 (Code Review): assert the FAILURE REASON specifically names the timeout/kill path — a merge that
// failed for an UNRELATED reason (e.g. no git identity resolvable) would ALSO make the two checks above
// pass, VACUOUSLY, without ever exercising the kill-confirm mechanism this file exists to prove.
const KILL_REASON_RE = /exceeded \d+ms/;
// Round 3 (m-d): a QUARANTINED refusal (the NEXT merge attempt on an already-quarantined repo) never
// itself names a timeout — reused by scenarios 3/4 below alongside KILL_REASON_RE.
const KILL_OR_QUARANTINE_REASON_RE = /exceeded \d+ms|QUARANTINED/;
if (scenario.merge1?.ok === false) {
  check("[scenario 1] merge1 failed for the TIMEOUT/kill reason specifically (not vacuously for something else)",
    KILL_REASON_RE.test(scenario.merge1?.reason ?? ""));
  check("[scenario 1] merge1 reported ok:false and truthfully landed nothing under its own trailer",
    trailerCommits(scenario.repo, BRANCH_A).length === 0);
}
if (scenario.merge2?.ok === false) {
  check("[scenario 1] merge2 failed for the TIMEOUT/kill reason specifically (not vacuously for something else)",
    KILL_REASON_RE.test(scenario.merge2?.reason ?? ""));
  check("[scenario 1] merge2 reported ok:false and truthfully landed nothing under its own trailer",
    trailerCommits(scenario.repo, BRANCH_B).length === 0);
}
console.log(`[scenario 1] info: merge1=${JSON.stringify({ ok: scenario.merge1?.ok, reason: scenario.merge1?.reason })} ` +
  `merge2=${JSON.stringify({ ok: scenario.merge2?.ok, reason: scenario.merge2?.reason })}`);

// SCENARIO 2 — post-commit hook: HEAD genuinely moves before the hang even starts (on BOTH pre-fix and
// post-fix code); only the TRUTHFULNESS of the report should differ.
const pc = await runScenario2(tag);
const headMoved = pc.head !== pc.initHead;
check("[scenario 2] the commit actually landed (HEAD moved) despite the post-commit hook hanging past the timeout",
  headMoved);
check("[scenario 2] mergeBranch reports this TRUTHFULLY as ok:true (not a false ok:false while a real commit sits unreported)",
  pc.result?.ok === true);
if (pc.result?.ok === true) {
  check("[scenario 2] the reported sha matches what HEAD actually is", pc.result.sha === pc.head);
  let content = null;
  try { content = execFileSync("git", ["-C", pc.repo, "show", `${pc.result.sha}:file-a.txt`], { encoding: "utf8" }); } catch { /* absent */ }
  check("[scenario 2] the reported sha truthfully contains the branch's own file", content === "content-a\n");
} else {
  console.log(`[scenario 2] info: mergeBranch reported ${JSON.stringify({ ok: pc.result?.ok, reason: pc.result?.reason })} ` +
    `while HEAD actually moved to ${pc.head} (was ${pc.initHead}) — this is the false-negative this scenario exists to catch`);
}

// SCENARIO 3 (Code Review repro 1) — POSITIVE CONTROL first: prove the marker-check can actually
// observe a real write, by letting the SAME backgrounding hook run to natural completion (a timeoutMs
// large enough that mergeBranch's own kill-trigger never fires).
const s3ControlRepo = makeRepo(`s3-control-${tag}`);
makeWorktree(s3ControlRepo, BRANCH_A, "file-a.txt", "content-a\n", `s3-control-${tag}`);
const s3ControlMarker = path.join(s3ControlRepo, "grandchild-touched.marker");
installBackgroundingPreCommitHook(s3ControlRepo, s3ControlMarker, 200);
await mergeBranch(s3ControlRepo, BRANCH_A, "feat(a): add a", { timeoutMs: GRANDCHILD_DELAY_MS + HOOK_TOTAL_MS + SETTLE_MARGIN_MS });
check("[setup] positive control: an UNKILLED backgrounded grandchild's write IS observed (the marker check can detect a real violation)",
  fs.existsSync(s3ControlMarker));

let s3;
const s3Result = await assertNeverWithControl({
  label: "a backgrounded grandchild of a killed commit's hook never touches the repo after the kill",
  check: () => fs.existsSync(s3.markerPath),
  positiveControl: async () => fs.existsSync(s3ControlMarker),
  settle: async () => { s3 = await runScenario3(tag); await wait(GRANDCHILD_DELAY_MS + SETTLE_MARGIN_MS); },
});
check("[scenario 3] outcome: the backgrounded grandchild's marker write never happened — the tree-kill reached it too",
  s3Result === true);
// Round 3 (m-d): scenario 1's own vacuity guard, applied here too — a merge that failed for an
// UNRELATED reason would also pass the check above, vacuously, without exercising the kill-confirm path.
if (s3.merge?.ok === false) {
  check("[scenario 3] merge failed for the TIMEOUT/kill/quarantine reason specifically (not vacuously for something else)",
    KILL_OR_QUARANTINE_REASON_RE.test(s3.merge?.reason ?? ""));
}
console.log(`[scenario 3] info: merge=${JSON.stringify({ ok: s3.merge?.ok, reason: s3.merge?.reason })}`);

// SCENARIO 4 (Code Review repro 2) — POSITIVE CONTROL: anyCommitHasPath can observe a real fixedA.txt commit.
const s4ControlRepo = makeRepo(`s4-control-${tag}`);
fs.writeFileSync(path.join(s4ControlRepo, "fixedA.txt"), "fixedA\n");
execFileSync("git", ["-C", s4ControlRepo, "add", "-A"]);
execFileSync("git", ["-C", s4ControlRepo, ...GIT_ID_ARGV, "commit", "-q", "-m", "manufactured fixedA.txt commit"]);
check("[setup] positive control: a manufactured commit containing fixedA.txt IS detected by anyCommitHasPath()",
  anyCommitHasPath(s4ControlRepo, "fixedA.txt"));

let s4;
const s4Result = await assertNeverWithControl({
  label: "a lint-staged-shaped hook's own unprompted git add never lands in any commit either merge actually makes",
  check: () => anyCommitHasPath(s4.repo, "fixedA.txt"),
  positiveControl: async () => anyCommitHasPath(s4ControlRepo, "fixedA.txt"),
  settle: async () => { s4 = await runScenario4(tag); },
});
check("[scenario 4] outcome: fixedA.txt (the hook's own unprompted git add) never lands in any commit",
  s4Result === true);
// Round 3 (m-d): same vacuity guard as scenario 1 — with the round-3 fix, merge1 is expected to hit the
// UNCONFIRMED-kill path (still matches KILL_REASON_RE: its message embeds the original "exceeded Nms"
// text) and merge2 is expected to be refused by the QUARANTINE this scenario's own merge1 just entered.
if (s4.merge1?.ok === false) {
  check("[scenario 4] merge1 failed for the TIMEOUT/kill reason specifically (not vacuously for something else)",
    KILL_REASON_RE.test(s4.merge1?.reason ?? ""));
}
if (s4.merge2?.ok === false) {
  check("[scenario 4] merge2 failed for the QUARANTINE reason specifically (not vacuously for something else)",
    KILL_OR_QUARANTINE_REASON_RE.test(s4.merge2?.reason ?? ""));
}
console.log(`[scenario 4] info: merge1=${JSON.stringify({ ok: s4.merge1?.ok, reason: s4.merge1?.reason })} ` +
  `merge2=${JSON.stringify({ ok: s4.merge2?.ok, reason: s4.merge2?.reason })}`);

// SCENARIO 5 (round 3) — drive the unconfirmed path itself and prove the full quarantine lifecycle.
const s5 = await runScenario5(tag);
console.log(`[scenario 5] info: merge1=${JSON.stringify({ ok: s5.merge1?.ok, reason: s5.merge1?.reason })} ` +
  `merge2=${JSON.stringify({ ok: s5.merge2?.ok, reason: s5.merge2?.reason })}`);
check("[scenario 5] merge1 (whose hook's own descendant escapes the tree-kill) is refused",
  s5.merge1?.ok === false);
if (s5.merge1?.ok === false) {
  check("[scenario 5] merge1 failed for the TIMEOUT/kill reason specifically (not vacuously for something else)",
    KILL_REASON_RE.test(s5.merge1?.reason ?? ""));
  // Card 8d8fa497: merge1 is the op whose OWN commit call raised this quarantine (an escaped descendant,
  // never confirmed dead) — its own result must say so directly, not merely be inferable from merge2's
  // SEPARATE refusal below (merge1's own `reason` text never contains the literal word "QUARANTINED" — see
  // docs/decisions/8d8fa497-*.md — so `quarantined:true` on merge1 itself is the only reliable signal).
  check("[scenario 5] merge1's OWN result carries quarantined:true — not just inferred from merge2's refusal",
    s5.merge1?.quarantined === true);
}
check("[scenario 5] merge2 (a DIFFERENT branch, same repo, attempted immediately after) is refused by the QUARANTINE, not a generic failure",
  s5.merge2?.ok === false && /QUARANTINED/.test(s5.merge2?.reason ?? ""));
check("[scenario 5] the quarantine is visible directly via the internal quarantine state (not merely inferred from merge2's refusal)",
  !!activeMergeQuarantineFor(s5.repo));

// POSITIVE CONTROL for the marker check: proves the escaped descendant genuinely runs (this scenario is
// not vacuous) — a bounded POLL on the real event, never a single fixed-length guessed sleep.
const s5MarkerAppeared = await pollUntil(() => fs.existsSync(s5.markerPath), { timeoutMs: S5_HOLD_MS + SETTLE_MARGIN_MS });
check("[scenario 5] the escaped descendant's marker write IS eventually observed (proves it genuinely ran)",
  s5MarkerAppeared);
check("[scenario 5] but the escaped descendant's own git add (fixedX.txt) never lands in EITHER merge's real commit — no corruption",
  !anyCommitHasPath(s5.repo, "fixedX.txt"));

// AUTO-CLEAR: once the descendant's own exit lets the real confirmation finally arrive, the quarantine
// lifts on its own — bounded poll on the real internal state, never a fixed guessed sleep.
// Generous bound: the underlying OS-level pipe-close signal (what `onTreeDeathSettled` ultimately waits
// on) was measured, empirically, to lag the escaped descendant's own last write by several more seconds
// on Windows — wider than the marker-poll window above, deliberately, not a guess.
const s5AutoCleared = await pollUntil(() => !activeMergeQuarantineFor(s5.repo), { timeoutMs: 20_000 });
check("[scenario 5] the quarantine AUTO-CLEARS once the real tree-death confirmation eventually arrives (no human action)",
  s5AutoCleared);

// The quarantine's own lift does not by itself clear the SEPARATE, correctly-refusing staged-residue
// guard the interrupted commit left behind (@decision 2eddf573) — simulate "a human resolves it by
// hand" (the documented recovery path: reset the residue, remove the now-irrelevant slow hook) and
// confirm a fresh merge succeeds afterwards, proving the quarantine was the only PERMANENT-looking
// obstacle, not a repo left broken forever.
fs.rmSync(path.join(s5.repo, ".git", "hooks", "pre-commit"), { force: true });
git(s5.repo, ["reset", "--hard", "HEAD"]);
const merge3 = await mergeBranch(s5.repo, BRANCH_B, "feat(b): add b", { timeoutMs: SMALL_MS });
check("[scenario 5] once the quarantine has cleared AND a human has resolved the residue, a fresh merge succeeds",
  merge3.ok === true);
console.log(`[scenario 5] info: merge3=${JSON.stringify({ ok: merge3.ok, reason: merge3.reason })}`);

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBranchLocked's squash commit is kill-confirmed: a timed-out commit's real git " +
    "child is confirmed dead before the canonical lock releases (scenario 1), a commit that actually " +
    "landed despite a hung post-commit hook is reported truthfully instead of a false failure (scenario " +
    "2), the kill reaches a BACKGROUNDED grandchild of the hook (scenario 3), a lint-staged-shaped " +
    "hook's own unprompted git add never lands in any commit either merge actually makes (scenario 4), " +
    "and a double-forked hook tail that escapes the tree-kill entirely quarantines the repo (no corruption, " +
    "a second merge refused) and auto-clears once its own eventual confirmed death arrives (scenario 5)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
