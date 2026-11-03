# dfef375f — a loop breaker that anchors to the session's own last RESUME, never a cap-to-cap window

⚠️ **Round 2 (below) supersedes round 1's own window-anchored design.** The "Round 1" sections are kept
for history — they describe code that no longer exists (`LOOP_BREAKER_WINDOW_MS`, the escalate-to-ceiling
bail) — read "Round 2" for the current mechanism.

## Incident

2026-11-03: five sessions cycled resume → StopFailure (rate limit) → park → resume on an almost exact
~61-minute period for ~7.5h. `index.ts`'s `onRateLimited` trusted `detail.resetsAtSeconds` (the
StopFailure hook) or the polled plan-usage status unconditionally, with no mechanism to notice "this
reset keeps being wrong" and escalate. The owner cleared a resulting global spawn hold by hand. Full
investigation: `worker_report` history on card dfef375f, 2026-11-03 (log-verified mechanism, two open
residuals on the watcher side and the CLI's own `cooldown` rate-limit type).

## Round 1 decision (superseded)

`stepLoopBreaker` counted re-caps in a window anchored to the MOST RECENT cap (never the episode's
first) and, once the count exceeded `loopBreakerMaxRecaps`, overrode `until` with an exponentially
escalating backoff capped at `loopBreakerBackoffCeilingMs`, bailing only once even a ceiling-sized wait
didn't stop the re-caps.

## Round 1 do not (historical — the window/ceiling concepts these name are gone; read Round 2 below)

- Do not anchor the window to the episode's FIRST cap instead of the most recent one — anchoring to the
  first cap lets the escalating backoff itself push the next cap outside the window, silently resetting
  `recapCount` right when the breaker is supposed to be escalating hardest.
- Do not skip clearing `rate_limit_loop_last_cap_at`/`rate_limit_loop_recap_count` alongside
  `rate_limit_deadline` at every site that clears the latter. A stale high `recapCount` surviving into
  the NEXT, unrelated episode would make it trip after a single additional cap. (Still true in round 2 —
  see that section's own note on the third counter it adds.)
- Do not assume the breaker's own bail is the only thing that can end a hammering episode. The
  PRE-EXISTING `RateLimitWatcher` deadline (COALESCE'd from the first cap, independent of this breaker)
  can still bail an episode before the breaker's own escalation finishes playing out — still true in
  round 2 (see below, this is exactly what a Code Review simulation found round 1 never actually beat).

## Round 2 — a Code Review simulation found round 1 never actually fixed the incident

A Code Review simulated round 1's own breaker against the real incident's shape (re-cap ~1s after every
resume, ~61-minute period, no reset on the first cap) and found it STILL took 6 caps before the episode
ended — the EXACT SAME count as before round 1 shipped at all. Two compounding reasons: (a) the first
`loopBreakerMaxRecaps` caps were free regardless of how suspicious their timing was, and (b) the
escalation ladder to the ceiling took longer wall-clock time than the PRE-EXISTING `RateLimitWatcher`
deadline (fixed from the first cap via COALESCE, so it never moves once armed) — so that independent,
unrelated mechanism bailed the episode first, before round 1's own breaker ever got the chance to.

The same Code Review ALSO found round 1's fix for `RateLimitWatcher.bail()` (clearing PtyHost's
in-memory `live.rateLimited` flag) was a CRITICAL regression against `sha:c6338ae1`'s own "Do not" —
see that decision record's own round-2 section.

### Round 2 decision

`stepLoopBreaker` (`packages/daemon/src/orchestration/usage-limit.ts`) no longer counts caps against a
cap-to-cap window at all. It counts CONSECUTIVE "quick" re-caps — a cap that arrives within
`loopBreakerQuickGapMs` (default 3min) of the session's own last RESUME, the actual signature of a resume
that landed back in a still-capped account, which every cap in the real incident shares (even the early
ones round 1's window-based design let through for free). A THIRD persisted column,
`rate_limit_loop_last_resumed_at` (`Db.recordRateLimitResume`), is stamped by every real resume call site
(`RateLimitWatcher.resume()`, both REST clear routes) — never by `onRateLimited` itself — and is what
`stepLoopBreaker` reads to decide "quick." Once the streak reaches `loopBreakerMaxRecaps` (default 3),
the episode bails IMMEDIATELY — no escalation ladder to climb first; each consecutive quick re-cap short
of that count instead trips an escalating backoff (same formula as round 1, `backoffBaseMs * 2^(k-1)`,
capped at `backoffCeilingMs`) so the session doesn't just keep resuming on the stale hook-reported reset
while the streak builds. Simulated against the SAME incident shape, this bails within 4 caps — fewer
than round 1's 6 — and well before the independent `RateLimitWatcher` deadline would fire on its own.
⚠️ **Round 3 scopes this "4 caps" figure to the NO-RESET incident shape specifically — see Round 3 below
for the hook-reset variant, where the breaker's own escalating backoff can legitimately lose that race to
the independent watcher deadline instead.**

Items 3/4/6 of the round-2 triage also folded the "tripped backoff never shortens a known reset" clamp
and the "global awareness arms on every cap, bail included" fix into one new pure function,
`decideRateLimitPark` (same file) — `onRateLimited` now composes `resolveResumeReset` + `stepLoopBreaker`
+ these two clamps through that one call instead of three separately-ordered ones.

Item 9 also raised the threshold `resolveResumeReset` requires of a weekly/account-scale
(sevenDay-family) window before it may OVERRIDE a hook-reported reset from 95% ("near") to 100% ("truly
exhausted") — but ONLY in that specific hook-present comparison; the status-only path (no hook reset at
all) keeps the ordinary 95% threshold, since `usage-limit-weekly-resume.mjs` already pins that as a real,
intentional tunable.

### Round 2 do not

- Do not go back to anchoring the streak on the gap since the PREVIOUS CAP (or any other cap-to-cap
  measure) instead of the gap since the session's own last RESUME — that is round 1's own design, and
  the Code Review simulation above is the proof it doesn't actually break the pattern faster than the
  independent watcher deadline already does.
- Do not derive `bail` from a separately-persisted "reached ceiling" flag. It is deliberately derived
  from `recapCount` alone (`recapCount >= maxRecaps`); if the backoff formula ever changes, this
  derivation must change with it in the same commit.
- Do not skip clearing `rate_limit_loop_last_resumed_at` everywhere `rate_limit_loop_last_cap_at`/
  `rate_limit_loop_recap_count` are cleared (`Db.clearRateLimitLoopBreakerState`) — a stale resume
  timestamp surviving into the NEXT, unrelated episode would make an unrelated cap read as "quick" by
  coincidence.
- Do not call `Db.recordRateLimitResume` from `onRateLimited`, or from anywhere other than a genuine
  resume call site (`RateLimitWatcher.resume()`, the two REST clear routes) — it must record when the
  session was ACTUALLY resumed, not when it was capped.
- Do not clear `live.rateLimited` from a bail — see `sha:c6338ae1`'s own "Do not" and its round-2 section.

## Round 3 — the "4 caps" figure is scoped to the NO-RESET shape; a hook-reset variant can legitimately lose the race to the watcher deadline

Round 2's simulation (and `rate-limit-loop-breaker-e2e-replay.mjs`) replays the real incident's own shape:
no `resetsAtSeconds` on any cap, so every park falls back to `defaultBackoffMs`/`deadlineNoResetMs`. A
SEPARATE shape — a hook DOES report a `resetsAtSeconds` on each cap, consistent with a genuinely short
`cooldown`-type sub-bucket reset rather than the account's real binding cap (the CLI quirk this card's own
Incident section names as an open residual) — parks on a much SHORTER `deadlineAfterResetMs` window
instead of `deadlineNoResetMs`. In that shape, a tripped escalating backoff can genuinely outlast the
episode's own (COALESCE'd-from-first-cap) deadline before the breaker's own count-based bail would have
fired — so the PRE-EXISTING, independent `RateLimitWatcher` deadline bails the episode first, at as few
as 2 caps in a simulated hook-reset run.

**This is ACCEPTED, not a regression to chase** — the watcher's own deadline-based bail is exactly as
safe as the breaker's own count-based bail (both route through the SAME shared `bailRateLimitEpisode`,
both leave the exact same durable "needs a human" trail), and round 3 item 1 closed the one real gap this
shape used to have: a watcher-deadline bail is now EXACTLY as human-visible as a breaker bail (the durable
`rate_limit_bailed_at` marker + the attention-queue row + the per-session Clear/retry button all key on
the bail itself, not on which of the two mechanisms fired it). `bailRateLimitEpisode`'s nudge now also
names WHICH mechanism fired (round 3 item 4), so a human reading it is never left guessing.

**Short `cooldown`-type caps specifically are explicitly OUT OF SCOPE here** — whether a `cooldown`-type
limit should park at all, or be retried soon instead, is card `c498afe0`'s own job (this card's original
investigate-first item 4); this card does not change how a `cooldown`-type cap is parked, only documents
that the breaker's own "bails fast" claim was never meant to cover it.

### Round 3 do not

- Do not read "bails within 4 caps" (Round 2 above) as a universal bound — it describes the NO-RESET
  incident shape only (`rate-limit-loop-breaker-e2e-replay.mjs`'s own scenario). A hook-reset variant
  (`rate-limit-loop-breaker-e2e-replay.mjs`'s second scenario) can bail via the independent watcher
  deadline instead, in fewer caps still, and that is a DIFFERENT, equally-safe outcome — not a failure of
  either mechanism.
- Do not treat a watcher-deadline bail as a lesser or less-visible outcome than a breaker bail — round 3
  item 1 made the two indistinguishable from a human's perspective (same durable marker, same attention
  row, same clear path); only the nudge's own tag/wording (round 3 item 4) still names which one fired,
  for diagnosis, not for any behavioral difference.
- Do not fold a `cooldown`-type-specific retry-soon policy into this card — that is card `c498afe0`.
