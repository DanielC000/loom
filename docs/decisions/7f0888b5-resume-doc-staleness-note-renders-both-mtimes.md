# 7f0888b5 — the resume-doc staleness note renders BOTH compared mtimes, never a bare verdict

## Narrative

Reported by another Loom project, the sibling of card `f17c5a76`'s size-warning fix (same class of bug, a different note): the resume-doc staleness note used to compare two mtimes and render NEITHER, handing the recipient a bare verdict ("your doc is stale") with no way to check it against an action they themselves took. This is worse than the size note's old defect — that one at least carried the raw measurement — because the recommended action here is a doc ROTATION (destructive-ish, irreversible-ish): the originating incident was a Platform Lead told to rotate a doc it had rotated 7 minutes earlier.

The fix: `now` (default `Date.now()`, injectable like `resumeDocSizeWarning`'s own param) stamps WHEN this comparison ran, distinct from send/delivery time; both compared mtimes are rendered as absolute ISO-8601 timestamps and labelled which is which, so the recipient can diff them directly against their own actions instead of trusting the derived verdict.

## Do not

- Do not render a staleness verdict without both compared timestamps — a bare "your doc is stale" gives the recipient no way to check it against an action they already took.
- Do not recommend a doc ROTATION off an unrendered comparison — a destructive-ish action needs the raw evidence behind it, not a verdict alone.

## Source

JSDoc comment above `composeResumeDocOperationalNotes` in `packages/daemon/src/sessions/platform-lead-prompt.ts`: originally lines 167-176, as of this tranche's HEAD. Introduced by commit `284c4fea85aae60984454cecd66e57d7d0eaa0f4` (`fix(sessions): stamp resume-doc-stale with the absolute mtimes it compares`). Relocated by card `36641df4` ("sessions prompt-composer files, tranche 1").

This card is the sibling of card `f17c5a76` (same class of bug in the resume-doc SIZE note, `sessions/resume-doc-notes.ts`) — see that card's own record for the sibling fix.
