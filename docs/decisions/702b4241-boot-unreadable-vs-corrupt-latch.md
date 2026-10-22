# 702b4241 — distinguish an UNREADABLE boot-time quarantine latch from a genuinely CORRUPT one

A pre-existing follow-up from Code Review `5d01bfbf` of `63e49ee2`. `63e49ee2` fixed the RUNTIME read
sites (`differentUnresolvableOccupantRepoPathAt`, `foldInOnDiskTokensIfMarked`, and siblings) so a
non-ENOENT read failure (EACCES, EMFILE, a mode-000 file in an otherwise-writable dir) is treated as
`"unknown"`, never `"none"` — never trusted as "nothing real there, safe to overwrite". It explicitly left
`reenterMergeQuarantinesAtBoot`'s own three read sites unfixed.

## The bug

PASS 1 (a latch's own final `.json`), PASS 1b (`.json.tmp-<pid>` residue) and the safety-tmp recovery loop
(`.json.tmp-safety-<pid>-<hex>` residue) each wrapped `fs.readFileSync` AND `JSON.parse` AND the
repoPath/branch/reason field validation in ONE `try`, with ONE `catch` that could not tell "the bytes are
provably bad" apart from "the read itself failed and nothing was learned about the bytes at all". Both
shapes fell into the identical CORRUPT cascade (`deferredCorruptJsons`/`deferredCorruptTmps`/the
safety-tmp `resolveAndArm` closure), which — for a filename hash that matches a currently-resolvable
registered repo — eventually calls `bootWriteLatch` and writes a fresh, fail-closed CORRUPT placeholder
AT THE EXACT SAME PHYSICAL FILE. When the read failure is transient (EACCES from a brief permission
hiccup, EMFILE from an fd-exhausted process, EPERM/EBUSY from a concurrent reader/AV scanner on Windows)
the real latch's content was never actually bad — it was simply never read — and this overwrite
permanently destroys its real tokens, replacing them with a freshly minted random one nobody is waiting
on. Reproduced hermetically (own `LOOM_HOME`, a real git repo, `fs.readFileSync` monkeypatched to throw
`{code:"EACCES"}` for the exact latch path): a raised quarantine's own real token
(`c59b8250-ab00-4b65-a884-9b948fb3ae18` in the worker's own repro run) was silently replaced by a fresh one
(`7bca6628-c9a2-47eb-89b2-05c638cfc739`) after a single unreadable boot.

## The fix

**Errno-keying is the discriminator, and it needs no restructuring of the existing three try/catch
blocks.** `fs.readFileSync` always throws an error carrying a real `.code` (`"ENOENT"`, `"EACCES"`,
`"EMFILE"`, ...); a `JSON.parse` `SyntaxError` and the module's own manual field-validation
`throw new Error(...)` never do. So checking, at the very top of each existing `catch (e)`, whether
`(e as NodeJS.ErrnoException).code` is set AND is neither `"ENOENT"` nor `"EISDIR"` correctly separates
"the read itself failed for a real reason" from "the read succeeded and the content is bad" — without
ever needing to split the `try` into a read-stage and a parse-stage. ENOENT/EISDIR deliberately keep
falling through to the existing, unchanged corrupt-latch cascade (nothing real is lost either way — this
mirrors the runtime `63e49ee2` precedent, where `differentUnresolvableOccupantRepoPathAt` et al. return
`"none"` for ENOENT/EISDIR and only `"unknown"` for anything else).

A genuine (non-ENOENT/EISDIR) read failure routes through one new, shared chokepoint —
`divertUnreadableBootLatch(f, hash, code, kindLabel)`, a local closure inside
`reenterMergeQuarantinesAtBootImpl` (it needs `hashToRepo`/`unresolvedClaimantsByHash`/
`ancestorHashToRepo`/`pendingUnresolvedQuarantines`/`orphanFilenames`/`orphanReasonParts`/
`keptUnreadableLatchFiles`, all of which are local state inside that one giant function — there is no
top-level home for it). It:

1. Marks `f` in `keptUnreadableLatchFiles` (the SAME identity-less protection set `63e49ee2` already added
   for the runtime side — boot had never once populated it before this card).
2. Diverts whichever registered repo(s) the filename's hash matches (direct, multi-claimant degraded, or
   ancestor-tier — the same three lookups the existing corrupt cascade already does) straight to
   `pendingUnresolvedQuarantines`, self-referencing `f` as `sourceFile`, with a NEW, dedicated placeholder
   branch text, `PLACEHOLDER_BRANCH_UNREADABLE` — never into `deferredCorruptJsons`/`deferredCorruptTmps`/
   the safety-tmp `resolveAndArm` cascade, all three of which can eventually `bootWriteLatch` a placeholder
   at this exact filename once the match is resolvable.
3. Falls back to the ordinary orphan sweep (`orphanFilenames`/`orphanReasonParts` — fail-closed for every
   registered repo) only when the hash matches no registered repo at any tier; that path writes to each
   REGISTERED repo's own key, never to `f` itself, so it carries no overwrite risk either.

**Round 1 claimed the pending entry's own `sourceFile` was structurally unwritable this boot, "twice
over" — FALSE, corrected in round 2 below.** A same-key SIBLING source (a tmp residue, or a stale migrate
source) also puts `f` into `allBootWriteTargets`, and Phase 0's own at-risk protection then re-points
THIS divert's `sourceFile` off `f` onto a fresh safety-tmp — which disarms `bootWriteLatch`'s backstop
refusal for that sibling's write. A real rename-tracing probe (Code Review `12c5623d`, round 2) confirmed
`bootWriteLatch` DOES rename over `f` during the SAME boot in exactly this shape. The real protection —
and what actually makes it hold — is in the Round 2 section below.

## The clear path already honoured `keptUnreadableLatchFiles` — this card just populates it at boot

The manager's review asked explicitly whether a human clearing the resulting placeholder (by path, by
id/hash, or by token) could re-destroy the file one step later — "clear the scary placeholder" undoing the
fix by deleting what boot had just protected. Investigated directly: `sweepOwnLatchFileUnlessOwnedElsewhere`
(line ~3870) and `sweepOrphanLatchFileIfUnreferenced` (line ~3659) — the TWO chokepoints every clear/sweep
route in this module is required to go through for its own file, per card `9cabd143`'s own "Do not add a
new direct `fs.unlinkSync`... without routing through one of these two" rule — **already** check
`keptUnreadableLatchFiles.has(filename)` first and refuse to delete (both added by `63e49ee2`, well before
this card). The gap `63e49ee2` left open was never in the clear/sweep side; it was that boot never put
anything into that set for an unreadable (as opposed to corrupt) file, so there was nothing for those
existing checks to find. Confirmed end to end, not just by code reading: `test/merge-quarantine-boot-
unreadable-vs-corrupt.mjs`'s `clear-after-unreadable-boot-keeps-file` scenario boots with a persistent
EACCES, then calls `clearMergeQuarantineLatchFile` on the resulting placeholder's own id. The physical
file is BYTE-IDENTICAL afterward (confirmed via `fs.existsSync` and a before/after byte comparison), and
the real raise token is still in it. The clear call DOES report `ok:true`/`wasQuarantined:true` and lifts
D's in-memory enforcement for the rest of that process's life — that is correct, not a regression:
`clearMergeQuarantineLatchFile`/`clearMergeQuarantineReporting` are the HUMAN-authoritative routes, and
they are entitled to lift enforcement on request without first proving the physical content's coverage,
unlike the automatic, token-scoped `clearMergeQuarantineByToken`. **Correction (round 2 review,
`12c5623d`): this scenario DOES go RED on unfixed `main`, for the SAME root reason as the main repro, not
a separate one** — `main`'s destructive overwrite happens DURING BOOT ITSELF, before the clear call is
ever reached, so the test's own `afterClearBytes === beforeBytes` assertion already fails at that point
on unfixed code (round 1's test file carried an incorrect "does NOT go RED" claim; see the Tests section).

## Round 2 (Code Review `12c5623d`, NOT MERGEABLE on round 1) — the net improvement still lost tokens, one writer later

Round 1 closed the BOOT-TIME overwrite but left two MAJOR gaps, both reachable the moment the read
failure is merely TRANSIENT (the common case) rather than permanent, plus one MINOR clear-reporting gap.
Reproduced with the reviewer's own probe (`<tmp|migrate|none> <daemonDir> <persistent|transient>`,
`TRACE=1`/`RAISE=1`), copied into this worker's own scratch dir and reused as-is.

**MAJOR 1 — the placeholder replaces the real latch the moment the file is readable again.** In the
`none` scenario (no sibling tmp/migrate at all), nothing writes during boot itself, so
`keptUnreadableLatchFiles` stays set and the pending UNREADABLE placeholder stays pending. The FIRST
`activeMergeQuarantineFor` call after boot (any later query, not just a deliberate "recover" action)
graduates it via `consumeMatchedPendingsIntoArmedEntry`, which calls `foldInOnDiskTokensIfMarked` — and
that function's EXISTING generic branch only ever unions `tokens`/`resolvedKeys` forward, never
`branch`/`reason`/`enteredAt`. Since the entry being folded IS the placeholder, the result durably stamps
the placeholder's own synthetic branch/reason over the just-recovered real content — a second, delayed
version of round 1's own bug, one caller removed.
**Fix:** `reconcileMarkedBasenameBeforeWrite` now checks, before the generic union, whether `entry` is
specifically this card's own `PLACEHOLDER_BRANCH_UNREADABLE` placeholder (`isUnreadablePlaceholderEntry`)
AND the on-disk parsed record is itself genuine (non-placeholder) content. If so, it RE-INGESTS the
on-disk record wholesale via a new, narrow helper (`latchEntryFromParsedRecord`, a deliberate duplicate of
PASS 1's own field extraction — see its own doc for why not a shared refactor), preserving only the
CALLER's already-stamped `resolvedKey`/`armedKeys`/`resolvedKeys`-union from the placeholder side, never
its branch/reason/tokens. The placeholder's own synthetic token is deliberately DROPPED, not unioned
forward — it was minted by boot itself and never returned to any caller, so nothing could legitimately be
relying on it for a future clear.

**MAJOR 2 — a transient failure plus ANY sibling (tmp residue or stale migrate source) still loses the
final's own token.** `bootWriteLatch`'s call to `writeMergeQuarantineLatch` reconciles the WRITTEN BYTES
(via that function's own internal, unexported reconcile) and clears `keptUnreadableLatchFiles` on
success — but `entry = reconciled` inside `writeMergeQuarantineLatch` is a local reassignment that never
propagates back to `bootWriteLatch`'s own caller. `byRepoKey` keeps holding the PRE-reconcile object. The
next query/graduation for the same repo then has no mark left to re-trigger a reconcile (it was already
cleared) and writes the stale, pre-reconcile in-memory entry straight over the just-recovered union,
losing whatever token the reconcile had folded in.
**Fix:** `bootWriteLatch` now calls `foldInOnDiskTokensIfMarked` itself, externally, BEFORE ever calling
`writeMergeQuarantineLatch`, whenever the target basename is still marked. A `"unreadable"` result refuses
the write outright (mirroring every other `bootWriteLatch` refusal, never falling through to
`writeMergeQuarantineLatch`'s own internal `divertRaiseEntry` fallback, which is for a RAISE, not a boot
write). A reconciled result is applied to `byRepoKey` via `replaceEntryEverywhere` BEFORE the write, and
passed into `writeMergeQuarantineLatch` with `reconciledAlready:true` so the write itself never re-reads
`final` a second time for the same decision. This closes the gap unconditionally — it is the single
`bootWriteLatch` chokepoint every boot write already goes through (confirmed by
`merge-quarantine-boot-write-chokepoint-guard.mjs`), so every future boot write site inherits it for free.

**Correcting the round-1 "structurally impossible, twice over" claim:** it was false, as both MAJORs
above demonstrate — `f` CAN be written to during the same boot (a sibling's own write targets it), and
the kept mark CAN clear mid-boot (a successful reconciled write clears it). The real, durable protection
is `keptUnreadableLatchFiles` plus the write-side reconcile chokepoint, now closed end to end by MAJOR 1
(the reconcile ingests the right DIRECTION of data for a placeholder entry) and MAJOR 2 (memory never
goes stale relative to what the reconcile actually wrote). See the `divertUnreadableBootLatch` closure's
own doc comment (merge-quarantine.ts) for the mechanism restated at the call site.

**MINOR — a human clear of the UNREADABLE placeholder silently reported success with no hint the file
stayed.** Traced to `deleteMergeQuarantineLatchByKey`'s own return shape: its bare "kept, no claimant to
name" branch (reached whenever `finalProtectOk` is false and `keptClaimants` is empty — exactly the shape
a basename-only unreadable mark produces, with no foreign identity to attach) had NO field to signal this
at all, unlike `sweepOwnLatchFileUnlessOwnedElsewhere`/`sweepOrphanLatchFileIfUnreferenced`'s own
`{kept, referencingRepoPaths}` shape (already `foldOrphanSweepResult`-aware of an "unattributed" keep).
Confirmed the gap is SPECIFIC to the ACTIVE-entry clear path (`clearMergeQuarantineByKey` and everything
that delegates through it) by probing both the never-graduated PENDING clear (already correctly reports
`latchKept:true`) and the graduated-then-still-unreadable ACTIVE clear (silently returned no `latchKept`
field at all, even though the file was never touched) side by side.
**Fix:** `deleteMergeQuarantineLatchByKey` gained an `unattributed?: true` return field, set in that exact
bare branch. Its three human-reachable call sites (`clearMergeQuarantineByKey`'s two loops, and
`clearMergeQuarantineByRecordedPath`'s pending loop) fold it into each function's own pre-existing
`anyKeptUnattributed` tracking — already wired into each function's `latchKept` computation, so no new
response field was needed, only the missing signal feeding the existing one. The fourth call site
(`clearActiveEntryTokenAtKey`, inside the TOKEN-scoped `clearMergeQuarantineByToken`) is deliberately left
untouched — that path has no human-facing return value at all (its own comment: "no human route reaches
this path").

## Round 3 (Code Review `b939aead`, NOT MERGEABLE on round 2) — `writePendingDivertFile` could still overwrite a still-unreadable final in place

**CRITICAL, pre-existing since round 1.** `divertUnreadableBootLatch` pushes the boot-time UNREADABLE
placeholder straight into `pendingUnresolvedQuarantines` with `sourceFile: f` — `f` being the real,
still-unread quarantine final, not a `pending-<hash>.json` record of its own. A fresh in-process raise for
the same identity, while `f` is STILL unreadable, reconciles to `"unreadable"` and correctly calls
`divertRaiseEntry`. But `divertRaiseEntry` finds the placeholder via `directPathIdentity` and uses ITS
`sourceFile` (`f`) as `base.sourceFile`, then calls `writePendingDivertFile(base.sourceFile, merged)` —
which never checked `keptUnreadableLatchFiles` at all and renamed straight over `f`, permanently replacing
the real branch/reason/resolvedKey(s)/tokens with nothing but the placeholder's own synthetic union.
`divertRaiseEntry`'s own doc claim, "Never touches `final` itself", was false in exactly this shape.
Reproduced: the real branch, reason, opId, token AND the secondary `resolvedKeys` were replaced by the
placeholder, and a second boot sees only the placeholder.

**The fix** is in `writePendingDivertFile` itself — the one shared write primitive every diverting caller
in this module already funnels through (`divertRaiseEntry`, `mergeTokenIntoPendingEntries`,
`consumeMatchedPendingsIntoArmedEntry`'s foreign-group loop, and the three partial-clear
pending-`sourceFile` rewrites) — never a caller-side check, which would have to be independently repeated
at every one of those sites and would drift the moment a new one is added. When `filename` is marked
`keptUnreadableLatchFiles`, it refuses to rename over it: it mints a fresh collision-suffixed pending
record (`pendingDivertCollisionFilenameFor(entry.repoPath)`) instead, folds `filename` into the written
entry's own `orphanLatchFiles` (so the still-unreadable file stays tracked and protected from deletion by
the pre-existing `keptUnreadableLatchFiles` checks in `sweepOwnLatchFileUnlessOwnedElsewhere`/
`sweepOrphanLatchFileIfUnreferenced`), and returns the ACTUAL `{filename, entry}` it wrote — never a bare
`boolean` — so a caller can never mistakenly record the ORIGINAL (unwritten-to) filename as this entry's
own durable backing.

**Swept for other writers reaching a marked basename outside the reconcile chokepoint:** the only other
two raw write primitives in this file are `writeMergeQuarantineLatch` (already routes every write through
`reconcileMarkedBasenameBeforeWrite`/`foldInOnDiskTokensIfMarked`) and `writeSafetyTmpResidueAtHash`
(always writes a brand-new, randomly-suffixed tmp name — it never renames over an existing file at all, so
it cannot reach this bug class). `writePendingDivertFile` was the only gap.

**Caller-side fix:** every call site that can realistically receive a marked `sourceFile` — i.e. one
sourced from an existing `PendingUnresolvedQuarantine`'s own `sourceFile` rather than a fresh
`reconcilePendingDivertTarget`-chosen name — now uses the returned `filename`/`entry` (re-pointing
`activeQuarantines` via `replaceEntryEverywhere` when the entry object itself changed) instead of its own
original locals: `divertRaiseEntry`, `mergeTokenIntoPendingEntries`, the foreign-group loop inside
`consumeMatchedPendingsIntoArmedEntry`, and the three partial-clear `pending.sourceFile`/`p.sourceFile`
rewrites (`clearTokenFromPendingIndices`'s own "reduce" branch, `clearActiveEntryTokenAtKey`'s
dual-tracked-twin loop, and `deleteMergeQuarantineLatchByKey`'s own tied-pending-twin "reduce" branch).
**CORRECTION (round 6) — the claim below was FALSE for two of the three sites; see "Round 6" for the real
analysis and the fix.** `protectOccupantContentBeforeDelete` and `mintPendingDivert` BOTH needed, and now
have, the same "use the returned `{filename, entry}`" fix as the other six call sites — nothing in this
module adding a `pending-`-prefixed basename to `keptUnreadableLatchFiles` was wrong: boot's own PASS 1
read loop iterates EVERY `.json` file, pending-divert records included, and a read failure on one calls
`divertUnreadableBootLatch` exactly like a real quarantine final. `rewriteOrphanLatchFilesAfterPartialClear`'s
own `writePendingDivertFile(orphanFile, updated)` call is the ONE claim that held up — its caller already
refuses via `orphanRewriteOwnershipConfirmed`'s own `keptUnreadableLatchFiles.has(orphanFile)` check
(merge-quarantine.ts, that exact line — see "Round 6" for the current line number) before ever reaching
the write.

## Round 4 (same review, `b939aead`) — two further MINOR gaps

**MINOR — `reconcileMarkedBasenameBeforeWrite`'s reingest branch (round 2) forced `provenanceTracked:
true` unconditionally**, contrary to `db0a9db0`'s own "only `writeMergeQuarantineLatch` stamps it" rule —
every OTHER write helper must faithfully carry forward whatever the entry it's given already decided,
never originate a fresh `true`. Forcing it here ALSO skipped `detectUnknownProvenance` entirely, so a
LEGACY (pre-`48aeb324`) stray union recovered through this branch lost its due `provenanceUnknown`
flagging, and clear-by-id on it fails open (it looks like safely single-identity-tracked content).
**Fix:** run `detectUnknownProvenance(reingested, finalOwnHashForReingest)` — the SAME detector every
other re-parse site in this module uses, on the reingested record's own disk-sourced fields, before
anything overrides them — and fold its result into `provenanceUnknown` (sticky-true, never overridden
back to falsy); drop the forced `provenanceTracked: true` entirely, letting `reingested`'s own value
(disk's `provenanceTracked`, if any) ride through unchanged like every other field this branch doesn't
explicitly override.

**MINOR — the generic (non-reingest) branch lost a genuinely older on-disk raiser's own identity to a
NEWER raiser's, when the two merge through `enterMergeQuarantine`'s pending-merge branch with NO
intervening query.** Repro (`probe2` with `LATE=1`): boot marks `f` unreadable, diverting a placeholder
into `pendingUnresolvedQuarantines` (`sourceFile: f`). The genuine on-disk content at `f` is actually a
real, LONG-OUTSTANDING raise (branch `"real"`, an old `enteredAt`) that boot simply never got to read.
Before anything queries this repo, a FRESH raise for the SAME repo (branch `"fresh"`) comes in directly.
`consumeMatchedPendingsIntoArmedEntry` unions the matched placeholder with the fresh raise via
`unionQuarantineEntries` — which correctly never lets a placeholder's own synthetic timestamp win identity
over a REAL raiser (`92c645cc` round 2, item 3) — so the union's branch/reason become `"fresh"`'s, not the
placeholder's. But neither side of THAT union ever saw the genuine `"real"` identity sitting on disk at
all; it only exists in the file, unread until `foldInOnDiskTokensIfMarked` runs moments later. By then
`armed` no longer looks like a placeholder (`isUnreadablePlaceholderEntry` is false — its branch is now
`"fresh"`), so `reconcileMarkedBasenameBeforeWrite` takes the GENERIC branch, which only ever unioned
tokens/keys forward, never branch/reason/enteredAt/opId. Enforcement stays intact (every outstanding
token survives), but the durably-written and in-memory identity becomes `"fresh"`, even though `"real"`
was genuinely outstanding first — breaking round-7 M1's "longest-outstanding raise wins the identity" rule.
**Fix:** the generic branch now compares the on-disk record's own `enteredAt` against `entry`'s; when disk
is both OLDER and genuinely readable (real `branch`/`reason` strings — the same shape the `resurrectable`/
`onDiskKeys` check above it already confirms holds live, surviving content), its `branch`/`reason`/
`enteredAt`/`opId` win, mirroring `unionQuarantineEntries`'s own placeholder-agnostic age rule applied to
a REAL-vs-REAL comparison this call is the only place positioned to make (neither side of the earlier
in-memory union ever held disk's own identity to compare against).

## Round 5 (found verifying round 3, not in the original kickoff) — the reingest branch dropped a REAL raiser's own token, not just the placeholder's synthetic one

Discovered proving round 3's own fix RED/GREEN with `probe2.mjs` (no `LATE`): a fresh raise while `f` is
STILL unreadable goes through `divertRaiseEntry`, which — unlike `unionQuarantineEntries` — never applies
the placeholder-vs-real age arbitration (`92c645cc`): it hand-rolls `merged = {...base.entry, tokens, ...}`
from whichever matched entry has the LOWEST `enteredAt`, and a boot-time placeholder's `enteredAt` is
always earlier than anything raised after boot — so `merged` stays placeholder-SHAPED (branch, reason,
`placeholder:true` all still the synthetic ones) even though its `tokens[]` now ALSO holds the fresh
raiser's own real token, unioned in by `divertRaiseEntry` itself. The FIRST query after `f` becomes
readable then hits round 2's own reingest branch (`isUnreadablePlaceholderEntry(entry)` is still true) —
which, per its own prior "Do not" ("the placeholder's own synthetic token is deliberately DROPPED, not
unioned forward"), discarded `entry.tokens` WHOLESALE and kept only `reingested.tokens` (disk's own). That
rule was correct for the ONLY case round 2 ever tested (a bare, never-raised-again placeholder, whose
`tokens` holds nothing but its own synthetic UUID) — but round 1's own pre-round-3 overwrite bug meant a
raise-while-unreadable ALWAYS destructively completed its write (clearing the mark) before any later
reconcile could run, so this shape — a real raiser's token riding inside an otherwise placeholder-shaped
`entry` — was never reachable until round 3 closed that overwrite. Confirmed with the reviewer's own
`probe2.mjs` (no `LATE`): the fresh raise's own real token is present in-memory right after the raise, and
GONE after the very next query. Enforcement doesn't silently open (the disk-side-surviving `T1-final`
token, or whichever real identity won `reconcileMarkedBasenameBeforeWrite`'s own identity battle, keeps
the repo quarantined either way) — but the specific raiser now holds a token that clears nothing, ever.

**Fix:** union `entry`'s own tokens into the reingest branch's return, exactly like the GENERIC branch
(a few lines below it) already does — `tokens: [...new Set([...entry.tokens, ...reingested.tokens])]` —
rather than discarding `entry.tokens` wholesale. This also means the placeholder's own bare synthetic
token (when `entry` is NOT raise-augmented — round 2's own original scenario) now rides forward into the
union too, harmlessly: it is the SAME "extra, meaningless token" residual round 2 already names and
accepts elsewhere in this record, now applied consistently to BOTH branches of this chokepoint instead of
only one. Verified against the EXISTING round-2 test (`query-after-boot-reingests-real-record`) — every
one of its own token assertions is `.includes(realToken)`, never an exact-array check, so this residual
addition does not regress it.

## Round 6 (re-review of commit `fdec6e9a`) — round 3's own "structurally unreachable" claim was wrong for two of three sites, plus two test gaps

**MAJOR — `mintPendingDivert`'s and `protectOccupantContentBeforeDelete`'s own success branches ALSO
needed the "use the returned `{filename, entry}`" fix, and round 3 wrongly argued they didn't.** Both
premises round 3's record relied on were false: (a) boot's PASS 1 read loop (`files = all.filter(f =>
f.endsWith(".json"))`) iterates every `.json` file in `MERGE_QUARANTINE_DIR`, `pending-<hash>.json` divert
records included — a read failure on ONE calls `divertUnreadableBootLatch`, which `keptUnreadableLatchFiles.add(f)`s
it exactly like a real quarantine final, with no special-casing for the `pending-` prefix at all; (b)
`reconcilePendingDivertTarget` picks the PRIMARY pending-divert name whenever `readPendingDivertFileAt`
succeeds right now and the identity matches — it never consults `keptUnreadableLatchFiles`, so a mark
that predates the glitch clearing persists invisibly to it. So `writePendingDivertFile`'s own redirect
(round 3) DOES fire from inside both `mintPendingDivert` and `protectOccupantContentBeforeDelete` — and
both ignored the returned value, recording `sourceFile: <the original, still-marked primary name>` while
the REAL durable bytes land at a freshly-minted collision file nothing in memory references: an untracked
orphan a human clear can never find or sweep, so it never actually resolves and resurrects on the next boot.

Reproduced directly: an unresolvable repo raises (mints a `pending-<hash>.json` via `mintPendingDivert`),
a boot sees that EXACT file as unreadable (EACCES), the glitch clears, a second raise for the same still-
unresolvable identity comes in — `mintPendingDivert` redirects to a collision file holding BOTH raises'
tokens, but (pre-fix) recorded `sourceFile` as the original primary name. `clearMergeQuarantineReporting`
then operates on that wrong reference: it reports `latchKept:true` (honest about the marked primary) but
the collision file — the ONLY place the second raise's real content survives — is left on disk with
nothing in memory pointing at it, so nothing ever sweeps it, and the identity re-quarantines from the
unreferenced collision file's own content at the next boot even after a "successful" clear.

**Fix:** applied the SAME pattern as the six already-fixed call sites — `mintPendingDivert` and
`protectOccupantContentBeforeDelete` both now capture `writePendingDivertFile`'s return and use
`written.filename`/`written.entry` (re-pointing `activeQuarantines` via `replaceEntryEverywhere` when the
entry object changed) everywhere they previously used their own `filename`/`toWrite` locals, including
`protectOccupantContentBeforeDelete`'s own re-point/mint branches and its final `relocated:true` return.
**The third site's claim held up on re-verification:** `rewriteOrphanLatchFilesAfterPartialClear`'s own
`writePendingDivertFile(orphanFile, updated)` call (merge-quarantine.ts ~:3342) is genuinely unreachable
for the redirect — its caller refuses via `orphanRewriteOwnershipConfirmed`'s own
`keptUnreadableLatchFiles.has(orphanFile)` check (~:3326) before ever reaching the write. That is the ONE
part of round 3's sweep that was correct; do not re-litigate it.

**Test gap #1 (round 5's token union, `~:1254`):** no existing check failed if that ONE line were
reverted back to `tokens: reingested.tokens` — every assertion that WOULD catch it only runs in `boot2`
(a fresh module reading from disk), and round 5's own on-disk write happens to still carry the token
forward correctly even with the revert, in the specific shapes those checks probed. **Fix:** added an
IN-PROCESS query, in the SAME `boot1` instance, immediately after the injected glitch clears and the raise
completes — verified RED under exactly that single-line revert (confirmed: reverting only that line fails
THREE checks, all within this ONE scenario — the new in-process assertion itself, plus the pre-existing
boot2-in-memory and boot2-on-disk freshToken assertions, since the in-process query's own write durably
persists the now-incomplete record those two later checks read — while the other 15 scenarios stay green,
exactly as flagged) and GREEN with the real fix restored.

**Test gap #2 / MINOR (the stray synthetic token, same line):** round 5's own fix unioned `entry.tokens`
forward unconditionally, which re-introduces the placeholder's bare synthetic `randomUUID()` into the
final token set even on the PLAIN query-after-boot path (no raise at all) — the exact "extra, meaningless
token" shape round 2 originally accepted as a harmless residual, now happening on EVERY reingest, not just
a raise-augmented one. **Fix:** a new module-level `unreadablePlaceholderTokens` Set records every
synthetic token `divertUnreadableBootLatch` ever mints (captured at mint time, right where `randomUUID()`
is called), and the reingest branch's token union now filters `entry.tokens` through
`!unreadablePlaceholderTokens.has(t)` before unioning — so the placeholder's own synthetic token is
dropped (restoring round 2's original guarantee: a plain query-after-boot path, with no raise involved,
carries ONLY the genuine on-disk token(s)), while a REAL raiser's own token (round 5's actual fix target)
still survives the union untouched, since it is never a member of that set.

## Round 7 (re-review `eadada0b` of commit `8869255f`) — a human clear over a marked primary could still re-quarantine on the next boot, plus a stray synthetic token on the raise path

**MAJOR — the round-6 fix still lost a clear's own resolution the moment the clear ran over a marked
PRIMARY pending-divert file.** `reconcilePendingDivertTarget` (used by `mintPendingDivert` and
`protectOccupantContentBeforeDelete`) already proves, by successfully reading the primary file and
confirming the SAME identity, that overwriting it in place is safe — but `writePendingDivertFile` (the
one shared write chokepoint every diverting caller funnels through) redirected anyway, on the STALE
`keptUnreadableLatchFiles` mark alone, never consulting that proof. A fresh raise for an identity whose
own primary pending-divert file was marked unreadable at an EARLIER boot — but is genuinely readable
again by the time of the raise — minted a brand-new collision file instead of overwriting the primary in
place, leaving the primary's own now-superseded bytes on disk, still marked kept. A human clear then
genuinely removed the collision file (correct) but left the marked primary untouched (also "correct" by
the OLD rule) — so the NEXT boot re-read the primary's own stale content and re-quarantined the exact
identity the clear had just resolved.

Reproduced directly: an unresolvable X raises (mints `pending-<hash>.json`); a boot injects a transient
EACCES on that file (marking it `keptUnreadableLatchFiles`); the glitch clears; a fresh raise for X comes
in — the primary is genuinely readable right now, but still marked — and mints a collision file instead
of overwriting in place; `clearMergeQuarantineReporting(X)` reports `latchKept:true` and genuinely removes
the collision file, but the marked primary (still carrying the FIRST raise's own stale branch/token)
survives untouched; a second boot re-reads it and re-quarantines X with that stale content — the very
raise the clear had just lifted. Reproduces identically whether X is registered at boot or not: X's own
`pending-<hash>.json` hash (`sha256(directPathIdentity(X))`) never matches boot's `quarantineHashFor`-keyed
lookups (`hashToRepo`/`unresolvedClaimantsByHash`/`ancestorHashToRepo`, all keyed off
`canonicalRepoLockKey` — a deliberately disjoint hash space, `d4b25feb`), so a read failure on it always
falls to the generic orphan cascade either way, and the second raise always reaches this bug through the
SAME `mintPendingDivert`/`reconcilePendingDivertTarget` path regardless of registration. (Registering X
ALSO trips a wholly separate, pre-existing mechanism — boot's own "no registered repo's hash matched —
defensively quarantine EVERY registered repo against it" orphan fallback, `reenterMergeQuarantinesAtBootImpl`
~:6947 — which independently arms X at a DEGRADED `canonicalRepoLockKey` and can leave the clear's own
`latchKept` field `true` from an unrelated ordering artifact between that defensive entry and X's own
real pending record; that mechanism and its artifact are immaterial to this card.)

**Fix:** `writePendingDivertFile` itself now re-reads a marked `filename` right before deciding, instead
of trusting the cached `keptUnreadableLatchFiles` boolean blindly. A successful, same-identity read
(`readPendingDivertFileAt` returning `"entry"` with a matching `directPathIdentity`) discharges the
redirect: the on-disk content is unioned forward via the SAME `unionIntoOnDiskPendingEntry` helper
`reconcilePendingDivertTarget` already uses, and the write proceeds IN PLACE at `filename` — the existing
success-path rename already clears `keptUnreadableLatchFiles` for whatever it wrote to (round 3's own
`63e49ee2`-mirrored rule), so no separate discharge step was needed. An `"enoent"` read (nothing real
there any more) also proceeds in place, unchanged. Every OTHER outcome — still genuinely unreadable,
corrupt, or a DIFFERENT identity entirely — keeps the pre-existing redirect, unchanged: this is what
preserves round 3's own critical guarantee (a raise while `final` is STILL unreadable must never rename
over it — `divertRaiseEntry`'s own call, where `base.sourceFile` can be a REAL quarantine final genuinely
never readable during the write, keeps redirecting exactly as before). Fixing this at the ONE write
chokepoint — rather than threading a "already reconciled" flag through `reconcilePendingDivertTarget`'s
own two callers — closes the gap for every diverting caller at once, including `divertRaiseEntry` and
`mergeTokenIntoPendingEntries`, which never called `reconcilePendingDivertTarget` at all and so could
never have benefited from a caller-side-only fix.

**MINOR — the raise-path's own hand-rolled token union (`divertRaiseEntry`, and the structurally
identical union in `mergeTokenIntoPendingEntries`) never filtered `unreadablePlaceholderTokens`,** unlike
round 4's own fix to `reconcileMarkedBasenameBeforeWrite`'s reingest branch. Proven with a dedicated
no-in-process-query repro (the in-process query in the sibling scenario graduates/reingests the
placeholder immediately, which already filters the token there — skipping it instead lets
`divertRaiseEntry`'s own union durably persist the boot placeholder's bare synthetic UUID all the way to a
second boot's on-disk read, alongside the real and fresh-raiser tokens). **Fix:** both unions now filter
`unreadablePlaceholderTokens` out of every matched entry's own `tokens` before unioning, exactly mirroring
the reingest branch's existing filter.

## Do not

- Do not restructure any of the three existing `try`/`catch` blocks into a read-stage/parse-stage split to
  make this discrimination — the errno-`.code` check at the top of the EXISTING catch is sufficient and
  far lower-risk against a function this heavily decision-anchored (`97cff6db`/`92c645cc`/`883e29bc`/
  `d163aef5`/`ef651188`/`4783df46`/... all govern exact ordering and write-deferral inside these same
  loops). A restructure risks silently reordering one of those guards.
- Do not treat ENOENT or EISDIR as unreadable — both mean "nothing real there" (the file vanished, or a
  directory sits where a file name was expected), and the existing corrupt-latch cascade already handles
  both safely (nothing is lost by writing a fresh placeholder where nothing real existed). Only a
  genuinely unreadable FILE — a real errno other than those two — is unreadable in this card's sense.
- Do not add `.code` to a field-validation `throw new Error(...)` or to any manually-constructed error in
  this module — the entire discrimination depends on only a REAL `fs.readFileSync` failure carrying one.
  Pinned by `corrupt-json-unchanged-non-regression` and `corrupt-field-validation-unchanged-non-regression`
  in the test file: both still take the existing corrupt path, unaffected by this card.
- Do not assume an unknown/unrecognized errno code defaults to "corrupt" — it must default to
  "unreadable". The matrix scenario pins `EACCES`/`EMFILE`/`EPERM`/`EBUSY` AND one made-up code
  (`EWEIRD_UNKNOWN_CODE`) all taking the unreadable branch — only `ENOENT`/`EISDIR` are excluded by name.
- Do not reference the catch-local `const hash = f.slice(...)` by its bare identifier at the TOP of the
  safety-tmp catch block — it is block-scoped (TDZ) for the WHOLE catch, including lines textually before
  its own declaration, so referencing `hash` there is a `tsc` error (and would be a runtime
  ReferenceError). Recompute it directly from `f` instead (see the safety-tmp site's own inline comment).
- Do not touch the stale-tmp-beside-a-clean-final delete shortcuts (e.g. PASS 1b's own
  `fs.unlinkSync(tmpPath)` early-exit, or any of the "leftover tmp beside a good final write is harmless"
  bare unlinks near the end-of-boot write passes) — those are a DIFFERENT, unrelated card's scope (tmp-
  residue sweep, card `21ec39e5`, lands right after this one on the same file).
- Do not let `reconcileMarkedBasenameBeforeWrite`'s re-ingestion branch (round 2) adopt the on-disk
  record's own `resolvedKey`/`armedKeys` — those are the CALLER's already-stamped, write-target-scoped
  values; adopting the disk's own (possibly stale, possibly for a different target key) values can re-
  arm a secondary key the caller never asked for. `branch`/`reason`/`enteredAt`/`tokens`/`opId`/
  `orphanLatchFiles`/`contributorRepoPaths`/`provenanceUnknown` come from disk (via
  `latchEntryFromParsedRecord`); `resolvedKey`/`armedKeys` come from `entry`; `resolvedKeys` is a UNION of
  `entry`'s own value with disk's own informative keys (never disk alone, never entry alone); and
  `provenanceTracked` is forced `true` regardless of what either side carried — see Round 4's own section
  below for why that specific override is itself a separate, narrower defect this card also fixes.
- Do not reference `reconcileMarkedBasenameBeforeWrite`'s round-2 re-ingestion branch as "fixing" a
  non-placeholder entry's own generic token union below it — the two branches are mutually exclusive by
  construction (`isUnreadablePlaceholderEntry(entry)` gates the first); a real, non-placeholder entry
  always falls through to the UNCHANGED generic branch, exactly as before this round.
- Do not add `bootWriteLatch`'s round-2 external reconcile call anywhere OTHER than that one chokepoint —
  it is the single site every boot write already goes through (`merge-quarantine-boot-write-chokepoint-
  guard.mjs`), so duplicating the reconcile-then-sync pattern at a second site would only risk the two
  drifting apart, never add coverage.
- Do not read a `bootWriteLatch` call's `reconciledAlready:true` as "no further read of `final` happens
  this write" in general — it only means THIS call already ran the ONE read `writeMergeQuarantineLatch`
  would otherwise run again; a later, unrelated boot write to the SAME basename still reconciles fresh.
- Do not set `unattributed:true` anywhere in `deleteMergeQuarantineLatchByKey` OTHER than the bare
  "finalProtectOk false, keptClaimants empty" branch — the OTHER `else if` branch already names real
  claimants via `keptClaimants`, which is itself sufficient attribution; adding `unattributed` there too
  would double-count the same keep under two different signals.
- Do not assume the "extra, meaningless token" residual this round's own probe surfaced (a stale pending
  divert's own synthetic UUID riding permanently into the real record's `tokens[]` the first time
  anything graduates it after a sibling's write already recovered the real content) is itself a data-loss
  bug — it is cosmetic pollution, not a correctness regression: one harmless, never-referenced extra
  token that then persists on disk PERMANENTLY (not "once" — nothing in this module ever removes it), and
  was left as a named, accepted residual rather than chased further in this round.
- Do not have a caller of `writePendingDivertFile` (round 3) keep using its OWN original `filename`/
  `entry` locals after a successful call — use the RETURNED `{filename, entry}`, which can legitimately
  differ (a redirect happened) or be identical (the overwhelming common case) — a caller that ignores the
  return and assumes its own arguments is exactly the bug this round closes, one level up.
- **(SUPERSEDED BY ROUND 6 — do NOT follow this old direction.)** This bullet used to say round 3's
  caller-side fix must NOT be extended to `protectOccupantContentBeforeDelete`/`mintPendingDivert`, on the
  claim both are structurally unreachable for the redirect. That claim was FALSE — round 6 found and
  fixed the real gap; see "Round 6" above for why boot's own PASS 1 read loop reaches a `pending-`
  basename too. `rewriteOrphanLatchFilesAfterPartialClear`'s own call is the ONE site this bullet was
  actually right about — it alone is still correctly left unchanged, per its own `orphanRewriteOwnershipConfirmed`
  guard (see "Round 6").
- Do not compare `entry.enteredAt` against the on-disk record's own `enteredAt` (round 4's generic-branch
  identity fix) using anything other than the ALREADY-VALIDATED `parsed.branch`/`parsed.reason` strings —
  an on-disk record with a numeric `enteredAt` but no genuine branch/reason (impossible in practice today,
  since nothing in this module ever writes such a shape, but not provably so) must never win identity
  with no identity to adopt.
- Do not conflate round 4's generic-branch identity fix with round 2's reingest branch — they are mutually
  exclusive by the SAME `isUnreadablePlaceholderEntry(entry)` gate round 2 already established; round 4
  only ever runs when `entry` is NOT itself still placeholder-shaped (i.e. an earlier union already
  resolved placeholder-vs-real in `entry`'s own favor), which is precisely the shape where the genuinely
  older on-disk identity was never compared against anything until this call.
- Do not revert round 5's reingest-branch token union back to "drop `entry.tokens` wholesale" on the
  grounds that round 2's own original "Do not" said so — that prior rule was correct only for a bare,
  never-raised-again placeholder; `divertRaiseEntry` can union a REAL raiser's own token into an otherwise
  placeholder-shaped `entry` before this branch ever runs, and dropping `entry.tokens` then silently
  orphans that raiser's token forever. See "Round 5" above.
- Do not fix `divertRaiseEntry`'s own lack of placeholder-vs-real age arbitration (the root reason `entry`
  can still be placeholder-SHAPED despite holding a real raiser's token) as part of this card — round 5's
  fix closes the DATA-LOSS consequence at the one chokepoint that matters (the reconcile write), without
  restructuring `divertRaiseEntry`'s own base-selection logic, which several OTHER decision records
  (`af948556`/`67136b71`/`8db913e2`) already heavily anchor.
- Do not trust a "structurally unreachable, no caller-side fix needed" claim in THIS record (or any
  other) without re-deriving it from source yourself — round 3's own version of exactly that claim, about
  these same two call sites, was wrong. Re-verify by reading `divertUnreadableBootLatch`'s own call sites
  and `reconcilePendingDivertTarget`'s own logic directly; do not reason from a prior round's prose alone.
- Do not let `mintPendingDivert`'s or `protectOccupantContentBeforeDelete`'s double-fault/failure
  fallback branches start using `written.filename`/`written.entry` too — `written` is `false` on that
  path (the write itself failed); those branches correctly keep using their own `filename`/`toWrite`
  locals, exactly as before round 6.
- **(SUPERSEDED BY ROUND 7 — do NOT follow this old restriction.)** This bullet used to say
  `unreadablePlaceholderTokens` membership checks belong ONLY in the reingest branch's own token union.
  False: `divertRaiseEntry`'s and `mergeTokenIntoPendingEntries`'s own hand-rolled token unions are the
  SAME shape (a matched entry can be the boot placeholder itself) and round 7 filters both too. The rule
  that survives is narrower: filter it at every site that unions a POSSIBLY-placeholder entry's own
  `tokens` forward into a durable record — never at a site with no such union to protect.
- Do not revert `writePendingDivertFile`'s round-7 re-read to a caller-side "already reconciled" flag
  threaded from `reconcilePendingDivertTarget` — that would fix only `mintPendingDivert`/
  `protectOccupantContentBeforeDelete` and leave `divertRaiseEntry`/`mergeTokenIntoPendingEntries`
  (which never call `reconcilePendingDivertTarget`) exactly as broken as before round 7.
- Do not treat a redundant SECOND read of the SAME marked file (once inside `reconcilePendingDivertTarget`,
  once inside `writePendingDivertFile`'s own round-7 check, for `mintPendingDivert`'s and
  `protectOccupantContentBeforeDelete`'s calls specifically) as the CR2 B2 hazard `8db913e2` round 3's
  `reconciledAlready` flag exists to prevent — that hazard is about two reads separated by enough real
  work for a TRANSIENT failure to flip between them; these two reads are back-to-back, synchronous, with
  no I/O in between, and even a pathological flip only yields the pre-existing (safe) redirect, never an
  unsafe overwrite.
- Do not assert `clearMergeQuarantineReporting`'s own `latchKept` field for the "registered" boot variant
  of `mintpendingdivert-uses-returned-redirect-target` — the pre-existing "defensively quarantine every
  registered repo against an unmatched orphan" fallback (see "Round 7" above) can leave it `true` from an
  ordering artifact unrelated to this card; assert the file-system-level outcome (no stale file survives
  the clear; nothing remains after a second boot) instead, for both variants.

## Tests

`packages/daemon/test/merge-quarantine-boot-unreadable-vs-corrupt.mjs` — round 1's nine scenarios (the
three sites each surviving an injected read failure byte-identical and fail-closed-pending; a no-match
unreadable file landing in the ordinary orphan cascade while staying untouched; two negative controls,
genuinely corrupt JSON and valid-JSON-but-failed-field-validation, pinning the existing corrupt path
unchanged; an errno matrix; a clear-after-unreadable-boot scenario, corrected this round to assert it
DOES go RED on `main`; and a multi-boot recovery scenario), PLUS round 2's own additions covering MAJOR
1 (query-after-boot re-ingests the real record, never the placeholder's own branch/reason), MAJOR 2 (a
transient failure plus a tmp/migrate sibling preserves every token, in memory AND on disk, across a
second boot), and the MINOR clear-reporting fix (a graduated-then-still-unreadable active clear now
reports `latchKept:true`). All RED on `main` where meaningful, GREEN after.

Round 2's own reproductions reused the Code Reviewer's probe script verbatim (`<tmp|migrate|none>
<daemonDir> <persistent|transient>`, `TRACE=1` renames-over-`final` tracing, `RAISE=1`) — copied into
this worker's own scratch dir per the kickoff's instruction, never run from the reviewer's own path.

Rounds 3-5 added three further scenarios to the same test file: `raise-while-unreadable-never-overwrites-
final` (round 3's CRITICAL fix — a raise while `f` is still unreadable leaves `f` byte-identical, and the
real branch/opId/resolvedKeys/token AND the fresh raiser's own token all survive a later boot once
readable — round 5's fix is what makes the fresh raiser's own token survive here), `fresh-raise-after-
readable-keeps-older-ondisk-identity` (round 4's generic-branch identity fix — a fresh raise arriving
AFTER `f` becomes readable again still yields the genuinely older on-disk branch/reason/opId/enteredAt,
never the fresher raiser's), and `reingest-detects-legacy-stray-union-provenance` (round 4's MINOR
`provenanceUnknown` fix — a legacy, pre-`48aeb324`-shaped stray union recovered through the reingest
branch is correctly flagged `provenanceUnknown:true`). All three verified RED against the round-2 tip
(`ae7a21e5`, by temporarily swapping in that commit's own `merge-quarantine.ts`, rebuilding, and
confirming each new scenario's own assertions fail there) and GREEN on this round's own fix; the
reviewer's `probe2.mjs` (no `LATE` vs `LATE=1`) is what surfaced round 5 in the first place and was used,
unmodified, to confirm the fix by hand before it was turned into a committed scenario.

Round 6 added one further scenario, `mintpendingdivert-uses-returned-redirect-target` (the MAJOR fix —
an unresolvable repo's second raise mints a collision file via `mintPendingDivert`, and a human clear
correctly sweeps THAT file rather than leaving it an untracked orphan while the still-marked primary
survives untouched), and extended two existing ones: `raise-while-unreadable-never-overwrites-final`
gained an IN-PROCESS `activeMergeQuarantineFor` query right after the glitch clears (the actual negative
control for round 5's token union — verified RED under a temporary single-line revert of that one line,
confirmed to be the ONLY one of 16 scenarios affected, matching the re-review's own prediction exactly;
restored immediately after) and a corrected `resolvedKeys` fixture (a genuine secondary key, distinct
from the file's own primary key — the original `[kd]`-only fixture was degenerate, since
`reconcileMarkedBasenameBeforeWrite`'s own primary-key exclusion rule correctly drops a resolvedKeys entry
equal to the file's own key, which the ORIGINAL fixture accidentally tripped once an in-process query
was added); `query-after-boot-reingests-real-record` gained three exact-token-set assertions (query, on
disk, and boot2) proving the plain no-raise path now carries ONLY the genuine token, verified RED on
`fdec6e9a` and GREEN on this round's own fix. The new MAJOR scenario was also verified RED on `fdec6e9a`
the same way as rounds 3-5's own scenarios (temporary source swap, rebuild, run, restore).

Round 7 rewrote `mintpendingdivert-uses-returned-redirect-target` in place (the MAJOR fix — the round-6
scenario's own "the marked primary survives the clear untouched" assertion LOCKED IN the bug this round
closes, so it is removed rather than kept alongside the fix) to loop over BOTH the registered and
unregistered boot variants and add a boot2 step: the second raise now overwrites the primary IN PLACE
(no collision file minted; both raises' tokens unioned; the original branch survives), the clear
genuinely removes the primary (no stale file left), and a second boot does NOT re-quarantine the
identity, with no orphan/collision file left behind — verified RED against this round's own
`writePendingDivertFile` fix (a temporary unconditional-redirect revert, isolated from the fix via a full
rebuild+run+restore, confirmed to fail the same assertions this round added, for BOTH variants) and GREEN
restored. (`clearMergeQuarantineReporting`'s own `latchKept` field is deliberately NOT asserted — see this
record's own "Do not" section.) Round 7 also added `raise-while-unreadable-no-query-exact-token-set` (the
MINOR fix — the no-in-process-query variant of `raise-while-unreadable-never-overwrites-final`, asserting
boot2's own EXACT token set, in memory and on disk, is `[realToken, freshToken]` with no stray synthetic
placeholder UUID) — verified RED under a temporary single-line revert of `divertRaiseEntry`'s own token
filter (confirmed to be the ONLY one of 17 scenarios affected) and GREEN restored.
