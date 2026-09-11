# fa1b77c1 — `spawnWorker`'s try starts at the live-flip, not at `pty.spawn`

## Narrative

Before this card, `spawnWorker`'s row was flipped `processState:"live"`, then several synchronous,
unguarded statements ran — project-memory retrieval/digest (`retrieveProjectMemoryForKickoff`/
`stampProjectMemoryDigest`) and codescape status (`resolveCodescapeInjectionStatus`) — before the existing
try/catch around `pty.spawn` itself began. A throw from any of those PRE-pty statements left the row
phantom-live: counted toward the manager's cap (safe direction, an over-count) but with no process behind
it, occupying a slot until something noticed and reconciled it by hand (`worker_stop` already reconciled a
stale live row with no pty, card `dde0ce24`, but only if a manager thought to call it).

The fix widens the try to start right at the live-flip, so the SAME catch that already handled a
`pty.spawn`/`createPty` throw now also covers these pre-pty steps — see
[[6ca4155f-reconcile-a-live-flip-spawn-to-exited-on-any-synchronous-throw]] for the full reconciliation
mechanism this widened try feeds into.

`releaseCapSlotClaim()` (card `16637a9e`) stays OUTSIDE the widened try, unmoved — widening the try below
it does not touch its own synchronous, no-`await`-before-it placement right after the live flip.

## Do not

- Do not move `releaseCapSlotClaim()` inside the widened try — its placement right after the live flip,
  with no `await` before it, is a separate, unrelated invariant (card `16637a9e`) that this widening must
  not disturb.
- Do not assume the pre-pty steps (project-memory retrieval/digest, codescape status) are safe to leave
  unguarded because they "just read state" — any synchronous throw among them phantom-lives the row
  exactly like a `pty.spawn` throw does.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`spawnWorker`, the try-block boundary
comment just after `releaseCapSlotClaim()`, ~line 6229 as of this tranche's HEAD). Board card `fa1b77c1`
(merged `132aab4`, verification: content).
