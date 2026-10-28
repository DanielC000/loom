// SHARED TEST PROD-GUARD — import this FIRST in every daemon test.
//
// WHY THIS EXISTS (HIGH-severity incident, 2026-06-04 ~03:39): a worker ran a daemon integration
// test with NO env set. The test's `BASE` defaulted to the PROD daemon on :4317 and a bare `new Db()`
// opened the PROD database `~/.loom/loom.db`, and the test then DELETE'd sessions/agents/projects/
// tasks — wiping the real 14 projects / 197 tasks (recovered only by luck from a WAL checkpoint).
//
// DEFENSE IN DEPTH — this module gives the test suite two protections:
//   1. Importing it sets `process.env.LOOM_TEST = "1"` (inherited by any daemon this test spawns),
//      which arms the Db prod-guard in `src/db.ts` — a stray default-path `new Db()` then THROWS
//      instead of opening `~/.loom/loom.db`.
//   2. `requireHermeticEnv()` ABORTS the process unless it is pointed at an isolated test environment:
//      LOOM_HOME must be a temp dir (NOT the real ~/.loom) and — for tests that talk to a live daemon
//      over HTTP — LOOM_PORT must be set and != 4317 (NOT the prod daemon).
//
// USAGE:
//   • In-process / self-isolating tests (they set their OWN LOOM_HOME=<temp> before importing dist):
//         import "./_guard.mjs";              // arms the Db backstop (LOOM_TEST=1)
//         process.env.LOOM_HOME = <temp>;
//         requireHermeticEnv();               // confirms LOOM_HOME is the temp dir
//   • Live-BASE tests (they fetch a running daemon — the prod-killers):
//         import { requireHermeticEnv } from "./_guard.mjs";
//         requireHermeticEnv({ port: true }); // FIRST executable line — aborts on bare env
//
// TIMING ASSERTIONS: never sample timing-dependent state right after a blind `sleep(N)` and assert
// against it — that's a guess about how long some other async operation takes, and it passes on an idle
// host and fails under load (card 0fa5beef — four real merge gates redded by exactly this shape in one
// day). Poll for the real state instead: see `./_wait.mjs` (`waitUntil`/`deferred`) for the shared
// helper and the full writeup of the anti-pattern and its two corollaries.
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  cleanupPathSync,
  normalizeForCompare,
  loomHomeImportOrderingViolation,
  portImportOrderingViolation,
} from "./_tmp-fixture.mjs";
import { ambientScaledBudget } from "./_wait.mjs";

// @decision 8c8ee0ee — STRUCTURAL test-spawn registry for pty/host.ts's real-reaper test tripwire
// (assertReapTargetIsOwnLiveDescendantUnderTest). A live OS pid->ppid walk alone can't recognize a pid
// this test legitimately spawned but has ALREADY killed before reaping it (dev-server-teardown.mjs's own
// pattern: kill the root, confirm it's dead, THEN call reapOrphanedDescendants(root.pid) — a dead pid's
// row is ABSENT from a fresh enumeration, verified empirically, not assumed). This records every pid this
// test process itself hands to node:child_process spawn/fork/exec/execFile, AND node-pty's own spawn
// (the REAL claude/codex/shell root-process primitive pty/host.ts actually calls — see "Do not" below
// for the real-spawn incident this card's own CR found that closed this second gap) — structurally, via
// a CJS-side monkeypatch of each module's shared exports object. Exposed on `globalThis` (never by
// import) because pty/host.ts is PRODUCTION source and must never import from packages/daemon/test/ —
// `globalThis.__LOOM_TEST_SPAWNED_PIDS__` is simply absent in a real daemon process, where the consuming
// lookup is itself gated behind `inTestMode()` and never runs anyway. No test author has to do anything —
// every test that imports this file first (the project-wide convention) gets this for free.
const LOOM_TEST_SPAWNED_PIDS = new Set();
globalThis.__LOOM_TEST_SPAWNED_PIDS__ = LOOM_TEST_SPAWNED_PIDS;

// @decision 85ae7768 — companion registry: pid -> the VERIFIED OS creation time captured at registration,
// via the SAME resolveVerifiedRootCreationTime predicate 87691385 built (never a new, unreviewed check).
// Closes the "dead registered root" residual (card dbbb52db's own gen-408 triage note, out of scope for
// 87691385 itself): a test-registered root swept via reapOrphanedDescendants's branch-b path used to
// always carry rootCreationTime=null, so a stale-ppid child left by an earlier owner of that pid number
// went unfiltered. See docs/decisions/85ae7768-win32-root-creation-leaf-module.md for why this imports
// ONLY the side-effect-free `pty/win32-root-creation.js` leaf, never the full `pty/host.js`.
const LOOM_TEST_SPAWNED_PID_CREATION_TIMES = new Map();
globalThis.__LOOM_TEST_SPAWNED_PID_CREATION_TIMES__ = LOOM_TEST_SPAWNED_PID_CREATION_TIMES;

// Test-visible counters for the re-entrancy-guard's own regression test (card 85ae7768) — never read by
// production or by assertReapTargetIsOwnLiveDescendantUnderTest; purely diagnostic/assertable state.
const CAPTURE_STATS = { started: 0, skippedReentrant: 0, failed: 0 };
globalThis.__LOOM_TEST_CAPTURE_STATS__ = CAPTURE_STATS;

// @decision 0d8270b2 — pid -> WHY the most recent capture for that pid came back unverified (never why it
// succeeded — a verified entry clears/overwrites any stale reason here). One of "no-row" (the OS enumeration
// returned nothing for this pid), "ppid-mismatch" (a live row exists but its ppid isn't ours — the genuine
// pid-reuse signal this whole mechanism exists to catch), "slack-margin" (a row exists, ppid matches, but
// `row.creationTime` landed after `registeredAt + ROOT_CREATION_CAPTURE_SLACK_MS` — see
// `armWitnessWithFreshRetry`'s own doc for why this one, specifically, is NOT evidence of reuse), or "infra"
// (the capture's OWN spawn/CIM call itself threw or rejected for THIS pid — never a verification outcome).
// `armWitnessWithFreshRetry` reads THIS pid's own entry — never the global `CAPTURE_STATS.failed` counter —
// to decide, PER PID, whether a null result is worth retrying with a fresh candidate: a concurrent capture
// failure for an unrelated pid must never be read as THIS pid's own infra failure (@decision 0d8270b2 round 2).
const CAPTURE_REJECTION_REASONS = new Map();
// @decision 0d8270b2 (round 2) — test-visible for the "per pid, not global" regression test (see
// pty-root-reap-test-tripwire.mjs's own "(helper)" scenario); never read by production.
globalThis.__LOOM_TEST_CAPTURE_REJECTION_REASONS__ = CAPTURE_REJECTION_REASONS;

// @decision 85ae7768 (CR 85360986/165cf2fa) — OFF BY DEFAULT. `node:child_process`'s own `spawn` is also
// the primitive simple-git (and most test helpers) spawn real `git`/helper processes through — narrowing
// the capture to ONE spawn kind (see wrapSpawnLikeForTestRegistry's own doc) does NOT bound its cost on
// its own, since EVERY win32 test that spawns ANYTHING via cp.spawn would otherwise pay the real capture
// LATENCY (~560-630ms measured on this host — NOT a per-spawn CIM-query estimate; see the record). THE
// RULE for which tests call `enableRootCreationCapture()` is NOT "does this test's own assertion read a
// captured creationTime" — it is: opt in any test that hands a REGISTERED root to the real reaper (no
// injected `deps.enumerate`), since that's exactly the shape the card's filter protects, regardless of
// what the test happens to check afterward. See docs/decisions/85ae7768-win32-root-creation-leaf-module.md
// for the full rule, the measured cost on both sides, and why an earlier draft of this comment got it
// backwards (opted the actual reaper-root files OUT on the wrong reasoning).
let rootCreationCaptureEnabled = false;
export function enableRootCreationCapture() { rootCreationCaptureEnabled = true; }

// Lazy + cached: only the FIRST win32 capture pays the dynamic-import cost; every later one reuses the
// same resolved module. Dynamic, not a static top-level import, so a test file that never spawns
// anything (the overwhelming majority of this suite) never forces `dist/pty/win32-root-creation.js` to
// exist — only a test that actually spawns on win32 does.
let win32RootCreationLeafPromise = null;
function loadWin32RootCreationLeaf() {
  if (!win32RootCreationLeafPromise) {
    win32RootCreationLeafPromise = import("../dist/pty/win32-root-creation.js");
  }
  return win32RootCreationLeafPromise;
}

// @decision 85ae7768 — re-entrancy depth, bracketed SYNCHRONOUSLY around the real
// `enumerateWin32SweepRowForPid(pid)` call (its own powershell.exe helper spawn happens inside that
// call's Promise constructor, which the language spec runs synchronously) — never around the whole async
// settle. Without this, capturing for a real root recurses into capturing for its OWN diagnostic helper's
// pid, unboundedly: the helper is spawned via this SAME wrapped cp.spawn. A depth guard bracketing only
// the synchronous window never suppresses a genuinely concurrent, unrelated capture for a different root
// (JS's single-threaded event loop never interleaves two synchronous windows).
let captureReentrancyDepth = 0;

// @decision 85ae7768 (CR 85360986, MAJOR) — pid -> the capture's own settlement promise. The capture is
// genuinely async (measured ~560-630ms on this host, win32 CIM query + helper spawn) while
// `reapOrphanedDescendants` reads the companion registry SYNCHRONOUSLY — a real-sweep test that kills its
// root immediately after spawning it races that window and loses almost every time, leaving the filter
// silently un-armed (the capture settles to null well after the sweep has already run, with no error).
// `awaitRootCreationCapture` (below) is how a caller actually WAITS for that settlement before
// proceeding to kill/reap, rather than just hoping the window happened to close in time.
const PENDING_CAPTURES = new Map();

/**
 * Fire-and-forget: captures pid's verified OS creation time, win32-only. `registeredAt` must be stamped
 * AFTER the real spawn call returns (mirrors production's real spawn-then-stamp ordering, 87691385) so
 * `resolveVerifiedRootCreationTime` can verify the row against it within `ROOT_CREATION_CAPTURE_SLACK_MS`
 * (20ms, card 0d8270b2) — NOT, as an earlier draft of this doc claimed, because the genuine root's own OS
 * creation time is "always `<= registeredAt`"; that invariant is empirically false (see
 * docs/decisions/0d8270b2-*.md and `docs/decisions/87691385-*.md` round 7) — a genuine root's creationTime
 * can land a few ms AFTER `registeredAt`, which is exactly why the slack exists.
 */
// @decision 0d8270b2 — the capture's own CIM enumeration (a REAL spawned `powershell.exe` doing real I/O,
// not a guessed sleep) gets MORE wall-clock headroom under genuine host contention — same
// `ambientScaledBudget` convention every other load-sensitive real-OS-call wait in this suite already
// uses (dev-server-teardown.mjs's `ROOT_DEATH_TIMEOUT_MS`/`REAP_TIMEOUT_MS`). Orthogonal to, and NOT the
// confirmed fix for, the card's own root cause — that turned out to be `armWitnessWithFreshRetry`'s own
// slack-margin miss (see its doc below, and docs/decisions/0d8270b2-*.md for the full investigation); this
// stays as a harmless, independently-justified hardening against a genuinely slow CIM query under extreme
// contention. Lazy: `ambientScaledBudget` only pays its one-time ambient-probe cost (~50ms) the first time
// a win32 capture actually runs, never for the large majority of test files that import this module but
// never call `enableRootCreationCapture()`.
const CAPTURE_ENUMERATION_BASE_TIMEOUT_MS = 10_000; // == enumerateWin32SweepRowForPid's own unscaled default.
function resolveCaptureEnumerationTimeoutMs() {
  return ambientScaledBudget(CAPTURE_ENUMERATION_BASE_TIMEOUT_MS);
}

function captureTestRegistryCreationTime(pid, registeredAt) {
  if (!rootCreationCaptureEnabled) return; // opt-in, card 85ae7768 — see its own doc above.
  if (process.platform !== "win32") return; // POSIX never carries a creation-time column; stays unpopulated.
  if (captureReentrancyDepth > 0) { CAPTURE_STATS.skippedReentrant++; return; }
  CAPTURE_STATS.started++;
  const capturePromise = loadWin32RootCreationLeaf()
    .then(({ enumerateWin32SweepRowForPid, resolveVerifiedRootCreationTime }) => {
      captureReentrancyDepth++;
      let rowPromise;
      try {
        // @decision 0d8270b2 — explicit, ambient-scaled timeoutMs (see above); the production call site
        // (pty/host.ts's captureRootCreationRow) still uses this function's own unscaled 10s default —
        // this override is test-only and never reaches production.
        rowPromise = enumerateWin32SweepRowForPid(pid, resolveCaptureEnumerationTimeoutMs());
      } finally {
        captureReentrancyDepth--;
      }
      return rowPromise.then((row) => {
        const verified = resolveVerifiedRootCreationTime(row, process.pid, registeredAt);
        // @decision 0d8270b2 — classify WHY a null came back (see CAPTURE_REJECTION_REASONS's own doc
        // above); a verified result clears any stale reason from an earlier capture of this same pid.
        if (verified == null) {
          const reason = row == null ? "no-row"
            : row.ppid !== process.pid ? "ppid-mismatch"
            : "slack-margin";
          CAPTURE_REJECTION_REASONS.set(pid, reason);
        } else {
          CAPTURE_REJECTION_REASONS.delete(pid);
        }
        return verified;
      });
    })
    .then((verified) => {
      // @decision 85ae7768 (CR 165cf2fa) — only the LATEST capture for THIS pid may write. A pid can be
      // reused within this test process's own lifetime (an old child dies, the OS hands its number to a
      // brand-new one) and promises don't settle in start order — without this check, a slower OLDER
      // capture settling after a faster NEWER one could clobber the newer, correct value. `PENDING_
      // CAPTURES.get(pid)` always holds whichever capture started MOST RECENTLY for this pid (each new
      // one overwrites the map entry synchronously, at the bottom of this function); comparing it against
      // `capturePromise` (this very call's own promise, captured by closure) is how this call tells
      // whether it's still that latest one by the time it finally settles.
      if (PENDING_CAPTURES.get(pid) === capturePromise) {
        if (verified != null) LOOM_TEST_SPAWNED_PID_CREATION_TIMES.set(pid, verified);
        // A NEWER capture settling null means the most recent truth about this pid is "unverified" — an
        // older capture's stale value (possibly for a since-reused pid) must not keep squatting there.
        else LOOM_TEST_SPAWNED_PID_CREATION_TIMES.delete(pid);
      }
      return verified;
    })
    .catch((err) => {
      CAPTURE_STATS.failed++;
      // @decision 0d8270b2 (round 2) — record the infra failure PER PID too, not just the global
      // counter above: `armWitnessWithFreshRetry` classifies a null result from THIS pid's own entry
      // here, never from `CAPTURE_STATS.failed`'s global count (see that map's own doc above).
      CAPTURE_REJECTION_REASONS.set(pid, "infra");
      // eslint-disable-next-line no-console
      console.error(`[pty-reap-test-guard-capture] REFUSED pid=${pid}: ${err?.message ?? err}`);
      return null;
    });
  PENDING_CAPTURES.set(pid, capturePromise);
}

// Generous relative to the ~560-630ms measured real latency (CR 85360986) — this bounds a genuinely
// wedged capture (e.g. a hung powershell.exe), it is not tuned to the common-case timing.
// @decision 0d8270b2 — ambient-scaled (see resolveCaptureEnumerationTimeoutMs above) with a 20% margin
// ABOVE the inner enumeration's own scaled ceiling, so this outer race can never fire first and reject a
// capture that is still legitimately running under load — it must always lose that race to the inner
// call's own tolerant-null `.catch()` resolution, never pre-empt it.
function resolveAwaitRootCreationCaptureTimeoutMs() {
  return Math.round(resolveCaptureEnumerationTimeoutMs() * 1.2);
}

/**
 * Waits for pid's own capture (if one was ever started) to settle, so a caller can arm-then-assert
 * BEFORE killing/reaping the pid, instead of racing the capture's real latency blind. Resolves to the
 * SAME value `LOOM_TEST_SPAWNED_PID_CREATION_TIMES` ends up holding for `pid` (a number, or `null` if the
 * capture legitimately found nothing to trust) — `null` immediately, no wait at all, when no capture was
 * ever started for `pid` (capture disabled, POSIX, or never registered). REJECTS — never resolves `null`
 * — on a real timeout, so a wedged capture is an observable failure, never silently indistinguishable
 * from a legitimate null result.
 */
export function awaitRootCreationCapture(pid, timeoutMs = resolveAwaitRootCreationCaptureTimeoutMs()) {
  const pending = PENDING_CAPTURES.get(pid);
  if (!pending) return Promise.resolve(null);
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`awaitRootCreationCapture: pid=${pid} capture did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @decision 0d8270b2 — card 0d8270b2's investigation (docs/decisions/0d8270b2-*.md) found a genuine,
 * correctly-identified (ppid-matched) witness child occasionally failing `resolveVerifiedRootCreationTime`'s
 * own slack check by a few ms — CONFIRMED via a captured diagnostic (a real witness, delta=4ms against the
 * OLD 2ms slack). The fix for THAT is in PRODUCTION (`ROOT_CREATION_CAPTURE_SLACK_MS`, `pty/
 * win32-root-creation.ts`, raised to 20ms — see `docs/decisions/87691385-*.md` round 7): a genuine root's
 * skew is now comfortably inside the slack, so a slack-margin miss should no longer occur for a real
 * witness in practice. This helper therefore retries ONLY a genuine INFRA failure (the spawn/CIM call
 * itself threw or rejected — `CAPTURE_STATS.failed` advances) with a BRAND NEW candidate process (never
 * re-querying the same pid — both `row.creationTime` and `registeredAt` are fixed once set for a given
 * pid, so only a fresh spawn gives a fresh, independent trial). EVERY verification rejection — `no-row`,
 * `ppid-mismatch`, OR `slack-margin` — is now a HARD, NON-RETRIED failure: retrying past a slack-margin
 * miss would MASK a regression of the production fix above (if the slack were ever narrowed again, a
 * retry-dependent test would silently keep passing instead of catching it), and `ppid-mismatch`/`no-row`
 * are already the genuine pid-reuse-adjacent signals this whole mechanism exists to catch loudly. This
 * mirrors `pty-exit-reap-seam.mjs`'s own pre-existing, independent "only infra failures retry" design —
 * not a new idea, just this file's own reusable version of it.
 *
 * `spawnCandidate()` must return a fresh `ChildProcess` on every call (same shape every scenario in
 * `pty-root-reap-test-tripwire.mjs` already uses: `spawnProcess(process.execPath, ["-e", "setTimeout(()
 * => {}, N)"], { stdio: "ignore" })`). Returns `{ pid, child, creationTime }` on success — the caller owns
 * `child` from here on (kill it, reap it, whatever the scenario needs) exactly as if it had spawned it
 * itself. On a hard rejection (any non-infra verification failure) or exhaustion (every attempt was a
 * genuine infra failure), returns `{ pid: null, child: null, creationTime: null, hardRejected, reason, log
 * }` — `hardRejected:true` + `reason` (`"no-row"`/`"ppid-mismatch"`/`"slack-margin"`) on a hard rejection;
 * `hardRejected:false` + `reason:null` on exhaustion (every attempt was infra); `log` is every attempt's
 * own one-line diagnostic, newline-joinable, naming WHICH branch fired each time.
 *
 * @decision 0d8270b2 — a BOUNDED, logged backoff (`INFRA_RETRY_BACKOFF_MS`) sits between infra-failure
 * retries ONLY — a transient spawn/CIM squeeze (the manager's own "resource starvation under a concurrent
 * gate" hypothesis) may need more than an immediate re-try to clear; the default 5 attempts / ~3.75s of
 * total backoff is a deliberately small, bounded budget, not a blind long wait. Never applied before a
 * hard rejection (there is nothing to wait out) or before the first attempt.
 *
 * @decision 0d8270b2 (round 2) — the infra-vs-hard-reject decision is made PER PID, from THIS pid's own
 * `CAPTURE_REJECTION_REASONS` entry (set by `captureTestRegistryCreationTime`'s own settle handler, either
 * to `"infra"` on a genuine spawn/CIM error or to one of the three verification-rejection reasons) — never
 * from the GLOBAL `CAPTURE_STATS.failed` counter. A concurrent capture for an UNRELATED pid also bumps that
 * global counter while THIS pid's own await is still outstanding; reading it as THIS pid's own outcome
 * would misclassify a genuine hard rejection (slack-margin/ppid-mismatch/no-row) as a retryable infra
 * failure and retry past it — masking exactly the regression this mechanism exists to catch. `__testHooks`
 * (test-only, never set by a real caller) lets a hermetic test fully control the per-attempt outcome
 * without a real win32 CIM race — see `pty-root-reap-test-tripwire.mjs`'s own "(helper)" scenario.
 */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// @decision 0bc86798 — attempts/backoff are no longer a local const: both are read from
// win32-root-creation.ts (`ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS`/`_BACKOFF_MS`), the SAME ladder
// production's own `armRootCreationTimeWithRetry` (pty/host.ts) retries with — one source, never two
// copies to drift. `attempts` stays an explicit override param (tests that want a smaller/larger budget
// still can); only its DEFAULT comes from the shared leaf now.
export async function armWitnessWithFreshRetry(spawnCandidate, { attempts, __testHooks } = {}) {
  // Capture mechanism not engaged at all (POSIX, or `enableRootCreationCapture()` never called) — mirrors
  // `awaitRootCreationCapture`'s own immediate-null shape for this case: spawn ONCE, return immediately
  // with `creationTime: null`, never retry (there is nothing a retry could change).
  if (!rootCreationCaptureEnabled || process.platform !== "win32") {
    const child = spawnCandidate();
    return {
      pid: child.pid, child, creationTime: null, hardRejected: false, reason: null,
      log: ["capture mechanism not engaged (non-win32 or disabled) — single spawn, no retry"],
    };
  }
  // @decision 0bc86798 — the backoff itself is also read from the shared leaf
  // (`resolveRootCreationCaptureBackoffMs`, CR 5518e77c item 3), never a local index into the raw ladder
  // array — production's own retry loop repeats the last slot past the ladder's length and applies
  // jitter; computing backoff any other way here would silently diverge the moment either side changes.
  const { ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS, resolveRootCreationCaptureBackoffMs: resolveBackoffMs } = await loadWin32RootCreationLeaf();
  const resolvedAttempts = attempts ?? ROOT_CREATION_CAPTURE_RETRY_ATTEMPTS;
  const awaitCapture = __testHooks?.awaitCapture ?? awaitRootCreationCapture;
  const log = [];
  for (let attempt = 1; attempt <= resolvedAttempts; attempt++) {
    const child = spawnCandidate();
    const pid = child.pid;
    let result = null;
    let threw = null;
    try {
      result = await awaitCapture(pid);
    } catch (err) {
      threw = err;
    }
    if (threw) {
      try { child.kill(); } catch { /* already gone */ }
      const isLastAttempt = attempt >= resolvedAttempts;
      const backoffMs = isLastAttempt ? null : resolveBackoffMs(attempt);
      log.push(`attempt ${attempt}/${resolvedAttempts} pid=${pid}: INFRA FAILURE (spawn/CIM error) — ${threw?.message ?? threw}` +
        (backoffMs != null ? ` — backing off ~${backoffMs}ms then retrying` : ""));
      if (backoffMs != null) await sleep(backoffMs);
      continue;
    }
    if (typeof result === "number" && result > 0) {
      log.push(`attempt ${attempt}/${resolvedAttempts} pid=${pid}: VERIFIED (creationTime=${result}) — armed`);
      return { pid, child, creationTime: result, hardRejected: false, reason: null, log };
    }
    // @decision 0d8270b2 (round 2) — PER-PID classification, never the global CAPTURE_STATS.failed
    // counter (see this function's own doc above for why that counter is unsafe to read here).
    const reason = CAPTURE_REJECTION_REASONS.get(pid) ?? "unknown";
    try { child.kill(); } catch { /* already gone */ }
    if (reason === "infra") {
      const isLastAttempt = attempt >= resolvedAttempts;
      const backoffMs = isLastAttempt ? null : resolveBackoffMs(attempt);
      log.push(`attempt ${attempt}/${resolvedAttempts} pid=${pid}: INFRA FAILURE (resolved null via capture's own catch)` +
        (backoffMs != null ? ` — backing off ~${backoffMs}ms then retrying` : ""));
      if (backoffMs != null) await sleep(backoffMs);
      continue;
    }
    // A genuine verification rejection (no-row / ppid-mismatch / slack-margin), OR an "unknown" pid this
    // run never classified at all (fail safe: never silently retry something unclassified) — NEVER
    // retried. See this function's own doc for why slack-margin joined ppid-mismatch/no-row here once the
    // production fix (docs/decisions/87691385-*.md round 7) made it a real, test-worthy anomaly rather
    // than noise.
    log.push(`attempt ${attempt}/${resolvedAttempts} pid=${pid}: HARD REJECT (${reason}) — NOT retrying`);
    return { pid: null, child: null, creationTime: null, hardRejected: true, reason, log };
  }
  return { pid: null, child: null, creationTime: null, hardRejected: false, reason: null, log };
}

/**
 * Wraps `moduleExports[name]` to record its result's own `.pid` into {@link LOOM_TEST_SPAWNED_PIDS},
 * preserving `this`/argument/return passthrough exactly. `exec`/`execFile` carry `util.promisify.custom`
 * (a Symbol-keyed own property) so `promisify(exec)` resolves `{stdout, stderr}` instead of the default
 * single-value convention — a bare reassignment drops it, silently breaking `promisify(cp.exec)` for
 * every test/production caller in the whole suite (this wrapper sits under EVERY test file). Copies
 * every own key (string AND symbol) from the original onto the wrapper, individually try/caught so a
 * non-configurable property (if any) is skipped rather than throwing and breaking the patch itself.
 *
 * `captureCreationTime` (card 85ae7768, default false) additionally ROUTES the spawned pid through
 * {@link captureTestRegistryCreationTime} — ONLY passed `true` for `node:child_process`'s own `spawn`,
 * the ONE spawn kind this suite ever hands DIRECTLY to `reapOrphanedDescendants`/`sweepOrphanedDescendants`
 * as a registered root (traced: never `fork`/`exec`/`execFile`, and never node-pty's own spawn — a
 * node-pty-spawned root already gets its own production-side capture via
 * `armWin32RootCreationTime`/`live.creationTime`, 87691385). This alone is NOT what keeps the cost off
 * every other `cp.spawn` caller, though — `simple-git` and most test helpers spawn real processes via this
 * SAME primitive, so `captureTestRegistryCreationTime`'s own `rootCreationCaptureEnabled` opt-in gate
 * (see its own doc above) is what actually makes this free by default; the kind-narrowing here only
 * matters once a test has opted in, to avoid ALSO recursing through `fork`/`exec`/`execFile`/node-pty for
 * no reason.
 */
function wrapSpawnLikeForTestRegistry(moduleExports, name, captureCreationTime = false) {
  const original = moduleExports[name];
  const patched = function patchedForTestSpawnRegistry(...args) {
    const result = original.apply(this, args);
    const registeredAt = Date.now(); // AFTER the real spawn call returns — mirrors production's ordering.
    // Best-effort bookkeeping ONLY — a registry failure (should never happen for a Set.add(number))
    // must never prevent the REAL result from reaching the real caller.
    try {
      if (result && typeof result.pid === "number") {
        LOOM_TEST_SPAWNED_PIDS.add(result.pid);
        if (captureCreationTime) captureTestRegistryCreationTime(result.pid, registeredAt);
      }
    } catch { /* best-effort */ }
    return result;
  };
  for (const key of Reflect.ownKeys(original)) {
    if (key === "arguments" || key === "caller") continue; // throw on access for a strict-mode function
    try {
      const desc = Object.getOwnPropertyDescriptor(original, key);
      if (desc) Object.defineProperty(patched, key, desc);
    } catch { /* best-effort — leave the wrapper's own value for this key */ }
  }
  moduleExports[name] = patched;
}

{
  const requireHere = createRequire(import.meta.url);
  const cp = requireHere("node:child_process");
  wrapSpawnLikeForTestRegistry(cp, "spawn", /* captureCreationTime */ true);
  for (const name of ["fork", "exec", "execFile"]) wrapSpawnLikeForTestRegistry(cp, name);
  // Re-syncs every BUILTIN module's named ESM exports to the CJS exports object's CURRENT property
  // values (Node's own documented mechanism, builtins only) — without this, a module that did
  // `import { spawn } from "node:child_process"` would still hold the ORIGINAL, unpatched binding.
  syncBuiltinESMExports();

  // @decision 8c8ee0ee (CR, real-spawn incident) — node-pty is NOT a builtin, so syncBuiltinESMExports
  // above has no effect on it; it needs no equivalent call, though — Node's CJS/ESM interop already gives
  // a named import of an ordinary (non-builtin) CJS package a LIVE-BINDING getter onto its module.exports
  // (verified empirically: patching `require("node-pty").spawn` here is visible to pty/host.ts's own
  // `import { spawn } from "node-pty"`, even though that import resolves at a LATER dynamic `import()`).
  // Without this, EVERY real-spawn test (a test whose PtyHost subclass deliberately delegates to the REAL
  // `createPty`/`createCodexPty`/`createShellPty`, which all call node-pty's `spawn` — not
  // node:child_process's) left its own real root pid completely untracked: once that root died (the
  // ordinary, ALWAYS-fires onExit reap), neither branch (the dead root has no live-enumeration row, and
  // it was never in this registry either) could recognize it, and the tripwire wrongly refused the
  // legitimate, pre-existing real-spawn pattern itself. Best-effort: some environment could plausibly
  // lack a buildable node-pty; never let a broken/missing native module break every OTHER test's import
  // of this file.
  try {
    const ptyMod = requireHere("node-pty");
    wrapSpawnLikeForTestRegistry(ptyMod, "spawn");
  } catch { /* best-effort — see doc above */ }
}

const REAL_LOOM_HOME = path.resolve(path.join(os.homedir(), ".loom"));
const OS_TMPDIR = path.resolve(os.tmpdir());

// Card 49c50b80: a LOOM_HOME this hook may safely clean up (i.e. whose `-worktrees` sibling it deletes)
// MUST be a genuine, strict subdirectory of the OS temp dir — that is the structural proof it's a
// throwaway home a TEST created (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`, the shape every test in
// this suite uses — the harness's own `runOne`, `_tmp-fixture.mjs`'s `mkdtempManaged`/`useOwnLoomHome`,
// and 600+ hand-rolled per-file `tmpHome` variables all satisfy this by construction), never a REAL
// non-default LOOM_HOME a human pointed a second daemon at (`CLAUDE.md`: "override LOOM_HOME/LOOM_PORT
// for two daemons side by side") — which is exactly the exposure this card fixed: the old code deleted
// `<LOOM_HOME>-worktrees` for ANY LOOM_HOME other than the real one, with no proof it was test-created.
// This needs no per-caller marker file (the DoD's alternative (a) — "restores an invariant each new
// caller must remember", per the card) because the proof is a property of HOW every test-created home is
// already built, not something a new caller could forget to add.
function isTestCreatedHome(resolved) {
  const home = normalizeForCompare(resolved);
  const tmp = normalizeForCompare(OS_TMPDIR);
  return home !== tmp && home.startsWith(tmp + path.sep);
}

/**
 * Card 5eace211 (Code Review, CRITICAL) — the SAME strict-subdirectory-of-OS-tmpdir proof as
 * {@link isTestCreatedHome} above, generalized to any path a test wants to verify before mutating it —
 * specifically `PROJECTS_WORK_ROOT` (`paths.ts`), which a human may set via `LOOM_PROJECT_WORK_ROOT` to
 * point at the REAL shared root every project's caches live under (Decision 2 in
 * `docs/decisions/5eace211-project-work-dir-sibling-root.md` explicitly recommends this). A test that
 * resolves `PROJECTS_WORK_ROOT` and then recursively removes it (cleanup) or creates entries under it
 * (`ensureProjectWorkDir`) MUST first prove the resolved value is this test's OWN temp-derived root, never
 * an inherited one — this is that proof, exported so every such call site can share ONE implementation
 * instead of re-deriving the tmpdir-containment check by hand. Throws (never returns false) so a caller
 * can simply call it right before the dangerous operation and let a violation abort loudly instead of
 * silently skipping the mutation (which would mask the bug rather than surface it).
 * @param {string} label  what this path is, for the thrown message (e.g. "PROJECTS_WORK_ROOT")
 * @param {string} p
 */
export function assertUnderOsTmpdir(label, p) {
  const resolved = path.resolve(p);
  if (!isTestCreatedHome(resolved)) {
    throw new Error(
      `🛑 refusing to touch ${label} (${resolved}) — it is NOT a strict subdirectory of the OS temp dir ` +
        `(${OS_TMPDIR}), so it cannot be proven to be this test's own throwaway root. This guard exists ` +
        `specifically to stop a test from mutating a human-set LOOM_PROJECT_WORK_ROOT override.`,
    );
  }
}

/**
 * Card 2c9f0854 (Code Review of 5eace211, round 3, item 1) — mirrors `paths.ts`'s OWN derivation of
 * `PROJECTS_WORK_ROOT` from `LOOM_HOME` EXACTLY (`path.dirname`/`path.basename` on the RAW, unresolved
 * `LOOM_HOME` value — see `paths.ts` ~:109: `path.join(path.dirname(LOOM_HOME), \`${basename}-projects\`)`),
 * so `requireHermeticEnv` can tell "this override equals what THIS test's own LOOM_HOME would derive
 * anyway" apart from "this is some OTHER throwaway root that merely happens to also live under the OS
 * temp dir" — e.g. a human's isolated-daemon-for-UI-review recipe (CLAUDE.md's own recipe), which has its
 * own genuine LOOM_HOME and its own derived `-projects` sibling, ALSO under the OS temp dir.
 * `assertUnderOsTmpdir`/`isTestCreatedHome` alone cannot distinguish these two cases — both pass "is
 * under tmp" — which is exactly the gap this closes.
 * @param {string} home  the raw (unresolved) LOOM_HOME value
 */
function deriveDefaultProjectsWorkRoot(home) {
  return path.join(path.dirname(home), `${path.basename(home)}-projects`);
}

// Card 2c9f0854 — a test that genuinely needs `LOOM_PROJECT_WORK_ROOT` to be something OTHER than this
// test's own derived default (e.g. exercising the override mechanism itself) registers that EXACT value
// here, BEFORE calling `requireHermeticEnv()`. This is the ONLY way `requireHermeticEnv` can tell "a
// value this test deliberately owns" apart from "an ambient value this test merely inherited" — both
// arrive identically as a `process.env.LOOM_PROJECT_WORK_ROOT` string, so there is no way to recover
// provenance from the value alone; a caller has to say so. Pinning never WIDENS what's accepted beyond
// the existing tmp-dir-containment proof — `assertUnderOsTmpdir` still runs on the pinned value itself —
// it only adds a second path TO that same proof, alongside "matches this test's own derived default".
let pinnedProjectWorkRootOverride = null;
export function pinProjectWorkRootOverrideForTest(value) {
  const resolved = path.resolve(value);
  assertUnderOsTmpdir("LOOM_PROJECT_WORK_ROOT (pinned)", resolved);
  pinnedProjectWorkRootOverride = resolved;
}

// Arm the Db prod-guard for THIS process (and inherited by spawned daemons) the moment we're imported.
process.env.LOOM_TEST = "1";

// @decision d5432aff — redirect PowerShell's module-analysis cache out of cwd under a sandboxed
// USERPROFILE; never clobber a runner-injected value. See docs/decisions/d5432aff-*.md.
let psModuleCacheDir = null;
if (process.platform === "win32" && !process.env.PSModuleAnalysisCachePath) {
  psModuleCacheDir = path.join(os.tmpdir(), `loom-test-ps-cache-${process.pid}`);
  process.env.PSModuleAnalysisCachePath = path.join(psModuleCacheDir, "ModuleAnalysisCache");
}

// LOOM_HOME-derived WORKTREES_DIR leak (card de7abf0b): `paths.ts` defines `WORKTREES_DIR` as a SIBLING
// of LOOM_HOME (`<dirname>/<basename>-worktrees`), never a child of it. Every hermetic test that sets its
// own temp LOOM_HOME (the near-universal pattern in this suite — see that file's own header) and then
// touches `createWorktree` leaves this sibling behind: cleanup code everywhere targets LOOM_HOME itself
// (or individual leaf worktree paths), never this derived path, so the per-project parent directories
// `createWorktree` creates under it — and sometimes real worktree content, if a test's own cleanup never
// ran — accumulate forever. Measured: a single run of worker-noop-done.mjs alone left a fresh
// `<LOOM_HOME>-worktrees` dir with 6 empty per-project leftovers.
// This hook is the ONE chokepoint: `_guard.mjs` is imported FIRST by every test in this convention
// (measured 612/714 non-underscore files, 2026-08-07), so fixing it here needs no per-file edit. It must
// be LAZY (read `process.env.LOOM_HOME` only when the hook actually fires) because every test sets its
// OWN LOOM_HOME AFTER this import — `paths.ts` reads LOOM_HOME at module load, so the override always
// happens later in the file. `exit` (not `beforeExit`) mirrors `_tmp-fixture.mjs`'s own reasoning: nearly
// every file in this suite ends with an explicit `process.exit(N)`, which only `exit` fires for.
// KNOWN NON-COVERAGE, STATED NOT FIXED: the ~14% of files that don't import `_guard.mjs` at all get none
// of this (they predate, or opted out of, the shared prod-guard convention) — same class of gap as
// `_tmp-fixture.mjs`'s own SIGKILL/`taskkill /F` caveat, not papered over here either.
// CLEAN-ON-PASS-VS-RETAIN-ON-FAIL (card de7abf0b DoD-2): deliberately UNCONDITIONAL, not gated on the
// exit code. A retained LOOM_HOME can be real post-mortem evidence (its db/logs/event history) — but
// this cleans up a DIFFERENT thing, the WORKTREES_DIR sibling (git worktree checkouts), whose diagnostic
// value on a failure is already covered by the runner's captured stdout/stderr (printed on FAIL — see
// `runOne` in scripts/test-daemon.mjs) and by git history, not by an on-disk checkout. Every existing
// per-file LOOM_HOME/worktree cleanup in this suite (600+ sites) is ALSO unconditional (a bare `finally`,
// no pass/fail branch) — matching that established convention here avoids a new, surprising asymmetry
// where this ONE derived path survives a failure and nothing else does.
process.on("exit", () => {
  // @decision d5432aff — best-effort cleanup of the dir THIS file (never test-daemon.mjs) created above.
  if (psModuleCacheDir) cleanupPathSync(psModuleCacheDir);

  const home = process.env.LOOM_HOME;
  if (!home) return;
  const resolved = path.resolve(home);
  if (normalizeForCompare(resolved) === normalizeForCompare(REAL_LOOM_HOME)) return; // never touch the real ~/.loom-worktrees
  // Card 49c50b80: refuse unless `resolved` is provably a test-created temp home (see isTestCreatedHome
  // above) — this hook is reachable from a bare `node <guard-file>.mjs` invocation (both
  // buildReducedGateCommand's reduced merge-gate steps and `pnpm --filter @loom/daemon guards`), which
  // inherits the CALLER's ambient LOOM_HOME with no scrub. Before this fix, ANY non-real LOOM_HOME —
  // including a real, non-default one a human pointed a second daemon at — had its `-worktrees` sibling
  // (every project's live worker worktrees on that daemon) deleted unconditionally.
  if (!isTestCreatedHome(resolved)) return;
  cleanupPathSync(`${resolved}-worktrees`);
  // Card 5eace211 (Code Review MINOR 6) — `PROJECTS_WORK_ROOT` (paths.ts) is ALSO a sibling of LOOM_HOME
  // (`<dirname>/<basename>-projects`), the exact same shape as `-worktrees` above, and the DEFAULT when
  // `LOOM_PROJECT_WORK_ROOT` is unset — so any test that calls `ensureProjectWorkDir`/`projectWorkDir`
  // without an explicit override leaves this sibling behind too, for the identical reason `-worktrees`
  // used to leak. Same `isTestCreatedHome` proof already gated this cleanup on above, so no separate
  // guard is needed — a test that explicitly pinned `LOOM_PROJECT_WORK_ROOT` to some OTHER temp dir still
  // leaves THIS sibling empty/absent, which `cleanupPathSync` already treats as a no-op.
  cleanupPathSync(`${resolved}-projects`);
});

// Strip GIT_PAGER/PAGER from the test process env. This USED to be the only defense — card 42544916
// proved the assumption behind it wrong: "production only runs in the supervisor-spawned daemon
// process, never the worker/manager pty's GIT_PAGER=cat" ignored that the supervisor itself inherits
// whatever env the HUMAN's own launching shell has, and a real end user with GIT_PAGER/PAGER set in
// their own shell profile (an ordinary personal git config) hit the exact same 500 in production — not
// just in a worker-spawned test run. The REAL fix now lives at the source: `nonInteractiveEnv()`
// (git/writer.ts) strips GIT_PAGER/PAGER (and EDITOR/GIT_EXTERNAL_DIFF alongside the pre-existing
// GIT_EDITOR/GIT_SEQUENCE_EDITOR) itself, so GitReader/GitWriter are immune regardless of ambient env —
// see its own comment for the full enumeration of what's stripped vs. deliberately still blocked. This
// strip stays here only for parity with a bare test process that imports simple-git directly without
// going through nonInteractiveEnv(); it is no longer load-bearing for the daemon's own git reads/writes.
delete process.env.GIT_PAGER;
delete process.env.PAGER;

const PROD_PORT = 4317;

/**
 * Abort unless this process is pointed at an isolated test environment — never prod.
 * @param {{ port?: boolean }} opts  port:true also requires LOOM_PORT to be set and != 4317
 *   (use for any test that fetch()es a live daemon).
 *
 * SCOPE, NARROWER THAN IT LOOKS (card 7a5948bd): this only proves `LOOM_HOME` (and, with `port:true`,
 * `LOOM_PORT`) are isolated — it does NOT mean this process can't reach real `~/.loom` by any route.
 * Since card d1e10795, every test child spawned by `scripts/test-daemon.mjs` also carries a SEPARATE,
 * ADDITIVE `LOOM_REAL_HOME` env var (the harness's own real home, for durable diagnostic telemetry) that
 * this function never inspects and never could — a test reading `process.env.LOOM_REAL_HOME` and writing
 * through it reaches prod with this guard passing the whole time. That's a real, narrower gap, closed not
 * here but by `real-home-scope-guard.mjs`, which allowlists+shape-checks every such read instead.
 */
export function requireHermeticEnv({ port = false } = {}) {
  const problems = [];

  const home = process.env.LOOM_HOME;
  if (!home) problems.push("LOOM_HOME is unset (would default to the real ~/.loom)");
  else if (path.resolve(home) === REAL_LOOM_HOME)
    problems.push(`LOOM_HOME resolves to the real ~/.loom (${path.resolve(home)})`);

  // @decision 0ee30648 — dist/paths.js may have already been imported (and its LOOM_HOME/PORT consts
  // frozen) BEFORE this test ever set the env above; a current value that merely LOOKS isolated doesn't
  // prove the already-loaded module saw it. See loomHomeImportOrderingViolation's own doc for the rule.
  const homeOrderingViolation = loomHomeImportOrderingViolation();
  if (homeOrderingViolation) {
    problems.push(
      `dist/paths.js was imported while LOOM_HOME was still the real default ` +
        `(${homeOrderingViolation.frozen}), BEFORE this process re-pointed it to ` +
        `${homeOrderingViolation.current} — every paths.ts-derived const in this process is frozen at ` +
        `the real value regardless. Fix: set LOOM_HOME (or call useOwnLoomHome()) BEFORE the first ` +
        `import of anything under ../dist.`,
    );
  }

  // Card 5eace211 (Code Review, CRITICAL) — `LOOM_PROJECT_WORK_ROOT` is a human-set override pointing at
  // the REAL shared root every project's caches/build output live under (Decision 2). Unset is always
  // fine (paths.ts derives a sibling of the temp LOOM_HOME instead).
  //
  // Card 2c9f0854 (round 3, item 1) — a bare "is it under the OS temp dir" check (the original shape of
  // this block) is NOT enough: an ambient override that itself lives under the OS temp dir (e.g. a
  // human's own isolated-daemon-for-UI-review recipe, with its own genuine LOOM_HOME and derived
  // `-projects` sibling) would PASS that check and still be the WRONG root for THIS test — a pin-less
  // test would then silently walk/mutate that other throwaway root instead of its own. SET is only fine
  // when it equals EXACTLY WHAT THIS TEST'S OWN LOOM_HOME would derive by default (so the override is
  // inert — identical to not having set it at all), or when this test explicitly registered that exact
  // value via `pinProjectWorkRootOverrideForTest` above. Anything else — including a value that merely
  // passes the OLD tmp-dir-containment check — is refused.
  const projectWorkRoot = process.env.LOOM_PROJECT_WORK_ROOT;
  if (projectWorkRoot) {
    const resolvedOverride = path.resolve(projectWorkRoot);
    const expectedDefault = home ? path.resolve(deriveDefaultProjectsWorkRoot(home)) : null;
    const matchesDefault = expectedDefault != null && normalizeForCompare(resolvedOverride) === normalizeForCompare(expectedDefault);
    const matchesPin = pinnedProjectWorkRootOverride != null
      && normalizeForCompare(resolvedOverride) === normalizeForCompare(pinnedProjectWorkRootOverride);
    if (!matchesDefault && !matchesPin) {
      problems.push(
        `LOOM_PROJECT_WORK_ROOT (${resolvedOverride}) does not match this test's own derived root ` +
          `(${expectedDefault ?? "<unknown — LOOM_HOME unset>"}) and was not registered via ` +
          `pinProjectWorkRootOverrideForTest() — this looks like an AMBIENT value this test merely ` +
          `inherited (e.g. another throwaway LOOM_HOME's own -projects sibling, which can also live ` +
          `under the OS temp dir and would otherwise pass a bare tmp-dir-containment check), not one it ` +
          `deliberately owns. Clear it (delete process.env.LOOM_PROJECT_WORK_ROOT), or if this test ` +
          `genuinely needs a distinct root, call pinProjectWorkRootOverrideForTest(value) before ` +
          `requireHermeticEnv() — before importing dist/paths.js either way.`,
      );
    }
  }

  if (port) {
    const p = process.env.LOOM_PORT;
    if (!p) problems.push("LOOM_PORT is unset (would default to the prod daemon on 4317)");
    else if (Number(p) === PROD_PORT) problems.push("LOOM_PORT == 4317 (the prod daemon)");

    // @decision 0ee30648 — the PORT twin of the LOOM_HOME ordering check above.
    const portOrderingViolation = portImportOrderingViolation();
    if (portOrderingViolation) {
      problems.push(
        `dist/paths.js was imported while LOOM_PORT was still the real default ` +
          `(${portOrderingViolation.frozen}), BEFORE this process re-pointed it to ` +
          `${portOrderingViolation.current} — PORT in this process is frozen at the real value ` +
          `regardless. Fix: set LOOM_PORT BEFORE the first import of anything under ../dist.`,
      );
    }
  }

  if (problems.length) {
    console.error(
      "\n🛑 refusing to run tests against prod — set LOOM_HOME=<temp> and LOOM_PORT=<non-4317>.\n" +
        problems.map((p) => "  - " + p).join("\n") +
        "\n",
    );
    process.exit(99);
  }
}
