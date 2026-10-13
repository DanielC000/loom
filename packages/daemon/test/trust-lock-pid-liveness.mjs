// Hermetic test for pty/claude-config.ts's pid-liveness trust-lock fix (card 5b97da80).
//
// Before this card, withTrustLock's stale-break check used ONE constant (trustLockMs(), default
// 5000ms) for two different things: how long a waiter personally waits before giving up (the acquire
// deadline), and how old a held lock must be before it's assumed abandoned. Conflating them meant a
// lock held continuously by a genuinely LIVE (not crashed) process for that long was broken out from
// under it by any other process that happened to poll at that moment — a real, measured lost update
// (see docs/decisions/5b97da80-*.md).
//
// The fix: the lock file's own content now records the holder's pid. A waiter breaks a held lock only
// when (a) the recorded holder pid is CONFIRMED DEAD (process.kill(pid,0) throws ESRCH), or (b) the
// lock is older than a hard ceiling (max(10*trustLockMs(), 60s)) — a backstop against the OS reusing a
// crashed holder's pid for an unrelated live process, which would otherwise make pure pid-liveness wedge
// forever.
//
// Section (0) is the real-process lost-update repro this card's own investigation used, turned into a
// committed real-process regression test — with a DETERMINISTIC HANDSHAKE (see that section's own
// comment) instead of a wall-clock margin: B waits for an OBSERVABLE signal that A actually holds the
// lock (the lock file's own existence — attemptCreateLock's `wx` create succeeds, and ONLY THEN does
// withTrustLock call `fn()`, so "lock file exists" IS "A is now in the lock"), then attempts with its
// OWN acquire deadline (LOOM_TRUST_LOCK_MS) set far beyond ANY realistic hold A could have — so B never
// reaches its own give-up-and-degrade path (a separate, still-accepted tradeoff, see
// EnsureTrustedResult's own doc) regardless of how slow the host is. With B's own deadline taken out of
// the race, the ONLY thing left that can decide the outcome is shouldBreakLock's pid-liveness check —
// exactly the mechanism card 5b97da80 fixed.
//
// @decision cacc9f8a — this section no longer discriminates pre-/post-fix code by itself; do not
// re-introduce a wall-clock margin to try to make it do so. See docs/decisions/cacc9f8a-trust-lock-case0-deadline.md.
//
// Run after build: node test/trust-lock-pid-liveness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureTrusted, removeClaudeConfigEntryForWorktree,
} from "../dist/pty/claude-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const writer = path.join(here, "_trust-writer.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const readEntries = (cfgPath) => { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects ?? {}; } catch { return {}; } };
const trusted = (cfgPath, key) => {
  const e = readEntries(cfgPath)[key];
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
};

const root = path.join(os.tmpdir(), `loom-trust-lock-pid-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

// Isolate from the real $HOME, same convention as trust-lock.mjs / trust-lock-fault-injection.mjs.
const fakeHome = path.join(root, "fake-home");
fs.mkdirSync(fakeHome, { recursive: true });

const savedCfg = process.env.CLAUDE_CONFIG_DIR;
const savedLockMs = process.env.LOOM_TRUST_LOCK_MS;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", savedCfg], ["LOOM_TRUST_LOCK_MS", savedLockMs], ["HOME", savedHome], ["USERPROFILE", savedUserProfile]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

const realJson = path.join(os.homedir(), ".claude.json");
const realBefore = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;

// A pid guaranteed to be DEAD right now: spawn a trivial child and wait for it to actually exit.
function mintDeadPid() {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return res.pid;
}

// A pid guaranteed to be ALIVE right now: this test process's own pid. Stands in for the hazard
// condition the hard ceiling defends against — the OS having reused a crashed holder's pid for an
// unrelated live process, which must never be mistaken for "the original holder is still working".
const alivePid = process.pid;

const writeLock = (lockPath, content, ageMs) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, content);
  if (ageMs != null) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lockPath, t, t);
  }
};

const run = (configDir, dir, startAt, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [writer, configDir, dir, String(startAt)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });

// Late-arrival variant (section 0) — waits for the lock to actually exist, then a fixed extra delay.
// See _trust-writer-delayed.mjs's own doc for why this replaces a shared wall-clock startAt here.
const delayedWriter = path.join(here, "_trust-writer-delayed.mjs");
const runDelayed = (configDir, dir, delayMs, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [delayedWriter, configDir, dir, String(delayMs)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });

const main = async () => {
  // === (0) THE LOST-UPDATE REPRO, as a committed test. Two REAL child processes against a big enough
  // file that the in-lock work genuinely takes a while (measured ~230-270ms at 60,000 entries on this
  // class of host) — the exact shape the investigation used to reproduce the bug against real
  // production code.
  //   - A starts immediately. Its hold has TWO phases that both matter here: a FAST-PATH read of the
  //     big (180,000-entry) file BEFORE it even attempts the lock (measured ~400-600ms on this host —
  //     ensureTrusted always does this, lock or no lock), then the actual in-lock read+merge+write
  //     (measured ~600ms at this size). Total hold ≈1000ms on a quiet host.
  //   - B waits for the lock to actually exist (a DETERMINISTIC HANDSHAKE: `attemptCreateLock`'s `wx`
  //     create succeeds, and ONLY THEN does `withTrustLock` call `fn()` — so "lock file exists" IS "A is
  //     now genuinely in the lock", an OBSERVABLE signal, not an estimate), then attempts (delayMs=0
  //     below — B's OWN fast-path read of the same big file already provides a realistic arrival delay).
  // B's OWN acquire deadline (`BIG_DEADLINE_MS`, below) is set far beyond ANY realistic hold A could have
  // — tens of seconds vs. A's ~1-2s — so B NEVER reaches its own give-up-and-degrade path (see
  // EnsureTrustedResult's own doc for that separate, still-accepted tradeoff), regardless of host speed.
  // With that deadline taken out of the race, B just keeps polling every 50ms until A naturally
  // releases: on POST-FIX code, `shouldBreakLock` correctly refuses to break A's confirmed-alive-pid lock
  // the whole time (the hard ceiling is nowhere near reached either), so B acquires normally once A
  // releases — no break, no degrade, both writes survive, deterministically. See
  // docs/decisions/cacc9f8a-trust-lock-case0-deadline.md for why this means pre-fix code now behaves
  // identically here (this section is no longer the file's RED/GREEN proof — sections (1)/(3) are). ===
  {
    const configDir = path.join(root, "lost-update");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");

    const projects = {};
    for (let i = 0; i < 180_000; i++) {
      projects[`C:/Users/synthetic/project-${i}`] = {
        hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
        disabledMcpjsonServers: ["docker", "sentry"], enabledMcpjsonServers: [], enableAllProjectMcpServers: false,
      };
    }
    fs.writeFileSync(isoJson, JSON.stringify({ projects }, null, 2));

    const dirA = path.join(root, "lost-update-A");
    const dirB = path.join(root, "lost-update-B");
    // Far beyond any realistic hold A could have (~1-2s even under heavy gate-lane contention) — see
    // docs/decisions/cacc9f8a-trust-lock-case0-deadline.md for why this value must not be shrunk back
    // down to "discriminate" pre-/post-fix code again.
    const BIG_DEADLINE_MS = "20000";
    const env = { LOOM_TRUST_LOCK_MS: BIG_DEADLINE_MS };
    const [codeA, codeB] = await Promise.all([
      run(configDir, dirA, Date.now(), env), // A: no deliberate wait, starts as soon as it's ready
      runDelayed(configDir, dirB, 0, env), // B: waits for A's lock to exist, then attempts immediately — see comment above
    ]);

    const aSurvived = trusted(isoJson, keyFor(dirA));
    const bSurvived = trusted(isoJson, keyFor(dirB));
    check("(0) both children exited 0", codeA === 0 && codeB === 0);
    check(`(0) NEITHER concurrent writer's trust entry was lost (A survived=${aSurvived}, B survived=${bSurvived}) — proves two REAL concurrent OS processes never lose a write under genuine filesystem lock contention, with B's own give-up deadline taken out of the race entirely`,
      aSurvived && bSurvived);
  }

  // === (1) A lock recorded with a CONFIRMED-ALIVE pid, lightly aged (well under the hard ceiling), is
  // NEVER broken on account of age alone — ensureTrusted must wait out its own acquire deadline and
  // THEN degrade to best-effort (same bounded-wait shape as the pre-existing "(b) held lock" test in
  // trust-lock.mjs), reporting locked:false with a reason. ===
  {
    const configDir = path.join(root, "alive-not-broken");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    writeLock(lockPath, JSON.stringify({ pid: alivePid, acquiredAt: Date.now() - 200 }), 200);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "300";
    const proj = path.join(root, "alive-not-broken-proj");

    const calibT0 = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    const calibDt = performance.now() - calibT0;
    const overshoot = Math.max(1, calibDt / 50);

    const t0 = performance.now();
    const result = ensureTrusted(proj);
    const dt = performance.now() - t0;
    const bound = 300 * overshoot * 3;

    check(`(1) alive-pid lock held → ensureTrusted waited roughly the full deadline before degrading (${dt.toFixed(1)}ms, expect >= ~300ms, bound ${bound.toFixed(0)}ms)`,
      dt < bound && dt > 100); // generous lower bound: a near-instant return would mean it was wrongly broken
    check("(1) alive-pid lock → still wrote best-effort (degrades, never refuses)", trusted(isoJson, keyFor(proj)));
    check(`(1) alive-pid lock → ensureTrusted reports locked:false with a reason (got ${JSON.stringify(result)})`,
      result.locked === false && typeof result.reason === "string" && result.reason.length > 0);
    try { fs.rmSync(lockPath); } catch { /* best-effort */ }
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // === (2) The SAME alive-pid lock, but aged PAST the hard ceiling, IS broken regardless of the pid
  // probe — the required backstop against OS pid reuse wedging the lock forever. ===
  {
    const configDir = path.join(root, "alive-past-ceiling");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "500"; // ceiling = max(10*500, 60_000) = 60_000ms
    writeLock(lockPath, JSON.stringify({ pid: alivePid, acquiredAt: Date.now() - 120_000 }), 120_000); // well past the 60s ceiling
    const proj = path.join(root, "alive-past-ceiling-proj");

    const t0 = performance.now();
    ensureTrusted(proj);
    const dt = performance.now() - t0;

    check(`(2) alive-pid lock PAST the hard ceiling → broken promptly, not waited out (${dt.toFixed(1)}ms, timeout 500ms)`, dt < 250);
    check("(2) ceiling-broken lock → write succeeded", trusted(isoJson, keyFor(proj)));
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // === (3) A lock recorded with a CONFIRMED-DEAD pid, FRESH mtime (nowhere near even the old 5000ms
  // threshold, let alone the new 60s ceiling), is broken near-instantly — the crash-recovery
  // improvement: a crash is now detected on the FIRST poll, not only after the lock ages out. ===
  {
    const configDir = path.join(root, "dead-pid-fast");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    const deadPid = mintDeadPid();
    writeLock(lockPath, JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }), 0); // fresh mtime
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "5000"; // generous — proves this ISN'T waited out
    const proj = path.join(root, "dead-pid-fast-proj");

    const t0 = performance.now();
    ensureTrusted(proj);
    const dt = performance.now() - t0;

    check(`(3) dead-pid lock (fresh mtime) → broken on first poll, not waited out over a 5000ms deadline (${dt.toFixed(1)}ms)`, dt < 500);
    check("(3) dead-pid lock → write succeeded", trusted(isoJson, keyFor(proj)));
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // === (4) tryTrustLockOnce (the GC per-worktree-removal path, exercised via the one real public
  // caller, removeClaudeConfigEntryForWorktree) recovers from a confirmed-dead holder via its ONE
  // bounded extra attempt — before this card, ANY held lock (crashed or alive) disabled every GC
  // removal forever. A confirmed-ALIVE holder must still be left alone (skip, no recovery). ===
  {
    const configDir = path.join(root, "gc-dead-pid");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    // A worktree path that genuinely does NOT exist on disk (classifyPathLiveness → "dead"), with a
    // pre-existing entry for it in the config.
    const deadWorktree = path.join(root, "gc-dead-pid-worktree-does-not-exist");
    const key = keyFor(deadWorktree);
    fs.writeFileSync(isoJson, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }, null, 2));

    const deadPid = mintDeadPid();
    writeLock(lockPath, JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }), 0); // fresh mtime, dead holder

    removeClaudeConfigEntryForWorktree(deadWorktree); // deferred via setImmediate
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r)); // a second tick of slack for the deferred body to finish

    const stillPresent = key in readEntries(isoJson);
    check("(4a) GC removal recovers a dead-pid-held lock (one bounded extra attempt) and removes the dead worktree's entry",
      !stillPresent);
    check("(4a) lock released after recovery — no lockfile left behind", !fs.existsSync(lockPath));
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  {
    const configDir = path.join(root, "gc-alive-pid");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const deadWorktree = path.join(root, "gc-alive-pid-worktree-does-not-exist");
    const key = keyFor(deadWorktree);
    fs.writeFileSync(isoJson, JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }, null, 2));
    writeLock(lockPath, JSON.stringify({ pid: alivePid, acquiredAt: Date.now() }), 0); // fresh mtime, ALIVE holder

    removeClaudeConfigEntryForWorktree(deadWorktree);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const stillPresent = key in readEntries(isoJson);
    check("(4b) GC removal does NOT recover an alive-pid-held lock — skips entirely, entry untouched (negative control for 4a)",
      stillPresent);
    check("(4b) the alive-held lock itself is left untouched (GC never breaks a genuinely live holder)", fs.existsSync(lockPath));
    try { fs.rmSync(lockPath); } catch { /* cleanup */ }
    delete process.env.CLAUDE_CONFIG_DIR;
  }
};

try {
  await main();
} finally {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

// === The whole test never mutated the real ~/.claude.json. ===
const realAfter = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;
check("real ~/.claude.json byte-identical before/after the whole test",
  (realBefore === null && realAfter === null) || (!!realBefore && !!realAfter && realBefore.equals(realAfter)));

console.log(failures === 0
  ? "\nALL PASS — a confirmed-dead lock holder is recovered fast; a confirmed-alive one is never broken short of the hard ceiling backstop."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
