# 4c5bf820 — A settled merge-kind gate row derives its verdict too, and payload fields stay honest-null when absent

## Narrative

SETTLED VERDICT (card 4c5bf820, widened by 9f6598dd): populated for a "gate" row via deriveWorkerGateVerdict, and — since 9f6598dd — for a "merge" row too, via deriveMergeGateVerdict (previously a "merge" row's verdict/verdictPayload stayed NULL by construction; that was exactly Finding 1). A legacy row (from before either card) predates the columns entirely, and a not-yet-settled row never has one either. `payload` itself is honest-null on a corrupt/unparseable stored blob (see `Db.toPendingGateOp`) — either way this spreads nothing rather than a fabricated shape. `settledAt`/`totalDurationMs`/`extended` (card 9f6598dd) are independently optional on `payload` regardless of `verdict` kind — currently only ever set by the merge-kind derivation, so they spread through for "pass"/"fail" today and are simply absent for "cancelled"/"error"/a "gate" row, never fabricated.

## Do not

- Do not leave a `merge`-kind gate row's `verdict`/`verdictPayload` NULL by construction (Finding 1) — derive it via `deriveMergeGateVerdict`, the same as a `gate` row's `deriveWorkerGateVerdict`.
- Do not fabricate `payload`, `settledAt`, `totalDurationMs`, or `extended` when they're absent — a legacy row, a not-yet-settled row, or a corrupt stored blob must spread through as honest-null/absent, never a made-up shape.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`): lines 5061-5070, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed.
