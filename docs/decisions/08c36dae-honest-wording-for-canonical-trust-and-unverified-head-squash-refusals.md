# 08c36dae — honest wording for canonical-trust and unverified-HEAD squash refusals

From card f4da727f's Code Review (reviewer 08a4b80b, 2026-10-27), findings F1 and F2. Three
`mergeBranchLocked` refusal sites (`packages/daemon/src/git/worktrees.ts`) carried no distinguishing
flag, so `confirmWorkerMergeTracked`'s generic fallthrough (`sessions/service.ts`) told the manager
"squash was attempted but never committed … canonical repo untouched, worktree retained. Re-task a
rebase." for conditions where that text was false or actively misleading. Reviewed and shipped
(commit 6f014fcf); this file also carries a second review round's three findings (below).

## The flag → site table

- **`canonicalTrustRefusal`** — TWO sites, both gated on a STRUCTURAL `instanceof CanonicalGitRefusal`
  check, never a message-text match:
  1. The pre-squash identity-fallback probe's catch block. After card f4da727f round 2 moved this probe
     BEFORE the squash, `resolveGitIdentityFallbackArgs` can only ever throw a `CanonicalGitRefusal` —
     its own internal probe (`probeGitIdentResolvable`, `git/bounded.ts`) swallows every other error and
     rethrows only that type — so the `instanceof` check here is always true in practice; it stays
     explicit so the site never silently drifts if that invariant changes.
  2. `squashRefusalDetail !== undefined` at the squash's own trust check — the function's own comment
     confirms "the squash never started, so the canonical repo is exactly as it entered" for this site.
  Both are genuinely pre-squash: nothing was ever attempted. **A `CanonicalGitRefusal` is not limited to
  commondir redirect / pin mismatch / unpinned root** — it is also thrown for a LIVE or unsafe-named
  merge-driver config entry (`assertNoLiveMergeDrivers`, `git/bounded.ts` ~L2053; `defaultPrefixBuilder`,
  ~L2078) — every kind this type can carry reaches `canonicalTrustRefusal`, not only the commondir-trust
  ones. `ConfirmMergeResult.canonicalTrustRefusal`'s own doc comment (service.ts) names both.
- **`headMovedUnverified` (+ `divertedSha`)** — the squash commit call failed, and canonical HEAD then
  moved to a sha `verifyLandedAsOwnCommit` could NOT verify as this attempt's own. Deliberately left
  unreset (see f4da727f's own "Do not" — a hard reset here could destroy possibly-foreign work).
  "Canonical repo untouched" is FALSE here: HEAD moved, and the content there is unconfirmed.
  **Round 2 correction: this is NOT only the "a racer landed a foreign commit" case.**
  `verifyLandedAsOwnCommit` returns `{landedBase: undefined}` unconditionally whenever `preCommitHead`
  or `stagedTree` was never captured — and `stagedTree`'s capture is a SEPARATE, independently-failable
  step (`git write-tree`, after `preCommitHead`'s own `rev-parse HEAD` already succeeded) in the same
  best-effort try block. So this flag ALSO fires when `headAfterFailure` is genuinely THIS merge's own
  commit, but the verification apparatus itself could not run because that one capture step failed for
  an unrelated reason. The wording stays technically true either way ("this merge cannot verify as its
  own" — it genuinely could not, regardless of whether the commit actually is or isn't its own), but a
  human reading the alert should not assume a racer is the only possible cause.
- **`squashLandedUnread`** — the squash commit itself SUCCEEDED (the commit call never threw), but the
  immediately-following confirmatory `rev-parse HEAD` read failed, so this merge never learned the
  landed sha. Distinct from `headMovedUnverified`: there is no doubt this is the merge's OWN commit —
  only its sha is unread. Folded into this card (not originally named by the reviewer) because it is the
  same defect class: "canonical repo untouched" is false, since a real commit DID land.

## Why each flag's wording is what it is

- `canonicalTrustRefusal`'s `detailText` deliberately does NOT re-explain the trust remedy. `merge.reason`
  already carries `canonicalFailureMessage`'s full, kind-specific guidance (pinMismatch / commondirRedirect
  / boundRepoIsWorktree / unpinned each have distinct, already-good remedy text; a merge-driver refusal
  falls to the generic `refused, nothing changed: ${d.text}` branch — `git/bounded.ts`'s
  `canonicalFailureMessage`, ~L1599-1618). The new branch only drops the misleading "squash was
  attempted … Re-task a rebase" suffix and states plainly that this is a TRUST refusal a rebase cannot
  fix — duplicating the remedy text would drift from `canonicalFailureMessage`'s own wording over time.
- `headMovedUnverified`'s `detailText` says the canonical repo is NOT confirmed untouched, says the
  moved-to commit "may be a foreign write, or it may genuinely be this merge's own commit whose
  verification itself could not run" (the round-2 nuance above), names `git show <sha>` for a human to
  inspect (when `divertedSha` is known), says a rebase will not help, and says **nothing currently blocks
  a further merge on this repo** — a later landing's own `advanceMainlineWatermark` call is what will
  file a HIGH mainline-moved alert naming this commit, once one actually lands (see the trust-freeze
  section below for the exact mechanism and why "checkMainlineMove" was the wrong attribution in round 1
  of this card).
- `squashLandedUnread`'s `detailText` says the commit DID land and a re-confirm "should detect this as
  already merged" — see the double-land finding below for why that word is "should", not "will
  unconditionally", and what was actually checked — and now also names the SAME trust-freeze exposure
  `headMovedUnverified` has: neither the original refusal nor the ALREADY_MERGED re-confirm advances the
  mainline trust record, so a later landing on this repo will file the same HIGH alert, naming THIS
  commit specifically.

## The mainline trust-freeze finding (round 2, manager review note 1 — reproduced independently by 3 workers)

`confirmWorkerMergeTracked` only calls the mainline ledger/trust writers when the landing actually
succeeded: `recordMainlineLedgerEntryIfRepoUnchanged` requires `merge.ok && !merge.noop && merge.sha &&
merge.landedBase`, and `advanceMainlineWatermark` requires `mainlineCheckedTip && merge.ok && !merge.noop
&& merge.sha`. For `headMovedUnverified` and `squashLandedUnread`, `merge.ok` is `false` — so NEITHER call
happens for the original refusal. For `squashLandedUnread` specifically, the eventual ALREADY_MERGED
re-confirm (`merge.noop === true`) ALSO fails the `!merge.noop` gate on both writers — so a re-confirm
never retroactively records what op1 missed either.

The real commit landed on canonical main regardless (that is the whole premise of both flags). On
whatever landing attempt comes NEXT on this repo (any worker, any branch) — call it op-N — `checkMainlineMove`
runs first, as always, and in this exact scenario it is expected to classify the gap as "explained"
(`classifyMainlineMove`'s own content-based scan sees a structurally normal, correctly-trailered Loom
squash commit, not an anomaly) — so **`checkMainlineMove` itself does NOT file an alert here**; it passes
`checkedTip` (the earlier refusal's own commit sha) through to op-N's own landing. ONLY AFTER op-N's own
squash lands does `advanceMainlineWatermark(…, checkedTip, …)` run — and THIS is where the freeze actually
fires: it reads the per-branch TRUST record (`trustedBefore`, a value separate from the watermark
`checkMainlineMove` itself reads/writes), and because the earlier flagged commit was never added to the
Loom-owned ledger (`mainline_landed_commits` — the ledger write was skipped for the identical `merge.ok`
reason above), `isMainlineLedgerReachable(trustedBefore, checkedTip)` returns false. `trustedBefore !==
checkedTip` either. So `advanceMainlineWatermark` falls to its `else` branch and calls
`fileLandingTrustFreezeEvent` — a HIGH `mainline_moved_outside_loom` event, `evidence:
["untrusted-tip-mismatch"]`, `source: "landing-trust-freeze"` — naming the EARLIER flagged commit (a
genuine Loom-authored, Loom-trailered commit, not a foreign write) as the untrusted tip. Trust is NOT
re-stamped (the `else` branch never calls `setMainlineBranchTrust`), so it stays frozen at its old value —
and because the chain is now broken at the un-ledgered hop, every LATER landing on this repo re-triggers
the same freeze (deduped per episode) until a human clears it via the mainline-watermark reset route
(`POST /api/projects/:id/mainline-watermark/reset`), which also re-stamps trust as a byproduct.

**Round 1 of this card wrongly attributed this alert to `checkMainlineMove` ("the mainline tripwire").**
That function's own git-content classification is a DIFFERENT, more permissive check than the per-branch
trust record `advanceMainlineWatermark` enforces — this scenario is specifically the case round 19-21 of
decision `2a6a292a` hardened against (a legitimate-looking commit that is nonetheless NOT in the trusted
ledger chain). The correct attribution is `advanceMainlineWatermark`'s own landing-trust-freeze, fired on
a LATER, unrelated landing's own success — not a check performed at the moment of THIS refusal, and not
something that blocks or delays that later landing either (the freeze event is filed alongside/after that
landing proceeds normally).

**This is a real, not-yet-closed exposure. It is NOT fixed by this card** — the real fix (teaching the
ledger/trust-advance path to recognize a `headMovedUnverified`/`squashLandedUnread` commit as Loom's own,
e.g. by still recording the ledger entry for a verified-own commit even when the overall result is
`ok:false`) is carded separately. This card's own scope is honest WORDING about the exposure, not closing
it.

## The double-land finding

Manager ruling (card 08c36dae review note 3) required checking, AT SOURCE, whether a re-confirm of the
same worker after a `squashLandedUnread` refusal could land a DUPLICATE commit, since the commit really
did land but this call never confirmed it. Checked `findLandedSquashCommit` (`git/worktrees.ts` ~L8069-8166):
on a re-confirm the squash target (`squashTarget`/`resolvedBranchHead`) is unchanged, so `git merge
--squash` against a HEAD that already carries the branch's content stages NOTHING — this reaches the
`!staged` / "genuine no-op" branch, which calls `findLandedSquashCommit`. Its branch-present verify arm
(`branchPresent === true`, since the worker's branch still exists) does NOT trust trailer presence alone —
it runs `branchContentLandedInCommit`, a REAL content-reachability check (the candidate commit's actual
tree content, not just its trailer text) against the live branch. Since the commit that landed under the
`squashLandedUnread` refusal genuinely does carry the branch's real content, this check passes and the
re-confirm resolves `ALREADY_MERGED`, never a second squash. Verified empirically:
`merge-confirm-squash-landed-unread.mjs` part (B) asserts canonical HEAD is BYTE-IDENTICAL after the
re-confirm to the sha that landed under the unread failure, and that `git rev-list --count HEAD` does not
grow. **Round 2 addition:** this ALREADY_MERGED re-confirm does NOT clear the trust-freeze exposure above
— it fails the exact same `!merge.noop` gate that skips the ledger/trust writers, verified directly in the
test at the DB level (`db.getMainlineBranchTrust(...)` stays `null` after both op1 and op2).

## The never-cached discrimination findings (round 2, manager review note 2)

**Round 1's claim that all three new tests "caught the caching gap" independently was imprecise — corrected
here to state what is actually proven, per the manager's instruction.**

Only TWO of the three tests actually discriminate (fail when the outcome string is removed from
`NEVER_CACHED_OUTCOMES`), and only after a real bug in one of them was fixed:

- **`merge-confirm-canonical-trust-refusal.mjs`** genuinely discriminates. The fault here is EXTERNAL
  (a registered commondir-trust-pin lookup) and never changes canonical main's own tip, so op1's and
  op2's `verdictIdentity` (keyed on branch tip + main tip) are identical by construction — the ONLY thing
  that can make op2 re-attempt instead of replaying op1's cached rejection is `canonicalTrustRefusal`'s
  membership in `NEVER_CACHED_OUTCOMES`. Verified via a throwaway mutation (temporarily removing
  `"canonical-trust-refusal"` from the Set, rebuilding, re-running): the test goes RED exactly as
  expected (op2 replays op1's rejection; `cacheHit` is now set).
- **`merge-confirm-head-moved-unverified.mjs` was NOT discriminating as originally written, and the
  manager's reviewers reproduced it (dropping the outcome from the Set left it green).** Root cause: part
  (B)'s "fault clears" step reset canonical HEAD to `divertedSha` — the racer's own sha, which is already
  the live HEAD, making that `git reset --hard` a no-op. Op2's own fresh `verdictIdentity` therefore read
  a DIFFERENT main tip than op1's stored identity (op1's was captured before the squash, at the ORIGINAL
  pre-incident `mainSha`) — a structural identity mismatch that forces a fresh mint regardless of
  `NEVER_CACHED_OUTCOMES` membership, making the "never cached" check vacuous. **Fixed** by resetting to
  the ORIGINAL pre-incident `mainSha` instead, so op2's identity exactly matches op1's — now the ONLY
  variable is the Set membership. Verified via the same throwaway-mutation technique: with the fix in
  place, removing `"head-moved-unverified"` from the Set turns the test RED (replay, `cacheHit` set);
  restoring it returns GREEN.
- **`merge-confirm-squash-landed-unread.mjs` is NOT independently discriminating, and cannot be made so
  without misrepresenting the real remedy.** Reaching `squashLandedUnread` at all REQUIRES the squash
  commit to have already landed — main's tip necessarily differs, structurally, between whatever it was
  when op1's own `verdictIdentity` was captured (pre-squash) and what it actually is afterward (post-
  squash). There is no "reset HEAD back to the pre-incident tip" remedy analogous to the head-moved case,
  because doing so would DISCARD a real, legitimately-landed commit — not a plausible production remedy,
  and not what this test should pretend to exercise. Verified via the same throwaway-mutation technique:
  removing `"squash-landed-unread"` from the Set leaves the test fully GREEN regardless — confirming
  caching is structurally inert for this outcome, not merely untested. The string stays in
  `NEVER_CACHED_OUTCOMES` for documentation/consistency with its two siblings, not because this test
  proves it load-bearing.

## merge-gate.mjs and the live-daemon gap

`merge-gate.mjs` requires a live daemon (`requireHermeticEnv({ port: true })`, drives `worker_merge_confirm`
over a real MCP/HTTP connection) and so could not be run under the standing "never boot a daemon"
constraint. Its own assertions (`(1) ... FAIL path ... canonical repo untouched, worktree retained`) target
a GENUINE gate-command failure (a real `exit 1` test command) — the generic `merge_failed`/conflict
fallthrough this card deliberately leaves unchanged, never one of this card's three new flag sites. The
full merge gate running this file is not expected to flip on this change.

## Do not

- Do not classify a canonical-git trust refusal (`canonicalTrustRefusal`) by matching `reason`/`detailText`
  against known wording — always `instanceof CanonicalGitRefusal` at the throw site. A worker-plantable
  commit-msg/merge-driver hook can forge arbitrary stderr text that would otherwise defeat a text match.
- Do not say "canonical repo and worktree are untouched" (or any equivalent claim) for a refusal where
  residue, a foreign commit, or an unconfirmed-but-real commit is possible — `headMovedUnverified` and
  `squashLandedUnread` both exist specifically because the generic fallthrough's unconditional "untouched"
  claim was false for them.
- Do not add a flag to `mergeBranchLocked`'s return type without ALSO adding it to BOTH
  `confirmWorkerMergeTracked`'s `classifyOutcome` ternary (`sessions/service.ts`) AND `NEVER_CACHED_OUTCOMES`
  (`orchestration/pending-ops.ts`) if the refusal describes the CANONICAL CHECKOUT's transient state rather
  than a stable fact about the branch — otherwise it silently falls through to the generic `"rejected"`
  classification and gets cached under the until-superseded verdict cache, serving a stale refusal forever
  after the condition clears.
- Do not assume `squashLandedUnread`'s re-confirm is safe without the FULL argument: it relies on
  `findLandedSquashCommit`'s branch-present arm running a real content check
  (`branchContentLandedInCommit`), not merely trailer presence — if that check is ever weakened to trust
  trailers alone, this card's "no double-land" claim no longer holds and must be re-verified.
- Do not re-explain `canonicalFailureMessage`'s own remedy text inside `confirmWorkerMergeTracked`'s
  `canonicalTrustRefusal` branch — read `merge.reason` for the specific, already-correct guidance; a second,
  hand-written copy of that guidance will drift from the real one over time.
- **Do not treat `squashLandedUnread`'s (or `headMovedUnverified`'s) ALREADY_MERGED/later-landing path as
  clearing the mainline trust freeze.** Both the original refusal and any later ALREADY_MERGED re-confirm
  skip the ledger/trust writers identically (the same `merge.ok`/`!merge.noop` gates) — only a human
  mainline-watermark reset actually clears it. The real fix for the underlying exposure is a separate card.
- Do not attribute the next-landing mainline-moved alert for either flag to `checkMainlineMove` ("the
  mainline tripwire") — it is `advanceMainlineWatermark`'s own landing-trust-freeze, fired on a LATER,
  unrelated landing's own success, never at the moment of the original refusal, and never blocking
  anything (nothing holds a subsequent merge from running in the meantime).
- Do not design a "never-cached" discrimination test's own fault-clears step around whatever sha happens
  to already be on disk — verify it actually restores the SAME `verdictIdentity` (branch tip + main tip)
  the original op was cached under, or a structural identity mismatch can make the test pass vacuously
  regardless of whether the production fix (the `NEVER_CACHED_OUTCOMES` entry) is even present. Prove
  genuine discrimination with a throwaway mutation (temporarily drop the outcome string, rebuild, re-run,
  expect RED; restore, rebuild, confirm GREEN) rather than trusting the test's own green by inspection.
- Do not assume every member of `NEVER_CACHED_OUTCOMES` is independently provable as load-bearing by a
  dedicated test — `squash-landed-unread` is a real, deliberate counterexample: it is structurally
  impossible for its own caching exclusion to ever matter, because reaching that outcome at all already
  guarantees the verdictIdentity can never repeat. State that reasoning plainly rather than manufacturing
  a test that looks like it proves something it cannot.
