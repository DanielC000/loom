# 5683c2e3 — `stop()`'s first graceful write guards on `killed`; never hoisted, never spread to the hard branch's `kill()`

## Narrative

Card `5683c2e3`: `stop()`'s own first graceful write (`this.ptyWrite(sessionId, live, "\x03", "stop-ctrl-c")`, the double-Ctrl-C that exits an idle claude) was the ONE write/kill call in this method family card `ac20c8e7`'s own fixes left unguarded — the delayed resend just below it, `escalateGracefulStop`'s own stage-2 resend, and its stage-3 kill all already checked `killed`.

The gap this closes: a SECOND `stop()` call (either mode) landing here after an earlier kill was already issued — a prior hard `stop()`, or this same session's own `escalateGracefulStop` stage-3 — sails past the top-of-method `!live?.alive` guard (`alive` stays true until the async `'exit'` event) and would otherwise write Ctrl-C into an already-destroyed socket. The fix: guard this write on `killed`, matching every sibling site in the method family.

## Why not the two other fixes considered

- **Hoisting the guard to the top of `stop()`** was rejected: that would also skip the `stopping`/`pending`/`submitGeneration` bookkeeping above it, which a second `stop()` call legitimately still needs to run even when `killed` is already true.
- **Extending a `killed` guard to the HARD branch's `kill()` call** (the `if (mode === "hard")` branch above) was rejected: `killed` is set BEFORE `kill()` runs (card `bb3d9005` S1) specifically to close the write-after-destroy race, so it records "a kill was issued," never "the kill succeeded." Gating `kill()` itself on it could leave a session that failed to die on its first kill attempt permanently unkillable through this API — strictly worse than a redundant write.

## Do not

- Do not hoist this `killed` check to the top of `stop()` — a second `stop()` call still needs the `stopping`/`pending`/`submitGeneration` bookkeeping to run even when `killed` is already true.
- Do not extend a `killed` guard to the HARD branch's `kill()` call — `killed` there records only that a kill was issued, never that it succeeded; gating `kill()` on it risks leaving a session permanently unkillable through this API.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`stop()`'s graceful branch, immediately before its first `ptyWrite` call), as of this tranche's starting HEAD (`main` commit `51425319`). Extracted by card `05058dc8` (tranche 52 on `pty/host.ts`); condensed, not verbatim. The Narrative's quoted `ptyWrite(sessionId, live, "\x03", "stop-ctrl-c")` call, the `if (mode === "hard")` branch name, and the "double-Ctrl-C that exits an idle claude" description are drawn from the surrounding code and the unchanged doc comment immediately above the removed paragraph (`stop()`'s own graceful-branch intro), not from the removed paragraph itself.
