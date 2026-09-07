Card fedef6a0 — forced-retry probe findings

Method: scripts/probe.mjs. See that file's own header for the full mechanism (createCodexPty wrapper, positive control). One run, per manager direction ("a mechanism question, not a rate question, ONE clean observation is enough"). Run once, against a real, authenticated codex CLI, under an explicit manager-granted exclusive real-codex window.

Criteria pre-registered BEFORE this run (verbatim, sent to the manager before the probe executed):

HARM (any one suffices):
1. A genuinely new/second real turn fires (a fresh busy marker after the original reply is already printed).
2. The captured reply is duplicated, truncated, or interleaved/garbled.
3. The composer/TUI ends the observation window visibly broken or wedged.
4. The composer holds visible leftover/garbled input residue at observation end.

INERT (all four required):
1. No fresh busy marker beyond the original turn's own natural tail.
2. Exactly one clean reply, no duplication.
3. host.isBusy reads false at the end of the observation window.
4. No corruption in the raw output beyond ordinary TUI redraw noise already seen in the un-suppressed trials.

Explicitly excluded from HARM in advance: a second onCodexSubmitUnconfirmed/natural retry from the same ladder (ambiguous by itself — read the raw buffer instead); a non-zero exit on the final graceful stop (the known 176bdb0c flake, ~15.4% base rate, unrelated to this probe).

Raw result, one run:

- Positive control: PASS. isCodexBusy() on the real, unfiltered side-channel returned true during suppression — the real busy marker (title spinner) genuinely appeared in reality while PtyHost's own classification was blinded. The forced condition is a real confirmation-withheld case, not a no-op.
- submit -> retry-observed elapsed: 3317ms (matches CODEX_SUBMIT_ENTER_DELAY_MS 300ms + CODEX_BUSY_STALE_MS 3000ms almost exactly).
- submitConfirmAttempts trajectory: 0 -> 1 (one forced retry fired via CASE 3) -> stayed at 1 for the rest of the run. Never reached CASE 4 (exhaustion); never fired a second onCodexSubmitUnconfirmed.
- Raw buffer at the retry-observed instant (unfiltered side channel, escaped, tail):

```
\x1b]0;(spinner glyph) loom-codex-forced-ret...\x1b[?2026h...
⚠ MCP startup incomplete (failed: loom-orchestration, loom-tasks)
› Reply with exactly the single word: pong. Do not run any commands.
  gpt-6-astra medium · ~\AppData\Local\Temp\loom-codex-forced-retry-cwd-FwZMIh
```

(The MCP-startup warning is expected and disclosed in probe.mjs's own header — this probe does not stand up a real gateway/MCP router, mirroring its sibling real-spawn test. Not itself evidence of anything about the retry.)

- Observation window (6000ms after lifting suppression): host.isBusy read true at the 6s mark (the underlying turn was still genuinely completing — plausibly slowed by the MCP-startup-incomplete condition above); zero busy edges fired during the window itself; no second onCodexSubmitUnconfirmed.
- Buffer captured immediately after the observation window (unfiltered, escaped, tail):

```
...(spinner cycling)...
• pong
› Ask Codex to do anything
  gpt-6-astra medium · ~\AppData\Local\Temp\loom-codex-forced-retry-cwd-FwZMIh
```

Then, shortly after this capture (before the graceful stop() call): `[busy] codex-forced-retry-probe -> false (codex-marker-stale)` — a single, ordinary confirm-idle transition, and the final SUMMARY line reports busy=false.

- Final exit: code=0, intended=true, stop->exit elapsed 1358ms (fast graceful path, well under the 6000ms hard-kill backstop — not the 176bdb0c flake this run).

Classification against pre-registered criteria: INERT.

- Exactly one reply ("pong"), no duplication — criterion 2 met.
- Composer ends at the genuine idle placeholder ("Ask Codex to do anything"), no residue — criteria 3/4 met (isBusy settled false; no leftover text).
- The only busy->idle transition observed is a single, ordinary CASE-2 confirm that happens AFTER the reply is already printed — consistent with the ORIGINAL turn's own (delayed) natural completion, not a second turn. No fresh busy marker appears after that point. Criterion 1 met.
- No corruption, no garbled text, no stuck prompt in either captured buffer beyond ordinary spinner/redraw noise already present in the five natural (un-suppressed) real-spawn trials run earlier on this card.

Explicitly not read as harm: submitConfirmAttempts never exceeded 1 (no second retry, so the pre-excluded ambiguous case did not even arise here); the graceful exit was code 0 (not the 176bdb0c flake, and would not have counted against this probe either way).

Bound on this finding: n=1, one host, one MCP-unavailable condition (no real gateway stood up), one trivial single-word prompt. This is a mechanism observation, not a rate claim — it shows a bare extra Enter landing on a real, mid-turn (spinner-active) codex composer produced no observable harm in this one forced, positive-controlled trial. It does not rule out a different composer state (e.g. mid-keystroke on a longer prompt, or a different codex version) behaving differently; it directly answers the one question armCodexBusyStaleTimer's own doc comment posed as unverified.

## Follow-up run — card 605f002d (event-gated observation window)

Card 605f002d was filed because one pre-registered INERT criterion above ("host.isBusy reads false at the end of the observation window") could not be evaluated as written: it read `true` at the fixed 6s mark on a host where the original turn was genuinely still completing, and was resolved by substituting a different observable — exactly what pre-registration exists to prevent. `scripts/probe.mjs` was changed to replace the fixed 6000ms post-lift sleep with an event-gated wait (`waitUntil`): it polls until BOTH the composer's idle placeholder ("Ask Codex to do anything") reappears in the subscriber buffer after the submit instant AND a real confirm-idle busy edge fires (`armCodexBusyStaleTimer`'s CASE 2, `"codex-marker-stale"` — verified via grep to be the ONLY `setCodexBusy(..., false, ...)` call site in host.ts, so an `isBusy===false` edge observed after the lift is unambiguous), then evaluates the post-retry state. The confirmation-suppression mechanism and the side-channel positive control are unchanged.

Criteria pre-registered BEFORE this run (sent to the manager first): HARM (any one suffices) unchanged from above; INERT (all four required) unchanged except criterion 3, replaced with: `turnCompletionEstablished === true` (the event fired within a 30s budget) AND `host.isBusy()` reads false at that point — if the event does not fire within budget, this criterion is explicitly UNEVALUATED, never substituted with a duration read.

One run, per the same "a mechanism question, not a rate question" direction as the first run. Real, authenticated codex CLI, exclusive real-codex lock. Window: 2026-09-07T23:47:03Z – 2026-09-07T23:47:21Z UTC (~18s wall clock).

Raw result:

- Positive control: PASS.
- submit -> retry-observed elapsed: 4403ms.
- submitConfirmAttempts trajectory: 0 -> 1, stayed at 1 for the rest of the run (never exhausted, never a second onCodexSubmitUnconfirmed).
- **turnCompletionEstablished: true** — the idle placeholder reappeared and the confirm-idle busy edge fired well inside the 30s budget; `host.isBusy()` read `false` at evaluation.
- Busy edges observed since lift: exactly one, `{"isBusy":false}` (the CASE-2 transition) — no second busy marker.
- Captured reply tail at evaluation: exactly one clean "• pong", then the genuine idle placeholder ("Ask Codex to do anything"), no corruption beyond ordinary TUI redraw noise already seen in prior trials.
- Final exit: code=0, intended=true, stop->exit elapsed 1328ms (fast graceful path).

Classification against the pre-registered criteria: **INERT** — same classification as the first run, but criterion 3 is now genuinely, positively established rather than provisional (`turnCompletionEstablished: true`, not a duration read that happened to land ambiguous). This closes the exact gap card 605f002d was filed to fix.

One probe-mechanics FAIL, unrelated to the HARM/INERT question and deliberately not scored against it in either direction (same discipline the manager applied to a different, unrelated boot-stuck hazard seen on a sibling test in the merge gate that ran during this card's own real-codex window — that hazard means no observation at all; this run produced a full, clean observation): `check("enqueueStdin delivered the one real turn immediately (session was idle post-boot)")` failed — `enq.delivered` came back `false` (queued), not `true`. Root cause, verified by reading source rather than guessed: card 448f1b4a added a `live.bootReady` gate to `enqueueStdinCodex` (host.ts:6712) requiring ready-marker + model-loaded + trust-dialog-resolved before it delivers immediately; this probe's own pre-submit wait only checks for the idle-placeholder TEXT (predates that gate) and is weaker than it — it doesn't also wait for model-loaded. The message queued and was drained later through the exact same `submitCodex` path once `bootReady` actually latched; since suppression was armed before the enqueue call regardless of immediate-vs-queued delivery, the underlying forced-retry mechanism this probe exercises ran identically either way — the queueing did not change what was observed, only how long it took to start (4403ms vs the first run's 3317ms). This is a stale probe-internal assumption that should be tightened (wait for `isCodexModelLoaded`, not just the placeholder text) if this probe is ever run again — not fixed as part of this run, since re-running now to get a cleaner mechanics pass would be exactly the selective re-running this card's own DoD forbids.

Bound on this finding: n=1, same host/build/single-word-prompt shape as the first run (see that run's own bound above) — a mechanism observation, not a rate claim. It confirms the first run's INERT read under a methodology that no longer carries an unevaluable criterion.
