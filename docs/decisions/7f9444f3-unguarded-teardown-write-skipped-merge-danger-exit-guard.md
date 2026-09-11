# 7f9444f3 — an unguarded write inside `gracefulShutdown`'s teardown skipped the merge-danger exit guard and faked a crash

## Narrative

A real crash showed `gracefulShutdown` (index.ts) throwing an `uncaughtException` from an UNGUARDED `console.log` — EPIPE on a destroyed stdout (the Windows-console-close SIGHUP case is the realistic trigger, since Node emits SIGHUP for that). That throw sat on the line immediately BEFORE the merge-danger-aware exit board card `5a7692a4` added, so it skipped `waitForMergeDangerWindowsToClear()` entirely — reopening the exact ~92s-margin mid-canonical-merge-squash hazard that card exists to prevent — AND turned a clean, deliberate signal stop into a fatal exception that writes a phantom crash.log, misread by the next boot as `[loom:crash-recovered]`.

## Consequences

`runGracefulTeardown` (graceful-teardown.ts) is the structural fix: it runs `teardown()` best-effort — any synchronous throw inside it (not just the one write that has actually been observed to throw; a future write or fault added to that body is covered too) is swallowed — and then unconditionally awaits the merge-danger-window guard before calling `exit`. See the guard comment in `runGracefulTeardown`'s own doc comment for why the guard+exit must stay outside the try.

## Source

Inline JSDoc comment on `runGracefulTeardown` in `packages/daemon/src/graceful-teardown.ts`, as of commit `8e9c2b7a` (main's tip at this tranche's branch point), extracted by board card `6dc366d8` (`graceful-teardown.ts, tranche 1`). The Narrative paragraph above is the source's own incident-narrative paragraph, reproduced near-verbatim (wrapped lines joined, `*` comment markers stripped, the leading "Card 7f9444f3: " label dropped as redundant with this record's own heading — no other wording changed). The Consequences paragraph condenses the function's contract paragraph, which remains inline in source alongside the structural guard rule it does not cover.
