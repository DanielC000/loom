# f8e11853 — arm foreign tmp residue that collapses onto a key freed by a clear

Found by `25d0d45b`'s final re-CR (`5ac3b82b`, 2026-10-28, PROBED), as an X fail-open window that exists
independently of that card's own reporting fix.

## The bug (reproduced hermetically before any fix was written)

Y is independently quarantined at key K_Y. X = `Y/ghost` (no own `.git`, so X's real canonical key is
always K_Y) has an armable foreign tmp residue filed under a WHOLLY DIFFERENT repo R's hash — never
K_Y's own hash. While Y occupies K_Y, X's content cannot arm in-process (`armForeignOrphanContentInMemoryIfUnenforced`
answers "already-enforced" via Y), so it stays boot-deferred on disk — `25d0d45b` round 4 correctly
discloses this as `contentKept` + `blockedBy: Y`.

When Y is then cleared, `deleteMergeQuarantineLatchByKey`'s own trailing sweep
(`sweepTmpResidueForHashIfUnreferenced`) only ever examined files matching `${hash(K_Y)}.json.tmp-` — it
never looked at R's hash. So X stayed FAIL-OPEN in-process (`assertRepoNotQuarantined(X)` reads
`{ok:true}`) right after Y's clear, while the next boot — which reads the WHOLE `MERGE_QUARANTINE_DIR`
directory and recomputes each file's own real identity, content-driven, never hash-driven (see
`1dd00dca`'s own record) — re-armed X at K_Y from the surviving residue. An in-process/reboot split.

Repro (own `LOOM_HOME`, real git repos, no mocking): `y` raised via `enterMergeQuarantine`; `r` a second,
unrelated real repo, never itself quarantined; `x = path.join(y, "ghost-subdir")`; X's armable tmp
planted at `hash(canonicalRepoLockKey(r))`. `clearMergeQuarantine(y)` → in-process `assertRepoNotQuarantined(x).ok
=== true`; a fresh `reenterMergeQuarantinesAtBoot([y, r])` → `assertRepoNotQuarantined(x).ok === false`.

## How residue for a freed key is FOUND, given that it lives under other hashes

There is no key→residue index. The only existing mechanism that finds "content canonicalising onto K"
regardless of which hash it is filed under is boot's own full-directory enumeration
(`reenterMergeQuarantinesAtBootImpl`: one `fs.readdirSync(MERGE_QUARANTINE_DIR)`, then per-file
`JSON.parse` + `repoPath` → `canonicalRepoLockKey` recompute, bucketed by the file's OWN real identity,
never by its filename hash).

The fix mirrors this at runtime, but only for the one call site that genuinely frees a key
(`deleteMergeQuarantineLatchByKey`'s own trailing sweep). Cost: a cheap `O(N)` readdir + filename-shape
filter (`N` = total files currently in `MERGE_QUARANTINE_DIR`, daemon-global, not project-scoped); the
EXPENSIVE part — `canonicalRepoLockKey`'s own ancestor `.git` walk, `O(D)` `fs.existsSync` calls (`D` =
path depth, small in practice) — runs only for files that survive the READ check first (the relevance
gate itself is what the walk computes; ownership and clearer-identity are decided only AFTER relevance,
so they never gate the walk — see "Round 2" below), which in a healthy fleet is a small, torn-write-
residue-only population (the same order of magnitude boot already walks on every single boot). This is
"boot-equivalent cost, now also paid once per key-freeing clear," not a new unbounded primitive.

## The fix

`sweepTmpResidueForHashIfUnreferenced` gains an optional trailing `freedKey?: string` parameter, passed
ONLY by `deleteMergeQuarantineLatchByKey`'s own call (merge-quarantine.ts ~:2926) — the one call site, of
5 real call sites (grepped directly, never trusted from a doc comment), that genuinely frees a key before
this sweep runs (true for BOTH an identity-wide human clear and a token-route full lift — see `25d0d45b`'s
own record). The other 4 call sites (`writeMergeQuarantineLatch`'s success sweep; `clearActiveEntryTokenAtKey`'s
partial-clear branch; `clearMergeQuarantineLatchFile`'s matchedPending branch and its no-match fallback)
pass nothing and are byte-identical to before this card.

When `freedKey` is set, a SECOND loop scans every tmp-residue-shaped file NOT matching this call's own
hash prefix. For each one whose own parsed content's `canonicalRepoLockKey` genuinely equals `freedKey`,
it is fed into the SAME per-identity decision pipeline the same-hash loop already uses — `orphanSweepSafeToDelete`
→ `armableByIdentity` union → `armForeignOrphanContentInMemoryIfUnenforced` → `classifyKeptRepoPath` — no
copy of that logic. A file that cannot be classified (unreadable, unparsable, no string `repoPath`, or
`canonicalRepoLockKey` itself throwing, via a new `canonicalKeyOrUndefined` wrapper) is left COMPLETELY
UNTOUCHED — never guessed into a delete, an arm, or a content-kept disclosure.

## Deletion discipline — what disposition a cross-hash file can reach, and why it is safe

The relevance gate (`residueKey === freedKey`) runs BEFORE any other decision, including the ownership
check — see "Round 2" below for why that ordering is load-bearing. Once a file is confirmed relevant, its
disposition is driven by the IDENTICAL `orphanSweepSafeToDelete`/`excludeIdentities` checks the same-hash
loop already runs on an analogous file — there are only three reachable outcomes, none of them new:

1. **Already owned** (some surviving entry's own `orphanLatchFiles` already lists it) → folded into
   `referencingRepoPaths`/`keptEntries`, same as the same-hash loop.
2. **The clearer's own content** (`excludeIdentities.has(identity)`) → `contentKeptEntries`, never armed
   — mirrors the same-hash "ownContent" branch exactly.
3. **Genuinely safe to delete** (every on-disk token already covered by `candidateTokens`/tombstoned) →
   unlinked. **Genuinely foreign and uncovered** → deferred, armed if armable (has `branch`+`reason`),
   classified via `classifyKeptRepoPath` after the arm phase, same as the same-hash loop.

Nothing about this branch invents a NEW disposition a same-hash file could not already reach — it only
widens WHICH files are examined, never WHAT happens to a file once examined.

## Round 2 (found during this card's own verification, before merge) — ownership check must run AFTER
## the relevance gate, never before

The first implementation ran the in-memory ownership check (does some surviving entry's `orphanLatchFiles`
already list this file) BEFORE confirming `residueKey === freedKey`. This is correct for the same-hash
loop (every file at that hash is, by construction, this call's own business) but WRONG for the cross-hash
loop: a file sitting at some unrelated hash, owned by a completely unrelated, unrelated-to-`freedKey`
surviving entry, would be unconditionally folded into THIS clear's own `stillBlockedCoOccupants` — pure
contamination from one block's own bookkeeping leaking into another's clear result. Caught by this card's
own test corpus (several scenarios share one `LOOM_HOME`/module instance in sequence, same convention as
every other `merge-quarantine-*.mjs` file) — the `unresolv-neg` scenario's own `clearResult` unexpectedly
carried an EARLIER scenario's own leftover entry. Fixed by moving the ownership check to run only AFTER
`residueKey === freedKey` is confirmed — a file irrelevant to this clear is `continue`d before its
ownership is even consulted.

## R-OCCUPIED-NEG — R itself genuinely, independently quarantined

Verified directly (own test scenario): when R (the hash X's residue happens to be misfiled under) is
ALSO independently, genuinely quarantined, Y's clear still correctly arms X — and R's own in-memory
entry (token set, repoPath/branch/reason) and on-disk latch file are BYTE-FOR-BYTE unchanged. This holds
structurally, not by luck: the cross-hash loop only ever examines tmp-residue-SHAPED filenames
(`TMP_RESIDUE_FILENAME_RE`, never a bare `.json` final latch), and R's own in-memory entry is never
mutated by this function at all — only ever read, for the ownership check.

## SCOPE-NEG — exact identity match, never "any foreign content lying around"

A cross-hash file whose own content canonicalises onto a DIFFERENT key (not `freedKey`) is never touched —
verified directly: W (`= Z/ghost`, Z independently quarantined) with its own residue misfiled under a
third repo's hash survives Y's clear untouched, and `stillBlockedEntryFor(w)` — which is naturally
non-undefined regardless of this card's fix, since W's canonical key is always Z's and Z is genuinely
quarantined — resolves to Z's own, real, pre-existing entry, with its own token set and `orphanLatchFiles`
never unioned with W's own residue content.

## CR Round 2 (post-merge Code Review) — the cross-hash `readFailed` branch must not run before the relevance gate either

The Round 2 fix above (ownership after relevance) left one more pre-relevance branch unmoved: a cross-hash
read failure (`safety.readFailed`) marked the basename `keptUnreadableLatchFiles` and set `anyUnattributed`
unconditionally, BEFORE `residueKey === freedKey` was ever checked — because relevance cannot be decided
without a successful read, there was no way to gate the read attempt itself on relevance. Reproduced
directly: Y quarantined; R an unrelated repo, never itself quarantined; a DIRECTORY (not a file) planted at
`${hash(K_R)}.json.tmp-<suffix>` forces `readFileSync` to throw EISDIR (portable on both Windows and
POSIX). `clearMergeQuarantine(y)` then falsely reported `latchKept`/`unattributed`, and the sticky
in-process mark could also change R's own later same-hash clear.

Fix: on a cross-hash read failure, log and `continue` — no mark, no flag, no disclosure. Relevance to
`freedKey` is simply left unprovable rather than assumed either way; the file is left completely untouched,
matching every OTHER unclassifiable cross-hash shape (malformed JSON, non-string `repoPath`) already
documented above under "Deletion discipline" and "UNRESOLVABLE-NEG". Pinned by (READFAILED-NEG) below,
including a same-hash differential (an untouched control repo with the identical EISDIR shape at its own
hash) proving R's own later clear reaches the identical disposition either way.

This round also added REGRESSION coverage for two things the original test corpus asserted correct but
never independently pinned: the Round-2 ordering fix itself (ownership after relevance — ORDER-NEG, with
mutant `ownerfirst`, which swaps the order back) and Disposition 1 from "Deletion discipline" above
("already owned" — OWNED-NEG, with mutant `ownedskip`, which still gates on relevance+ownership correctly
but silently drops the report on an owned hit instead of filling `referencingRepoPaths`/`keptEntries`).
Neither mutant required a production change — both findings were about missing test coverage for
already-correct behavior.

## Do not

- Do not widen `freedKey` to any of the other 4 call sites "for defensive symmetry" — only
  `deleteMergeQuarantineLatchByKey`'s own call genuinely frees a key before the sweep runs; the other 4
  keep the key occupied through the call (or free a PENDING-tier identity instead, see the next bullet).
- Do not fold the pending-tier analog (`clearMergeQuarantineLatchFile`'s own matchedPending branch, which
  frees a PENDING identity rather than an armed key) into this card's own scope — it is a plausible
  sibling gap, filed as its own follow-up card by the Lead. Do not re-derive or re-implement it here.
- Do not run the cross-hash loop's ownership check BEFORE confirming `residueKey === freedKey` — see
  "Round 2" above for the exact contamination this reopens.
- Do not mark/flag a cross-hash read failure the way the same-hash loop does (`keptUnreadableLatchFiles`/
  `anyUnattributed`) — see "CR Round 2" above for the false `latchKept` disclosure and sticky cross-repo
  contamination this reopens.
- Do not convert a cross-hash "owned" or "safe to delete" file into a NEW disposition the same-hash loop
  could not already reach for an analogous file — the three outcomes in "Deletion discipline" above are
  exhaustive; widening them here would be a behaviour change this card never intended.
- Do not read `canonicalKeyOrUndefined`'s own try/catch as proof that `canonicalRepoLockKey` is
  reachably throwable via some constructible `repoPath` string in this codebase — EMPIRICALLY it is not
  (`findExistingAncestorRealpath`'s own try/catch, repo-lock.ts, already swallows the one real throw
  point, `fs.realpathSync.native` on a NUL byte, before it can propagate). The wrapper is a correct,
  cheap defensive guard, not a RED-provable behaviour today — the test corpus exercises the reachable
  "returns nothing" shapes (malformed JSON, non-string `repoPath`) instead of a fabricated throw.
- Do not assume `TMP_RESIDUE_FILENAME_RE` needs to match an orphan `.json` final latch too — this card is
  scoped to `.tmp` residue only (per the card's own title/repro); an analogous orphan-`.json` cross-hash
  gap, if one exists, is a separate investigation.

## Tests

`packages/daemon/test/merge-quarantine-f8e11853-freed-key-cross-hash-residue.mjs`:
- (MAIN) the card's own repro: X armed in-process, matching a fresh boot's own derivation exactly
  (token set compared via `stillBlockedEntryFor`, never a bare `.ok`); `clearMergeQuarantine(y)`'s own
  result reports X via `stillBlockedCoOccupants` with a real `{id}` route, never `contentKeptRepoPaths`.
- (R-OCCUPIED-NEG) R genuinely, independently quarantined; R's own entry/token-set/latch-file bytes are
  unchanged after Y's clear arms X.
- (READFAILED-NEG, CR Round 2) an EISDIR directory planted at an unrelated repo's own hash is left
  completely untouched (no mark, no `latchKept`/`unattributed`); a differential against an untouched
  control repo proves the earlier cross-hash attempt leaves no sticky contamination on that repo's own
  later same-hash clear.
- (ORDER-NEG, CR Round 2) a surviving entry's own cross-hash file that is irrelevant to `freedKey` is
  never named by the clear — pinned via mutant `ownerfirst` (ownership checked before relevance).
- (OWNED-NEG, CR Round 2) a relevant cross-hash file already owned by a surviving entry is reported via
  that entry, never armed/dropped independently — pinned via mutant `ownedskip` (continues on an owned
  hit without filling `referencingRepoPaths`/`keptEntries`).
- (SCOPE-NEG) a cross-hash file belonging to a DIFFERENT key (Z's, not Y's) is never touched by Y's clear.
- (UNARM-NEG) a cross-hash residue matching `freedKey` but missing `branch` stays content-kept forever,
  never armed, with no new in-process/reboot split introduced for the unarmable shape either.
- (UNRESOLVABLE-NEG) malformed JSON and a non-string `repoPath` are both left byte-for-byte untouched,
  never reported anywhere in the clear result.
- (DELETE-SAFE) a cross-hash residue whose only token is already covered by the clearer's own cleared
  tokens is genuinely deleted — the same disposition the same-hash loop already reaches, now also
  reachable cross-hash.
- (non-freeing regression) a source-text count confirms `sweepTmpResidueForHashIfUnreferenced` still has
  exactly 5 real call sites (excluding its own declaration line).

Every crash-prone dereference in the RED phase is guarded (`?.`/early short-circuit) so a RED run fails
on real, visible assertions across every scenario rather than aborting partway with an uncaught
`TypeError` — confirmed directly (re-verified after the CR Round 2 additions above):
`node scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-f8e11853-freed-key-cross-hash-residue.mjs --ref 2e8420b4`
reports RED with 14 real assertion failures (`build ok`, not a build error) across every scenario, GREEN
restores all 53 checks, byte-identical tree confirmed. The CR Round 2 fix itself is pinned separately via
`--ref 4180cc93` (the pre-CR-Round-2 sha): RED with exactly 1 failure (the READFAILED-NEG disclosure
check), GREEN restores all 53, byte-identical tree confirmed.

Also fixed in the same diff: `merge-quarantine-25d0d45b-arm-foreign-tmp-residue-in-memory.mjs`'s own
`withDistMutation` EXCL-B find-text (pinned the exact pre-card call-site text, which this card's own
`freedKey` argument changed) — updated to match the new 7-argument call shape.

Full `merge-quarantine*.mjs` corpus (114 files, enumerated via `ls packages/daemon/test | grep
'^merge-quarantine'`, run individually by name — never a glob) green in both `env -u LOOM_DEV -u
LOOM_SUPERVISED` and `LOOM_DEV=1 LOOM_SUPERVISED=1` (228 total runs, 0 failures).
