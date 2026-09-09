# b64b3726 — the give-up paste-reassert settle window is sized from a measured latency distribution

## Narrative

Card b64b3726: bounded poll for the GIVE-UP attempt's own paste-reassert (`BRACKET_PASTE_START` + `BRACKET_PASTE_END`, written by `sendEnterAndVerify` on every `attempt > 1`) to settle BEFORE writing that attempt's Enter and capturing `enterWrittenAt` — see `awaitReassertSettle`. Mirrors this file's existing `RESUME_MODE_READ_POLL_MS`/`RESUME_MODE_CHANGE_MAX_POLLS` poll-count convention (observe, don't guess, but stay bounded).

SIZED FROM A MEASURED DISTRIBUTION, not guessed (real `claude` engine, card b64b3726 probes — see `test/_probe-empty-paste-provocation.mjs` for the base finding). The re-assert alone reliably provokes a deterministic 16-byte TUI response (a keyboard-protocol renegotiation) — but only INTERMITTENTLY at production's actual retry cadence (~900ms between reasserts): a cadence-matched probe found it lands inside its own attempt's verify window in ~13-20% of give-ups, not "always" (an earlier, wider-spaced probe had wrongly suggested "always" — see that finding's own correction note for why probe CADENCE has to match the thing being measured). When it DOES fire, latency across n=10 pooled real-engine samples was bimodal: 8/10 (80%) landed in 1.15-7.65ms, 2/10 (20%) landed at 820.96/1367.94ms. `REASSERT_SETTLE_MAX_POLLS` × `REASSERT_SETTLE_POLL_MS` ≈ 300ms therefore catches the fast majority with wide margin and deliberately accepts the slow tail as a residual — a slow-arriving response can still land after this bound and cause a suppress on THIS attempt, same as before this fix. That residual is acceptable ONLY because `healIfStuck` (card b64b3726 Half 2) backstops the consequence regardless of which vector caused the suppression — if that backstop is ever removed, this bound needs re-deriving against a fuller sample, not just widened. If a future re-measurement shows the fast group is no longer the majority, THIS bound is the wrong one to keep — don't just halve it, re-derive it from a fresh distribution.

## Do not

- Do not just widen or halve `REASSERT_SETTLE_MAX_POLLS`/`REASSERT_SETTLE_POLL_MS` off a future re-measurement — re-derive the bound from the fresh distribution, the same way this one was sized.
- Do not treat this bound's residual-acceptance as safe on its own — it depends on `healIfStuck` (card b64b3726 Half 2) backstopping the consequence; if that backstop is ever removed, this bound needs re-deriving.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`REASSERT_SETTLE_POLL_MS`/`REASSERT_SETTLE_MAX_POLLS`'s top-of-const doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
