# 5d068eec — the first hookless TERMINAL give-up suppression: a PARTIAL gain under contention, windows never widened, one accepted content-only-match residual

## Narrative

Site B, `give-up-recovery` (`pty/host.ts`, `fireEnterAndVerify`'s commit point after `awaitGiveUpConfirmSettle`
reports `confirmed:false`). The only positive evidence that branch consulted was `enterConfirmed` — a
proxy for "a confirming hook fired." `hook-relay.mjs` posts the `UserPromptSubmit`/`Stop` hooks
fire-and-forget, with no retry, so a dropped hook can leave a genuinely-started turn with no confirming
hook ever arriving, and no pty output either (a quiet model turn with no spinner/repaint chatter —
nothing for the existing output discriminator to see). This is a LOST hook, categorically different from
a LATE one: a late hook eventually arrives and self-corrects via the existing `purgeConfirmedGiveUpRequeue`
defense-in-depth; a lost one never does.

**CR round 2 Minor 1 — claim accuracy.** Since card `29b3c396`, the pre-existing OUTPUT discriminator
(`lastOutputAt > enterWrittenAt`) does NOT terminally suppress on its own: a positive read logs, marks the
composer possibly-dirty, and falls through into the SAME `awaitGiveUpConfirmSettle` recheck every branch
uses — it only becomes a real, terminal suppression if `enterConfirmed` ALSO flips true inside that
recheck, i.e. a real hook still has to arrive. This card's transcript check is therefore the FIRST and
ONLY path in `fireEnterAndVerify` that terminally suppresses with NO hook ever confirming anything.

## Measurement (n=3 of 5 real spawns; 2 lost to a measurement-script bug, not re-run)

A real `claude` was spawned through this project's own `PtyHost` + a real gateway (`/internal/hook` wired
to the real `host.deliverHook`), anchored on this generation's first Enter write
(`fireEnterAndVerify`'s own `[submit] ... Enter attempt 1/4 written gen=1` line), polling the resolved
transcript file's size every ~10ms. Real HOME/USERPROFILE (manager-approved — same auth every production
Loom session uses, never redirected, never an API key); fresh `LOOM_HOME` + fresh cwd per trial.

| Trial | transcript growth | UserPromptSubmit hook | Stop |
|---|---|---|---|
| 1 (quiet) | 987ms | 769ms | 3395ms |
| 4 (real contention: 4 Enter attempts, a genuine GIVE-UP SUPPRESSED) | 6326ms | 5623ms | 12438ms |
| 5 (quiet) | 892ms | 684ms | 3228ms |

Trials 2 and 3 completed live (visible in the console at the time) but their numeric results were lost
when the measurement script crashed (an EBUSY on its own cleanup) before they were logged to a file; the
script was fixed and one further trial run instead of re-spending the approved real-spawn budget to
recover them. This record cites n=3, not n=5 — do not round it up.

## The lost-vs-late distinction, and why "slower than the hook" does NOT kill the candidate

The naive reading of the numbers above — transcript growth consistently arrives 200-700ms AFTER the real
hook, in every trial — looks like a disqualifying result ("it's slower than what it's meant to replace").
That reading compares the wrong two things. The signal is never meant to race a hook that ARRIVES; it
exists for the hook that is DROPPED and never arrives at all. The correct comparison is transcript growth
against the GIVE-UP DECISION time, both measured from this generation's own FIRST Enter write:
`SUBMIT_MAX_ATTEMPTS(4) × SUBMIT_VERIFY_TIMEOUT_MS(900ms) + GIVE_UP_CONFIRM_SETTLE_MAX_POLLS(20) ×
GIVE_UP_CONFIRM_SETTLE_POLL_MS(15ms) ≈ 3.9s` after attempt 1.

On the two quiet trials (1, 5), transcript growth landed at ~0.9-1.0s — comfortably inside that ~3.9s
budget. In a lost-hook case on a quiet host, the transcript would already have the matching record by
the time GIVE-UP RECOVERY is about to commit, and this check suppresses it correctly.

Trial 4 is the contended counter-case: growth at 6.3s, past the ~3.9s decision point. Under real
contention, this check would NOT have corroborated in time — it fails closed to today's unchanged
GIVE-UP RECOVERY, exactly as designed. That is a PARTIAL gain on the axis this card set out to improve
(helps on a quiet host, no worse than today under load) — it adds no wait of its own, and it is the ONLY
hookless terminal suppression (see the claim-accuracy correction above). It is NOT a blanket "never a
regression" claim on every axis: see the Accepted residual below for the one way it can regress.

## Accepted residual (CR round 2 Minor 1)

The content match is NEVER tied to a generation or logical-message identity — unlike
`purgeConfirmedGiveUpRequeueCore`'s `ambiguousDispatches`/`batchId` bookkeeping, `transcriptGrowthShowsTurnStarted`
only asks "does SOME new transcript line, since MY baseline, carry MY intended text." This is a genuine,
accepted cross-attribution risk, not merely a theoretical one:

Two logically DISTINCT messages (different generations, different logical ids) happen to share
byte-identical text. The EARLIER one's real engine-recorded transcript line lands AFTER the LATER one's
own baseline was captured (e.g. the earlier one's engine processing was unusually slow). The LATER
message's own give-up commit point then sees that late-arriving, matching-text line as "new since my
baseline" and wrongly suppresses — even though the LATER message's own Enter may never have genuinely
registered at all. Because suppression never requeues, the later message's content can be silently lost
in exactly this ordering.

**LEAD DECISION (this card): accepted.** Narrow (requires byte-identical text across two distinct,
concurrently-outstanding dispatches, in a specific arrival order) and benign in the case it is actually
reachable in practice — idempotent duplicate nudges, where losing one copy because an identical copy
already landed is not a real loss. **Reopening trigger:** if a real specimen ever shows two logically
distinct, NON-idempotent dispatches sharing byte-identical text cross-attributing this way, scope the
match to the current generation's own identity (the same bookkeeping `purgeConfirmedGiveUpRequeueCore`
already uses) instead of content alone.

## Do not

- Do not widen `SUBMIT_VERIFY_TIMEOUT_MS`, `GIVE_UP_CONFIRM_SETTLE_POLL_MS`/`GIVE_UP_CONFIRM_SETTLE_MAX_POLLS`,
  or any other give-up-related window to try to make this check corroborate in the contended case too —
  decisions `0fa5beef`, `29b3c396`, and `71de1f9c` already establish that give-ups are contention-driven
  bursts, not uniformly slow hooks; a wider window only relocates the threshold to wherever fleet
  contention next peaks. This card's own measurement reinforces rather than overturns that conclusion:
  the contended trial's gap (703ms past the hook) was LARGER than the quiet trials' (~210ms), i.e. the
  problem gets worse under exactly the load a wider window would be trying to buy margin against.
- Do not add a wait of this check's own (a retry, a poll, a settle window) — it must stay a single,
  bounded, synchronous-cost check (one `statSync`, and only on growth, one bounded HEAD read starting
  exactly at the baseline) consulted at the EXISTING commit point, never a reason to delay it further.
- Do not read "transcript growth is slower than the hook" as disqualifying on its own — see the
  lost-vs-late distinction above. The relevant comparison is against the GIVE-UP DECISION time, not the
  hook's own arrival time.
- Do not treat this as closing the lost-hook gap in general — it is a best-effort corroboration for the
  common (quiet-host) case, not a guarantee; a hook lost under real contention can still result in
  GIVE-UP RECOVERY firing, same as before this card.
- Do not read a SUPPRESSED-by-transcript generation as merely "left alone" — `fireEnterAndVerify` also
  sets `enterConfirmed=true`/`firstTurnStarted=true` on a match, so a LATER lost `Stop` heals via
  `healIfStuck`'s `"heal-if-stuck-stale"` branch (clears busy, requeues nothing) instead of its other
  branch (which would wrongly mark-dirty-and-restore a turn that already genuinely started).
- Do not re-widen the read to the TAIL instead of the HEAD — the target record is the FIRST thing
  appended after the baseline, and a read starting past the baseline can miss it entirely (CR round 2
  Minor 3). This does NOT mean the baseline is guaranteed to land on a real line boundary — a stat can
  catch a half-flushed append, so the first line read can be a partial fragment. That fragment simply
  fails `JSON.parse` and is skipped like any other unparsable line; it can only belong to a record that
  STARTED before the baseline, so it is never mistaken for this generation's own new record either way.

## Source

Card `5d068eec`, split from `08ac0e79` (investigation by worker `2fbbe820`, gen 433). Phase 1 (measurement
plan + the real-spawn numbers above) and Phase 2 (this implementation) both reviewed and approved by the
dispatching manager before being carried out — see the card body for the full exchange.
