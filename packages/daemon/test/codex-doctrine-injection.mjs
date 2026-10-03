import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 887e10b8 Item 1 (multi-harness epic df1f94b0, Phase 1) — hermetic coverage for
// pty/codex-doctrine.ts#injectCodexDoctrine and its git-hygiene helpers. Pure filesystem-transform logic,
// no pty/real spawn involved — a fake-pty/real-spawn test can't observe this any more precisely than
// direct file assertions can, so a hermetic unit test is the right-sized check here (mirrors
// codex-host-decisions.mjs's own "pure decision logic gets a hermetic test" posture). RECEPTION (does a
// real codex process actually READ this file) is a SEPARATE claim this test does NOT make — see
// test/codex-doctrine-real-spawn.mjs for that proof.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-injection.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { injectCodexDoctrine, isCodexDoctrinePath, CODEX_DOCTRINE_FILE } = await import("../dist/pty/codex-doctrine.js");

check("CODEX_DOCTRINE_FILE is the codex-native convention name", CODEX_DOCTRINE_FILE === "AGENTS.md");

// --- isCodexDoctrinePath: positive + negative control on the SAME predicate --------------------------
check("isCodexDoctrinePath('AGENTS.md') === true (positive control)", isCodexDoctrinePath("AGENTS.md") === true);
check("isCodexDoctrinePath is exact-match, not prefix-match — 'sub/AGENTS.md' is NOT the root file", isCodexDoctrinePath("sub/AGENTS.md") === false);
check("isCodexDoctrinePath('CLAUDE.md') === false (negative control — the predicate can discriminate, not just always-false)", isCodexDoctrinePath("CLAUDE.md") === false);

function makeFakeRepo(prefix) {
  const cwd = mkdtempManaged(prefix);
  fs.mkdirSync(path.join(cwd, ".git")); // a bare dir is enough — resolveGitCommonDirForDoctrine only stats it
  return cwd;
}

// --- non-worker role: never injects --------------------------------------------------------------------
{
  const cwd = makeFakeRepo("loom-codex-doctrine-norole-");
  injectCodexDoctrine(cwd, "manager");
  check("role !== 'worker' (manager) — no AGENTS.md written (Phase-1 scope limit)", !fs.existsSync(path.join(cwd, "AGENTS.md")));
  injectCodexDoctrine(cwd, null);
  check("role === null — no AGENTS.md written", !fs.existsSync(path.join(cwd, "AGENTS.md")));
  injectCodexDoctrine(cwd, undefined);
  check("role === undefined — no AGENTS.md written", !fs.existsSync(path.join(cwd, "AGENTS.md")));
}

// --- fresh worker spawn: creates AGENTS.md with the doctrine block + a stable, content-derived ID ------
let firstBlock = null;
{
  const cwd = makeFakeRepo("loom-codex-doctrine-fresh-");
  const target = path.join(cwd, "AGENTS.md");
  check("AGENTS.md absent before injection", !fs.existsSync(target));
  injectCodexDoctrine(cwd, "worker");
  check("AGENTS.md created for role='worker'", fs.existsSync(target));
  firstBlock = fs.readFileSync(target, "utf8");
  check("carries the managed-block BEGIN marker", firstBlock.startsWith("<!-- LOOM:CODEX-DOCTRINE:BEGIN"));
  check("carries the managed-block END marker", firstBlock.trimEnd().endsWith("<!-- LOOM:CODEX-DOCTRINE:END -->"));
  check("carries a LOOM-DOCTRINE-ID line (the real-spawn test's reception marker)", /LOOM-DOCTRINE-ID: [0-9a-f]{8}/.test(firstBlock));
  check("names the three load-bearing rules (targeted-test default, no-speculative-gate, escalate-up)",
    /[Tt]argeted-test default/.test(firstBlock) && /speculatively run a shared\/full gate/.test(firstBlock) && /Escalate up/.test(firstBlock));
  check("points at the project's own CLAUDE.md rather than restating project specifics", /CLAUDE\.md/.test(firstBlock));

  // --- idempotent re-injection: identical content on a second call (resume) ----------------------------
  injectCodexDoctrine(cwd, "worker");
  const secondBlock = fs.readFileSync(target, "utf8");
  check("re-injecting the SAME doctrine version produces byte-identical content (idempotent resume)", secondBlock === firstBlock);

  // --- git-hygiene: the shared .git/info/exclude gets the entry, so a worker's `git status` never
  // surfaces this as untracked noise a blind `git add -A` could sweep in. --------------------------------
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let excludeContent = "";
  try { excludeContent = fs.readFileSync(excludePath, "utf8"); } catch { /* asserted false below */ }
  check("git info/exclude gains a '/AGENTS.md' entry after injection", excludeContent.split(/\r?\n/).includes("/AGENTS.md"));
}

// --- card 25389c3c: a submodule-shaped canonical repo (`.git` is a gitfile with NO `commondir` file —
// the shape hideCodexDoctrineFromGit's prior local resolver returned null for, silently never excluding
// AGENTS.md) must still get the exclude entry via the shared resolveGitDirsSync fallback -----------------
//
// Round 3, item 4: GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_CONFIG_NOSYSTEM/HOME are pinned to test-owned
// files for this block too (mirrors the global-excludes block further below) — without this, the "git
// status shows NO untracked AGENTS.md" assertion below could pass for the WRONG reason (a host global
// exclude/ignore rule that happens to match "AGENTS.md"), rather than because this fixture's own
// info/exclude entry actually hid it.
{
  const savedSubmoduleEnv = { ...process.env };
  const tmpHomeForSubmoduleBlock = mkdtempManaged("loom-codex-doctrine-submodule-home-");
  const submoduleGlobalGitconfig = path.join(tmpHomeForSubmoduleBlock, "global-gitconfig");
  fs.writeFileSync(submoduleGlobalGitconfig, ""); // deliberately empty — no excludesFile of its own
  process.env.GIT_CONFIG_GLOBAL = submoduleGlobalGitconfig;
  process.env.GIT_CONFIG_SYSTEM = path.join(tmpHomeForSubmoduleBlock, "nonexistent-system-gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = tmpHomeForSubmoduleBlock;
  process.env.USERPROFILE = tmpHomeForSubmoduleBlock;
  try {
    const cwd = mkdtempManaged("loom-codex-doctrine-submodule-");
    const externalGitDir = path.join(cwd, "..", "loom-codex-doctrine-submodule-external-gitdir");
    registerForCleanup(externalGitDir); // sibling of cwd, outside its own mkdtemp'd dir — not auto-swept otherwise
    const git = (args) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
    git("init -q");
    git('config user.email "test@test.com"');
    git('config user.name "test"');
    fs.writeFileSync(path.join(cwd, "README.md"), "hi");
    git("add README.md");
    git('commit -q -m "init"');
    fs.renameSync(path.join(cwd, ".git"), externalGitDir);
    fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${externalGitDir}\n`);
    // git init's own template writes a default info/exclude — remove it so "was created" actually discriminates.
    fs.rmSync(path.join(externalGitDir, "info", "exclude"), { force: true });
    check("submodule fixture: .git is a FILE", fs.statSync(path.join(cwd, ".git")).isFile());
    check("submodule fixture: no commondir file (the shape under test)", !fs.existsSync(path.join(externalGitDir, "commondir")));

    injectCodexDoctrine(cwd, "worker");
    check("AGENTS.md still created for a submodule-shaped repo", fs.existsSync(path.join(cwd, "AGENTS.md")));
    const excludePath = path.join(externalGitDir, "info", "exclude");
    let excludeContent = "";
    try { excludeContent = fs.readFileSync(excludePath, "utf8"); } catch { /* asserted false below */ }
    check("info/exclude is created in the submodule's own gitdir (privateDir == commonDir fallback)", excludeContent !== "");
    check("info/exclude carries the '/AGENTS.md' entry for a submodule-shaped repo", excludeContent.split(/\r?\n/).includes("/AGENTS.md"));
    const status = git("status --porcelain -uall");
    check("git status shows NO untracked AGENTS.md for a submodule-shaped repo", !/\?\? AGENTS\.md/.test(status));
  } finally {
    process.env = savedSubmoduleEnv;
  }
}

// --- never clobbers a repo's OWN real, pre-existing AGENTS.md (mirrors skills/inject.ts's rule) --------
// Card 9bf0db97 claim 1: this skip used to be SILENT — nothing anywhere disclosed that the codex worker
// lost its injected doctrine. Capture console.log (same technique as codex-concurrent-same-cwd-
// exclusion.mjs) to prove the skip now emits a non-content-bearing signal naming the session/project id
// and the PATH only, never the repo's own real file text.
{
  const cwd = makeFakeRepo("loom-codex-doctrine-preexisting-");
  const target = path.join(cwd, "AGENTS.md");
  const ownContent = "# This project's own real AGENTS.md\n\nSome real, human-authored project instructions.\n";
  fs.writeFileSync(target, ownContent);

  const capturedLogs = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => { capturedLogs.push(args.map(String).join(" ")); originalConsoleLog(...args); };
  try {
    injectCodexDoctrine(cwd, "worker", { sessionId: "sess-skip-test-1", projectId: "proj-skip-test-1" });
  } finally {
    console.log = originalConsoleLog;
  }
  check("a pre-existing AGENTS.md that does NOT start with the Loom marker is left byte-identical (never clobbered)",
    fs.readFileSync(target, "utf8") === ownContent);
  const skipLine = capturedLogs.find((l) => l.startsWith("[codex-doctrine] skipped:"));
  check("the skip now emits a visible [codex-doctrine] log line (was SILENT before card 9bf0db97)", skipLine !== undefined);
  check("the skip log line names the session id passed through", !!skipLine && skipLine.includes("sess-skip-test-1"));
  check("the skip log line names the project id passed through", !!skipLine && skipLine.includes("proj-skip-test-1"));
  check("the skip log line names the AGENTS.md path", !!skipLine && skipLine.includes(target));
  check("the skip log line does NOT carry the repo's own file CONTENT (non-content-bearing)",
    !!skipLine && !skipLine.includes("human-authored project instructions"));

  const excludePath = path.join(cwd, ".git", "info", "exclude");
  let excludeContent = "";
  try { excludeContent = fs.readFileSync(excludePath, "utf8"); } catch { /* fine if absent */ }
  check("a real pre-existing AGENTS.md is NOT git-excluded either (it is a real, presumably-tracked project file)",
    !excludeContent.split(/\r?\n/).includes("/AGENTS.md"));
}

// --- stale Loom-owned content (an older doctrine wording) IS refreshed, unlike a foreign file ----------
{
  const cwd = makeFakeRepo("loom-codex-doctrine-stale-");
  const target = path.join(cwd, "AGENTS.md");
  const staleBlock = "<!-- LOOM:CODEX-DOCTRINE:BEGIN (managed by Loom — regenerated every spawn; do not edit by hand) -->\nSTALE PRIOR VERSION\n<!-- LOOM:CODEX-DOCTRINE:END -->\n";
  fs.writeFileSync(target, staleBlock);
  injectCodexDoctrine(cwd, "worker");
  const refreshed = fs.readFileSync(target, "utf8");
  check("a stale Loom-OWNED block (starts with our marker) IS refreshed to the current doctrine content", refreshed === firstBlock && refreshed !== staleBlock);
}

// --- card 9bf0db97 claim 2 (round 1): a LINKED worktree's exclude must never land in the shared
// commonDir — `info/exclude` has no per-worktree copy, so writing the entry there used to leak into
// every sibling worktree of the repo, including the main checkout where a human's own real, later-added
// root AGENTS.md would then be silently hidden from `git status`/`git add -A` too. -----------------------
//
// round 2 (Code Review CHANGES on round 1's own fix — 1 Critical + 1 Major, both reproduced on git
// 2.47): round 1's replacement (a per-worktree `core.excludesFile` via `extensions.worktreeConfig`)
// broke submodule/bare-canonical `git status` repo-wide, AND silently REPLACED (never merged with) the
// worker's own global excludes — a real auto-commit exfiltration risk (`attemptCodexAutoCommit` stages
// every untracked file). The reviewer verified a THIRD git-level option (a per-worktree `info/exclude`
// under the PRIVATE gitdir) is simply not honoured by git either. So for a LINKED worktree, NOTHING is
// written at the git layer any more — `git status` in the worker worktree now correctly reports the
// injected AGENTS.md as an ordinary untracked file (asserted below, the opposite of round 1's own
// assertion) — and the daemon's own `isCodexDoctrinePath`-based filters (already present at every real
// untracked-file consumer: `uncommittedWorkFiles`/`worktreeStatusHasWork`/`computeWorktreeGateStamp` via
// `filteredWorkEntries`, `attemptCodexAutoCommit`'s own candidate filter, and `readWorktreeUncommittedState`
// built on the same shared helper) are what hides it from "real work" instead. Hermetic: GIT_CONFIG_GLOBAL/
// GIT_CONFIG_SYSTEM/HOME are pinned to test-owned files for the global-excludes case below, so it never
// depends on whatever (if anything) the host's own real global gitconfig/ignore happens to set.
{
  const { uncommittedWorkFiles, readWorktreeUncommittedState, attemptCodexAutoCommit } = await import("../dist/git/worktrees.js");

  const savedEnv = { ...process.env };
  const tmpHomeForThisBlock = mkdtempManaged("loom-codex-doctrine-wt-home-");
  const globalIgnore = path.join(tmpHomeForThisBlock, "global-ignore");
  const globalGitconfig = path.join(tmpHomeForThisBlock, "global-gitconfig");
  fs.writeFileSync(globalIgnore, "*.secret\n");
  fs.writeFileSync(globalGitconfig, `[core]\n\texcludesFile = ${globalIgnore.replace(/\\/g, "/")}\n`);
  process.env.GIT_CONFIG_GLOBAL = globalGitconfig;
  process.env.GIT_CONFIG_SYSTEM = path.join(tmpHomeForThisBlock, "nonexistent-system-gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = tmpHomeForThisBlock;
  process.env.USERPROFILE = tmpHomeForThisBlock;

  try {
    const mainCwd = mkdtempManaged("loom-codex-doctrine-wt-main-");
    const git = (args, cwd) => execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString();
    git("init -q", mainCwd);
    git('config user.email "test@test.com"', mainCwd);
    git('config user.name "test"', mainCwd);
    fs.writeFileSync(path.join(mainCwd, "README.md"), "hi");
    git("add README.md", mainCwd);
    git('commit -q -m "init"', mainCwd);

    const workerCwd = `${mainCwd}-worker-wt`;
    registerForCleanup(workerCwd); // created by `git worktree add` below, not by mkdtempManaged
    const branch = "loom-codex-doctrine-wt-branch";
    git(`worktree add -q "${workerCwd}" -b ${branch}`, mainCwd);

    injectCodexDoctrine(workerCwd, "worker");
    check("AGENTS.md created in the linked WORKER worktree", fs.existsSync(path.join(workerCwd, "AGENTS.md")));

    // --- round 2: NO git-level exclude mechanism is written for a linked worktree at all ---
    const sharedConfigContent = fs.readFileSync(path.join(mainCwd, ".git", "config"), "utf8");
    check("round 2: the shared commonDir config does NOT gain extensions.worktreeConfig (round 1's rejected mechanism)",
      !/worktreeConfig/i.test(sharedConfigContent));
    const workerPrivateDir = fs.readFileSync(path.join(workerCwd, ".git"), "utf8").trim().replace(/^gitdir:\s*/, "");
    check("round 2: no config.worktree file is created in the worktree's private gitdir",
      !fs.existsSync(path.join(workerPrivateDir, "config.worktree")));
    check("round 2: no codex-doctrine-exclude file is created in the worktree's private gitdir either",
      !fs.existsSync(path.join(workerPrivateDir, "codex-doctrine-exclude")));

    // The exclude pattern must NOT have landed in the shared commonDir's info/exclude (claim 2, round 1).
    const sharedExcludePath = path.join(mainCwd, ".git", "info", "exclude");
    let sharedExcludeContent = "";
    try { sharedExcludeContent = fs.readFileSync(sharedExcludePath, "utf8"); } catch { /* fine if absent */ }
    check("the shared commonDir's info/exclude does NOT carry the '/AGENTS.md' entry",
      !sharedExcludeContent.split(/\r?\n/).includes("/AGENTS.md"));

    // --- round 2: raw git now reports AGENTS.md as untracked in the worker worktree (no exclude hides it
    // at the git layer any more — this is the OPPOSITE of round 1's own assertion here). ------------------
    const workerStatusRaw = git("status --porcelain -uall", workerCwd);
    check("round 2: raw `git status` in the worker worktree DOES show AGENTS.md as untracked",
      /\?\? AGENTS\.md/.test(workerStatusRaw));

    // A human's own later root AGENTS.md in the MAIN checkout must never be hidden either (claim 2 still
    // holds under round 2 — there's even less to leak now that nothing is written at all).
    fs.writeFileSync(path.join(mainCwd, "AGENTS.md"), "# the project's own real root AGENTS.md\n");
    const mainStatus = git("status --porcelain -uall", mainCwd);
    check("git status in the MAIN checkout still shows a human's own later root AGENTS.md as untracked (no cross-worktree leak)", /\?\? AGENTS\.md/.test(mainStatus));

    // --- the daemon's own isCodexDoctrinePath-based filter is what hides it from "real work" instead ----
    fs.writeFileSync(path.join(workerCwd, "real-work.txt"), "the worker's actual product");
    const statusZ = git("-c core.quotePath=false status --porcelain -z", workerCwd);
    const realWorkFiles = uncommittedWorkFiles(statusZ);
    check("uncommittedWorkFiles (feeds the done-report precheck + gate stamp) EXCLUDES the injected AGENTS.md",
      !realWorkFiles.includes("AGENTS.md"));
    check("uncommittedWorkFiles still INCLUDES a genuine untracked file (the filter discriminates, not just always-empty)",
      realWorkFiles.includes("real-work.txt"));
    fs.rmSync(path.join(workerCwd, "real-work.txt"));

    // --- finalize's own dirty-check reads a worktree holding ONLY the injected AGENTS.md as clean -------
    const finalizeState = await readWorktreeUncommittedState(workerCwd);
    check("finalize's readWorktreeUncommittedState reads a worktree holding only the injected AGENTS.md as clean",
      finalizeState.state === "clean");

    // --- the auto-commit staging filter also ignores it (never stages/commits AGENTS.md) -----------------
    // Round 3, item 2: `sekrit.secret` is created BEFORE calling attemptCodexAutoCommit (not after, as this
    // block used to) — the round-1 Major finding was that a per-worktree core.excludesFile could silently
    // REPLACE the worker's own global excludes and let attemptCodexAutoCommit sweep a globally-ignored
    // secret into a real commit; asserting the secret is absent from the commit's own `show --stat` pins
    // that actual exfiltration path, not just a `git status` read that never exercised the auto-commit.
    fs.writeFileSync(path.join(workerCwd, "real-work-2.txt"), "the worker's real deliverable");
    fs.writeFileSync(path.join(workerCwd, "sekrit.secret"), "should stay globally ignored");
    const autoCommitResult = await attemptCodexAutoCommit(workerCwd, branch, { summary: "test: round 2 auto-commit filter" });
    check("attemptCodexAutoCommit committed the real file", autoCommitResult.committed === true);
    const committedPaths = git("show --stat --format= HEAD", workerCwd);
    check("attemptCodexAutoCommit's commit includes the real work file", /real-work-2\.txt/.test(committedPaths));
    check("attemptCodexAutoCommit's commit does NOT include the injected AGENTS.md", !/AGENTS\.md/.test(committedPaths));
    check("round 3: attemptCodexAutoCommit's commit does NOT include the globally-ignored secret (the actual exfiltration path the round-1 Major was about)",
      !/sekrit\.secret/.test(committedPaths));

    // --- the worker's own GLOBAL excludesFile (core.excludesFile from gitconfig) still applies inside
    // the worker worktree — round 1's per-worktree core.excludesFile used to REPLACE this, never merge
    // with it, which is this record's own Major finding (a real auto-commit exfiltration risk). ----------
    const statusWithSecret = git("status --porcelain -uall", workerCwd);
    check("the worker's own GLOBAL excludesFile (*.secret) still applies inside the worker worktree — never replaced by anything Loom writes",
      !/sekrit\.secret/.test(statusWithSecret));
  } finally {
    process.env = savedEnv;
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — injectCodexDoctrine creates/refreshes a Loom-owned AGENTS.md for worker-role codex sessions only, never clobbers a repo's own real file, discloses when it skips a repo-owned AGENTS.md, and — for a linked worktree, where it reports as an ordinary untracked file instead (round 2) — never lets the worker's own global excludes get replaced or the injected artifact get auto-committed."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
