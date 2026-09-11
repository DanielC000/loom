# f17c5a76 — the resume-doc size note stamps a `measured-at` time, distinct from delivery time

## Narrative

Reported by another Loom project: the `[loom:resume-doc-size]` note used to carry only the byte measurement itself, with no timestamp of when that measurement was taken. A recipient could not tell a fresh reading from one that had gone stale sitting in a busy-gated/coalesced delivery queue or a paste-recovery re-injection — both of which can widen the gap between "when this was stat'd" and "when you're actually reading it" arbitrarily. `now` (default `Date.now()`, injectable for deterministic tests — mirrors `ResumeDocWatcher.tick`'s own `now` param) is stamped into the note as `measured-at`, distinct from whatever send/delivery timestamp the surrounding transport may show.

Deliberately NOT suppressed when stale — a silent drop is its own silent decision that loses the signal entirely. Instead the note tells the recipient how to tell staleness apart from a fresh reading and how to recover cheaply (re-check the doc's own current size) rather than trusting the number blindly.

Card `7f0888b5` is the sibling fix, for the SAME class of bug in the Platform Lead's resume-doc STALENESS note (`sessions/platform-lead-prompt.ts`'s `composeResumeDocOperationalNotes`): that note used to compare two mtimes and render NEITHER, handing the recipient a bare verdict ("your doc is stale") with no way to check it against an action they themselves took — worse there because the recommended action is a doc ROTATION (destructive-ish, irreversible-ish), and the originating incident was a Lead told to rotate a doc it had rotated 7 minutes earlier. See that card's own record for its fix.

## Do not

- Do not emit a size/staleness measurement with no timestamp of when it was taken — a recipient in a coalesced/re-injected delivery queue cannot otherwise tell a fresh reading from a stale one.
- Do not suppress a stale measurement instead of stamping it — a silent drop loses the signal entirely; tell the recipient how to check freshness instead.

## Source

JSDoc comment above `resumeDocSizeWarning` in `packages/daemon/src/sessions/resume-doc-notes.ts`: originally lines 63-72, as of this tranche's HEAD. Introduced by commit `347a4daa4abe82bd531fffcae6604fae1d8dd797` (`fix(sessions): stamp the resume-doc-size notice with a measured-at time`). Relocated by card `36641df4` ("sessions prompt-composer files, tranche 1").

This card is ALSO cited in `packages/daemon/src/sessions/platform-lead-prompt.ts` (`composeResumeDocOperationalNotes`'s own doc comment, as the sibling of card `7f0888b5`'s staleness-note fix) — see that card's own record for the sibling fix's full narrative.
