# 327bcaaa — clear pending proposal payloads on companion session close

## Narrative

Card `327bcaaa` (the session-close hygiene fix): `clearPendingProposalsForSession` (packages/daemon/src/companion/capabilities.ts) clears every outstanding proposal PAYLOAD held for a `sessionId`, across all five ACT levers' own module-scoped pending-payload maps — `pendingDecisionResolves` (decisions-relay), `pendingBoardWrites` (board-reach), `pendingAuthoredGrants` (authored-content-grant), `pendingSpawns` (session-spawn), and `pendingGitWrites` (git-push, card `a3c3ade8`, joined the set for the identical reason once that lever landed).

Before this card, `closeCompanionTrustWindow` cleared neither this payload store nor the confirm-token store — a recycled/unbound/re-paired session's pending proposal became permanently-orphaned dead memory. Never a security issue (nothing can ever confirm it once the session is gone), but genuine leaked state. A caller of `clearPendingProposalsForSession` must ALSO call `OwnerConfirmStore.clearSession` (attestation.ts) for the SAME sessionId, since this only clears the levers' own remembered payloads, never the confirm tokens themselves.

CR follow-up (this same card): the first pass missed `pendingSpawns` — `session_spawn` uses the identical proposeConfirmation→pending→confirm shape via the same `OwnerConfirmStore`, so it needed the same clear as the other three. This gap is exactly why `pendingProposalCountForSession` (TEST-ONLY introspection, same file) exists: the commit path on every lever checks the confirm TOKEN (`OwnerConfirmStore`) BEFORE it ever reads its own payload map, so a test that only proves "the captured token no longer commits" can pass even if a payload-map clear silently regressed — exactly how the `pendingSpawns` gap slipped past the first test. Asserting on `pendingProposalCountForSession` directly gives a test that FAILS if the payload-map half of the clear breaks, independent of the token half.

## Do not

- Do not add a new ACT lever's pending-payload map without also adding it to `clearPendingProposalsForSession`'s clear list — the `pendingSpawns` omission is the concrete incident this guards against.
- Do not trust a test that only exercises the confirm-token path to prove the payload-map clear works — assert on `pendingProposalCountForSession` directly.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`clearPendingProposalsForSession`'s top-of-function doc, plus `pendingProposalCountForSession`'s "CR follow-up" clause): lines 939-953 and 967-968, as of this tranche's HEAD. Relocated by card `2e703a3d` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs.
