# sha:79af3725 — a submitted paste is durable across `--resume`; only an UNSENT draft is genuinely lost

## Narrative

Source: commit `79af3725`, no board card. `DRAFT_LOSS_NOTE` is a CONDITIONAL companion to `RESUME_NUDGE_TAIL`, appended only for a session whose raw-terminal composer held an unsent human draft at restart-capture time (`RestartResumeEntry.hadUnsentDraft`, set from `PtyHost.isComposerDirty` in `liveFleetResumeSet`). Unlike `RESUME_NUDGE_TAIL`'s two facts (always true of every resume), this one is true only for THAT session, so it is not folded into the shared tail.

Real-engine probes (referenced informally in-source as "pasted-text-attachment-survives-restart"; no board card id — see `16c50cdd` for the later task that re-validated the same claim) confirmed a SUBMITTED turn's pasted text is fully durable: the engine resolves it to full content before persisting, and `--resume` reconstructs it correctly every time. The ONE genuine gap is a draft that was pasted or typed but never submitted (Enter not yet pressed) at the moment of the restart: it lives only in the now-dead pty's (and engine's) in-memory composer, commonly collapsed on-screen to a "[Pasted text #N]" placeholder, and is not part of the transcript at all — so it is NOT replayed and NOT recoverable. Without this note that loss is entirely silent (no dangling reference even appears); `DRAFT_LOSS_NOTE` makes it explicit instead of leaving the resumed agent to either not notice or guess at content it never actually saw.

## Do not

- Do not conflate a genuinely-lost unsent draft with the (durable) case of a submitted paste rendering as a placeholder — see `94721f95` for a related, separate durability claim about the SUBMITTED case that later needed correcting.
- Do not guess at what an unsent draft said if it comes up later — tell whoever is asking that it was lost in the restart and ask them to resend it (this is the note's own instruction to the resumed agent).

## Source

JSDoc comment above `DRAFT_LOSS_NOTE` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 79-90 and 99-106 as of this tranche's HEAD (tranche 1). Introduced by commit `79af3725` ("fix(daemon): a pasted-text attachment does not render into a resumed session after a daemon restart"); no board card cites this decision anywhere in the tree.
