import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision abbda4f5 — don't shrink any section below to "just check it doesn't throw": each one's own
// malicious-vs-well-formed pair is load-bearing (the record's "Test coverage" section names what each
// proves). Real git, no claude/daemon.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worktree-add-and-log-argv-injection.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("wali-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
requireHermeticEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreesUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const writerUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "writer.js")).href;
const {
  createWorktree, resolveWorktreePath, taskKey,
  findLandedSquashCommit, findAllLandedTrailerCommits, getMergedCommitMapCached,
  __resetMergedCommitMapCacheForTest, __setUnsafeBranchNameShapeReasonForTest,
  classifyAgainstLedgerForTest,
} = await import(worktreesUrl);
const { unsafeBranchNameShapeReason } = await import(writerUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wali@loom -c user.name=wali";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function newRepo(name) {
  const repo = mkdtempManaged(`loom-wali-${name}-`);
  execSync(`git init -q -b master && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION 0 — pure git mechanism, no Loom code
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("mech");
    const olderSha = git(repo, "rev-parse HEAD"); // the FIRST commit (init)
    execSync(`git ${GIT_ID} commit -q -m second --allow-empty`, { cwd: repo });
    const headSha = git(repo, "rev-parse HEAD"); // the SECOND commit — current HEAD, deliberately != olderSha
    // `git branch -- --detach` itself refuses the name (check-ref-format) — only update-ref can create it.
    let branchRefused = false;
    try { git(repo, "branch -- --detach"); } catch { branchRefused = true; }
    check("(0a) PRECONDITION: `git branch -- --detach` refuses the name (check-ref-format)", branchRefused);
    execSync(`git update-ref refs/heads/--detach ${olderSha}`, { cwd: repo }); // the only way to create it
    check("(0a) PRECONDITION: olderSha (the --detach ref's own tip) != headSha (current HEAD)", olderSha !== headSha);

    // (a) worktree add: bare --detach detaches at CURRENT HEAD (the ref is never consulted at all).
    const wtBare = mkdtempManaged("loom-wali-wt-bare-"); // git worktree add tolerates an existing EMPTY dir
    execSync(`git worktree add "${wtBare}" --detach`, { cwd: repo });
    check("(0a) MECHANISM: bare `worktree add <path> --detach` detaches at CURRENT HEAD, not the " +
      "refs/heads/--detach ref's own tip — the ref is never even consulted",
      git(wtBare, "rev-parse HEAD") === headSha);

    // (a) worktree add: --end-of-options does NOT close the shape — it changes WHICH commit you land on.
    // `--end-of-options` ends option parsing, so `--detach` resolves as a REVISION; since refs/heads/
    // --detach genuinely exists, it resolves to THAT ref's own (older) tip, not HEAD — but it still never
    // ATTACHES (a dash-prefixed name is not a syntactically valid branch for the attach path), so the
    // worktree still ends up detached, just at a caller-steerable commit. STRONGER than a bare "detached
    // HEAD" regex match (which passes under either mechanism) — this asserts WHICH commit it actually is.
    const wtGuard = mkdtempManaged("loom-wali-wt-guard-");
    execSync(`git worktree add "${wtGuard}" --end-of-options --detach`, { cwd: repo });
    check("(0a) MECHANISM: guarded `worktree add <path> --end-of-options --detach` detaches at the " +
      "refs/heads/--detach ref's OWN (older) tip, NOT current HEAD — --end-of-options changes WHICH " +
      "commit you land on, it never closes the vulnerability (still never attaches to the branch)",
      git(wtGuard, "rev-parse HEAD") === olderSha && git(wtGuard, "rev-parse HEAD") !== headSha);

    // (b) rev-parse: --end-of-options alone corrupts a WELL-FORMED ref's output; --verify fixes it.
    const bareGuarded = git(repo, "rev-parse --end-of-options master");
    check("(0b) MECHANISM: `rev-parse --end-of-options <ref>` ALONE echoes an extra literal line for a " +
      "well-formed ref (NOT a safe no-op) — confirms --verify is required, not optional",
      bareGuarded.split("\n").length === 2 && bareGuarded.split("\n")[0] === "--end-of-options");
    const verifiedGuarded = git(repo, "rev-parse --verify --end-of-options master");
    check("(0b) MECHANISM: `rev-parse --verify --end-of-options <ref>` resolves a well-formed ref to " +
      "exactly one line, byte-identical to the unguarded call",
      verifiedGuarded === git(repo, "rev-parse master"));
    let failedAll = false;
    try { git(repo, "rev-parse --verify --end-of-options --all"); } catch { failedAll = true; }
    check("(0b) MECHANISM: `rev-parse --verify --end-of-options --all` FAILS LOUDLY (the fixed shape) " +
      "rather than silently resolving every ref in the repo", failedAll);

    // (c) log <base> <flags>: base must move to the END, not stay in its natural first position.
    let brokenOrdinary = false;
    try { git(repo, `log --end-of-options master -F --grep=x --format=%H`); } catch { brokenOrdinary = true; }
    check("(0c) MECHANISM: `log --end-of-options <base> -F --grep... --format...` (base FIRST, the " +
      "unfixed call's natural order) BREAKS the ordinary case — it swallows the real flags that follow",
      brokenOrdinary);
    const reordered = git(repo, `log -F --grep=init --format=%H --end-of-options master`);
    check("(0c) MECHANISM: reordered `log -F --grep... --format... --end-of-options <base>` (base LAST) " +
      "resolves the well-formed base correctly", reordered === olderSha);
    let failedAllLog = false;
    try { git(repo, `log -F --grep=x --format=%H --end-of-options --all`); } catch { failedAllLog = true; }
    check("(0c) MECHANISM: the reordered shape FAILS LOUDLY for an option-shaped base (--all) instead of " +
      "silently scanning every ref's history", failedAllLog);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION V — unsafeBranchNameShapeReason itself (the function createWorktree's entry guard calls)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  for (const bad of ["--detach", "-x", "@{-1}", "refs/heads/x"]) {
    check(`(V) unsafeBranchNameShapeReason("${bad}") rejects it`, unsafeBranchNameShapeReason(bad) !== null);
  }
  check("(V) POSITIVE CONTROL: unsafeBranchNameShapeReason(\"loom/0123456789ab\") (the real shape) accepts it",
    unsafeBranchNameShapeReason("loom/0123456789ab") === null);

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION A — createWorktree's entry guard, dynamically exercised via the test-only seam
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repo = newRepo("entry");
    const proj = "wali-proj-entry";
    const taskId = "wali-task-entry";
    const branch = `loom/${taskKey(taskId)}`;
    const worktreePath = resolveWorktreePath(proj, taskId);

    __setUnsafeBranchNameShapeReasonForTest(() => "forced-unsafe-for-test (card abbda4f5)");
    let threw = null;
    try { await createWorktree(repo, proj, taskId); } catch (e) { threw = e; }
    __setUnsafeBranchNameShapeReasonForTest(); // restore the real function before any later assertion

    check("(A) createWorktree THROWS when the entry guard reports the branch unsafe (FAILS pre-fix: no " +
      "guard exists at all, so createWorktree proceeds straight to `worktree add` regardless)",
      threw instanceof Error && /refusing to cut a worktree/.test(threw.message));
    check("(A) no worktree directory was created before the guard refused",
      !fs.existsSync(worktreePath));
    check("(A) no branch was created in the repo before the guard refused",
      git(repo, "branch --list --format=%(refname:lstrip=2)").split("\n").map((s) => s.trim()).filter(Boolean)
        .every((b) => b !== branch));

    // POSITIVE CONTROL — the SAME taskId, guard restored to the real function: ordinary cut still works.
    const result = await createWorktree(repo, proj, taskId);
    check("(A) POSITIVE CONTROL: with the real guard restored, createWorktree succeeds normally",
      result.branch === branch && fs.existsSync(result.worktreePath));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Shared fixture for sections B/D/E/F — one repo, a genuine landed commit on master ("loom/legit"),
  // and a rogue commit on a non-branch ref invisible to master but visible to `--all` ("loom/victim").
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  const argvRepo = newRepo("argv");
  execSync(`git add -A && git ${GIT_ID} commit -q -m "chore: legit landing" --allow-empty ` +
    `--trailer "Loom-Worker-Branch: loom/legit"`, { cwd: argvRepo });
  const shaLegit = git(argvRepo, "rev-parse HEAD");

  execSync(`git checkout -q --orphan wali-rogue-tmp`, { cwd: argvRepo });
  fs.writeFileSync(path.join(argvRepo, "rogue.txt"), "rogue\n");
  execSync(`git add -A && git ${GIT_ID} commit -q -m "chore: rogue landing" ` +
    `--trailer "Loom-Worker-Branch: loom/victim"`, { cwd: argvRepo });
  const shaRogue = git(argvRepo, "rev-parse HEAD");
  execSync(`git update-ref refs/loom-rogue/x ${shaRogue}`, { cwd: argvRepo }); // pin it OUTSIDE refs/heads
  execSync(`git checkout -q master`, { cwd: argvRepo });
  execSync(`git branch -D wali-rogue-tmp`, { cwd: argvRepo }); // the rogue ref survives via refs/loom-rogue/x

  check("(PRECONDITION) neither loom/legit nor loom/victim is a real branch (both read as \"gone\")",
    git(argvRepo, "branch --list --format=%(refname:lstrip=2)").split("\n").map((s) => s.trim()).filter(Boolean)
      .every((b) => b !== "loom/legit" && b !== "loom/victim"));
  check("(PRECONDITION) `git log --all` still finds the rogue commit (the orphan ref keeps it reachable)",
    git(argvRepo, `log --all -F --grep="Loom-Worker-Branch: loom/victim" --format=%H`) === shaRogue);
  check("(PRECONDITION) `git log master` does NOT find the rogue commit (master's own history is clean)",
    git(argvRepo, `log master -F --grep="Loom-Worker-Branch: loom/victim" --format=%H`) === "");

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION B — findLandedSquashCommit
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const smuggled = await findLandedSquashCommit(argvRepo, "loom/victim", "--all", {});
    check("(B) findLandedSquashCommit(\"loom/victim\", base=\"--all\") does NOT surface the rogue commit " +
      "(FAILS pre-fix: `git log --all ...` succeeds and the rogue commit is wrongly reported as landed)",
      smuggled === null);
    const legit = await findLandedSquashCommit(argvRepo, "loom/legit", "master", {});
    check("(B) POSITIVE CONTROL: findLandedSquashCommit(\"loom/legit\", base=\"master\") still finds the " +
      "genuine landed commit, unaffected by the fix", legit === shaLegit);
    const noneOnMaster = await findLandedSquashCommit(argvRepo, "loom/victim", "master", {});
    check("(B) POSITIVE CONTROL: findLandedSquashCommit(\"loom/victim\", base=\"master\") correctly finds " +
      "NOTHING — the rogue commit is genuinely outside master's own history", noneOnMaster === null);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION D — findAllLandedTrailerCommits
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const smuggled = await findAllLandedTrailerCommits(argvRepo, "loom/victim", "--all", {});
    check("(D) findAllLandedTrailerCommits(\"loom/victim\", base=\"--all\") returns EMPTY (FAILS pre-fix: " +
      "would include the rogue commit, sourced from outside the intended base's history)",
      Array.isArray(smuggled) && smuggled.length === 0);
    const legit = await findAllLandedTrailerCommits(argvRepo, "loom/legit", "master", {});
    check("(D) POSITIVE CONTROL: findAllLandedTrailerCommits(\"loom/legit\", base=\"master\") still finds " +
      "the genuine landed commit", legit.length === 1 && legit[0].sha === shaLegit);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION E — getMergedCommitMapCached (scanMergedCommitMap)
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    __resetMergedCommitMapCacheForTest();
    const { map: smuggledMap, truncated: smuggledTruncated } = await getMergedCommitMapCached(argvRepo, "--all", {});
    check("(E) getMergedCommitMapCached(base=\"--all\") does NOT carry an entry for loom/victim (FAILS " +
      "pre-fix: the rogue commit would be scanned in and mapped)",
      !smuggledMap.has("loom/victim"));
    check("(E) getMergedCommitMapCached(base=\"--all\") reports truncated:true — the fail-safe EMPTY-map " +
      "path (the log call itself failed), not a scan that merely found nothing",
      smuggledTruncated === true);

    __resetMergedCommitMapCacheForTest();
    const { map: legitMap } = await getMergedCommitMapCached(argvRepo, "master", {});
    check("(E) POSITIVE CONTROL: getMergedCommitMapCached(base=\"master\") still maps loom/legit to the " +
      "genuine landed commit",
      (legitMap.get("loom/legit") ?? []).some((e) => e.sha === shaLegit));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SECTION F — classifyAgainstLedger's own rev-parse, tested DIRECTLY via classifyAgainstLedgerForTest.
  // Every PRODUCTION path into this function couples its `ref` to the SAME base/ref a preceding `git
  // log` call already uses (and that call fails first, via this card's own sibling fix — see the export's
  // own doc comment) — so this site has no public call path to exercise independently; call it directly.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { simpleGit } = await import("simple-git");
    const gitHandle = simpleGit(argvRepo);
    const fakeLedger = { maxRowId: () => 1, resolveBoundary: () => null, rowsByTips: () => [], scopeKey: "abbda4f5-test:primary" };
    const realWarn = console.warn;

    const captured = [];
    console.warn = (msg) => { captured.push(String(msg)); };
    let maliciousVerdict;
    try {
      maliciousVerdict = await classifyAgainstLedgerForTest(gitHandle, 15000, shaLegit, "--all", fakeLedger);
    } finally {
      console.warn = realWarn;
    }
    check("(F) classifyAgainstLedger(ref=\"--all\") returns \"error\" (FAILS pre-fix: bare `rev-parse " +
      "--all` succeeds silently instead of being rejected)", maliciousVerdict === "error");
    check("(F) ... and logs \"could not resolve ref\" explaining why",
      captured.some((m) => /could not resolve ref/i.test(m) && m.includes("--all")));

    const captured2 = [];
    console.warn = (msg) => { captured2.push(String(msg)); };
    let legitVerdict;
    try {
      legitVerdict = await classifyAgainstLedgerForTest(gitHandle, 15000, shaLegit, "master", fakeLedger);
    } finally {
      console.warn = realWarn;
    }
    check("(F) POSITIVE CONTROL: classifyAgainstLedger(ref=\"master\") resolves normally (\"skip\", since " +
      "this fake ledger's own resolveBoundary returns null) and never logs \"could not resolve ref\"",
      legitVerdict === "skip" && !captured2.some((m) => /could not resolve ref/i.test(m)));
  }
} finally {
  // mkdtempManaged's own exit hooks are the real backstop; this just lets a solo run print success/failure
  // without waiting for process exit to confirm cleanup actually happened.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree's entry branch-shape guard, and every `log`/`rev-parse` site's " +
    "argv fix, behave correctly for both a well-formed and an option-shaped base/ref/branch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
