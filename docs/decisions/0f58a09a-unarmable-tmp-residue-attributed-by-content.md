# 0f58a09a — boot attributes an UNARMABLE tmp residue by the repo its content names, not by its filename hash

Found by the `f8e11853` Code Review (follow-up A); behaves the same before and after that card. Sibling of
`f8e11853`, `cdcd55c2` (cross-hash residue on the in-process side) and `1dd00dca`.

## The bug (run RED before any fix)

X's tmp residue that parses as JSON and names `repoPath: X` but lacks `branch` (or `reason`) is misfiled
under an innocent repo R's hash. In-process nothing reads it, so R is open. On reboot, PASS 1b's tmp loop
threw at the field-shape check, lost the parsed identity, and its catch bucketed the file by the FILENAME
hash: `deferredCorruptTmps.push({f, matchedRepo: R})`. The resolver then armed a corrupt placeholder for R
("quarantining THAT repo"), durably wrote it, and unlinked the tmp. Two failures, not one:

- R, which did nothing wrong, was fail-closed quarantined (in-process vs reboot split);
- X's real record was DESTROYED (the tmp was the only copy), so X ended up not blocked at all (fail-open).

Armable files are already attributed by content (entry built from `parsed.repoPath`, keyed by
`canonicalRepoLockKey(entry.repoPath)`, grouped by that key); only the throw path fell back to the filename.

## The fix

PASS 1b records `contentIdentity = parsed.repoPath` when the bytes parse to an object whose `repoPath` is a
non-empty ABSOLUTE path string, before the field-shape throw. The catch then pushes
`{f, matchedRepo: contentIdentity, byContent: true}` onto `deferredCorruptTmps` and skips the filename-hash
cascade. The existing resolver does the rest for X: resolvable → placeholder armed at key(X), durably
written, THEN the tmp unlinked (`deleteSourceLatchIfSuperseded`); unresolvable → pending entry for X with the
tmp kept as written. `byContent` makes `verified = true` (no spurious `provenanceUnknown`, no legacy-hash
match, which would be meaningless for a misfiled file).

## Round 2 (Code Review)

- **S1 closed.** The early "stale tmp beside an already-clean final" branch runs BEFORE attribution, and a
  TOKENLESS record trivially passes `orphanSweepSafeToDelete`'s subset test (`[].every()`), so it was unlinked
  and X failed open. Now `namesOtherRepo` (parsed repoPath absolute AND `canonicalRepoLockKey` differs from the
  hash-matched repo's) keeps the tmp out of that delete; it falls through to attribution. Run-RED scenario
  `(s1)`; behavioural mutant `namesOtherRepo` forced false ⇒ 2 failing assertions. Residual: an unarmable file
  naming another repo whose tokens are all tombstoned is also kept and yields a clearable X placeholder.
- **Scope of `byContent` is the field-shape throw ONLY** (identity captured immediately before that throw); a
  later throw for an otherwise-armable record keeps the filename cascade. Not covered by a dedicated test.
- **Resolver wording** (logs and the DURABLE placeholder `reason`) branches on `byContent`: it says the
  identity came from the file's content. Only when it is genuinely misfiled (a `misfiled` bit carried beside
  `byContent`: the named repo's own hash differs from the file's) do they add that the file sat at another
  repo's hash; R's own branchless record at R's own hash gets neutral wording ("whose content names this repo").
- Added tests: write-failure (rename of X's latch fails ⇒ tmp kept, X blocked in memory, R open) and X already
  holding a real latch (tmp folds into key(X), X's real tokens unchanged).

## Known asymmetry: in-process vs reboot

X's unarmable residue is content-kept (not armed) in-process (`f8e11853`), while a reboot now fail-closes X.
Safe direction (more conservative), and R is open on both sides. Closing it means arming a placeholder at
clear time; that is a separate follow-up card, `63569b55`.
The `f8e11853` test's `(unarm-neg)` scenario was updated to pin the new reboot verdict, including that X is a
ghost subdir of Y so the reboot re-blocks Y via key(Y) and one `clear(y)` lifts both.

## Truly corrupt files (no content identity)

Unparsable bytes, non-object JSON, a missing/non-string/empty/relative `repoPath`: unchanged, fail closed to
the filename-hash claimant (and the existing unresolvable-claimant / ancestor / orphan tiers). Safety
argument: the hash is then the only provenance claim, and Loom writes a tmp at its own key's hash, so an
unparsable file there is overwhelmingly a torn write of that repo's own latch. Failing open risks silently
losing a real quarantine; failing closed costs a recoverable human clear. Residual (not closed): a misfiled
AND wholly unparsable file still blocks the claimant; nothing in it can say otherwise.

## Known siblings: investigated (card `ac6427d5`), NOT fixed — tampering-only

Same parse-then-throw shape, same filename-hash fallback: PASS 1's final `.json` read (`latch JSON is
missing repoPath/branch/reason`) and the safety-tmp recovery loop (`safety-tmp latch JSON is missing ...`).

**RED when hand-planted.** X's branchless record `{repoPath: X, reason, tokens}` planted at R's hash, then
`reenterMergeQuarantinesAtBoot([R, X])` (repro: `C:\Users\danie\.loom-projects\c36e8691-44d8-44ae-91ed-1bae3c632b33\ac6427d5\repro-ac6427d5.mjs`,
run once per shape; the ordinary-tmp control shows the fixed PASS 1b behaviour):

| planted as | R | X | file |
|---|---|---|---|
| final `<Rhash>.json` | blocked | OPEN | survives |
| safety-tmp `<Rhash>.json.tmp-safety-…` | blocked | OPEN | **unlinked (X's only copy lost)** |
| ordinary tmp (control, fixed) | open | blocked | unlinked after X armed |

So at the safety-tmp site this is not purely fail-closed: X fails open and its record is destroyed.

**Why it is not reachable by Loom itself.** Hitting it needs a record that parses but lacks `branch` or
`reason`. Both fields have been required on `MergeQuarantineEntry` since the file's first commit
(`484e68f14`), every writer (`writeMergeQuarantineLatch`, `writeSafetyTmpResidueAtHash`) persists the full
entry, and a torn write is unparsable (no content identity under either rule). Getting there takes manual
tampering with `LOOM_HOME` (dropping a field AND moving the file).

**Unproven corner.** Every `writeSafetyTmpResidueAtHash` caller's hash derivation was not enumerated. A
misfile by that route would be a COMPLETE record, which parses and is already attributed by `parsed.repoPath`
on the armable path, so it does not reach this throw.

**Verdict:** not fixed. Accepted residual, tampering-only. If a Loom writer is ever found to emit a
field-missing record, apply this card's rule at both sites with the same controls (absolute `repoPath` only,
filename-claimant fallback otherwise, unlink only after the content owner is durably armed).

## Follow-up: ad66e57e

A fully tombstoned unarmable record is now disposed of instead of placeholdered; see
`ad66e57e-tombstone-filter-unarmable-content-tokens.md`. That disposal deliberately unlinks with NO
superseding write: the durable tombstone is the supersession proof, mirroring the armable branch.

## Not done

No token salvage: X's placeholder carries a fresh token, not the original (the file had no usable `branch`).

## Do not

- Do not treat a relative, empty or non-string `repoPath` as an identity.
- Do not unlink the misfiled tmp before X's placeholder/pending entry is durably written.
- Do not let `byContent` fall through to `legacyMatchStillResolvesToHash` (it would mark X provenanceUnknown).
