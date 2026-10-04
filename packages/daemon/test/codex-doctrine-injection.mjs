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

// --- card 29f22d83: pruneStaleCodexDoctrineExclude — an idempotent removal of a stale '/AGENTS.md' line
// left over from round 1's unconditional write (before card 9bf0db97 scoped it away from linked
// worktrees). Must remove ONLY a Loom-written entry in the FIRST position of a recognized run under
// LOOM_EXCLUDE_HEADER (round 2), never hideFromGit's own skill/manifest/settings entries sharing that same
// header, and never a user-authored '/AGENTS.md' line sitting outside any such run — even one with
// identical text, even one landing directly after a Loom-written run. Round 3 fixed a two-boot user-line-
// loss bug (the header-drop fix below) and tried an in-file done-marker for one-shot-per-commonDir — that
// marker never shipped (its own "none" branch never stamped it) and was replaced in round 4 by a
// `PruneDoneMarkerStore` (an app_meta-shaped key/value store, faked here in-memory) keyed per commonDir, so
// nothing is ever written into a clean user repo's exclude file just to record Loom's own bookkeeping.
// Round 4 also closed a real lost-update window: round 3's own fix re-read the file BEFORE three more
// `await`s (tmp write, chmod, rename) — a concurrent in-process writer landing in THAT window still got
// clobbered. The fix moves the final read+compare+rename into one synchronous block with no `await` or
// yield inside it. --------------------------------------------------------------------------------------
{
  const { pruneStaleCodexDoctrineExclude, pruneStaleCodexDoctrineExcludesAtBoot } = await import("../dist/pty/codex-doctrine.js");
  const LOOM_HEADER = "# loom-managed exclusions (injected per session; do not commit)";

  // A hermetic, in-memory fake of PruneDoneMarkerStore (the real one is Db's getMeta/setMeta) — a fresh one
  // per test fixture unless the fixture itself needs to prove persistence ACROSS calls (e.g. a two-boot
  // scenario), in which case one instance is deliberately reused across those calls.
  function makeMemMetaStore() {
    const map = new Map();
    return { getMeta: (k) => map.get(k), setMeta: (k, v) => { map.set(k, v); }, _map: map };
  }

  // --- a missing exclude file is a no-op: no throw, no file/dir created, and — never marked done, since
  // there's nothing to protect against re-scanning (see PruneDoneMarkerStore's own doc). -------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-missing-");
    const store = makeMemMetaStore();
    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("missing info/exclude: outcome is 'no-file'", outcome === "no-file");
    check("missing info/exclude: no info/ dir was created as a side effect", !fs.existsSync(path.join(cwd, ".git", "info")));
    check("missing info/exclude: no done-marker was stamped (nothing to protect)", store._map.size === 0);
  }

  // --- the real stale-entry shape (round-1 era), produced via the REAL injectCodexDoctrine path on a
  // non-worktree repo (privateDir === commonDir) — the actual historical output, not a hand-guessed one. --
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-stale-");
    injectCodexDoctrine(cwd, "worker"); // writes the real '/AGENTS.md' entry under LOOM_HEADER via appendToSharedExclude
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    const before = fs.readFileSync(excludePath, "utf8");
    check("setup: the real injection wrote the stale '/AGENTS.md' entry", before.split(/\r?\n/).includes("/AGENTS.md"));

    const store = makeMemMetaStore();
    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("a genuinely Loom-written '/AGENTS.md' line: outcome is 'removed'", outcome === "removed");
    const after = fs.readFileSync(excludePath, "utf8");
    check("the stale '/AGENTS.md' line is gone", !after.split(/\r?\n/).includes("/AGENTS.md"));
    check("the now-orphaned header (its whole run was just the stale entry) is dropped too, not left as noise",
      !after.includes(LOOM_HEADER));
    check("round 4: the file holds nothing else — the done-marker lives in the STORE, never written into the file",
      after === "");

    // --- idempotent on a second run, now via the store's done-marker, which short-circuits before any read ---
    const outcome2 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("second run: outcome is 'none' (the store's done-marker short-circuits before any scan)", outcome2 === "none");
    check("second run: content unchanged", fs.readFileSync(excludePath, "utf8") === after);
  }

  // --- marker-scoped: a Loom-written '/AGENTS.md' entry is removed, hideFromGit's own skill/manifest/
  // settings entries sharing the SAME header are kept, and a user-authored '/AGENTS.md' line sitting
  // OUTSIDE any Loom-managed run is kept untouched even though it's byte-identical text. -------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-mixed-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = [
      "# a human's own hand-written exclude comment",
      "/build",
      LOOM_HEADER,
      "/.claude/skills/worker",
      "/.claude/skills/.loom-skills.json",
      "/.claude/settings.local.json",
      LOOM_HEADER,
      "/AGENTS.md", // the stale codex entry — its own append-call block (one call = one entry, the real shape)
      "# the project's own later hand-added note",
      "/AGENTS.md", // a user's own exclude entry, OUTSIDE any Loom-managed run — must survive
      "",
    ].join("\n");
    fs.writeFileSync(excludePath, content);

    const store = makeMemMetaStore();
    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("mixed file: outcome is 'removed'", outcome === "removed");
    const after = fs.readFileSync(excludePath, "utf8");
    const afterLines = after.split(/\r?\n/);

    check("the human's own unrelated comment+entry before any Loom header survive",
      afterLines.includes("# a human's own hand-written exclude comment") && afterLines.includes("/build"));
    check("hideFromGit's skill entry survives", afterLines.includes("/.claude/skills/worker"));
    check("hideFromGit's manifest entry survives", afterLines.includes("/.claude/skills/.loom-skills.json"));
    check("hideFromGit's settings.local.json entry survives", afterLines.includes("/.claude/settings.local.json"));
    check("the codex header's own now-empty run is dropped — only the skills header remains (one header line total)",
      afterLines.filter((l) => l === LOOM_HEADER).length === 1);
    check("the project's own later hand-added comment survives", afterLines.includes("# the project's own later hand-added note"));
    check("the user's own '/AGENTS.md' line OUTSIDE any Loom run survives (never touched, despite identical text)",
      afterLines.filter((l) => l === "/AGENTS.md").length === 1);
    check("the trailing newline is preserved (file still ends with one)", after.endsWith("\n"));

    // --- idempotent on a second run ---
    const outcome2 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("mixed file second run: outcome is 'none'", outcome2 === "none");
    check("mixed file second run: content unchanged", fs.readFileSync(excludePath, "utf8") === after);
  }

  // --- round 2, item 1 (BLOCKING, CR ce9c4156): a '/AGENTS.md' line directly following a SKILLS run with
  // no header of its own in between — exactly where `echo /AGENTS.md >> .git/info/exclude` lands right
  // after a claude worker's own hideFromGit write — must SURVIVE. Only the FIRST line right after a header
  // is ever a removal candidate; this one is NOT in that position, so it must never be swept in just for
  // matching isKnownLoomExcludeEntry's text. This is the exact RED case that failed on 29228734: the old
  // run-continuation scan treated every recognized entry in a run as equally removable regardless of
  // position, and removed this line. ---------------------------------------------------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-adjacent-user-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = [
      LOOM_HEADER,
      "/.claude/skills/worker",
      "/.claude/skills/.loom-skills.json",
      "/.claude/settings.local.json",
      "/AGENTS.md", // a user's own line, landing directly after the skills run — NOT the stale codex write
      "",
    ].join("\n");
    fs.writeFileSync(excludePath, content);

    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), makeMemMetaStore());
    check("a user '/AGENTS.md' directly adjacent to a skills run: outcome is 'none' (nothing Loom-written to remove)",
      outcome === "none");
    const after = fs.readFileSync(excludePath, "utf8");
    check("round 2 item 1: the adjacent user '/AGENTS.md' line SURVIVES (RED on 29228734 — it used to be swept)",
      after.split(/\r?\n/).includes("/AGENTS.md"));
    check("round 2 item 1: content is completely unchanged (true no-op, not merely 'not removed')", after === content);
  }

  // --- round 2, item 2: CRLF round-trip. The real stale entry sits in a CRLF file (a Windows-authored
  // exclude, or any repo a Windows git client touched) — every SURVIVING line's terminator must come back
  // byte-identical, never silently normalized to LF. --------------------------------------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-crlf-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = [
      "# a human's own CRLF comment",
      "/build",
      LOOM_HEADER,
      "/AGENTS.md",
      "",
    ].join("\r\n");
    fs.writeFileSync(excludePath, content);

    const before = fs.readFileSync(excludePath);
    const crBefore = before.filter((b) => b === 0x0d).length;
    check("setup: before has 4 CRLF-terminated lines (comment, /build, header, stale entry)", crBefore === 4);

    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), makeMemMetaStore());
    check("CRLF file: outcome is 'removed'", outcome === "removed");
    const afterBuf = fs.readFileSync(excludePath);
    const after = afterBuf.toString("latin1");
    check("CRLF file: the stale entry is gone", !after.includes("/AGENTS.md"));
    check("CRLF file: surviving lines keep CRLF, never silently flipped to bare LF — and round 4 writes nothing else into the file (the done-marker lives in the store)",
      after === "# a human's own CRLF comment\r\n/build\r\n");
    // 2 lines removed (the header AND the stale entry — its whole run was just the one entry, so the
    // header is dropped too), each contributing exactly 1 CR of its own \r\n terminator.
    check("round 2 item 2: CR count dropped by exactly 2 (the removed header + entry's own terminators), nothing else re-encoded",
      afterBuf.filter((b) => b === 0x0d).length === crBefore - 2);
  }

  // --- round 2, item 2: non-UTF-8 bytes elsewhere in the file must survive byte-identical — a utf8
  // read/write would have silently mangled this (the replacement-character trap). ------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-nonutf8-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    // 0xE9 alone ("é" in latin-1) is NOT valid standalone UTF-8 — a utf8-decode-then-reencode round-trip
    // replaces it with U+FFFD (0xEF 0xBF 0xBD in utf8), which is byte-visible and easy to assert against.
    const commentLine = Buffer.from([0x23, 0x20, 0xe9, 0x0a]); // "# \xE9\n"
    const rest = Buffer.from(`${LOOM_HEADER}\n/AGENTS.md\n`, "utf8");
    fs.writeFileSync(excludePath, Buffer.concat([commentLine, rest]));

    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), makeMemMetaStore());
    check("non-UTF-8 file: outcome is 'removed'", outcome === "removed");
    const after = fs.readFileSync(excludePath);
    check("round 2 item 2: the non-UTF-8 byte (0xE9) survives untouched, never replaced with U+FFFD, and nothing else is appended (round 4: the done-marker lives in the store)",
      after.length === 4 && after[0] === 0x23 && after[1] === 0x20 && after[2] === 0xe9 && after[3] === 0x0a);
  }

  // --- round 2, item 3: atomic write preserves the original file's mode (posix only — win32 has no
  // meaningful chmod bits to assert on). ---------------------------------------------------------------
  if (process.platform !== "win32") {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-mode-");
    injectCodexDoctrine(cwd, "worker");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.chmodSync(excludePath, 0o640);
    const modeBefore = fs.statSync(excludePath).mode & 0o777;
    check("setup: exclude file mode is 0640 before prune", modeBefore === 0o640);

    const outcome = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), makeMemMetaStore());
    check("mode-preservation: outcome is 'removed'", outcome === "removed");
    const modeAfter = fs.statSync(excludePath).mode & 0o777;
    check("round 2 item 3: the atomic temp+rename write preserves the original file's mode (0640), not the temp file's umask-derived mode",
      modeAfter === 0o640);
  }

  // --- round 2, item 5: a live codex session sharing this commonDir blocks the destructive write, checked
  // RIGHT BEFORE the write (not only reasoned about by the caller) — mirrors
  // removeStaleCodexDoctrineArtifact's own 'skip-live-codex' discipline. Asserted by proving the guard
  // callback is actually invoked WITH this commonDir, not merely that the outcome matches. -----------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-livecodex-");
    injectCodexDoctrine(cwd, "worker");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    const before = fs.readFileSync(excludePath, "utf8");
    const commonDir = path.join(cwd, ".git");
    let calledWith = null;
    const outcome = await pruneStaleCodexDoctrineExclude(commonDir, makeMemMetaStore(), (c) => { calledWith = c; return true; });
    check("live codex session sharing commonDir present → outcome 'skip-live-codex'", outcome === "skip-live-codex");
    check("live codex session present → exclude file left untouched", fs.readFileSync(excludePath, "utf8") === before);
    check("the live-codex guard was actually invoked with this commonDir (not short-circuited earlier)", calledWith === commonDir);
  }

  // --- boot sweep: dedupes by resolved commonDir and only reports the repos it actually touched. Also
  // wires the live-session guard through to every repo it prunes. -------------------------------------------
  {
    const repoA = makeFakeRepo("loom-codex-doctrine-prune-boot-a-");
    injectCodexDoctrine(repoA, "worker");
    const repoB = makeFakeRepo("loom-codex-doctrine-prune-boot-b-"); // clean — nothing stale to remove
    const removed = await pruneStaleCodexDoctrineExcludesAtBoot([repoA, repoA, repoB], makeMemMetaStore()); // repoA listed twice — dedup
    check("boot sweep reports exactly one removal (repoA)", removed.length === 1 && removed[0].repoPath === repoA);
    check("boot sweep actually cleaned repoA's exclude file",
      !fs.readFileSync(path.join(repoA, ".git", "info", "exclude"), "utf8").includes("/AGENTS.md"));
  }

  // --- round 2, item 6: commonDir dedupe with a REAL linked worktree + its main checkout (not just a
  // literal duplicate path string) — `git worktree add` genuinely shares one commonDir across two distinct
  // repoPaths, which is the actual shape the dedupe exists to collapse. -------------------------------------
  {
    const main = mkdtempManaged("loom-codex-doctrine-prune-boot-wt-main-");
    execSync("git init -q", { cwd: main });
    execSync('git config user.email "test@test.com"', { cwd: main });
    execSync('git config user.name "test"', { cwd: main });
    fs.writeFileSync(path.join(main, "README.md"), "x");
    execSync("git add -A", { cwd: main });
    execSync('git commit -q -m "init"', { cwd: main });
    // round 4, item 4: derive the sibling worktree dir name from `main`'s OWN mkdtemp-random suffix, not a
    // fixed literal — a fixed name can collide across concurrent test runs sharing the same temp root.
    const worktreeDir = `${main}-wt`;
    registerForCleanup(worktreeDir);
    execSync(`git worktree add -q -b loom-test-wt "${worktreeDir}"`, { cwd: main });
    injectCodexDoctrine(main, "worker"); // writes the real stale entry into the MAIN checkout's shared exclude

    const removed = await pruneStaleCodexDoctrineExcludesAtBoot([main, worktreeDir], makeMemMetaStore()); // two DISTINCT repoPaths, one commonDir
    check("round 2 item 6: a linked worktree + its main checkout share one commonDir — pruned exactly once",
      removed.length === 1);
    check("round 2 item 6: the reported repoPath is whichever of the two the sweep visited first (main, by Set-iteration order)",
      removed.length === 1 && removed[0].repoPath === main);
    check("round 2 item 6: the shared exclude is actually cleaned",
      !fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8").includes("/AGENTS.md"));
  }

  // --- round 3, item 1 (BLOCKING, delta CR cb4dae72): two-boot user-line loss. Loom's stale '/AGENTS.md'
  // sits directly before a user's own identically-texted '/AGENTS.md' under the SAME header — removing only
  // the first one must NOT leave the user's line re-emitted as the new first-position entry under a
  // surviving header, or it dies on the NEXT boot. RED on 54db23dc: boot 1 removed Loom's line but kept the
  // header, producing `HEADER\n/AGENTS.md\n` — indistinguishable from the original stale shape — so boot 2
  // deleted the user's own line. One store instance reused across both calls, since this is exactly the
  // "two boots, same commonDir" scenario the store exists to make idempotent. --------------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-twoboot-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const content = [
      LOOM_HEADER,
      "/AGENTS.md", // Loom's stale entry (round 1 era) — the only removal candidate (first position)
      "/AGENTS.md", // the user's own, landing immediately after — byte-identical, must survive BOTH boots
      "",
    ].join("\n");
    fs.writeFileSync(excludePath, content);
    const store = makeMemMetaStore();

    const outcome1 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("two-boot: boot 1 outcome is 'removed'", outcome1 === "removed");
    const afterBoot1 = fs.readFileSync(excludePath, "utf8");
    check("round 3 item 1(a): boot 1 — the user's '/AGENTS.md' line survives, with the header DROPPED (not re-emitted ahead of it), and round 4: nothing else is written into the file itself",
      afterBoot1 === "/AGENTS.md\n");
    check("round 4 item 2: the done-marker was stamped in the STORE on this 'removed' outcome", store._map.size === 1);

    const outcome2 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("round 3 item 1: boot 2 outcome is 'none' (RED on 54db23dc: this used to be 'removed', deleting the user's line)",
      outcome2 === "none");
    const afterBoot2 = fs.readFileSync(excludePath, "utf8");
    check("round 3 item 1: boot 2 — the user's '/AGENTS.md' line STILL survives (the actual two-boot bug)",
      afterBoot2.split(/\r?\n/).includes("/AGENTS.md"));
    check("round 3 item 1: boot 2 is a true no-op — content unchanged from after boot 1", afterBoot2 === afterBoot1);
  }

  // --- round 4, item 2 (BLOCKING, replaces round 3's in-file marker test): the STORE'S done-marker makes
  // the prune a true one-shot — even a FRESH header-then-'/AGENTS.md' shape landing in the file AFTER a
  // "none" scan already marked this commonDir done must never be touched. Deliberately starts from a
  // "none" outcome (an exclude file with nothing stale) — round 3's own marker design never stamped this
  // branch at all, which was exactly the blocking defect the delta CR found. ---------------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-nonestamp-");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, "# just a human's own comment, nothing Loom-managed here\n");
    const store = makeMemMetaStore();

    const outcome1 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("round 4 item 2: a clean file scans to outcome 'none'", outcome1 === "none");
    check("round 4 item 2: the 'none' outcome DOES stamp the store's done-marker (round 3's in-file marker never did)",
      store._map.size === 1);

    // Simulate a fresh header+'/AGENTS.md' run landing AFTER that "none" scan (a hand edit, or hypothetically
    // a future bug reintroducing round 1's write pattern) — the store's marker must make this permanently
    // invisible to a LATER call using the SAME store.
    fs.appendFileSync(excludePath, `${LOOM_HEADER}\n/AGENTS.md\n`);
    const outcome2 = await pruneStaleCodexDoctrineExclude(path.join(cwd, ".git"), store);
    check("round 4 item 2: once the store's done-marker is set, prune is a permanent no-op — it never reads the file again",
      outcome2 === "none");
    check("round 4 item 2: the newly-appended '/AGENTS.md' survives untouched — proof this is a STORE-marker skip, not a structural one",
      fs.readFileSync(excludePath, "utf8").includes("/AGENTS.md"));
  }

  // --- round 4, item 1 (BLOCKING, replaces round 3's lost-update test): hideFromGit/appendToSharedExclude
  // write with plain SYNC fs calls and can land in the async gap this function's own awaits open up. Round
  // 3's own fix re-read the file BEFORE the tmp write/chmod/rename `await` chain — leaving exactly that
  // chain's own window uncaught (the reviewer reproduced this against dist). Round 4 moves the final check
  // to run synchronously immediately before the rename, so this test injects the concurrent append INSIDE
  // the tmp write itself — the precise window round 3 missed. ------------------------------------------------
  {
    const cwd = makeFakeRepo("loom-codex-doctrine-prune-lostupdate-");
    injectCodexDoctrine(cwd, "worker");
    const excludePath = path.join(cwd, ".git", "info", "exclude");
    const commonDir = path.join(cwd, ".git");

    const originalWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async (...args) => {
      const [target] = args;
      // Trigger only for THIS function's own tmp-file write, not any other writeFile call that might run
      // concurrently in the same process — simulating hideFromGit landing exactly inside that window.
      if (typeof target === "string" && target.endsWith(".loom-tmp")) {
        fs.appendFileSync(excludePath, "/added-concurrently\n");
      }
      return originalWriteFile.apply(fs.promises, args);
    };
    let outcome;
    const store = makeMemMetaStore();
    try {
      outcome = await pruneStaleCodexDoctrineExclude(commonDir, store);
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
    check("round 4 item 1: a concurrent write landing INSIDE the tmp write aborts with 'lost-update'", outcome === "lost-update");
    const after = fs.readFileSync(excludePath, "utf8");
    check("round 4 item 1: the concurrently-added line survives (never clobbered)", after.includes("/added-concurrently"));
    check("round 4 item 1: the stale '/AGENTS.md' entry is STILL there too (nothing was removed on this aborted pass)",
      after.split(/\r?\n/).includes("/AGENTS.md"));
    check("round 4 item 1: no done-marker was stamped in the store on an aborted pass", store._map.size === 0);

    // --- a later retry (no injected race) succeeds normally, keeping the concurrent line intact ---
    const outcome2 = await pruneStaleCodexDoctrineExclude(commonDir, store);
    check("round 4 item 1: a later retry (no race) succeeds", outcome2 === "removed");
    const after2 = fs.readFileSync(excludePath, "utf8");
    check("round 4 item 1: the retry still preserves the concurrently-added line", after2.includes("/added-concurrently"));
    check("round 4 item 1: the retry removes the stale entry", !after2.split(/\r?\n/).includes("/AGENTS.md"));
  }

  // --- round 3, item 3: make the commonDir-dedupe test discriminating. `removed.length === 1` after feeding
  // two repoPaths sharing one commonDir stays true even with `seenCommonDirs` deleted outright, because a
  // second REAL visit onto an already-pruned (marker-stamped) file is ALSO a no-op, for an unrelated reason
  // (this function's own idempotency). Using a live-session callback that ALWAYS reports a live session
  // keeps the file's removable shape UNCHANGED across repeated visits (the write never happens), so a
  // second visit — if dedupe were absent — would reach the callback again: counting invocations is what
  // actually discriminates, not `removed.length`. ------------------------------------------------------------
  {
    const main = mkdtempManaged("loom-codex-doctrine-prune-dedupe-count-main-");
    execSync("git init -q", { cwd: main });
    execSync('git config user.email "test@test.com"', { cwd: main });
    execSync('git config user.name "test"', { cwd: main });
    fs.writeFileSync(path.join(main, "README.md"), "x");
    execSync("git add -A", { cwd: main });
    execSync('git commit -q -m "init"', { cwd: main });
    // round 4, item 4: derive the sibling worktree dir name from `main`'s OWN mkdtemp-random suffix, not a
    // fixed literal — a fixed name can collide across concurrent test runs sharing the same temp root.
    const worktreeDir = `${main}-wt`;
    registerForCleanup(worktreeDir);
    execSync(`git worktree add -q -b loom-test-wt-dedupe-count "${worktreeDir}"`, { cwd: main });
    injectCodexDoctrine(main, "worker"); // writes the real stale entry into the shared exclude

    let calls = 0;
    const removed = await pruneStaleCodexDoctrineExcludesAtBoot([main, worktreeDir], makeMemMetaStore(), () => { calls++; return true; });
    check("round 3 item 3: the live-session callback (invoked only on a genuine removal attempt) runs exactly ONCE — proves the SAME commonDir was visited only once, not merely that removed.length happens to be 1",
      calls === 1);
    check("round 3 item 3: nothing was removed (every visit reported a live codex session, so the write never happened)",
      removed.length === 0);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — injectCodexDoctrine creates/refreshes a Loom-owned AGENTS.md for worker-role codex sessions only, never clobbers a repo's own real file, discloses when it skips a repo-owned AGENTS.md, and — for a linked worktree, where it reports as an ordinary untracked file instead (round 2) — never lets the worker's own global excludes get replaced or the injected artifact get auto-committed."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
