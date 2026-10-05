import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Deterministic fault-injection test for pty/claude-config.ts's `ensureTrustedResilient` — the ONE bounded
// whole-call retry of `ensureTrusted` added on card f024f21b (decision record:
// docs/decisions/f024f21b-ensure-trusted-whole-call-retry.md).
//
// THE GAP this closes: `ensureTrusted` already retries a transient Windows EPERM/EACCES/EBUSY internally
// (writeJsonAtomic's rename, withTrustLock's lock-acquire — both bounded by transientFsRetryLimit(),
// default 12 attempts / ~363ms worst case), but that budget can genuinely exhaust under real spawn-time
// contention (specimen: 2 overlapping spawns + 5 live sessions) and the exhausted error propagates
// uncaught through host.ts's createPty, killing the WHOLE spawn attempt. ensureTrustedResilient adds one
// coarse, jittered, whole-call retry on top — deliberately NOT a wider inner budget (card 53e64114 already
// decided against that).
//
// Mirrors trust-lock-fault-injection.mjs's shape: stub the rename via claude-config.ts's
// __setRenameSyncForTest seam (fs's ESM namespace import is immutable and can't be monkeypatched
// directly) to force transient EPERM/EACCES/EBUSY deterministically, instead of a probabilistic race.
//
// Fully hermetic: isolated CLAUDE_CONFIG_DIR + fake HOME (no real ~/.claude.json touched).
//
// Run after build: node test/ensure-trusted-retry-fault-injection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureTrusted,
  ensureTrustedResilient,
  __setRenameSyncForTest,
  transientFsRetryLimit,
} from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const keyFor = (dir) => path.resolve(dir).replace(/\\/g, "/");
const readEntries = (cfgPath) => { try { return JSON.parse(fs.readFileSync(cfgPath, "utf8")).projects ?? {}; } catch { return {}; } };
const trusted = (cfgPath, key) => {
  const e = readEntries(cfgPath)[key];
  return e?.hasTrustDialogAccepted === true && e?.hasCompletedProjectOnboarding === true;
};
const transientErr = (code) => { const e = new Error(`${code}: simulated transient fs error`); e.code = code; return e; };
const persistentErr = () => { const e = new Error("ENOENT: simulated non-transient fs error"); e.code = "ENOENT"; return e; };

// Capture console.warn calls so we can assert the "retry fired, outcome X" log line fires exactly once
// on the retry path and never on the common (no-contention) path.
const realWarn = console.warn.bind(console);
let warnLines = [];
const captureWarn = () => { warnLines = []; console.warn = (...args) => { warnLines.push(args.join(" ")); }; };
const stopCapture = () => { console.warn = realWarn; };

const root = path.join(os.tmpdir(), `loom-ensure-trusted-retry-fault-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

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

// One fully-exhausted whole-call attempt makes exactly this many rename calls (first try + every retry).
const CALLS_PER_EXHAUSTED_ATTEMPT = transientFsRetryLimit() + 1;

try {
  // === (a) RED baseline, no retry: a fault pattern that fails for exactly one whole call's worth of
  // attempts then clears is enough to exhaust bare `ensureTrusted` (no outer retry) — proves the fault
  // pattern below is genuinely fail-inducing without the fix, not vacuously harmless. ===
  {
    const configDir = path.join(root, "a-red");
    fs.mkdirSync(configDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "a-red-proj");

    let calls = 0;
    __setRenameSyncForTest((from, to) => {
      calls++;
      if (calls <= CALLS_PER_EXHAUSTED_ATTEMPT) throw transientErr(calls % 2 === 0 ? "EACCES" : "EPERM");
      return fs.renameSync(from, to);
    });

    let threw = null;
    try { ensureTrusted(proj); } catch (err) { threw = err; }

    check(`(a-RED) bare ensureTrusted (no outer retry) THROWS under this fault pattern (${calls} calls, threw=${threw?.code ?? "none"})`,
      threw !== null && calls === CALLS_PER_EXHAUSTED_ATTEMPT);

    __setRenameSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // === (a) GREEN: the SAME fault pattern, through ensureTrustedResilient — the first whole call
  // exhausts exactly as above, the outer retry's whole SECOND call then succeeds ⇒ spawn proceeds
  // (no throw), and exactly one "retry succeeded" log line fires. ===
  {
    const configDir = path.join(root, "a-green");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "a-green-proj");

    let calls = 0;
    __setRenameSyncForTest((from, to) => {
      calls++;
      if (calls <= CALLS_PER_EXHAUSTED_ATTEMPT) throw transientErr(calls % 2 === 0 ? "EACCES" : "EPERM");
      return fs.renameSync(from, to);
    });

    captureWarn();
    let threw = null;
    try { ensureTrustedResilient(proj); } catch (err) { threw = err; }
    stopCapture();

    check(`(a-GREEN) ensureTrustedResilient does NOT throw — outer retry recovered (threw=${threw?.code ?? "none"})`,
      threw === null);
    check(`(a-GREEN) exactly one whole-call retry happened (${calls} calls, expected ${CALLS_PER_EXHAUSTED_ATTEMPT + 1})`,
      calls === CALLS_PER_EXHAUSTED_ATTEMPT + 1);
    check("(a-GREEN) entry ends up trusted (the retry's write actually landed)", trusted(isoJson, keyFor(proj)));
    check(`(a-GREEN) exactly one log line fired, reporting the retry succeeded (got ${warnLines.length}: ${JSON.stringify(warnLines)})`,
      warnLines.length === 1 && /succeeded/i.test(warnLines[0]));

    __setRenameSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // === (b) Both whole calls exhaust (persistent transient fault) ⇒ ensureTrustedResilient throws exactly
  // as bare ensureTrusted would — the retry does not swallow a genuinely-persistent failure, and it never
  // tries a THIRD time. ===
  {
    const configDir = path.join(root, "b");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "b-proj");

    let calls = 0;
    __setRenameSyncForTest(() => { calls++; throw transientErr(calls % 2 === 0 ? "EBUSY" : "EPERM"); }); // never clears

    captureWarn();
    let threw = null;
    try { ensureTrustedResilient(proj); } catch (err) { threw = err; }
    stopCapture();

    check(`(b) ensureTrustedResilient still throws when BOTH attempts exhaust (threw=${threw?.code ?? "none"})`,
      threw !== null && (threw.code === "EPERM" || threw.code === "EBUSY"));
    check(`(b) exactly TWO whole-call attempts were made, no third (${calls} calls, expected ${CALLS_PER_EXHAUSTED_ATTEMPT * 2})`,
      calls === CALLS_PER_EXHAUSTED_ATTEMPT * 2);
    check("(b) entry never ends up trusted — the failure was not swallowed", !trusted(isoJson, keyFor(proj)));
    check(`(b) exactly one log line fired, reporting the retry also failed (got ${warnLines.length}: ${JSON.stringify(warnLines)})`,
      warnLines.length === 1 && /also failed/i.test(warnLines[0]));

    __setRenameSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // === (c) A non-transient error (e.g. ENOENT) is NEVER retried — propagates on the very first attempt,
  // no outer retry, no sleep, no log line. ===
  {
    const configDir = path.join(root, "c");
    fs.mkdirSync(configDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "c-proj");

    let calls = 0;
    __setRenameSyncForTest(() => { calls++; throw persistentErr(); });

    captureWarn();
    const t0 = performance.now(); // MONOTONIC — see CLAUDE.md's CI timing-flake note
    let threw = null;
    try { ensureTrustedResilient(proj); } catch (err) { threw = err; }
    const dt = performance.now() - t0;
    stopCapture();

    check(`(c) non-transient ENOENT propagates immediately (threw=${threw?.code ?? "none"})`,
      threw?.code === "ENOENT");
    check(`(c) no outer retry attempted — exactly 1 call (${calls})`, calls === 1);
    check(`(c) no retry delay incurred (${dt.toFixed(1)}ms, well under the jitter floor)`, dt < 100);
    check(`(c) no log line fired (got ${warnLines.length})`, warnLines.length === 0);

    __setRenameSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // === Common path: no fault at all ⇒ ensureTrustedResilient behaves byte-identically to bare
  // ensureTrusted — one call, no sleep, no log line. ===
  {
    const configDir = path.join(root, "common");
    fs.mkdirSync(configDir, { recursive: true });
    const isoJson = path.join(configDir, ".claude.json");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const proj = path.join(root, "common-proj");

    let calls = 0;
    __setRenameSyncForTest((from, to) => { calls++; return fs.renameSync(from, to); });

    captureWarn();
    const t0 = performance.now();
    ensureTrustedResilient(proj); // must not throw
    const dt = performance.now() - t0;
    stopCapture();

    check(`(common) exactly one rename call — no retry attempted (${calls})`, calls === 1);
    check(`(common) no delay incurred (${dt.toFixed(1)}ms)`, dt < 100);
    check("(common) entry trusted on the first, uncontended attempt", trusted(isoJson, keyFor(proj)));
    check(`(common) no log line fired on the uncontended path (got ${warnLines.length})`, warnLines.length === 0);

    __setRenameSyncForTest();
    delete process.env.CLAUDE_CONFIG_DIR;
  }
} finally {
  stopCapture();
  __setRenameSyncForTest(); // belt-and-suspenders: never leave the real fs.renameSync stubbed on a throw
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

// === The whole test never mutated the real ~/.claude.json. ===
const realAfter = fs.existsSync(realJson) ? fs.readFileSync(realJson) : null;
check("real ~/.claude.json byte-identical before/after the whole test",
  (realBefore === null && realAfter === null) || (!!realBefore && !!realAfter && realBefore.equals(realAfter)));

console.log(failures === 0
  ? "\nALL PASS — ensureTrustedResilient retries a persistent transient EPERM/EACCES/EBUSY exactly once (jittered), never retries a non-transient error, never swallows a genuinely-persistent failure, and is byte-identical to ensureTrusted on the uncontended common path."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
