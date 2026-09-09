# c23e2869 — the wrapper-stripped-current fusion candidate, and why its empty-string guard must stay

## Narrative

Card c23e2869 — d005f55b's own Candidate #3 ("a Loom redelivery wrapper"), arithmetically confirmed on a real specimen (session `daf64e68`, gen=10): `9,709 + 1,640 = 11,349` (recognized entry's own length plus the current write's stripped length equals `reported`'s length) and, independently, `1,680 − 40 = 1,640` (the current write's own intended length minus the fixed 40-char redelivery-tag length). Both exact.

`detectPossibleDuplicateWrapperDeficit` only tests whether `reported` equals the CURRENT generation's own intended text with its wrapper stripped, IN FULL — it cannot confirm a specimen where `reported` is that PLUS an EARLIER generation's own recorded WRITTEN text fused onto it, the shape this card measured: `reported` matched an entry in `window` as a leading/trailing SUBSTRING (what `findRecognizedSubstring` already recognizes), with the REMAINDER left unaccounted for — even though that remainder is itself exactly explainable as the current write's own wrapper-stripped text.

Tries EACH window entry (most-recent-first, mirroring `findRecognizedSubstring`'s own precedent) in BOTH concatenation orders — `[entry][strippedCurrent]` and `[strippedCurrent][entry]` — since either can legitimately sit first depending on when the redelivered wrapper was drained relative to the earlier generation's own content. EXACT-EQUALITY, not sum+hash: a literal `===` comparison is strictly stronger than a 32-bit hash (no collision is possible) — this is the exact-match discipline this card's own DoD-1 requires preserved, never loosened (d005f55b's standing bound).

Returns `null` immediately if the current write carries no recognizable wrapper to strip — an unwrapped current write can never satisfy this candidate, so it is a no-op on every ordinary (non-redelivered) turn, same posture as `detectPossibleDuplicateWrapperDeficit`.

Code Review (manager, card c23e2869): ALSO returns `null` when the stripped current write is EMPTY — a bare tag with no body (`currentIntendedText` is exactly the 40-char tag and nothing else). Without this, `strippedCurrent === ""` and the loop degenerates: the length check becomes `entry.text.length === reported.length` and `reported === entry.text + ""` collapses to `reported === entry.text` — the PLAIN `replayedEntry` whole-string-match condition — so this function would fire "NOT A LOSS, fused with a zero-char stripped write" for what is actually an ordinary unresolved replay, silently disarming its own follow-up loss timer (`isRecognizedReplayAwaitingResolution` guards against `confirmedWrapperAwareFusion` alongside its siblings). `entry.text.length === 0` protects the WINDOW side of this same degeneracy; nothing protected the CURRENT side until this line — the asymmetry was the whole bug. A bare-tag-only write looks impossible today; that is exactly why this guard must stay even though it looks like it protects nothing.

## Do not

- Do not remove the `strippedCurrent.length === 0` early return, even though a bare-tag-only write looks impossible today — without it the loop degenerates to the plain whole-string-match condition and silently disarms the follow-up loss timer (the asymmetric bug this guard fixed).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`detectRecognizedFusionWithWrapperStrippedCurrent`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`) — the empty-string guard clause stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
