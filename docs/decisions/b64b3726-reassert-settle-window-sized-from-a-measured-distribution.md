# b64b3726 — the give-up paste-reassert settle window is sized from a measured latency distribution

## Narrative

Card b64b3726: bounded poll for the GIVE-UP attempt's own paste-reassert (`BRACKET_PASTE_START` + `BRACKET_PASTE_END`, written by `sendEnterAndVerify` on every `attempt > 1`) to settle BEFORE writing that attempt's Enter and capturing `enterWrittenAt` — see `awaitReassertSettle`. Mirrors this file's existing `RESUME_MODE_READ_POLL_MS`/`RESUME_MODE_CHANGE_MAX_POLLS` poll-count convention (observe, don't guess, but stay bounded).

SIZED FROM A MEASURED DISTRIBUTION, not guessed (real `claude` engine, card b64b3726 probes — see `test/_probe-empty-paste-provocation.mjs` for the base finding). The re-assert alone reliably provokes a deterministic 16-byte TUI response (a keyboard-protocol renegotiation) — but only INTERMITTENTLY at production's actual retry cadence (~900ms between reasserts): a cadence-matched probe found it lands inside its own attempt's verify window in ~13-20% of give-ups, not "always" (an earlier, wider-spaced probe had wrongly suggested "always" — see that finding's own correction note for why probe CADENCE has to match the thing being measured). When it DOES fire, latency across n=10 pooled real-engine samples was bimodal: 8/10 (80%) landed in 1.15-7.65ms, 2/10 (20%) landed at 820.96/1367.94ms. `REASSERT_SETTLE_MAX_POLLS` × `REASSERT_SETTLE_POLL_MS` ≈ 300ms therefore catches the fast majority with wide margin and deliberately accepts the slow tail as a residual — a slow-arriving response can still land after this bound and cause a suppress on THIS attempt, same as before this fix. That residual is acceptable ONLY because `healIfStuck` (card b64b3726 Half 2) backstops the consequence regardless of which vector caused the suppression — if that backstop is ever removed, this bound needs re-deriving against a fuller sample, not just widened. If a future re-measurement shows the fast group is no longer the majority, THIS bound is the wrong one to keep — don't just halve it, re-derive it from a fresh distribution.

## Do not

- Do not just widen or halve `REASSERT_SETTLE_MAX_POLLS`/`REASSERT_SETTLE_POLL_MS` off a future re-measurement — re-derive the bound from the fresh distribution, the same way this one was sized.
- Do not treat this bound's residual-acceptance as safe on its own — it depends on `healIfStuck` (card b64b3726 Half 2) backstopping the consequence; if that backstop is ever removed, this bound needs re-deriving.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`REASSERT_SETTLE_POLL_MS`/`REASSERT_SETTLE_MAX_POLLS`'s top-of-const doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Half 2 — the orphaned composer clear, at `healIfStuck`'s stale-busy branch

The residual accepted above (a slow-arriving reassert response landing after the settle bound) is exactly what `healIfStuck` backstops: when a session is caught busy-with-no-output past `staleMs`, and `!live.enterConfirmed && live.composerLen === 0 && live.lastPrompt`, that shape is exactly a give-up that was wrongly suppressed (or any other path leaving an unconfirmed submit stranded) — the composer holds a paste that was written but never confirmed. The OLD version of `healIfStuck` cleared `busy` but never un-typed the composer, so the stranded injection survived and the NEXT `drainPending` submit pasted on top of it — reintroducing the exact concatenation card `ee082fbb` fixed. `sendEnterAndVerify` can independently suppress its own give-up recovery (card `71de1f9c`) when it reads output after the final Enter write — but that read can be fooled: either by our own paste-reassert write provoking a deterministic engine response, or by a viewer's `repaint()` doing the same; either vector can leave a submit stranded this way. When it does, `live.enterConfirmed` stays false FOREVER: nothing else can ever flip it, because nothing can call `submit()` again — the sole writer of `lastPrompt`/`enterConfirmed=false` — while `live.busy` stays stuck true, and `enqueueStdin` only submits immediately when `!live.busy`. That permanence is exactly why `healIfStuck`'s backstop has to exist at all.

This half reuses the SAME mechanism `sendEnterAndVerify`'s own give-up path already uses — do not invent a second clear path: an exact-count Backspace burst sized off `live.lastPrompt.length`, gated on `composerLen === 0` (card `e1829591` — never touch a real human draft), with `setBusy(false)` threaded through the burst's own completion (`writeChunked`'s `done` callback) so a concurrent `enqueueStdin` can't interleave a new turn's paste into the still-draining backspaces. This is deliberately UNCONDITIONAL on *why* `enterConfirmed` is false — robust to vectors nobody has enumerated yet, not just the two vectors above.

A turn that's LEGITIMATELY still confirmed-and-running never reaches this branch at all: `UserPromptSubmit` sets `enterConfirmed = true` AND re-arms `busySince` (rising edge) the moment the turn actually starts, so a merely-slow-to-confirm turn's staleness clock restarts before `staleMs` can elapse — belt-and-suspenders with the `enterConfirmed` check itself.

This half only CLEARS the stranded injection from the composer — it does not by itself restore the abandoned text anywhere. See card `2c3c4aff`'s own record for the gap that left and its fix.

## Do not (2)

- Do not invent a second composer-clear path for this branch — reuse the same backspace-burst mechanism `sendEnterAndVerify`'s give-up path already uses.

## Source (3)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`healIfStuck`'s doc comment, the Card b64b3726 Half 2 paragraphs). Extracted tranche 28.
