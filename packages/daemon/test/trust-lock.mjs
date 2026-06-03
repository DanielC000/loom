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

const realJson = path.join(os.homedir(), ".claude.json");
const realBefore = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;

const savedCfg = process.env.CLAUDE_CONFIG_DIR;
const savedLockMs = process.env.LOOM_TRUST_LOCK_MS;
const restoreEnv = () => {
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", savedCfg], ["LOOM_TRUST_LOCK_MS", savedLockMs]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
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

    const t0 = Date.now();
    ensureTrusted(projB); // must NOT hang on the held lock
    const dt = Date.now() - t0;

    check(`(b) held lock → ensureTrusted returns bounded (${dt}ms, timeout 500ms)`, dt < 2500);
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
    const old = (Date.now() - 60_000) / 1000; // 60s old → stale vs 500ms timeout
    fs.utimesSync(lockPath, old, old);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.LOOM_TRUST_LOCK_MS = "500";
    const projS = path.join(root, "stale-proj");

    const t0 = Date.now();
    ensureTrusted(projS);
    const dt = Date.now() - t0;

    check(`(b2) stale lock broken → write succeeds promptly (${dt}ms)`, dt < 500 && trusted(isoJson, keyFor(projS)));
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
