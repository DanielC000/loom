import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Deterministic fault-injection test for pty/claude-config.ts withTrustLock's transient-EPERM
// retry-then-degrade branch (fix a38e9e62, follow-up card 26c8575c).
//
// THE GAP this closes: that branch was covered only PROBABILISTICALLY by trust-lock.mjs's
// 12-concurrent-writer race, and the transient EPERM/EACCES/EBUSY codes are a WINDOWS-only
// manifestation of that race (the Linux CI runner sees EEXIST instead) — so the branch got ZERO
// exercise in CI. This test stubs the lock-acquire fs.openSync via claude-config.ts's __setOpenSyncForTest
// seam (fs's ESM namespace import is immutable and can't be monkeypatched directly — mirrors
// companion/tts.ts's spawnImpl seam) to force the transient codes deterministically on every platform.
//
// Fully hermetic: isolated CLAUDE_CONFIG_DIR + fake HOME (no real ~/.claude.json touched), no real
// filesystem race — the "concurrency" is simulated entirely via the fault-injected open.
//
// Run after build: node test/trust-lock-fault-injection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTrusted, __setOpenSyncForTest, transientFsRetryLimit } from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const readEntries = (cfgPath) => { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects ?? {}; } catch { return {}; } };
const trusted = (cfgPath, key) => {
  const e = readEntries(cfgPath)[key];
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
};
const transientErr = (code) => { const e = new Error(`${code}: simulated transient fs error`); e.code = code; return e; };

const root = path.join(os.tmpdir(), `loom-trust-lock-fault-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

// Isolate from the real $HOME the same way trust-lock.mjs does: discoverProjectMcpServerNames and
// claudeJsonPath both resolve via os.homedir() at call time, so pointing HOME/USERPROFILE at an empty
// fake-home keeps this test deterministic (no ambient ~/.mcp.json) and provably clear of the real
// ~/.claude.json (CLAUDE_CONFIG_DIR below redirects the actual read/write target too).
const fakeHome = path.join(root, "fake-home");
fs.mkdirSync(fakeHome, { recursive: true });

const savedCfg = process.env.CLAUDE_CONFIG_DIR;
const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", savedCfg], ["HOME", savedHome], ["USERPROFILE", savedUserProfile]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

const realJson = path.join(os.homedir(), ".claude.json");
const realBefore = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;

try {
  // === (1) Transient EPERM clears within budget → withTrustLock RETRIES and acquires the lock;
  // it must NOT degrade to lock-free on the first (or any single) transient throw. ===
  {
    const configDir = path.join(root, "retry");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "retry-proj");

    const FAILS = 5; // comfortably under transientFsRetryLimit() — proves multi-attempt retry, not a fluke
    let calls = 0;
    __setOpenSyncForTest((p, flags) => {
      calls++;
      if (calls <= FAILS) throw transientErr(calls % 2 === 0 ? "EACCES" : "EPERM");
      return fs.openSync(p, flags); // transient cleared — real open, actually acquires the lock
    });

    ensureTrusted(proj);

    check(`(1) retried through ${FAILS} transient EPERM/EACCES before acquiring (${calls} calls, expected ${FAILS + 1})`,
      calls === FAILS + 1);
    check("(1) fn ran under the (eventually-acquired) lock — entry trusted", trusted(isoJson, keyFor(proj)));
    check("(1) lock released after use — no lockfile left behind", !fs.existsSync(`${isoJson}.loom-lock`));

    __setOpenSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // === (2) Transient EPERM/EBUSY NEVER clears → after exhausting transientFsRetryLimit() retries,
  // withTrustLock DEGRADES to best-effort lock-free: fn still runs, ensureTrusted still returns
  // (no hang). ===
  {
    const configDir = path.join(root, "degrade");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "degrade-proj");

    let calls = 0;
    __setOpenSyncForTest(() => { calls++; throw transientErr(calls % 2 === 0 ? "EBUSY" : "EPERM"); }); // never clears

    const t0 = performance.now(); // MONOTONIC: a wall-clock forward step under load can't inflate dt
    ensureTrusted(proj); // must return — not hang — even though the lock is never acquirable
    const dt = performance.now() - t0;

    const expectedCalls = transientFsRetryLimit() + 1; // the first attempt + LIMIT retries, then give up
    check(`(2) exhausted the transient-retry budget before degrading (${calls} calls, expected ${expectedCalls})`,
      calls === expectedCalls);
    check(`(2) degraded to best-effort — fn still ran unlocked, no hang (${dt.toFixed(1)}ms)`,
      trusted(isoJson, keyFor(proj)));
    check("(2) never held the lock — no lockfile left behind", !fs.existsSync(`${isoJson}.loom-lock`));

    __setOpenSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }
} finally {
  __setOpenSyncForTest(); // belt-and-suspenders: never leave the real fs.openSync stubbed on a throw
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

// === The whole test never mutated the real ~/.claude.json. ===
const realAfter = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;
check("real ~/.claude.json byte-identical before/after the whole test",
  (realBefore === null && realAfter === null) || (!!realBefore && !!realAfter && realBefore.equals(realAfter)));

console.log(failures === 0
  ? "\nALL PASS — withTrustLock retries transient EPERM/EACCES/EBUSY bounded, then degrades to best-effort (never hangs, never abandons early)."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
