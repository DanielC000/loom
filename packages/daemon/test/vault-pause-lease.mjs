// Unit test for the vault auto-committer's advisory pause/lease (card 614dfbef, origin finding 4ae8a3c9):
// a manager once had to ask the owner to pause the auto-committer by hand mid-.gitignore/untrack git
// surgery, because it raced the agent's staged changes. Proves VaultVersioner respects a pause lease
// (skips commit/flushSync while held, resumes normally once it expires or is explicitly lifted) and that
// the lease file itself never pollutes vault history or spuriously wakes the watcher. Claude-free, no
// network, no real timers (drives commit()/flushSync() directly rather than waiting on the debounce).
//
// SCENARIO 9 (card 7673d096): `resolveLeaseGitDir` (vault/versioner.ts) used to stat `<commitPath>/.git`
// DIRECTLY, no upward search. A GitWriter op's own `pauseVaultAutoCommit(this.repoPath)` passes the
// project's BOUND path — for a project bound to a SUBDIRECTORY with no `.git` of its own, that call
// silently no-opped (nothing to pause — "no git dir at all"), while `VaultVersioner`'s own tick checks the
// lease at the resolved TOPLEVEL root. So the auto-committer was NEVER actually paused during a
// subdir-bound GitWriter op. `resolveLeaseGitDir` now resolves to the git toplevel first
// (`resolveGitToplevelSync`, shared with `canonicalRepoLockKey`), so both sides land on the same `.git`.
// RED on pre-fix code (verified manually during development by reverting `resolveLeaseGitDir` to its
// pre-fix direct-stat form, rebuilding, and re-running this file — the pause was a silent no-op and the
// edit committed anyway) — GREEN once it resolves the toplevel first.
//
// Run after build: node test/vault-pause-lease.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VaultVersioner, pauseVaultAutoCommit, resumeVaultAutoCommit } from "../dist/vault/versioner.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(mkdtempManaged("loom-vault-pause-lease-"));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();

// 0. Card 40dd6b62: pauseVaultAutoCommit's lease write against a path that is NOT a git repo must be a
// safe no-op — it must NEVER mkdirSync a nested `.git` there, which would make the folder look like a
// real repo to isGitRepo-style checks and worktree cleanup ("nested git repo found and NOT removed").
{
  const nonRepoDir = fs.realpathSync(mkdtempManaged("loom-vault-pause-nonrepo-"));
  const token = pauseVaultAutoCommit(nonRepoDir, 60_000);
  check("non-repo dir: pauseVaultAutoCommit does NOT create a nested .git", !fs.existsSync(path.join(nonRepoDir, ".git")));
  resumeVaultAutoCommit(nonRepoDir, token); // must not throw, and must not create anything either
  check("non-repo dir: resumeVaultAutoCommit on a never-paused non-repo dir is a harmless no-op (still no .git)", !fs.existsSync(path.join(nonRepoDir, ".git")));
}

// 0b. A linked WORKTREE's `.git` is a FILE (a `gitdir: <path>` pointer), not a directory — pre-fix,
// `mkdirSync(path.dirname(leasePath), {recursive:true})` throws EEXIST against that file (verified: the
// throw is swallowed by the function's own best-effort try/catch, so the pointer file survives untouched
// but the lease is NEVER actually written — pausing against a worktree was a SILENT no-op). Post-fix, the
// lease must resolve to the real private gitdir and actually land there.
{
  const wtRoot = fs.realpathSync(mkdtempManaged("loom-vault-pause-wt-"));
  const mainRepo = path.join(wtRoot, "main");
  fs.mkdirSync(mainRepo);
  const gitMain = (...args) => execFileSync("git", args, { cwd: mainRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();
  gitMain("init", "-q");
  gitMain("config", "user.email", "loom-test@example.com");
  gitMain("config", "user.name", "loom-test");
  gitMain("commit", "-q", "--allow-empty", "-m", "init");
  const wtPath = path.join(wtRoot, "wt");
  gitMain("worktree", "add", "-q", wtPath, "-b", "wt-branch");
  const wtGitFile = path.join(wtPath, ".git");
  check("worktree fixture: .git is a FILE (pointer), not a directory", fs.statSync(wtGitFile).isFile());

  // Resolve the real private gitdir ourselves (independent of the fix's own internals) so the assertion
  // below proves the lease landed in the REAL location, not merely that nothing crashed.
  const pointerMatch = fs.readFileSync(wtGitFile, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  const realGitDir = path.resolve(wtPath, pointerMatch[1]);
  const realLeasePath = path.join(realGitDir, "loom-vault-pause.json");

  const wtToken = pauseVaultAutoCommit(wtPath, 60_000);
  check("worktree: .git pointer file is untouched (still a file)", fs.statSync(wtGitFile).isFile());
  check("worktree: the lease ACTUALLY lands in the real private gitdir (not silently dropped)", fs.existsSync(realLeasePath));
  resumeVaultAutoCommit(wtPath, wtToken);
  check("worktree: resume removes the lease from the real private gitdir", !fs.existsSync(realLeasePath));
}

{
  git("init");
  git("config", "user.email", "loom-test@example.com");
  git("config", "user.name", "loom-test");
  fs.writeFileSync(path.join(root, "base.md"), "# base\n");
  git("add", ".");
  git("commit", "-m", "base");

  const versioner = new VaultVersioner(root);
  await versioner.start(); // resolves commitRoot === root (already its own repo, no init needed)
  check("versioner resolved commitRoot to the repo root", versioner.commitRoot === root);

  // 1. No lease held → an edit commits normally.
  fs.writeFileSync(path.join(root, "doc1.md"), "# edit 1\n");
  await versioner.commit();
  check("unpaused: commit() lands a new commit", git("log", "--oneline").trim().split("\n").length === 2);

  // 2. Pause, then edit → commit() must skip (no new commit lands while the lease is held).
  pauseVaultAutoCommit(root, 60_000);
  fs.writeFileSync(path.join(root, "doc2.md"), "# edit 2 (during pause)\n");
  await versioner.commit();
  check("paused: commit() is a no-op (still 2 commits)", git("log", "--oneline").trim().split("\n").length === 2);
  check("paused: the edit sits staged/untracked, not lost", git("status", "--porcelain").includes("doc2.md"));

  // 3. flushSync() (the sync shutdown path) ALSO respects the pause.
  const flushed = versioner.flushSync();
  check("paused: flushSync() returns false and commits nothing", flushed === false && git("log", "--oneline").trim().split("\n").length === 2);

  // 4. Explicit resume lifts the pause immediately → the pending edit now commits.
  resumeVaultAutoCommit(root);
  await versioner.commit();
  check("resumed: commit() lands the previously-paused edit", git("log", "--oneline").trim().split("\n").length === 3);

  // 5. A SHORT lease expires on its own (time-bound, not permanent) → commit() proceeds once past `until`.
  pauseVaultAutoCommit(root, 50);
  fs.writeFileSync(path.join(root, "doc3.md"), "# edit 3 (short lease)\n");
  await new Promise((r) => setTimeout(r, 150)); // past the 50ms lease
  await versioner.commit();
  check("expired lease: commit() proceeds once the lease's time is up", git("log", "--oneline").trim().split("\n").length === 4);

  // 6. The lease file itself lives under .git/ — never git-tracked, never shows up in status/diff noise.
  pauseVaultAutoCommit(root, 60_000);
  check("lease file is NOT tracked/staged (lives under .git/)", !git("status", "--porcelain").includes("loom-vault-pause"));
  resumeVaultAutoCommit(root);

  // 7. resumeVaultAutoCommit on an already-clear lease (or a never-paused repo) is a harmless no-op.
  resumeVaultAutoCommit(root);
  fs.writeFileSync(path.join(root, "doc4.md"), "# edit 4\n");
  await versioner.commit();
  check("double-resume is harmless; commit() still works normally after", git("log", "--oneline").trim().split("\n").length === 5);

  // 8. Per-op token (card 237d1899) + multi-holder (card 6e6b342d): op A pauses, then op B re-pauses the
  // SAME repo while A's lease is still held — simulating two overlapping same-repo GitWriter ops (a real
  // reachable race: REST, Platform, and companion git-push all construct their own GitWriter with no
  // cross-surface mutex). A finishes first; its resume must NOT clear B's lease — B's own entry sits
  // alongside A's in the lease SET (never clobbered out by B's pause), and A's resume removes only A's own
  // entry. Only B's own resume actually lifts the pause (empties the set). See
  // vault-pause-lease-multi-holder.mjs for the data-level proof that B's entry survives byte-for-byte.
  const tokenA = pauseVaultAutoCommit(root, 60_000);
  const tokenB = pauseVaultAutoCommit(root, 60_000); // B "arrives" while A's lease is still held
  resumeVaultAutoCommit(root, tokenA); // A's cleanup — stale token now, must be a no-op
  fs.writeFileSync(path.join(root, "doc5.md"), "# edit 5 (during B's still-held lease)\n");
  await versioner.commit();
  check(
    "A's stale-token resume does not drop B's lease — commit() still a no-op (still 5 commits)",
    git("log", "--oneline").trim().split("\n").length === 5,
  );
  resumeVaultAutoCommit(root, tokenB); // B finishes — its OWN token clears its OWN lease
  await versioner.commit();
  check(
    "B's own-token resume lifts the pause — the pending edit now commits (6 commits)",
    git("log", "--oneline").trim().split("\n").length === 6,
  );

  await versioner.stop();
}

// 9. Card 7673d096 — a GitWriter op bound to a SUBDIRECTORY of the vault's own repo (no `.git` of its
// own) must still actually pause the TOPLEVEL's auto-committer — not silently no-op.
{
  const topRoot = fs.realpathSync(mkdtempManaged("loom-vault-pause-subdir-"));
  const subdir = path.join(topRoot, "teamA");
  fs.mkdirSync(subdir);
  const gitTop = (...args) => execFileSync("git", args, { cwd: topRoot, stdio: ["ignore", "pipe", "pipe"] }).toString();
  gitTop("init");
  gitTop("config", "user.email", "loom-test@example.com");
  gitTop("config", "user.name", "loom-test");
  fs.writeFileSync(path.join(topRoot, "base.md"), "# base\n");
  gitTop("add", ".");
  gitTop("commit", "-m", "base");
  check("subdir fixture: subdir has NO .git of its own", !fs.existsSync(path.join(subdir, ".git")));

  const versioner = new VaultVersioner(topRoot);
  await versioner.start();
  check("versioner resolved commitRoot to the TOPLEVEL (not the subdir)", versioner.commitRoot === topRoot);

  // Pause via the SUBDIR path — exactly what a subdir-bound project's GitWriter op does
  // (`pauseVaultAutoCommit(this.repoPath)`).
  const subdirToken = pauseVaultAutoCommit(subdir, 60_000);
  check(
    "THE BUG: pre-fix, pausing via a subdir with no own .git silently no-opped — the lease now lands at the TOPLEVEL's .git",
    fs.existsSync(path.join(topRoot, ".git", "loom-vault-pause.json")),
  );

  fs.writeFileSync(path.join(topRoot, "doc-subdir-pause.md"), "# edit during subdir-keyed pause\n");
  await versioner.commit();
  check(
    "THE BUG: pre-fix, the auto-committer was NEVER actually paused by a subdir-keyed call — now commit() is a genuine no-op",
    gitTop("log", "--oneline").trim().split("\n").length === 1,
  );
  check("paused via subdir: the edit sits staged/untracked, not committed", gitTop("status", "--porcelain").includes("doc-subdir-pause.md"));

  // Resume, also via the subdir path — must lift the SAME toplevel lease, not create a second one.
  resumeVaultAutoCommit(subdir, subdirToken);
  check("resume via subdir: the toplevel's lease file is gone", !fs.existsSync(path.join(topRoot, ".git", "loom-vault-pause.json")));
  await versioner.commit();
  check("resumed via subdir: the previously-paused edit now commits", gitTop("log", "--oneline").trim().split("\n").length === 2);

  await versioner.stop();
}
// root's own manual finally-block cleanup loop removed here: mkdtempManaged already registered it for
// guaranteed cleanup at process exit (card 995be21f).

// 10. Card 6e6b342d (Minor 3) — a TRANSIENT I/O error reading the lease file (e.g. Windows EBUSY/EPERM on
// a file briefly open elsewhere) must be told apart from genuine CONTENT corruption: the latter safely
// starts fresh (overwrite), but the former must NEVER overwrite — doing so would silently drop a real,
// still-held holder's entry on nothing more than a passing glitch. Injected by monkey-patching the shared
// `fs.readFileSync` (a live property on the one Node "node:fs" module object both this test and
// versioner.ts's own `import fs from "node:fs"` resolve to — verified directly: versioner.ts calls
// `fs.readFileSync(...)` via property access, never a destructured copy, so a patch here is visible there
// too) to throw an EBUSY-coded error for exactly this repo's own lease path, and nothing else's.
{
  const ioRoot = fs.realpathSync(mkdtempManaged("loom-vault-pause-ioerr-"));
  const gitIo = (...args) => execFileSync("git", args, { cwd: ioRoot, stdio: ["ignore", "pipe", "pipe"] }).toString();
  gitIo("init");
  gitIo("config", "user.email", "loom-test@example.com");
  gitIo("config", "user.name", "loom-test");
  fs.writeFileSync(path.join(ioRoot, "base.md"), "# base\n");
  gitIo("add", ".");
  gitIo("commit", "-m", "base");
  const ioLeasePath = path.join(ioRoot, ".git", "loom-vault-pause.json");

  // A real holder pauses first — this is the entry an I/O error on a DIFFERENT (B's) pause must never drop.
  const tokenA10 = pauseVaultAutoCommit(ioRoot, 60_000);
  const beforeContent = fs.readFileSync(ioLeasePath, "utf8");
  check("[10] precondition: A's real entry is on disk before the injected I/O error", fs.existsSync(ioLeasePath));

  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === ioLeasePath) {
      const err = new Error("EBUSY: simulated transient I/O error (test injection)");
      err.code = "EBUSY";
      throw err;
    }
    return origReadFileSync.call(fs, p, ...args);
  };
  let tokenB10;
  try {
    tokenB10 = pauseVaultAutoCommit(ioRoot, 60_000);
  } finally {
    fs.readFileSync = origReadFileSync; // always restore, even if the call above somehow throws
  }
  check("[10] pauseVaultAutoCommit is still best-effort — it returns a token even when the I/O error hits", typeof tokenB10 === "string" && tokenB10.length > 0);
  check(
    "[10] A's real entry is BYTE-FOR-BYTE untouched after B's pause hit a transient I/O error (no overwrite, no drop)",
    fs.readFileSync(ioLeasePath, "utf8") === beforeContent,
  );

  // Behavioral corroboration, not just a file read: a tick must still treat this repo as paused — A's
  // entry alone must still gate it, exactly as if B's pause attempt had never happened.
  const versionerIo = new VaultVersioner(ioRoot, 5000);
  await versionerIo.start();
  fs.writeFileSync(path.join(ioRoot, "edit-during-io-error.md"), "# edit\n");
  await versionerIo.commit();
  check(
    "[10] behaviorally: VaultVersioner.commit() STILL skips (A's entry alone still gates the tick) after B's I/O-error pause — still only the base commit",
    gitIo("log", "--oneline").trim().split("\n").length === 1,
  );
  await versionerIo.stop();

  // Cleanup — resume whichever tokens were actually taken (B10 may be undefined-but-string from the
  // best-effort path; resuming a token that was never actually written is a documented harmless no-op).
  resumeVaultAutoCommit(ioRoot, tokenA10);
  resumeVaultAutoCommit(ioRoot, tokenB10);
}

console.log(failures === 0 ? "\nALL PASS — the advisory pause lease is respected by commit() and flushSync(), and self-expires." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
