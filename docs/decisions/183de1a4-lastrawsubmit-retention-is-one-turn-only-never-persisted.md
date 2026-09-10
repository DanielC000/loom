# 183de1a4 — `Live.lastRawSubmit`'s retention verdict: one-turn ephemeral slot only, investigated so a future reader doesn't have to re-derive it

## Narrative

`Live.lastRawSubmit` (card `0f9268cc`) is the raw-terminal-channel counterpart of `lastPrompt`, so the paste-tripwire can see a paste/long text typed or pasted directly into the terminal panel (`/ws/term` -> `writeStdin`), not just a structured `submit()` turn.

RETENTION VERDICT (card `183de1a4`, investigated so a future reader doesn't have to re-derive it): this IS the full content of a human raw-terminal paste, not merely a length — but retention is a SINGLE ephemeral slot with a ONE-TURN lifetime (overwritten/cleared by submit() starting, or by the Stop/StopFailure chokepoint consuming it), never persisted to the DB, and reset to null on every spawn/resume/fork — it does NOT survive a daemon restart.

That one-turn window is sufficient for the bare-placeholder tripwire + its one-shot recovery (they consume it within the SAME turn it's set), but nothing downstream can recover an OLDER turn's raw paste once this slot has moved on — see `detectPastePlaceholderLengthLoss`'s own doc for the resulting residual (a stale re-render several turns later, `PASTE_LOSS_EXPLAIN_WINDOW`-bounded).

## Do not

- Do not assume `Live.lastRawSubmit` can recover an older turn's raw paste content — it is a single ephemeral slot with a one-turn lifetime, not a durable store; it does not survive a daemon restart and is overwritten/cleared well before an older turn's content could be needed again.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`Live.lastRawSubmit`'s field doc), lines 2370-2377 as of this tranche's HEAD (commit `1d2e8e78`). Relocated by card `60cd72ad` (tranche 5 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. The field's own base doc (card `0f9268cc`, what the field is and how it's set/cleared) remains inline at the same location.
