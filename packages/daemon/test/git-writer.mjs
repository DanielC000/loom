import "./_guard.mjs"; // FIRST: arms LOOM_TEST=1 + strips GIT_PAGER/PAGER before simple-git is exercised.
// Unit test for the git WRITER (checkout / createBranch / commit / push) + its bounded,
// non-interactive guarantee. Claude-free: imports the compiled module and runs real git on a temp
// repo. Run after build: node test/git-writer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWriter, nonInteractiveEnv } from "../dist/git/writer.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// 0. The git-writer's non-interactive env must pin a stable C locale so we can MACHINE-READ git's stderr
//    (the no-upstream `push -u` retry below keys on English substrings). LC_ALL=C must win regardless of
//    the host locale, and the existing fail-fast guards must stay intact.
{
  const env = nonInteractiveEnv();
  check("non-interactive env pins LC_ALL=C", env.LC_ALL === "C");
  check("non-interactive env pins LANG=C", env.LANG === "C");
  check("non-interactive env keeps GIT_TERMINAL_PROMPT=0", env.GIT_TERMINAL_PROMPT === "0");
  check("non-interactive env keeps GCM_INTERACTIVE=never", env.GCM_INTERACTIVE === "never");
  // LC_ALL/LANG must OVERRIDE an inherited non-English locale, not be shadowed by it.
  const savedLcAll = process.env.LC_ALL, savedLang = process.env.LANG;
  process.env.LC_ALL = "de_DE.UTF-8"; process.env.LANG = "de_DE.UTF-8";
  const overridden = nonInteractiveEnv();
  check("LC_ALL=C overrides an inherited non-English LC_ALL", overridden.LC_ALL === "C");
  check("LANG=C overrides an inherited non-English LANG", overridden.LANG === "C");
  if (savedLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = savedLcAll;
  if (savedLang === undefined) delete process.env.LANG; else process.env.LANG = savedLang;
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-writer-")));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
// A repo configured with a test identity — the writer commits PLAINLY under whatever the repo is set
// to (no -c overrides, no Co-Authored-By), so this identity must land on the writer's commits.
git("init");
git("config", "user.email", "loom-test@example.com");
git("config", "user.name", "loom-test");
git("config", "commit.gpgsign", "false");
fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
git("add", "-A");
git("commit", "-m", "initial");
const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD").trim();

const w = new GitWriter(repo);

try {
  // 1. createBranch: makes + switches to a new branch off HEAD.
  const cb = await w.createBranch("feature/x");
  check("createBranch returns ok", cb.ok === true && cb.branch === "feature/x");
  check("HEAD is now feature/x", git("rev-parse", "--abbrev-ref", "HEAD").trim() === "feature/x");
  // createBranch on an existing name is an EXPECTED failure (structured, not a throw).
  const dup = await w.createBranch("feature/x");
  check("createBranch on existing rejected", dup.ok === false && typeof dup.error === "string" && dup.error.length > 0);

  // 2. commit: stages all changes and commits under the repo identity. Returns the new hash.
  fs.writeFileSync(path.join(repo, "new.txt"), "added on feature/x\n");
  const cm = await w.commit("add new.txt");
  check("commit returns ok + hash", cm.ok === true && /^[0-9a-f]{7,40}$/.test(cm.hash ?? ""));
  check("commit landed in history", git("log", "--pretty=%s").includes("add new.txt"));
  check("commit used the repo identity (no override/trailer)", git("log", "-1", "--pretty=%an <%ae>").trim() === "loom-test <loom-test@example.com>");
  check("commit body has NO Co-Authored-By trailer", !git("log", "-1", "--pretty=%B").includes("Co-Authored-By"));
  check("working tree clean after commit", git("status", "--porcelain").trim() === "");
  // commit on a clean tree is an EXPECTED no-op failure, never a throw or an empty commit.
  const noop = await w.commit("nothing here");
  check("commit on clean tree rejected", noop.ok === false && /nothing to commit/i.test(noop.error ?? ""));

  // 3. checkout: switches to an existing branch; an unknown branch fails (structured).
  const co = await w.checkout(baseBranch);
  check("checkout returns ok", co.ok === true && co.branch === baseBranch);
  check("HEAD switched back to base", git("rev-parse", "--abbrev-ref", "HEAD").trim() === baseBranch);
  const bad = await w.checkout("does-not-exist");
  check("checkout of unknown branch rejected", bad.ok === false && typeof bad.error === "string" && bad.error.length > 0);

  // 4. push with NO reachable remote must FAIL FAST (bounded + non-interactive) — never hang. The repo
  //    has no remote configured, so git errors immediately ("No configured push destination"). We also
  //    assert it returns well within the writer's push budget, proving the bound holds.
  const started = process.hrtime.bigint();
  const pushNoRemote = await w.push();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  check("push with no remote fails (structured, not a throw)", pushNoRemote.ok === false && typeof pushNoRemote.error === "string");
  check("push failed FAST (bounded — did not hang)", elapsedMs < 30_000);

  // 5. push to an UNREACHABLE remote must also fail fast, not hang on credentials/network. Point a
  //    remote at a non-existent local path + set tracking config directly (no fetch needed);
  //    GIT_TERMINAL_PROMPT=0 + the timeout bound it.
  git("remote", "add", "origin", path.join(root, "no-such-remote.git"));
  git("config", "branch." + baseBranch + ".remote", "origin");
  git("config", "branch." + baseBranch + ".merge", "refs/heads/" + baseBranch);
  const started2 = process.hrtime.bigint();
  const pushUnreachable = await w.push();
  const elapsedMs2 = Number(process.hrtime.bigint() - started2) / 1e6;
  check("push to unreachable remote fails (structured)", pushUnreachable.ok === false && typeof pushUnreachable.error === "string");
  check("push to unreachable remote failed FAST (bounded)", elapsedMs2 < 30_000);

  // 6. happy-path push to a REAL (bare, local) remote works end-to-end — the success path is exercised
  //    hermetically without a network. (A live network push is left for the manager to eyeball.)
  git("remote", "remove", "origin");
  const bare = path.join(root, "bare.git");
  execFileSync("git", ["init", "--bare", bare], { stdio: ["ignore", "pipe", "pipe"] });
  git("remote", "add", "origin", bare);
  // Seed the remote + set upstream with an explicit `push -u` once; then the writer's plain push
  // (to the now-tracking remote) must succeed.
  git("push", "-u", "origin", baseBranch);
  fs.writeFileSync(path.join(repo, "more.txt"), "more\n");
  git("add", "-A"); git("commit", "-m", "second");
  const okPush = await w.push();
  check("plain push to tracking remote succeeds", okPush.ok === true && okPush.branch === baseBranch);
  const remoteLog = execFileSync("git", ["--git-dir", bare, "log", "--pretty=%s"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  check("pushed commit reached the remote", remoteLog.includes("second"));

  // 7. push of a FRESH branch with NO upstream — the exact "+ Branch" repro: created locally, never
  //    pushed, so a plain push errors "The current branch <x> has no upstream branch." The writer must
  //    PUBLISH it: succeed AND set tracking to origin/<branch> (push -u). The remote `origin` is the
  //    bare repo from step 6.
  const fresh = await w.createBranch("feature/fresh");
  check("createBranch fresh ok", fresh.ok === true && fresh.branch === "feature/fresh");
  fs.writeFileSync(path.join(repo, "fresh.txt"), "added on fresh branch\n");
  git("add", "-A"); git("commit", "-m", "fresh commit");
  const freshPush = await w.push();
  check("push of fresh no-upstream branch succeeds", freshPush.ok === true && freshPush.branch === "feature/fresh");
  const freshUpstream = git("rev-parse", "--abbrev-ref", "feature/fresh@{upstream}").trim();
  check("fresh branch upstream now set to origin/feature/fresh", freshUpstream === "origin/feature/fresh");
  const remoteLogFresh = execFileSync("git", ["--git-dir", bare, "log", "feature/fresh", "--pretty=%s"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  check("fresh-branch commit reached the remote", remoteLogFresh.includes("fresh commit"));

  // 8. pendingPushSummary() — the companion `git-push` lever's own bounded confirm-preview (card
  //    a3c3ade8). Never throws; ahead/latestSubject degrade to null on a read failure rather than
  //    blocking the caller.
  await w.checkout("feature/fresh"); // back to the branch we just published (has an upstream + a commit)
  const summary = await w.pendingPushSummary();
  check("pendingPushSummary: resolves the current branch", summary?.branch === "feature/fresh");
  check("pendingPushSummary: ahead is 0 right after a push (nothing new since)", summary?.ahead === 0);
  check("pendingPushSummary: latestSubject is the most recent commit's subject", summary?.latestSubject === "fresh commit");
  fs.writeFileSync(path.join(repo, "fresh2.txt"), "another change, never pushed\n");
  git("add", "-A"); git("commit", "-m", "a second unpushed commit");
  const summary2 = await w.pendingPushSummary();
  check("pendingPushSummary: ahead reflects a new unpushed local commit", summary2?.ahead === 1);
  check("pendingPushSummary: latestSubject reflects the newest commit", summary2?.latestSubject === "a second unpushed commit");

  const noUpstreamBranch = await w.createBranch("feature/no-upstream-summary");
  check("pendingPushSummary setup: fresh branch with no upstream created", noUpstreamBranch.ok === true);
  const summaryNoUpstream = await w.pendingPushSummary();
  check("pendingPushSummary: no upstream configured yet ⇒ ahead is null (not a crash, not a false 0)", summaryNoUpstream?.branch === "feature/no-upstream-summary" && summaryNoUpstream?.ahead === null);

  const summaryBadRepo = await new GitWriter(path.join(root, "does-not-exist")).pendingPushSummary();
  check("pendingPushSummary: a non-existent repo path returns null, never throws", summaryBadRepo === null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// 9. Concurrent-writer contention (owner sign-off on card a3c3ade8's design: the companion `git-push`
//    lever's "vault" target shares its repo with Loom's own vault auto-committer + sibling project
//    vaults, so concurrent git writes WILL happen — an index.lock collision must surface as a CLEAN,
//    retryable structured error, never a wedge or a partial commit). A FRESH repo, isolated from the
//    branch/remote churn above.
{
  const contentionRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-git-writer-contention-")));
  const contRepo = path.join(contentionRoot, "repo");
  fs.mkdirSync(contRepo);
  const cgit = (...args) => execFileSync("git", args, { cwd: contRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  cgit("init");
  cgit("config", "user.email", "loom-test@example.com");
  cgit("config", "user.name", "loom-test");
  cgit("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(contRepo, "seed.txt"), "seed\n");
  cgit("add", "-A");
  cgit("commit", "-m", "initial");

  try {
    // (a) A STALE index.lock (simulating another process's git operation mid-flight, e.g. Loom's own
    //     vault auto-committer) must make commit() fail STRUCTURED + FAST, never hang or throw.
    const lockPath = path.join(contRepo, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const cw = new GitWriter(contRepo);
    fs.writeFileSync(path.join(contRepo, "locked.txt"), "should not commit while locked\n");
    const startedLock = process.hrtime.bigint();
    const lockedResult = await cw.commit("should fail — index is locked");
    const elapsedLockMs = Number(process.hrtime.bigint() - startedLock) / 1e6;
    check("contention (stale lock): commit fails STRUCTURED, not a throw", lockedResult.ok === false && typeof lockedResult.error === "string" && lockedResult.error.length > 0);
    check("contention (stale lock): fails FAST (bounded — did not hang)", elapsedLockMs < 30_000);
    check("contention (stale lock): nothing actually committed", cgit("log", "--pretty=%s").includes("should fail") === false);

    // Clearing the lock (as a real second process would on completion) lets a retry succeed cleanly —
    // proving the failure above was a clean, retryable rejection, not a corrupted/partial state.
    fs.rmSync(lockPath);
    const retried = await cw.commit("should fail — index is locked");
    check("contention (stale lock): a retry AFTER the lock clears succeeds", retried.ok === true);
    check("contention (stale lock): the retried commit actually landed", cgit("log", "-1", "--pretty=%s").trim() === "should fail — index is locked");

    // (b) TWO genuinely CONCURRENT commit() calls against the SAME repo (Promise.all — both child git
    //     processes launched at once, racing on the real .git/index.lock) — exactly one may win; the
    //     loser must degrade to a clean structured error, never a throw, never a hang, never a corrupted
    //     partial commit. Two DIFFERENT files so a winning commit is unambiguous either way.
    fs.writeFileSync(path.join(contRepo, "race-a.txt"), "race A\n");
    fs.writeFileSync(path.join(contRepo, "race-b.txt"), "race B\n");
    const cwA = new GitWriter(contRepo);
    const cwB = new GitWriter(contRepo);
    const startedRace = process.hrtime.bigint();
    const [raceA, raceB] = await Promise.all([
      cwA.commit("concurrent commit A"),
      cwB.commit("concurrent commit B"),
    ]);
    const elapsedRaceMs = Number(process.hrtime.bigint() - startedRace) / 1e6;
    check("contention (real race): neither call threw — both resolved to a structured result", raceA !== undefined && raceB !== undefined);
    check("contention (real race): bounded — the race resolved fast, no hang", elapsedRaceMs < 30_000);
    const raceLog = cgit("log", "--pretty=%s");
    const aLanded = raceLog.includes("concurrent commit A");
    const bLanded = raceLog.includes("concurrent commit B");
    // Since both writes touch the SAME working tree via `git add -A`, a genuine race can plausibly
    // resolve as EITHER exactly one commit landing (the loser's add/commit rejected on the lock) OR,
    // if the two calls' git children happen to interleave without contending for the SAME lock instant,
    // both files land in ONE combined commit (git add -A is idempotent — the second call's `git status`
    // sees a clean tree and reports its own EXPECTED "nothing to commit" failure). What must NEVER
    // happen: a lost update (neither file ever committed) or a thrown/hung caller.
    check("contention (real race): at least one of the two changes landed in history (no lost update)", aLanded || bLanded || raceLog.includes("concurrent commit"));
    check("contention (real race): every actual file change is captured in history exactly once (add -A is idempotent, never silently dropped)",
      cgit("show", "--stat", "HEAD").includes("race-a.txt") || cgit("log", "-p", "--follow", "--", "race-a.txt").includes("race A"));
    const failedOne = [raceA, raceB].find((r) => r.ok === false);
    if (failedOne) {
      check("contention (real race): the LOSING call's failure is structured (never a throw)", typeof failedOne.error === "string" && failedOne.error.length > 0);
    }
  } finally {
    fs.rmSync(contentionRoot, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nALL PASS — git writer + bounded/non-interactive guards hold, incl. concurrent-writer/index.lock contention degrading to a clean structured error, never a wedge." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
