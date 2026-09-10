# f91c8634 — the reference discriminator for "did this session ever really start": busy:false + non-empty on-disk transcript, not give-up-budget exhaustion alone

## Narrative

Card f91c8634 investigated "stuck turn-1" specimens and, in its own DoD item 3, specified the working discriminator for whether a session's first turn genuinely never started: `busy:false` plus a NON-EMPTY on-disk transcript check (an empty transcript means nothing ran) — not give-up-budget exhaustion, which is only a delivery-channel signal that Loom's own confirmation went stale, never proof the engine didn't receive the write.

Card `a8f8a8f2`'s original `handleKickoffGiveUpExhausted` wiring keyed its `[loom:worker-spawn-broken]` notice on exhaustion alone, without adopting this specified discriminator — the root of card `00bd3b4a`'s incident, where the notice fired against a healthy, 35-turn-deep worker whose kickoff had simply confirmed late (pinned memory `engine-confirmation-can-lag-minutes-timeouts-assume-seconds` records a measured 232s confirmation lag with no known ceiling).

Fixed (card `00bd3b4a`) by reading the `f91c8634`-shape check DIRECTLY at the top of `handleKickoffGiveUpExhausted`: `readTranscript(w.cwd, w.engineSessionId, w.harness).length > 0` is proof-by-construction the kickoff was NOT dropped — the same ground-truth artifact `worker_transcript` exposes, and the one that refuted this exact notice in production (session `405985b5` showed `totalTurns:35` there while the notice was still asserting "nothing began at all"). `busy` is NOT re-checked at this call site: it is ALREADY false by construction there (`fireEnterAndVerify`'s GIVE-UP RECOVERY branch always calls `setBusy(false, "give-up-recovery")` before `onGiveUpExhausted` can fire), so it adds no discrimination at THIS seam — unlike the generic idle watchdog `f91c8634` built the check for, which polls `busy` at an arbitrary moment. Deliberately ONE transcript read here, not `f91c8634`'s own "≥2 reads": that guard exists for a periodic watchdog that can race a transcript write within a cold start's first ~50s; this handler fires only after Loom's own give-up budget has fully exhausted (two submit-retry cycles plus a hold — see `requeueGiveUpOrigin`'s own doc — genuinely multiple minutes), well past that race window. This discriminator is checked on EVERY call regardless of `chainDepth` — a false-positive give-up must get NO dispatch at all, re-mint included, not just no terminal notice. `this.pty.hasFirstTurnStarted` is kept as an ADDITIONAL (OR'd), zero-I/O pre-check — cheap and strictly safe to keep since it can only ever suppress the notice MORE eagerly, never less — but it rides the SAME hook-relay confirmation channel already shown unreliable/delayed in this incident, so it is not, by itself, the specified reference discriminator; the transcript read is.

HONEST SCOPE: card `7772176d`'s re-mint fix (root cause `c8660ac7`) raises the kickoff to PARITY with `handleGiveUpExhausted`'s own re-mint, which is itself NOT proven reliable — a live specimen (an ordinary, established-session `worker_message` on the very same re-mint mechanism) parked anyway. It converts the kickoff's terminal state from "zero further attempts once the shared budget is spent, whoever spent it" to "one bounded further attempt, then park" — the same structure every other durable message gets, not a guarantee. It does NOT close `f91c8634`: that card's other specimens (a live manager mid-session, no kickoff involved) are structurally outside `scheduleKickoffGuarantee` and unverified by this fix.

## Do not

- Do not key a give-up-exhaustion notice on budget exhaustion alone — always check the `f91c8634` discriminator (`busy:false` + non-empty on-disk transcript) first; exhaustion is a delivery-channel signal, not proof the turn never ran.
- Do not claim a re-mint-parity fix like `7772176d` "closes" `f91c8634` — it only raises one path to the same (unproven-reliable) standard every other durable message already has.
- Do not add a second transcript read at this call site reasoning from `f91c8634`'s "≥2 reads" guard — that guard is for a periodic watchdog racing a cold-start transcript write; this handler fires well past that race window.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleKickoffGiveUpExhausted`'s JSDoc: "⚠️ HONEST SCOPE" paragraph, lines 7362-7368, and "Card 00bd3b4a — TWO fixes" point (1) "DISCRIMINATE before accusing", lines 7404-7431), as of main `afce859a` (introducing commit `5bf38dad7` "fix(sessions): worker-spawn-broken fired on a live 35-turn worker"). Extracted by card `3f99687d` (tranche 21); wording unchanged beyond joining wrapped lines and stripping `*` markers.

## Related

- `docs/decisions/c8660ac7-root-cause-kickoff-had-no-remint-parity.md` — the specific defect this card root-caused.
- `docs/decisions/00bd3b4a-onkickoffgiveupexhausted-msgid-rootmsgid-enable-late-confirmation-retraction.md` — the incident this discriminator gap caused, and the retraction-gap fix bundled with it.
