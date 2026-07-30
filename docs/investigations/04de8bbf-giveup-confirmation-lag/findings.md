# 04de8bbf — TIME-radius injection-concurrency analysis: findings

Diagnose-only analysis run 2026-07-30 (mgr #71 fleet), against card `04de8bbf` (the give-up
discriminator under-suppresses; 4 prior attempts) and its cross-linked `4a0af485` (a give-up declares a
message undeliverable while its write is still queued; the engine can confirm minutes late). No
production code was changed as part of this analysis — see the one exception (the observability fix)
called out at the end, which is a separate, minimal, log-only follow-up.

## Reproducibility anchor

Frozen snapshot: `~/.loom/workspaces/log-corpus-snapshot-20260730-mgr71/daemon-output.log`
(manager-captured, 5,362,521 bytes). Independently re-derived from a copy of that exact file:

- md5 of the analysed `daemon-output.log`: `6c71f90ee5e6e234f58909e6b158cee7`
- **101 stamped give-up classification events** (magnitude-validated, ≥1.7e12) — **101 is confirmed
  correct**; the manager's own first awk count on the same file read 102, and the cause was found and
  verified (not a rounding difference): the manager's awk used an unanchored `index($0, ...)` substring
  match against `"GIVE-UP RECOVERY after"`. That string appears inside the analysing worker's *own*
  `[pty] spawn` argv line (its kickoff prompt quoted the phrase verbatim while briefing this very
  investigation), so the unanchored match counted that spawn line as a 102nd "give-up." This is the
  card's own **trap #1** ("spawn argv echoes whole kickoff prompts, so an unanchored grep matches the
  investigation's own text"), reproduced live in the act of re-verifying this investigation's own count —
  confirmed independently against this snapshot: `833bdf3d-...`'s spawn line (line 18991) contains that
  exact phrase, and it is the only non-classification line matching it. This script's `^\[submit\]`
  anchor (see `parse-log-events.mjs`) excludes it structurally.
- stamped range: `2026-07-29T08:49:54.518Z` → `2026-07-30T02:08:27.776Z` (17.31h)
- **505 stamped submit-attempt-1 events** in the same file
- an earlier, slightly smaller self-captured snapshot (md5 `e6a7693e05b6bace8681027690270130`) gave 97
  stamped give-ups / 500 stamped submits over 16.74h — consistent, just less data (captured ~40 min
  earlier)

All scripts in `scripts/` are re-runnable against any frozen snapshot; see each file's header for usage.
Re-running them against the snapshot above reproduces every number in this document exactly (validated
during authoring).

## Method: positive-controlled stamp parsing

The corpus is mixed: lines emitted after the 2026-07-29 ~08:37Z relaunch carry a trailing epoch-ms
suffix (card `ced00bfb`); ~21MB of older history has none. A naive "last whitespace token = epoch ms"
parser will happily parse an old line that merely *ends in a small number* (a port, a pid, a count) into
a garbage near-zero epoch, with no error raised. `scripts/parse-log-events.mjs` requires the token be
≥1.7e12 and is positive-controlled against three known-unstamped lines (a port-number line, a
`GIVE-UP RECOVERY: re-queued...` line, a `[hook]` line) before trusting any count — run the script with
no arguments to execute just that self-check.

## Finding 1 — the "modest manager tilt" does not survive incident-level reanalysis

**Primary, reusable method: the 1:1 give-up↔submit join** (`scripts/time-radius-concurrency.mjs`'s
linkage, reused throughout this investigation). Every stamped give-up links to its own nearest-preceding
`Enter attempt 1/4 written` in the same session (≤15s — justified by the give-up firing ~3.6s after its
own trigger, 4 attempts × 900ms), and the join is verified clean: **101/101 give-ups linked, zero
submit1s double-claimed.** This join is the load-bearing artifact of this investigation and should be
treated as the deliverable's authoritative method going forward — it needs no further declustering
question to trust it, because it identifies exactly which submit failed and which didn't, directly.

An earlier pass (`scripts/decluster-incidents.mjs`) additionally clustered give-ups into cascades and
asked whether the submit *denominator* should be declustered the same way, since a re-mint's redelivery
goes back through `drainPending()` → `submit()` and re-logs a fresh `Enter attempt 1/4 written` line
(confirmed in `pty/host.ts`'s `requeueGiveUpOrigin()`, and empirically by the same 101/101 zero-collision
join above). **That question is superseded by the 1:1 join, not a separate open item**: the join already
tells you, per submit, whether it gave up — the cascade-declustering exercise below is kept only as a
secondary cross-check that concurs with the join-based read, not as independent evidence:

| role | undeclustered (raw/raw) | consistently declustered (incidents/trial-submits) |
|---|---|---|
| manager | 58/315 = 18.41% | 16/273 = **5.86%** |
| worker | 43/183 = 23.50% | 16/156 = **10.26%** |

This secondary cross-check **agrees with the join-based read, and if anything strengthens the reversal
slightly** (worker/manager ratio ≈1.75x here vs ≈1.64x when only the numerator was declustered) — the two
longest cascades (`8c7c87ea` size 7, `884a3402` size 8) are both **worker** sessions, so removing their
retries from the worker denominator shrinks it proportionally more (14.8%) than the manager denominator
shrinks (13.3%).

With only 32 total incidents (16 manager / 16 worker), a two-proportion check (z≈1.67, two-tailed
p≈0.09) means this reversal is suggestive, not statistically decisive. **No per-submit role tilt is
established in either direction** by this data.

## Finding 2 — the between-subject session-incidence split is fully explained by exposure, not a role
mechanism

Session-level: 70% of manager sessions (7/10) vs 31% of worker sessions (14/45) had ≥1 give-up in this
window. This looks tilted, but:

| role | n sessions | median observed submit-span | mean submits/session |
|---|---|---|---|
| worker | 45 | 10.7 min | 4.0 |
| manager | 10 | 160.9 min | 31.4 |

Managers live ~15x longer and submit ~8x more per session in this window. More at-bats against any
contention window, over a much longer lifetime, with no per-submission role effect required. This
reconciles Finding 1 (no/reversed per-submit tilt) with the session-level number without contradiction:
it's a dosage artifact, not two competing signals.

## Finding 3 — TIME-radius concurrency (the card's original open question)

Replacing the card's confounded LINE-radius proxy (a cascade's own retry lines mechanically crowd a line
window regardless of true concurrency) with a genuine TIME-radius one
(`scripts/time-radius-concurrency.mjs`): for every stamped submit, count distinct OTHER sessions with a
submit within ±30s/60s/120s, link each give-up to its triggering submit (100% linked, zero collisions —
same clean join as Finding 1), and compare.

| radius | mean concurrency, gave-up submits | mean concurrency, other submits | low(0-1) vs high(2+) give-up rate | χ² (df=1) |
|---|---|---|---|---|
| ±30s | 0.495 (n=101) | 0.730 (n=404) | 21.8% vs 9.6% | 5.78 |
| ±60s | 0.861 | 1.136 | 24.3% vs 8.6% | **15.49** (p<0.001) |
| ±120s | 1.693 | 1.797 | 23.8% vs 16.1% | 4.76 |

At all three radii, give-ups occur at **below-baseline** concurrent-submit activity — the opposite
direction from "concurrent injected submissions delay the engine." At ±60s the effect is large and
statistically decisive: high-concurrency submits have under half the give-up rate of low-concurrency
ones.

**⚠️ CORRECTED — this inverse result does NOT survive a reverse-causality confound check, and should NOT
be read as evidence against a shared-contention mechanism.** A significant result in the unexpected
direction is usually a confound, not a discovery, and there is a concrete candidate here: the same host
contention that stalls a session's own confirmation could plausibly also make *other* sessions submit
less right then (a manager pausing to wait on a response; every session's own event loop getting less CPU
at once) — which would produce this identical inverse correlation as a downstream *symptom*, not as proof
concurrency is irrelevant.

Tested it (`scripts/confound-check-prior-window.mjs`): for each give-up's trigger, compared concurrency
in a PRIOR window (−300s to −60s, ending exactly where the ±60s AT window begins) against the AT window
itself.

- mean AT concurrency = 0.861 (matches the table above); **mean PRIOR concurrency = 2.317** — the
  neighborhood was markedly more active just before most give-ups than it was at the moment of the
  give-up.
- **59/101 (58%) give-ups show "went quiet at the failure"** (prior ≥2 distinct sessions submitting nearby,
  dropping by the AT window) vs **38/101 (38%) "genuinely idle both windows"** (prior ≤1 throughout — the
  only subset the original inverse reading would actually support cleanly).
- The give-up-specific PRIOR-minus-AT gap (1.455) is **2.49x the same gap computed for all 505 submits
  generally** (0.584) — some quieting-toward-"now" is normal background autocorrelation, but give-ups show
  far more of it than an average submit does.

**Verdict: the confound is real and substantial.** The majority-share "went quiet at the failure" pattern
means Finding 3's inverse result is much better explained as a symptom of shared host contention
suppressing nearby submission activity right as this session's confirmation was also stalling, than as
evidence that concurrent submissions don't matter. **This finding is retracted as evidence against the
concurrency/contention hypothesis** — it neither confirms the original "concurrent injected submissions
compete for delivery" framing nor refutes it; it is consistent with, and folds into, the shared-host-load
story in Finding 5. With n=101 this can't be pushed further (e.g. into per-episode causal ordering) without
more data.

A live natural experiment volunteered by the manager (fleet went idle→active, absolute give-up rate rose
from ~10/hr to ~43/hr) was checked against the per-submit analysis per the manager's own pre-registered
falsification rule ("if the per-submit rate is flat and only the absolute count rose, fleet activity is
not the mechanism, and this data point evaporates"): the per-submit rate does **not** rise with
concurrency — so by that rule, the two-point diff still evaporates as evidence *for* the hypothesis (this
conclusion is separate from, and unaffected by, the confound correction above — the two-point diff never
depended on the sign of the concurrency-rate relationship, only on whether it was flat).

## Finding 4 — engine-confirmation lag is real and load-bearing, but role-agnostic, and the log has a
join-key gap that makes any precise measurement approximate

Pairing each submit-attempt-1 with its session's next `UserPromptSubmit` hook (`scripts/confirmation-
lag.mjs`) hits a real methodology hazard: **the submit log line carries no generation/message id**, so
pairing is by time-order only. Across a cascade, several submit1 lines can precede the ONE real hook that
eventually confirms the (re-minted) message — naive pairing then assigns the cascade's later attempts to
the session's *next unrelated turn*, sometimes hours later (~22% of raw pairs in this corpus were
multi-hour and excluded as pairing artifacts, not silently dropped).

On the remaining 326 clean (≤15min) pairs: median 588ms, but ~25-30% exceed 30-120s even after
exclusion, and a genuine, non-cascade cluster of ~15 pairs at 750-900s (12-15min) appears on two manager
sessions during a sustained 2026-07-29 ~10:00-11:30Z window (see Finding 5 for what else was happening
then). Split by role, worker resolves faster on the medians (worker median 312ms/mean 55.6s vs manager
median 2.77s/mean 237s) — but this split is itself contaminated by the same pairing ambiguity, so treat
it as suggestive only, not as a role effect.

**This is the one concrete code gap this investigation found**: no analysis, and no future live
reconciliation fix on `4a0af485`, can attribute a late confirmation to its true originating submit
without a join key. See "Observability fix" below.

## Finding 5 (Probe B) — direct, time-aligned evidence of host activity during the sustained 10:00-11:30Z
lag cluster

The card's synthesis names host-load contention as the mechanism, but the time-radius proxy (Finding 3)
can only see *other sessions' submits* — it's blind to builds, gates, and merges. Sliced the exact window
(`scripts/slice-window.mjs`, `2026-07-29T09:55:00Z`–`11:35:00Z`) and searched for independent signals of
host activity:

- **12 distinct worker sessions spawned** in this 1.5h window — a genuinely active fleet, not idle.
- **8 `[loom:merge-done]` deliveries** landed in this window, and **all 8 went to exactly the two manager
  sessions showing the sustained lag** (`062c9897`: 4, `cb85f531`: 4) — not a random sample of the
  fleet's managers.
- A **codescape serve build-drift restart** fired mid-window: drift detected `09:56:38.403Z`, went STABLE
  and the serve process was killed (SIGTERM) and restarted at `10:11:38.629Z`.
- No line carrying a genuine `[gate...]`-style tag fired in this window (the "gate" substring hits found
  were all inside spawn-argv paths, not real gate-run log lines) — noting the absence plainly rather than
  omitting it.

**Precise temporal alignment, not just same-window co-occurrence**: the `062c9897` lag samples at
`10:11:38.806Z` (782.0s lag) and `10:18:29.596Z` (810.1s lag) land within ~0.2s and ~0.16s respectively of
the codescape serve restart (`10:11:38.629Z`) and a merge-done delivery to that same session
(`10:18:29.440Z`). The `cb85f531` lag cluster (10:58-11:31Z) similarly brackets four merge-done deliveries
to that session between 10:50:52Z and 11:16:22Z.

**This converts "host load, asserted but unmeasured" into "host load, measured on this specific
episode."** It is n=2 sessions / one episode, not a general law, and correlation here doesn't prove the
merge-done delivery or the serve restart *caused* the specific lag sample it sits beside — but the
precision of the alignment (sub-second, twice) is well beyond what same-window coincidence alone would
predict, and it is genuine positive evidence rather than an inference from the absence of a
submit-concurrency signal.

## Finding 6 — PER-SESSION inbound delivery pressure, not cross-session concurrency, is the axis that
shows a real, monotonic, positive effect

Every prior concurrency measurement on this card (the card's own line-radius proxy, Finding 3's
time-radius proxy) counted *other sessions'* activity nearby. None measured the one axis left standing:
how much traffic was being pushed **into** the session that was about to give up. Finding 5 found 8/8
merge-done deliveries in the 10:00-11:30Z cluster landing on exactly the two lagging sessions — delivery
pressure concentrated on the victims themselves, not generic ambient host load.

`[submit-write] <sessionId> reason=... busyBefore=... len=... head="..."` (`pty/host.ts`'s `submit()`)
fires once per message actually delivered into a session's composer, from any source (manager direction,
merge-done pushes, nudges, a human turn), regardless of path — the closest log proxy to "inbound traffic
landing on this session." `scripts/inbound-pressure.mjs` counts these targeting the SAME session as each
give-up's trigger, in the identical PRIOR window (−300s to −60s) Finding 3's confound check used, and
compares against the 505-submit baseline:

| | mean prior inbound (own session) |
|---|---|
| give-up triggers (n=101) | **1.218** |
| baseline, all submits (n=505) | 0.820 |
| **ratio** | **1.486x** |

Binned by prior inbound-pressure level, the per-submit give-up rate is **monotonic**:

| inbound level | 0 | 1 | 2 | 3+ |
|---|---|---|---|---|
| give-up rate | 12.55% | 24.82% | 27.14% | **38.46%** |

Low(0-1) vs high(2+): 16.9% (67/396) vs 31.2% (34/109) — **χ²(df=1)=10.88, p<0.001**, and unlike Finding
3's inverse result this is in the *hypothesized* direction with a clean dose-response shape across four
buckets, not a single significant bucket comparison — a materially different and stronger evidentiary
shape than Finding 3 had.

By role: manager mean prior inbound 1.259 (give-up) vs 0.975 (baseline) = 1.29x; worker 1.163 vs 0.585 =
**1.99x**. Managers have a higher absolute baseline (consistent with Finding 2 — they're the natural
recipients of merge-done/report/nudge traffic) but the *relative* elevation at give-up moments is, if
anything, larger for workers — this reads as a role-agnostic per-session mechanism whose baseline exposure
happens to differ by role (the same dosage shape as Finding 2, now on the correct axis: inbound volume,
not submission volume).

**Reading, without over-claiming causal direction**: per the manager's three-way distinction — (a) local
self-suppression, (b) a common cause suppressing everyone including the victim, (c) inbound pressure on
the victim driving its own lag — this measurement is confined to traffic targeting the SAME session, so
it is orthogonal to (a)/(b) by construction and speaks most directly to (c). A monotonic dose-response
across four independent buckets is a stronger signature of a real contributing effect than a single
significant split, but n=101 give-ups still can't establish (c) as the *sole* mechanism over, say, a
version of (b) where host-wide batching produces both more merge-done deliveries and more contention at
once. What this finding does establish: **inbound delivery pressure is the one axis measured on this card
that shows an effect in the hypothesized direction, at a dose-response shape, surviving the same rigor
(anchoring, positive control, the 1:1 join) applied to every other measurement here** — this is what
should shape `4a0af485`'s design, not the (retracted) cross-session concurrency result.

## Synthesis

One mechanism, role-agnostic, and it sits on a specific axis: **per-session inbound delivery pressure**,
not cross-session submission concurrency and not (established, anyway) generic gate/build CPU load. No
per-submit role tilt survives declustering (Finding 1); the session-level split is fully explained by
manager sessions' much longer lifetime and higher submit volume (Finding 2); nearby-*other-session*
concurrency's apparent inverse relationship to give-ups does not survive a reverse-causality confound
check and is retracted as evidence either way (Finding 3); no genuine gate-tagged activity was found
during the one sustained real-world lag episode examined, so generic build/gate contention is explicitly
**not** established (Finding 5's negative, stated as plainly as the positive); but that same episode
showed merge-done delivery pressure concentrated precisely on the two victim sessions (Finding 5), and
**inbound pressure on the victim session itself is the one axis, of everything measured on this card, that
shows a real, monotonic, statistically significant effect in the hypothesized direction** (Finding 6:
1.49x elevation, 12.55%→38.46% across four dose levels, χ²=10.88, p<0.001). The card's DoD #1 ("explain
the modest manager tilt") is satisfied by showing there is no per-submit tilt to explain — that
conclusion does not depend on any of the concurrency findings, retracted or otherwise. What DOES follow
for `4a0af485`: design around inbound delivery pressure on the recipient (queueing/backpressure at the
per-session delivery path), not around cross-session submission timing or a generic load-shedding
constant.

**Remediation was folded into `4a0af485`** by the manager (idempotent logical-message id across
re-mints/resends, attribute a late confirmation to its own generation — already detected at
`pty/host.ts:5126`, just not acted on — and honest "unconfirmed, possibly pending" reporting instead of
"not delivered"). `04de8bbf`'s role-tilt investigation is closed as EXPLAINED (exposure/dosage).

## Observability fix landed alongside this investigation

Added the submit generation number to the `[submit] ... Enter attempt N/4 written` log line
(`pty/host.ts`) — log-only, zero behavior change. This is the join key Finding 4 found missing; without
it, no future analysis or live fix on `4a0af485` can verify "a late confirmation is attributed to its own
generation" by joining a submit to its confirming hook. See the commit for the exact diff.

## Standing constraints — untouched

`SUBMIT_VERIFY_TIMEOUT_MS`, the `>`/`>=` comparison, `c933238`, message-size, and the paste-reassert echo
were not touched, per the card's standing constraints.
