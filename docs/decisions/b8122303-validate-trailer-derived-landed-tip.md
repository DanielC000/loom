# b8122303 — validate a trailer-derived landed tip as an exact object id before use; guard new raw uses

Phase 2 of card `65b2b002` (landed `148082e01`, "fix(git): end option parsing before revision ranges in
diff path queries"). This card's own investigation (checkpointed via `worker_report(blocked)` and
approved by the manager) found that both of its originally-named call sites — `findLandedSquashCommit`
(`Loom-Worker-Base`) and `resolveMergedCommitMapHit` (`hit.baseSha`) — were **already fully covered** by
card `c0d0eac9` (landed `e30b9913b`, "fix(git): pick the newest verified landing when strict and tolerant
hits compete"), rounds 5-7: both route through the shared `verifyGoneBranchLanding` →
`verifyPersistedPathSet` (`packages/daemon/src/git/worktrees.ts`), which already resolves a
`baseOverride` via `rev-parse --verify --quiet <id>^{object}`, requires the resolved stdout to equal the
literal input EXACTLY, and requires the resolved object type to be `"commit"` (never peels a tag).

What was missing: the SAME class of gap — shape-validated-at-parse but not exact-match-resolved — existed
for `Loom-Landed-Tip` (`candidate.trailers.landedTip`), which reaches git revision arguments directly
inside `verifyReviewedTipChain` (`packages/daemon/src/git/worktrees.ts`, called from
`attributeStaleGenerationOwnLanding` in `packages/daemon/src/sessions/service.ts`). A 41-64-hex
`Loom-Landed-Tip` value can resolve as a REF NAME instead of the literal object id when a same-named ref
also exists in the shared, worker-writable `.git` (the same ambiguity `c0d0eac9` round 7 closed for
`Loom-Worker-Base`).

## The fix

`resolveExactTrailerObjectId` (`worktrees.ts`, just above `verifyPersistedPathSet`) is the ONE shared
helper, extracted from `verifyPersistedPathSet`'s own inline `baseOverride` logic: shape check
(`OBJECT_ID_SHAPE_RE`) → `rev-parse --verify --quiet <id>^{object}` → exact-match the resolved stdout
against the literal input → `cat-file -t` must read `"commit"`. `verifyPersistedPathSet` now calls it for
`baseOverride`; `verifyReviewedTipChain` now calls it for `live` **at its own entry**, before the hop
walk — a validation failure returns `{ok: false, reason: ...}` (fail-closed: the chain is not ok), never a
thrown error. This closes the gap for ALL THREE of `verifyReviewedTipChain`'s callers uniformly (the other
two already pass a git-resolved value, so the added check is a no-op hardening for them, not a behavior
change), not just the `landedTip` caller — the validation is parameter-scoped, not caller-scoped, by
design: a revision argument must prove itself regardless of which caller supplied it.

`attributeStaleGenerationOwnLanding` (`sessions/service.ts`) itself is UNCHANGED — its call to
`verifyReviewedTipChain(repoPath, reviewedTip, candidate.trailers.landedTip, ...)` needed no edit, by
design (card `1cf79e64` was concurrently editing that exact function; the fix lives entirely in
`worktrees.ts` to avoid colliding with it).

## Severity note (recorded honestly, not inflated)

Even before this fix, a falsely-resolved `landedTip` could only ever gate entry to
`attributeStaleGenerationOwnLanding`'s own content check (`recordedTipContentLanded` /
`stampedPathsPlausible`), both parameterized on `candidate.sha` (git-log-resolved) and `reviewedTip` (a
DB-stored value) — never on `landedTip` itself. So this gap could not, by itself, forge a false
`"attributed"` result; it is fixed anyway, for the same reason `c0d0eac9` fixed the identical ambiguity
for `Loom-Worker-Base` — a revision argument must never reach git unvalidated, regardless of whether a
downstream check happens to catch the forgery too.

## The new guard: `trailer-derived-value-git-argv-guard.mjs`

A corpus-wide, comment-stripped source-text scan of `packages/daemon/src/**/*.ts` asserting that every
*occurrence* (not merely every matching line — see "Round 2" below) of `trailers.base`/`trailers.landedTip`/
`trailers.pathSet`, `.baseSha`, a direct `parseLoomTrailerBlock(...)?.`/`tolerantFindLoomTrailerBlock(...)?.`
producer chain onto one of those three fields, or a `readLandedTipTrailer(` call, matches a named site in
an explicit allowlist — each entry carries **file + pattern name + exact occurrence count** (never a line
number: a line's content can shift, and the count is what the scan actually re-derives and compares) plus
a reason. A stale entry (one whose count no longer matches, in EITHER direction) fails exactly as loudly
as a genuinely new, unlisted site — the guard re-derives the allowlist's own claims at scan time rather
than trusting them.

**Why `STATIC_GUARD_REPO_PATHS`, not `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`** (Code Review correction,
reviewer 201f0fa5): this guard's own comment-stripped-whole-file-scan shape is `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`'s
own documented shape-(3) EXEMPTION (`worktrees.ts`'s doc comment on that list: "an EXPLICIT comment-stripped
whole-file scan... already immune by construction; adding it here would be redundant with running it on
every reduced gate anyway" — citing `remote-trust-single-predicate-guard.mjs`/`harness-adapter-claude-literal-guard.mjs`,
both already unconditional members of `STATIC_GUARD_REPO_PATHS` for exactly this reason). A comment-only
diff cannot flip this guard's verdict, so it does not belong on the list that exists FOR tests vulnerable
to a comment-only diff. It belongs in `STATIC_GUARD_REPO_PATHS` instead, under THAT list's own membership
criterion (card `a1734000`, `worktrees.ts`'s doc comment on that array): a guard belongs there when
something OTHER than a behavioural `.ts` edit can invalidate what it asserts — here, a purely textual
refactor that does not change COMPILED behaviour (so `computeEmitCompareGate`'s own reduction proof would
not catch it) can still add, move, or remove one of this guard's six tracked shapes. Added to
`STATIC_GUARD_REPO_PATHS` on that ground, next to the two precedent guards cited above.

## Round 2 (Code Review, reviewer 201f0fa5 — SHIP with follow-ups, landed as new commits)

Four findings, all fixed in the same guard/test files (never by amending the round-1 commit):

1. **Occurrence counting, not per-line presence.** `scanText` used `p.re.test(ln)` — true/false per line,
   so a SECOND raw use added to an already-allowlisted line was invisible (that line kept reading as
   exactly one hit no matter how many real uses it carried). Rewritten to `String.matchAll` with a
   per-pattern global `RegExp`, so a line carrying the same pattern twice now reports two hits — proven by
   a positive control that reconstructs the OLD per-line result (1) against the NEW occurrence-counted
   result (2) on the identical doubled line.
   **Round 3 correction (Lead review):** this does NOT close a same-file SWAP — removing one validated
   occurrence and adding a DIFFERENT, unvalidated one elsewhere in the SAME file, same pattern — because
   the allowlist is keyed on `[file, pattern name, count]` only, with no line or site identity; the total
   count is unchanged and the guard cannot tell the two variants apart. Occurrence counting closes a COUNT
   INCREASE (a second use on an existing site); it was never a fix for a same-count substitution, and the
   guard's own header/WHAT-IT-DOES-NOT-COVER list and a new executable `(C) NAMED LIMIT` control (next to
   the pre-existing alias-limit control) now say so directly, with the limit demonstrated rather than only
   asserted. Deliberately NOT closed by keying on line numbers — that would churn the guard on every
   unrelated edit; stating the limit honestly is the fix, per the Lead's explicit ruling.
2. **Guard honesty — the producer shape.** The guard could not see `readLandedTipTrailer`'s own
   `parseLoomTrailerBlock(body)?.landedTip` (`git/worktrees.ts` ~line 4332) — a trailer field read straight
   off the parse call's result, with no `trailers` identifier for the original four patterns to anchor on.
   That function's return value flows to `sessions/service.ts`'s `heldRecordedTip` (~line 21890) ->
   `resolveOwedRange`'s `base` (~line 21901), which DOES reach `resolveGitRef`/`isAncestorCommit` (~lines
   21908-21909) with none of this card's exact-match validation, and separately to
   `pinnedTipForLandedSquash` (~line 22007). Two new patterns now cover this: a direct
   `parseLoomTrailerBlock(...)?.`/`tolerantFindLoomTrailerBlock(...)?.` chain onto `landedTip`/`base`/
   `pathSet` (never `.branch`, which is never used as a revision), and a `readLandedTipTrailer(` call —
   all three real sites (the worktrees.ts producer + the two service.ts consumers) are now visible to the
   guard and allowlisted with a reason, **not fixed**: the reviewer judged this flow NOT exploitable as the
   same ref-name forgery, because it reads a LANDING COMMIT's own `Loom-Landed-Tip` trailer (never
   attacker-controlled worker content — `112b8d5d` strips worker-authored commit subjects before this
   trailer is ever stamped). Validating this producer is a SEPARATE follow-up card the manager is filing;
   out of scope here on purpose.
3. **The realistic exploit shape.** Round 1's `(LANDEDTIP-REF-NAME-SHAPE)` test only covered `reviewed ===
   live` (both the identical 50-hex forged text) — which the OLD code's trivial `cur === reviewed` string
   fast path would have accepted WITHOUT ever reaching the ref-name ambiguity at all, so it never actually
   exercised the real bug. Added the realistic shape: `reviewed` is a REAL, different commit, and `live`
   is the ref-name-shaped forgery that resolves (via the planted ref) to that SAME commit — `reviewed !==
   live` as literal text, so the fast path never fires, and the OLD code instead reached
   `reachable(cur, mainRef)` / `reachable(reviewed, cur)`, where the ref-resolved `cur` made BOTH
   trivially true against `reviewed` — a forged `chain-ok`, pre-fix. The original `reviewed === live` case
   is kept alongside it (it still proves the entry check runs before the string-equality fast path).
4. **This record's own wording** previously said the guard belongs in `CHANGED_TS_TEXT_SCANNER_REPO_PATHS`
   (contradicting the code, which adds it to `STATIC_GUARD_REPO_PATHS`) and described allowlist entries as
   carrying `file:line` (they carry file + pattern name + exact count). Both corrected above, in "The new
   guard" section — see that section for the `a1734000`/`STATIC_GUARD_REPO_PATHS` citation.

## Do not

- Do not re-implement `resolveExactTrailerObjectId`'s resolve-and-exact-match logic a second time at a
  third call site — add the new call site to this function's own callers and, if the guard's allowlist
  needs a new entry, add it there with a reason, never by copying the validation inline.
- Do not widen `verifyReviewedTipChain`'s entry validation to skip it for a "trusted" caller — the
  validation is on the PARAMETER, not the CALLER; a future caller passing an unvalidated value gets the
  same protection for free specifically because the check does not ask who's calling.
- Do not read a `"fail"` from `verifyPersistedPathSet` or a `{ok: false}` from `verifyReviewedTipChain` on
  a validation miss as a transient/error state — it is the candidate's own claim being false, a
  DEFINITIVE rejection (matching `c0d0eac9`'s own round-5 "Do not" on this exact point).
- Do not let `trailer-derived-value-git-argv-guard.mjs`'s allowlist entries go unverified when editing
  nearby code — a stale entry (naming a site that no longer reads the value, or no longer reaches git) is
  exactly as bad as a missing one; the guard must fail on either.
- Do not revert the guard's scan to a per-line `.test()` check "for simplicity" — round 2's own positive
  control exists specifically because that shape silently undercounts a line carrying the SAME pattern
  more than once (never a swap — see the round-3 correction above; a per-line check wouldn't catch a
  same-file swap either, so reverting loses real ground without gaining any new blindness).
- Do not read this guard's silence on an ALIASED trailer object (`const t = candidate.trailers; use(t.base)`)
  or on a SAME-FILE SWAP (removing one validated occurrence, adding a different unvalidated one elsewhere
  in the same file at an unchanged per-file-per-pattern count) as proof no such site exists — both are
  named, stated limits (no data-flow analysis, no site/line identity), not guarantees. Do not try to close
  the swap by keying the allowlist on line numbers instead — that churns the guard on every unrelated
  edit; the fix is stating the limit honestly (the header's WHAT IT DOES NOT COVER list, and an executable
  `(C) NAMED LIMIT` control demonstrating it), never a line-identity key.
- Do not treat the `readLandedTipTrailer`/`trailer-parse-chain` allowlist entries as validated just because
  the guard now sees them — it only proves they are NAMED; the producer-side validation they still need is
  the separate follow-up card referenced in Round 2, finding 2 above.
