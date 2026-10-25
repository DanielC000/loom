# f224632d — verify the solo squash commit's own trailer before trusting its landed sha

## The hole

Card `95940402` closed the batch cherry-pick path's own parent+tree-only verification gap: a racer who
swaps the batch worktree's ref to a forged sibling commit sharing the real candidate's exact parent and
tree, but carrying a forged `Loom-Worker-Branch:`/`Loom-Landed-Tip:` trailer, used to pass unnoticed. That
card's own cross-reference named the SOLO squash path (`mergeBranchLocked`'s `verifyLandedAsOwnCommit`,
decision `2a6a292a` rounds 21-23) as carrying the identical residual, carded separately as this card.

The solo path's `verifyLandedAsOwnCommit` closure verified a re-read sha's parent and tree against
`preCommitHead`/`stagedTree` (via the shared `verifyCommitParentAndTree`, `git/worktrees.ts`) — but never
inspected the commit's own message. A racer who swaps canonical `HEAD` to a `commit-tree <tree> -p
<realParent> -m <forged>` sibling in the narrow window between the real `git commit` settling and
`mergeBranchLocked`'s own post-commit `rev-parse HEAD` re-read gets that forged commit `landedBase`
defined (`landedVerify: "verified"`) — the exact same trust-laundering shape `95940402` closed for batch,
reaching `recordMainlineLedgerEntry` and `advanceMainlineWatermark`'s trust stamp unverified.

## The fix

`verifyLandedAsOwnCommit` (`mergeBranchLocked`, `git/worktrees.ts`) now, after `verifyCommitParentAndTree`
reports `ok:true`, builds the EXACT set of Loom trailers this process itself wrote — `Loom-Worker-Branch:
<branch>`, `Loom-Landed-Tip: <resolvedBranchHead>` (only when `resolvedBranchHead` is truthy, mirroring
how the message itself is built), and `Loom-Worker-Base:`/`Loom-Worker-PathSet:` (only when the
PathSet/tree capture succeeded — `stampedPathSetDigest`, hoisted out of its capture `try` block so this
closure can read it) — and checks the verified commit's own raw body (`verify.body`, now always populated
alongside an `ok:true` parent/tree result) against that set via the SHARED `verifyLoomTrailersExactAndReadable`
(`git/worktrees.ts`, built by `95940402` for the batch path). A mismatch makes the closure return
`undefined`, exactly the same "unverified" outcome a bare parent/tree mismatch already produces — no new
refusal shape, no second check: both of `verifyLandedAsOwnCommit`'s existing call sites (the ordinary
post-commit read, and the commit-threw-but-HEAD-moved-anyway recovery read) already treat an `undefined`
landed-base as "don't trust this sha" — skip the ledger row, pass `undefined` (never the raw sha) into
`advanceMainlineWatermark`, and (on the HEAD-moved-anyway path specifically) refuse the merge outright with
the existing "cannot verify as its own" reason. Extending the SAME mechanism to cover trailer forgery, not
just parent/tree forgery, closes the gap with no new control-flow branch.

`verify.body` was already returned by `verifyCommitParentAndTree` whenever the `cat-file -p` read itself
succeeded (card `95940402` round 2) — this card is the first SOLO-path caller to actually read it.

Traced which message git actually commits: `mergeBranchLocked` builds its own `message` local variable
(subject + `deriveWorkerCommitLogBody`'s subject-only worker log + the Loom trailer paragraph) and passes
it directly via `git commit -m message` (`killableCanonicalRaw(... ["commit", "-m", message] ...)`) — never
through a `SQUASH_MSG`-derived default (that would only apply with no `-m`/`-F`/`-c`) and never through a
`stripClaudeSessionTrailer` call (that strip exists elsewhere, for paths that pass a worker's own raw
commit body through; this path's `workerCommitLogBody` is derived via `git log --format=%s` — subjects
only, per card `8b7b81e0` — so a body-only trailer like `Claude-Session:` never reaches it). The `expected`
set this card builds mirrors that `message` construction exactly.

## Test

`packages/daemon/test/mainline-watch-own-commit-verify.mjs` — three new scenarios, direct `mergeBranch`
calls (mirroring the file's existing `(UNIT-TWO-PARENT)`/`(UNIT-GRAFT-HIDDEN)` shape):

- `(FORGE-TRAILER-BRANCH)` — a same-parent, same-tree (content-identical) post-commit-hook racer carrying
  a forged `Loom-Worker-Branch:` naming a different branch. `landedBase` must be `undefined`,
  `landedVerify` must be `"rejected"`.
- `(FORGE-TRAILER-LANDEDTIP)` — the identical racer, keeping the real branch trailer but carrying a
  wrong, DUPLICATED `Loom-Landed-Tip:` line. Same assertions.
- `(FORGE-TRAILER-CONTROL)` — an ordinary, no-forgery landing: `landedBase` equals `preCommitHead`,
  `landedVerify` is `"verified"`, and `landedTip` equals the branch's own real pre-squash tip sha.

RED/GREEN: confirmed via a temporary revert of the two `worktrees.ts` edits (captured as a patch, restored
after), rebuild, re-run — RED: `(FORGE-TRAILER-BRANCH)`'s and `(FORGE-TRAILER-LANDEDTIP)`'s own two
assertions each failed (both forged commits still verified as "our own"); `(FORGE-TRAILER-CONTROL)` passed
unaffected (proving the revert isolated exactly the new check). Restored, rebuilt, re-run — GREEN: all
pass.

Also run directly (no regression): `worktrees.mjs`, `canonical-git-helper-guard.mjs`, and every
`merge-confirm*.mjs` file referencing `landedBase`/`landedVerify`/the Loom trailer namespace —
`merge-confirm-completion-nudge.mjs`, `merge-confirm-idempotent.mjs`, `merge-confirm-solo-finalize-tip-cas.mjs`,
`merge-confirm-stale-retry-idempotent.mjs`, `merge-confirm-thrown-error-recovery.mjs` — all green, plus the
full `pnpm --filter @loom/daemon guards` suite (30/30).

## Round 2 (Code Review 5e586b56) — a legitimate commit-msg hook must not read as a forgery

Round 1's fix folded EVERY `verifyLoomTrailersExactAndReadable` failure kind into "unverified" — correct
for a genuine value forgery, but wrong for the two kinds that function can ALSO return for a completely
honest reason: a repo's own `commit-msg` hook appending a paragraph after Loom's trailer ("displaced") or
otherwise breaking the structural per-line reader without touching any reserved VALUE ("unreadable"). The
solo path keeps real `git commit` (never `commit-tree`) precisely so a repo's own hooks still run — so
this is exactly the protected population. Folding both into "unverified" meant EVERY ordinary landing in
such a repo filed a false forge-race HOLD alert (`fileNullTrustForgeRaceEvent`) or froze trust permanently
(`fileLandingTrustFreezeEvent`), and never got a ledger row — reproduced live by the Code Review.

**M1 (Code Review ruling) — only a genuine "forged" kind still disqualifies.** `verifyLandedAsOwnCommit`
now reads `verifyLoomTrailersExactAndReadable`'s own `kind` out of its result:
- `kind: "forged"` — unverified, unchanged from round 1 (`landedBase: undefined`).
- `kind: "displaced"` or `"unreadable"` — kept **VERIFIED** (`landedBase: preCommitHead`, same as a
  genuine match), and the closure ALSO returns `trailerAdvisory: kind` so the caller can file an honest,
  low-severity, non-nudging notice instead of routing into the forge-race/trust-freeze path.

**Double-checked, not assumed: both kinds ALREADY imply every reserved value is byte-exact, by the shared
function's own control flow** — `verifyLoomTrailersExactAndReadable` only ever reaches its
`parseLoomTrailerBlock` round-trip (where `"unreadable"` is returned) AFTER `verifyLoomNamespaceExact`
already returned `true` for the SAME `message`/`expected` pair, and `"displaced"` is returned only when
`verifyLoomNamespaceExact` failed BUT `loomTrailerBlockDisplaced` independently confirmed the exact
reserved-key SET and VALUES still match `expected`, just not all in the final paragraph. Neither kind is
reachable via a genuine value mismatch — so no split between "unreadable (values exact)" and "unreadable
(values wrong)" is needed; the function's own control flow already guarantees there is no second case.

**New field: `mergeBranch`/`mergeBranchLocked`'s return type gains `trailerAdvisory?: "displaced" |
"unreadable"`.** `SessionService.fileTrailerDisplacedAdvisory` (new private method, `sessions/service.ts`)
files a `landing_trailer_displaced` event (new `OrchestrationEventKind`, `packages/shared/src/types.ts`) —
`detail: {projectId, repoKey, branch, kind, severity:"low"}` — deduped per `(projectId, repoKey)` for the
daemon **PROCESS's own lifetime only** (an in-memory `Set`, `trailerDisplacedAdvisedRepos` — never a
DB-backed/cross-restart dedup; a restart may refile it once, accepted). It never calls
`enqueueDurableMessage` — this is a forensic record, not an actionable hold, and nudging on every future
ordinary landing in a hook-bearing repo is the exact noise this round removes. Audit-only posture, same as
`codex_isolation_gap_disclosed`/`commondir_trust_pinned` — deliberately NOT added to
`EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS`.

**M2 (scope ruling) — this closes the LEDGER/TRUST path only.** `findLandedSquashCommit`,
`scanMergedCommitMap`, `pinnedTipForLandedSquash`, and hold release still parse a landed commit's message
DIRECTLY via `parseLoomTrailerBlock`/trailer-grep, and still can't read a displaced/unreadable trailer —
this round does not change that; the advisory event exists precisely to make that residual discoverable.
Closing the READER side is carded separately (per the Code Review); do not fold a reader-side fix in here.

**m1 — fixed the stale comment** at the "commit failed but HEAD moved anyway" recovery read (old text:
"parent+tree via `verifyLandedAsOwnCommit`, never a trailer" — now stale since round 1 already added the
trailer check there) to name both checks.

**m2 — extended the control set:** a two-commit branch (so `deriveWorkerCommitLogBody`'s own non-trivial
body is present) under the displacing hook still verifies correctly; a hook that joins a FOREIGN
(non-Loom) trailer INTO Loom's own final paragraph (no blank-line separator — exactly how a real
`Change-Id:`/`Signed-off-by:` hook behaves) stays on the plain pre-existing `ok:true` path with **no**
`trailerAdvisory` at all, proving round 2 didn't widen what counts as "kept verified despite" beyond the
two kinds it was meant to cover.

**Tests** (`mainline-watch-own-commit-verify.mjs`, direct `mergeBranch` calls unless noted):
- `(HOOK-DISPLACED)` / `(HOOK-UNREADABLE)` — a `commit-msg` hook (fires during `git commit`, never a
  post-commit race) produces each kind; both assert `landedBase` defined, `landedVerify: "verified"`,
  `trailerAdvisory` set to the matching kind, AND (setup control) that `parseLoomTrailerBlock` — the real
  reader every mainline consumer uses — genuinely returns `null` on the actual committed message, proving
  the displacement/unreadability is real, not assumed.
- `(HOOK-DISPLACED-MULTI-COMMIT)` — m2's multi-commit control.
- `(HOOK-FOREIGN-TRAILER-IN-BLOCK)` — m2's foreign-trailer-in-block control; asserts `trailerAdvisory ===
  undefined`.
- `(HOOK-DISPLACED-SERVICE)` — the FULL `confirmWorkerMergeTracked` path, two sequential landings under the
  same still-installed hook: a ledger row (L2; L1 is this project's true first-ever landing, where
  `expectedMainlineBranch` resolves to `undefined` regardless of this fix — the same M1 asymmetry
  `(FORGE-RACE)`'s own comment names, so L1's ledger-row assertion would be vacuous and is skipped), a
  trust stamp on both landings, **zero** `mainline_moved_outside_loom` events across both, and **exactly
  one** `landing_trailer_displaced` event total — proving the dedup is per-repo-per-PROCESS, not
  per-landing or per-episode.

RED/GREEN: captured the round-2 source diff (`worktrees.ts`/`sessions/service.ts`/`types.ts`) to a patch,
reverted just those three files to round-1 state (kept the round-2 tests), rebuilt, re-ran — 16 checks
FAILED: every `HOOK-*` assertion plus the full false-forge-race/no-ledger-row/no-advisory chain on
`(HOOK-DISPLACED-SERVICE)`, with `(HOOK-FOREIGN-TRAILER-IN-BLOCK)` correctly UNAFFECTED (proving the
revert was scoped to exactly the round-2 mechanism, not the pre-existing `ok:true` path). Restored,
rebuilt, re-ran — all 89 checks green.

Also run directly (no regression), in BOTH `LOOM_DEV` states (`env -u LOOM_DEV` / `LOOM_DEV=1`) per the
manager's own m3 directive: `mainline-watch-own-commit-verify.mjs` and the same five `merge-confirm*.mjs`
files round 1 named — all green in both states. (Neither this file nor any of the five branches on
`isLoomDev()`/`isSupervised()` directly; run in both states anyway, as directed.)

## Cross-references

- `docs/decisions/95940402-verify-each-batch-landed-commits-parent-and-tree-before-pinning-it.md` — the
  batch path's own fix, whose `verifyCommitParentAndTree`/`verifyLoomTrailersExactAndReadable` this card
  reuses rather than reimplements (per that card's own round-5/F3 fix, which generalized the `Loom-Landed-Tip`
  comparison specifically so this card's solo-path reuse would not false-refuse on a value only the solo
  path legitimately sets).
- `docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md` rounds 21-23 — the
  solo path's own `verifyLandedAsOwnCommit`/"unverified landing" mechanism this card extends, not replaces.
- `docs/decisions/356538ef-canonical-git-isolation.md` / request `b0fb1e26` — why this fix is a message
  check, never a `commit-tree`+CAS rewrite of the solo squash path (that would drop the user's own commit
  hooks, already declined by the owner).
- Code Review `5e586b56` — round 2's M1/M2 ruling and the m1/m2/m3 follow-ups.

## Do not

- Do not write a second trailer-verification function for the solo path — reuse the shared, exported
  `verifyLoomTrailersExactAndReadable`/`verifyCommitParentAndTree` (`git/worktrees.ts`); this card's own
  `verifyLandedAsOwnCommit` closure is the ONLY call site added.
- Do not introduce a NEW refusal branch (a fresh `ok:false` shape) for a trailer mismatch in the ordinary
  (non-throwing) commit success path — the existing "`landedBase` undefined ⇒ unverified" outcome is
  already the refusal this card reuses; the downstream ledger-skip/trust-freeze mechanics (decision
  `2a6a292a` rounds 19-21) are what actually protect the trust layer, same as for a parent/tree mismatch.
- Do not switch the solo path to `commit-tree` + `update-ref` CAS to close this gap — `commit-tree` skips
  the user's own commit hooks, which the owner has already declined dropping (record `356538ef`, request
  `b0fb1e26`).
- Do not build `expected` trailers from a fresh read of `message` after the fact — build it from the SAME
  local state (`branch`, `resolvedBranchHead`, `preCommitHead`, `stampedPathSetDigest`) the real commit's
  message was itself constructed from, so a drift between the two can never exist.
- Do not assume `stagedTree !== undefined` without `stampedPathSetDigest !== undefined` (or vice versa) —
  both are captured in the SAME pre-commit `try` block, in sequence, so either both are defined or the
  early uncaptured short-circuit (`preCommitHead === undefined || stagedTree === undefined`) already
  applies; don't re-derive a third partial-capture case that cannot actually occur.
- Do not fold `"displaced"`/`"unreadable"` into `"forged"`'s unverified outcome (round 1's own mistake,
  fixed in round 2) — only a genuine value mismatch (`"forged"`) disqualifies; the other two kinds are
  what a repo's own legitimate `commit-msg` hook produces, and the solo path keeps real `git commit`
  specifically so such hooks still run (record `356538ef`/request `b0fb1e26`).
- Do not re-derive whether `"unreadable"` can hide a genuine value mismatch — `verifyLoomTrailersExactAndReadable`'s
  own control flow already proves it cannot (see round 2's own "Double-checked, not assumed" paragraph);
  don't add a redundant re-verification of the already-exact namespace before trusting that kind.
- Do not call `enqueueDurableMessage` from `fileTrailerDisplacedAdvisory`, and do not route its event
  through `mainline_moved_outside_loom` — it is a forensic record for a known-honest cause, not an
  actionable hold; see round 2's own M1 fix for why folding it into the forge-race/freeze path is exactly
  the bug being fixed.
- Do not persist `trailerDisplacedAdvisedRepos` to the DB, or dedupe the advisory any other way than the
  in-memory `Set` — "per repo per PROCESS" is the explicit ruling; a restart refiling it once is accepted.
- Do not read round 2 as closing the trailer-READER side (`findLandedSquashCommit`/`scanMergedCommitMap`/
  `pinnedTipForLandedSquash`/hold release) — M2 scopes this card to the ledger/trust path only; the reader
  side is carded separately.
