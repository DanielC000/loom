# 028837ad — lift a cleared token from a pending identity armed PENDING mid-`clearMergeQuarantineByToken`

**SUPERSEDED-BY-5d0820c7 (the narrow-record guard only):** this record's own "never widen
`ArmableOrphanRecord`" ruling (Round 3, and in the "Do not" section below) is satisfied, not violated, by
`5d0820c7`'s own fix — routing the arm's record-building through the ALREADY-EXISTING
`latchEntryFromParsedRecord` helper, rather than a third hand-mirrored field list, is exactly what Round
3's own "fix the WRITE instead" ruling was protecting against hand-mirroring from recurring. Round 3's
own "Accepted, NAMED, pre-existing, OUT-OF-SCOPE residual (tracked on card `5d0820c7`)" paragraph already
named this as the deferred continuation. Every write-side fix in THIS record (the rebase-onto-disk
mechanism, `rebaseOntoRealDiskRecord`, the token-union fix) is UNCHANGED and still binding.

Found by `1dd00dca`'s own round-3 narrow re-CR (`efbfe9d1`, 2026-10-28, PROBED) as a follow-up, not a
blocker on that round. Investigate-first card; PRE-EXISTING, not a regression — the same strand existed
before `1dd00dca`/`25d0d45b` too, just reached via boot instead of an in-process arm.

## The bug

`clearMergeQuarantineByToken` (`merge-quarantine.ts`) computes `nonTwinPendingIndices` — the set of
pending entries this call's own by-token sweep should also clear — ONCE, at the top of the function,
**before** the active-entry loop runs. That active loop (per the existing `@decision 1dd00dca` guard
comment at the loop itself) iterates the live `activeQuarantines` `Map` directly, so it naturally
re-visits any entry a mid-iteration insert adds (e.g. a resolvable foreign orphan armed by
`armForeignOrphanContentInMemoryIfUnenforced`, itself reached transitively through the loop's own
`clearActiveEntryTokenAtKey` → `clearMergeQuarantineByKey` delegation on a full lift).

`pendingUnresolvedQuarantines` is a plain array with no equivalent live-revisit mechanism.
`nonTwinPendingIndices`'s own snapshot was taken before any such mid-call arm could exist, so an
**unresolvable** foreign identity T — armed PENDING (not active) during the SAME call, carrying the raw
on-disk token set `[tA, tF]` (A's own just-released token, plus T's own real token) — is invisible to
that already-completed pending pass. T keeps `tA` forever: its OWN later clear (releasing `tF`) reduces it
to `[tA]` only, and nothing ever lifts a dead raiser's token from it again short of a human `/clear`.

A **resolvable** foreign T self-recovers today precisely because it lands in `activeQuarantines`, not
`pendingUnresolvedQuarantines` — the SAME active loop the arm happened inside re-visits it before the
call returns (see `merge-quarantine-1dd00dca-arm-foreign-orphan-in-memory.mjs`'s own scenario H1, the
`*** LOAD-BEARING PIN ***` check). This card closes the identical gap for the PENDING side.

**Verified pre-existing, not a regression:** before `1dd00dca`, `armForeignOrphanContentInMemoryIfUnenforced`
did not exist and nothing armed T in-process at all — the SAME on-disk bytes (`O`, untouched) would have
stranded T on `tA` at the next boot's PASS 1 regardless. `1dd00dca`/`25d0d45b` made T visible WITHIN the
process sooner; they did not create or widen the strand itself.

**Same gap, same single fix site, for the `.tmp-residue` twin (`25d0d45b`):** `sweepTmpResidueForHashIfUnreferenced`'s
own kept-and-armed branch calls the SAME `armForeignOrphanContentInMemoryIfUnenforced` helper, pushing
into the SAME `pendingUnresolvedQuarantines` array, reachable from the SAME active loop (via
`clearActiveEntryTokenAtKey`'s own partial-clear sweep, and via `clearMergeQuarantineByKey`'s own trailing
sweep on a full lift). The defect lives entirely in `clearMergeQuarantineByToken`'s own single snapshot
gap, not in which inner sweep did the arming — proven by an EXECUTED repro for the ARM path on both sides
(the orphan path directly; the tmp-residue side via CONTRIB-TMP's own PARTIAL reduce specifically — see
"Round 2" below for why a full-lift construction there proves nothing about this card's own arm at all),
never inferred from the orphan path alone.

## The fix

A fresh, independent SECOND pending pass, added right after the active loop in
`clearMergeQuarantineByToken`: re-derive `activeMatches` from scratch (post-loop) and re-collect pending
indices the same way the pre-loop pass does, then run them through the SAME shared
`clearTokenFromPendingIndices` body again. **Never a reorder of the existing pre-loop pass** — that pass's
own `activeMatches` identities are captured BEFORE the active loop runs, and `replaceEntryEverywhere`
(inside `clearActiveEntryTokenAtKey`) repoints a genuine dual-tracked twin's pending reference onto a NEW
object during that loop; reusing the stale `activeMatches` set after the loop would misclassify that twin.
A fresh post-loop scan naturally finds nothing left to exclude for a genuine twin, because the active loop
has already reduced any twin's shared entry below the token being cleared by the time this second pass
runs (verified directly — see the Twin Guard scenario).

**A SECOND, real regression was found and fixed before landing (caught by running every test file that
calls `clearMergeQuarantineByToken` directly, not just the new/dedicated ones):** a bare `collectPendingIndices`
filter on the post-loop pass also matched `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs`'s
own S3a scenario — a pre-existing, CR-reviewed, deliberately AMBIGUOUS multi-record identity (two live
pending records sharing one identity, only one of which happens to hold the cleared token after an
ASSIGN-not-splice reassignment). That scenario's OWN re-resolution safety (`clearTokenFromPendingIndices`'s
`!pendingUnresolvedQuarantines.includes(pending)` branch) exists specifically to fail closed on this exact
ambiguity — but it only engages for a STALE captured reference; a fresh, non-stale index lookup (which is
all the post-loop pass's own call ever produces, since nothing mutates between collecting its indices and
invoking `clearTokenFromPendingIndices` on them) never reaches that branch at all, so it silently "resolved"
what the original design deliberately left ambiguous — reproduced as a genuine regression (RED on the fixed
code, GREEN on `git checkout HEAD --`-reverted pre-fix code, confirmed by direct `node` runs of both).

**The fix for this second regression (as it now stands — superseded once in Round 3, see below, and
NARROWED by `58a3f730`):** exclude, from the post-loop pass, any identity whose pending record ALREADY
HELD `token` in `pendingUnresolvedQuarantines` at CALL START (`identitiesPendingBeforeCall`, captured
before even the pre-loop pass runs — Round 3 moved this earlier still; see Round 3's own B-1 section for
why "right after the pre-loop pass" was itself still too late). This is safe and sufficient for
`armForeignOrphanContentInMemoryIfUnenforced` specifically, because it itself gates on
`stillBlockedEntryFor` — a genuinely NEW mid-call arm can only ever happen for an identity with ZERO live
representation (active or pending) anywhere at arm time, so excluding an identity that already held
`token` can never exclude THIS pass's own bug-fix target. **It is NOT a safety argument for every other
mechanism that can mutate a pending record mid-call, and the broader original criterion here — "any
identity already represented at call start," regardless of whether it held `token` — was FALSIFIED by
`58a3f730`:** the pre-existing relocate-foreign-occupant path (`c9114934`/`d4b25feb`) can fold `token` into
an ALREADY-pending identity's existing record, which that broader criterion wrongly excluded too,
permanently stranding it. See `docs/decisions/58a3f730-lift-a-token-relocated-into-an-already-pending-record.md`
for the narrowed, now-correct criterion and why it stays identity-keyed rather than record/reference-keyed.

**The durability mechanism — why a reboot does NOT re-arm `tA` from `O`'s on-disk bytes:** the re-invoked
`clearTokenFromPendingIndices`'s own "reduce" branch calls `writePendingDivertFile(live.sourceFile,
updated, new Set([token]))` (`merge-quarantine.ts:4771`). As of Round 3, `writePendingDivertFile` (`:3055`)
does NOT write `updated` (the in-memory, arm-derived record) verbatim — it REBASES onto `live.sourceFile`'s
own REAL on-disk record and drops only the token(s) being released from THAT record's own tokens; see
Round 3's own B-1 section for why writing the in-memory record directly was itself a durable fail-open.
A later boot therefore reads `O`'s NEW, already-reduced content — built from the SAME full on-disk record
the arm itself only ever modeled narrowly — never the stale `[tA, tF]` bytes and never a content silently
narrowed to what the arm happened to carry.

## Round 2 (Code Review of `de7a0f48`) — 2 BLOCKING + 1 SHOULD, all fixed/addressed

**BLOCKING 1 — the strand survives when the arm happens in the PRE-LOOP pass, not the active loop.**
`identitiesPendingBeforeActiveLoop` (the round-1 name) was captured AFTER the pre-loop
`clearTokenFromPendingIndices(nonTwinPendingIndices, token)` call — but THAT pass's own "remove" branch
(a pending identity's own full lift) ALSO sweeps orphan files (`sweepOrphanLatchFileIfUnreferenced`) and
can ALSO arm a brand-new foreign unresolvable T mid-pass, exactly like the active loop can. T is missed by
the already-collected `nonTwinPendingIndices`, then lands in the (too-late) exclusion snapshot, so the
post-loop pass wrongly skips it too — reproduced directly: A itself PENDING/unresolvable, with
`orphanLatchFiles=[O]`, O holding T=[tA,tF]; after `clear(A,tA)`, T kept [tA,tF] in-process and after a
reboot, and T's own later `clear(tF)` left it stranded on `[tA]` — the identical strand the whole card
exists to fix, just reached via a different pass.

**Fix:** the exclusion snapshot (renamed `identitiesPendingBeforeCall`) is now captured at the TOP of
`clearMergeQuarantineByToken`, before `activeMatches`/`nonTwinPendingIndices` are even computed — i.e.
before EITHER pass can arm anything new. This still correctly protects `3315b08a`'s own ambiguous
multi-record S3a shape, because that scenario's own identities are injected into
`pendingUnresolvedQuarantines` before `clearMergeQuarantineByToken` is ever called at all — "present at
call start" is a strict superset of "present before the active loop," so moving the capture earlier can
only ever exclude MORE identities that genuinely pre-exist the call, never fewer.

**BLOCKING 2 — the arm only ever carried 5 fields, durably stripping provenance once rewritten.** Before
this card, a kept orphan/tmp-residue file's content NEVER got rewritten — `armForeignOrphanContentInMemoryIfUnenforced`
built a narrow in-memory entry (missing `contributorRepoPaths`/`reducedContributorRepoPaths`/`resolvedKeys`),
which meant a contributor identity's own enforcement was ALREADY silently missing in-process (an
in-process ≠ reboot divergence that predates this card and this round's own fix closes too) — but harmless
in the sense that a REBOOT always re-derived the full picture fresh from the untouched file. Once this
card's own post-loop pass started durably REWRITING that content (`writePendingDivertFile`), the missing
fields became PERMANENTLY stripped from disk too: reproduced directly — `O={T, tokens:[tA,tF,tC],
contributorRepoPaths:[C]}`; after `clear(A,tA)`, O's own on-disk content had `contributorRepoPaths:undefined`,
and `stillBlockedEntryFor(C)` read `false` both in-process AND after a reboot, while C's own token (`tC`,
folded into T's own union) was still genuinely live and unaddressed by the clear.

**Fix (root cause, per the preferred direction):** `ArmableOrphanRecord` is widened to carry every
provenance field PASS 1 itself would construct from the same bytes — read via the SAME canonical
whitelist PASS 1 uses, `latchEntryFromParsedRecord` (never a third hand-rolled copy of that whitelist) —
so the in-memory entry and what a reboot would construct agree BY CONSTRUCTION, not by coincidence.
Deliberately still EXCLUDES `resolvedKey` (singular — the active branch always overwrites it with a
freshly-computed key anyway; the pending branch's existing `undefined` default is unchanged and
sufficient, since a pending entry resolves lazily later regardless), `armedKeys` (always freshly computed
per branch) and `placeholder` (a foreign kept file is never a placeholder shape in practice) —
widening those three risks reopening exactly the "no degraded-collision dance" simplicity the ORIGINAL
`1dd00dca` design deliberately chose, for no benefit this card's own repro needs. `resolvedKeys` (plural)
IS carried through uniformly, mirroring PASS 1 exactly, since it is inert data carrying no arming side
effect of its own in this function.

**Two-path asymmetry, caught before landing (own EXECUTED repro per CLAUDE.md's standing rule, not
inferred):** the FIRST attempt at a tmp-residue contributor scenario planted the residue at the CLEARER's
own canonical-key hash during a FULL LIFT — which, it turns out, is also exactly the shape that triggers a
wholly UNRELATED, pre-existing "protect/relocate a foreign occupant before delete" mechanism
(`deleteMergeQuarantineLatchByKey`'s own protect-before-delete step, `c9114934`/`d4b25feb`'s own lineage) —
confirmed directly by its own distinct log line ("... also relocated 1 foreign co-occupant(s) ...") and by
the fact that `contributorRepoPaths` survived even reverted all the way back to `62f88046`, well before
this card's own fix (or even `1dd00dca`'s arm helper) could be responsible. That relocate path already
preserves everything losslessly and is out of this card's scope entirely — exercising it would have
silently "proven" a fix for a code path the fix never touches. Corrected to a PARTIAL reduce (the clearer
raised twice, at the same key, with one token staying outstanding) — a partial reduce triggers ONLY
`clearActiveEntryTokenAtKey`'s own direct `sweepTmpResidueForHashIfUnreferenced` call, with no delete and
so no protect/relocate, correctly isolating the narrow-arm path this card's own fix actually touches (the
`clearTokenFromPendingIndices`/`writePendingDivertFile` reduce-write — Round 3 reverted the arm's own
field-widening; see Round 3's own B-1 section). Confirmed by
its own log line ("arming ... as a PENDING quarantine ... from a kept tmp residue ... ARMED and
enforced"), matching the orphan path's own wording exactly.

**SHOULD 3 — the Twin Guard scenario doesn't exercise `activeMatchesAfterLoop`.** Y's identity is already
pending BEFORE `clearMergeQuarantineByToken` is ever called, so the (now call-start) identity exclusion
alone fully explains why it's skipped — independent of, and never reaching, the separate
`activeMatchesAfterLoop` exclusion. It also passes unchanged reverted all the way to `62f88046`, confirming
it is a non-regression pin for the pre-existing dual-tracked-twin shape, not evidence for this card's own
second exclusion. Addressed by REWORDING the scenario's own header comment in the test file to state this
plainly, rather than fabricating a contrived construction whose own realism would be questionable.

**Also found during Round 2's own review (test/record honesty, fixed in Round 3):** Round 1's own
"(TMP-RESIDUE)" scenario was a FULL LIFT at R's own key hash — which, same as CONTRIB-TMP's own first
draft, collides with the unrelated protect/relocate-before-delete mechanism rather than reaching this
card's own arm helper at all. Relabeled "(TMP-RESIDUE-RELOCATE)" and its checks stripped of any "THE FIX"
framing — it is a non-regression pin for the relocate mechanism, never coverage of this card. The real
tmp-residue ARM-path coverage is CONTRIB-TMP's own partial-reduce construction, as described above.

## Round 3 (Code Review of `7203bbea`) — 1 BLOCKING (B-1), 1 explicitly out-of-scope (S-1)

**B-1 (BLOCKING, a durable fail-open vs `62f88046`) — the reduce-write persisted the arm's own narrow
in-memory model verbatim, not O's real on-disk record.** Round 2's own `writePendingDivertFile` call wrote
`updated` (built from the arm's deliberately narrow `entry` — repoPath/branch/reason/enteredAt/tokens
only, even after Round 2's own now-reverted widening attempt) directly over `O`. Every normal raise
persists a real `resolvedKey` (`merge-quarantine.ts` ~`:4428`), and PASS 1 USES it
(`secondaryKeysToAttempt`/`informativeKeysFor`, ~`:9071`+) to arm an unresolvable identity ACTIVE at that
key on reboot — losing it durably degrades that identity from "ACTIVE at its own real key" to "a bare
PENDING park with no key to re-verify against." Reproduced directly: `O` names `B` — a repo that WAS
resolvable at raise time (so it earned a real `resolvedKey`) but is now GONE (its own directory removed)
— holding `[tA,tF]` plus its OWN secondary `orphanLatchFiles` reference. After `clear(A,tA)`, `O` on disk
lost `resolvedKey` (and had `orphanLatchFiles` overridden to `[O]`, the arm's own self-reference). At
`62f88046`, `O` is never touched at all, so neither field is ever lost — confirming this is a durable
fail-open Round 2 itself introduced, not a pre-existing one.

**Correction on the exact reboot consequence (verified directly, at its true strength — not the original
framing):** losing `resolvedKey` does NOT make `B` read fully UNBLOCKED in the construction verified here
— `B` still reads blocked after a reboot EITHER way, via the pending tier's own lazy fallback (confirmed
identically at `7203bbea` and with the fix: `stillBlockedEntryFor(B)`/`assertRepoNotQuarantined(B)` both
still refuse). What IS confirmed to differ, directly: the entry PASS 1 reconstructs for `B` carries NO
`resolvedKey` field at all at `7203bbea`, versus the preserved real key with the fix — a genuine,
verified-both-ways-RED-vs-GREEN discriminator, just not "fully unblocked." A shape that DOES degrade all
the way to unblocked (if one exists) was not found within this round's own effort budget — not asserted
here as reproduced.

**RETRACTED BY ROUND 4 — this "stays blocked either way" finding was itself an artifact of the
construction, not a property of the mechanism.** `O`'s own `repoPath` field named `B` DIRECTLY (T and B
shared one identity), so `stillBlockedEntryFor(B)` found it via a plain, same-string identity match
(`ownIdentityEntryFor`) regardless of whether `resolvedKey` survived at all — the pending tier's own "lazy
fallback" referenced above IS that identity match, not some independent recovery path. Round 4 reshaped
the test so `B` stays a REAL, resolvable repo throughout and the foreign identity (`T`, carrying
`resolvedKey`) is a DISTINCT never-existing path — this routes a query for `B` through the KEY-based
`activeMergeQuarantineForPeek` instead (never the identity-based path), and under THAT shape `B` DOES
read genuinely UNBLOCKED at `7203bbea` and genuinely BLOCKED with the fix, both in-process (round 3's own
adoption of the rebased record into memory — see "The fix" above — means this now holds immediately
after the clear, not just after a reboot) and after a reboot. See the "Tests" section's own RESOLVEDKEY
bullet for the current construction.

PASS 1 also derives `placeholder` and runs `detectUnknownProvenance` (~`:8983`/`:9006`)
via its OWN inline parse (~`:8971`), never `latchEntryFromParsedRecord` — so Round 2's own "the same
canonical whitelist PASS 1 uses" framing was ALSO inaccurate; `latchEntryFromParsedRecord` is a narrower,
single-other-caller helper (`702b4241`), not PASS 1's own parse.

**The fix (lesson 277: three reviews have now each found a new fail-open in this SAME mechanism — shrink
the surface, don't widen the model further):**
1. **REVERTED** the `ArmableOrphanRecord` widening back to the narrow `1dd00dca` shape (restoring that
   record's own "never widen" guard, and `latchEntryFromParsedRecord`'s own `702b4241` single-caller
   guard) — the arm's own in-memory model can stay narrow now that the WRITE no longer depends on it.
2. **`writePendingDivertFile` (`:3055`) made O-PRESERVING BY CONSTRUCTION**, but ONLY when its NEW,
   explicit, OPT-IN `rebaseOntoRealDiskRecord` parameter is `true` — never the shared default for every
   `droppedTokens.size > 0` caller. When set, it re-reads `filename`'s own CURRENT on-disk record first
   (reusing the SAME re-read pattern the pre-existing `keptUnreadableLatchFiles` branch already used,
   never a second hand-rolled copy) and, when it reads back as the SAME identity, rebases onto THAT
   record — dropping ONLY the specified token(s) from its own tokens, keeping every other KNOWN field
   (`resolvedKey`, `orphanLatchFiles`, contributors, everything `readPendingDivertFileAt`'s own whitelist
   carries forward) exactly as it was — never "byte-for-byte": a field outside that whitelist (there are
   none known today) would not survive this rebase either, same as any other reader in this module.
   ENOENT (nothing real there) writes `entry` as given, unchanged. Unreadable/corrupt/a DIFFERENT identity underneath
   fails CLOSED — returns `false` (never overwrites blind), so the token stays outstanding and a restart
   re-arms it, rather than risk silently dropping a field disk still genuinely has.
   **A real regression, caught before landing:** the FIRST attempt made this the unconditional behavior
   for every `droppedTokens.size > 0` call — this broke 4 PRE-EXISTING, unrelated tests (`58957b1e`,
   `64119847`, `degraded-occupant-guard`, `raise-protect-failure`), all via the SAME shape: a DIFFERENT
   call site (the `clearActiveEntryTokenAtKey`'s own tied-twin rewrite, `~:6134`) passes an already
   carefully-computed `entry`/`updated` (the result of an earlier union/reduce elsewhere in that same
   call), and rebasing onto whatever is CURRENTLY on disk there resurrected a token (`wa`) that
   computation had already, correctly, dropped — `droppedTokens` at THAT call site means something
   narrower ("subtract the clearer's own current tokens from the twin's stale on-disk copy"), not "this
   IS the full narrowing". Caught by the full `clearMergeQuarantineByToken`-caller sweep (same discipline
   as Round 2's own 3315b08a catch), confirmed as a genuine regression via `git checkout HEAD --` +
   rebuild + direct run (passed on pre-fix code, failed with the blanket version). Fixed by making the
   rebase strictly OPT-IN, enabled at exactly ONE call site — `clearTokenFromPendingIndices`'s own
   "reduce" branch (`~:4784`), the SAME site Round 2's own `writePendingDivertFile(live.sourceFile,
   updated, new Set([token]))` call already lived at. **Not the ONLY site an arm-derived entry can ever
   reach a durable-strip hazard** — `mergeTokenIntoPendingEntries`'s own write (`~:3800`, a plain raise/
   merge, never opted into this rebase) and `rewriteOrphanLatchFilesAfterPartialClear` (`~:4953`,
   defined `~:4600`) are two OTHER, pre-existing sites with the SAME class of gap, left deliberately
   OUT OF SCOPE here and tracked on card `97a5b64f`. Every other `droppedTokens.size > 0` caller of
   `writePendingDivertFile` keeps its PRE-028837ad behavior byte-identical (the default `false`).

**Why the write-level fix, not a second widening:** disk is now unconditionally A source of truth for a
narrowing write, so the in-memory arm's own field set is irrelevant to what lands on disk — never
narrowed to a hand-maintained whitelist's own enumeration again.

**CORRECTED BY ROUND 5 — "agree BY CONSTRUCTION, for every field" was FALSE as written here.** Disk being
A source of truth is not the same claim as disk being the ONLY one: taking every non-token field from
disk ALONE (this round's own `{...reread.entry, ...}`) silently drops a field that exists IN MEMORY ONLY
because an earlier write into the SAME pending record already failed its own durable write — Round 4
closed this for tokens specifically; Round 5 closes it for every other field via the same union. See
"Round 5" below.

**Accepted, NAMED, pre-existing, OUT-OF-SCOPE residual (tracked on card `5d0820c7`):** the in-memory arm's
own narrow model still means `contributorRepoPaths`/`resolvedKey`/etc. are genuinely ABSENT from a
freshly-armed entry's IN-MEMORY view for as long as it sits in
`activeQuarantines`/`pendingUnresolvedQuarantines` without ever being durably rewritten — an in-process ≠
reboot divergence that has existed since `1dd00dca` itself (this card's own Round 2 found and (wrongly)
tried to close it by widening the arm; Round 3 found that approach itself caused a worse, durable
fail-open and reverted it). This divergence is REAL, PRE-EXISTING, and NOT introduced or fixed by
`028837ad` at any round — tracked as its own, separately-carded follow-up (`5d0820c7`), not fixed here.

**S-1 (explicitly OUT OF SCOPE, carded separately on `58a3f730`) — a fail-closed strand via the
relocate-foreign-occupant path (`c9114934`/`d4b25feb`) when the identity was already pending at call
start.** Found during Round 2's review; not this card's own mechanism (the relocate path is
`c9114934`/`d4b25feb`'s own, pre-dating this card entirely) and not fixed here per the Lead's own explicit
ruling. **FIXED by `58a3f730`** (its own record: `docs/decisions/58a3f730-lift-a-token-relocated-into-an-already-pending-record.md`)
— `identitiesPendingBeforeCall` narrowed from bare pending presence to "already held `token` at call
start," never widened or record-keyed.

**Behaviour change, stated plainly:** after this call site's own reduce, the in-memory entry is REPLACED
by the rebased record (as of Round 5, the full union of disk and memory — see "Round 5" below) rather than
by the arm's own original narrow model — so a reduce is also, incidentally, the moment the in-memory view
catches up to what a reboot would construct, for every field this write's own union covers.

## Round 4 (Code Review of `d3d5a4e3`, CR3) — 1 BLOCKING (B-1), 1 record/test accuracy (S-2), 1 NIT

**B-1 (BLOCKING, a durable fail-open introduced in Round 3) — the reduce-write's rebase took tokens from
disk ALONE, losing a MEMORY-only token.** `writePendingDivertFile`'s `rebaseOntoRealDiskRecord:true`
branch (`~:3084`) computed `toWrite.tokens` as `reread.entry.tokens.filter(t => !droppedTokens.has(t))` —
disk's own surviving tokens, minus the drop, with no reference to `entry.tokens` (the caller's own
in-memory model) at all. A token can exist IN MEMORY ONLY when an earlier write into the SAME pending
record already failed its own durable write (`mergeTokenIntoPendingEntries`'s own EPERM write, `~:3800`,
falling back to "quarantined IN THIS PROCESS ONLY") — disk never saw it. Reproduced directly: `T10` raised
`t1`; a second raise (`t2`) forced to fail its own rename (EPERM); disk still names `[t1]`, memory holds
`[t1,t2]`. Clearing `t1` through `clearTokenFromPendingIndices`'s reduce branch (`~:4788-4790`, which
ADOPTS `written.entry` into `live.entry`/`activeQuarantines` unconditionally once `writePendingDivertFile`
returns) rebased to `[t1]` minus `t1` = `[]` — a ZERO-TOKEN entry, durably written AND adopted into memory
— losing `t2` for good, with no holder left able to clear it. RED at `d3d5a4e3`.

**The fix:** every OTHER field in the rebase still comes from disk alone (unchanged from Round 3); tokens
are now `(disk's own surviving tokens) ∪ (entry.tokens)`, minus `droppedTokens` — the same token-union
shape `unionIntoOnDiskPendingEntry` (`~:3988`) already uses for the `keptUnreadableLatchFiles` branch just
above it, applied here too rather than trusting disk's tokens as the complete set. `armedKeys` is ALSO
carried forward from `entry` explicitly (`readPendingDivertFileAt` never persists it, so the disk-sourced
spread would otherwise silently drop it from the adopted in-memory entry).

**SUPERSEDED BY ROUND 5 — "every OTHER field... from disk alone" was ITSELF the next fail-open in this
SAME mechanism.** Round 5 widens this to the full `unionIntoOnDiskPendingEntry` union for every field, not
just tokens — see "Round 5" below.

**S-2 (record/test accuracy) — the RESOLVEDKEY scenario's own `T === B` shape masked its discriminator.**
See the Round 3 B-1 section's own "RETRACTED BY ROUND 4" note and the "Tests" section's own RESOLVEDKEY
bullet above for the corrected construction and what it actually proves. Also corrected here: the "ONLY
site" claim in Round 3's own "The fix" section (two other pre-existing durable-strip sites are out of
scope, tracked on card `97a5b64f`, not nonexistent) and the "byte-level"/"byte-preserved" phrasing (the
rebase preserves every field `readPendingDivertFileAt`'s own whitelist carries forward, never literally
every byte of the original file).

**NIT:** deduped a verbatim-duplicate `@decision 1dd00dca` "never widen" comment immediately above
`ArmableOrphanRecord` (one JSDoc copy, one redundant line-comment copy of the identical text) down to one.

## Round 5 (Code Review of `ddda6031`, CR4) — 1 BLOCKING (B-1), 1 record (S-1), 1 record/test (S-2), NITs

**B-1 (BLOCKING, a regression since Round 3, not closed by Round 4) — the SAME failed-write gap, for
EVERY non-token field, not just tokens.** `writePendingDivertFile`'s rebase branch (`~:3083`) spread
`{...reread.entry, ...}` — every non-token field from disk ALONE — and `clearTokenFromPendingIndices`'s
reduce branch (`~:4790-4794`) adopts `written.entry` into memory unconditionally. A field that exists
ONLY in memory after an earlier failed write (`provenanceUnknown`, `orphanLatchFiles`,
`contributorRepoPaths`, `resolvedKey`(s)) is lost in memory AND on disk the moment the next reduce runs.
Reproduced directly (MULTI-EPERM scenario): `T` has a primary pending file holding `[a]` plus a
same-identity COLLISION file (card `882d6cff`'s own multi-claimant shape) holding `[b]` with
`provenanceUnknown:true`; raising `T` again merges both via `mergeTokenIntoPendingEntries`
(`matched.length===2`) into one in-memory record carrying `provenanceUnknown:true` and `orphanLatchFiles`
naming the collision file — whose own durable write is forced to fail (EPERM); `clear(a)` at `ddda6031`
then durably strips `provenanceUnknown`/`orphanLatchFiles` from the rebased record (verified: both the
in-memory AND on-disk result lack them), so the collision file (still holding the already-released token
`b`) becomes permanently unreferenced and is never swept on the eventual full lift. RED at `ddda6031`.

**The fix:** never hand-roll the merge — build the rebase via the EXISTING sibling helper,
`unionIntoOnDiskPendingEntry(reread.entry, entry)` (the SAME helper the `keptUnreadableLatchFiles` branch
just above already uses, and the one `unionIntoOnDiskPendingEntry`'s own doc comment already promises:
tokens AND `orphanLatchFiles`/`contributorRepoPaths`/`provenanceUnknown`/`provenanceTracked`/`resolvedKey`(s)
all carry forward together, via `unionQuarantineEntries` itself, never a second hand-rolled
re-implementation) — then drop `droppedTokens` from the union's own `.tokens`, then carry `entry.armedKeys`
forward explicitly, exactly as Round 4 already did. This changes only the WRITE, consistent with Round
3's own "don't widen the arm" ruling — the in-memory arm's field set stays exactly as narrow as Round 3
left it. The arm's own self-reference (a kept orphan/tmp-residue's own basename, folded into `entry.orphanLatchFiles`
by `armForeignOrphanContentInMemoryIfUnenforced` itself) is now UNIONED with whatever disk already names
in its own `orphanLatchFiles`, never overriding it — confirmed by the reshaped RESOLVEDKEY scenario's own
on-disk check (see "S-2" below).

**Round-3 regression set + RESOLVEDKEY/orphanLatchFiles legs re-checked:** the full
`clearMergeQuarantineByToken`-caller sweep (same discipline as every prior round), specifically including
`58957b1e`, `64119847`, `degraded-occupant-guard`, and `raise-protect-failure` (the four Round 3's own
FIRST, unconditional attempt broke) — all green. The RESOLVEDKEY scenario's own `orphanLatchFiles`
"survives" check was ITSELF a casualty of this round's own correctness: exact-equality against disk's own
pre-existing secondary reference no longer holds now that the union also folds in the arm's own
self-reference — reworded to assert BOTH are present (see "S-2" below), never a regression in the
mechanism itself.

**S-1 (record) — named the two out-of-scope follow-up cards inline, in their own paragraphs:** `5d0820c7`
(the narrow in-memory arm's own in-process ≠ reboot divergence) and `58a3f730` (the relocate-foreign-occupant
strand). Added one explicit sentence stating the behaviour change plainly: after a reduce via this call
site, the in-memory entry is REPLACED by the rebased record — now the full union, not the arm's own
original narrow model — so a reduce is also, incidentally, the moment the in-memory view catches up to
what a reboot would construct, for every field this write's own union covers.

**S-2 (record/test accuracy):** corrected Round 3's own now-false "agree BY CONSTRUCTION, for every
field" claim (see its own "CORRECTED BY ROUND 5" note above) and compressed the RESOLVEDKEY scenario's
own test-file header comment — a long narrative the CR judged duplicative of this record's own Round 4
bullet — down to a 2-3 line class-A guard plus `@decision 028837ad`, per the comment taxonomy in
`CLAUDE.md`: the history belongs in this record, not restated a second time inline in the test file.

**NITs:** the test's own check labels at the CONTRIB-ORPHAN/CONTRIB-TMP scenarios and the file's closing
summary string all still said "byte-preserved" — reworded to "every known non-token field preserved" to
match this record's own Round 4 correction (never literally every byte of the original file; only the
fields `readPendingDivertFileAt`'s own whitelist carries forward). Noted here, as asked: the `armedKeys`
carry-forward in the rebase branch is DEFENSIVE, not independently proven by its own dedicated test —
per `64283e06`'s own ruling, the arm-derived entries this call site serves are never genuinely
armed anywhere (a pending-only record's own `armedKeys` is ordinarily `undefined`), so the carry is
believed UNREACHABLE in practice today; kept anyway because nothing here proves it will stay that way.

**OUT OF SCOPE (carded by the Lead) — `writePendingDivertFile`'s own catch path (`~:3120`) never unlinks
the tmp it had already written+fsynced before a forced rename failure.** Confirmed directly: the
MULTI-EPERM scenario's own injected EPERM leaves exactly this stranded tmp residue, which — left in
place — independently re-arms `T` with every token the scenario had already cleared on the next reboot,
for a REASON UNRELATED to this card's own mechanism (the collision file, once correctly referenced, IS
swept; the stranded tmp is a different, unreferenced physical file nothing ever knows to clean up). The
test cleans this residue up itself (see its own header comment) so its own reboot assertion is never
confounded by this separately-tracked bug.

## Do not

- Do not reorder the pre-loop pass to run after the active loop — reopens the stale-`activeMatches`
  twin-misclassification risk a second, independent pass exists specifically to avoid.
- Do not capture the post-loop pass's own identity-exclusion snapshot anywhere but the TOP of
  `clearMergeQuarantineByToken`, before either pass runs, and never drop it from the post-loop filter —
  either misses an identity armed mid-pass or regresses card `3315b08a`'s own ambiguous multi-record identity.
- Do not construct a tmp-residue contributor/provenance test scenario via a FULL LIFT at the clearer's own
  key — it collides with the unrelated protect/relocate mechanism; use a PARTIAL reduce instead.
- Do not widen `ArmableOrphanRecord`/the arm's own in-memory model to carry more fields, ever again —
  this exact mistake has already recurred more than once; fix the WRITE instead.
- Do not write `entry`/`updated` directly to `filename` inside `clearTokenFromPendingIndices`'s reduce
  branch without `writePendingDivertFile`'s `rebaseOntoRealDiskRecord:true` — durably loses `resolvedKey`.
- Do not hand-roll any part of the rebase's own merge (tokens or any other field, including a kept
  orphan/tmp-residue's own self-reference basename) — build it via `unionIntoOnDiskPendingEntry(reread.entry,
  entry)` (unions tokens, `orphanLatchFiles` — self-reference included, never overriding disk's own —
  `contributorRepoPaths`, `provenanceUnknown`/`provenanceTracked`, `resolvedKey`(s)), then drop
  `droppedTokens` from its `.tokens`, then carry `entry.armedKeys` forward explicitly (never persisted to disk).
- Do not make `rebaseOntoRealDiskRecord` the shared default for every `droppedTokens.size > 0` caller of
  `writePendingDivertFile` — at least one other caller's own `entry` is already a correct union/reduce
  that rebasing onto raw disk would wrongly override; opt in ONLY at `clearTokenFromPendingIndices`'s own
  reduce-branch call site.
- Do not construct a `resolvedKey`-preservation test with the foreign identity sharing the SAME repoPath
  string as the real repo whose key it carries — a plain identity lookup finds it regardless of whether
  `resolvedKey` survived, masking the discriminator; use a DISTINCT, unresolvable identity instead.
- Do not construct an EPERM-forced-write test and trust a later reboot assertion without first removing
  the STRANDED TMP `writePendingDivertFile`'s own catch path leaves behind — it independently re-arms
  every token outstanding at the time of the failure, confounding the assertion.
- Do not add a twin-exclusion special case to the post-loop pass "for safety" — by construction no active
  entry can still hold `token` once the active loop completes, so a fresh `activeMatches` recompute is sufficient.
- Do not assume the tmp-residue path is covered by inference from the orphan path alone — the root cause
  (`nonTwinPendingIndices`'s snapshot timing) is orthogonal to which inner sweep performs the arm; prove
  each with its own executed scenario.
- Do not read item (4) from the investigation checkpoint (the silent "reduce" path has no log) as fixed
  here — explicitly out of scope, tracked separately.

## Tests

`merge-quarantine-028837ad-pending-arm-mid-clearbytoken.mjs`:
- Orphan path, unresolvable T: in-process lift of `tA` from T's pending entry within the SAME
  `clearMergeQuarantineByToken(A, tA)` call, plus a reboot taken right after independently re-deriving the
  same reduced set, plus T's own later `clearMergeQuarantineByToken(T, tF)` fully lifting it.
- **(TMP-RESIDUE-RELOCATE)** NOT this card's own arm-helper path (see "Round 2" above) — a non-regression
  pin for the pre-existing, unrelated protect/relocate mechanism only.
- Control: a RESOLVABLE foreign T still self-recovers within the same call, unchanged.
- **(PENDING-A, Round 2 BLOCKING 1)** the arm happens in the PRE-LOOP pass: A itself is pending/unresolvable,
  carrying `orphanLatchFiles=[O]`, O holding T=[tA,tF] — the same three legs as the orphan scenario above.
- **(CONTRIB-ORPHAN / CONTRIB-TMP, Round 2 BLOCKING 2, the REAL tmp-residue ARM-path coverage)** O/the tmp
  residue (CONTRIB-TMP via a PARTIAL reduce — see "Round 2" above for why) also carries
  `contributorRepoPaths:[C]` and a `resolvedKey` — C stays blocked (`stillBlockedEntryFor`) in-process AND
  after a reboot, for BOTH arm paths, and the on-disk copy's own `contributorRepoPaths` AND `resolvedKey`
  both survive the durable reduce-write.
- **(RESOLVEDKEY, Round 3 B-1; reshaped Round 4 S-2)** `B8` is a REAL, resolvable repo throughout — never
  removed. `T8` is a never-existing subdirectory UNDER `B8` — unresolvable on its own, and a DISTINCT
  identity from `B8` (never the SAME repoPath string) — holding `[tA,tF]` plus its own secondary
  `orphanLatchFiles` reference, and `resolvedKey: canonicalRepoLockKey(B8)`. Querying `B8` ITSELF (never
  `T8`) via `stillBlockedEntryFor` — which routes a RESOLVABLE repoPath through the KEY-based
  `activeMergeQuarantineForPeek`, never the identity-based `ownIdentityEntryFor` — is the real
  discriminator: `B8` reads genuinely UNBLOCKED at `7203bbea` and genuinely BLOCKED with the fix, both
  in-process (right after the clear) and after a reboot; its own `resolvedKey` survives the reduce-write
  on disk too, and its own secondary `orphanLatchFiles` reference survives UNIONED with the arm's own
  self-reference (card `882d6cff`'s own basename, folded in by the arm helper itself) — never one
  overriding the other (Round 5's own fix; see "Round 5, B-1" above). (The OLD shape had `T === B`'s own
  repoPath directly, so a plain identity lookup found `B` regardless of whether `resolvedKey` survived at
  all — masking this discriminator entirely; see the Round 3 B-1 section's own "RETRACTED BY ROUND 4"
  note.) The test file's own header comment for this scenario is now a compressed `@decision 028837ad`
  class-A guard (Round 5 S-2) — this bullet is the narrative.
- **(EPERM-UNION, Round 4 B-1)** a memory-only token must survive the reduce-write's own rebase onto disk:
  `T10` is raised unresolvable (`t1`); its SECOND raise (`t2`) takes `mergeTokenIntoPendingEntries`'s own
  union-into-existing branch, whose durable write (`~:3800`) is forced to fail (a one-shot monkeypatched
  `fs.renameSync` EPERM, same technique as `2dd97aaa`'s own item-3 test) — `t2` survives IN-MEMORY ONLY
  while disk still names only `[t1]`. Clearing `t1` then exercises the reduce-write's own
  `rebaseOntoRealDiskRecord:true` rebase: pre-fix, it took tokens from disk ALONE (`[t1]` minus `t1` =
  `[]`), adopting a ZERO-TOKEN entry into memory and durably losing `t2`; the fix unions disk's own tokens
  with the in-memory entry's own before dropping the cleared token, so `t2` survives in-process, on disk,
  after a reboot, and is fully liftable by its own later `clear(t2)`.
- **(MULTI-EPERM, Round 5 B-1)** the SAME shape as EPERM-UNION, for every NON-token field. `T11` has TWO
  independent pending records sharing one identity — a primary file (`a`) and a same-identity COLLISION
  file (`b`, `provenanceUnknown:true`, card `882d6cff`'s own multi-claimant shape, injected directly via
  the same test-only seams Twin Guard uses). Raising `T11` again (`c`) merges both via
  `mergeTokenIntoPendingEntries` into ONE in-memory record carrying `provenanceUnknown:true` and
  `orphanLatchFiles` naming the collision file — whose own durable write is forced to fail (EPERM, same
  one-shot technique as EPERM-UNION), so the primary file's own disk bytes stay untouched (`[a]` only, no
  `provenanceUnknown`/`orphanLatchFiles`) while memory holds the full merged picture. Clearing `a` then
  exercises the SAME rebase as EPERM-UNION, but for non-token fields: pre-fix, every non-token field came
  from disk ALONE, durably stripping `provenanceUnknown` and `orphanLatchFiles` — the collision file (still
  holding the already-released token `b`) then becomes permanently unreferenced and is never swept,
  re-blocking `T11` after a reboot on a token already lifted. The fix unions every field, so provenance
  and the orphan reference survive, and the collision file IS correctly swept once the full lift runs; a
  reboot then agrees `T11` is NOT re-blocked. (The test cleans up `writePendingDivertFile`'s own
  separately-tracked stranded-tmp residual from its OWN forced EPERM before asserting this — see the
  OUT-OF-SCOPE paragraph under "Round 5" above — so this scenario's own reboot check is never confounded
  by that unrelated, already-carded bug.)
- Twin guard: a genuine `883e29bc`-shaped dual-tracked twin (same object reference active AND pending) is
  not double-processed or wrongly re-reduced by the new post-loop pass — a non-regression pin (Round 2
  SHOULD 3: exercises the call-start identity exclusion alone, not `activeMatchesAfterLoop`; passes
  unchanged reverted to `62f88046` too).

RED proof: `negative-control --ref 62f88046`, `--ref 7203bbea` (the reshaped RESOLVEDKEY scenario's own
in-process/on-disk/durability checks RED specifically; every other Round-1/Round-2 scenario stays GREEN,
confirming only B-1 was missing), and `--ref ddda6031` (the MULTI-EPERM scenario's own four checks, plus
the reshaped RESOLVEDKEY orphanLatchFiles-union check, RED specifically — Round 5's own B-1, everything
else already fixed by Rounds 3-4 stays GREEN). Each run's own exact RED/GREEN set is recorded in the
worker's own `worker_report`, not restated here — re-run the controls rather than trusting a stale count.
