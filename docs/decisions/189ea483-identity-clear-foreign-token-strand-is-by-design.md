# 189ea483 — a human identity-scoped clear stranding a foreign orphan's own token share is by design

Investigate-first card, suspected sibling gap to `028837ad` (found by that card's own Code Review,
reviewer `eb000fdd`, probe `p5.mjs`, 2026-10-29). Shape: A active, holding its own token `tA`. An orphan
`O` is unresolvable and holds `[tA, tF]` — `tA` folded in via a structural `orphanLatchFiles`
back-reference A's own record carries to O's latch (the same construction `028837ad`'s own (ORPHAN) test
scenario uses). A human `clearMergeQuarantine(A)` (lift-by-identity, never by-token) fully and durably
lifts A, but leaves O holding BOTH `tA` and `tF` — in-process and after a reboot.

**Verdict, reached via a hermetic repro (both legs) against main at `dd2b2ea7`: BY DESIGN, not a defect.**
The strand is real, but:
- It is never silent. The raw `clearMergeQuarantine` returns `stillBlockedCoOccupants`/`latchKept`/
  `referencingRepoPaths` naming O directly; the real production route, `clearMergeQuarantineReporting`
  (what `POST /internal/merge-quarantine/clear` actually calls), composes a human-readable `reason`
  naming O and the exact remediation (clear the shared latch by its own id).
- It is recoverable two ways, both verified: (a) a LIVE raiser's later `clearMergeQuarantineByToken(A,
  tA)` reaches O via the pre-loop pending pass — that route matches by bare TOKEN VALUE, identity-
  independent — and correctly reduces O to `[tF]` only; (b) a human clearing O DIRECTLY (dead-raiser
  case), via any of `clearMergeQuarantine(O)`, `clearMergeQuarantineByRecordedPath(O)`, or
  `clearMergeQuarantineLatchFile(O's id)`, fully and durably lifts both `tA` and `tF`.
- The same shape (strand + full disclosure) holds identically for `clearMergeQuarantineByRecordedPath`
  called directly on a resolvable A, not just via the `clearMergeQuarantine` wrapper.

**The identity-vs-token contract split (why this is structural, not a bug):** every identity-scoped
human-clear route matches a pending record via `directPathIdentity(p.entry.repoPath) === identity` — "does
this pending record belong to the identity being cleared," never "does its token array merely contain a
token that identity raised." Only `clearMergeQuarantineByToken` matches by bare token value, identity-
independent (see that function's own doc: "a token match IS an exact identity of its own holder") — that
is the deliberate contract difference between the two route families, not an oversight in one of them.
This exactly mirrors the already-ruled-upon precedent in `reduceForeignUnionContributor`'s own doc
(`@decision 3b1944b6` Round 2): "'lifting' identity here can only ever mean removing its own recorded
membership, never its token ... there is no safety reason to attempt it."

Pinned by `packages/daemon/test/merge-quarantine-189ea483-identity-clear-foreign-token.mjs`.

## Do not

- Do not widen an identity-scoped clear (`clearMergeQuarantine`, `clearMergeQuarantineByRecordedPath`, or
  the id-addressed route's delegate, `clearMergeQuarantineByKey`'s pending-tier matching) to also sweep by
  TOKEN VALUE across every identity — that reopens exactly the over-clearing class `3b1944b6`/`c9114934`
  spent many rounds closing. If a foreign token must be released without the original raiser clearing it
  by token, the correct route is a human clearing the FOREIGN identity's own record directly (by identity,
  recorded path, or id) — never teaching the CLEARED identity's own route to reach across the boundary.
- Do not read the missing `reason` field on the RAW `clearMergeQuarantine`'s own `latchKept` return as a
  production gap — `clearMergeQuarantineByKey` has no reason field of its own by design; the human-facing
  composition happens one layer up, in `clearMergeQuarantineReporting` (see `@decision 182c01cc`'s own
  "Round 2" composition notes). Test against the production wrapper, not the raw function, when pinning a
  disclosure assertion.
- Do not assert the disclosure check against the full `reason` prose — match a stable substring (the
  orphan's own repoPath, and the `clear-by-path` remediation pointer) so a future reword of the composed
  message doesn't spuriously redden this pin.
