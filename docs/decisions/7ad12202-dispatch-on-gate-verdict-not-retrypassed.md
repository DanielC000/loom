# 7ad12202 — `retryWarning` dispatch checks the GATE's own verdict first, never `retryPassed` alone

## Narrative

Card 7ad12202 Code Review BLOCKING [1]: `gateStatus`'s `retryWarning` dispatch used to branch on `payload.retryPassed` ALONE — `formatWeakerPassWarning` on `true`, `formatRetryAlsoFailedWarning` on `false` — which was sound only as long as a `true` `retryPassed` could ONLY ever coexist with a genuinely PASSED gate. Card 7ad12202's own resume mechanism broke that: a rescued single-file retry can pass while a LATER step (one the original `&&` chain never reached) is resumed afterward and genuinely fails — `retryPassed:true` alongside `outcome:"fail"`/`t.record.verdict === "fail"`. Dispatching on `retryPassed` alone rendered `formatWeakerPassWarning`'s "WEAKER PASS" text on a REJECTED record — prose asserting a pass that did not happen, the exact defect class card `9bdc8ea5` exists to remove, reopened by a different mechanism.

Fixed by checking the GATE's own real verdict FIRST: `t.record.verdict === "pass"` (never `retryPassed`) decides whether the whole gate actually passed; `retryPassed` is consulted only WITHIN the rejected branch, to choose between `formatRetryAlsoFailedWarning` (the retry itself also failed) and `formatRetryRescuedButGateRejectedWarning` (the retry passed, but the resume then broke) — see that function's own doc for why neither of the other two formatters is honest for this case.

## Do not

- Do not dispatch `retryWarning`'s formatter choice on `payload.retryPassed` alone — check `t.record.verdict === "pass"` first; `retryPassed` only disambiguates WITHIN the rejected branch.
- Do not assume a `true` `retryPassed` implies the whole gate passed — card 7ad12202's resume mechanism can rescue one step and still fail a later one, leaving `retryPassed:true` alongside a "fail" verdict.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`'s `retryWarning` dispatch): lines 3837-3850, as of this tranche's HEAD (tranche 9).
