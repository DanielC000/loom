import "./_guard.mjs"; // FIRST: strips GIT_PAGER/PAGER before GitWriter's simple-git is exercised (§7 below).
// Unit test for the vault push-status VISIBILITY fix (task f48ee77d): the auto-committer is commit-only
// by design (never pushes — see versioner.ts's VaultVersioner doc); this proves the read-only "N commits
// un-pushed" signal added alongside it, PLUS (card 614dfbef) the durable push-FAILURE recording that
// folds into it via GitWriter.push(). Claude-free, no network: the "remote" is a local bare repo.
// Run after build: node test/vault-push-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkVaultPushStatus, logVaultPushStatus, VaultPushStatusWatcher } from "../dist/vault/versioner.js";
import { GitWriter } from "../dist/git/writer.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loom-vault-push-")));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

// A vault repo WITH a configured upstream: a bare "remote", a clone tracking it (origin/main), then a
// commit made locally and NEVER pushed — exactly the 172-ahead scenario from the task's real incident.
const bareRemote = path.join(root, "remote.git");
fs.mkdirSync(bareRemote);
git(bareRemote, "init", "--bare");

const withUpstream = path.join(root, "vaultWithUpstream");
fs.mkdirSync(withUpstream);
git(withUpstream, "init");
git(withUpstream, "checkout", "-b", "main");
git(withUpstream, "config", "user.email", "loom-test@example.com");
git(withUpstream, "config", "user.name", "loom-test");
fs.writeFileSync(path.join(withUpstream, "doc.md"), "# base\n");
git(withUpstream, "add", ".");
git(withUpstream, "commit", "-m", "base");
git(withUpstream, "remote", "add", "origin", bareRemote);
git(withUpstream, "push", "-u", "origin", "main"); // sets upstream tracking; nothing ahead yet

// A vault repo with NO remote at all — the common case for a fresh local-only Obsidian vault.
const noUpstream = path.join(root, "vaultNoUpstream");
fs.mkdirSync(noUpstream);
git(noUpstream, "init");
git(noUpstream, "checkout", "-b", "main");
git(noUpstream, "config", "user.email", "loom-test@example.com");
git(noUpstream, "config", "user.name", "loom-test");
fs.writeFileSync(path.join(noUpstream, "doc.md"), "# solo\n");
git(noUpstream, "add", ".");
git(noUpstream, "commit", "-m", "solo");

try {
  // 1. Freshly pushed repo (0 ahead) → checkVaultPushStatus reports the upstream but ahead:0.
  const clean = await checkVaultPushStatus(withUpstream);
  check("upstream detected right after push", clean !== null && clean.upstream === "origin/main");
  check("0 ahead right after push", clean !== null && clean.ahead === 0);

  // 2. Two MORE local auto-commits, never pushed — mirrors the real "loom: auto-commit" backlog.
  fs.writeFileSync(path.join(withUpstream, "doc2.md"), "# auto-commit 1\n");
  git(withUpstream, "add", ".");
  git(withUpstream, "commit", "-m", "loom: auto-commit 1");
  fs.writeFileSync(path.join(withUpstream, "doc3.md"), "# auto-commit 2\n");
  git(withUpstream, "add", ".");
  git(withUpstream, "commit", "-m", "loom: auto-commit 2");

  const ahead = await checkVaultPushStatus(withUpstream);
  check("ahead-count reflects un-pushed local commits", ahead !== null && ahead.ahead === 2);
  check("commitPath echoed back", ahead !== null && ahead.commitPath === withUpstream);

  // 3. No-remote vault → cleanly skipped (null), not an error, not a false "ahead of nothing".
  const none = await checkVaultPushStatus(noUpstream);
  check("no-upstream vault is skipped cleanly (null)", none === null);

  // 4. logVaultPushStatus over BOTH: only the ahead-by-2 vault comes back; the no-upstream one is silent.
  const unpushed = await logVaultPushStatus([withUpstream, noUpstream]);
  check("logVaultPushStatus returns exactly the vault with unpushed commits", unpushed.length === 1 && unpushed[0].commitPath === withUpstream && unpushed[0].ahead === 2);

  // 5. A vault back in sync (push again) drops out of the unpushed list entirely.
  git(withUpstream, "push");
  const afterPush = await logVaultPushStatus([withUpstream, noUpstream]);
  check("a vault back in sync with origin reports nothing", afterPush.length === 0);

  // 6. VaultPushStatusWatcher.tick() reads the CURRENT commit-path set from its deps closure (not a
  // snapshot taken at construction) and never throws even given a bogus path in the mix.
  fs.writeFileSync(path.join(withUpstream, "doc4.md"), "# auto-commit 3 (never pushed)\n");
  git(withUpstream, "add", ".");
  git(withUpstream, "commit", "-m", "loom: auto-commit 3");
  const bogus = path.join(root, "does-not-exist");
  const watcher = new VaultPushStatusWatcher({ getCommitPaths: () => [withUpstream, noUpstream, bogus] });
  const tickResult = await watcher.tick();
  check("watcher.tick() surfaces the unpushed vault and never throws on a bogus path", tickResult.length === 1 && tickResult[0].ahead === 1);

  // 7. Push-FAILURE surfacing (card 614dfbef, origin finding 4ae8a3c9): the ONE real pusher, GitWriter.push(),
  // durably records its outcome; checkVaultPushStatus must distinguish "N ahead, never tried" (above) from
  // "N ahead because the remote is actively rejecting". First establish real upstream tracking via a
  // successful push, then break the remote's reachability WITHOUT touching the local tracking ref (mirrors
  // the real incident: a remote that starts rejecting while local git state is otherwise intact).
  const pushRecordRoot = path.join(root, "vaultPushRecord");
  fs.mkdirSync(pushRecordRoot);
  git(pushRecordRoot, "init");
  git(pushRecordRoot, "checkout", "-b", "main");
  git(pushRecordRoot, "config", "user.email", "loom-test@example.com");
  git(pushRecordRoot, "config", "user.name", "loom-test");
  fs.writeFileSync(path.join(pushRecordRoot, "doc.md"), "# pr base\n");
  git(pushRecordRoot, "add", ".");
  git(pushRecordRoot, "commit", "-m", "base");
  const pushRecordBare = path.join(root, "pushRecordBare.git");
  fs.mkdirSync(pushRecordBare);
  git(pushRecordBare, "init", "--bare");
  git(pushRecordRoot, "remote", "add", "origin", pushRecordBare);

  const writer = new GitWriter(pushRecordRoot);
  const firstPush = await writer.push(); // no upstream yet -> writer retries with push -u -> succeeds
  check("setup: first push establishes upstream tracking", firstPush.ok === true);
  const statusClean = await checkVaultPushStatus(pushRecordRoot);
  check("setup: clean right after the first push (0 ahead, no failure)", statusClean !== null && statusClean.ahead === 0 && statusClean.lastFailure === undefined);

  fs.writeFileSync(path.join(pushRecordRoot, "doc2.md"), "# unpushed change\n");
  git(pushRecordRoot, "add", ".");
  git(pushRecordRoot, "commit", "-m", "ahead by one");
  git(pushRecordRoot, "remote", "set-url", "origin", path.join(root, "no-such-remote.git")); // remote now unreachable; local tracking ref untouched
  const failedPush = await writer.push();
  check("push against a now-unreachable remote fails (structured)", failedPush.ok === false && typeof failedPush.error === "string");
  const statusAfterFail = await checkVaultPushStatus(pushRecordRoot);
  check("checkVaultPushStatus surfaces the recorded failure", statusAfterFail !== null && statusAfterFail.ahead === 1 && statusAfterFail.lastFailure !== undefined);
  check("recorded failure carries a non-empty error + timestamp", typeof statusAfterFail.lastFailure.error === "string" && statusAfterFail.lastFailure.error.length > 0 && typeof statusAfterFail.lastFailure.at === "string");
  const loggedFailure = await logVaultPushStatus([pushRecordRoot]);
  check("logVaultPushStatus surfaces the failing repo even though ahead>0 alone would already qualify", loggedFailure.length === 1 && loggedFailure[0].lastFailure !== undefined);

  git(pushRecordRoot, "remote", "set-url", "origin", pushRecordBare); // remote reachable again
  const okPush = await writer.push();
  check("a subsequent successful push clears the failure", okPush.ok === true);
  const statusAfterSuccess = await checkVaultPushStatus(pushRecordRoot);
  check("checkVaultPushStatus no longer reports a failure after the successful push", statusAfterSuccess !== null && statusAfterSuccess.ahead === 0 && statusAfterSuccess.lastFailure === undefined);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}

console.log(failures === 0 ? "\nALL PASS — vault push-status is read-only and visible, never pushes." : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
