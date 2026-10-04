// Unit test for card 227d9f0b: a stale `.git/index.lock` left behind by a killed git child (an
// execSync/execFileSync timeout, a crash, a reboot) previously made every later commitVault/flushSync
// fail SILENTLY, forever, with nothing owner-visible — see decision 227d9f0b for the full design
// (stat-only detection, why message-classification was rejected as the primary signal, and why no
// auto-removal is sound on Windows with this codebase's tools). Proves: (a) a genuinely stale lock is
// detected + files ONE durable `vault_index_lock_stale` event + an on-disk dedupe marker; (b) a repeat
// detection against the SAME lock instance does NOT duplicate the event; (c) a FRESH lock (younger than
// the threshold) and a commit failure with NO lock file at all are both correctly ignored (negative
// controls); (d) the lock file itself is NEVER removed (no auto-removal). Also proves the
// VaultPushStatusWatcher's proactive, stat-only tick surfaces an idle vault's stuck lock, fires once,
// then re-fires only once the lock's own mtime changes. Claude-free, no network, no real timers — ages a
// lock by backdating its real mtime via fs.utimesSync rather than waiting out VAULT_LOCK_STALE_THRESHOLD_MS.
//
// ROUND 2 (Code Review 0858c93d of 41529894) additions — see decision 227d9f0b's round-2 section:
//   (A2) a linked git WORKTREE vault (`.git` is a FILE, not a directory) is detected + alerted via the
//        gitfile-aware resolution detectStaleVaultLock/maybeAlertStaleVaultLock now share with the
//        advisory pause lease (resolveLeaseGitDir) — the round-1 direct `.git/index.lock` join never
//        found a worktree's real lock at all.
//   (E) the dedupe marker is written ONLY after a successful appendEvent, and ONLY when db is set — a
//       throwing db.appendEvent must leave NO marker, so the very next call retries.
//   (C2) flushSync()'s OWN catch-site wiring, standalone (no prior commit() call) — proves the catch site
//        itself calls maybeAlertStaleVaultLock, not merely that dedupe prevents a duplicate.
//   (F) the watcher tick's CLEAR half: a marker present + lock absent files ONE vault_index_lock_cleared
//       event and removes the marker; a still-stuck lock, or no prior marker, is correctly a no-op.
//
// Run after build: node test/vault-lock-stale-alert.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  detectStaleVaultLock, maybeAlertStaleVaultLock, VaultVersioner, VaultPushStatusWatcher,
} from "../dist/vault/versioner.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeFakeDb() {
  const events = [];
  return { events, appendEvent: (evt) => { events.push(evt); return events.length; } };
}

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init");
  git("config", "user.email", "loom-test@example.com");
  git("config", "user.name", "loom-test");
  fs.writeFileSync(path.join(root, "doc.md"), "# base\n");
  git("add", ".");
  git("commit", "-m", "base");
  return git;
}

// A lock file old enough to clear VAULT_LOCK_STALE_THRESHOLD_MS (15min) without waiting: backdate its
// mtime by well over an hour.
function plantStaleLock(root) {
  const lockPath = path.join(root, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
  fs.utimesSync(lockPath, old, old);
  return lockPath;
}

function plantFreshLock(root) {
  const lockPath = path.join(root, ".git", "index.lock");
  fs.writeFileSync(lockPath, ""); // mtime = now — younger than the threshold
  return lockPath;
}

// === Part A: detectStaleVaultLock (direct, stat-only) ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-detect-"));
  initRepo(root);
  check("no lock file at all -> not stale (null)", detectStaleVaultLock(root) === null);

  const freshLock = plantFreshLock(root);
  check("a FRESH lock (just created) -> not stale (null)", detectStaleVaultLock(root) === null);
  fs.rmSync(freshLock);

  const staleLock = plantStaleLock(root);
  const info = detectStaleVaultLock(root);
  check("a genuinely stale (backdated) lock -> detected", info !== null);
  check("detected lockPath matches the real .git/index.lock", info !== null && info.lockPath === staleLock);
  check("detected ageMs reflects the real backdated age (> 1h)", info !== null && info.ageMs > 60 * 60 * 1000);
  fs.rmSync(staleLock);
}

// === Part A2 (Round 2 item 1): a linked git WORKTREE vault — `.git` is a FILE (a `gitdir: <path>`
// pointer), not a directory, and its own index.lock lives in the PRIVATE gitdir that pointer names, never
// under `<wtPath>/.git/`. Pre-fix, `path.join(wtPath, ".git", "index.lock")` would try to stat a path
// UNDER a plain FILE — never finds the real lock, and the on-disk marker would try to write under that
// same file too. Resolve the real location ourselves (independent of the fix's own internals, same
// pattern as vault-pause-lease.mjs's own worktree fixture) so the assertions below prove detection/alert
// actually reach the REAL private gitdir, not merely that nothing crashed. ===
{
  const wtRoot = fs.realpathSync(mkdtempManaged("loom-vault-lock-wt-"));
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

  const pointerMatch = fs.readFileSync(wtGitFile, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  const realGitDir = path.resolve(wtPath, pointerMatch[1]);
  const realLockPath = path.join(realGitDir, "index.lock");
  fs.writeFileSync(realLockPath, "");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(realLockPath, old, old);

  const wtInfo = detectStaleVaultLock(wtPath);
  check("worktree: detectStaleVaultLock resolves to the REAL private-gitdir lock, not <wtPath>/.git/index.lock", wtInfo !== null && wtInfo.lockPath === realLockPath);

  const wtFakeDb = makeFakeDb();
  const wtAlertResult = maybeAlertStaleVaultLock(wtPath, { db: wtFakeDb, projectId: "proj-wt" });
  check("worktree: maybeAlertStaleVaultLock detects + files ONE event", wtAlertResult !== null && wtFakeDb.events.length === 1);
  check("worktree: filed event's lockPath is the REAL private-gitdir path", wtFakeDb.events[0]?.detail?.lockPath === realLockPath);
  check("worktree: the dedupe marker lands in the REAL private gitdir (not silently dropped)", fs.existsSync(path.join(realGitDir, "loom-vault-lock-alert.json")));

  // A repeat call against the SAME lock instance must still dedupe correctly through the worktree path.
  const wtRepeat = maybeAlertStaleVaultLock(wtPath, { db: wtFakeDb, projectId: "proj-wt" });
  check("worktree: a repeat detection against the SAME lock instance does not duplicate the event", wtRepeat !== null && wtFakeDb.events.length === 1);
  fs.rmSync(realLockPath);
}

// === Part B: maybeAlertStaleVaultLock — fires once, dedupes, negative controls, never removes the lock ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-alert-"));
  initRepo(root);
  const fakeDb = makeFakeDb();

  // (c) negative control 1: a commit "failure" with NO lock file present at all.
  const noLockResult = maybeAlertStaleVaultLock(root, { db: fakeDb, projectId: "proj-x" }, new Error("fatal: some unrelated git error"));
  check("(c) no lock file present -> returns null, no event filed", noLockResult === null && fakeDb.events.length === 0);

  // (c) negative control 2: a FRESH lock (younger than the threshold) must be ignored, even with a
  // message that WOULD corroborate if the stat check didn't gate it.
  const freshLock = plantFreshLock(root);
  const freshErr = new Error(`fatal: Unable to create '${freshLock}': File exists.\n\nAnother git process seems to be running in this repository.`);
  const freshResult = maybeAlertStaleVaultLock(root, { db: fakeDb, projectId: "proj-x" }, freshErr);
  check("(c) a FRESH lock (younger than threshold) -> ignored, no event filed", freshResult === null && fakeDb.events.length === 0);
  fs.rmSync(freshLock);

  // (a) a genuinely stale lock, with the real corroborating git message -> ONE event filed.
  const staleLock = plantStaleLock(root);
  const realMessage = `fatal: Unable to create '${staleLock}': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again. If it still fails, a git process\nmay have crashed in this repository earlier:\nremove the file manually to continue.`;
  const staleErr = new Error(realMessage);
  const firstResult = maybeAlertStaleVaultLock(root, { db: fakeDb, projectId: "proj-x" }, staleErr);
  check("(a) a genuinely stale lock -> detected", firstResult !== null);
  check("(a) exactly ONE event filed", fakeDb.events.length === 1);
  const evt = fakeDb.events[0];
  check("(a) event kind is vault_index_lock_stale", evt?.kind === "vault_index_lock_stale");
  check("(a) event is daemon-global (managerSessionId '')", evt?.managerSessionId === "");
  check("(a) detail.projectId stamped from lockAlert.projectId", evt?.detail?.projectId === "proj-x");
  check("(a) detail.repoPath is the repo root", evt?.detail?.repoPath === root);
  check("(a) detail.lockPath is the real lock path", evt?.detail?.lockPath === staleLock);
  check("(a) detail.ageMs is a large positive number", typeof evt?.detail?.ageMs === "number" && evt.detail.ageMs > 60 * 60 * 1000);
  check("(a) detail.command names the lock path", typeof evt?.detail?.command === "string" && evt.detail.command.includes(staleLock));
  check("(a) detail.caveat warns about a mid-operation editor/GUI", typeof evt?.detail?.caveat === "string" && /editor|GUI/i.test(evt.detail.caveat));
  check("(a) a REAL git fatal message corroborates (secondary signal, not required)", evt?.detail?.corroboratedByMessage === true);
  check("(a) a dedupe marker file was written under .git/", fs.existsSync(path.join(root, ".git", "loom-vault-lock-alert.json")));
  check("(d) the lock file itself is NEVER removed (no auto-removal)", fs.existsSync(staleLock));

  // (b) a REPEAT detection against the SAME lock instance (same mtime) must NOT duplicate the event.
  const secondResult = maybeAlertStaleVaultLock(root, { db: fakeDb, projectId: "proj-x" }, staleErr);
  check("(b) repeat detection against the SAME lock instance -> still detected (info returned)", secondResult !== null);
  check("(b) but NO duplicate event filed (still exactly 1)", fakeDb.events.length === 1);
  check("(b) the lock file is still untouched after the repeat (no auto-removal)", fs.existsSync(staleLock));

  // A genuinely NEW lock instance (a different mtime) — simulating a human clearing the old one and a
  // fresh one later getting stuck too — must re-fire.
  fs.rmSync(staleLock);
  const secondStaleLock = plantStaleLock(root);
  const thirdResult = maybeAlertStaleVaultLock(root, { db: fakeDb, projectId: "proj-x" });
  check("a genuinely NEW lock instance (different mtime) -> detected", thirdResult !== null);
  check("a genuinely NEW lock instance -> re-fires (now 2 events total)", fakeDb.events.length === 2);
  check("the second event carries no corroboratedByMessage (no err passed this time)", fakeDb.events[1]?.detail?.corroboratedByMessage === undefined);
  fs.rmSync(secondStaleLock);

  // `lockAlert.db` absent -> detection still runs, but no event is filed (the established
  // optional-dep/silent-no-op-when-absent posture every other test-only dep in this module follows).
  const thirdStaleLock = plantStaleLock(root);
  const noDbResult = maybeAlertStaleVaultLock(root, {});
  check("db absent -> detection still returns info", noDbResult !== null);
  check("db absent -> no event filed (still 2)", fakeDb.events.length === 2);
  fs.rmSync(thirdStaleLock);
}

// === Part B2 (Round 2 item 2): the dedupe marker is written ONLY after a successful appendEvent, and
// ONLY when db is set — a swallowed append failure must leave NO marker, so the very next call retries
// filing the event for the SAME lock instance (pre-fix: the marker was written unconditionally, so a
// throwing appendEvent still silenced that lock forever). ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-marker-after-success-"));
  initRepo(root);
  const markerPath = path.join(root, ".git", "loom-vault-lock-alert.json");

  // (i) a THROWING db.appendEvent must write NO marker, and must be retried on the next call.
  const throwingDb = { appendEvent: () => { throw new Error("simulated durable-write failure"); } };
  const staleLock = plantStaleLock(root);
  const throwResult = maybeAlertStaleVaultLock(root, { db: throwingDb, projectId: "proj-y" });
  check("(i) a throwing appendEvent still returns the detected info (never throws into the caller)", throwResult !== null);
  check("(i) a throwing appendEvent -> NO marker is written", !fs.existsSync(markerPath));

  const realDb = makeFakeDb();
  const retryResult = maybeAlertStaleVaultLock(root, { db: realDb, projectId: "proj-y" });
  check("(i) the SAME lock instance retried against a working db -> files the event this time", retryResult !== null && realDb.events.length === 1);
  check("(i) the marker now exists, written only after the successful append", fs.existsSync(markerPath));
  fs.rmSync(staleLock);

  // (ii) `lockAlert.db` absent entirely -> no event, and (same posture) no marker either.
  const root2 = fs.realpathSync(mkdtempManaged("loom-vault-lock-marker-no-db-"));
  initRepo(root2);
  const markerPath2 = path.join(root2, ".git", "loom-vault-lock-alert.json");
  const staleLock2 = plantStaleLock(root2);
  const noDbResult = maybeAlertStaleVaultLock(root2, {});
  check("(ii) db absent -> detection still returns info", noDbResult !== null);
  check("(ii) db absent -> no marker written (no event was ever filed to succeed)", !fs.existsSync(markerPath2));
  fs.rmSync(staleLock2);
}

// === Part C: end-to-end through VaultVersioner.commit()/flushSync() — proves the catch-site wiring,
// not just the standalone function, actually fires on a real add/commit failure. ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-e2e-"));
  initRepo(root);
  const fakeDb = makeFakeDb();
  // Appended at the tail (3 explicit undefineds for the test-only positional params) — see the
  // constructor's own doc (card 227d9f0b).
  const versioner = new VaultVersioner(root, 5000, undefined, undefined, undefined, { db: fakeDb, projectId: "proj-e2e" });
  await versioner.start();

  fs.writeFileSync(path.join(root, "doc2.md"), "# pending edit\n");
  const staleLock = plantStaleLock(root);
  await versioner.commit(); // commitVault's own git add . hits the stuck lock and throws
  check("VaultVersioner.commit() against a real stuck lock -> files ONE alert event", fakeDb.events.length === 1 && fakeDb.events[0]?.kind === "vault_index_lock_stale");
  check("VaultVersioner.commit() never removes the lock itself", fs.existsSync(staleLock));

  const flushed = versioner.flushSync(); // flushSync's own git add -A ALSO hits the same stuck lock
  check("flushSync() against the SAME still-stuck lock -> returns false (commit dropped, not thrown)", flushed === false);
  check("flushSync() does NOT duplicate the alert (same lock instance, still 1 event)", fakeDb.events.length === 1);

  await versioner.stop();
  fs.rmSync(staleLock);
}

// === Part C2 (Round 2 item 3): flushSync()'s OWN catch-site wiring, standalone — Part C above only calls
// flushSync() AFTER commit() has already fired+marked the alert, so a flushSync() catch that never called
// maybeAlertStaleVaultLock at all would still pass that "doesn't duplicate" assertion — dedupe state
// masks the omission. This fixture calls ONLY flushSync() against a stale lock, with NO prior commit()
// call, and asserts the event fires on its own. RED if flushSync()'s own maybeAlertStaleVaultLock call is
// removed (verified manually during development: commenting it out drops this assertion's event count to
// 0). ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-flushsync-only-"));
  initRepo(root);
  const fakeDb = makeFakeDb();
  const versioner = new VaultVersioner(root, 5000, undefined, undefined, undefined, { db: fakeDb, projectId: "proj-flushsync-only" });
  await versioner.start();

  fs.writeFileSync(path.join(root, "doc3.md"), "# pending edit for flushSync-only\n");
  const staleLock = plantStaleLock(root);
  const flushed = versioner.flushSync(); // flushSync's OWN git add -A hits the stuck lock — ITS catch site must fire the alert
  check("flushSync()-only: returns false (commit dropped, not thrown)", flushed === false);
  check("flushSync()-only (no prior commit() call): files ONE alert event on its own catch-site wiring", fakeDb.events.length === 1 && fakeDb.events[0]?.kind === "vault_index_lock_stale");
  check("flushSync()-only: never removes the lock itself", fs.existsSync(staleLock));

  await versioner.stop();
  fs.rmSync(staleLock);
}

// === Part D: VaultPushStatusWatcher's proactive, stat-only tick — an IDLE vault (no pending edit, no
// git exec at all on this path) still surfaces a stuck lock; fires once, then not again until the lock's
// own mtime changes. ===
{
  const idleRoot = fs.realpathSync(mkdtempManaged("loom-vault-lock-tick-"));
  initRepo(idleRoot);
  const fakeDb = makeFakeDb();
  const watcher = new VaultPushStatusWatcher({
    getCommitPaths: () => [idleRoot],
    db: fakeDb,
    projectIdForPath: (p) => (p === idleRoot ? "proj-tick" : undefined),
  });

  check("an idle vault with NO stale lock -> tick() files nothing", (await watcher.tick(), fakeDb.events.length === 0));

  const staleLock = plantStaleLock(idleRoot);
  await watcher.tick();
  check("tick() detects a stuck lock on an IDLE vault (no pending edit) and files ONE event", fakeDb.events.length === 1);
  check("the filed event carries the wired projectId", fakeDb.events[0]?.detail?.projectId === "proj-tick");

  await watcher.tick();
  check("a SECOND tick against the SAME lock instance does NOT re-fire", fakeDb.events.length === 1);

  // A genuinely new lock instance (different mtime) re-fires.
  fs.rmSync(staleLock);
  const secondStaleLock = plantStaleLock(idleRoot);
  await watcher.tick();
  check("a NEW lock instance (different mtime) on a later tick DOES re-fire (now 2)", fakeDb.events.length === 2);
  check("tick() never removes the lock file itself", fs.existsSync(secondStaleLock));
  fs.rmSync(secondStaleLock);

  // Negative control: a watcher constructed WITHOUT db (every pre-existing push-status-only
  // construction) must behave exactly as before — the stale-lock side of tick() is a no-op.
  const bareWatcher = new VaultPushStatusWatcher({ getCommitPaths: () => [idleRoot] });
  const anotherStaleLock = plantStaleLock(idleRoot);
  const tickResult = await bareWatcher.tick();
  check("a watcher with NO db dep -> tick() still returns normally (push-status behavior unaffected)", Array.isArray(tickResult));
  fs.rmSync(anotherStaleLock);
}

// === Part F (Round 2 item 4): the watcher tick's CLEAR half — "marker present + lock absent" files ONE
// vault_index_lock_cleared event and removes the marker; a still-stuck lock, or a repo with no prior
// alert, is correctly a no-op. ===
{
  const root = fs.realpathSync(mkdtempManaged("loom-vault-lock-clear-"));
  initRepo(root);
  const fakeDb = makeFakeDb();
  const watcher = new VaultPushStatusWatcher({
    getCommitPaths: () => [root],
    db: fakeDb,
    projectIdForPath: (p) => (p === root ? "proj-clear" : undefined),
  });
  const markerPath = path.join(root, ".git", "loom-vault-lock-alert.json");

  // (i) no prior alert at all -> the clear check is a no-op (no marker to clear).
  await watcher.tick();
  check("(i) a repo that was never alerted -> tick() clears nothing", fakeDb.events.length === 0 && !fs.existsSync(markerPath));

  // (ii) a genuinely stuck lock -> the alert half fires, marker written; the clear half is a no-op
  // because the lock is STILL there (checked in this SAME tick, right after the alert half ran).
  const staleLock = plantStaleLock(root);
  await watcher.tick();
  check("(ii) a stuck lock -> ONE stale event filed, marker present", fakeDb.events.length === 1 && fakeDb.events[0]?.kind === "vault_index_lock_stale" && fs.existsSync(markerPath));

  // (iii) the lock is now removed (simulating a human clearing it) but nothing has observed that yet —
  // a tick where the marker is present AND the lock is absent must file the paired cleared event and
  // remove the marker.
  fs.rmSync(staleLock);
  await watcher.tick();
  check("(iii) marker present + lock absent -> ONE vault_index_lock_cleared event filed (now 2 total)", fakeDb.events.length === 2 && fakeDb.events[1]?.kind === "vault_index_lock_cleared");
  check("(iii) the cleared event carries the repoPath + wired projectId", fakeDb.events[1]?.detail?.repoPath === root && fakeDb.events[1]?.detail?.projectId === "proj-clear");
  check("(iii) the marker is removed once cleared", !fs.existsSync(markerPath));

  // (iv) a FURTHER tick with no marker and no lock -> no-op, no duplicate cleared event.
  await watcher.tick();
  check("(iv) a later tick with nothing left to clear -> no duplicate cleared event (still 2)", fakeDb.events.length === 2);

  // (v) a genuinely NEW stale episode after a clear -> re-fires + re-clears normally (the full cycle).
  const secondStaleLock = plantStaleLock(root);
  await watcher.tick();
  check("(v) a fresh stale episode after a clear -> re-fires (now 3)", fakeDb.events.length === 3 && fakeDb.events[2]?.kind === "vault_index_lock_stale");
  fs.rmSync(secondStaleLock);
  await watcher.tick();
  check("(v) and clears again once the lock disappears (now 4)", fakeDb.events.length === 4 && fakeDb.events[3]?.kind === "vault_index_lock_cleared");
  check("(v) the marker is removed again after the second clear", !fs.existsSync(markerPath));
}

console.log(failures === 0 ? "\nALL PASS — a stale vault .git/index.lock is detected, alerted exactly once per instance, never auto-removed, and surfaced even on an idle vault via the proactive tick." : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
