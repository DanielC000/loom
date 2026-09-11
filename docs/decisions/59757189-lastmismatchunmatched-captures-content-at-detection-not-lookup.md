# 59757189 — `lastMismatchUnmatched` captures content AT DETECTION time, never a later lookup

## Narrative

Card `59757189` DoD-1/3: `Live.lastMismatchUnmatched` is the UNMATCHABLE counterpart to `lastMismatchReplay`/`lastMismatchFusion` — set the instant a mismatch matches NONE of the recognized/confirmed shapes (not a single-entry replay, not a confirmed fusion, not a diverged-prior fusion, not a wrapper-deficit or ANSI-strip benign shape) — the exact population card `3ff61275` left unaddressed (that card shipped only DoD-7's WHICH-payload identity floor, never the content itself).

CAPTURED AT THE MOMENT OF DETECTION, directly from `intended` (the local in the same synchronous block) — deliberately NOT a later lookup into `recentWrittenTurns` (a BOUNDED, oldest-first window, `COMPOSER_ACCUM_WINDOW`=8, that will have rotated past this generation by the time any reader asks — the reporter's own correction on the predecessor card: "the content was in hand at detection time and discarded milliseconds later"). Stored IN FULL, no head-bounding — mirrors `recentWrittenTurns`'s own existing precedent of retaining full per-generation text with no length cap, rather than inventing an unmotivated new size bound here.

**DoD-3 (decidability):** `null` (the field's own type) combined with `getLastMismatchUnmatched`'s own `undefined` for an unknown/not-live session are the ONLY "not captured" states. An unmatchable mismatch, once it fires, ALWAYS populates a real object here — so a reader can never confuse "captured, here it is" (a non-null object, even one whose `intendedText` happens to be the empty string) with "nothing was ever captured" (`null`/`undefined`). Never cleared once set; overwritten — not accumulated — by a later unmatchable occurrence, so this always reflects the MOST RECENT one.

## Do not

- Do not recover this field's content via a later lookup into `recentWrittenTurns` — that ring is bounded and will have rotated past the generation by the time any reader asks. Capture directly from `intended` at detection time.
- Do not let an empty-string `intendedText` read as "nothing captured" — only `null`/`undefined` means that; a real object with an empty string is still a captured occurrence.

## `getLastMismatchUnmatched`'s own site (`pty/host.ts`) — a deliberate pull-only surface (DoD-2)

This is a DELIBERATE pull-only surface — nothing in this codebase currently pushes its content anywhere (a parent/manager delivery path is a separate, still-undecided question — see card `59757189`'s own DoD-2 note); reading it never has side effects.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `Live.lastMismatchUnmatched` field doc), as of `main` `d8b3076b`. Extracted by card `b19e70d3` (tranche 10 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `//` markers. The `getLastMismatchUnmatched`'s own site section above is a second site, same card: `getLastMismatchUnmatched`'s own doc, extracted by tranche 54.
