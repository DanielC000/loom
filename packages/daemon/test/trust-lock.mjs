// Hermetic concurrency test for pty/claude-config.ts ensureTrusted — the Phase-2 clobber fix.
//
// writeJsonAtomic (temp+rename) stops *corruption*, but without serialization two concurrent
// ensureTrusted calls each read state S and each write S+theirs → last-writer-wins clobbers the
// other's entry. ensureTrusted now guards the read-modify-write with a cross-process advisory
// lock (re-reading inside the lock), keeping the already-trusted fast-path lock-free.
//
// Pure + claude-free: no daemon, no real `claude`. Mirrors claude-config.mjs's temp
// CLAUDE_CONFIG_DIR style and proves the real ~/.claude.json is never touched.
//
// Run after build: node test/trust-lock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureTrusted } from "../dist/pty/claude-config.js";

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

const root = path.join(os.tmpdir(), `loom-trust-lock-test-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

// Hermetic from the user's REAL home for the whole test. ensureTrusted (and
// discoverProjectMcpServerNames) resolve paths via os.homedir(), which on every platform honors
// $USERPROFILE (Windows) / $HOME (POSIX) at call time. Point both at an isolated, empty fake-home so:
//   (1) the "never touched the real config" guard below probes an ISOLATED file that no external
//       process writes. The real ~/.claude.json is continuously rewritten by any live `claude` — and
//       this is a self-hosting repo, so the daemon's manager + sibling workers ARE live `claude`
//       processes during the suite. That ambient rewrite is what made the byte-compare flake "only
//       under the full suite" (a longer/loaded run widens the window for an ambient write to land).
//   (2) discoverProjectMcpServerNames is deterministic — no ambient ~/.mcp.json — so what section (a)
//       exercises no longer silently depends on the dev machine's home contents.
// The guard keeps its protective value: a regression that wrote to $HOME instead of the isolated
// CLAUDE_CONFIG_DIR would land in fake-home and still trip the byte-compare.
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

const run = (configDir, dir, startAt, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [writer, configDir, dir, String(startAt)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });

const main = async () => {
  // === (a) N concurrent writers, DISTINCT dirs, SAME temp config → all N entries survive. ===
  // The clobber regression: on the pre-lock code this drops entries (last-writer-wins). Looped
  // to beat timing flakiness. Default 5s lock timeout (well above a brief RMW → no false stale-break).
  const N = 12;
  const ITERS = 5;
  let allPresentEveryIter = true;
  for (let iter = 0; iter < ITERS; iter++) {
    const configDir = path.join(root, `cc-${iter}`);
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const dirs = Array.from({ length: N }, (_, i) => path.join(root, `iter${iter}-proj${i}`));

    const startAt = Date.now() + 400; // shared start instant → all children contend at once
    const codes = await Promise.all(dirs.map((d) => run(configDir, d, startAt)));

    const allExited0 = codes.every((c) => c === 0);
    const present = dirs.filter((d) => trusted(isoJson, keyFor(d))).length;
    if (!allExited0 || present !== N) {
      allPresentEveryIter = false;
      console.log(`  iter ${iter}: ${present}/${N} entries present, exits=${codes.join(",")}`);
    }
    check(`(a) iter ${iter}: ${N} concurrent writers → all ${N} trust entries present`, allExited0 && present === N);
  }
  check(`(a) clobber-free across all ${ITERS} iterations of ${N} concurrent writers`, allPresentEveryIter);

  // === (b) Bounded: lock already held by a fresh (non-stale) lockfile → ensureTrusted still
  // returns within ~the timeout (best-effort, no hang). ===
  {
    const configDir = path.join(root, "bounded");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    fs.writeFileSync(lockPath, "held-by-test"); // fresh mtime → NOT stale
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "500";
    const projB = path.join(root, "bounded-proj");

    const t0 = performance.now(); // MONOTONIC (not Date.now): a wall-clock forward step under load can't inflate dt
    ensureTrusted(projB); // must NOT hang on the held lock
    const dt = performance.now() - t0;

    // The bound only proves "bounded, no hang" (it must sit above the 500ms timeout, since by
    // design this waits the held lock out then degrades). Kept generous — the ORDER-OF-MAGNITUDE
    // bound (6× the 500ms timeout) so a loaded machine's sleep overshoot can't flip it, yet a real
    // hang (which would wait a full lock-wait ≫3s or never return) still trips it. The exact
    // wall-clock value is not what's under test. (Was a flaky Date.now()-measured dt < 500 against
    // a 500ms timeout — bound == timeout, so load flipped it: observed 505ms.)
    check(`(b) held lock → ensureTrusted returns bounded (${dt.toFixed(1)}ms, timeout 500ms)`, dt < 3000);
    check("(b) held lock → ensureTrusted still wrote best-effort (degrades to today's behavior)", trusted(isoJson, keyFor(projB)));
    try { fs.rmSync(lockPath); } catch { /* the held lock may have been treated stale & broken */ }
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // === (b2) Stale lock (old mtime) → broken and acquired; the write succeeds promptly. ===
  {
    const configDir = path.join(root, "stale");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    const lockPath = `${isoJson}.loom-lock`;
    fs.writeFileSync(lockPath, "crashed-holder");
    const old = (Date.now() - 60_000) / 1000; // 60s old (stale vs the 5000ms timeout)
    fs.utimesSync(lockPath, old, old);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // Generous timeout so the assertion proves a BEHAVIOR (a stale lock is broken on the first
    // loop iteration, NOT waited out) rather than a tight wall-clock bound. A regression that
    // failed to detect staleness would wait the full 5000ms and trip dt < 2500; a healthy break
    // returns near-instantly, leaving ample headroom for a slow/loaded machine. (Was a flaky
    // dt < 500 against a 500ms timeout — bound == timeout, so load flipped it: observed 513ms.)
    process.env.LOOM_TRUST_LOCK_MS = "5000";
    const projS = path.join(root, "stale-proj");

    const t0 = performance.now(); // MONOTONIC (not Date.now): a wall-clock forward step under load can't inflate dt
    ensureTrusted(projS);
    const dt = performance.now() - t0;

    check(`(b2) stale lock broken → write succeeds without waiting out the timeout (${dt.toFixed(1)}ms, timeout 5000ms)`, dt < 2500 && trusted(isoJson, keyFor(projS)));
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LOOM_TRUST_LOCK_MS;
  }

  // === (c) Idempotent fast-path: already-trusted dir is a no-op (and leaves no lockfile). ===
  {
    const configDir = path.join(root, "idem");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projI = path.join(root, "idem-proj");
    ensureTrusted(projI);
    ensureTrusted(projI); // fast-path no-op
    const noLock = !fs.existsSync(`${isoJson}.loom-lock`);
    check("(c) idempotent fast-path: already-trusted re-call keeps it trusted, no lockfile left",
      trusted(isoJson, keyFor(projI)) && noLock);
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
  ? "\nALL PASS — ensureTrusted serializes concurrent writers (no clobber), stays bounded, and keeps a lock-free fast-path."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
