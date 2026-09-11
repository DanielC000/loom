# bc91e86c — a synchronous throw in the live-flip → spawn window can come from `createPty` itself, not only a pre-pty step

## Narrative

Card `bc91e86c` names the concrete specimen behind
[[6ca4155f-reconcile-a-live-flip-spawn-to-exited-on-any-synchronous-throw]]'s "or `createPty`" clause:
node-pty's own spawn can throw SYNCHRONOUSLY too, before any Live entry is ever registered — e.g. a
Windows `CreateProcess` `error code: 206` from an oversized command line. This is distinct from
[[fa1b77c1-widen-spawnworkers-try-to-cover-the-pre-pty-steps]]'s pre-pty statements (project-memory
retrieval/digest, codescape status): `createPty` runs INSIDE the existing try, not before it, so this
specimen is the reason the reconciling catch must cover `pty.spawn`/`createPty` itself, not only the steps
ahead of it.

Card `8b194419`'s own Code Review follow-up later measured that this specimen was, despite naming it,
still UNTESTED: all three of `6ca4155f`'s own tests injected only a PRE-pty throw, and for 6 live-flip
sites (`startAuditor`, `startWorkspaceAuditor`, `startSetup`, `startOperator`, `startRun`,
`recyclePlatformLead`) the try contains ONLY `pty.spawn`, so a `createPty`-throw specimen had zero test
coverage there before that follow-up closed the gap.

## Do not

- Do not treat "the try covers the pre-pty steps" (card `fa1b77c1`) as sufficient coverage for this
  specimen — a `createPty`/`pty.spawn` throw happens INSIDE the try, and needs its own test coverage
  (closed by card `8b194419`), not just the pre-pty widening.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`spawnWorker`'s catch, citing this card by
name for the `createPty` throw class, ~line 6292 as of this tranche's HEAD), corroborated by card
`8b194419`'s own body (Code Review finding [1], citing this card by name for the "real-world Windows
`error code: 206` class"). This card's own board entry could not be re-read directly this tranche
(`tasks_get bc91e86c` returned "task not found in this project" — likely purged/archived); every claim
above is sourced from the two citing sites, not reconstructed.
