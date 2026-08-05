# c469d54e — the boot mode-cycle's shared READY_FALLBACK_MS clock: findings

REFUTE-FIRST analysis for card `c469d54e` (mgr-approved 2026-08-05), re-establishing the parent card
`2151f1db`'s root-mechanism claim from raw evidence instead of the worker-reported figure it shipped with.
Fix implemented and merged alongside this doc (commit `7889e579`, `packages/daemon/src/pty/host.ts`).

## Reproducibility anchor

Frozen snapshot: `~/.loom/workspaces/log-corpus-snapshot-20260805-c469d54e/daemon-output.log`
(copied from the daemon's own rotated `daemon-output.log.1`, 10,550,639 bytes — this rotation covers the
2026-08-01 mass-restart incident and nothing else relevant; it happens to contain the ENTIRE population of
`readiness fallback` lines this file's rotation window ever saw, all 9 from the one incident).

- md5 of the frozen `daemon-output.log`: `41d094f0b4bd1d087225d36371b0cf60`
- All numbers in this document are reproduced by running `scripts/analyze-fallback-race.mjs` against that
  exact file — re-run it to verify:
  `node docs/investigations/c469d54e-ready-fallback-race/scripts/analyze-fallback-race.mjs ~/.loom/workspaces/log-corpus-snapshot-20260805-c469d54e/daemon-output.log`

## Method: positive-controlled line parsing

Three regexes (`readiness fallback` firing, `SessionStart` hook, `cycle→` completion — all three carry the
same trailing epoch-ms suffix convention as `04de8bbf`'s investigation), each validated by a positive
control against 3 known-non-matching lines and 3 known-good lines before any count is trusted — run the
script with no path argument for usage, or just observe the `positive control: OK` line the real run also
prints first.

## Finding 1 — every fallback firing in the incident had SessionStart already arrived, contradicting the log's own wording

The log line printed at each firing said `"readiness fallback (no SessionStart in 20000ms)"` — but that
message is generated purely from `!ready` at the deadline (`host.ts`, pre-fix); it never actually checked
whether the hook had arrived. Cross-referencing each firing's session id against `[hook] ... SessionStart`
lines for that same session:

```
sessionId,fallbackTs,sessionStartTs,gapMs,sessionStartAlreadyArrived,nextCycleDoneReason,nextCycleDoneMode,corruptionLatencyMs,corrupted
e2d9c19a-a7b9-41dd-9890-81d3f25ccb02,1785618442495,1785618430926,11569,true,footer-unchanged,plan,24490,false
708f86a9-bd2e-4713-a3aa-9dd2b2ccc957,1785618442498,1785618430936,11562,true,footer-unchanged,unknown,24493,true
fbf1cb76-ab91-4ba2-95bf-7d4cf2e3fc91,1785618442501,1785618435279,7222,true,footer-unchanged,unknown,24477,true
efeb5d0c-fcfe-4a0f-ade4-48e0a0f9ef9a,1785618442504,1785618435310,7194,true,reached,auto,13993,false
16f90e6d-1828-491d-9b9f-6d9b15d08c20,1785618442504,1785618435401,7103,true,footer-unchanged,unknown,24477,true
0085610f-cc30-4411-98e9-bf5d20638bac,1785618442506,1785618435309,7197,true,footer-unchanged,unknown,24474,true
70605175-6637-46b7-8b75-7139a0838e80,1785618447974,1785618442522,5452,true,footer-unchanged,unknown,19697,true
2e921418-adc0-479b-bcaf-79810d7dac30,1785618447977,1785618442487,5490,true,footer-unchanged,unknown,19405,true
3542681e-784f-4502-94d2-91e061ee539b,1785618447980,1785618442686,5294,true,footer-unchanged,unknown,19971,true
```

**9/9** had `SessionStart` arrive at 5,294ms–11,569ms BEFORE the fallback fired — i.e. `cycleToMode` was
already kicked off in every case, with a residual budget (the gap to the spawn-anchored 20s deadline) well
under `cycleToMode`'s own sized worst case (~13-14s, `host.ts`'s doc comment on the constant). This is the
structural precondition the fix (design (a)) closes: re-arming the fallback from `SessionStart` instead of
spawn gives every one of these 9 specimens its own full, un-eroded budget.

## Finding 2 — reconciling "8 of 9" (the card's figure) against a stricter "7 of 9"

The parent card (`2151f1db`) reported *"corrupting the footer read for 8 of 9 mode-cycled sessions"* —
worker-reported, not manager-verified at the time. Re-deriving it from the frozen log with an explicit,
stated definition:

- **Strict definition** (the script's default): the session's NEXT `cycle→` completion after the fallback
  fired is a give-up variant (`footer-unchanged`/`footer-unreadable`) AND its landed mode is literally
  `unknown` — the footer was genuinely unparseable for the whole poll budget, not merely wrong-but-readable.
  **7/9** meet this bar (all listed `corrupted=true` above).
- **Broader definition** (any non-clean landing — a give-up away from target, whether unreadable OR
  wrong-but-readable): `e2d9c19a` additionally counts — its give-up landed on a DEFINITE but WRONG mode
  (`plan`, not the `auto` target), confirmed by reading its full context (`docs/investigations/c469d54e-
  ready-fallback-race/scripts/analyze-fallback-race.mjs`'s raw match, cross-checked by hand against the
  snapshot at line 50678). Under this broader definition: **8/9** — matching the card's original figure.
- The 9th, `efeb5d0c`, converged CLEANLY (`reached after 2 press(es) (mode=auto)`, zero give-up) despite
  also having the same timing precondition present (Finding 1) — the precondition is necessary but was not
  independently sufficient for every specimen; some races resolved without visible symptoms.

**Reconciled: the card's "8 of 9" is the broader (any-non-clean-landing) count, confirmed exactly. This
document's own tighter "7 of 9" is a stricter sub-population (mode=unknown specifically) nested inside it.**
Both are now manager-verified against the raw log, not worker-reported.

## Finding 3 — corruption latency is long (19.4s–24.5s after the fallback), not immediate

An earlier version of `analyze-fallback-race.mjs` bounded the corruption search to a 5000ms window after
the fallback and found 0/9 — wrong. The premature fallback's own `logLandedMode` read triggers a HEAL
`cycleToMode` call, which is QUEUED (`Live.modeCycleChain`, card `9c03f5a6`) BEHIND the `SessionStart`-
driven cycle already in flight — so the heal does not even begin until that original cycle finishes its own
(contention-stretched) give-up sequence. The 7 strictly-corrupted specimens show 19.4s–24.5s between the
fallback firing and the observed `mode=unknown` give-up. The script was corrected to search unboundedly
(the NEXT completion for the session, whenever it lands) rather than assume a window — see the script's own
comment on this exact mistake, left in place so a future reader doesn't repeat it.

## What this does NOT establish

Per the earlier progress report (unchanged): this cannot isolate byte-level pty-write interleaving
(drainPending's kickoff paste literally corrupting the footer bytes cycleToMode is reading) from raw
event-loop/CPU contention under the 11-session restart independently degrading the same polls — both
co-occur in every specimen, and no contrast case in this incident had a session escape the timing
precondition entirely to serve as a clean control. What IS established directly from source (not
inference): `drainPending` (which the premature fallback's `markReady` call triggers) writes to the pty
with zero synchronization against `Live.modeCycleChain`, so the structural race is real regardless of which
exact byte-level path dominates.

## DoD-3 — crash-between-arm-and-clear (partially discharged, correctly labeled)

`packages/daemon/test/pty-ready-fallback-race.mjs` scenario 2 intercepts `clearTimeout` to throw exactly
once (the closest testable proxy for a fault between arming the new timer and clearing the old one — a
literal process crash isn't reproducible in a unit test). Code review (2026-08-05) found the scenario's
final assertion ("still delivered EXACTLY ONCE — markReady's `ready` guard absorbs the second, now-stale
timer") was vacuous: in the current source, `live.readyFallbackTimer` is reassigned to the NEW timer BEFORE
the throwing clear call runs, so when the OLD (uncleared) timer fires and calls `markReady`, THAT call's own
clear (using the by-then-restored real `clearTimeout`) successfully cancels the NEW timer — there never was
a surviving second timer to absorb a double-fire from. The test was corrected (same commit range) to assert
only what it actually proves: the OLD timer, left live by the simulated fault, still fires and delivers the
kickoff (the genuinely new, tested claim — arm-before-clear ordering prevents a wedge), and that the
NEW timer is ALSO cleared once that delivery's `markReady` runs (a consequence of the pre-existing,
already-elsewhere-tested `live.ready` idempotency guard in `markReady`, not new machinery this card adds).
Exercising an actual two-live-timer double-fire would require ALSO making `markReady`'s own (unguarded)
clear throw — which propagates an uncaught exception out of a `setTimeout` callback in the current
production code and was judged out of scope for this fix (it would test a pre-existing gap in `markReady`,
not this card's own bookkeeping).

## DoD-4 — negative control, pasted

⚠️ **Correction during authoring, left in for the record:** my first attempt at this stashed only the
UNCOMMITTED changes on top of the already-committed fix (commit `7889e579`) — `git stash` cannot revert a
committed change, so that run was actually testing "fix present, minus the code-review fold-ins," not
pre-fix, and it showed ALL PASS (misleadingly). Corrected by extracting the TRUE pre-fix source directly
from the fix's parent commit: `git show 6c153624:packages/daemon/src/pty/host.ts > src/pty/host.ts`
(`6c153624` = the commit immediately before `7889e579`), confirmed via `grep -c readyFallbackTimer` (must
be `0`) before trusting the run. Also caught and fixed a real flake in this same pass: routing scenario 1's
negative check through `assertNeverWithControl` (a separate code-review fold-in) runs the positive control
BEFORE the real observation window, eating into the margin under the fixed 700ms settle — an initial
`LOOM_READY_FALLBACK_MS=200`/`windowMs=300` pairing flaked ~1/6 runs; shrunk to `50`/`150` and confirmed
clean over 20 consecutive runs (`for i in $(seq 1 20); do node test/pty-ready-fallback-race.mjs; done`) —
see the test file's own comments at both constants for the numbers.

True pre-fix (`6c71f90e`… — see the extraction command above) → `pnpm build` → `node test/pty-ready-fallback-race.mjs`:

```
PASS  1: kickoff NOT delivered while the cycle is still mid-settle (THE FIX — pre-fix this fires at ~200ms)
PASS  1: no Shift+Tab issued yet either (cycle genuinely still settling, not racing ahead)
PASS  1: cycle's 1st Shift+Tab issued once settle completes
PASS  1: cycle's 2nd Shift+Tab issued
PASS  1: kickoff delivered exactly once, only AFTER the cycle reached its target
PASS  1: the delivered text is the original kickoff
FAIL  1: EXACTLY ONE cycleToMode invocation for this session (no redundant heal queued behind it — the actual defect)
FAIL  2: the simulated clear-timeout fault actually fired (the control is real)
FAIL  2: deliverHook propagated the simulated throw (we are really testing the failure path, not a swallowed no-op)
PASS  2: the session STILL reaches ready and delivers its kickoff despite the clear throwing (no permanent wedge)
PASS  2: the re-armed timer does not ALSO deliver a second time once the old timer's markReady has run (not a test of double-fire absorption — see comment above)
❌ 3 FAILURE(S).
```

Note the timing-based checks (scenario 1's first six) pass even pre-fix — expected and reported at the
time this was first found: kickoff delivery happens to also be gated behind the (pre-existing) heal cycle's
own completion, which coincidentally still finishes fast enough at these smaller constants regardless of
this card's specific bug. That is exactly why the sharp, defect-specific assertion is the
CYCLE-INVOCATION COUNT, not delivery timing — see Finding 2's reasoning above and the code-review exchange
this doc responds to. Scenario 2's two failures are expected too: the mechanism under test (the re-arm's
`clearTimeout` call) doesn't exist in the pre-fix source at all, so the interception simply never fires.

`git checkout -- src/pty/host.ts && git stash pop` (restores the real fix from its commit, then the
uncommitted code-review fold-ins on top) → `pnpm build` → `node test/pty-ready-fallback-race.mjs`:

```
PASS  1: kickoff NOT delivered while the cycle is still mid-settle (THE FIX — pre-fix this fires at ~200ms)
PASS  1: no Shift+Tab issued yet either (cycle genuinely still settling, not racing ahead)
PASS  1: cycle's 1st Shift+Tab issued once settle completes
PASS  1: cycle's 2nd Shift+Tab issued
PASS  1: kickoff delivered exactly once, only AFTER the cycle reached its target
PASS  1: the delivered text is the original kickoff
PASS  1: EXACTLY ONE cycleToMode invocation for this session (no redundant heal queued behind it — the actual defect)
PASS  2: the simulated clear-timeout fault actually fired (the control is real)
PASS  2: deliverHook propagated the simulated throw (we are really testing the failure path, not a swallowed no-op)
PASS  2: the session STILL reaches ready and delivers its kickoff despite the clear throwing (no permanent wedge)
PASS  2: the re-armed timer does not ALSO deliver a second time once the old timer's markReady has run (not a test of double-fire absorption — see comment above)
✅ ALL PASS
```

Verified stable over 20 consecutive runs post-fix (`for i in $(seq 1 20); do node test/pty-ready-fallback-race.mjs; done` — 0/20 failed) and 10 consecutive runs of `pty-ready-fallback-ceiling.mjs` (0/10 failed), after the flake fix above.

## DoD-6 — a unit test cannot reproduce the event-loop contention that causes this race

Stated plainly, unchanged from the earlier progress report: the hermetic tests reproduce the STRUCTURAL
race (via constant sizing — `READY_FALLBACK_MS` set below the fixed 700ms `MODE_CYCLE_SETTLE_MS`) and the
liveness/no-wedge/no-duplicate guarantees, but cannot exercise real host CPU contention, real `claude.exe`
boot variance, or real ConPTY buffer interleaving. No test claims that coverage.

## DoD-5 — owner-gated, not attempted

Restart authority is per-use; no live grant exists. The fix is at the point a real mass restart would
confirm it — the re-arm timing is now scoped from `SessionStart` with a 20s budget (`MODE_CYCLE_FALLBACK_MS`)
plus a 45s absolute ceiling (`READY_FALLBACK_ABSOLUTE_CEILING_MS`), both comfortably covering this
incident's observed 5.3s–11.6s SessionStart-to-fallback gaps (Finding 1).
