import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure real-git exercise.
// Card e7a88047 (round 3 follow-up to 62c4953a, item 4) — commitVault()'s own `checkIndexLock:true` branch
// (merge-eligible vaults only) had no test coverage for a REAL planted `.git/index.lock`, nor for the two
// round-3 fixes layered onto it: (a) maybeAlertStaleVaultLock is now called from INSIDE commitVault's own
// catch (it used to rely on VaultVersioner.commit()'s outer catch, which this refusal — a graceful
// {committed:false}, never a throw — never reaches); (b) the plain console.warn alongside it is now
// rate-limited, since the pre-fix code logged it on every single debounced retry for as long as the lock
// persisted.
//
// SCENARIO A — a real planted lock refuses commitVault(), commits nothing, and the SAME call succeeds
//   once the lock is removed (the basic refusal + its negative control).
// SCENARIO B — the alert fires from INSIDE commitVault's own catch (never relying on an outer catch that
//   this {committed:false} path never reaches) once the lock is stale enough, and does NOT fire again for
//   the SAME lock instance on a second call (maybeAlertStaleVaultLock's own per-lock-instance dedupe).
// SCENARIO C — the plain console.warn is rate-limited: three back-to-back calls against the SAME
//   still-present lock log the warn only once, not three times.
//
// Run: 1) build daemon (pnpm build), 2) node test/vault-commit-index-lock.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

// HERMETICITY (card 500fe2df shape): commitVault's own checkIndexLock:true branch goes through the real
// withCanonicalIndexLock/assertRepoNotQuarantined machinery under LOOM_HOME — isolate before the dist
// import, same as vault-commit-quarantine.mjs / vault-tick-merge-toctou.mjs.
useOwnLoomHome("loom-vcil-home-");
requireHermeticEnv();

const { commitVault, setCodeRepoGuardProvider, VaultVersioner, VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function initRepo(dir) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "vault-index-lock@loom");
  git("config", "user.name", "vault-index-lock");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return git;
}

function commitCount(git) {
  return git("log", "--oneline").trim().split("\n").filter(Boolean).length;
}

/** Registers `repo` as merge-eligible (its own repoPath === the commitPath commitVault resolves) so
 *  commitVault() takes the SAME canonical lock a real merge would — same idiom as
 *  vault-tick-merge-toctou.mjs's own scenarios. */
function makeMergeEligible(repo, tag) {
  setCodeRepoGuardProvider({
    snapshot: () => [{ id: `p-vcil-${tag}`, repoPath: repo, repos: [], vaultOnly: true, vaultPath: repo }],
    recordEvent: () => {},
  });
}

/** Plants a real `.git/index.lock`, backdating its mtime so detectStaleVaultLock's own threshold
 *  (3x VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS) already reads it as stale — never a fixed-wait: the lock's
 *  AGE is set directly, so staleness is deterministic from the instant the file is written. */
function plantStaleIndexLock(repo) {
  const lockPath = path.join(repo, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  const past = new Date(Date.now() - (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 3 + 60_000));
  fs.utimesSync(lockPath, past, past);
  return lockPath;
}

function plantFreshIndexLock(repo) {
  const lockPath = path.join(repo, ".git", "index.lock");
  fs.writeFileSync(lockPath, "");
  return lockPath;
}

const root = fs.realpathSync(mkdtempManaged("loom-vcil-"));

try {
  // ═══════════════════ [A] a real planted lock refuses; the SAME call succeeds once removed ═══════════════════
  {
    const repo = path.join(root, "repo-a");
    fs.mkdirSync(repo);
    const git = initRepo(repo);
    const tag = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    makeMergeEligible(repo, tag);
    try {
      fs.writeFileSync(path.join(repo, "note.md"), "# note a\n"); // a genuine pending change to commit
      const lockPath = plantFreshIndexLock(repo);
      const result = await commitVault(repo, "loom: should be skipped — index lock present");
      check("[A] commitVault() SKIPS (committed:false) while a real .git/index.lock is present", result.committed === false);
      check("[A] nothing was actually committed while the lock is present", commitCount(git) === 1);

      fs.rmSync(lockPath);
      const resultAfterRemoval = await commitVault(repo, "loom: should land now — lock removed");
      check("[A] control: once the lock is removed, the SAME commitVault() call succeeds", resultAfterRemoval.committed === true);
      check("[A] control: the commit actually landed", commitCount(git) === 2 && git("log", "--oneline").includes("lock removed"));
    } finally {
      setCodeRepoGuardProvider(undefined);
    }
  }

  // ═══════════════════ [B] the alert fires from INSIDE commitVault's own catch; dedupes per lock instance ═══════════════════
  {
    const repo = path.join(root, "repo-b");
    fs.mkdirSync(repo);
    initRepo(repo);
    const tag = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    makeMergeEligible(repo, tag);
    try {
      plantStaleIndexLock(repo);
      const events = [];
      const stubDb = { appendEvent: (ev) => { events.push(ev); } };

      const result1 = await commitVault(repo, "loom: should be skipped (B1)", { lockAlert: { db: stubDb, projectId: `p-vcil-${tag}` } });
      check("[B] precondition: commitVault still refuses (stale lock)", result1.committed === false);
      check(
        "[B] the alert fires from INSIDE commitVault's own CanonicalIndexLockPresentError catch (never relying on an outer catch this {committed:false} path never reaches)",
        events.some((e) => e.kind === "vault_index_lock_stale" && e.detail?.repoPath === repo),
      );
      check("[B] the filed event names this project's id", events.some((e) => e.kind === "vault_index_lock_stale" && e.detail?.projectId === `p-vcil-${tag}`));

      // SAME lock instance (mtime unchanged) — a second call must NOT file a second alert event
      // (maybeAlertStaleVaultLock's own per-lock-instance, mtime-keyed dedupe, unaffected by this card).
      const eventsBefore2 = events.length;
      const result2 = await commitVault(repo, "loom: should be skipped (B2)", { lockAlert: { db: stubDb, projectId: `p-vcil-${tag}` } });
      check("[B] second call against the SAME lock instance still refuses", result2.committed === false);
      check("[B] second call does NOT file a second alert for the same lock instance (dedupe by mtime)", events.length === eventsBefore2);
    } finally {
      setCodeRepoGuardProvider(undefined);
    }
  }

  // ═══════════════════ [C] the plain console.warn is rate-limited across repeated debounced retries ═══════════════════
  {
    const repo = path.join(root, "repo-c");
    fs.mkdirSync(repo);
    initRepo(repo);
    const tag = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    makeMergeEligible(repo, tag);
    try {
      plantFreshIndexLock(repo);
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.join(" ")); };
      let r1, r2, r3;
      try {
        r1 = await commitVault(repo, "loom: should be skipped (C1)");
        r2 = await commitVault(repo, "loom: should be skipped (C2)");
        r3 = await commitVault(repo, "loom: should be skipped (C3)");
      } finally {
        console.warn = origWarn;
      }
      check("[C] all three back-to-back calls refuse (lock still present throughout)", r1.committed === false && r2.committed === false && r3.committed === false);
      const lockWarnings = warnings.filter((w) => w.includes("[vault-versioner]") && w.includes("skipping commitVault") && w.includes("canonical_index_lock_present"));
      check(
        "[C] the plain console.warn fired only ONCE across three back-to-back refusals against the same still-present lock (rate-limited, not once per call)",
        lockWarnings.length === 1,
      );
    } finally {
      setCodeRepoGuardProvider(undefined);
    }
  }

  // ═══════════════════ [D] round 2 (Code Review 1260fb58, item 4) — drive it through a REAL VaultVersioner
  // instance, not a direct commitVault() call, so the `{ lockAlert: this.lockAlert }` threading at
  // versioner.ts's own commit() call site is actually pinned — every scenario above calls commitVault()
  // directly and passes its own lockAlert explicitly, which would stay green even if that threading at the
  // real call site were ever dropped. ═══════════════════
  {
    const repo = path.join(root, "repo-d");
    fs.mkdirSync(repo);
    const git = initRepo(repo);
    const tag = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    makeMergeEligible(repo, tag);
    try {
      const events = [];
      const stubDb = { appendEvent: (ev) => { events.push(ev); } };
      // Appended at the tail (3 explicit undefineds for the test-only positional params), same shape as
      // vault-lock-stale-alert.mjs's own Part C construction.
      const versioner = new VaultVersioner(repo, 5000, undefined, undefined, undefined, { db: stubDb, projectId: `p-vcil-${tag}` });
      await versioner.start();

      const countBefore = commitCount(git);
      fs.writeFileSync(path.join(repo, "note-d.md"), "# note d\n"); // a genuine pending change
      plantStaleIndexLock(repo);
      await versioner.commit(); // the real, private debounced path — never commitVault() called directly

      check("[D] a real VaultVersioner.commit() against a stale lock files the alert — pins the `{ lockAlert: this.lockAlert }` threading at its own call site", events.length === 1 && events[0]?.kind === "vault_index_lock_stale");
      check("[D] the filed event names this project's id (proves it's THIS instance's own lockAlert, not some default)", events[0]?.detail?.projectId === `p-vcil-${tag}`);
      check("[D] nothing was actually committed while the lock is present", commitCount(git) === countBefore);

      await versioner.stop();
    } finally {
      setCodeRepoGuardProvider(undefined);
    }
  }
} catch (e) {
  console.error(e);
  failures++;
}

console.log(failures === 0
  ? "\nALL PASS — commitVault() refuses while a real .git/index.lock is present on a merge-eligible vault, " +
    "lands normally once it's removed, files its owner-visible alert from inside its OWN catch (never " +
    "relying on an outer catch this graceful {committed:false} path never reaches), dedupes that alert " +
    "per lock instance, and rate-limits its own plain console.warn across repeated debounced retries."
  : `\n${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
