# 347d37d2 — pointerAnchors' window widened from a fixed 3-line cap to the whole paragraph

## Narrative

`findPointerAnchors` (`packages/daemon/assets/comment-anchor-lint.mjs`) decides whether an anchor
SITE's own text points at its out-of-band record instead of stating the rule inline. Its
phrase-scan window originally used a FIXED `GUARD_MAX_LINES` (3) lines — the anchor's own line plus
two continuation lines. That was too narrow: a real, genuine, single, uninterrupted paragraph can
carry a pointer tail ("See docs/decisions/…") that lands on its 4th or 5th line, past that cap — a
false negative on exactly the shape this check exists to catch.

**Confirmed live on main before the fix:** two real specimens in this repo's own source — anchors
`545ef479` and `90550a97`, both in `codescape/supervisor.ts` — each a single uninterrupted
paragraph whose "See docs/decisions/…" tail sat on line 5-6 of its own paragraph, past the old
3-line cap. Measured **0** `pointerAnchors` hits in that file before this fix, despite both
specimens being genuine pointer-tailed anchors.

**The fix:** the window is now the anchor's own CONTIGUOUS PARAGRAPH, bounded by whichever comes
first — the enclosing comment block's own end, the next `@decision` SITE in the same block, a
blank JSDoc line (paragraph break), or a line starting a new JSDoc tag (`@param`, etc). This
intentionally trades away one narrow case: when SEVERAL anchor ids share ONE combined tail at the
very end of a block (e.g. "See docs/decisions/{id1,id2,id3}-*.md"), only the LAST anchor in that
group still gets flagged — the next-anchor boundary cuts off the earlier ones before they reach the
shared tail. Measured specimen: `packages/daemon/src/pty/host.ts:2941-2944`, ids `a8f8a8f2` /
`00bd3b4a` / `7772176d` — only `7772176d` flagged post-fix. Accepted trade: avoids the larger risk
of one anchor's window swallowing a genuinely distinct SUBSEQUENT anchor's own paragraph (the
`supervisor.ts` shape this card was filed over).

**Corpus delta, MEASURED via `node packages/daemon/assets/comment-anchor-lint.mjs .` (base
`735c7c0b` before the fix, `e7c854c4` after):** `pointerAnchors.count` 473 -> 683 (net +210: +216
newly caught false negatives, -6 corrected false positives that the old fixed window had swept past
a real paragraph boundary into unrelated prose). This REFUTES a "tens, not hundreds" hypothesis
carried in this card's own kickoff — the delta is genuinely large because many extraction-tranche
anchors across the repo follow the same "short rule + pointer tail on a later line" style the old
3-line cap was blind to. Top files by post-fix `pointerAnchors` count at the time: `sessions/
service.ts` 217, `pty/host.ts` 85, `git/worktrees.ts` 79, `shared/types.ts` 37, `companion/
capabilities.ts` 17, `deploy-staleness.ts` 16, `vault/versioner.ts` 16, `orchestration/
pending-ops.ts` 15, `codescape/supervisor.ts` 14, `gateway/server.ts` 12.

**Any of the counts above should be re-measured before being relied on** — other lanes keep fixing
individual pointer-anchor sites and the corpus keeps changing shape (comments get extracted,
anchors get fixed) independent of this window-mechanism fix.

## Do not

- Do not read the whole-block boundary as "the whole block indiscriminately" — a pointer phrase
  sitting in an UNRELATED later paragraph of the same block, separated from the anchor by one of
  the four boundaries above, must never be miscounted as part of THIS anchor's own text.
- Do not "fix" the several-anchors-share-one-tail trade above by widening the window past the
  next-anchor boundary — that reopens the larger swallowing risk this fix exists to avoid.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs` — `findPointerAnchors` (card `347d37d2`,
widening the window first shipped by card `a862e8f0`).
