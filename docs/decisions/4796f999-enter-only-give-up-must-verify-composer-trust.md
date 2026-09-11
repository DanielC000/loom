# 4796f999 — an Enter-only give-up redelivery must verify what the composer holds, not just assume it

## Narrative

Card 4796f999: `b9b8f8db`'s assumption ("the composer still holds THIS message's own physical write") has no way to verify itself, and is invalidated the instant an INTERVENING generation's own clear-then-repaste fails to actually erase the terminal — CONFIRMED end-to-end from two real specimens (`docs/investigations/f779b3da-giveup-redrain-race/findings.md`): one a silent FUSION of two messages' content (`11349 = 9709 + 1640` — an unresolved earlier generation's stray, never actually cleared, concatenated with a later generation's fresh paste), one a silently and permanently LOST message (a 42042-char notice erased by a working intervening clear, its own content now unrecoverable). Neither `b9b8f8db`'s own code nor `3ce3fa39`'s ever checked the OTHER's precondition.

**The fix** reuses `composerDirtyLenBelieved` (card `c148f118`) — it already tracked exactly the signal needed and was simply never consulted here: `composerDirtyLenBelieved === composerDirtyLen` means no OTHER generation's clear is currently unresolved, i.e. nothing has touched the composer since THIS message's own last write — Enter-only is genuinely safe. A gap between them means an intervening clear's outcome is unverified, and this redelivery must NOT trust whatever is actually sitting in the composer — it falls through to the full clear+repaste branch instead, which re-pastes THIS redelivery's own real body: `text` there is `joinSubmittedText(drained, …)` over the SAME `drained` array passed through as `origin`, so it always CONTAINS this redelivery's own body (not necessarily EXCLUSIVELY it — `drainPending`'s run-collection can splice several entries into one `drained`/`origin`; see `fa27d262`'s record for the companion guard that keeps a mixed batch from silently dropping a fresh member's share).

Per this card's own DoD: a correct fallback matters more than avoiding the re-paste — an unnecessary backspace+repaste is cheap; silently fusing or losing another message's content is not. That cost asymmetry is why the gap falls through to the expensive-but-safe branch rather than staying on Enter-only whenever the check can't prove safety.

**Bounded, not closed, by card `a6c1d413`'s own gap (now fixed):** this check used to be exposed to `composerDirtyLenBelieved`/`composerDirtyLen` being reset TOGETHER by `composerDirtyMarkedForGen`'s single-scalar confirm gate, which could zero an EARLIER, still-genuinely-unresolved contribution when a LATER generation alone confirmed — making the gap this check looks for read "nothing to doubt" when there still was some. `clearComposerDirtyOnConfirm` now tracks per-generation contributions (`composerDirtyMarkedGens`, card `a6c1d413`) and only ever resolves an EARLIER generation's mark when the confirming generation's own confirmation is DECISIVE (content-matched); a content-blind (FIFO-position) confirmation now resolves only its own generation's contribution, never an earlier one's. This check's `composerBelievedTrustworthy` read is therefore no longer exposed to that false-"nothing to doubt" reading — see `a6c1d413`'s own record for the general mechanism this depends on.

## `flushComposer`/`worker_flush` is a deliberate exception, not an oversight

`flushComposer` (`worker_flush`, card `3e76ecad`) DELIBERATELY does NOT take this same `composerDirtyLenBelieved === composerDirtyLen` trust check before its own bare Enter. This is a human/manager-initiated "press Enter and see what's actually there" affordance, not an automated redelivery guessing at what the composer holds — submitting whatever is genuinely sitting there IS the point of an operator flush, and gating it on the same trust signal would silently swap the requested action for a repaste nobody asked for. `flushComposer` still reuses this card's own verify-and-retry LADDER (`awaitReassertSettle`/`fireEnterAndVerify`) — only the trust gate ahead of it is skipped; it stays a bare Enter-only reassert regardless of composer trust.

## Do not

- Do not take the Enter-only branch based on `isGiveUpRedelivery` alone — the `composerDirtyLenBelieved === composerDirtyLen` check is load-bearing. Removing it reopens the fusion/loss defect this card fixed.
- Do not add this trust check to `flushComposer`/`worker_flush` — that call is a deliberate exception (see above), not a gap to close.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`, the composer clear-prefix / give-up-redelivery block), lines 9891-9925, as of commit `dc53c7111807e103baf99544d3890df80e9a1c92` (this tranche's starting HEAD). Extracted by card `dfde8c66` (tranche 9). Full mechanism trace: `docs/investigations/f779b3da-giveup-redrain-race/findings.md`. Regression test: `packages/daemon/test/pty-enter-only-verifies-composer-trust.mjs`.

The exception section above is a second site for the same card, extracted from `flushComposer`'s own method JSDoc in `packages/daemon/src/pty/host.ts`, condensed, not verbatim, as of main `df6d1c73` (this tranche's starting HEAD). Extracted by card `218e51fe` (tranche 39 on `pty/host.ts`).
