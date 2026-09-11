# 9549e322 — the Enter that submits a turn is NOT fire-and-forget: verified and retried until confirmed or given up

## Narrative

Card `9549e322` (the swallowed/dropped lone-Enter bug): a lone `\r` written to close out a `submit()` paste can land mid-ingest of a large/coalesced paste, or get dropped outright by Windows ConPTY (the same class of drop already documented for the boot Esc dismissal, card `dacb8571` — a different decision at a different site; this record does not attempt to cover it) — either way the text strands un-submitted with `busy` stuck true.

The fix: `enterConfirmed` is reset to `false` at the moment `submit()` writes the Enter, and `sendEnterAndVerify` re-sends the Enter on a bounded verify/retry schedule until either `UserPromptSubmit` fires (or a Stop, itself proof a turn ran) confirms it, or the schedule gives up and recovers `busy` so the session doesn't wedge forever waiting on a submit that never registered.

Validated against a real claude engine (v2.1.206, card `9549e322` review item ②): forcing a dropped Enter reproduces the stuck-busy symptom on unpatched code and confirms the verify/retry loop recovers it.

## Do not

- Do not treat the Enter write as fire-and-forget — always reset `enterConfirmed` and let the verify/retry schedule own confirmation, or a dropped Enter strands the session at `busy:true` with no recovery path.

## Source

Inline comment (JSDoc) in `packages/daemon/src/pty/host.ts`, `submit()`'s own method doc, lines 7993-7998 as of this tranche's starting `main` HEAD (`f18fdfcb`). Introducing commit `c433346f90` (2026-07-10). Card `9549e322` is cited at many other sites in this file (`git grep -n "9549e322" -- packages/daemon/src/pty/host.ts`); this record covers only the decision narrated at this specific site (why the Enter is verified/retried at all), not every citation. Extracted by tranche 33 (card `7ad5b460`).
