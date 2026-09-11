# f5cdceac — `submit()` delivers a turn as a BRACKETED PASTE + delayed Enter, never raw fire-and-forget lines

## Narrative

Worker reports were silently stranding. A report sent to a busy/stuck manager returned `delivered:false` and queued to an in-memory buffer that only drained on the next Stop hook — which a stuck-busy session never fires. A report sent to an *idle* manager whose composer held the human's half-typed text got concatenated into one garbled message, and could fail to submit outright (sitting un-entered in the box).

The fix: `submit()` writes the text as a BRACKETED PASTE (start marker, the chunked text, end marker) then Enter a beat later, so claude treats even multi-line content as one paste unit and the trailing Enter reliably submits — "no more reports stuck un-submitted in the box." The markers are written on their own (never concatenated into the same write as a text chunk) specifically so chunking can't split a marker sequence — a split marker would stop claude from recognising the paste as one unit.

## Do not

- Do not revert to writing lines directly to the pty without the bracket markers — that is exactly the "un-entered in the box" / garbled-concatenation failure mode this commit fixed.
- Do not let a chunk write share a buffer with a marker write — a split marker sequence defeats the "one paste unit" property the whole mechanism depends on.

## Source

Inline comment (JSDoc) in `packages/daemon/src/pty/host.ts`, at the top of `submit()`'s own method doc, lines 7979-7982 as of this tranche's starting `main` HEAD (`f18fdfcb`) — the opening Class-C contract line ("Write text as a turn and arm busy...") stays inline immediately above the `@decision` anchor. No board card cites this decision anywhere in the file; keyed by the introducing commit per this project's `sha:` anchor grammar. Extracted by tranche 33 (card `7ad5b460`).

Introducing commit: `f5cdceacf67c5af3d2166e7ab5aa2d0b4ba26f7c` — `fix(daemon): reliable worker-report delivery — bracketed-paste submit, stuck-busy self-heal, visible queue` (2026-06-02). That same commit also introduced `enqueueStdin`'s human-typing-grace defer and the stuck-busy self-heal reconcile tick — this record covers only the bracketed-paste submit mechanism narrated at this specific site, not the whole commit.
