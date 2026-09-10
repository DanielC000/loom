# 67030bb9 — `MergeBatchResult.retryWarning`'s three cases; CORRECTED to also apply on `ok:false`

## Narrative

Card 67030bb9 (CORRECTED, card 4ad6ccfd — the previous version of this doc, "present ONLY when `retriedFile` is set and the BATCH ultimately landed (`ok:true`)", was WRONG: this field is present on `ok:false` too). Gated on `retriedFile` non-null AND `retryPassed` a strict boolean — a null/undefined `retryPassed` (the retry-cancelled-while-queued exception) renders neither wording, since it never reached a verdict. Built by one of the SAME two shared formatters `gate_status(opId)` renders this exact op from (`formatWeakerPassWarning`/`formatRetryAlsoFailedWarning`, orchestration/gate-runner.ts), never a second independently-worded copy. Three real cases:
- `ok:true` (the retry came back green and the batch landed): the "⚠ WEAKER PASS" wording, with a batch clause carrying THIS batch's own `result.landed.length` (CORRECTED, card 553ea58c — an earlier version used the LOCAL, session-row-filtered `landed` array built a few lines below this return, which under-counts if a worker session row no longer resolves between selection and finalize; `result.landed.length` is the real git-verified count regardless) — how many branches landed on the strength of one isolated retry, not just which file(s) were retried. A batch retry is a STRONGER claim than a solo one for exactly this reason.
- `ok:false` with `retryPassed:true` (the retry itself passed, but a fast-forward/HEAD-read failure AFTER the gate — `batch-merge.ts`'s `:806`/`:813` returns — means nothing actually landed): still the "⚠ WEAKER PASS" wording (the retry fact is real and worth surfacing), but with NO batch clause — the caller passes `batchBranchCount:undefined` here specifically so this never asserts a landing that didn't happen (the "ALL N land on the strength of this ONE retry" clause would be false on this return, whose own `landed: []` says as much).
- `ok:false` with `retryPassed:false` (a genuine gate rejection, `batch-merge.ts`'s `:797` return, the ONLY reachable case here): the "⚠ RETRY ALSO FAILED" wording, with a batch clause carrying the count of branches ASSEMBLED into the batch worktree and gated (never "landed" — nothing lands on a rejection; this is the same "assembled", not "landed" wording `BatchGateResult.retriedFile`'s own doc (git/batch-merge.ts) already gets right).

## Decision B: `identifyRetriableTestFiles` (gate-runner.ts) — the bounded multi-file design, fail-closed per name

### Narrative

`identifyRetriableTestFiles` (card 344ce950 single-file / 67030bb9 bounded multi-file, manager-approved — REPLACES the old exactly-one-file `identifyRetriableTestFile`) identifies UP TO `maxFiles` distinct test files this daemon's own hermetic suite can re-run TOGETHER in isolation via its `--only=<name>[,<name>...]` flag (card 6185fbfc), so a merge gate can retry a small failing SET instead of the whole ~650-file suite before declaring a rejection.

DELIBERATELY NARROW AND FAIL-CLOSED, PER NAME: recognizes ONLY this daemon's own `FAIL  <name>` convention (a bare identifier — letters/digits/hyphen/underscore, no path/extension), never the sibling Jest/AVA/tap/`AssertionError`/`error TSxxxx`/`UNCAUGHT` shapes, and NEVER via a second parser. EVERY name is confirmed against the REAL filesystem before being reported identifiable — a single name that merely LOOKS like one of ours but doesn't correspond to a real file declines the WHOLE set (never a partial candidate).

THE COUNT CHECK THIS REPLACES (manager review, card 344ce950, inherited unchanged in spirit): this daemon's test runner has NO fail-fast (`Promise.all` over lanes; `failed` is an ARRAY) — a single run can genuinely fail on any number of files. The old function required EXACTLY `1`; this one requires `[1, maxFiles]` — everything ABOVE the cap still refuses exactly as `!== 1` used to, the identical "ambiguity ⇒ not identifiable" posture, just with a wider band below it.

### Do not

- Do not report a partial candidate set when one name fails the filesystem check — the WHOLE set declines.
- Do not widen the recognized shape beyond the bare `FAIL  <name>` convention, or add a second parser — a caller must pass the SAME `failTierAll` the live scan already extracted.

## Do not

- Do not gate `retryWarning`'s presence on `ok:true` alone — card 4ad6ccfd corrected an earlier version of this doc that claimed exactly that; it is also present on `ok:false`.
- Do not pass a real `batchBranchCount` on the `ok:false`/`retryPassed:true` case — nothing actually landed there (a fast-forward/HEAD-read failure after a passing retry), so the caller must pass `undefined` rather than asserting a landing that didn't happen.
- Do not build a second, independently-worded formatter for this warning — always route through `formatWeakerPassWarning`/`formatRetryAlsoFailedWarning` (orchestration/gate-runner.ts), the SAME two `gate_status(opId)` renders this exact op from.
- Do not compute a batch's `attempt1DurationMs` as `nowMs - gateStartedAt` at the settle point (Code Review finding [1]) — after a multi-file retry's own separate, later `runExclusive` admission, that produces an unbounded, mixed span covering neither admission the rest of the row describes; use the ALREADY-COMPUTED attempt-1-bounded duration captured right after attempt 1's own admission settled, mirroring `confirmWorkerMerge`'s own `gateAttempt1DurationMs` fix (card b9e07a4a).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`MergeBatchResult.retryWarning`, lines 486-510; the batch verdict derivation's `attempt1DurationMs` correction, lines 871-942): as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
