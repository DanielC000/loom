# fa27d262 — Enter-only requires EVERY origin member already written, not just some

## Narrative

Card fa27d262 (Code Review finding on `4796f999`'s branch, TRACED then REPRODUCED — see `packages/daemon/test/pty-enter-only-drops-coalesced-neighbour.mjs`): this check used to be `origin?.some(...)` — ANY member of `origin` carrying `giveUpGen` was enough to trust the WHOLE joined `text` as "already physically written, retry the Enter only". But `drainPending`'s run-collection loop can coalesce a `giveUpGen`-tagged entry together with a FRESH neighbour that has never been attempted before (same route + kind, neither held) into ONE `drained`/`origin` array — that fresh neighbour's real body was never written anywhere. `some` let that mixed batch take Enter-only too: zero body bytes written for the ENTIRE joined text, fresh neighbour included, while `drainPending` still unconditionally fires `onDeliver()` for every drained entry afterward — a silent loss the system believes it delivered.

`every` requires EVERY member of this batch to have already been physically written once before trusting the composer still holds all of it; a single fresh member routes the WHOLE batch to the full clear+repaste branch instead, which re-pastes the complete joined text (every member's real body, fresh ones included) rather than trusting nothing was ever written. Safe for the single-message case `b9b8f8db` exists to fix: `origin` is never empty (every call site passes either `undefined` or a non-empty array — see `submit()`'s own call sites), so `every`/`some` agree whenever `origin` has exactly one element, which is the only shape that case ever produces.

## Do not

- Do not revert `origin?.every(...)` back to `.some(...)` — that silently drops a fresh coalesced neighbour's body while `onDeliver()` still reports it delivered.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`, the composer clear-prefix / give-up-redelivery block), lines 9926-9941, as of commit `dc53c7111807e103baf99544d3890df80e9a1c92` (this tranche's starting HEAD). Extracted by card `dfde8c66` (tranche 9). Regression test: `packages/daemon/test/pty-enter-only-drops-coalesced-neighbour.mjs`.
