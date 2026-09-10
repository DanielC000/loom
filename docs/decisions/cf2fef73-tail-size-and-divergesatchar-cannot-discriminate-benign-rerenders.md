# cf2fef73 — tail size and `divergesAtChar` cannot discriminate a benign re-render from a real splice

## Narrative

Card `cf2fef73` (owner-reported false LOSS alarm on benign whitespace re-rendering): the byte-wise
mismatch scan (`divergesAtChar`/tail-length reasoning in `deliverHook`'s `UserPromptSubmit` case) used
to carry two claims about how to read its output. Both were measured false against the real corpus and
corrected in place.

**Correction 1 — tail size does not discriminate.** The comment used to claim a trailing-whitespace/
normalization artifact diverges near the very END with TINY tails on both sides. MEASURED FALSE for the
actual benign case seen in production: an INTERIOR tab, echoed back space-expanded by the terminal,
desyncs the byte-wise scan AT the tab and never re-syncs — everything after it counts as mismatched, so
the tail is as large as any real splice's. Over the retained corpus, 355/368 mismatches (96.4%) had "both
tails large" by this shape — almost all of them this benign case, not real splices. TAIL SIZE CANNOT
DISCRIMINATE a benign whitespace re-render from a real splice; the whitespace-normalized comparison
(`normalizeForMismatchNotice`/`isBenignWhitespaceRerender`) is the actual discriminator that decides
whether the session-facing notice fires.

**Correction 2 — `divergesAtChar=0` does not mean "wholly unrelated".** The comment also used to claim
"wholly different strings diverge at `divergesAtChar=0`". Also not reliable in practice: the single most
common benign shape measured in the corpus — a stale, already-collapsed paste-placeholder frame (Claude
Code's own paste-collapse UI, e.g. `[Pasted text #N +M lines]`) PREPENDED onto an otherwise-correct
submission — diverges at `divergesAtChar=1`, not 0: both strings start with the same `[` byte before
splitting. The single most common benign shape in the corpus therefore presents with the MOST
ALARMING-LOOKING raw signature available. Do not read `divergesAtChar` alone as a reliable "wholly
unrelated content" signal either.

**The general shape of the bug:** the byte-wise comparison is exact, but the property it exists to
detect ("was the intended content preserved") is not a byte-exact one — a benign rendering or framing
transform changes the bytes without losing anything, and an exact byte comparison has no way to tell
that apart from a real loss. It reports every transformation as a corruption unless the transform is
explicitly named and checked for.

**The stale-placeholder-prefix suppression mechanism** (manager review, second population — MEASURED the
largest single benign class in the corpus) is a SEPARATE mechanism from `detectPastePlaceholderLengthLoss`
(cards `0f9268cc`/`eef4883c`, the bare-pasted-text-placeholder tripwire — "paste tripwire detection then
recovery") — this card does not touch that one; do not conflate the two when reading either site. Strip a
GLOBAL run of one-or-more leading placeholder tokens
— both measured forms, `[Pasted text #N +M lines]` (with a line count) and `[Pasted text #N]` (no line
count) STACK: a real specimen carried THREE concatenated, mixing both forms
(`[Pasted text #11][Pasted text #12 +38 lines][Pasted text #13 +40 lines]`, delta=71=17+27+27 exactly).
The strip is therefore global, not single-shot — a single-shot strip would leave later placeholders in
the remainder on a stacked run, failing the exact-match check below and firing the notice on a provably
benign case (fail-OPEN in exactly the dense-paste case where a false alarm costs the most). Suppress ONLY
when `reported` is EXACTLY the whole leading placeholder run plus `intended`, byte-for-byte after
stripping it — precise, non-heuristic, fails closed by construction (no band/threshold/tail arithmetic)
regardless of how many placeholders matched or which form(s). A placeholder run that instead REPLACED
real content (measured: both a `lenDelta=-579` specimen for form 1 and negative-delta specimens for form
2, `reported` SHORTER — a genuine loss) does not match this shape and keeps firing, unchanged.

Both suppression checks (`isBenignWhitespaceRerender`, `isStalePlaceholderPrefix`) only ever SUPPRESS the
session-facing `[loom:prompt-mismatch]` notice — never add one. The diagnostic logs
(`[prompt-mismatch]`/`[prompt-echo]`/`[composer-accumulation*]`) above them are UNCONDITIONAL on either
check, so the raw corpus is preserved regardless of what the session-facing notice decides.

## Do not

- Do not read `divergesAtChar`/tail size alone as evidence of a real splice vs. a benign re-render — both
  measured claims about how to do so from the raw scan output were false.
- Do not single-shot-strip the placeholder prefix — placeholders stack, and a single-shot strip fails
  closed in exactly the case (dense paste) where a false alarm costs the most.

## Source

Inline comments in `packages/daemon/src/pty/host.ts` (the `divergesAtChar` correction comments and
`isStalePlaceholderPrefix`'s own doc, in `deliverHook`'s `UserPromptSubmit` case), as of `main` `e0f71681`.
Extracted by card `54dc1362` (tranche 20 on `pty/host.ts`); wording condensed and reorganized from two
separate correction comments into one narrative, content preserved.
