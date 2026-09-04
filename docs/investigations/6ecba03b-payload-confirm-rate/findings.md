# 6ecba03b — does write-confirm probability fall as PAYLOAD size rises?

## Instrument, stated before the data (per this card's own DoD)

Independent variable: payload size (`len=` on the `[submit-write]` log line — the composer body length in characters at the moment a message is accepted for delivery, before `writeChunked` paces it onto the real pty).

Dependent variable: whether that submit generation ends in a genuine give-up (`[submit] <sid> GIVE-UP RECOVERY after N Enter attempts — no confirming hook observed...` / older wording `— no engine output observed...`) — i.e. the write never confirmed within the production retry ladder (`SUBMIT_VERIFY_TIMEOUT_MS` x `SUBMIT_MAX_ATTEMPTS` + the `awaitGiveUpConfirmSettle` window).

Falsifier, pre-committed: if the give-up rate is flat (or not statistically distinguishable) across size buckets, that is a real, reportable null — not a reason to keep looking for an effect.

Population and instrument: real production log history from this project's own self-hosted daemon (`daemon-output.log` + 5 rotated predecessors, contiguous, 2026-08-24T11:49:54Z → 2026-09-04T21:47:28Z, ~15.6 days, 390,022 total lines, 6,304 submit-write events / 6,311 Enter-attempt-1 events / 302 true give-ups). This is **observational**, not the controlled sweep the card's DoD-2 originally asked for (see "Why observational, not a real-spawn sweep" below) — role, machine, engine, mode-cycle and host-load are **not** held constant.

## Why observational, not a real-spawn sweep

The card's DoD-1 rules out the daemon's own hermetic test suite (a fake pty whose confirmation is scripted by the test) and points at `kickoff-real-spawn.mjs`'s real-OS-process shape as the house idiom for a "real spawn." That harness substitutes a fixture (`fake-claude-cli.mjs`) for `claude` via `LOOM_CLAUDE_BIN`. Read closely (`fake-claude-cli.mjs`'s own contract comment), its "confirm" signal is a fixed post-quiet-period file flush — `FIXTURE_DEBOUNCE_MS` after the *last* byte received — independent of total payload size, and it also emits a `FIXTURE_ALIVE` heartbeat every `FIXTURE_HEARTBEAT_MS` regardless of input, which would itself satisfy `fireEnterAndVerify`'s `lastOutputAt > enterWrittenAt` discriminator within one heartbeat interval of any Enter write. Reusing that fixture to test THIS hypothesis would very likely return a foregone null — not because size doesn't matter, but because the fixture's confirm signal is structurally decoupled from the one thing a real engine's confirm timing actually scales with (rendering/hook round-trip cost proportional to the pasted content). That would be exactly the "broken instrument returning the answer you built into it" trap DoD-1 warns against, just with a different-flavored broken instrument than the fully-hermetic one it explicitly names.

A genuine controlled sweep would need many real, API-consuming `claude` engine spawns across sizes — expensive, and disproportionate for a p3 card that also carries a standing host-load-honesty constraint against creating new load on this shared box. Given that, real production history — the actual engine, actual hook timing, actual host load, already sitting in `daemon-output.log` — is the closer, cheaper, and (per the sibling card `04de8bbf`'s own precedent, see below) house-validated way to ask this question, with the tradeoff that it's correlational and needs confound-checking rather than a clean sweep.

## Method

Modeled on `docs/investigations/04de8bbf-giveup-confirmation-lag/scripts/parse-log-events.mjs`'s positive-controlled stamp parsing and 1:1 join methodology, but **not reused verbatim** — that script's own `GIVEUP_RE` ("no engine output observed") is stale against the current corpus. Direct grep confirmed the wording changed mid-history (card `441499ee`'s `awaitGiveUpConfirmSettle` hardening): the three oldest rotated files say "no engine output observed" (86/94/53 matches, 0 for the new wording), the three newest say "no confirming hook observed" (0/0/57/12/0 — old phrase absent). Reusing the sibling investigation's regex unmodified would have silently undercounted 233/302 (77%) of the true give-ups in this exact corpus. `scripts/payload-confirm.mjs` in this folder matches both, and its self-check positive/negative-controls every regex against both a known-good and known-bad case (including the "GIVE-UP SUPPRESSED" provisional/final variants, which must NOT be misclassified as a true give-up) before it will process any log.

Two joins, run over the concatenated, chronologically-contiguous corpus (verified contiguous: each rotated file's first stamp is within milliseconds of the previous file's last stamp):

1. **Enter-attempt-1 → payload length**: nearest preceding `[submit-write]` in the same session, ≤30s lookback (a 185KB payload takes ~1.5s to fully chunk-write at production's `PTY_WRITE_CHUNK_UNITS=1024B`/`PTY_WRITE_CHUNK_DELAY_MS=8ms`, so 30s is generous headroom derived from that constant, not guessed). This also correctly carries the length forward across an "Enter-only" give-up retry (card `b9b8f8db`'s own fix) that writes no new submit-write line, since it reuses the last real body's length — the semantically correct len for that retry's actual write.
2. **A true give-up → its triggering Enter-attempt-1**: nearest preceding, same session, ≤15s (reusing `04de8bbf`'s own validated window: 4 attempts × 900ms + settle wait ≈ 3.6-4s).

Join quality: 6,304/6,311 (99.9%) Enter-attempt-1 events resolved a length; 301/302 (99.7%) give-ups linked; zero double-claims (no two give-ups attributed to the same submit).

## Result

| bucket | n (submits) | n (give-up) | rate |
|---|---|---|---|
| <5KB | 3,825 | 114 | 2.98% |
| 5-20KB | 1,075 | 94 | 8.74% |
| 20-60KB | 1,233 | 73 | 5.92% |
| 60-120KB | 171 | 16 | 9.36% |
| 120KB+ | 0 | 0 | n/a |

Total: n=6,304, 297 give-ups, 4.71%. No data landed above 120KB in this window — post-`b9b8f8db` (which removed the payload-growth loop), nothing in production currently writes a payload that large in one generation.

**The raw table is not monotonic** (2.98% → 8.74% → 5.92% → 9.36%) — a clean dose-response is not what this shows.

**<20KB vs ≥20KB** (a natural split near the card's own named ~46KB midpoint): small n=4,900 g=208 (4.24%), large n=1,404 g=89 (6.34%). χ²(df=1) = **10.66** (p<0.001) — a statistically significant raw association, in the direction the original inferred claim predicted.

## Confound check — does the raw effect survive controlling for delivery `reason`?

`[submit-write]`'s `reason=` field (already collected, no extra cost) names the delivery path: `immediate`, `drain`, `kickoff-guarantee`. Stratifying the same <20KB/≥20KB split by reason:

| reason | small n/g/rate | large n/g/rate | χ² |
|---|---|---|---|
| `immediate` | n=2,460 g=38 (1.54%) | n=0 g=0 (n/a) | n/a |
| `kickoff-guarantee` | n=24 g=0 (0.00%) | n=1,183 g=67 (5.66%) | 1.44 |
| `drain` | n=2,416 g=170 (7.04%) | n=221 g=22 (9.95%) | **2.55** |

`immediate` (ordinary same-turn messages) is *structurally* almost always small; `kickoff-guarantee` (session-startup prompts) is *structurally* almost always large. Size and delivery-path/session-lifecycle-stage are collinear across the large majority of the corpus — the raw χ²=10.66 largely reflects "kickoffs vs. everything else," not a clean size effect.

`drain` is the one reason category with genuine size variance on both sides (the general message-delivery path — worker reports, manager nudges, human turns — carries both small and occasionally-large bodies). Within `drain` alone, the same-direction gap (7.04% → 9.95%) **does not reach significance at this n** (χ²=2.55, need ≥3.84 for p<0.05).

## Reading this honestly

- **The unconditioned population-level association is real and significant** (χ²=10.66, p<0.001, n=6,304) — larger writes do co-occur with a higher give-up rate in this corpus.
- **It is substantially confounded by delivery reason.** The one subset where size varies independently of reason (`drain`, n=2,636) shows the same direction but not the same strength, and does not clear the conventional significance bar.
- **Per the small-n-null caution this card's own DoD requires**: "not established at this n" is the honest statement for the `drain` result, not "no effect" — n=221 in the large `drain` bucket is not huge, and this reads as under-powered rather than definitively flat.
- **Known, unremoved confounds beyond `reason`**: `04de8bbf` (the sibling investigation on the *context-size* axis of this same question) found per-session **inbound delivery pressure** to be the one axis with a real, monotonic, statistically decisive effect on give-up rate (12.55%→38.46% across four dose levels, χ²=10.88, p<0.001) — and did not test payload size, leaving it explicitly untouched. This analysis does not check whether inbound pressure also correlates with payload size (plausible: a session under heavy inbound traffic may also be more likely to receive/accumulate a larger next write) and therefore cannot rule out that the residual `drain`-stratified size gap is itself a downstream artifact of inbound pressure rather than of size per se. Role (manager vs. worker) is a similarly plausible, similarly untested confound (per `04de8bbf` Finding 2, managers run far longer sessions with far more submits — a dosage difference that could interact with typical message size by role).
- **This is a real production instrument, not a synthetic one** — it reflects actual engine behavior, actual host load, and actual hook-confirmation timing, which is the one thing a fixture-based real-spawn test (see above) structurally could not have given us.

## Answer to the card's question

**No clean, unconfounded size effect is established.** A real, significant raw association exists, but it is substantially attributable to payload size being collinear with delivery reason (kickoffs are big, ordinary messages are small) rather than to size acting on confirm probability independent of reason. Within the one subset that isolates size from reason, the same-direction trend does not reach significance at the available n (χ²=2.55 on n=2,636, need ≥3.84).

This is **not** the clean null DoD-4 imagined ("no detectable size dependence... closes this card") — there IS a detectable raw dependence — but it is also not confirmation of the original inferred causal claim, which specifically asserted that size itself degrades confirm probability. What this analysis adds beyond "still inferred": the raw correlation people would naturally point to (bigger writes give up more) is real but is not clean evidence for the size mechanism specifically, because it is confounded with what kind of message is being sent.

## What would resolve this further (not attempted here — proportionality)

- A larger `drain`-only window (more days of log history, once available) to re-run the same stratified check with more power in the large-`drain` bucket.
- Checking whether inbound pressure and role correlate with size within `drain`, to see if the residual gap survives a joint model rather than a single stratifier.
- A genuine controlled real-engine sweep (real `claude` spawns at fixed sizes) remains the only way to fully isolate size — judged out of proportion for a p3 card per the reasoning above; declined here, not attempted and reported as green.

## Card `b9b8f8db` updated

Its "WHY THIS IS SELF-SEALING" paragraph (the inferred causal-loop claim) was replaced in place with a pointer to this finding, per this card's DoD-5.
