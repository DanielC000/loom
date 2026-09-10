# 7f47991e — a give-up redelivery-confirmed signal attests an OUTCOME (a turn ran), never a CAUSE

## Narrative

The `[loom:redelivery-confirmed]` notice `handleGiveUpConfirmed` (`sessions/service.ts`) sends is built entirely from a CONTENT-MATCH signal: `purgeConfirmedGiveUpRequeue` (`pty/host.ts`) matches `latencyMs` and the "CONFIRMED" verdict against `hook.prompt` — the text Claude Code's own `UserPromptSubmit` hook reports it received. That hook fires identically for EVERY turn regardless of what pressed Enter: a Loom-issued `submit()`, the engine resubmitting a still-composed write on its own, or a human manually pressing Enter on a stuck composer. It proves WHAT text reached the engine and WHEN — never WHO or WHAT triggered the keystroke that submitted it.

The one mechanism in this file that DOES attribute a turn to a human (`Live.pendingRawOwnerSubmit`, populated only by `writeStdin`'s raw-terminal relay) is not wired to this signal, and would not help even if it were: it only captures text a human typed THROUGH that raw channel and accumulated in `Live.rawDraftText`. A parked message was written by Loom's own `ptyWrite`, not through `writeStdin`, so `rawDraftText` stays empty; a human pressing a bare Enter on that already-composed text produces `nextRawDraftState`'s `submitted:null` (its `text.length > 0` guard fails), so `pendingRawOwnerSubmit` never fires for this scenario either. There is no code path, wired or unwired, that lets this notice tell a genuine engine self-heal apart from a human keystroke — the notice text has to say so, not imply "Loom's retry landed."

A third candidate, surfaced by a manager's own in-vivo report during this card's implementation (worker `c500e7e3`'s stuck-then-recovered turn): the RECIPIENT of this notice is the very sender who may, in the meantime, have ALSO sent a fresh `worker_message`/`worker_redirect` to the same session — itself a Loom-driven `submit()`, indistinguishable from an automatic give-up retry by this same content-match signal. That manager could only rule its own action out because `worker_message` happened to return `delivered:false, reason:"held"` with a `busyForMs` that proved the turn had already started before the message was even sent — a trace that will NOT exist in general. So the notice's "cause unknown" has to include the sender's own later action, not only "Loom automatically" vs "a human" — a sender who just re-drove the session is the one reader most tempted to credit their own intervention for a turn their intervention may not have caused.

## Do not

- Do not word this notice as "Loom's retry landed" or otherwise assert a cause — the signal proves a turn ran with matching content, never who or what triggered it.
- Do not assume a sender's own later `worker_message`/`worker_redirect` is ruled out by default — it produces the identical content-match signal and is the cause the sender is least likely to suspect of themselves.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleGiveUpConfirmed`'s method doc), as of main `a3f78400`. Extracted by card `3376af3e` (tranche 24).
