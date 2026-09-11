# 3ce3fa39 — the composer clear-prefix is DEFERRED to the next submit(), never attempted at give-up time

## Narrative

Card 3ce3fa39 (the frame-splice bug): `composerDirtyLen` tracks a possibly-stranded amount an earlier submit's give-up/heal-if-stuck left unresolved. The clear-prefix is deliberately deferred to the NEXT submit() rather than attempted at give-up time itself: give-up time's own trigger condition is "the engine wasn't reading," so nothing at that moment can corroborate whether a clear would actually land. A fresh submit is the one point that gets real corroboration for free — if that write's own Enter goes on to confirm, it proves the engine read the entire ordered byte stream, clear-prefix included, in order.

When the deferred clear does fire (submit()'s `composerDirtyLen > 0 && composerLen === 0` branch), it force-closes the paste bracket first — a fresh zero-length START+END pair, the same bytes `sendEnterAndVerify`'s own retry-reassert uses (card 97558183: idle → true no-op, still-open → closes with only a small stray tail) — so the backspace burst that follows can never be swallowed as literal paste content from an earlier write whose own closing END marker may have been the thing that dropped.

`composerDirtyLen` is deliberately NOT reset to 0 by this deferred clear (only a genuine confirmation resets it — see the field's own doc). If this write also gives up unconfirmed, the give-up branch must keep compounding on top of whatever was already unresolved, not overwrite it — that compounding is exactly what an earlier specimen's doubled/singled residue measured.

## Do not

- Do not attempt the clear-prefix while `composerLen > 0` — that gate exists for the SAME reason every other clear in this file is (card e1829591): never risk erasing a real human draft on the raw terminal. If a human is mid-draft, the defensive clear is skipped and the (already-rare) historical stray-concatenation risk applies instead, unchanged.
- Do not reset `composerDirtyLen` at give-up time, or on an unconfirmed deferred clear — resetting early would silently discard a still-genuinely-unresolved earlier contribution the next redelivery cycle needs to keep compounding on top of.

## The `UserPromptSubmit` hook's GATED reset of `composerDirtyLen`

A second site, in the `UserPromptSubmit` case of `deliverHook`: the reset (`composerDirtyLen = 0`, etc.) fires ONLY when this hook lands while `live.submitGeneration` still equals the generation that actually issued the clear-prefix (tracked via `composerDirtyLenClearedByGen`, see `a6c1d413`'s record for the per-generation map this gate feeds into). An ungated reset here would be WRONG: a hook belonging to unrelated engine activity (no `submit()` of ours in flight) can still land and flip `enterConfirmed` true — first-hand confirmed in production — and must NOT be read as proof our clear-prefix (which may not even have been attempted yet) landed.

### Do not (2)

- Do not reset `composerDirtyLen` at `UserPromptSubmit` without checking `composerDirtyLenClearedByGen === live.submitGeneration` first — an unrelated hook can fire and flip `enterConfirmed` without proving this generation's clear-prefix actually landed.

## Why not clear at the GIVE-UP RECOVERY callback specifically

A third site applies the same deferred-clear rule at `awaitGiveUpConfirmSettle`'s `confirmed:false` callback (the branch `sendEnterAndVerify` falls through to when no confirming hook settles the give-up). Reaching that callback means no confirming hook ever arrived — i.e. the engine wasn't reading — which is exactly the condition under which a raw backspace burst is LEAST likely to be safely interpreted. First-hand confirmed: two specimens' abandoned text survived a backspace-clear attempted at this exact point fully intact, only to resurface — once doubled — glued onto a much later, unrelated submit. This is a sharper instance of the general deferred-clear rationale above (give-up time itself can't corroborate a clear would land), not a separate decision.

## Do not (3)

- Do not attempt the clear at this GIVE-UP RECOVERY callback either — the same "give-up time can't corroborate a clear will land" rule applies, and it is measurably worse here: no confirming hook arriving at all is the least-corroborated case of the three sites this record covers.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`, the composer clear-prefix / give-up-redelivery block), lines 9808-9825, as of commit `dc53c7111807e103baf99544d3890df80e9a1c92` (this tranche's starting HEAD). Extracted by card `dfde8c66` (tranche 9). This record covers only the deferred-clear-timing design at this specific call site — 3ce3fa39's own root-cause question (which of two candidate mechanisms makes a clear-prefix's success unverifiable) remains OPEN; see `docs/spikes/frame-splice-3ce3fa39-*.md` and `2960c3bf`'s record. 3ce3fa39 is cited at many other sites in this file (`git grep -n "3ce3fa39" -- packages/daemon/src/pty/host.ts`); this record does not attempt to cover all of them.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `UserPromptSubmit` case in `deliverHook`), as of `main` `0cac46b89a9d2ad236117c355fb93d43f4f0f03f` (this tranche's starting HEAD). Extracted by card `7f448888` (tranche 19 on `pty/host.ts`).

## Source (3)

Inline comment in `packages/daemon/src/pty/host.ts` (`awaitGiveUpConfirmSettle`'s `confirmed:false` callback, the GIVE-UP RECOVERY branch), lines 8450-8459, as of `main` `5fa1465eccf00042d4946cf05ed5e2b775013859` (this tranche's starting HEAD). Condensed, not verbatim. Not shared with `packages/daemon/src/sessions/service.ts`. Extracted by tranche 38 (card `639cf9ae`).
