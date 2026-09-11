# c22f6cb8 — the `footer-unchanged` give-up branch makes kickoff-delivery ordering best-effort, not structural

## Narrative

Card `0050a17e`'s kickoff-delivery gate (`markReady` gating the actual kickoff pty write on `logLandedMode`'s `onSettled` callback) makes the "footer-read/auto-heal settles before the kickoff write" ordering STRUCTURAL rather than incidental for 3 of `runCycleToMode`'s 4 terminal branches: `reached`/`press-cap` fire only once `awaitChange` has CONFIRMED the footer moved, so the last Shift+Tab is provably consumed; `pty-gone` is moot, since nothing will be pasted.

Card `c22f6cb8`: the `footer-unchanged` branch is the exception. It gives up after `RESUME_MODE_CHANGE_MAX_POLLS` polls with the just-written Shift+Tab still UNCONFIRMED, then still calls `onDone` — so on that branch the ordering is best-effort, not structural: a queued Shift+Tab can in principle still land mid-paste if the engine is stalled precisely across that give-up.

## Do not

- Do not treat `logLandedMode`'s `onSettled` gate as a guarantee that no auto-heal Shift+Tab can ever interleave with the kickoff write — on the `footer-unchanged` give-up branch specifically, the guarantee is best-effort, not structural, because the Shift+Tab that was just written is still unconfirmed when `onDone` fires.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`markReady`, the paragraph explaining why `logLandedMode`'s completion callback gates kickoff delivery), as of commit `aa936b4e3526d81eb06f8758539b19f33f2b4cf3` (this tranche's starting HEAD, `host.ts` tranche 48). Extracted by card `8a3d430f` (tranche 49 on `pty/host.ts`); condensed from the surrounding paragraph (which is itself card `0050a17e`'s content and stays inline at that site — `0050a17e` is shared with `packages/daemon/src/sessions/service.ts` and is anchor-only for this tranche).
