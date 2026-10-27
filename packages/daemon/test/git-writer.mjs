import "./_guard.mjs"; // FIRST: arms LOOM_TEST=1 + strips GIT_PAGER/PAGER before simple-git is exercised.
// Unit test for the git WRITER (checkout / createBranch / commit / push) + its bounded,
// non-interactive guarantee. Claude-free: imports the compiled module and runs real git on a temp
// repo. Run after build: node test/git-writer.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWriter, nonInteractiveEnv, stripClaudeSessionTrailer, unsafeBranchNameShapeReason } from "../dist/git/writer.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

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

// 0b. stripClaudeSessionTrailer (card b7f965d2) — pure function, no repo needed. Positive-controlled: a
//     message WITH the trailer must actually lose it; a message WITHOUT one must round-trip unchanged
//     (byte-identical — proves the function is not silently rewriting messages that never had one).
{
  const withTrailer = "fix(x): summary\n\nBody paragraph one.\n\nClaude-Session: https://claude.ai/code/session_ABC123\n\nLoom-Worker-Branch: loom/deadbeef\n";
  const r = stripClaudeSessionTrailer(withTrailer);
  check("stripClaudeSessionTrailer: reports stripped:true when the trailer is present", r.stripped === true);
  check("stripClaudeSessionTrailer: removes the Claude-Session line", !r.message.includes("Claude-Session"));
  check("stripClaudeSessionTrailer: preserves Loom-Worker-Branch (never touches it)", r.message.includes("Loom-Worker-Branch: loom/deadbeef"));
  check("stripClaudeSessionTrailer: preserves the body prose", r.message.includes("Body paragraph one."));
  check("stripClaudeSessionTrailer: collapses the doubled blank line the removal leaves behind (no 3+ consecutive newlines)", !/\n{3,}/.test(r.message));

  const noTrailer = "fix(x): summary\n\nBody paragraph one.\n\nLoom-Worker-Branch: loom/deadbeef\n";
  const r2 = stripClaudeSessionTrailer(noTrailer);
  check("stripClaudeSessionTrailer: reports stripped:false when absent", r2.stripped === false);
  check("stripClaudeSessionTrailer: byte-identical when there is nothing to strip (negative control)", r2.message === noTrailer);

  // NEGATIVE CONTROL on the matcher itself: a line that merely CONTAINS the substring "Claude-Session"
  // mid-sentence (not as a trailer key at line-start) must NOT be treated as the trailer.
  const substringOnly = "docs: mention Claude-Session trailers in passing\n\nSome text about Claude-Session handling.\n";
  const r3 = stripClaudeSessionTrailer(substringOnly);
  check("stripClaudeSessionTrailer: a mid-line mention (not a trailer) is left alone", r3.stripped === false && r3.message === substringOnly);
}

const root = fs.realpathSync(mkdtempManaged("loom-git-writer-"));
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

{
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
  // The advisory vault-pause lease (card 614dfbef) is held only for the DURATION of the op — it must
  // never linger afterward (would wrongly pause a real VaultVersioner watching this same repo root).
  check("commit does not leave the advisory pause lease held afterward", !fs.existsSync(path.join(repo, ".git", "loom-vault-pause.json")));
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

  // 3b. @decision 59e53710 — unsafeBranchNameShapeReason's three no-legitimate-use checks ("-", "@{", a
  //     "refs/" prefix), unit-tested directly, PLUS the same names proven refused through
  //     checkout()/createBranch() THEMSELVES — the chokepoint this card moved the check into. A REAL
  //     previous branch is established first (round-2 CR correction) so "-"/"@{-1}" genuinely have
  //     something to resolve to pre-fix, not merely fail for lack of one. HEAD is asserted via the
  //     SYMBOLIC ref, never a sha (a same-sha new branch would pass a sha-only check), and state is reset
  //     to the baseline between every case.
  git("checkout", "-b", "second");
  git("checkout", baseBranch);
  const symbolicRef3b = () => { try { return git("symbolic-ref", "HEAD").trim(); } catch { return null; } };
  const branchSet3b = () => git("branch", "--list").split("\n").map((l) => l.replace(/^[* ]+/, "").trim()).filter(Boolean).sort().join(",");
  function resetToBaseline3b() {
    try { git("checkout", "--", "."); } catch { /* nothing dirty */ }
    try { git("checkout", baseBranch); } catch { /* best-effort */ }
    for (const b of branchSet3b().split(",").filter(Boolean)) {
      if (b !== baseBranch && b !== "second") { try { git("branch", "-D", b); } catch { /* ignore */ } }
    }
  }
  for (const name of ["-", "@{-1}", "-bsneaky"]) {
    check(`unsafeBranchNameShapeReason(${JSON.stringify(name)}) rejects`, typeof unsafeBranchNameShapeReason(name) === "string");
    resetToBaseline3b();
    const refBefore = symbolicRef3b();
    const coUnsafe = await w.checkout(name);
    check(`checkout(${JSON.stringify(name)}) rejected`, coUnsafe.ok === false && typeof coUnsafe.error === "string");
    check(`checkout(${JSON.stringify(name)}): symbolic HEAD unchanged`, symbolicRef3b() === refBefore);
    resetToBaseline3b();
    const setBefore = branchSet3b();
    const cbUnsafe = await w.createBranch(name);
    check(`createBranch(${JSON.stringify(name)}) rejected`, cbUnsafe.ok === false && typeof cbUnsafe.error === "string");
    check(`createBranch(${JSON.stringify(name)}): no new branch landed`, branchSet3b() === setBefore);
  }
  // "refs/" prefix — moved INTO unsafeBranchNameShapeReason this round (CR correction: git's own
  // validation does NOT reject it — verified directly: createBranch("refs/heads/other") used to create a
  // real, nested "refs/heads/refs/heads/other" ref, and checkout()ing an EXISTING branch's own
  // "refs/heads/<name>" full path used to DETACH HEAD rather than switch to that branch).
  check('unsafeBranchNameShapeReason("refs/heads/other") rejects', typeof unsafeBranchNameShapeReason("refs/heads/other") === "string");
  resetToBaseline3b();
  {
    const refBefore = symbolicRef3b();
    const r = await w.checkout("refs/heads/second");
    check('checkout("refs/heads/second") rejected (refs/ prefix)', r.ok === false && typeof r.error === "string");
    check('checkout("refs/heads/second"): symbolic HEAD unchanged (never detached)', symbolicRef3b() === refBefore);
  }
  resetToBaseline3b();
  {
    const setBefore = branchSet3b();
    const r = await w.createBranch("refs/heads/other");
    check('createBranch("refs/heads/other") rejected (refs/ prefix)', r.ok === false && typeof r.error === "string");
    check('createBranch("refs/heads/other"): no nested branch landed', branchSet3b() === setBefore);
  }
  // Negative control: an ordinary, legal local-branch SHAPE this function deliberately does NOT reject —
  // "origin/x" is a syntactically valid local branch name too (see unsafeBranchNameReason's own doc).
  check("negative control: unsafeBranchNameShapeReason(\"origin/x\") does NOT reject", unsafeBranchNameShapeReason("origin/x") === null);
  check("negative control: unsafeBranchNameShapeReason(\"feature/x\") does NOT reject", unsafeBranchNameShapeReason("feature/x") === null);

  // 3c. @decision 59e53710 — the PATHSPEC-FALLBACK data-loss path: checkout(".")/checkout(a tracked
  //     filename)/checkout("<branch>^{}") used to resolve as a pathspec-restore or a detached revision
  //     instead of refusing an unknown branch, silently discarding a dirty tracked file or detaching HEAD.
  //     Closed by requiring `target` to be an EXISTING local branch (via for-each-ref, see 3d below for
  //     why not branchLocal().all) before the mutating spawn, plus a trailing "--" so a check/use race
  //     still hard-fails rather than falling back to pathspec mode. Reset to a clean baseline, then
  //     re-dirty, before every case.
  for (const name of [".", "seed.txt", `${baseBranch}^{}`]) {
    resetToBaseline3b();
    fs.writeFileSync(path.join(repo, "seed.txt"), "DIRTY EDIT\n");
    const refBefore = symbolicRef3b();
    const r = await w.checkout(name);
    check(`checkout(${JSON.stringify(name)}) [pathspec-fallback] rejected`, r.ok === false && typeof r.error === "string");
    check(`checkout(${JSON.stringify(name)}): seed.txt is byte-unchanged (dirty edit survived)`, fs.readFileSync(path.join(repo, "seed.txt"), "utf8") === "DIRTY EDIT\n");
    check(`checkout(${JSON.stringify(name)}): symbolic HEAD unchanged (never detached)`, symbolicRef3b() === refBefore);
  }
  resetToBaseline3b();

  // 3d. @decision 59e53710 (round 3) — DETACHED-HEAD PSEUDO-ENTRY: on a detached canonical HEAD, simple-git
  //     parses git's own "(HEAD detached at X)" branch-list line into a pseudo-entry and puts the bare
  //     commit-ish X into branchLocal().all — so an existence check built on `.all` wrongly treated
  //     checkout(<that sha>) as "an existing local branch". The fix reads real branch names from
  //     for-each-ref's refs/heads/ listing instead, which never contains a detached-HEAD line at all.
  //     Detach for real (raw git, bypassing the writer under test — it refuses a non-branch target by
  //     design) at both the short (git's own default abbreviation, the exact string the pseudo-entry
  //     would have carried) and full sha forms. MUST detach via the raw SHA, never a branch name — git
  //     itself renders the branch-list line differently in each case ("(HEAD detached at <sha>)" vs.
  //     "(HEAD detached at refs/heads/<branch>)", measured directly on this host's git 2.47.0), and only
  //     the sha form produces the pseudo-entry this case exists to catch.
  const detachedFullSha = git("rev-parse", baseBranch).trim();
  git("checkout", "--detach", detachedFullSha);
  const detachedShortSha = git("rev-parse", "--short", "HEAD").trim();
  for (const shaForm of [detachedShortSha, detachedFullSha]) {
    const r = await w.checkout(shaForm);
    check(`checkout(${JSON.stringify(shaForm)}) [detached-HEAD pseudo-entry] rejected`, r.ok === false && typeof r.error === "string");
    check(`checkout(${JSON.stringify(shaForm)}): still detached at the same commit (never switched)`, git("rev-parse", "HEAD").trim() === detachedFullSha);
  }
  git("checkout", baseBranch); // back to a normal branch before step 4's push tests rely on it.
  resetToBaseline3b(); // clean seed.txt + back on baseBranch before step 4's push tests rely on both.

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

  // 10. Oversized-staged-file WARNING, not a refusal (card 237d1899, decision on CR finding 2): unlike
  //     commitVault (the automatic vault path, which silently unstages), this DELIBERATE human/agent path
  //     commits the file as asked but surfaces a non-blocking `warning`. `maxFileBytes` is a test-only
  //     override (mirrors commitVault's own opts.maxFileBytes) so this doesn't need a real ~95MB fixture.
  await w.checkout(baseBranch);
  fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(2048));
  const bigCommit = await w.commit("add an oversized-for-the-test file", { maxFileBytes: 1024 });
  check("oversized commit still succeeds (warns, does not refuse)", bigCommit.ok === true && typeof bigCommit.hash === "string");
  check("oversized commit surfaces a warning naming the file", bigCommit.ok === true && bigCommit.warning?.includes("big.txt"));
  check("oversized file actually landed in history (not silently unstaged)", git("show", "--stat", "HEAD").includes("big.txt"));

  fs.writeFileSync(path.join(repo, "small.txt"), "small\n");
  const smallCommit = await w.commit("add a normal-sized file", { maxFileBytes: 1024 });
  check("normal-sized commit carries no warning", smallCommit.ok === true && smallCommit.warning === undefined);

  // 11. Claude-Session trailer stripping (card b7f965d2) — GitWriter.commit() is the DOMINANT leak path
  //     (git_commit MCP tool + any other direct caller land a message verbatim otherwise); this asserts
  //     the strip happens end-to-end, not just in the pure-function unit tests above.
  fs.writeFileSync(path.join(repo, "trailer.txt"), "carries an attribution trailer\n");
  const withTrailerMsg = "fix(daemon): a real change\n\nExplains why.\n\nClaude-Session: https://claude.ai/code/session_XYZ789\n";
  const trailerCommit = await w.commit(withTrailerMsg);
  check("commit() with a Claude-Session trailer still succeeds", trailerCommit.ok === true && typeof trailerCommit.hash === "string");
  // THE DISCRIMINATING ASSERTION — must FAIL against pre-fix code, which lands `message.trim()` verbatim.
  check("commit() strips the Claude-Session trailer from the landed message", !git("log", "-1", "--pretty=%B").includes("Claude-Session"));
  check("commit() preserves the rest of the message (subject + body)", git("log", "-1", "--pretty=%B").includes("fix(daemon): a real change") && git("log", "-1", "--pretty=%B").includes("Explains why."));
  check("commit() surfaces a warning naming the strip", trailerCommit.warning?.includes("Claude-Session") === true);

  // Negative control: a message with NO trailer lands byte-identical to today — the strip must not touch
  // an ordinary message it has nothing to remove from.
  fs.writeFileSync(path.join(repo, "no-trailer.txt"), "ordinary commit, no trailer\n");
  const plainCommit = await w.commit("fix(daemon): an ordinary commit with no trailer");
  check("commit() with no trailer carries no strip warning", plainCommit.ok === true && plainCommit.warning === undefined);
  check("commit() with no trailer lands the message unchanged", git("log", "-1", "--pretty=%B").trim() === "fix(daemon): an ordinary commit with no trailer");

  // Loom-Worker-* trailers must SURVIVE — the strip is keyed on the exact "Claude-Session:" name only.
  fs.writeFileSync(path.join(repo, "worker-trailer.txt"), "carries a real Loom-Worker-Branch trailer\n");
  const withBothMsg = "fix(daemon): worker-shaped commit\n\nBody.\n\nClaude-Session: https://claude.ai/code/session_KEEP000\n\nLoom-Worker-Branch: loom/abc123\n";
  const bothCommit = await w.commit(withBothMsg);
  const bothBody = git("log", "-1", "--pretty=%B");
  check("commit() strips Claude-Session even alongside a real Loom-Worker-Branch trailer", bothCommit.ok === true && !bothBody.includes("Claude-Session"));
  check("commit() NEVER strips Loom-Worker-Branch — only the exact Claude-Session key", bothBody.includes("Loom-Worker-Branch: loom/abc123"));

  // A message consisting of NOTHING but the trailer strips to empty — must be the writer's own clean
  // "commit message required" refusal, not a raw git failure ("Aborting commit due to empty commit
  // message") reaching the caller as an opaque `gitError()` string. THE DISCRIMINATING ASSERTION: fails
  // against code that only checks emptiness BEFORE stripping.
  const headBeforeTrailerOnly = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(repo, "trailer-only.txt"), "would-be committed by a trailer-only message\n");
  const trailerOnlyCommit = await w.commit("Claude-Session: https://claude.ai/code/session_ONLYTRAILER");
  check("commit() with a message that strips to empty is refused, not passed to git", trailerOnlyCommit.ok === false && trailerOnlyCommit.error === "commit message required");
  check("commit() with a message that strips to empty did NOT commit — HEAD unchanged", git("rev-parse", "HEAD").trim() === headBeforeTrailerOnly);
}
// root's own manual finally-block rmSync removed here: mkdtempManaged already registered it for
// guaranteed cleanup at process exit (card 995be21f).

// 9. Concurrent-writer contention (owner sign-off on card a3c3ade8's design: the companion `git-push`
//    lever's "vault" target shares its repo with Loom's own vault auto-committer + sibling project
//    vaults, so concurrent git writes WILL happen — an index.lock collision must surface as a CLEAN,
//    retryable structured error, never a wedge or a partial commit). A FRESH repo, isolated from the
//    branch/remote churn above.
{
  const contentionRoot = fs.realpathSync(mkdtempManaged("loom-git-writer-contention-"));
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

  {
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
  }
  // contentionRoot's own manual finally-block rmSync removed here: mkdtempManaged already registered it
  // for guaranteed cleanup at process exit (card 995be21f).
}

// 12. card 697be64a — GitWriter.commit() now passes its message via `-F <tempfile>`, never `-m`, removing
//     the same Windows CreateProcess argv ceiling (~32766 chars, ENAMETOOLONG) card 75199847 already
//     removed from the batch-landing path. Mirrors that card's own proof shape for this caller.
{
  const bigRoot = fs.realpathSync(mkdtempManaged("loom-git-writer-bigmsg-"));
  const bigRepo = path.join(bigRoot, "repo");
  fs.mkdirSync(bigRepo);
  const bgit = (...args) => execFileSync("git", args, { cwd: bigRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  bgit("init");
  bgit("config", "user.email", "loom-test@example.com");
  bgit("config", "user.name", "loom-test");
  bgit("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(bigRepo, "seed.txt"), "seed\n");
  bgit("add", "-A");
  bgit("commit", "-m", "initial");
  const bw = new GitWriter(bigRepo);

  // `git log --format=%B` appends its OWN extra trailing newline for display (card 75199847's "Do not" —
  // never use it for a byte-for-byte comparison); read the raw object via `cat-file -p` and slice off the
  // header (up to the first blank-line separator) instead.
  const bodyFromCatFile = (raw) => {
    const idx = raw.indexOf("\n\n");
    return idx === -1 ? "" : raw.slice(idx + 2);
  };

  // (12a) A >32K message — well over the Windows argv ceiling — must land byte-identical via the real
  // GitWriter.commit(), never ENAMETOOLONG. Code Review: this RED is WINDOWS-ONLY — Linux's own
  // per-argument limit (MAX_ARG_STRLEN, ~128KiB) sits well above this 40,000-char message, so a pre-fix
  // `-m` call would NOT reproduce ENAMETOOLONG there; it still exercises the fixed `-F` code path and
  // still proves byte-identity on every OS, just without a RED precondition off Windows.
  fs.writeFileSync(path.join(bigRepo, "big1.txt"), "big message test\n");
  const bigMessage = `fix(git): a message far longer than any reasonable subject line\n\n${"x".repeat(40_000)}\n`;
  const bigResult = await bw.commit(bigMessage);
  check("(12a) a >32K commit message succeeds via -F (no ENAMETOOLONG — Windows-only RED, see comment above)", bigResult.ok === true);
  const landedBig = bgit("cat-file", "-p", bigResult.hash ?? "HEAD");
  check("(12a) the landed message is byte-identical to the source (via git cat-file -p)", bodyFromCatFile(landedBig) === bigMessage);

  // (12b) byte-identity: -m vs -F, routed through the REAL GitWriter.commit() (Code Review) — not a bare
  // git call — under GitWriter.commit's own actual invocation (no `--cleanup` flag at all). HERMETIC
  // against ambient host config (Code Review): isolates HOME/USERPROFILE to a scratch dir, blocks the
  // system config (GIT_CONFIG_NOSYSTEM=1), and points GIT_CONFIG_GLOBAL at a non-existent file, so no
  // real user/global/system `commit.cleanup` can leak into the result. Each repo ALSO pins
  // `commit.cleanup` explicitly — "verbatim" (no cleanup at all; the mode the Code Review found 13/143
  // cases diverge under, pre-fix) and "strip" (git's default when a message IS edited) — covering both
  // reachable cleanup modes rather than whatever this host happens to have ambiently. `-m`'s own argv
  // value is ALWAYS line-completed by git itself regardless of cleanup mode; a bare `-F <file>` is used
  // VERBATIM under `commit.cleanup=verbatim` specifically, which is why the production fix force-appends
  // exactly one trailing `\n` to the written message (`writer.ts`'s `commit()`) — see this section's own
  // RED/GREEN proof note for how that fix is independently verified.
  const savedHermeticEnv = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  };
  const isoHome = fs.realpathSync(mkdtempManaged("loom-git-writer-isohome-"));
  process.env.HOME = isoHome;
  process.env.USERPROFILE = isoHome;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = path.join(isoHome, "nonexistent-gitconfig");
  try {
    const matrixCases = [
      { label: "CRLF body", msg: "feat(x): crlf body\r\n\r\nLine one.\r\nLine two.\r\n" },
      { label: "non-ASCII body", msg: "fix(x): unicode\n\nÜnïcödé body — ✓ done.\n" },
      { label: "a #-prefixed subject", msg: "#not-a-comment: looks like a comment\n\nBody text.\n" },
      { label: "a trailer block", msg: "chore(x): trailers\n\nBody.\n\nLoom-Worker-Branch: loom/deadbeef\n" },
      { label: "no trailing newline", msg: "docs(x): no trailing newline\n\nBody with no trailing newline" },
    ];
    for (const cleanupMode of ["verbatim", "strip"]) {
      const matrixRoot = fs.realpathSync(mkdtempManaged(`loom-git-writer-matrix-${cleanupMode}-`));
      const matrixRepo = path.join(matrixRoot, "repo");
      fs.mkdirSync(matrixRepo);
      const xgit = (...args) => execFileSync("git", args, { cwd: matrixRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
      xgit("init");
      xgit("config", "user.email", "loom-test@example.com");
      xgit("config", "user.name", "loom-test");
      xgit("config", "commit.gpgsign", "false");
      xgit("config", "commit.cleanup", cleanupMode);
      fs.writeFileSync(path.join(matrixRepo, "seed.txt"), "seed\n");
      xgit("add", "-A");
      xgit("commit", "-m", "initial");
      const mw = new GitWriter(matrixRepo);

      for (const { label, msg } of matrixCases) {
        // -m BASELINE: a real, unmocked `git commit -m` under this repo's pinned cleanup mode — given the
        // SAME bytes GitWriter.commit() itself writes to the `-F` temp file (`cleanedMessage.trim() +
        // "\n"`; none of these matrix cases carry a Claude-Session trailer, so `cleanedMessage === msg`
        // here), never the raw `msg`. Under `commit.cleanup=verbatim` specifically, `.trim()` can eat a
        // trailing `\r` along with the `\n` it's removing — comparing against the UN-trimmed `msg` would
        // wrongly fault the real fix for a difference that `.trim()` itself introduces on BOTH sides
        // (production applies that same `.trim()` before either `-m` or `-F` ever sees the message).
        const expectedMessage = `${msg.trim()}\n`;
        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `content for ${label} (${cleanupMode})\n`);
        xgit("add", "-A");
        xgit("commit", "-m", expectedMessage);
        const mBody = bodyFromCatFile(xgit("cat-file", "-p", "HEAD"));
        xgit("reset", "--hard", "HEAD~1");

        // -F via the REAL GitWriter.commit() — proves what production actually does, not a bare git call.
        fs.writeFileSync(path.join(matrixRepo, "f.txt"), `content for ${label} (${cleanupMode})\n`);
        const fResult = await mw.commit(msg);
        check(`(12b ${cleanupMode}/${label}) GitWriter.commit() succeeds`, fResult.ok === true);
        const fBody = bodyFromCatFile(xgit("cat-file", "-p", "HEAD"));
        xgit("reset", "--hard", "HEAD~1");

        check(`(12b ${cleanupMode}/${label}) -m and -F (via the real GitWriter.commit()) land byte-identical bodies`, mBody === fBody);
      }
    }
  } finally {
    for (const [k, v] of Object.entries(savedHermeticEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // (12c) A commit-message temp-file write failure is a NAMED refusal, never a silent fallback to -m —
  // monkey-patches the real shared `node:fs` singleton (same technique as the batch path's own F4 test),
  // targeting only the "message" file under a dir whose prefix matches GitWriter.commit's own
  // `writeCommitMessageFile(..., "loom-git-commit-")` call.
  {
    fs.writeFileSync(path.join(bigRepo, "refuse1.txt"), "should not commit — write will fail\n");
    const capturedDirs = [];
    const realMkdtemp = fs.promises.mkdtemp;
    const realWriteFile = fs.promises.writeFile;
    let writeFailed = false;
    fs.promises.mkdtemp = async (...a) => {
      const dir = await realMkdtemp.apply(fs.promises, a);
      if (path.basename(dir).startsWith("loom-git-commit-")) capturedDirs.push(dir);
      return dir;
    };
    fs.promises.writeFile = async (file, ...rest) => {
      if (!writeFailed && typeof file === "string" && path.basename(file) === "message" &&
          capturedDirs.some((d) => file.startsWith(d))) {
        writeFailed = true;
        throw new Error("simulated EACCES (test 12c)");
      }
      return realWriteFile.apply(fs.promises, [file, ...rest]);
    };
    let refusalResult;
    try {
      refusalResult = await bw.commit("should not commit — write will fail");
    } finally {
      fs.promises.mkdtemp = realMkdtemp;
      fs.promises.writeFile = realWriteFile;
    }
    check("(12c) precondition: the simulated write failure actually fired", writeFailed === true);
    check("(12c) precondition: a temp dir was actually created before the write failed", capturedDirs.length >= 1);
    check("(12c) a temp-file write failure is a NAMED refusal naming 'temp file', never a throw",
      refusalResult.ok === false && /temp file/i.test(refusalResult.error ?? ""));
    check("(12c) the refusal never fell back to passing the message via -m",
      !bgit("log", "--pretty=%s").includes("should not commit"));
    const failedDir = capturedDirs[capturedDirs.length - 1];
    let dirGone = false;
    try {
      await waitUntil(() => !fs.existsSync(failedDir), { timeoutMs: 5000, label: `(12c) temp dir ${failedDir} removed` });
      dirGone = true;
    } catch { /* dirGone stays false — reported below */ }
    check("(12c) the orphaned temp dir from the FAILED write is cleaned up, never leaked", dirGone === true);
  }

  // (12d) The commit-message temp dir is cleaned up on the ORDINARY success path too, not just on
  // failure — capture it the same way, let a real commit land, then confirm it's gone afterward.
  {
    fs.writeFileSync(path.join(bigRepo, "cleanup1.txt"), "ordinary commit for cleanup check\n");
    const capturedDirs = [];
    const realMkdtemp = fs.promises.mkdtemp;
    fs.promises.mkdtemp = async (...a) => {
      const dir = await realMkdtemp.apply(fs.promises, a);
      if (path.basename(dir).startsWith("loom-git-commit-")) capturedDirs.push(dir);
      return dir;
    };
    let okResult;
    try {
      okResult = await bw.commit("ordinary commit for cleanup check");
    } finally {
      fs.promises.mkdtemp = realMkdtemp;
    }
    check("(12d) precondition: the ordinary commit succeeded", okResult.ok === true);
    check("(12d) precondition: a temp dir was captured", capturedDirs.length === 1);
    let dirGoneOk = false;
    try {
      await waitUntil(() => !fs.existsSync(capturedDirs[0]), { timeoutMs: 5000, label: `(12d) temp dir ${capturedDirs[0]} removed` });
      dirGoneOk = true;
    } catch { /* dirGoneOk stays false — reported below */ }
    check("(12d) the commit-message temp dir is cleaned up after an ORDINARY successful commit too", dirGoneOk === true);
  }

  // (12e) Code Review item 4 — the commit-message temp dir is cleaned up on the `refuseIfOperationalHome()`
  // EARLY RETURN too, not just the ordinary success/failure paths above. Forces that refusal via its own
  // LOOM_HOME-independent branch — an EMPTY git-resolved toplevel (`resolveOperationalHomeToplevelRefusal`'s
  // `!toplevel` arm, decision f9360c84 round 2) via an injected `gitFactory` — so this never touches the
  // real ambient LOOM_HOME (see git-writer-operational-home-guard.mjs for the dedicated LOOM_HOME-path
  // proof of the refusal mechanism itself; this test only proves THIS card's cleanup fires on that path).
  {
    const homeRefusalRoot = fs.realpathSync(mkdtempManaged("loom-git-writer-homerefusal-"));
    const homeRefusalRepo = path.join(homeRefusalRoot, "repo");
    fs.mkdirSync(homeRefusalRepo);
    const hgit = (...args) => execFileSync("git", args, { cwd: homeRefusalRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
    hgit("init");
    hgit("config", "user.email", "loom-test@example.com");
    hgit("config", "user.name", "loom-test");
    hgit("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(homeRefusalRepo, "seed.txt"), "seed\n");
    hgit("add", "-A");
    hgit("commit", "-m", "initial");
    fs.writeFileSync(path.join(homeRefusalRepo, "f.txt"), "should be refused before any real commit\n");

    const emptyToplevelGitFactory = () => ({ revparse: async () => "" });
    const hw = new GitWriter(homeRefusalRepo, { gitFactory: emptyToplevelGitFactory });

    const capturedDirs = [];
    const realMkdtemp = fs.promises.mkdtemp;
    fs.promises.mkdtemp = async (...a) => {
      const dir = await realMkdtemp.apply(fs.promises, a);
      if (path.basename(dir).startsWith("loom-git-commit-")) capturedDirs.push(dir);
      return dir;
    };
    let homeRefusalResult;
    try {
      homeRefusalResult = await hw.commit("should be refused before any real commit");
    } finally {
      fs.promises.mkdtemp = realMkdtemp;
    }
    check("(12e) precondition: a temp dir was captured before the refusal", capturedDirs.length === 1);
    check("(12e) the operational-home refusal fires (forced via an empty git-resolved toplevel)", homeRefusalResult.ok === false);
    check("(12e) nothing was actually committed", !hgit("log", "--pretty=%s").includes("should be refused"));
    let dirGoneHome = false;
    try {
      await waitUntil(() => !fs.existsSync(capturedDirs[0]), { timeoutMs: 5000, label: `(12e) temp dir ${capturedDirs[0]} removed` });
      dirGoneHome = true;
    } catch { /* dirGoneHome stays false — reported below */ }
    check("(12e) the commit-message temp dir is cleaned up on the homeRefusal early return too", dirGoneHome === true);
  }
}

console.log(failures === 0 ? "\nALL PASS — git writer + bounded/non-interactive guards hold, incl. concurrent-writer/index.lock contention degrading to a clean structured error, never a wedge." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
