# d326c3c2 — `question_resolve` refuses rather than quoting a stale owner turn when the current one was race-discarded

## The real mechanism (and why the card's stated root cause was already false)

Card d326c3c2 was filed from a chenari-dev escalation describing `question_resolve` recording the
owner's PREVIOUS message instead of their current answer, and claimed the root cause was that
`Live.activeTurnOwnerText` is populated ONLY by Loom-mediated submissions (companion inbound / the
composer route) — never by text typed directly into the raw terminal.

That claim was already false against the code at the time this card was investigated: cards `b4b9b707`
and `fca6af6d` (merged 2026-07-24, ~2 months before the incident) added exactly this raw-terminal
attribution path — `writeStdin` captures a genuine Enter-submit into `Live.pendingRawOwnerSubmit`, and
the `UserPromptSubmit` hook (`pty/host.ts`'s `deliverHook`) attributes it via `attributeOwnerText` the
moment it's confirmed. `pty-owner-attestation.mjs` (scenarios 9/15) and `question-resolve.mjs` (Part 2/2b)
already covered the simple case and pass on unmodified main.

The REAL gap, reproduced with a positive control (the race) and a negative control (the same raw Enter,
no race): `fca6af6d`'s own reverse-order-race fix deliberately DISCARDS a raw-terminal owner line that
races an already-outstanding Loom submit() — rather than risk crediting it to the wrong turn — so
`getActiveTurnOwnerText` correctly returns `null` for that turn (see `pty-owner-attestation.mjs` test 14).
But `question_resolve`'s fallback (`getActiveTurnOwnerText ?? getRecentOwnerTurns()[0]`, decided by card
`ca341979` for the legitimate "current turn genuinely isn't owner-formed" case) cannot tell that apart
from "an owner turn existed this generation but was discarded by the race" — so it silently substituted
the PRIOR owner turn, reproducing the incident's exact symptom.

## The fix

`Live` gained two fields, `raceDiscardedOwnerSubmitAt`/`raceDiscardedOwnerSubmitGen` (claude-only —
codex has no raw-terminal attribution mechanism to race in the first place) — a timestamp/generation
marker, never the discarded text itself. It is:
- **Set** in the `UserPromptSubmit` case, exactly where a fresh `pendingRawOwnerSubmit` is discarded
  because `submitWasOutstanding` (the `fca6af6d` branch).
- **Cleared** ONLY the instant a genuine owner turn is actually attributed (`attributeOwnerText`) — a
  real attribution always supersedes a stale discard marker.

**Code Review correction (first round of this card):** the original design ALSO cleared the marker
whenever `submit()` advanced to a new generation, on the theory that a later, unrelated turn means the
race "no longer describes the current turn". That reopens the exact stale-quote bug this card fixes: a
race at generation N, followed by turn N's Stop draining something ELSE (a queued worker report, a
rate-limit replay, a kickoff guarantee — none of them the owner) as generation N+1, would silently clear
the marker before the agent ever gets to call `question_resolve` — and the fallback would quote the
PRIOR owner turn again, exactly as if this card had never shipped. The two failure costs are asymmetric:
a marker that stays TRUE too long costs one refusal that already tells the agent what to do and
self-heals the moment the owner repeats themselves; a marker that goes FALSE too early silently records
the wrong owner's words. So the marker now survives ANY NUMBER of unrelated generations and clears on
nothing but a genuine owner attribution.

`PtyHost.hasRaceDiscardedOwnerSubmit(sessionId)` exposes it. `question_resolve`'s fallback (both the
manager surface, `mcp/orchestration.ts`, and the Lead surface, `mcp/platform.ts`) checks it ONLY in the
fallback path — if the current turn isn't owner-formed and the marker is set, `resolveQuestionForAgent`
(`mcp/questionTool.ts`) refuses outright (checked before the `ownerText === null` case) rather than
falling back to `getRecentOwnerTurns()[0]`. The refusal message tells the agent to ask the owner to
repeat their reply, or use the web Requests UI.

`getActiveTurnOwnerText`'s own contract and Primitive A's semantics (Companion Capability &
Permission-Lever Framework §3) are unchanged — this marker is consulted nowhere else.

## Do not

- Do not consult `hasRaceDiscardedOwnerSubmit` anywhere except `question_resolve`'s fallback — it does
  not widen or change `getActiveTurnOwnerText`'s own contract, and Primitive A's semantics were
  deliberately left untouched by this card.
- Do not store the discarded text on the marker — timestamp/gen only. Widening it to carry content would
  make it a second place owner content leaks from, with none of Primitive A's own review/containment.
- Do not clear the marker on a bare TTL/time check, and do not clear it on a later, unrelated `submit()`
  generation either (the bug this card's own first round shipped — see the Code Review correction above).
  The ONLY event that may ever clear it is a genuine owner attribution (`attributeOwnerText`) — it must
  survive any number of unrelated turns in between.
- Do not add the marker to `CodexLive` — codex has no `writeStdin`-based raw-terminal draft tracking at
  all (`writeStdinCodex` is a bare passthrough), so there is nothing to race in the first place.

Tests: `packages/daemon/test/pty-owner-attestation.mjs` (scenarios 16-18: marker set by the race,
SURVIVES multiple unrelated submit()s, cleared only by a genuine later attribution) and
`packages/daemon/test/question-resolve.mjs` ((B4)/(B5) via a fake pty, (Part 2c) end-to-end via a REAL
PtyHost reproducing the chenari-dev incident verbatim, (Part 2d) the marker surviving an unrelated
drained submit before the resolve call — RED on commit `42abe107`, the first round of this card).
