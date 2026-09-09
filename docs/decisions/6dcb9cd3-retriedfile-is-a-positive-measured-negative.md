# 6dcb9cd3 — persist the single-file-retry fact on `gate_status`, with a positive measured-negative

## Narrative

Card 6dcb9cd3 plumbs card `344ce950`'s single-file-retry fact onto the durable `verdict_payload_json` payload. Before this card, `gate_history` (the `build_gate` audit event) already carried `retriedFile`/`retryPassed` on both outcomes, but a `gate_status(opId)` read of a settled "merge" row carried neither, so a caller who polled `gate_status` instead of `gate_history` saw `outcome:"pass"` sitting beside a `steps[]` entry with a real failure and no way to tell "a failing gate merged code" from "the retry worked".

`retriedFile` uses a DELIBERATE MEASURED-NEGATIVE discipline, NOT the `undefined`-means-omit pattern every other field on this interface uses: `deriveMergeGateVerdict` sets this to a real filename OR `null` — never leaves it `undefined` — on every "pass"/"fail" row it writes going forward, so `null` here is a POSITIVE assertion ("no such retry fired for this row"), not silence. `undefined` still means what it means everywhere else on this interface: a settled row that predates this card, or a "cancelled"/"error" row (this pairing was never computed on those branches, since attempt 1's own retry facts don't carry onto a cancel-while-queued return). This mirrors the `composerDirtyLen`/`recentTimeoutStreak` present-with-null-vs-absent-key contract already used elsewhere in this codebase (mcp/orchestration.ts).

`retryPassed` is `retriedFile`'s sibling with the same discipline: `null` whenever `retriedFile` is `null`; when `retriedFile` IS a real filename, `retryPassed` is `true`/`false` UNLESS card `318ac7b2`'s exception applies (the retry was identified and queued but cancelled before it ran to completion), in which case it stays `null` even though `retriedFile` is non-null — mirroring `gate_history`'s own documented pairing exactly.

## Do not

- Do not read an `undefined` `retriedFile` as "no retry happened" — only a literal `null` is that positive assertion; `undefined` means the row predates this card or is a cancelled/error row where the pairing was never computed.
- Do not assume a non-null `retriedFile` implies `retryPassed: true` — card `318ac7b2`'s cancel-while-queued exception leaves `retryPassed: null` even with a real filename present.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.retriedFile` and `retryPassed`): lines 2220-2243, as of this tranche's HEAD.
