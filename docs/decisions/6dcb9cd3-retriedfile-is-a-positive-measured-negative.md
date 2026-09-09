# 6dcb9cd3 — TWO decisions, one card id: the `retriedFile` measured-negative, and the WEAKER PASS wording

This record anchors TWO distinct decisions from the same card, at two sites, merged into one record because
they share a card id (`resolveRecord`'s `.sort()[0]` over candidate filenames means a second `6dcb9cd3-*.md`
file would silently shadow one of these two decisions rather than adding to them).

## Decision A: persist the single-file-retry fact on `gate_status`, with a positive measured-negative

### Narrative

Card 6dcb9cd3 plumbs card `344ce950`'s single-file-retry fact onto the durable `verdict_payload_json` payload. Before this card, `gate_history` already carried `retriedFile`/`retryPassed` on both outcomes, but a `gate_status(opId)` read of a settled "merge" row carried neither, so a caller who polled `gate_status` instead saw `outcome:"pass"` beside a `steps[]` entry with a real failure and no way to tell "a failing gate merged code" from "the retry worked".

`retriedFile` uses a DELIBERATE MEASURED-NEGATIVE discipline, NOT the `undefined`-means-omit pattern every other field on this interface uses: `deriveMergeGateVerdict` sets this to a real filename OR `null` — never leaves it `undefined` — on every "pass"/"fail" row it writes going forward, so `null` here is a POSITIVE assertion ("no such retry fired for this row"), not silence. `undefined` still means what it means everywhere else on this interface: a settled row that predates this card, or a "cancelled"/"error" row (this pairing was never computed on those branches). This mirrors the `composerDirtyLen`/`recentTimeoutStreak` present-with-null-vs-absent-key contract already used elsewhere in this codebase (`mcp/orchestration.ts`).

`retryPassed` is `retriedFile`'s sibling with the same discipline: `null` whenever `retriedFile` is `null`; when `retriedFile` IS a real filename, `retryPassed` is `true`/`false` UNLESS card `318ac7b2`'s exception applies (the retry was identified and queued but cancelled before it ran to completion), in which case it stays `null` even though `retriedFile` is non-null — mirroring `gate_history`'s own documented pairing exactly.

### Do not

- Do not read an `undefined` `retriedFile` as "no retry happened" — only a literal `null` is that positive assertion; `undefined` means the row predates this card or is a cancelled/error row where the pairing was never computed.
- Do not assume a non-null `retriedFile` implies `retryPassed: true` — card `318ac7b2`'s cancel-while-queued exception leaves `retryPassed: null` even with a real filename present.

### Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.retriedFile` and `retryPassed`): lines 2220-2243, as of that tranche's HEAD.

## Decision B: `formatWeakerPassWarning` is the ONE place the "weaker pass" wording is authored

### Narrative

`formatWeakerPassWarning` (`gate-runner.ts`) is the ONE place the "⚠ WEAKER PASS" wording is authored — reused by BOTH the live `[loom:merge-done]` nudge (`confirmWorkerMergeTracked`'s `onSettle`, `sessions/service.ts`) and the pull-based `gate_status(opId)` settled-record read (`retryWarning`, same file — the very field Decision A above added). Before this card the nudge had its own inline template literal and `gate_status` had no warning at all — a manager who missed the nudge and polled `gate_status` instead saw `outcome:"pass"` next to a `steps[]` entry with a real failure and nothing explaining it (measured finding, op `3954a69f`). A single formatter means the two surfaces can never drift into two different tellings of the identical fact.

It takes `retriedFile` as callers already store it (a bare name, or a comma-joined list, card 67030bb9) — never call this when no retry fired. `outputTail` (card 9966c52d) is OPTIONAL/additive for `isTimeoutKillEntry`'s timeout-vs-assertion classification. `batchBranchCount` (card 67030bb9) is OPTIONAL/additive for the BATCH gate path; CORRECTED (card 553ea58c): an earlier version claimed "a green retry lands EVERY branch in the batch" unconditionally — false whenever the retry's own gate passes but the batch's fast-forward afterward still forfeits, or its post-gate HEAD read fails. Every call site now passes `batchBranchCount:undefined` for exactly that shape.

Card 9bdc8ea5: this function's signature/body are unchanged by that card — see its sibling `formatRetryAlsoFailedWarning` for the FAILED-retry case, kept SEPARATE rather than a `passed: boolean = true` default (Code Review: a default there recreates the exact defect for any future caller that forgets the 4th arg, and `tsc` cannot catch a missing defaulted arg) or a REQUIRED `passed` (rejected: `gate-status.mjs` alone has eight untyped `.mjs` call sites passing 1-2 args, each of which would start silently passing `passed: undefined` and flip into a fail-branch).

### Do not

- Do not inline a second copy of this wording anywhere else (nudge or `gate_status`) — both surfaces must call this one formatter, or they will drift.
- Do not add a `passed` boolean parameter to this function to cover the failed-retry case — use the sibling `formatRetryAlsoFailedWarning` instead; a defaultable/forgettable boolean here previously produced a false "weaker pass" claim with no compiler catch.
- Do not claim a batch retry lands every assembled branch unconditionally — pass `batchBranchCount:undefined` whenever the batch's post-retry fast-forward could still forfeit.

### Source

JSDoc comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `formatWeakerPassWarning`: originally lines 1527-1574, as of gate-runner.ts tranche 1's HEAD. Relocated by card `b80a2d76`; no wording changed, wrapped source lines joined into a flowing paragraph and `*` markers stripped. Folded into this pre-existing Decision A record (not kept as a separate file) after discovering `resolveRecord`'s `.sort()[0]` means only one `6dcb9cd3-*.md` file can ever be live.
