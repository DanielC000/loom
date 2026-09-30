import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ffe98495 (full review lane 4, B1): `resolveInVault` (vault/writer.ts) had no in-root deny-list at
// all — a `vault_write` caller could write `.git/hooks/pre-commit` (or set `core.fsmonitor` in
// `.git/config`), and the daemon's OWN next `commitVault` would execute it: host code execution as the
// daemon user. Reproduced by the reviewer on Windows with real git.
// See docs/decisions/ffe98495-refuse-vault-git-segment-writes-and-neutralise-commit-hooks.md.
//
// Review round 2 (Code Review of commit c929219d) found FIVE further issues, all addressed in this file:
//   1. CRITICAL, VERIFIED live: an NTFS alternate-data-stream alias (`<dir>::$INDEX_ALLOCATION`,
//      `<file>:<stream>`) resolves to the base name WITHOUT ever spelling `.git` as a segment string, so
//      the original segment-name check alone missed it. Fixed by refusing any literal `:` in relPath.
//   2. every vault git call is now ALSO repo-pinned (GIT_DIR/GIT_WORK_TREE) and forces
//      `commit.gpgsign=false`/`safe.bareRepository=explicit` — proved directly in sections (6)/(7) below.
//   3. a segment ending in `.`/space is now refused OUTRIGHT for every name, not only a `.git`/`.obsidian`
//      alias — Node does NOT strip a trailing dot/space the way Explorer/cmd.exe do, so an UNGUARDED write
//      can leave a real, mismatched directory behind that then breaks `git add` for the whole repo.
//   4. the 8.3 short-name check now refuses ANY `~<digits>` shape outright, not just a `GIT~`/`OBSIDI~`
//      prefix — a Windows short name can be a HASHED collision form unrelated to the long name's prefix.
//   5. resolveInVault's realpath walk now ALSO refuses when it resolves into the vault's own `.git`, as
//      defense in depth against a pre-existing symlink/junction planted by some OTHER means.
//
// HERMETIC, real git + temp dirs (no mocks): proves, against RED-on-old-code behavior (see each section's
// own manual RED-proof note, performed against this same file, not committed):
//   (1) resolveInVault (via writeVaultFile/createVaultFile/deleteVaultFile) refuses EVERY path whose
//       segments touch `.git`/`.obsidian` — exact, case-insensitive, nested-ancestor, leaf-only (a gitlink
//       file), Windows trailing-dot/space alias, Windows 8.3 short-name alias forms (both a fixed-prefix
//       and a hashed-collision shape), and an NTFS alternate-data-stream (colon) alias;
//   (1b) a trailing dot/space is ALSO refused on a name with NO relation to `.git`/`.obsidian` — the
//       general hygiene rule review finding 3 asked for, with a live consequence check proving WHY;
//   (1c) DEFENSE IN DEPTH: a pre-existing symlink/junction (never created via vault_write) that resolves
//       into the vault's own `.git` is refused even though its own segment name is innocuous;
//   (2) NEGATIVE CONTROL: an ordinary nested vault write is completely unaffected;
//   (3) a hook planted BY HAND directly on disk (never through vault_write — proving the defect class even
//       independent of guard (1)) does NOT run when commitVault commits, with a POSITIVE CONTROL proving
//       the exact same hook DOES fire under a plain, unmodified `git commit` — so the absence under
//       commitVault is meaningful, not a broken detector;
//   (4) same shape for a hand-planted `core.fsmonitor` hook script — neutralised under commitVault's own
//       `git status`/`git add`, with the same positive control;
//   (5) VaultVersioner.flushSync (the synchronous shutdown-flush twin of the same commit path) gets the
//       same hook/fsmonitor neutralisation;
//   (6) a hand-planted `commit.gpgsign=true` + a marking `gpg.program` does NOT fire under commitVault's
//       own commit (forced off by `-c commit.gpgsign=false`), with the same positive-control shape;
//   (7) commitVault is provably UNAFFECTED by an ambient `GIT_DIR`/`GIT_WORK_TREE` pointing at a
//       completely different, unrelated repo — the commit lands in the VAULT's own `.git`, never the
//       decoy's, proving the repo-pinning actually takes effect rather than merely being passed and ignored.
// Run after build: node test/vault-git-segment-guard.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const { writeVaultFile, createVaultFile, deleteVaultFile } = await import("../dist/vault/writer.js");
const { commitVault, VaultVersioner } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email vault-git-segment@example.com");
  git(dir, "config user.name vault-git-segment-test");
}
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

// --- (1) resolveInVault refuses every `.git`/`.obsidian` segment form ------------------------------------
// RED PROOF (performed manually against this SAME file, not committed): reverting ONLY
// packages/daemon/src/vault/writer.ts to its pre-ffe98495 content (`git checkout HEAD -- ...` against the
// pre-fix commit), rebuilding, and re-running this unchanged section shows EVERY case below returning
// `ok:true` and the file actually landing on disk — i.e. no deny-list at all, exactly the defect this fix
// closes. Restoring the fix and rebuilding returns this section to green. See the worker's own report for
// the observed numbers.
{
  const vault = mkdtempManaged("loom-git-segment-vault-");
  fs.mkdirSync(vault, { recursive: true });

  const REFUSED_CASES = [
    [".git", "exact leaf (a gitlink file)"],
    [".git/hooks/pre-commit", "nested under .git"],
    [".GIT/hooks/pre-commit", "case-insensitive (.GIT)"],
    ["notes/.git/config", ".git as a NON-leading ancestor segment"],
    [".git./hooks/pre-commit", "Windows trailing-dot alias (.git.)"],
    [".git /hooks/pre-commit", "Windows trailing-space alias (.git )"],
    ["GIT~1/hooks/pre-commit", "Windows 8.3 short-name alias (GIT~1)"],
    ["git~2/hooks/pre-commit", "Windows 8.3 short-name alias, lowercase + different digit (git~2)"],
    [".obsidian/plugins/evil/main.js", "nested under .obsidian"],
    [".OBSIDIAN/workspace.json", "case-insensitive (.OBSIDIAN)"],
    ["OBSIDI~1/plugins/evil/main.js", "Windows 8.3 short-name alias for .obsidian (OBSIDI~1)"],
    [".obsidian.", "Windows trailing-dot alias for .obsidian leaf"],
    // review finding 1 (CRITICAL, verified live): an NTFS alternate-data-stream alias resolves to the
    // BASE name — multi-letter dir names, deliberately, so a single-letter case (e.g. "d:") can't be
    // mistaken for a Windows drive letter by Node's own path handling, which would make the case vacuous.
    ["dirnn::$INDEX_ALLOCATION/hooks/pre-commit", "NTFS directory alternate-data-stream alias (colon) reaching a nested path"],
    ["filenn:evil.md", "NTFS file alternate-data-stream alias (a single colon, no nested path)"],
    // review finding 3: a trailing dot/space is refused for ANY name, not only one that aliases
    // `.git`/`.obsidian` — see the live consequence check below this loop for WHY.
    ["notes.", "trailing dot on an UNRELATED (non-.git) leaf name"],
    ["notes /file.md", "trailing space on an UNRELATED ancestor segment"],
    // review finding 4: the 8.3 short-name refusal is a SHAPE match, not tied to a `.git`/`.obsidian`
    // prefix — Windows can generate a HASHED collision-form short name unrelated to the long name's own
    // first six characters.
    ["GI7F32~1/hooks/pre-commit", "Windows 8.3 short-name SHAPE unrelated to any fixed .git/.obsidian prefix (a hashed collision form)"],
  ];
  for (const [relPath, why] of REFUSED_CASES) {
    const before = JSON.stringify(walkAll(vault));
    const w = await writeVaultFile(vault, relPath, "PWNED");
    check(`writeVaultFile refuses "${relPath}" (${why})`, w.ok === false && w.reason === "traversal");
    const after = JSON.stringify(walkAll(vault));
    check(`writeVaultFile("${relPath}") wrote NOTHING new to disk`, before === after);
    const c = await createVaultFile(vault, relPath, "PWNED");
    check(`createVaultFile refuses "${relPath}" (${why})`, c.ok === false && c.reason === "traversal");
    const d = await deleteVaultFile(vault, relPath);
    check(`deleteVaultFile refuses "${relPath}" (${why})`, d.ok === false && d.reason === "traversal");
  }

  // (2) NEGATIVE CONTROL: an ordinary nested write is completely unaffected by the new deny-list.
  const ok = await writeVaultFile(vault, "notes/subdir/hello.md", "# hello\n");
  check("negative control: an ordinary nested write still succeeds", ok.ok === true);
  check("negative control: the file actually landed on disk", fs.existsSync(path.join(vault, "notes", "subdir", "hello.md")));
}

/** Every file path under `root`, recursively (sorted) — used as a before/after disk snapshot. */
function walkAll(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(root, p));
    }
  };
  try { walk(root); } catch { /* root may not exist yet */ }
  return out.sort();
}

// --- (1b) CONSEQUENCE CHECK for review finding 3: a `.git`-adjacent trailing-dot/space directory,
// created DIRECTLY (bypassing our guard — this proves the underlying git behavior, not our code), collides
// with the repo's real `.git` in a way that makes EVERY later `git add` in that repo fail — not just a
// skipped file, a HARD, repo-wide failure. Verified live (not asserted from memory): reverting the writer
// fix and re-running section (1) above on THIS same file showed exactly this — `error: unable to index
// file '.git /HEAD'` / `fatal: adding files failed`, repeating on every subsequent commitVault call
// against that same polluted vault. This reproduces it directly, independent of the writer guard.
{
  const consequenceRepo = mkdtempManaged("loom-trailing-dot-consequence-");
  initRepo(consequenceRepo); // creates a real .git
  const spaceDir = path.join(consequenceRepo, ".git "); // trailing space — collides with the real .git
  fs.mkdirSync(spaceDir, { recursive: true });
  fs.writeFileSync(path.join(spaceDir, "x.md"), "hi\n");
  fs.writeFileSync(path.join(consequenceRepo, "other.md"), "unrelated content\n");
  let addFailed = false;
  try { git(consequenceRepo, "add ."); } catch { addFailed = true; }
  check(
    "consequence check: a `.git `-colliding directory (created directly, bypassing our guard) makes a real " +
    "`git add .` fail HARD for the WHOLE repo, not just the colliding path — exactly what the guard prevents",
    addFailed,
  );
}

// --- (1c) DEFENSE IN DEPTH for review finding 5: a pre-existing symlink/junction that resolves INTO the
// vault's own `.git` must be refused even though its OWN segment name is innocuous (never created via
// vault_write, which cannot write a symlink at all — this checks the REALPATH walk independently of the
// segment-name refusal above).
{
  const vault5 = mkdtempManaged("loom-git-symlink-defense-");
  initRepo(vault5); // creates a real .git
  const linkPath = path.join(vault5, "escape");
  let linked = false;
  try { fs.symlinkSync(path.join(vault5, ".git"), linkPath, "junction"); linked = true; }
  catch { try { fs.symlinkSync(path.join(vault5, ".git"), linkPath, "dir"); linked = true; } catch { /* no privilege */ } }
  if (linked) {
    const w5 = await writeVaultFile(vault5, "escape/hooks/pre-commit", "PWNED");
    check(
      "writeVaultFile refuses a write through a symlink resolving into the vault's own .git (defense in depth)",
      w5.ok === false && w5.reason === "traversal",
    );
    check("the write did not land inside the real .git", !fs.existsSync(path.join(vault5, ".git", "hooks", "pre-commit")));
  } else {
    console.log("SKIP  symlink-into-.git defense check — could not create a link/junction without elevation");
  }
}

// --- (3) a hand-planted pre-commit hook does NOT run on commitVault ---------------------------------------
// RED PROOF (performed manually against this SAME file, not committed): reverting ONLY
// packages/daemon/src/vault/versioner.ts to its pre-ffe98495 content, rebuilding, and re-running this
// unchanged section shows the marker file CREATED after commitVault runs — i.e. the hand-planted hook
// fires under commitVault exactly as it does under a plain `git commit`, proving no neutralisation at all.
// Restoring the fix and rebuilding returns this section to green.
{
  const repo = mkdtempManaged("loom-hook-noexec-commitvault-");
  initRepo(repo);
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const markerPath = path.join(repo, ".git", "hook-fired");
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${repo.replace(/\\/g, "/")}/.git/hook-fired"\n`);
  fs.chmodSync(hookPath, 0o755);

  fs.writeFileSync(path.join(repo, "urgent.md"), "planted by hand, not via vault_write\n");
  const before = commitCount(repo);
  const result = await commitVault(repo, "loom: hand-planted hook test");
  check("commitVault against a hand-planted pre-commit hook still commits (ok, not silently refused)", result === true);
  check("commitVault's commit actually landed", commitCount(repo) === before + 1);
  check("the hand-planted pre-commit hook did NOT fire under commitVault", !fs.existsSync(markerPath));

  // POSITIVE CONTROL: the SAME hook, planted the SAME way, DOES fire under a plain unmodified `git commit`
  // — proving the marker-detection mechanism itself works, so the absence above is meaningful.
  const controlRepo = mkdtempManaged("loom-hook-noexec-control-");
  initRepo(controlRepo);
  const controlHookPath = path.join(controlRepo, ".git", "hooks", "pre-commit");
  const controlMarkerPath = path.join(controlRepo, ".git", "hook-fired");
  fs.writeFileSync(controlHookPath, `#!/bin/sh\ntouch "${controlRepo.replace(/\\/g, "/")}/.git/hook-fired"\n`);
  fs.chmodSync(controlHookPath, 0o755);
  fs.writeFileSync(path.join(controlRepo, "urgent.md"), "control\n");
  git(controlRepo, "add .");
  git(controlRepo, 'commit -m "control commit"');
  check("positive control: the SAME hook DOES fire under a plain 'git commit' (proves the detector works)", fs.existsSync(controlMarkerPath));
}

// --- (4) a hand-planted core.fsmonitor hook does NOT run on commitVault ------------------------------------
{
  const repo = mkdtempManaged("loom-fsmon-noexec-commitvault-");
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "a.md"), "seed\n");
  await commitVault(repo, "loom: seed commit"); // establish HEAD so a later `git status` has something to diff against
  const scriptPath = path.join(repo, "fsmon.sh");
  const markerPath = path.join(repo, ".git", "fsmon-fired");
  fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch "${repo.replace(/\\/g, "/")}/.git/fsmon-fired"\nexit 1\n`);
  fs.chmodSync(scriptPath, 0o755);
  git(repo, `config core.fsmonitor "${scriptPath.replace(/\\/g, "/")}"`);

  fs.writeFileSync(path.join(repo, "b.md"), "second\n");
  const before = commitCount(repo);
  const result = await commitVault(repo, "loom: fsmonitor test");
  check("commitVault against a hand-planted core.fsmonitor hook still commits", result === true);
  check("commitVault's commit actually landed", commitCount(repo) === before + 1);
  check("the hand-planted core.fsmonitor hook did NOT fire under commitVault", !fs.existsSync(markerPath));

  // POSITIVE CONTROL: the SAME fsmonitor config DOES fire under a plain `git status`.
  const controlRepo = mkdtempManaged("loom-fsmon-noexec-control-");
  initRepo(controlRepo);
  fs.writeFileSync(path.join(controlRepo, "a.md"), "seed\n");
  git(controlRepo, "add .");
  git(controlRepo, 'commit -m "seed"');
  const controlScriptPath = path.join(controlRepo, "fsmon.sh");
  const controlMarkerPath = path.join(controlRepo, ".git", "fsmon-fired");
  fs.writeFileSync(controlScriptPath, `#!/bin/sh\ntouch "${controlRepo.replace(/\\/g, "/")}/.git/fsmon-fired"\nexit 1\n`);
  fs.chmodSync(controlScriptPath, 0o755);
  git(controlRepo, `config core.fsmonitor "${controlScriptPath.replace(/\\/g, "/")}"`);
  fs.writeFileSync(path.join(controlRepo, "b.md"), "second\n");
  git(controlRepo, "status --porcelain");
  check("positive control: the SAME core.fsmonitor script DOES fire under a plain 'git status' (proves the detector works)", fs.existsSync(controlMarkerPath));
}

// --- (5) VaultVersioner.flushSync gets the same hook/fsmonitor neutralisation ------------------------------
{
  const repo = mkdtempManaged("loom-hook-noexec-flushsync-");
  initRepo(repo);
  const vc = new VaultVersioner(repo, 60_000);
  await vc.start();
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  const markerPath = path.join(repo, ".git", "hook-fired");
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${repo.replace(/\\/g, "/")}/.git/hook-fired"\n`);
  fs.chmodSync(hookPath, 0o755);
  fs.writeFileSync(path.join(repo, "urgent.md"), "planted by hand before a shutdown flush\n");
  const before = commitCount(repo);
  const result = vc.flushSync();
  await vc.stop();
  check("flushSync against a hand-planted pre-commit hook still commits", result === true);
  check("flushSync's commit actually landed", commitCount(repo) === before + 1);
  check("the hand-planted pre-commit hook did NOT fire under flushSync", !fs.existsSync(markerPath));
}

// --- (6) a hand-planted commit.gpgsign=true + gpg.program does NOT fire under commitVault --------------
{
  const repo = mkdtempManaged("loom-gpgsign-noexec-commitvault-");
  initRepo(repo);
  const scriptPath = path.join(repo, "gpg.sh");
  const markerPath = path.join(repo, ".git", "gpg-fired");
  fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch "${repo.replace(/\\/g, "/")}/.git/gpg-fired"\nexit 1\n`);
  fs.chmodSync(scriptPath, 0o755);
  git(repo, "config commit.gpgsign true");
  git(repo, `config gpg.program "${scriptPath.replace(/\\/g, "/")}"`);

  fs.writeFileSync(path.join(repo, "urgent.md"), "planted by hand\n");
  const before = commitCount(repo);
  // A wrapping try/catch, not a bare await: on OLD (pre-round-2) code, gpgsign is never forced off, so the
  // fake always-failing gpg.program makes the underlying `git commit` itself throw — this must be a
  // reportable FAIL, never an uncaught crash that aborts every check after it.
  let result;
  let threw;
  try { result = await commitVault(repo, "loom: gpgsign test"); } catch (err) { threw = err; }
  check("commitVault against a hand-planted commit.gpgsign=true still commits (no throw)", threw === undefined && result === true);
  check("commitVault's commit actually landed", commitCount(repo) === before + 1);
  check("the hand-planted gpg.program did NOT fire under commitVault (gpgsign forced off)", !fs.existsSync(markerPath));

  // POSITIVE CONTROL: the SAME config DOES fire under a plain `git commit`.
  const controlRepo = mkdtempManaged("loom-gpgsign-noexec-control-");
  initRepo(controlRepo);
  const controlScriptPath = path.join(controlRepo, "gpg.sh");
  const controlMarkerPath = path.join(controlRepo, ".git", "gpg-fired");
  fs.writeFileSync(controlScriptPath, `#!/bin/sh\ntouch "${controlRepo.replace(/\\/g, "/")}/.git/gpg-fired"\nexit 1\n`);
  fs.chmodSync(controlScriptPath, 0o755);
  git(controlRepo, "config commit.gpgsign true");
  git(controlRepo, `config gpg.program "${controlScriptPath.replace(/\\/g, "/")}"`);
  fs.writeFileSync(path.join(controlRepo, "urgent.md"), "control\n");
  git(controlRepo, "add .");
  let controlThrew = false;
  try { git(controlRepo, 'commit -m "control commit"'); } catch { controlThrew = true; }
  // A fake, always-failing gpg.program makes the control commit itself FAIL (exit 1) — that failure IS the
  // proof it fired; a real signing program would instead let the commit succeed.
  check("positive control: the SAME commit.gpgsign=true + gpg.program DOES fire under a plain 'git commit' (it fires and fails the commit, proving the detector works)", controlThrew && fs.existsSync(controlMarkerPath));
}

// --- (7) commitVault is unaffected by an ambient GIT_DIR/GIT_WORK_TREE pointing at a different repo ------
// RED PROOF (performed manually, not committed): before `boundedVaultGitAtConfirmedRoot` existed, an
// ambient GIT_DIR/GIT_WORK_TREE (verified live via a standalone probe, same shape as this section) made
// every one of commitVault's git calls operate on the DECOY repo instead of the intended vault — the
// commit landed in the decoy's history, and the vault's own .git was left with zero commits.
{
  const base = mkdtempManaged("loom-ambient-gitdir-");
  const decoy = path.join(base, "decoy");
  const vault = path.join(base, "vault");
  fs.mkdirSync(decoy, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  const cleanEnv = { ...process.env };
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;
  const gitClean = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"], env: cleanEnv }).toString();
  gitClean(decoy, "init");
  gitClean(decoy, "config user.email decoy@example.com");
  gitClean(decoy, "config user.name decoy");

  const savedGitDir = process.env.GIT_DIR;
  const savedWorkTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = path.join(decoy, ".git");
    process.env.GIT_WORK_TREE = decoy;
    fs.writeFileSync(path.join(vault, "urgent.md"), "hello\n");
    const result = await commitVault(vault, "loom: ambient-gitdir test");
    check("commitVault still succeeds despite an ambient GIT_DIR/GIT_WORK_TREE pointing elsewhere", result === true);

    // Resilient to a genuinely missing/broken repo (the exact RED-proof shape on pre-round-2 code, where
    // the vault's own `.git` may never even get created) — a query that can't run reports a count of -1,
    // never an uncaught crash that would abort every check after it.
    const commitCountSafe = (dir) => { try { return parseInt(gitClean(dir, "rev-list --all --count").trim() || "0", 10); } catch { return -1; } };
    const lsFilesSafe = (dir) => { try { return gitClean(dir, "ls-files").trim(); } catch { return "<repo unreadable>"; } };
    const decoyCount = commitCountSafe(decoy);
    const vaultCount = commitCountSafe(vault);
    check("the decoy repo received ZERO commits (never touched)", decoyCount === 0);
    check("the vault's OWN .git received the commit", vaultCount === 1);
    check("the decoy's working tree never received the file", !fs.existsSync(path.join(decoy, "urgent.md")));
    check("the vault's own working tree DOES have the file tracked", lsFilesSafe(vault) === "urgent.md");
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
    if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedWorkTree;
  }
}

console.log(failures === 0
  ? "\nALL PASS — resolveInVault refuses every .git/.obsidian segment form, an ordinary write is " +
    "unaffected, a hand-planted hook/fsmonitor/gpgsign script never fires under commitVault or flushSync, " +
    "and commitVault is immune to an ambient GIT_DIR/GIT_WORK_TREE pointing at a different repo."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
