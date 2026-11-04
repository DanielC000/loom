// Card dfef375f round 2 item 2: an END-TO-END replay of the 2026-11-03 incident's shape (re-cap ~1s
// after every resume) that drives the REAL `RateLimitWatcher` on a real timer AND the REAL
// `handleRateLimitedCap` (orchestration/rate-limit-cap.ts, round 3 item 3's extracted core of
// `index.ts`'s `onRateLimited` — this test now calls THAT exported function directly rather than a
// hand-mirrored copy of its composition) — not just the pure-function replay
// `usage-limit-loop-breaker.mjs` already covers in isolation.
//
// Card dfef375f round 4 item 1 (CORRECTION): calling the real `handleRateLimitedCap` here does NOT, by
// itself, catch a mutant that reorders its own internals (e.g. moving `recordClaudeRateLimit` below the
// bail `return`) — none of scenarios 1/2's own checks read the global usage-awareness latch file, so
// that exact mutant survived every one of them. Scenario 3 below is the actual regression guard for that
// ordering — see its own header for why.
//
// WHY THIS TEST EXISTS (and the pure-function replay alone doesn't prove it): a Code Review simulation
// found round 1's own breaker still took 6 caps to end the incident, because the PRE-EXISTING
// `RateLimitWatcher` deadline (fixed from the first cap, independent of the breaker) bailed the episode
// FIRST — before the breaker's own escalation ever finished playing out. Proving "the breaker's pure
// function bails within N caps" in isolation says nothing about which mechanism actually wins the race
// in the real system. This test drives BOTH mechanisms together, for real.
//
// Card dfef375f round 3 item 2: a SECOND scenario below (`hookReset`) proves the round-2 "bails within 4
// caps" claim is scoped to the NO-RESET incident shape — when a hook DOES report a resetsAtSeconds on
// every cap (the CLI's own `cooldown`-type quirk this card's own Incident section names as an open
// residual), the escalating backoff can legitimately outlast the independent watcher's own fixed
// deadline, so the WATCHER bails the episode first, in even fewer caps — and that is an ACCEPTED,
// equally-safe outcome (see docs/decisions/dfef375f-rate-limit-loop-breaker.md's Round 3 section), not a
// regression. Short `cooldown`-type caps retrying soon instead of parking at all is card c498afe0's job,
// out of scope here.
//
// Real time is used throughout (no injected/frozen `now`) — every tunable below is scaled down by
// roughly three orders of magnitude from the real incident's minute/hour figures so each episode resolves
// in well under a second of real wall-clock time, with generous margins against ordinary test-runner
// scheduling jitter. `RateLimitWatcher.resume()`/`bail()`/`succeed()` stamp their own audit events via
// the REAL wall clock internally (pre-existing, unrelated to this card) — using real time end to end,
// rather than fighting that with an injected clock, is what keeps this test correct rather than merely
// passing.
//
// RUN (no live daemon needed): node test/rate-limit-loop-breaker-e2e-replay.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rlreplay-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { RateLimitWatcher } = await import("../dist/orchestration/rate-limit-watcher.js");
const { handleRateLimitedCap } = await import("../dist/orchestration/rate-limit-cap.js");
const { clearClaudeRateLimit, readClaudeUsageState } = await import("../dist/orchestration/usage-awareness.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const now0 = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now0, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

const usageStatus = { getStatus: () => undefined };
const QUICK_RECAP_DELAY_MS = 30; // the incident's own "re-cap almost immediately after resume" signature

/**
 * Drives the REAL extracted `handleRateLimitedCap` (card dfef375f round 3 item 3) + the REAL
 * `RateLimitWatcher` on a real timer, racing them against each other, for one session. `hookResetOffsetSec`
 * (when set) makes every cap report a hook `resetsAtSeconds` this many seconds in the future — the
 * round-3 item 2 hook-reset variant; omitted entirely reproduces the original no-reset incident shape.
 * Resolves once a `rate_limit_bailed` event lands for this session, or the bound is hit (bailEventSeen
 * stays null in that case — the caller's own checks then fail loudly rather than hang).
 */
async function runEpisode(sid, cfg, hookResetOffsetSec) {
  db.insertSession({
    id: sid, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now0, lastActivity: now0, lastError: null,
  });

  let capCount = 0;
  let bailEventSeen = null; // {reason, ...} — whichever mechanism actually fired

  function fireCap() {
    capCount++;
    const resetsAtSeconds = hookResetOffsetSec === undefined ? undefined : Date.now() / 1000 + hookResetOffsetSec;
    handleRateLimitedCap(
      { db, pty, usageStatus }, sid,
      { resetsAtSeconds, type: undefined, detector: "stop_failure" },
      cfg, new Date(),
    );
  }

  const pty = {
    isAlive: () => true,
    // Simulates the resume firing, then — the incident's OWN signature — the account is STILL capped and
    // re-caps almost immediately. Scheduled (not called inline) so RateLimitWatcher.resume() finishes its
    // OWN bookkeeping (recordRateLimitResume) before this fires, exactly mirroring how a real StopFailure
    // arrives asynchronously, on a later turn, after the resume's own turn has already started.
    //
    // THE RACE THIS GUARDS (reproduced deterministically in isolation, outside this suite, before this
    // fix landed): RateLimitWatcher.resume() clears the park and schedules this recap via a bare
    // setTimeout. If that resume itself lands late enough relative to the episode's fixed deadline, the
    // watcher's own next tick can bail the episode WHILE this timer is still pending — and the timer then
    // fires AFTERWARD, on a session that has ALREADY bailed (its breaker state just cleared), re-arming a
    // brand-new, non-null rateLimitedUntil/rateLimitDeadline. Measured live (40 solo runs, no induced
    // load): ~2.5% of runs hit this even at the test's own nominal margins, matching the card's real
    // failure under a loaded full gate (more scheduling jitter, not a different mechanism). Retiring the
    // timer from the OUTSIDE once a bail is observed is NOT sufficient — the stale fire can land before
    // the caller's own poll even notices the bail (measured directly). The fix has to live HERE, at the
    // one place the race actually resolves: check synchronously, at fire time, whether the episode has
    // already ended, before acting on it — deterministic regardless of how ticks/timers interleave.
    resumeAfterRateLimit: (id) => {
      db.setBusy(id, true); // the resumed turn is "in flight" until the StopFailure below clears it
      setTimeout(() => {
        db.setBusy(id, false);
        if (db.getSession(id)?.rateLimitBailedAt) return; // the episode already ended — this late "StopFailure" is moot
        fireCap();
      }, QUICK_RECAP_DELAY_MS);
      return true;
    },
  };

  const watcher = new RateLimitWatcher({ db, pty, intervalMs: 15 });
  try {
    // THE FIRST CAP (no prior resume — "no reset on first cap", matching the real investigation, even in
    // the hook-reset variant: the hook only starts reporting resets from the FIRST cap onward either way).
    fireCap();
    watcher.start();
    const deadline = Date.now() + 3000; // generous bound — either mechanism should win in well under 1s
    while (bailEventSeen === null && Date.now() < deadline) {
      const bailed = db.listOrchestrationEventsBounded({ kind: ["rate_limit_bailed"], sessionId: sid, limit: 10, offset: 0 });
      if (bailed.total > 0) bailEventSeen = bailed.items[0].detail;
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    watcher.stop();
  }
  return { capCount, bailEventSeen, row: () => db.getSession(sid) };
}

try {
  // ===== Scenario 1: the real incident's own shape — NO hook reset on any cap. The breaker's own
  // CONSECUTIVE-quick-re-cap count (default 3) should bail it, well before the independent watcher's own
  // fixed 5s deadline. =====
  const cfg1 = {
    defaultBackoffMs: 150, resetBufferMs: 0, deadlineAfterResetMs: 5000, deadlineNoResetMs: 5000,
    recencyWindowMs: 0, exhaustedThresholdPct: 95,
    loopBreakerMaxRecaps: 3, loopBreakerQuickGapMs: 3000, loopBreakerBackoffBaseMs: 60, loopBreakerBackoffCeilingMs: 240,
  };
  const r1 = await runEpisode("sess-e2e-replay-noreset", cfg1, undefined);

  check("(1) setup: the first cap parked before any resume occurred", r1.capCount >= 1);
  check("(1) e2e: the episode actually bailed within the bounded poll window", r1.bailEventSeen !== null);
  // THE DEFINING PROOF (round 2 item 2): the loop BREAKER bailed it — not the independent watcher
  // deadline. In the real incident's shape, round 1's own breaker never won this race (the Code Review
  // simulation found the watcher's fixed deadline fired first, at 6 caps, same as having no breaker).
  check("(1) e2e: the BREAKER bailed it (reason:\"loop_breaker\"), not the independent watcher deadline",
    r1.bailEventSeen?.reason === "loop_breaker");
  check(`(1) e2e: FEWER caps than the OLD design's 6 (actual: ${r1.capCount})`, r1.capCount < 6);
  check("(1) e2e: exactly ONE rate_limit_bailed event (no double-bail from both mechanisms racing)",
    db.listOrchestrationEventsBounded({ kind: ["rate_limit_bailed"], sessionId: "sess-e2e-replay-noreset", limit: 10, offset: 0 }).total === 1);
  const row1 = r1.row();
  check("(1) e2e: the session stays genuinely parked after the bail (rateLimitedUntil null, lastError set)",
    row1.rateLimitedUntil === null && typeof row1.lastError === "string" && row1.lastError.length > 0);

  // ===== Scenario 2 (round 3 item 2): a HOOK-RESET variant — every cap reports a resetsAtSeconds a short
  // way out (the "cooldown"-type quirk), so `deadlineAfterResetMs` (not `deadlineNoResetMs`) governs the
  // episode's own fixed give-up deadline. Margins below are chosen so the escalating backoff's own `until`
  // (the 2nd cap's park) lands WELL past that fixed deadline — the watcher must bail BEFORE the breaker's
  // own 3-recap count is ever reached. =====
  const cfg2 = {
    defaultBackoffMs: 150, resetBufferMs: 0, deadlineAfterResetMs: 60, deadlineNoResetMs: 5000,
    recencyWindowMs: 0, exhaustedThresholdPct: 95,
    loopBreakerMaxRecaps: 3, loopBreakerQuickGapMs: 3000, loopBreakerBackoffBaseMs: 60, loopBreakerBackoffCeilingMs: 240,
  };
  const r2 = await runEpisode("sess-e2e-replay-hookreset", cfg2, 0.1); // every cap reports resetsAtSeconds ~100ms out

  check("(2) e2e: the hook-reset episode also bailed within the bounded poll window", r2.bailEventSeen !== null);
  // THE ROUND-3 ITEM-2 PROOF: with a hook reset present on every cap, the independent WATCHER deadline —
  // not the breaker's own recap count — ends the episode, and well short of the breaker's maxRecaps(3).
  check("(2) e2e: the independent WATCHER deadline bailed it (reason:\"watcher_deadline\"), not the breaker",
    r2.bailEventSeen?.reason === "watcher_deadline");
  check(`(2) e2e: bailed in FEWER caps than the breaker's own maxRecaps threshold (actual: ${r2.capCount})`,
    r2.capCount > 0 && r2.capCount <= 2);
  check("(2) e2e: exactly ONE rate_limit_bailed event for this session",
    db.listOrchestrationEventsBounded({ kind: ["rate_limit_bailed"], sessionId: "sess-e2e-replay-hookreset", limit: 10, offset: 0 }).total === 1);
  const row2 = r2.row();
  // Card dfef375f round 3 item 1: the durable "needs a human" marker is set regardless of WHICH mechanism
  // bailed — the watcher-deadline path must be exactly as human-visible as the breaker path.
  check("(2) e2e: the bailed session carries the durable rate_limit_bailed_at marker",
    typeof row2.rateLimitBailedAt === "string" && row2.rateLimitBailedAt.length > 0);
  check("(2) e2e: the session stays genuinely parked after the bail (rateLimitedUntil null, lastError set)",
    row2.rateLimitedUntil === null && typeof row2.lastError === "string" && row2.lastError.length > 0);

  // ===== Scenario 3 (round 4 item 1): the actual ordering regression guard. Scenarios 1/2 above prove
  // the breaker/watcher bail the episode — they do NOT prove the BAIL BRANCH still arms global
  // usage-awareness (item 4 of round 2): a mutant moving `recordClaudeRateLimit` below the bail `return`
  // in `handleRateLimitedCap` survives every check above untouched, since none of them read the global
  // latch file. Primes the loop breaker directly (no timer race needed) so the VERY FIRST call to the
  // REAL `handleRateLimitedCap` bails immediately, then asserts THAT SAME call armed the global latch. =====
  {
    const sid3 = "sess-e2e-replay-bail-latch";
    db.insertSession({
      id: sid3, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now0, lastActivity: now0, lastError: null,
    });
    const cfg3 = {
      defaultBackoffMs: 150, resetBufferMs: 0, deadlineAfterResetMs: 5000, deadlineNoResetMs: 5000,
      recencyWindowMs: 0, exhaustedThresholdPct: 95,
      loopBreakerMaxRecaps: 3, loopBreakerQuickGapMs: 3000, loopBreakerBackoffBaseMs: 60, loopBreakerBackoffCeilingMs: 240,
    };
    // Prime the breaker one short of the bail threshold, with a RECENT lastResumedAt (within
    // quickGapMs) — the very next cap counts as the maxRecaps-th CONSECUTIVE quick re-cap and bails
    // immediately, with no need to race the watcher's own timer.
    const primedAt = new Date().toISOString();
    db.recordRateLimitResume(sid3, primedAt);
    db.setRateLimitLoopBreakerState(sid3, primedAt, cfg3.loopBreakerMaxRecaps - 1);

    clearClaudeRateLimit();
    check("(3) setup: the global latch is genuinely clear before the primed cap", readClaudeUsageState().lastRateLimitAt === undefined);

    handleRateLimitedCap(
      { db, pty: { isAlive: () => true, resumeAfterRateLimit: () => true }, usageStatus }, sid3,
      { resetsAtSeconds: undefined, type: undefined, detector: "stop_failure" }, cfg3, new Date(),
    );

    const bailed3 = db.listOrchestrationEventsBounded({ kind: ["rate_limit_bailed"], sessionId: sid3, limit: 10, offset: 0 });
    check("(3) setup: the primed cap actually bailed (confirms the priming worked, not a park)", bailed3.total === 1);
    // THE REGRESSION PROOF: if `recordClaudeRateLimit` were moved below the bail `return`, this call
    // never reaches it, and the latch stays clear — this is exactly what the item-1 order mutant does.
    check("(3) e2e: the BAIL BRANCH still armed global usage-awareness (item 1's own regression)",
      typeof readClaudeUsageState().lastRateLimitAt === "string");
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — driving the REAL RateLimitWatcher on a real timer against two real shapes (no hook reset, and a hook-reset 'cooldown' variant): the no-reset shape bails via the loop BREAKER in fewer caps than the old design's 6, and the hook-reset shape bails via the independent WATCHER deadline in even fewer caps — both durably marked and human-visible the same way."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
