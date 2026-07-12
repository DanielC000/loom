import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Deterministic fault-injection test for pty/claude-config.ts writeJsonAtomic's transient-EPERM
// rename-retry budget (card 0f265dde, follow-up to the a42c42ac flaky-test-hardening worker).
//
// THE GAP this closes: TRANSIENT_FS_RETRY_LIMIT was a FIXED constant (12, ~370ms worst-case backoff)
// with no way to widen it — under extreme concurrent Windows FS contention that budget can genuinely
// EXHAUST and surface an EPERM that would have cleared given a bit more time (~1 in ~64 heavy-stress
// attempts in the reported repro), asymmetric with the lock-acquire timeout (LOOM_TRUST_LOCK_MS),
// which was already env-overridable. The fix makes the rename-retry budget env-configurable via
// LOOM_TRANSIENT_FS_RETRY_LIMIT (transientFsRetryLimit(), mirroring trustLockMs()'s override pattern)
// while preserving the exact pre-fix retry count (12) as the default when the env var is unset.
//
// Mirrors test/trust-lock-fault-injection.mjs's shape: stub the rename via claude-config.ts's
// __setRenameSyncForTest seam (fs's ESM namespace import is immutable and can't be monkeypatched
// directly) to force transient EPERM/EACCES/EBUSY deterministically on every platform, instead of a
// probabilistic concurrent-writer race.
//
// Fully hermetic: writes only inside an isolated temp dir, never touches any real Loom/Claude config.
//
// Run after build: node test/write-json-atomic-fault-injection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, __setRenameSyncForTest, transientFsRetryLimit } from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const transientErr = (code) => { const e = new Error(`${code}: simulated transient fs error`); e.code = code; return e; };
const persistentErr = () => { const e = new Error("ENOENT: simulated non-transient fs error"); e.code = "ENOENT"; return e; };

const root = path.join(os.tmpdir(), `loom-write-json-atomic-fault-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });

const savedLimit = process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
const restoreEnv = () => {
  if (savedLimit === undefined) delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
  else process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT = savedLimit;
};

try {
  const DEFAULT_LIMIT = (() => {
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
    return transientFsRetryLimit();
  })();
  check(`baseline: transientFsRetryLimit() with no env override is the pre-fix constant (${DEFAULT_LIMIT})`, DEFAULT_LIMIT === 12);

  // === (0) Parse edges: garbage/degenerate overrides all fall back to the default (12), and a
  // fractional value in (0,1) — "0.5" — specifically does NOT floor to 0 and disable retries. An
  // above-ceiling override clamps to the ceiling instead of being taken verbatim. ===
  {
    for (const raw of ["0", "-3", "", "abc", "0.5"]) {
      process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT = raw;
      const got = transientFsRetryLimit();
      check(`(0) LOOM_TRANSIENT_FS_RETRY_LIMIT=${JSON.stringify(raw)} falls back to the default (12), got ${got}`, got === 12);
    }
    process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT = "100000";
    const clamped = transientFsRetryLimit();
    check(`(0) LOOM_TRANSIENT_FS_RETRY_LIMIT="100000" clamps to the ceiling (1000), got ${clamped}`, clamped === 1000);
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
  }

  // === (1) Transient EPERM clears well within the default budget → writeJsonAtomic RETRIES and
  // succeeds; must NOT give up on the first (or any single) transient throw. ===
  {
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
    const target = path.join(root, "retry.json");
    const FAILS = 5; // comfortably under the default budget — proves multi-attempt retry, not a fluke
    let calls = 0;
    __setRenameSyncForTest((from, to) => {
      calls++;
      if (calls <= FAILS) throw transientErr(calls % 2 === 0 ? "EACCES" : "EPERM");
      return fs.renameSync(from, to); // transient cleared — real rename
    });

    writeJsonAtomic(target, { ok: true });

    check(`(1) retried through ${FAILS} transient EPERM/EACCES before succeeding (${calls} calls, expected ${FAILS + 1})`,
      calls === FAILS + 1);
    check("(1) target written with the real content", JSON.parse(fs.readFileSync(target, "utf8")).ok === true);
    __setRenameSyncForTest();
  }

  // === (2) Transient EPERM NEVER clears, default budget (env unset) → EXHAUSTS after exactly the
  // pre-fix retry count and throws (proves the default is unchanged — byte-identical to pre-fix). ===
  {
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
    const target = path.join(root, "exhaust-default.json");
    let calls = 0;
    __setRenameSyncForTest(() => { calls++; throw transientErr(calls % 2 === 0 ? "EBUSY" : "EPERM"); });

    let threw = null;
    try { writeJsonAtomic(target, { ok: true }); } catch (err) { threw = err; }

    const expectedCalls = transientFsRetryLimit() + 1; // first attempt + LIMIT retries, then give up
    check(`(2) default budget exhausted → threw (code=${threw?.code}), ${calls} calls (expected ${expectedCalls})`,
      (threw?.code === "EPERM" || threw?.code === "EBUSY") && calls === expectedCalls);
    check("(2) no target file left behind on terminal failure", !fs.existsSync(target));
    __setRenameSyncForTest();
  }

  // === (3) Env override WIDENS the budget → a fault count that would have exhausted the pre-fix
  // default (12) now SUCCEEDS. Proves both "the env override takes effect" and "the widened budget
  // succeeds where the old budget would have exhausted". ===
  {
    process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT = "20";
    const target = path.join(root, "widened.json");
    const FAILS = 15; // > pre-fix default (12), < the overridden budget (20)
    let calls = 0;
    __setRenameSyncForTest((from, to) => {
      calls++;
      if (calls <= FAILS) throw transientErr(calls % 2 === 0 ? "EACCES" : "EPERM");
      return fs.renameSync(from, to);
    });

    check("(3) env override applied", transientFsRetryLimit() === 20);

    let threw = null;
    try { writeJsonAtomic(target, { widened: true }); } catch (err) { threw = err; }

    check(`(3) ${FAILS} transient failures (> pre-fix default 12) SUCCEEDED under the widened budget (${calls} calls, threw=${threw?.code ?? "none"})`,
      threw === null && calls === FAILS + 1);
    check("(3) target written with the real content", JSON.parse(fs.readFileSync(target, "utf8")).widened === true);
    __setRenameSyncForTest();
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
  }

  // === (4) Env override still EXHAUSTS on genuinely-persistent EPERM — the widened budget doesn't
  // swallow a real failure, it just widens the ceiling. ===
  {
    process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT = "20";
    const target = path.join(root, "exhaust-widened.json");
    let calls = 0;
    __setRenameSyncForTest(() => { calls++; throw transientErr(calls % 2 === 0 ? "EBUSY" : "EPERM"); });

    let threw = null;
    try { writeJsonAtomic(target, { ok: true }); } catch (err) { threw = err; }

    check(`(4) widened budget (20) still eventually throws on persistent EPERM (${calls} calls, expected 21, threw=${threw?.code ?? "none"})`,
      (threw?.code === "EPERM" || threw?.code === "EBUSY") && calls === 21);
    check("(4) no target file left behind on terminal failure", !fs.existsSync(target));
    __setRenameSyncForTest();
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
  }

  // === (5) A non-transient error (e.g. ENOENT) is NEVER retried, regardless of budget — propagates
  // on the first attempt. ===
  {
    delete process.env.LOOM_TRANSIENT_FS_RETRY_LIMIT;
    const target = path.join(root, "non-transient.json");
    let calls = 0;
    __setRenameSyncForTest(() => { calls++; throw persistentErr(); });

    let threw = null;
    try { writeJsonAtomic(target, { ok: true }); } catch (err) { threw = err; }

    check(`(5) non-transient ENOENT propagates immediately, no retry (${calls} calls, expected 1)`,
      threw?.code === "ENOENT" && calls === 1);
    __setRenameSyncForTest();
  }
} finally {
  __setRenameSyncForTest(); // belt-and-suspenders: never leave the real fs.renameSync stubbed on a throw
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\nALL PASS — writeJsonAtomic's transient-EPERM retry budget is env-configurable (LOOM_TRANSIENT_FS_RETRY_LIMIT), defaults byte-identical to pre-fix, widens on override, and still surfaces a genuinely-persistent failure."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
