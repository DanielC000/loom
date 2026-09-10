# sha:c433346f — a Stop/StopFailure is itself proof the outstanding submit()'s Enter registered

## Narrative

`deliverHook`'s `Stop`/`StopFailure` case sets `live.enterConfirmed = true` unconditionally, before
neutralizing any still-pending verify-retry and before the M2 synchronous window (busy-gate drain
ordering). The reasoning: a `Stop`/`StopFailure` hook can only fire for a turn that actually ran — the
engine does not emit either hook for a turn that never started — so its mere arrival is proof the
outstanding `submit()`'s Enter keystroke registered, even on the rare path where `UserPromptSubmit`'s own
hook was itself lost (the engine can drop that hook without dropping the turn it announces). This lets
the Stop-hook chokepoint neutralize a still-pending verify-retry unconditionally, rather than needing its
own separate confirmation signal.

## Do not

- Do not gate this `enterConfirmed = true` on having previously seen a `UserPromptSubmit` hook for the
  same turn — that hook can be lost while the turn still ran to completion, and gating on it would leave
  `enterConfirmed` stuck false for a turn that genuinely did register.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `Stop`/`StopFailure` case, immediately
before `live.enterConfirmed = true`), as of commit `c433346f90a90b66fb4f0791647410024d470035` (this
tranche's starting HEAD) — no board card cites this reasoning anywhere in the file or its introducing
commit, so it is keyed by that commit's sha per the extraction program's `sha:` grammar. Extracted by card
`6ba43dfa` (tranche 23 on `pty/host.ts`); no wording changed beyond compressing wrapped source lines into a
flowing paragraph and stripping `//` comment markers.
