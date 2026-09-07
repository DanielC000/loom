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
