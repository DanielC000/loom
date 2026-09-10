# b68d1f5b — `detectPastePlaceholderLengthLoss`'s origin, window sizing, and calibration

## Narrative

Card b68d1f5b DoD-1 added the "compare the placeholder's stated line count against the delivered body"
check (adopted from a peer project manager's suggestion). Unlike `detectBarePastePlaceholderTripwire`, this
check works from the RECORDED/delivered side alone: a `[Pasted text #N +M lines]` token surviving into the
transcript's recorded turn text always means those M lines never reached the engine (a placeholder is
never accompanied by its own expansion — if the paste had gone through, the placeholder wouldn't be there
at all). That is what makes it work "regardless of who wrote the text" (card's own framing).

**Window sizing.** `PASTE_LOSS_EXPLAIN_WINDOW` (64) is how many of the most-recent Loom-authored
submissions `Live.recentWrittenLineCounts` retains, per session, for `findExplainingWrittenGen`'s lookup
(see [[abeac33a-gen-discriminator-explains-current-and-older-gen-matches]] for what a match means). It is
deliberately its OWN constant, independent of card c2c750a9's `COMPOSER_ACCUM_WINDOW` (8, see
[[c2c750a9-detectcomposeraccumulation-two-stage-trigger-and-confirm]]) — that ring is sized for a DIFFERENT
job (its detector needs full TEXT to concatenate-and-hash a contiguous span; this one only needs an
unordered "was there EVER a write with this line count" membership test over small integers). Picked 8x
c2c750a9's own window — wide enough to meaningfully outlast the 8-entry blind spot the `abeac33a` specimen's
15-minute gap could fall into (its own worked stale-token specimen was a FIFTEEN-MINUTE gap between the
explaining write and its re-render, and whether 8 intervening submissions fit that gap is a property of
session traffic, not of this check's logic). Reusing card c2c750a9's own window would have inherited a bound picked for a
different job; because this history stores only a `gen` plus two small integers per entry (see
`WrittenLineCountEntry`) rather than full text, it costs far less per entry than that ring, which is what
justifies giving it a MUCH longer horizon without growing `Live`'s footprint the way widening
`COMPOSER_ACCUM_WINDOW` itself would have (that ring is card c2c750a9's own field, sized for its own
purpose — not this check's to grow as a side effect). This is NOT a
claim the window is provably sufficient for every real gap: silence is guaranteed ONLY for a placeholder
whose explaining write is still inside the window — beyond it, an explained token reads as unexplained and
the check WILL fire on a correct send, exactly the failure mode `abeac33a`'s own hard constraint names.

**Calibration.** `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE` (130) is calibrated from five specimens,
128.4–132.3 B/line, all kickoffs delivered intact. It estimates lost BYTES from the placeholder's stated
line count for the ALERT MESSAGE ONLY — it is NOT part of the detection gate (presence of an unexplained
placeholder is itself the whole signal; the byte estimate just makes the alert legible). Deliberately
calibrated against PAYLOAD NEWLINES, never wrapped terminal display rows (a fixed 120-column pty only ever
ADDS rows via wrapping, so a row-count reading would undercount).

## Do not

- Do not reuse card c2c750a9's `COMPOSER_ACCUM_WINDOW`/`Live.recentWrittenTurns` for this check's window —
  it's sized for a different job (full-text concatenation) and would inherit a bound picked for that job,
  not this one.
- Do not treat `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE` as part of the detection gate — it only makes the
  alert message legible; the unexplained placeholder is the whole signal.
- Do not calibrate the bytes-per-line estimate against wrapped terminal display rows — the fixed
  120-column pty only ever adds rows via wrapping, which would undercount.

## Source

Inline comment in `packages/daemon/src/orchestration/paste-tripwire.ts`
(`detectPastePlaceholderLengthLoss`'s function doc, `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE`'s doc, and
`PASTE_LOSS_EXPLAIN_WINDOW`'s doc). Relocated by card 26afc9eb (tranche 1 on
`orchestration/paste-tripwire.ts`); no wording changed beyond compressing wrapped source lines into flowing
paragraphs and stripping `/** */`/`*` comment markers.
