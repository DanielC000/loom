// Card dfef375f — the loop breaker + the rate-limit TYPE extraction + the hook/poller cross-check.
// Fully HERMETIC: pure functions only, no daemon, no claude, no DB. Mirrors the shape of
// usage-limit-detect.mjs's own PART 1, but self-contained (no daemon needed at all).
//
// RUN (no live daemon needed): node test/usage-limit-loop-breaker.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import {
  detectUsageLimit, resolveResumeReset, resumeResetFromUsageStatus, stepLoopBreaker, decideRateLimitPark,
  LOOP_BREAKER_MAX_RECAPS, LOOP_BREAKER_QUICK_GAP_MS, LOOP_BREAKER_BACKOFF_BASE_MS, LOOP_BREAKER_BACKOFF_CEILING_MS,
} from "../dist/orchestration/usage-limit.js";
import { PLATFORM_DEFAULTS } from "@loom/shared";

const rl = PLATFORM_DEFAULTS.platform.rateLimit;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================ item 1 — rate-limit TYPE extraction ============================
{
  check("type: a short enum-shaped error_details string is extracted",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "cooldown" }).type === "cooldown");
  check("type: a short enum-shaped error_details.type field is extracted",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit", error_details: { type: "blocked_five_hour" } }).type === "blocked_five_hour");
  check("type: absent when error_details carries no type-shaped field",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit", error_details: { resetsAt: 123 } }).type === undefined);
  // NEGATIVE CONTROL (redaction-safety bar): a free-text / long error_details must NEVER be surfaced as
  // "type" — proves the bound actually discriminates, not just that short strings happen to pass.
  check("type: a long free-text error_details is REJECTED, never surfaced as a type label",
    detectUsageLimit({
      hook_event_name: "StopFailure", error: "rate_limit",
      error_details: "You have exceeded your usage limit for the five hour window, please try again later",
    }).type === undefined);
  check("type: a short string containing a space is REJECTED (not enum-shaped)",
    detectUsageLimit({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "not valid" }).type === undefined);
  check("type: absent entirely when the hook isn't a StopFailure at all",
    detectUsageLimit({ hook_event_name: "Stop", error_details: "cooldown" }).type === undefined);
}

// ============================ item 2 — resolveResumeReset (hook vs poller, take the LATER) ============================
{
  const now = new Date("2026-11-03T08:00:00Z");
  const earlier = Math.floor(now.getTime() / 1000) + 10 * 60; // +10min
  const later = Math.floor(now.getTime() / 1000) + 90 * 60; // +90min
  const statusWith = (resetSec, utilization = 99) => ({
    available: true, fetchedAt: now.toISOString(),
    fiveHour: { utilization, resetsAt: new Date(resetSec * 1000).toISOString() },
    sevenDay: { utilization: 0, resetsAt: null },
    sevenDayOpus: null, sevenDaySonnet: null,
  });

  check("resolve: hook earlier, poller later → takes the poller's LATER reset, source=status",
    (() => {
      const r = resolveResumeReset(earlier, statusWith(later), now);
      return r.resetsAtSeconds === later && r.source === "status";
    })());
  check("resolve: hook later, poller earlier → takes the hook's LATER reset, source=hook",
    (() => {
      const r = resolveResumeReset(later, statusWith(earlier), now);
      return r.resetsAtSeconds === later && r.source === "hook";
    })());
  check("resolve: hook only (poller unavailable) → hook value, source=hook",
    (() => {
      const r = resolveResumeReset(later, { available: false, reason: "no token", fetchedAt: null }, now);
      return r.resetsAtSeconds === later && r.source === "hook";
    })());
  check("resolve: poller only (hook carries none) → poller value, source=status",
    (() => {
      const r = resolveResumeReset(undefined, statusWith(later), now);
      return r.resetsAtSeconds === later && r.source === "status";
    })());
  // DEGRADE-SAFE (the card's explicit hard requirement): poller unavailable + no hook reset → the
  // DEFAULT backoff applies, NEVER read as "no limit" (resetsAtSeconds stays `undefined`, not e.g. 0).
  check("resolve: neither side carries a reset → source=default, resetsAtSeconds undefined (never \"no limit\")",
    (() => {
      const r = resolveResumeReset(undefined, { available: false, reason: "schema changed", fetchedAt: null }, now);
      return r.source === "default" && r.resetsAtSeconds === undefined;
    })());
}

// ============================ item 3 — the loop breaker (round 2: CONSECUTIVE QUICK re-caps) ============================
// Round 2 (Code Review): round 1's own cap-to-cap WINDOW design is gone — a Code Review simulation
// found it still took 6 caps to end the real incident (see docs/decisions/dfef375f-rate-limit-loop-
// breaker.md's round-2 section). The streak now counts a cap ONLY when it arrives within
// `loopBreakerQuickGapMs` of the session's own last RESUME (the `lastResumedAt` param below) — every
// cap in the real incident shares that signature, even the early ones round 1 let through for free.
{
  // --- the episode's FIRST cap (no prior resume to compare against) is never tripped ---
  {
    const now = new Date("2026-11-03T08:00:00Z");
    const r = stepLoopBreaker(null, null, now);
    check("breaker: the first cap (no lastResumedAt) is never tripped — streak starts at 0",
      r.tripped === false && r.bail === false && r.state.recapCount === 0);
  }

  // --- a cap that arrives QUICKLY after the session's last resume counts toward the streak ---
  {
    const resumedAt = new Date("2026-11-03T08:00:00Z");
    const capAt = new Date(resumedAt.getTime() + 1000); // 1s after resume — the incident's own signature
    const r = stepLoopBreaker(null, resumedAt.toISOString(), capAt);
    check("breaker: a cap 1s after its own resume is QUICK — tripped, streak=1",
      r.tripped === true && r.bail === false && r.state.recapCount === 1);
  }

  // --- NEGATIVE CONTROL: a cap well past the quick-gap window is NOT quick — resets the streak, never trips ---
  {
    const resumedAt = new Date("2026-11-03T08:00:00Z");
    const capAt = new Date(resumedAt.getTime() + LOOP_BREAKER_QUICK_GAP_MS + 60_000); // just past the window
    const prevState = { lastCapAt: resumedAt.toISOString(), recapCount: 2 }; // an in-progress streak
    const r = stepLoopBreaker(prevState, resumedAt.toISOString(), capAt);
    check("breaker NEGATIVE CONTROL: a cap well past the quick-gap window is NOT quick — streak resets to 0, never trips",
      r.tripped === false && r.bail === false && r.state.recapCount === 0);
  }

  // --- NEGATIVE CONTROL: fewer than maxRecaps consecutive quick re-caps never BAILS (it DOES trip, though) ---
  {
    let state = null;
    let lastResumedAt = null;
    let now = new Date("2026-11-03T08:00:00Z");
    let bailed = false;
    for (let i = 0; i < LOOP_BREAKER_MAX_RECAPS - 1; i++) {
      const r = stepLoopBreaker(state, lastResumedAt, now);
      state = r.state;
      bailed = bailed || r.bail;
      lastResumedAt = now.toISOString(); // simulate an immediate resume right after this cap
      now = new Date(now.getTime() + 1000); // the NEXT cap arrives quickly
    }
    check(`breaker NEGATIVE CONTROL: ${LOOP_BREAKER_MAX_RECAPS - 1} consecutive quick re-caps never bails`, bailed === false);
  }

  // --- REPLAY the real incident's shape (re-cap ~1s after EVERY resume, ~61-min period on the untripped
  //     leg) end-to-end: the breaker must bail in FEWER caps than the OLD design's 6 — see the dedicated
  //     e2e replay test (rate-limit-loop-breaker-e2e-replay.mjs) for the version that ALSO drives the
  //     real RateLimitWatcher's independent deadline alongside this. This replay proves stepLoopBreaker's
  //     own half in isolation: the quick-recap streak reaching maxRecaps bails directly, no ceiling climb. ---
  {
    let state = null;
    let lastResumedAt = null;
    let now = new Date("2026-11-03T08:14:35Z"); // the real b0dc5501 first-cap timestamp (log-verified)
    const results = [];
    for (let i = 0; i < 8; i++) {
      const r = stepLoopBreaker(state, lastResumedAt, now);
      state = r.state;
      results.push({ cap: i + 1, tripped: r.tripped, bail: r.bail, backoffMs: r.backoffMs });
      if (r.bail) break;
      // Mirrors index.ts: an UNTRIPPED cap parks on the hook's fixed 61-min reset; a TRIPPED cap parks
      // on the breaker's own escalating backoff instead. Either way the resume fires at `until`, and the
      // account re-caps ~1s later — the incident's own signature.
      const parkMs = r.tripped ? r.backoffMs : 61 * 60_000;
      const resumedAt = new Date(now.getTime() + parkMs);
      lastResumedAt = resumedAt.toISOString();
      now = new Date(resumedAt.getTime() + 1000);
    }
    check("replay: the FIRST cap (no prior resume) is never tripped", results[0].tripped === false);
    check("replay: every re-cap after that is QUICK and trips immediately — no free re-caps",
      results[1]?.tripped === true && results[2]?.tripped === true);
    check("replay: backoff escalates across tripped (non-bail) caps",
      (() => {
        const tripped = results.filter((r) => r.tripped && !r.bail);
        for (let i = 1; i < tripped.length; i++) if (!(tripped[i].backoffMs > tripped[i - 1].backoffMs)) return false;
        return tripped.length >= 1;
      })());
    check("replay: backoff never exceeds the ceiling",
      results.every((r) => r.backoffMs === undefined || r.backoffMs <= LOOP_BREAKER_BACKOFF_CEILING_MS));
    const bailIdx = results.findIndex((r) => r.bail);
    check("replay: the episode BAILS", bailIdx !== -1);
    check("replay: a bail result carries no backoffMs (the caller must stop parking, not park at a stale number)",
      bailIdx !== -1 && results[bailIdx].backoffMs === undefined);
    // THE DEFINING FIX (round 2 item 2): fewer caps than the OLD design's 6 (the real incident's observed
    // count, unchanged by round 1 — see the Code Review simulation in the decision record).
    check(`replay: bails within FEWER caps than the OLD design's 6 (actual: ${bailIdx + 1})`, bailIdx !== -1 && bailIdx + 1 < 6);
  }
}

// ============================ item 9 — a hook-present comparison requires TRUE (100%) sevenDay exhaustion ============================
{
  const now = new Date("2026-11-03T08:00:00Z");
  const hookReset = Math.floor(now.getTime() / 1000) + 30 * 60; // hook reports +30min
  const laterSevenDayReset = Math.floor(now.getTime() / 1000) + 4 * 60 * 60; // sevenDay resets +4h (later than hook)
  const statusWith = (utilization) => ({
    available: true, fetchedAt: now.toISOString(),
    fiveHour: { utilization: 0, resetsAt: null }, // never exhausted — isolates the sevenDay comparison
    sevenDay: { utilization, resetsAt: new Date(laterSevenDayReset * 1000).toISOString() },
    sevenDayOpus: null, sevenDaySonnet: null,
  });

  check("item 9: hook present + sevenDay NEAR-exhausted (92%, below 100) → hook wins, status does NOT override",
    (() => {
      const r = resolveResumeReset(hookReset, statusWith(92), now);
      return r.resetsAtSeconds === hookReset && r.source === "hook";
    })());
  check("item 9: hook present + sevenDay TRULY exhausted (100%) → status's later reset DOES override",
    (() => {
      const r = resolveResumeReset(hookReset, statusWith(100), now);
      return r.resetsAtSeconds === laterSevenDayReset && r.source === "status";
    })());
  // NEGATIVE CONTROL: the SAME 92%-utilization status, with NO hook present at all, still uses the
  // ORDINARY (95%) threshold — proves the raise to 100% is scoped to the hook-present comparison alone.
  check("item 9 NEGATIVE CONTROL: status-only path (no hook) keeps the ordinary 95% threshold — 92% still NOT exhausted",
    resumeResetFromUsageStatus(statusWith(92), now) === undefined);
  check("item 9: the fiveHour window's OWN threshold is unaffected by a present hook reset — still the ordinary 95%",
    (() => {
      const status = {
        available: true, fetchedAt: now.toISOString(),
        fiveHour: { utilization: 96, resetsAt: new Date(laterSevenDayReset * 1000).toISOString() }, // 96% — exhausted under the ordinary threshold
        sevenDay: { utilization: 0, resetsAt: null }, sevenDayOpus: null, sevenDaySonnet: null,
      };
      const r = resolveResumeReset(hookReset, status, now);
      return r.resetsAtSeconds === laterSevenDayReset && r.source === "status"; // fiveHour's 96% still overrides, hook present or not
    })());
}

// ============================ items 3/4/6 — decideRateLimitPark (the pure core composing the above) ============================
{
  const now = new Date("2026-11-03T08:00:00Z");
  const noStatus = { available: false, reason: "no token", fetchedAt: null };

  // --- item 3: a TRIPPED backoff never SHORTENS a known reset — park until max(resolved reset, now+backoff) ---
  {
    const hookReset = Math.floor(now.getTime() / 1000) + 3 * 60 * 60; // +3h — further out than any backoff step
    const prevBreakerState = { lastCapAt: null, recapCount: 1 }; // one prior quick recap already counted
    const lastResumedAt = new Date(now.getTime() - 1000).toISOString(); // 1s before now — QUICK
    const d = decideRateLimitPark({ resetsAtSeconds: hookReset, type: undefined }, noStatus, prevBreakerState, lastResumedAt, now, rl);
    check("item 3: a tripped backoff never shortens a KNOWN reset — until is the reset, not the (shorter) backoff",
      !d.bail && d.backoffMs !== undefined && new Date(d.until).getTime() === hookReset * 1000 + rl.resetBufferMs);
  }
  // --- item 3 NEGATIVE CONTROL: when the backoff is LONGER than the known reset, the backoff wins (a true max, not "reset always wins") ---
  {
    const hookReset = Math.floor(now.getTime() / 1000) + 5 * 60; // +5min — shorter than the 30min base backoff
    const prevBreakerState = { lastCapAt: null, recapCount: 1 };
    const lastResumedAt = new Date(now.getTime() - 1000).toISOString();
    const d = decideRateLimitPark({ resetsAtSeconds: hookReset, type: undefined }, noStatus, prevBreakerState, lastResumedAt, now, rl);
    check("item 3 NEGATIVE CONTROL: a LONGER backoff wins over a SHORTER known reset (true max, not reset-always-wins)",
      !d.bail && new Date(d.until).getTime() === now.getTime() + d.backoffMs && new Date(d.until).getTime() > hookReset * 1000);
  }

  // --- item 4: GLOBAL awareness arms on EVERY cap, bail included ---
  {
    const hookReset = Math.floor(now.getTime() / 1000) + 8 * 60 * 60; // +8h — beyond the 6h recency floor
    const prevBreakerState = { lastCapAt: null, recapCount: 2 }; // the NEXT quick recap bails (maxRecaps=3)
    const lastResumedAt = new Date(now.getTime() - 1000).toISOString();
    const d = decideRateLimitPark({ resetsAtSeconds: hookReset, type: undefined }, noStatus, prevBreakerState, lastResumedAt, now, rl);
    check("item 4: a BAILED cap still carries a resolved globalResetsAtSeconds (never blind on bail)",
      d.bail === true && d.globalResetsAtSeconds === hookReset);
  }
  // --- item 4 NEGATIVE CONTROL: a reset that would SHORTEN the recency hold is still omitted on bail too ---
  {
    const hookReset = Math.floor(now.getTime() / 1000) + 60; // +1min — inside the recency floor
    const prevBreakerState = { lastCapAt: null, recapCount: 2 };
    const lastResumedAt = new Date(now.getTime() - 1000).toISOString();
    const d = decideRateLimitPark({ resetsAtSeconds: hookReset, type: undefined }, noStatus, prevBreakerState, lastResumedAt, now, rl);
    check("item 4 NEGATIVE CONTROL: a too-soon reset is still omitted from global awareness on bail (never shortens the hold)",
      d.bail === true && d.globalResetsAtSeconds === undefined);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectUsageLimit's type extraction is bounded to short enum-shaped tokens (never free text); resolveResumeReset takes the LATER of hook/poller (raising the sevenDay-family threshold to TRUE exhaustion only when a hook reset is present) and degrades safely to \"default\", never \"no limit\"; stepLoopBreaker's CONSECUTIVE-quick-re-cap streak bails well before the real incident's old 6-cap scale; decideRateLimitPark never shortens a known reset via a tripped backoff and arms global awareness on every cap, bail included."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
