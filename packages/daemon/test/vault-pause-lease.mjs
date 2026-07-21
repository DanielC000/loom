// Unit test for the vault auto-committer's advisory pause/lease (card 614dfbef, origin finding 4ae8a3c9):
// a manager once had to ask the owner to pause the auto-committer by hand mid-.gitignore/untrack git
// surgery, because it raced the agent's staged changes. Proves VaultVersioner respects a pause lease
// (skips commit/flushSync while held, resumes normally once it expires or is explicitly lifted) and that
// the lease file itself never pollutes vault history or spuriously wakes the watcher. Claude-free, no
// network, no real timers (drives commit()/flushSync() directly rather than waiting on the debounce).
// Run after build: node test/vault-pause-lease.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VaultVersioner, pauseVaultAutoCommit, resumeVaultAutoCommit } from "../dist/vault/versioner.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-vault-pause-lease-")));
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();

try {
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

  await versioner.stop();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

console.log(failures === 0 ? "\nALL PASS — the advisory pause lease is respected by commit() and flushSync(), and self-expires." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
