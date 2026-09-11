# 1bd1f045 — the `[pty-write]` byte/call-sequence log for the actual `pty.write()` call

## Purpose and placement

Card `1bd1f045`: a byte/call-sequence log for the ACTUAL `pty.write()` call, called INLINE at every real write site — never a layer above them — so it records what genuinely reached node-pty, not what the daemon merely composed/handed down. That distinction matters: `[submit-write]` (`submit()`'s own pre-write log) was overclaimed as proof the write path is clean and retracted twice. Everything from the actual `pty.write()` call down was, until this card, completely uninstrumented in both directions (see `3ce3fa39`'s frame-splice investigation, for which this log supplies the missing forensic layer — `3ce3fa39`'s own record covers a different call site's composer-clear-timing decision, not this instrumentation).

## The discriminator

This log discriminates the two surviving hypotheses for `3ce3fa39`'s mid-token splice: if the daemon itself double-emits (e.g. `writeChunked`'s `done` callback firing more than once, unguarded by `submitGeneration` — see `9ed20572`, which documents `writeChunked`'s own "`done` must fire on every exit path" invariant at its own site, not this discriminator), TWO `[pty-write]` records on `tag=chunk` share the same content signature (`len`, `hash`) at distinct `seq` WITHIN THE SAME `gen`. If the daemon writes exactly once and corruption still appears at the receiving end, this log shows a single clean record and the fault is BELOW the daemon (ConPTY/node-pty/Windows). Either outcome is a real result.

## Correction, 2026-07-23 (manager measurement, 583 live records)

The discriminator above is unusable without the `tag=chunk`+`gen` restrictions: fixed control sequences (enter/bracket-start/bracket-end) are byte-identical by construction and matched repeatedly on healthy traffic, and a by-design re-write (give-up requeue/retry/re-drain — see `purgeConfirmedGiveUpRequeue`) crosses a `gen` boundary rather than duplicating within one. Two traps this correction closes:

- `seq` resets across a daemon restart — de-duplicate per boot, never across one.
- The give-up clear burst reuses the `chunk` tag and can share a message body's `len` (only the hash differs) — never filter by length alone.

`seq` is the load-bearing field: a monotonic per-session counter (`Live.writeSeq`) that makes a duplicated or out-of-order emission visible AS a sequence anomaly rather than plausible traffic.

## Record size (card review, 2026-07-23)

A head+tail excerpt was the first cut but measured at ~100-150 bytes/record — at 17 call sites, some firing per-chunk on every 15KB+ payload, that risked shrinking `daemon-output.log`'s rotation window (the SAME forensic corpus `3ce3fa39`/`9ed20572` depend on) faster than it fills today, which would make a rare recurrence HARDER to catch, not easier. `fnv1a32` replaces the excerpt with a fixed 8-hex-char content fingerprint — every field the card's DoD names (sessionId, seq, submitGeneration, len, a cheap hash) stays, nothing load-bearing for duplicate/replay detection is dropped, and the record shrinks by roughly half regardless of chunk size. `tag` names WHICH call site wrote (bracket-start/chunk/bracket-end/enter/…) so a reader doesn't have to infer it from content.

## Do not

- Do not filter candidate duplicate `[pty-write]` records by `len` alone — the give-up clear burst can share a length with unrelated traffic; the hash is what discriminates.
- Do not compare `seq` values across a daemon restart as if they were one continuous sequence — `seq` resets on boot.
- This log is OBSERVATION ONLY (see the inline guard at its call site, `ptyWrite()`): it must never alter what's written, its outcome, or its timing relative to a bare `live.pty.write(data)` call.

## Source

Inline comment (JSDoc) in `packages/daemon/src/pty/host.ts`, `ptyWrite()`'s own method doc, lines 8000-8032 as of this tranche's starting `main` HEAD (`f18fdfcb`). Extracted by tranche 33 (card `7ad5b460`).
