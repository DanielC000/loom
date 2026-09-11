# 25813ecc — capture the kickoff from `live.startupPrompt`, never `live.lastPrompt`

## Narrative

Card `25813ecc` fixes a live regression that card `0050a17e`'s own kickoff-delivery work introduced (squash commit `b4fa85a4`): `markReady` used to read `live.lastPrompt` to recover "the kickoff" text. That is unsafe — `drainPending`, called from `markReady` right before delivery, calls `submit()` for any queued message (a resume's queue is normally non-empty: companion/project-memory recall, redriven undelivered messages, all enqueued before ready), and `submit()` unconditionally overwrites `live.lastPrompt` with whatever it is currently submitting. Reading `lastPrompt` AFTER that drain — the old code's order — captured the DRAINED message instead of the real kickoff on a resume, and `scheduleKickoffGuarantee` then redelivered that wrong text a second time.

The fix: capture the kickoff from `live.startupPrompt` instead — the IMMUTABLE field seeded once at `spawn()` from `opts.startupPrompt ?? null` and never written again by anything else (only `submit()` ever touches `lastPrompt`; nothing ever touches `startupPrompt` past `spawn()`). `markReady` reads `startupPrompt` BEFORE calling `drainPending`, so the read is correct by construction — it names the one field that can never be another turn's text — not by depending on statement order between the capture and the drain call.

## Do not

- Do not read `live.lastPrompt` at `markReady` to recover the kickoff — read `live.startupPrompt` instead. `lastPrompt` is overwritten by every `submit()` call, including the ones `drainPending` triggers for a queued message.
- Do not capture the kickoff AFTER calling `drainPending` — capture it before, from the immutable field, so no future reordering of the surrounding lines can reintroduce this bug.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`markReady`, the kickoff-capture line immediately before `drainPending`), as of commit `aa936b4e3526d81eb06f8758539b19f33f2b4cf3` (this tranche's starting HEAD, `host.ts` tranche 48). Extracted by card `8a3d430f` (tranche 49 on `pty/host.ts`). Condensed and reworded, not verbatim. This card id recurs at two other sites in this file not covered by this record: `Live.startupPrompt`'s own field doc (~line 2251) and a `Live.giveUpOrigin`-adjacent comment (~line 8031) — both outside this tranche's line-range fence (~9580-10300); a future tranche should check whether either carries content beyond what's here before creating a second record.
