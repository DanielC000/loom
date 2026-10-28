# 0d3b64c6 — tombstone a bled token under every holder, and match a drifted identity

From card `8bc779f0`'s own round-3 Code Review (reviewer `a25e852d`, 2026-10-27). Round 3 scoped
`clearedTokens` to the clearing identity, closing a reproduced fail-OPEN (a bled token cleared under Y
lifted X with nobody clearing X). That review found two fail-CLOSED regressions this card fixes (SF1,
SF2), a test gap (SF3), and two record corrections elsewhere (NIT4, on `8bc779f0`'s own record; NIT5,
below).

## SF1 — a bled token tombstoned only under the LAST holder, never every holder

`tombstoneIfNotSurviving`'s own survival scan (condition (a)) used to scan `activeQuarantines`/
`pendingUnresolvedQuarantines` GLOBALLY, across every identity, before deciding whether to record a
tombstone for the clearing identity. When a token's value bled into two identities' own ACTIVE records
(`398f476c`/`f575cebf`) and `clearMergeQuarantineByToken` released it from both in one call (its own
multi-holder sweep, active then pending), the identity processed FIRST still saw the SECOND holder's
own, not-yet-processed entry as "surviving" and skipped recording a tombstone at all for that identity;
the identity processed LAST then got the ONLY tombstone, for a token it may not have originally raised.

**Reproduced:** X active `[synth, t2, xTok]`; Y active `[yTok, xTok]`. `clearMergeQuarantineByToken(x,
xTok)` with a durable-write failure (ENOSPC) on X's own final leaves X's final holding stale bytes
`[xTok, t2]`. Clearing `t2` then `synth` reaches the reconcile over those stale bytes — the tombstone for
`xTok` was recorded under Y only (Y was processed last in the sweep), so X's own reconcile (declaring
X's own identity) never finds it and resurrects `xTok`. X never lifts. Pre-round-3 (`54e60408`, a bare
identity-less `Set`) this correctly lifted; round-3's own identity-scoping regressed it.

### The fix — scope the survival scan to the CLEARING identity's own entries

The scan (condition (a)) is now scoped: it only collects tokens still held by entries whose own
`directPathIdentity(entry.repoPath)` equals the clearing identity — normalized through the SAME
`directPathIdentity` the tombstone attribution itself uses, never a second, independently-derived
comparison. The scan still covers EVERY one of the clearing identity's own entries (active and pending
both), never just the single entry/key this particular call mutated — preserving the "even the SAME
occupant" safety condition (a) always had (a sibling pending twin, or content this same clear's own write
path durably protects elsewhere under the SAME identity, still blocks the tombstone).

**The rule this makes true:** a tombstone recorded under identity A is only ever CONSULTED by a reader
that itself declares identity A — `readSurvivingOnDiskTokens`/`tokenTombstonedForIdentity` both require an
exact identity match before honoring it. So a DIFFERENT identity B still holding this same token value has
nothing for A's own tombstone to protect FROM: B's own reads never consult a tombstone attributed to A, no
matter when A's tombstone gets recorded. Scanning globally only ever delayed WHEN a tombstone got
attributed to a given identity (until whichever holder happened to be processed last released it); it was
never what made that attribution safe for a DIFFERENT identity's own reads, which have always been
identity-scoped since round 3. Now, each holder is tombstoned for its OWN release, at the moment ITS own
entries stop holding the token — independent of whether a sibling identity still holds the same value.

### Rejected alternative — defer every tombstone until the whole multi-holder sweep finishes

The card's own investigate-first step named a second option: keep the scan global, but hoist every
`tombstoneIfNotSurviving` call out of `clearActiveEntryTokenAtKey`/`clearTokenFromPendingIndices` and fire
one call per holder identity only after `clearMergeQuarantineByToken`'s own multi-holder loop (pending,
then active) has fully finished mutating every holder.

**Rejected** because it would reopen the `8db913e2` CR2-B1 timing hazard for whichever holder is processed
FIRST in that loop: that holder's own write (inside `clearActiveEntryTokenAtKey`/
`clearTokenFromPendingIndices`, reached BEFORE a deferred tombstone call would ever fire) relies on the
tombstone already being recorded so its own chokepoint union (`reconcileMarkedBasenameBeforeWrite`,
reached if that SAME write happens to touch a marked-unreadable final) correctly excludes the
just-cleared token. Deferring the tombstone past that write reopens exactly the stale-bytes resurrection
CR2-B1 fixed. Rescoping the scan (the fix above) keeps the tombstone recorded immediately after each
holder's own in-memory removal, preserving that timing, while still fixing the cross-identity blocking.

## SF2 — identity drift once a path stops resolving (a removed/retargeted junction or symlink)

`directPathIdentity` realpaths `repoPath` while it resolves, falling back to `path.resolve` once it
doesn't (merge-quarantine.ts, `directPathIdentity`). The tombstone attribution computed this identity ONCE,
at clear time, while the path still resolved (giving the REALPATH form). A later reconcile recomputes the
SAME function fresh, at READ time, from the record's own stored `repoPath` string — if the path has since
stopped resolving (its junction/symlink removed), this now returns the PATH.RESOLVE fallback form instead,
a genuinely different string. The two forms never match, the old tombstone is never recognized, and the
already-cleared token resurrects — a repo stays quarantined after every genuinely-outstanding token has
been cleared.

**Reproduced** two ways: with my own fixture (a junction `y` -> a real target directory; raise+clear a
token while `y` resolves; remove the junction; force the stale-bytes-and-marked-final shape; clear every
remaining live token) and independently against the reviewer's own `probe1.mjs` fixture (run directly
against this project's build) confirming `directPathIdentity(y)` genuinely differs before vs. after the
junction is removed.

### The fix — reuse `literalRepoPathKey` (repo-lock.ts), never invent a new helper

`repo-lock.ts` already exports `literalRepoPathKey(p)` (`path.resolve(p)`, trailing slash stripped,
lowercased on win32) for exactly this shape — comparing a value stored earlier against a path that may
have since drifted (used today for the commondir-trust-pin check, card `3a5c5d4a`). This is TIME-STABLE:
it never depends on whether the path currently resolves, so the SAME string comes out whether computed at
clear time (while the junction still resolved) or at read time (after it's gone) — unlike
`directPathIdentity`, which is exactly the function whose fallback-vs-realpath divergence causes the drift.

`tombstoneIfNotSurviving` now attributes a tombstone under BOTH `directPathIdentity(clearingIdentity)` AND
`literalRepoPathKey(clearingIdentity)`. `tokenTombstonedForIdentity` (the one shared reader every
`clearedTokens` consumer already routes through — `readSurvivingOnDiskTokens` and the three inline
coverage-proof call sites) now matches on EITHER form of `recordIdentity`. A record's own stored `repoPath`
string never changes across a reconcile (confirmed below, answering the card's own open question), so
`literalRepoPathKey(recordIdentity)` computed at read time is IDENTICAL to the SAME computation at clear
time — it was never a function of resolvability to begin with.

### Round 2 (Code Review, NOT-SHIP) — B1: a cross-FORM collision, reproduced; S1: most call sites' literal attribution was a no-op; S2: the test couldn't detect either

The round-1 fix above shipped `clearedTokens: Map<token, Set<identity>>` with BOTH forms added into ONE
shared set, and read it back as `owners.has(direct(X)) || owners.has(literal(X))`. The Code Review
reproduced a fail-OPEN this combined-set shape permits: a path's own DIRECT (realpath) identity at READ
TIME can equal a DIFFERENT path's own LITERAL identity attributed at CLEAR TIME, whenever a junction is
later removed and replaced by a real directory, and a new junction is then pointed at that same real
directory (the reviewer's `sf2-driftin-bytoken.mjs`). Concretely: Y = junction `J` -> target `TY`; Y's own
record (bled with `xTok`) is cleared while `J` still resolves, attributing `xTok` under
`direct(J)=realpath(J)=TY` and `literal(J)=path.resolve(J)="J"`. `J` is then removed and replaced by a
REAL directory (no longer a junction); a NEW junction `Q` is pointed AT `J` (now real). `direct(Q) =
realpath(Q) = "J"` — textually IDENTICAL to Y's own OLD `literal(J)` attribution. X's own record
(`repoPath=Q`) reconciling a marked-unreadable final carrying `xTok` then checks `owners.has(direct(Q))`
— TRUE, because `"J"` is in the ONE shared set — and wrongly drops `xTok`, even though X never released
it. Reproduced directly (see Tests, Scenario 3 below) before any round-2 fix was written.

**The fix — TWO NAMESPACES, never one shared set.** `clearedTokens` is now `Map<token, {direct: Set,
literal: Set}>`. `tombstoneIfNotSurviving` adds `direct(clearingIdentity)` to `.direct` and
`literal(clearingIdentity)` to `.literal`, never mixed. `tokenTombstonedForIdentity` matches
`direct(recordIdentity)` ONLY against `.direct` and `literal(recordIdentity)` ONLY against `.literal` —
never cross-namespace. This still closes the original SF2 case (a read-time `direct()` recompute that has
fallen back to the SAME value `literal()` always computes, checked against the `.literal` set populated at
clear time with that SAME time-stable value — a literal-vs-literal match) while killing the cross-form
hit above (`direct(Q)="J"` is checked ONLY against `.direct`, which holds `{TY}`, not `"J"`; `literal(Q)`
computed fresh is `"Q"` itself, checked ONLY against `.literal`, which holds `{"J"}`, not `"Q"` — no match
either way).

**S1 — most call sites' own literal attribution was a no-op, because they pre-normalized.** Of the 7
`tombstoneIfNotSurviving` call sites, only `clearActiveEntryTokenAtKey`'s two (passing `entry.repoPath`,
raw) were already correct. The other 5 passed an identity LOCAL already computed via
`directPathIdentity(...)` earlier in the same function — `clearMergeQuarantineByKey`,
`tryClearMergeQuarantineByOwnIdentity`, and `clearTokenFromPendingIndices`'s own two calls (which passed
the already-normalized `identity` local, not `live.entry.repoPath`). Since `literalRepoPathKey` is NOT
idempotent on an already-resolved path the way `directPathIdentity` is,
`literalRepoPathKey(directPathIdentity(raw))` collapses to the direct form itself — identical to it,
contributing NOTHING beyond what the direct form already attributed. **Fixed:** every call site now
threads the RAW `repoPath` (never a pre-normalized value) into `tombstoneIfNotSurviving`. The one
genuinely plural site (`clearMergeQuarantineLatchFile`'s pending-by-id bucket) needed a structural change
beyond swapping one variable: `matchedPending` entries sharing one `directPathIdentity` bucket key can
still carry DIFFERENT raw `repoPath` spellings (literal form is not spelling-insensitive the way direct
form is), so each bucket now also collects every distinct raw spelling that fed it (`rawRepoPaths`), and
`tombstoneIfNotSurviving` is called once PER raw spelling in the bucket — same tokens/basenames each time,
each call contributing its own `direct`/`literal` pair (the direct form is identical across all of them
by construction; only the literal form can differ). The round-1 doc comment's own "pass raw or normalized
— both collapse to the same key" claim is corrected in place: true for the direct form, false for the
literal form, which is exactly why this bug existed.

**S2 — the round-1 test couldn't detect a reopened fail-open.** Mutating `tokenTombstonedForIdentity` to
ignore identity entirely (`return owners.direct.size > 0 || owners.literal.size > 0`) left the round-1
test file fully GREEN — Scenario 1's own cross-identity ("Y untouched") check only asserted `yTok`'s
presence, never `xTok`'s, and every reconcile in Scenarios 1/2 only ever checked ITS OWN identity against
its OWN genuine tombstone (never a DIFFERENT identity's), so an identity-blind mutation changes nothing
observable there. **Fixed two ways:** (1) Scenario 1 now also asserts, as an explicit precondition, that Y
genuinely holds the bled `xTok` before any clear, and as a sanity check after, that Y's OWN copy of it is
ALSO genuinely gone (it released it too, in the same multi-holder sweep) — tightening the existing
assertion's wording without claiming it discriminates the identity-blind mutation (it doesn't; this is a
completeness fix, not a new discriminator). (2) B1's own fixture is now a committed Scenario 3 (below) —
run directly against the identity-ignoring mutation, it fails (`xTok3` is wrongly dropped), confirming the
test FILE as a whole goes RED under that mutation. The mutation was applied as a throwaway edit, rebuilt,
run (RED confirmed, 1 failure, exactly Scenario 3's own discriminating check), then reverted and rebuilt
again (GREEN restored) before this round's own commit.

### Round 3 (Code Review, NOT-SHIP on round 2) — SF-3: gate `.literal` on resolvability

Round 2's SHIP-quality verdict on the fail-closed side (all 7 drift-lift routes, below) came with ONE new
bleed-conditional fail-open that round 2 itself introduced: case (A) in the collision analysis below. The
reviewer's own fixture (`zz-cr-0d3b64c6-r2-scratch.mjs`, case A) reproduced it directly: HEAD (round 2)
dropped X's genuine `xTok`; `23dabc63` (pre-card) was safe for this exact case.

**The fix:** `tokenTombstonedForIdentity` now consults `.literal` ONLY when `recordIdentity` is NOT
currently resolvable (`isRepoPathCurrentlyResolvable`, `repo-lock.ts` — already imported). `.direct` is
still checked unconditionally first; the resolvability check (one more `fs.realpathSync` call) is paid
only when `.direct` alone didn't already find a match, so the hot/common path (a direct hit) never pays
for it. SF2's own motivating case IS exactly "the path stopped resolving" — `.literal` exists to recognize
a tombstone from before that happened, so gating it on the SAME condition is not a narrowing invented for
this card alone, it is the condition the mechanism was always FOR.

**The residual this gate itself carries — CLOSED by round 4, below, not left as an accepted risk.** Round
3 itself named the asymmetric failure mode (a transient non-ENOENT `isRepoPathCurrentlyResolvable` error
wrongly enabling `.literal`) as "a real, accepted, narrower residual... not closed by this card." Round
4's own Code Review reproduced it directly, found it was reachable WITHOUT any transient error at all (a
genuinely dangling link also returns `false` from that same bare catch), and closed both shapes. See the
Round 4 section below — this paragraph is superseded, not merely extended.

Verified against the reviewer's full fixture (cases A/B/C and all 7 drift-lift routes D): (A) now PASSES;
(B)/(C) still fail, identically to pre-card `23dabc63` (see below); all 7 of D still pass. See Tests.

### Round 4 (Code Review `fa433f2a` of round 3, MAJOR, FIX-FIRST) — the SF-3 gate's residual was reachable without any transient error

The round-3 residual above undersold its own reach. `isRepoPathCurrentlyResolvable` is a single `try {
realpathSync.native } catch { return false }` — it cannot tell "genuinely gone" apart from "exists as a
link but dangles" apart from "a transient EACCES/EBUSY/EMFILE/ELOOP just happened to fire on this call".
All three return the same `false`, and round 3 wrongly treated that `false` as license to consult
`.literal` by presence alone.

**Reproduced (the reviewer's MAJOR):** same setup as case (A) above, but at read time the SECOND target
(`TX`) is itself ABSENT — `P` is re-pointed at `TX`, then `TX` is removed, so `P` is a DANGLING junction
(`realpath(P)` throws ENOENT, but the junction entry itself still exists). `isRepoPathCurrentlyResolvable(P)`
returns `false` (indistinguishable from case A's "re-pointed to a different, EXISTING repo"), `.literal`
is consulted by presence, `literal(P)` matches Y's old attribution, and X's genuine `xTok` is wrongly
dropped — X can lift with its own genuinely-outstanding token still unaccounted for. Also: the same bare
catch means a transient EACCES/EPERM/EMFILE/ELOOP/sharing-violation on the resolvability probe itself
re-enables `.literal` for as long as that condition persists, with no dangling link involved at all.

**Lead ruling:** the fail-open is not accepted. Classify LOCALLY (never via `isRepoPathCurrentlyResolvable`,
and `repo-lock.ts`'s own helper and its other callers are untouched — this is a narrower, purpose-built
classification for this one gate):

1. `fs.realpathSync.native(recordIdentity)` succeeds ⇒ `.direct` alone is trustworthy; `.literal` is
   never consulted.
2. It fails, and `fs.lstatSync(recordIdentity)` ITSELF fails `ENOENT`/`ENOTDIR` (the link/dir entry is
   gone — SF2's own shape) ⇒ `.literal` may be consulted by presence alone, exactly as before this round.
   **⛔ SUPERSEDED BY ROUND 5** — this rule's own premise ("lstat on the LEAF alone tells you `open`") is
   FALSE one level up: a path NAMING A CHILD of a dangling link also fails lstat with ENOENT, and that is
   NOT "gone", it is case 3 one level up the ancestry. See the Round 5 section below for the real rule
   (an ancestor WALK, not a single lstat on the leaf).
3. It fails, but `lstatSync` succeeds (the entry still exists) and `readlinkSync` succeeds — a DANGLING
   link/junction (the reviewer's own repro) ⇒ `.literal` may be consulted ONLY against the clear-time
   direct form(s) stored alongside that literal attribution: `readlinkSync(recordIdentity)`'s target is
   normalized via {@link directPathIdentity} (the SAME normalization the stored form itself was computed
   with — reusing the function rather than inventing a second one) and compared for exact membership.
4. Any OTHER lstat/readlink failure (EACCES/EPERM/EBUSY/EMFILE/ENFILE/ELOOP, a sharing violation, or
   `recordIdentity` existing but not being a link at all) ⇒ `.literal` is never consulted — fail CLOSED,
   same direction as case 1.

**Implementation:** `classifyLiteralGate` (`merge-quarantine.ts`) returns one of
`{kind:"direct-only"}` / `{kind:"open"}` / `{kind:"match-target", normalizedTarget}` for exactly the four
cases above. `clearedTokens`' own `.literal` field changed shape to carry the stored target(s):
`Map<literalKey, Set<directForm>>` (was a bare `Set<literalKey>`) — `tombstoneIfNotSurviving` now stores,
per literal key, the SET of `directPathIdentity(clearingIdentity)` forms seen under that key at clear
time. `tokenTombstonedForIdentity` reads `classifyLiteralGate`'s verdict: `"direct-only"` never consults
`.literal`; `"open"` consults it by presence (case 2, unchanged behavior); `"match-target"` requires the
stored forms set to contain the normalized readlink target (case 3, the new comparison).

**Legacy-shape safety (Lead ruling point 2) — ADDED then DELETED, see Round 5 Nit 5.** Round 4 originally
let `.literal` ALSO be a bare `Set<string>` at runtime (the pre-round-4 shape), reachable only via a
test-only seeding function, reasoning that the shape change needed a documented safe-read path. Round 5
deleted all of it (the seeding function, both helper functions, and the two legacy-focused test scenarios
below) once it was named as dead weight: `clearedTokens` is in-memory only and resets every reboot (see
that structure's own doc comment), so there is no durable blob that could ever predate the current shape.

**Tests (`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`, round 4 additions):** Scenario 7
reproduces the reviewer's own dangling-junction MAJOR directly (mismatched target — must NOT match,
`xTok7` survives, X stays quarantined). Scenario 8 is its positive twin (the junction's TARGET is removed
WITHOUT re-pointing, so the dangling link's own readlink text is unchanged — the token must STILL be
recognized as tombstoned; this is what proves the comparison isn't vacuously always-false). Scenario 9
reproduces the bare-catch transient-error residual directly: `fs.realpathSync.native` and `fs.lstatSync`
are both monkey-patched to throw a fake `EACCES` for one specific path (the junction itself never changes
on disk), and the fix must fail CLOSED (X's genuine token survives) rather than read the injected error
as "gone". (Round 4 also added Scenarios 10a/10b for the legacy-shape safety above — DELETED by Round 5,
see that section's own Nit 5.)

RED/GREEN proven via `scripts/negative-control.mjs --ref 0eec9d53` (round 3's own HEAD): Scenarios 7 and 9
fail reverted (exactly the reproduced MAJOR and its transient-error sibling), pass restored, tree
byte-identical both times.

**Mutation M4, run directly (not via negative-control) — confirmed RED:** `tokenTombstonedForIdentity`'s
final `"match-target"` branch changed to unconditionally `return true` (ignoring the stored-target
comparison entirely). **RED, 3 failures at round 4** (both of Scenario 7's checks plus the since-deleted
Scenario 10b's own check — see Round 5 for this mutation's re-run against the current, legacy-free code).
Scenario 8 (a genuine match) and Scenario 9 (never reaches the `"match-target"` branch at all — it fails
closed earlier, at `"direct-only"`) correctly stayed green, isolating this mutation's blast radius to the
comparison itself. M1/M2/M3 (round 3's own mutations) were also re-run against the round-4 code and
confirmed RED with the same blast radius described above, plus the new round-4 scenarios where applicable.

### Round 5 (Code Review `7d9ad6e5` of round 4, MAJOR, FIX-FIRST) — classify on the NEAREST EXISTING ANCESTOR, not the leaf alone

Round 4's own `classifyLiteralGate` closed the dangling-junction case — but only when `recordIdentity`
NAMES the dangling link itself. It lstat'd `recordIdentity` ONE TIME, at its own leaf, and read ENOENT
there as "gone" (case 2/`"open"`). That premise is false one level up: a path naming a CHILD of a
dangling junction (`P\sub`, where `P` itself dangles) ALSO fails `lstat` with ENOENT — not because
anything was removed, but because the OS can't traverse through `P`'s own unresolvable reparse point to
even attempt the final component. Round 4 read that ENOENT identically to SF2's genuine "the junction is
gone" shape, wrongly enabling `.literal` by presence and reopening EXACTLY the MAJOR round 4 itself had
just closed, one level up the path.

**Reproduced (the reviewer's MAJOR):** `recordIdentity = P\sub`, `P` re-pointed at `TX` then `TX`
removed (the identical setup as round 4's own Scenario 7, but naming a child of `P` instead of `P`
itself). `lstat(P\sub)` throws `ENOENT`; round 4's gate reads this as `"open"`; `.literal` is consulted
by presence; `literal(P\sub)` matches Y's old attribution; X's genuine `xTok` is wrongly dropped. With
`.literal` disabled entirely the same fixture passes — proving this round's own gate, not some
pre-existing defect, introduced the regression. The Lead additionally reasoned the SAME shape is
reachable on POSIX through a dangling SYMLINK component, for the identical reason (not independently
reproduced on this host — Windows-only CI — but the mechanism is OS-agnostic: any path whose resolution
must traverse an unresolvable intermediate component fails with ENOENT at the LEAF, regardless of which
component is the actual cause).

**Lead ruling:** classify on the path's NEAREST EXISTING ANCESTOR, never the leaf alone, and make the
classifier a PURE function over an injected fs so the full table is testable without touching a real
filesystem:

1. `realpath(recordIdentity)` succeeds ⇒ `"direct-only"` (unchanged from round 4).
2. Otherwise, walk UP from `recordIdentity` one component at a time, `lstat`ing each `probe`:
   - `lstat(probe)` fails `ENOENT`/`ENOTDIR` ⇒ `probe` doesn't exist; remember its basename and continue
     at `dirname(probe)`.
   - `lstat(probe)` succeeds and `isSymbolicLink()` is `true` (confirmed on Windows: a junction created
     via `fs.symlinkSync(target, link, "junction")` reports `isSymbolicLink() === true` under `lstatSync`,
     dangling or not) ⇒ FOUND the nearest link. `readlink(probe)`; a RELATIVE target resolves against
     `dirname(probe)`, NEVER `cwd` (Minor 3: a relative POSIX symlink target is relative to its own
     containing directory) — compose the resolved target with every basename remembered on the way up,
     normalize via `directPathIdentity` (the SAME normalization the stored clear-time form used), and
     compare for exact membership in the stored forms set ⇒ `"match-target"`.
   - `lstat(probe)` succeeds and is NOT a link ⇒ `probe` EXISTS as an ordinary entry, but that alone
     proves nothing about whether some ANCESTOR OF `probe` is itself a link (this is the piece round 4's
     own single-lstat shortcut, and a naive "stop at the first existing component" walk, both miss) —
     remember its basename too (it is still part of the path between any link found further up and the
     original leaf) and keep walking up.
   - ANY other `lstat`/`readlink` errno (EACCES/EPERM/EBUSY/EMFILE/ENFILE/ELOOP, a sharing violation, or
     a `readlink` failure on a confirmed link) ⇒ `"direct-only"` — fail CLOSED, immediately, abandoning
     the walk.
   - The walk reaches the filesystem root (`dirname(probe) === probe`) having found no link anywhere on
     the chain ⇒ `"open"` — genuinely gone, SF2's own shape; `.literal` may be consulted by presence
     alone, same as before round 4.
3. Bound the walk ({@link LITERAL_GATE_WALK_MAX_STEPS} = 64 components) — a cycle or a pathological depth
   fails CLOSED (`"direct-only"`) rather than looping/recursing unboundedly.

**Implementation:** `classifyLiteralGateFromFs(recordIdentity, ops)` (`merge-quarantine.ts`) is a PURE
function over an injected `{realpathNative, lstat, readlink}` — no module-level `fs` reference inside it
at all — so the table-driven unit test (below) exercises every row via mocked ops, with no real
filesystem touched. `classifyLiteralGate(recordIdentity)` is the thin real-fs binding, looking up each
`fs.*` method ON EACH CALL (never captured once) so a test that monkey-patches `fs`'s own methods (as
Scenario 9 does) is still observed. `tokenTombstonedForIdentity` is otherwise unchanged from round 4: it
still checks `.direct` first, then gates `.literal` on the classifier's verdict exactly as before — only
the classifier's OWN internals changed.

**Nit 5 — delete the legacy-shape support entirely.** `clearedTokens` is an IN-MEMORY-ONLY structure that
resets on every reboot (see its own doc comment) — there is no durable blob that could ever predate the
current `.literal` shape, so round 4's bare-`Set` legacy-read fallback (`literalOwnersMapOf`,
`literalOwnersEntry`, the `seedLegacyClearedTokenLiteralForTest` test seam, and Scenarios 10a/10b) was
dead weight from the moment it was written, not a real compatibility need. All deleted this round.
`clearedTokens`'s `.literal` field is now simply `Map<string, Set<string>>`, no union type; both
`tombstoneIfNotSurviving` and `tokenTombstonedForIdentity` read/write it directly, with no shape-narrowing
helper in between.

**Minor 1 — ACCEPTED RESIDUAL, by Lead decision, not closed by this round.** A leaf junction re-pointed to
a DIFFERENT repo's target and then DELETED ENTIRELY (the junction entry itself, not just its target) is
indistinguishable from SF2's own "the junction is gone" shape: `lstat` on the (now wholly absent) junction
fails ENOENT, the walk finds nothing existing below it that's a link, and it reaches `"open"` exactly like
a genuinely-removed junction would — there is no artifact left anywhere on disk to tell "a different
repo's old attribution happens to share this literal path" apart from "nothing was ever here." This is a
fail-open RELATIVE TO `23dabc63` (pre-card): the pre-card code could not have avoided it either, since it
has the identical shape as SF2 itself (the mechanism `.literal` exists to recognize). **Accepted** because
closing it would require either keeping a durable record of every removed junction's own old target (a
structural redesign, not a classification fix) or refusing EVERY `"open"` case outright (which would
re-break SF2 itself, the mechanism's whole reason for existing) — and it requires a DELIBERATE
re-point-then-delete sequence to construct, not an ordinary filesystem event.

**Minor 3 — ⛔ SUPERSEDED BY ROUND 6, below — do not carry this paragraph's own mechanism forward.** It
originally named a fail-CLOSED over-block from 8.3 short names / `subst` / nested-link targets in the
round-5 target-COMPARISON. Round 6 deleted target composition/comparison entirely, so THIS specific
mechanism no longer exists — there is nothing left to compare, hence nothing for an 8.3/subst/nested-link
text mismatch to spuriously trip. Round 6 has its OWN, differently-shaped accepted residual (see that
section) — read it there, not here.

**Tests (`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`, round 5):** Scenario 11 reproduces the
reviewer's own subdir-of-a-dangling-junction MAJOR directly (`recordIdentity = P\sub`, same mismatched-
target shape as Scenario 7, one level deeper) — `xTok11` survives, X stays quarantined. A table-driven
unit test exercises `classifyLiteralGateFromFs` directly via mocked `{realpathNative, lstat, readlink}`,
covering: a leaf that resolves; a leaf missing under a plain dir (SF2's shape); a leaf missing under a
dangling junction (the round-5 shape); a leaf that IS itself a live-ish link under a transient realpath
failure; a NESTED link (walking past an existing non-link ancestor to find one further up); a RELATIVE
link target (resolved against `dirname(link)`, never `cwd`); a `readlink` EINVAL failure (Minor 2, below);
EACCES on the leaf's own lstat, on an ancestor's lstat, and on readlink; and the walk bound exceeded.
Scenarios 4-9 (rounds 2-4) stay green, unchanged.

RED/GREEN proven via `scripts/negative-control.mjs --ref 877426b5` (round 4's own HEAD): Scenario 11's two
checks fail reverted, and the table-driven unit test crashes with `classifyLiteralGateFromFs is not a
function` (round 4 never exported it) — both are RED by the negative-control script's own criteria (a
non-zero exit), not a silent skip. Pass restored, tree byte-identical both times.

**Minor 2's own proof — mutation M5, run directly:** the `readlink`-failure branch inside the walk's
link-found case changed from `"direct-only"` to unconditionally `"open"`. **RED, 2 failures**: exactly the
`readlink EINVAL` and `EACCES on readlink` table rows — no other row reaches that branch, isolating the
mutation's blast radius to the readlink-failure handling specifically.

**Mutations M1-M4 (rounds 3/4), re-run directly against the current, legacy-free round-5 code — all
confirmed RED with the blast radius widened to include Scenario 11 where applicable, otherwise unchanged:**
M1 (identity-ignoring) and M2 (literal-only matching) additionally catch Scenario 11 (M1: 9 failures; M2:
10 failures, including the pre-existing M2-discriminator Scenario 5). M3 (S1 reverted at
`clearMergeQuarantineByKey`) is UNCHANGED at 4 failures — none of this round's scenarios route through that
call site. M4 (`"match-target"` always-`true`) now catches Scenario 11 alongside Scenario 7 (4 failures
total: both checks each), with Scenario 8 (a genuine match) and Scenario 9 (never reaches `"match-target"`)
still correctly green. Each mutation applied as a throwaway edit to the real source, rebuilt, run,
confirmed RED with the exact failure set named above, then reverted and rebuilt (file ALL PASS again).

**⛔ EVERYTHING ABOVE THIS LINE IN THE ROUND-5 SECTION DESCRIBES ROUND-5-ERA CODE AND TESTS, SUPERSEDED BY
ROUND 6.** `"match-target"`, `readlink`, the relative-link/nested-link-with-composition table rows,
Scenario 10a/10b's legacy-blob tests, and mutation M5 (the readlink-failure proof) no longer exist in the
current source or test file — round 6 deleted all of them. Scenario 7/8/11's own MECHANISMS also changed
(Scenario 8's own EXPECTATION flipped). Read the Round 6 section below for the current shape; this
section is kept for its OWN history (the repro, the four-way rule, and why it was the right fix for what
it fixed) — not as a description of what currently ships.

### Round 6 (Code Review `95cf6f1a` of round 5, MAJOR x2, FIX-FIRST) — STOP PATCHING `match-target`; SHRINK THE SURFACE

Round 5's own nearest-link composition was the FIFTH straight Code Review round to find a fail-open in
some form of "does this path's CURRENT target still equal what was stored at clear time" (round 3's
`isRepoPathCurrentlyResolvable` bare catch; round 4's leaf-only lstat; round 5's own composition, now
reopened twice more). The Lead's ruling: this is a pattern, not a sequence of unrelated bugs (the project's
own standing lesson 275) — stop trying to fix the HEURISTIC and shrink what it is allowed to prove instead.

**MAJOR 1 — composition expands only the NEAREST link, missing a CHAINED redirection.** Setup: `P` is a
junction to `T1`, and `T1` is a PLAIN directory (not a link) at clear time, so the stored direct form is
`realpath(T1/sub)`. Later, `T1` is REPLACED: removed entirely, then recreated AS ITSELF a junction
pointing to `T2` (which holds a DIFFERENT repo, X's); `T2` is then removed too. `P` itself was NEVER
touched — it still names `T1` literally. Round 5's walk finds `P` (unchanged), reads its target text
(`"T1"`, unchanged literal text) and composes `T1\sub` — which, normalized, happens to equal the
ORIGINAL stored form (itself `T1\sub`, from before `T1` became a link) even though the REAL repo moved
TWICE and is now gone. `xTok` is wrongly dropped, X lifts. **877426b5 (round 4) had this fail-open too**
— round 5's own fix never closed it, it just changed which single hop gets composed.

**MAJOR 2 — an EXISTING plain leaf whose `realpath` throws (EACCES, realpath-only injection) walks to the
root and returns `"open"`.** Round 4's own rule ("exists, not a link ⇒ never consult `.literal`") was
itself REGRESSED by round 5: round 5's walk, after `realpath` fails, `lstat`s the leaf — if it exists and
is NOT a link, round 5 treats that as "say nothing, keep walking" and continues ALL THE WAY to the
filesystem root looking for a link; finding none (a genuinely plain, symlink-free ancestry), it returns
`"open"`, enabling `.literal` by presence and dropping the token. The round-5 decision record never named
this change from round 4's own rule at all.

**MINOR — subst / mapped drive / volume mount point / UNC-DFS / a POSIX mount can make `"open"` a
fail-OPEN, not the fail-closed the round-5 record claimed.** A redirection mechanism the walk's own
`lstat`/`isSymbolicLink()` CANNOT SEE (an `lstat` on a mount point, a `subst`-mapped drive letter, or a
DFS share reports as an ORDINARY directory, never as a link) lets the walk reach the filesystem root and
return `"open"` even though the path's real REFERENT silently changed underneath it — round 5's own
Minor-3 paragraph miscategorized this exact class as a fail-CLOSED over-block; it is the opposite
direction.

**Lead ruling: STOP PATCHING, SHRINK THE SURFACE.** Delete `"match-target"` (and all target composition)
entirely. The classifier proves only ONE thing from here on — "this could definitely not be the same
place" — and otherwise fails closed. As a pure function, in order:

1. `realpath(leaf)` succeeds ⇒ `"direct-only"` — `.direct` alone is trustworthy.
2. It fails. `lstat(leaf)` ITSELF succeeds — ANYTHING exists at that exact path (a directory, a file, a
   live link, or a DANGLING link/junction; `lstat` never follows the final component) ⇒ `"direct-only"`.
   This closes MAJOR 2: a plain, non-link leaf whose `realpath` throws for an unrelated reason must never
   fall through to a walk at all, and a dangling leaf is now fail-CLOSED too (never compared against
   anything).
3. `lstat(leaf)` fails `ENOENT`/`ENOTDIR` ⇒ walk UP from the leaf, one component at a time, checking ONLY
   `isSymbolicLink()`. ANY existing link found ANYWHERE on the chain ⇒ `"direct-only"` — never compose or
   compare its target, no matter how many hops away or how "obviously unchanged" its own readlink text
   looks. This closes MAJOR 1: a chain containing a link, at ANY depth, is simply never eligible for
   `.literal`'s presence-based match any more. An existing ancestor that is NOT a link says nothing about
   ancestors further up — keep walking past it.
4. Any OTHER `lstat` errno anywhere in the walk (EACCES/EPERM/EBUSY/EMFILE/ENFILE/ELOOP, a sharing
   violation), or the walk exceeding {@link LITERAL_GATE_WALK_MAX_STEPS}, ⇒ `"direct-only"` — fail CLOSED
   immediately.
5. The walk reaches the filesystem root having found NO link anywhere on the existing prefix ⇒ `"open"`
   — genuinely gone, SF2's own shape; `.literal` may be consulted by presence alone, unchanged since
   round 4.

**Implementation:** `classifyLiteralGateFromFs(recordIdentity, ops)` returns a bare STRING,
`"direct-only"` or `"open"` — no object, no `normalizedTarget`, no third outcome. `LiteralGateFsOps` drops
`readlink` entirely (never called anywhere any more). `classifyLiteralGate` is the same thin real-fs
binding as round 5, now wrapping only `realpathSync.native`/`lstatSync`. `clearedTokens`'s `.literal`
field reverts to a plain `Set<string>` (was `Map<literalKey, Set<directForm>>`) — grepped the whole file:
nothing else ever read the stored-forms shape, so there was nothing else to migrate.
`tombstoneIfNotSurviving` writes `.literal` by simple `Set.add`; `tokenTombstonedForIdentity` consults it
by simple `Set.has` whenever the gate returns `"open"`, exactly as it did before round 4 ever existed.

**Consequence — Scenario 8 (and the reviewer's own "control C") now expects NOT tombstoned.** A token
tombstoned while junction `P -> TY` resolves, with `TY` later removed WITHOUT re-pointing `P` (a genuine
drift with the dangling link's own target text unchanged), used to be recognized as tombstoned by rounds
4-5's own target composition. Rule 2 now fires unconditionally the instant `lstat(P)` succeeds — dangling
or not — with no further comparison, so the token now SURVIVES: an ACCEPTED fail-CLOSED OVER-BLOCK (the
repo stays quarantined a little longer than strictly necessary), never a dropped token. Scenario 7 and
Scenario 11 keep their SAME outcome (`xTok` survives, X stays quarantined) under a DIFFERENT mechanism:
Scenario 7's own leaf (the junction `P` itself) is now resolved by rule 2 directly (lstat succeeds at the
leaf); Scenario 11's leaf (`P\sub`, missing) is resolved by rule 3 (the walk finds `P` one level up IS a
link, at all, full stop — no target comparison). Scenario 6 (the 7 drift routes, which remove the
junction ENTIRELY, never leaving a link anywhere) is untouched: rule 5 still fires for it exactly as rule
5 (formerly the sole non-direct-only outcome) always has, since round 4 — SF2 survives.

**The ONE accepted fail-open class this round leaves, stated honestly against `23dabc63` (pre-card) —
⛔ NARROWED BY ROUND 7, below; this paragraph's own framing is now too WIDE.** a redirection Loom CANNOT
OBSERVE from the path alone at read time — a deleted junction whose own entry is gone, a `subst`-mapped
drive, a volume mount point, a UNC/DFS redirect, or a POSIX mount — is changed to point at a DIFFERENT
repo's target, and that different target THEN disappears too. The walk's own `lstat`/`isSymbolicLink()`
has no way to see any of these as "a redirection happened here" (a mount point reports as an ordinary
directory; a `subst` drive letter reports as an ordinary drive), so the walk reaches the root and returns
`"open"`, and `.literal`'s presence-based match recognizes the OLD attribution as if nothing had changed.
**Accepted** because the SF2 drift routes — the mechanism's own reason for existing — DEPEND on literal
matching once a link is genuinely gone; refusing every `"open"` case to close this residual would
re-break SF2 itself. This subsumes and generalizes round 5's own Minor 1 (a re-pointed-then-deleted
junction is one specific, constructible instance of this same class) and corrects round 5's own Minor 3
(which miscategorized the SAME underlying class as fail-CLOSED). **Round 7 found this framing was too
coarse: a junction spelled via `\\?\Volume{GUID}\…` is ALSO invisible to `lstat`/`isSymbolicLink()` even
while the ENTRY itself (not just its target) is present — a case this paragraph's own wording
("a redirection... is changed to point at a DIFFERENT repo's target, and that different target THEN
disappears") did not cover, since here the JUNCTION ENTRY ITSELF is what `lstat` cannot see. See the
Round 7 section for the real, narrower residual this leaves once that gap is closed.**

**Tests (`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`, round 6):** Scenario 7's and Scenario
11's own comments updated to name the NEW mechanism (rules 2 and 3 respectively); their assertions are
UNCHANGED (same outcome). Scenario 8's assertions FLIPPED (documented above) and its header rewritten to
name it as the reviewer's own "control C". Scenario 9's comment updated to name rule 4; assertions
unchanged. Scenario 12 (NEW) reproduces MAJOR 1 directly via real junctions (`P -> T1` plain, `T1`
replaced with a junction to `T2`, `T2` removed) — `xTok12` survives, X stays quarantined. Scenario 13
(NEW) reproduces MAJOR 2 end-to-end against REAL on-disk state: a real, on-disk plain directory with
`fs.realpathSync.native` monkey-patched to throw EACCES for that exact path and `fs.lstatSync` left real,
calling `classifyLiteralGateFromFs` directly (exercising the real-fs wiring the fully-mocked unit test
does not) and asserting it returns the bare string `"direct-only"`. The table-driven unit test is rebuilt
for the 5-rule, no-`readlink` shape: rule 1 (resolves); rule 2 (a dangling leaf — lstat ok, realpath
fails); rule 2 (a plain, non-link leaf whose realpath throws — MAJOR 2's own unit-level shape); rule 3 (a
link on the immediate ancestor); rule 3 (a link found further up, past an existing non-link ancestor —
MAJOR 1's own unit-level shape); rule 4 (EACCES on the leaf's own lstat, on an ancestor's lstat, and the
walk bound exceeded); rule 5 (a missing leaf under plain dirs only, including several ENOENT hops). Nit 5
(from round 5) carries forward and is now moot by construction: there is no stored-forms shape left to
have a legacy variant of, so round 5's own legacy-blob tests (Scenario 10a/10b) stay deleted.

RED/GREEN proven via `scripts/negative-control.mjs --ref 2a8b411c` (round 5's own HEAD): Scenario 8's
flipped check, both of Scenario 12's checks, Scenario 13's check, and every one of the new/changed
table-driven rows fail reverted — the table rows fail on a TYPE mismatch alone (round 5's function
returns `{kind:"open"}` objects, never the bare string `"direct-only"`, for ANY input), which is itself a
valid RED signal for this round's own refactor. Scenario 7/9/11 correctly stayed GREEN reverted (their
OUTCOME is unchanged across rounds 4-6, only the mechanism differs), confirming the blast radius is
exactly the two MAJORs plus the accepted-over-block flip, nothing broader. Pass restored, tree
byte-identical both times.

**Mutations — M1/M2/M3 re-run directly against the round-6 code, plus two NEW mutations for rules 2 and
3, all confirmed RED, each a throwaway edit, rebuilt, run, confirmed, then reverted and rebuilt (file ALL
PASS again):**
- M1 (identity-ignoring): 12 failures (Scenario 3's B1 check, Scenario 4's case-A checks, Scenario 7,
  Scenario 8's flipped check, Scenario 9, Scenario 11, Scenario 12 — every scenario that depends on the
  `.literal` gate discriminating at all).
- M2 (literal-only matching, drops `.direct` and the gate entirely): 13 failures — the same set as M1 plus
  Scenario 5 (the pre-existing M2 discriminator, a case only `.direct` can recognize).
- M3 (S1 reverted at `clearMergeQuarantineByKey`): UNCHANGED, 4 failures — the same 4 of 7 drift routes as
  every prior round; none of this round's scenarios route through that call site.
- **M6 (rule 2 removed — fold the leaf into the walk instead of short-circuiting on it):** 2 failures,
  exactly Scenario 13 (the end-to-end MAJOR-2 repro) and its matching unit-table row — no other scenario
  or row depends on rule 2, isolating it precisely.
- **M7 (rule 3 removed — a link found during the walk no longer short-circuits; keep walking past it):**
  6 failures, exactly Scenario 11, Scenario 12 (both checks each) and their two matching unit-table rows
  — no other scenario or row depends on rule 3, isolating it precisely.

### Round 7 (Code Review `6ef22315` of round 6, MAJOR, FIX-FIRST on ONE finding) — a `\\?\Volume{GUID}\…`-targeted junction is invisible to libuv's own link detection

Round 6's own re-CR (`95cf6f1a`) verified rules 1/4/5, M6/M7, and all 7 drift routes sound. ONE finding
remained: a junction whose target is spelled as a `\\?\Volume{GUID}\…` path (`mklink /J` accepts this
without admin rights) is INVISIBLE to `lstat`/`isSymbolicLink()` in a way neither rule 2 nor rule 3 can
see — reproduced end-to-end on this host, with real junctions, no admin rights required.

**Reproduced:** `mountvol C: /L` gives this host's own `\\?\Volume{GUID}\` prefix; `mklink /J P
\\?\Volume{GUID}\...\ty` creates a junction indistinguishable, while LIVE, from an ordinary one by every
visible signal EXCEPT `isSymbolicLink()`, which reports `false` — confirmed directly: `fs.lstatSync(P)`
returns `{isSymbolicLink: () => false, isDirectory: () => true}`, and `fs.realpathSync.native(P)`
resolves it correctly to `ty`. Once DANGLING (the target removed), it gets WORSE: `fs.lstatSync(P)`
ITSELF throws `ENOENT` — not merely reporting "not a link", but failing to see the entry EXISTS AT ALL,
even though the junction's own reparse-point entry is still physically present on disk (confirmed: its
own basename still appears in its parent directory's `readdirSync` listing).

- **Dangling variant:** `recordIdentity = P\sub` (or `P` itself), `P`'s target removed. `lstat(P\sub)`
  fails `ENOENT` (rule 2 never fires); the walk reaches `P` itself, and `lstat(P)` ALSO fails `ENOENT`
  (rule 3 never fires either — there's no successful `lstat` anywhere to report `isSymbolicLink()` on).
  The walk reaches the root having found nothing ⇒ `"open"` ⇒ `.literal` matched by presence ⇒ X's
  genuine `xTok` dropped, X lifts.
- **Live variant:** `P` re-pointed (still via a `\\?\Volume{GUID}\…` target) at a DIFFERENT, EXISTING
  target `TX` with no `sub` child. `lstat(P)` SUCCEEDS but reports `isSymbolicLink()` FALSE (rule 3 never
  fires); the walk treats `P` as an ordinary, non-link existing ancestor and keeps walking past it,
  reaching `"open"` the same way.

Both variants reproduced on this host with real `mklink /J` junctions (scratch fixtures
`repro-voljunction.mjs`, `probe3.mjs`, `probe4.mjs`), and both independently confirmed via DIRECTLY
instrumented calls to `classifyLiteralGateFromFs` (not just through the full reconcile pipeline) — the
genuine mechanism in each case verified by injecting logging into every `ops.*` call and confirming
EXACTLY which check fires, not merely that the final answer happens to be correct (an earlier pass at this
verification used the REVIEWER's own scratch `ops` objects, which predate round 7 and omit `readdir`
entirely — every one of their `gate(...)` results that LOOKED like a fix was actually a `TypeError` on
`ops.readdir is not a function`, caught and misclassified as a generic "error" ⇒ `"direct-only"` by
accident, not by genuine detection; re-verified with a correctly-equipped `ops` before trusting any of it).

**Ruling: close it with two PRESENCE checks — never a target composition, so neither can reopen a
fail-open the way `"match-target"` did (five straight rounds; see the Round 6 "Do not"):**

(i) **While walking**, whenever an `lstat` in this function (the leaf's own rule-2 check, or an ancestor
during the walk) fails `ENOENT`/`ENOTDIR`, that alone no longer proves absence: check the component's
PARENT directory's own `readdirSync` listing (case-insensitive on win32) for the component's basename. If
it's there, the component is PRESENT despite `lstat`'s own blindness ⇒ `"direct-only"`. Any `readdir`
errno other than `ENOENT`/`ENOTDIR` ⇒ `"direct-only"` too (fail CLOSED, same posture as every other
unexpected errno here). Applied at BOTH the leaf's own rule-2 branch and every ancestor-walk ENOENT, not
only "while walking" in the narrower sense the ruling's own wording might suggest — the SAME hazard (an
`lstat` `ENOENT` that doesn't mean absence) applies equally at the leaf, and `recordIdentity` naming the
dangling junction entry itself (not a child of it) would otherwise slip through uncaught.

(ii) **At the nearest EXISTING ancestor** found by the walk (the first one whose `lstat` succeeds) —
before trusting "exists, not a link, say nothing about it" — compare `realpathNative(ancestor)` against
the ancestor's own LEXICAL spelling, normalized the same way `directPathIdentity` normalizes (lowercased
on win32). A LIVE invisible junction's `realpath` still resolves to somewhere textually DIFFERENT from
its own name, which this catches even though `isSymbolicLink()` lied. A `realpath` FAILURE at this
confirmed-existing node ⇒ `"direct-only"` too. Checked ONLY at the nearest existing ancestor, never
re-applied further up the chain (see the residual below for the cost of that scope).

Both checks ONLY ever ADD `"direct-only"` outcomes — neither composes or compares a TARGET, so neither
can reopen a fail-open the way `"match-target"` did; they cannot create a NEW fail-open, only narrow the
`"open"` outcome's own reach.

**Implementation:** `LiteralGateFsOps` gains `readdir(p): string[]`. `presentInParentListing(probe, ops)`
returns `"present"` / `"absent"` / `"error"` per check (i)'s own rule. `normalizeLexical(p)` is
`directPathIdentity`'s own lowercase-on-win32 rule, extracted so check (ii) can reuse it without
re-deriving it. `classifyLiteralGate`'s real-fs binding adds `readdir: (p) => fs.readdirSync(p)`.

**Accepted residual, restated precisely now that the volume-GUID gap is closed — NARROWER than round 6's
own framing (see that section's own note):** what's left is (a) a redirection that is GONE ENTIRELY — a
deleted junction ENTRY (not merely its target), a removed `subst`/mapped drive, or an unmounted volume —
where there is no entry left anywhere, visible or invisible, for check (i)'s own `readdirSync` to find;
or (b) a UNC/DFS/POSIX-mount redirection that is CHANGED to a different target and that target THEN also
disappears, where the redirect mechanism itself (a mapped drive letter, a mount point) has no "parent
directory entry" of the kind check (i) can inspect at all — a drive root's own `readdirSync` just throws
`ENOENT` once its target is gone, same as `lstat` does, with nothing above it to list it as present. Both
shapes reach the filesystem root having found nothing and correctly, if unluckily, return `"open"`.
**Accepted** for the same reason round 6 accepted its own, wider version: the SF2 drift routes depend on
exactly this presence match once a link is genuinely gone, and narrowing it further would re-break SF2
itself.

**Accepted over-block — 8.3 short names (the reviewer's own aliasing nit):** check (ii)'s own comparison
(`realpath(ancestor)` vs. its own lexical spelling) OVER-BLOCKS (fail-CLOSED, never a dropped token) for
an ancestor spelled via a Windows 8.3 short name (e.g. `LONGFO~1`) — `realpath` resolves it to the LONG
form, which never textually matches the short lexical spelling, even though they denote the identical
directory. This is the SAME "keep more, never less" direction every reader in this module already
defaults to — safe, documented, not fixed; narrowing it would need resolving BOTH sides through a THIRD,
case/8.3-insensitive comparison this module has no existing primitive for.

**Tests (`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`, round 7):** Scenario 14 reproduces the
dangling volume-GUID junction directly via a real `mklink /J` junction (`tryVolumeGuidJunction`, a shared
helper using `mountvol <drive>: /L` — SKIPS, never fails vacuously, if `mountvol`/`mklink` are
unavailable in the environment). Scenario 15 reproduces the live, re-pointed variant the same way. Both
confirmed NOT skipped and GREEN on this host. The table-driven unit test gains 7 rows: check (i) positive
(an invisible-but-present component), its case-insensitivity on win32, its negative (genuinely absent),
and its failure branch (`readdir` throws non-`ENOENT`); check (ii) positive (a redirect `lstat` can't
see), its failure branch (`realpath` throws at the nearest ancestor), and its negative (an ordinary
ancestor never false-positives). `mockOps` gained `realpathFails`/`realpathRedirects`/`readdirListing`/
`readdirErrors`, and its OWN default `realpathNative` behavior changed from "always throws" to "resolves
to itself unless explicitly marked" — needed so an ordinary, unmarked existing ancestor passes check (ii)
cleanly without every pre-existing test needing to configure it; the two pre-existing rows that relied on
the OLD "always throws" default for their OWN leaf (`rule 2: a plain leaf whose realpath throws`, `rule
4: EACCES on the leaf's own lstat`) were updated to mark their own leaf via the new `realpathFails` set
explicitly, preserving their original intent under the new default.

RED/GREEN proven via `scripts/negative-control.mjs --ref caf914db` (round 6's own HEAD): Scenario 14/15
(both checks each) and all 5 new/changed table rows fail reverted (round 6's `ops` has no `readdir` at
all, so every check-(i)/check-(ii)-dependent row reaches `"open"`, round 6's own unchanged behavior).
Scenario 6/7/8/9/11/12/13 and every pre-existing table row correctly stayed GREEN reverted, confirming the
blast radius is exactly the two new scenarios and the five new rows, nothing broader. Pass restored, tree
byte-identical both times.

**Mutations — M1/M2/M3 re-run directly against the round-7 code (unchanged blast radius, now also
catching Scenarios 14/15 where applicable), plus two NEW mutations for checks (i) and (ii), all a
throwaway edit, rebuilt, run, confirmed RED, then reverted and rebuilt (file ALL PASS again):**
- M1 (identity-ignoring): 16 failures (the round-6 set, plus both checks each for Scenarios 14 and 15).
- M2 (literal-only matching): 17 failures (M1's set plus Scenario 5's pre-existing M2 discriminator).
- M3 (S1 reverted at `clearMergeQuarantineByKey`): UNCHANGED, 4 failures — the same 4 of 7 drift routes as
  every prior round; neither new scenario routes through that call site.
- **M8 (check (i) removed — `presentInParentListing` always returns `"absent"`):** 5 failures, exactly
  Scenario 14 (the dangling volume-GUID repro) and its 3 matching unit-table rows. Scenario 15 (check ii's
  own scenario) correctly stayed green, isolating check (i)'s own blast radius precisely.
- **M9 (check (ii) removed — the nearest-existing-ancestor comparison deleted, `foundNearestExistingAncestor`
  set unconditionally with no realpath call):** 4 failures, exactly Scenario 15 (the live volume-GUID
  repro) and its 2 matching unit-table rows. Scenario 14 (check i's own scenario) correctly stayed green,
  isolating check (ii)'s own blast radius precisely.

### Round 8 (Code Review `15f5e8a1` of round 7, MAJOR, FIX-FIRST on ONE finding) — check (ii)'s comparison must normalize BOTH sides, not just lowercase them

Round 7's re-CR confirmed checks (i)/(ii) close both volume-GUID variants by their real mechanism, no
swallowed path to `"open"`, M8/M9 RED, and all 7 drift routes green. ONE fail-CLOSED regression remained
(not a fail-open): check (ii)'s own comparison (`normalizeLexical`, lowercase-on-win32 only) doesn't
normalize away two artifacts `realpath` ALONE introduces, so it mismatches for paths that were NEVER
redirected at all.

**Reproduced end-to-end:** `fs.realpathSync.native` strips a local-drive extended-length prefix
(`\\?\<drive>:\…` / `//?/<drive>:/…`) entirely — confirmed directly: `realpathSync.native("\\?\C:\Users\…")`
returns the bare `"C:\Users\…"` form, no prefix at all. `path.dirname`/`path.resolve` (what builds the
walk's own `probe`) never strip it — confirmed: `path.dirname("\\?\C:\Users\danie\sub")` returns
`"\\?\C:\Users\danie"`, prefix intact. So for ANY `\\?\<drive>:\…`-spelled `recordIdentity` — a form
`isUnsafeToCanonicalize` (`projects/vault-path.ts`) DELIBERATELY allows through as safe — every ancestor
check (ii) reaches mismatches `real` (prefix-stripped) against `probe` (prefix-intact), forever, with no
redirect anywhere: an SF2 drift on a `\\?\`-spelled path stayed QUARANTINED permanently, where round 6's
own behavior (confirmed via M9: disable check (ii) entirely) correctly lifted it.

The SAME class of artifact recurs at a UNC share root: confirmed directly —
`fs.realpathSync.native("\\localhost\c$\")` returns `"\\localhost\c$"` (trailing separator DROPPED), while
`path.resolve("\\localhost\c$")`/`path.dirname(...)` both return `"\\localhost\c$\"` (trailing separator
ALWAYS ADDED, the same convention a drive root gets) — the walk's own `probe` at a UNC share-root ancestor
mismatches `real` the same way, purely from a trailing-separator artifact.

**Ruling: one shared normalizer, applied to BOTH sides of check (ii) before comparing — never a target
composition, so the round-6 Do-not still holds.** It must:
1. Strip ONLY the local-drive extended-length prefix (`\\?\<letter>:` / `//?/<letter>:`) — NEVER
   `\\?\UNC\…` or `\\?\Volume{…}…`, which are EXACTLY the redirections checks (i)/(ii) exist to detect;
   stripping those would silently swallow round 7's own fix.
2. Strip a trailing separator, UNLESS what remains is a bare drive root (`C:\`) — a drive root keeps its
   own trailing separator through `realpath`; a UNC share root does not, so it gets the SAME stripping
   every ordinary ancestor already implicitly gets (an ordinary directory's `realpath` never has a
   trailing separator to begin with).
3. Keep the win32 lowercasing — reusing {@link directPathIdentity}'s own rule, never re-deriving a second
   one (satisfied here: `directPathIdentity` only ever lowercases; this round's normalizer does the SAME
   lowercase step, LAST, after the two structural strips above, which `directPathIdentity` itself has no
   equivalent of — `directPathIdentity` is never called directly here, since calling it on either side
   would re-invoke `realpath` a second, redundant time and, worse, would make the comparison VACUOUS: both
   sides would converge to the identical `realpath(probe)` value regardless of whether `probe` names a
   genuine redirect, since `directPathIdentity(real)`'s own realpath call on an already-resolved path is
   idempotent and `directPathIdentity(probe)`'s own realpath call resolves to the exact same `real` — this
   was checked and rejected before writing the implementation, not discovered by a failing test).

**Implementation:** `normalizeLexical` renamed `normalizeForAncestorComparison`, extended with the two
structural strips above (regex-based: a drive-local prefix strip, then a conditional trailing-separator
strip), lowercased last. Both `real` and `probe` are passed through it before the `!==` comparison in
check (ii). This stays comparison-only — it composes/compares nothing but a NORMALIZED spelling of the
SAME two values check (ii) already had.

**Tests (`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`, round 8):** Scenario 16 (NEW, placed
next to Scenario 6's own 7 drift routes) reproduces the regression end-to-end: a `\\?\`-spelled PLAIN
directory, NO junction anywhere, genuinely removed — must LIFT once every outstanding token is cleared,
exactly like Scenario 6's own routes. Two new table rows: a case-DIFFERING `realpath` spelling of the same
ancestor must still reach `"open"` (pins the lowercase step — this is the row that makes mutation M10,
below, actually discriminating); a genuine `\\?\Volume{…}…`-spelled ancestor must STILL reach
`"direct-only"` after the normalizer (the prefix-strip must never swallow round 7's own fix).

RED/GREEN proven via `scripts/negative-control.mjs --ref eccd24c9` (round 7's own HEAD): ONLY Scenario
16's own check fails reverted — the two new table rows do NOT discriminate round 7 from round 8 by
themselves (round 7's lowercase-only normalizer already passes the case-differing row correctly, and
never attempted any prefix-stripping at all so the Volume{GUID} row was already correct too; both rows
exist to PIN the current behavior against a FUTURE regression, not to prove THIS round's own fix — only
Scenario 16, which actually exercises the `\\?\<drive>:`-prefix-strip, does that). Every pre-existing
scenario and table row (including Scenarios 14/15 and their own check-(i)/(ii) rows) stayed GREEN
reverted, confirming the blast radius is exactly this one regression, nothing broader. Pass restored, tree
byte-identical both times.

**Mutations — M1/M2/M3/M8/M9 re-run directly against the round-8 code (UNCHANGED blast radius from round
7), plus the reviewer's own named M10, now discriminating where it did not before:**
- M1 (identity-ignoring): 16 failures, same set as round 7 — Scenario 16 has no cross-identity bleed, so
  M1's over-broad matching doesn't change its outcome either way.
- M2 (literal-only matching): 17 failures, same set as round 7, for the same reason.
- M3 (S1 reverted at `clearMergeQuarantineByKey`): UNCHANGED, 4 failures — Scenario 16 doesn't route
  through that call site either.
- M8 (check (i) removed): UNCHANGED, 5 failures — exactly Scenario 14 and its 3 matching rows; Scenario
  16 isn't affected (it never reaches check (i) at all — every ancestor lstat succeeds normally, just
  under a `\\?\`-prefixed spelling).
- M9 (check (ii) removed entirely): now ALSO catches the round-8 `\\?\Volume{…}…` table row (5 failures
  total: Scenario 15's two checks, its own two matching rows, plus this round's Volume{…} row) — correctly
  so, since that row depends on check (ii) running at all, same as Scenario 15.
- **M10 (the reviewer's own named mutation — `normalizeForAncestorComparison` returns its input
  UNCHANGED, "compare raw"):** 2 failures — exactly Scenario 16 (the `\\?\`-prefix artifact this round
  fixes) and the NEW case-differing table row (the lowercase artifact this mutation ALSO removes, since
  it deletes the whole normalizer, not just the prefix-strip). Confirmed this went FULLY GREEN against
  round 7's own code (the reviewer's own finding) — the new case-differing row is what makes it
  discriminating now. The Volume{…} row and every other pre-existing row/scenario stayed green under
  M10, correctly isolating its blast radius to the two normalization artifacts alone.

### Collision analysis — CORRECTED round 3 (the round-1/round-2 "token uniqueness" argument was FALSE for a bled token)

**Both earlier versions of this section argued: "B never raises A's exact token string, so B's own
genuinely-outstanding tokens can never collide with A's entry." That argument is FALSE, and the round-3
Code Review's own reproduction of case (A) is exactly the counter-example.** Token uniqueness means no
TWO RAISES ever mint the same string — it says nothing about a token's value being copied, by the
pre-existing `398f476c`/`f575cebf` BLEED class, into a SECOND identity's own record that never raised it.
In every one of cases (A)/(B)/(C) below, Y's own record is CONSTRUCTED bled with X's genuine `xTok` (the
same shape SF1 itself exploits) — so when Y clears itself, Y's OWN clear calls `tombstoneIfNotSurviving`
with `xTok` IN ITS token list, attributing `xTok` under Y's own identity forms even though Y never raised
it. This is not a hypothetical: it is the literal mechanism by which `clearedTokens` ends up holding an
entry for `xTok` attributed to an identity that is NOT its genuine owner. The question this record should
have asked from round 1 onward is never "can two values collide" (they can't) — it is **"can a READER's
own identity form, computed fresh, wrongly equal an ATTRIBUTION form some OTHER identity's clear left
behind for THIS SAME token value."** That is a question about path-identity STABILITY across time, not
about token value uniqueness, and the answer differs per case:

- **(A) — literal-namespace, junction re-pointed to a different repo — CLOSED by round 3 (SF-3).** Same
  path TEXT `P` is a junction to `TY` at clear time (Y, bled with `xTok`, cleared while `P` resolves,
  attributing `xTok` under `direct(P)=realpath(P)=TY` AND `literal(P)="P"`); `P` is later re-pointed to a
  DIFFERENT repo `TX`. At read time `P` STILL resolves (now to `TX`), so `direct(P)=TX` — no match against
  `{TY}` — but the OLD, unqualified code also consulted `.literal`, where `literal(P)="P"` DOES match the
  old attribution, wrongly dropping X's genuine `xTok`. Fixed (round 3) by gating `.literal` on
  `!isRepoPathCurrentlyResolvable(recordIdentity)` — superseded by round 4's `classifyLiteralGate`, then
  round 5's `classifyLiteralGateFromFs` ancestor walk (see those sections below); the OUTCOME for case (A)
  is unchanged across all three: `P` DOES resolve at read time, so every version's gate reaches
  `"direct-only"`/skips `.literal` entirely, and `direct()` alone (now genuinely `TX`, not `TY`) never
  matches. Reproduced RED at HEAD before this fix (the
  reviewer's own `zz-cr-0d3b64c6-r2-scratch.mjs`, case A); GREEN after; re-verified against the SAME
  fixture, all 7 drift-lift routes (D) still pass.
- **(B) — direct-namespace, junction TARGET deleted and recreated — PRE-EXISTING, INHERENT, NOT fixed by
  any round of this card.** Y at junction `J -> TY` is cleared while `J` resolves (`direct(J)=TY`); `J` is
  removed, then `TY` ITSELF is deleted and recreated (a brand-new directory, reusing the same literal
  path), and X is bound via a NEW junction `Q -> TY` (the recreated one). `direct(Q)=realpath(Q)=TY` —
  textually IDENTICAL to Y's own old attribution, and this time `.direct` is ALWAYS consulted
  unconditionally (never gated), so SF-3's fix does nothing here. **This is a structural limitation of
  using `realpath` (a filesystem PATH) as a stand-in for "the same logical repository" — a deleted-and-
  recreated directory gets a new inode but the identical path string, and nothing in `directPathIdentity`
  (or any OS-level realpath call) can tell the two apart.** Confirmed pre-existing: fails IDENTICALLY
  against `23dabc63` (pre-card), before `clearedTokens` had any namespace concept at all. Never introduced,
  and not closed, by SF1, SF2, round 2, or round 3.
- **(C) — both namespaces, plain directory deleted and recreated, no junction at all — PRE-EXISTING,
  INHERENT, same reason as (B), stronger.** With no symlink layer at all, `direct(P)` and `literal(P)` are
  BOTH simply `P` itself at every point in time — there is no DIFFERENCE between the two namespaces to
  exploit a gate on, because the collision is total: the identity computation has zero signal to
  distinguish "the same repo, still here" from "a different repo, freshly created at this same path."
  Confirmed pre-existing, same as (B).

**The corrected, true safety claim for THIS card's own fix: round 3 closes the LITERAL-namespace
collision that this card's own round-1/round-2 work introduced (case A) — it does not, and cannot by
itself, close the pre-existing direct-namespace / no-junction collisions (B)/(C), which are inherent to
realpath-based identity and were never this card's own regression to begin with.**

### The canonicalRepoLockKey discrepancy — observed on this host, not asserted either way

The reviewer's own `drift.mjs`/`drift.log` records `canonicalRepoLockKey` staying IDENTICAL across the
same junction removal (`"key same? true"`) on their host. Reproducing the identical fixture shape (a
junction over a bare, non-git directory pair) on THIS host instead gave `kBefore !== kAfter`:
`resolveGitToplevelSync`'s own `findExistingAncestorRealpath` reattaches the removed junction's own leaf
name onto its nearest EXISTING ancestor's realpath once the junction itself is gone, landing on the
junction's own literal path rather than the old target — a structurally different value from the
realpath-resolved `kBefore`. This is recorded as an observation, not a claim about which host's behavior
is "correct" or representative — it did not change the SF2 fix's own direction (which concerns
`directPathIdentity`/`clearedTokens` attribution, not `canonicalRepoLockKey`), and the committed regression
test below does not assert on `canonicalRepoLockKey`'s own stability either way.

## (c) — does twin-graduation or copy-aside rewrite a record's `repoPath`?

**No, neither does.** `unionQuarantineEntries` (twin-graduation) returns `{...older, ...}` — `repoPath` is
always copied verbatim from whichever side (`older`/`newer`, chosen by placeholder-ness then `enteredAt`)
the spread picks; the field is never recomputed. `protectOccupantContentBeforeDelete`'s own copy-aside
(`toPersist`) is built as `{repoPath: parsed.repoPath, ...}` straight from the on-disk JSON's own stored
field — never re-derived via `directPathIdentity`/realpath. A record's `repoPath` string is therefore
stable TEXT across every reconcile/union/copy-aside in this module; only the IDENTITY COMPUTED FROM that
stable string can drift, if the filesystem later makes it unresolvable — which is exactly what the SF2 fix
above addresses at its one source (`directPathIdentity`'s own callers in this module), not something
twin-graduation or copy-aside need to touch themselves.

## SF3 — restored the cross-identity scratch variants, assertion inverted

`merge-quarantine-raise-protect-failure.mjs`'s own card-`48547eec` commit replaced three scenarios'
cross-identity "mint via an unrelated scratch repo, fully clear it there" token fixture with a same-identity
one (minting/clearing under the SAME identity as the record under test), to keep those scenarios passing
under round 3's identity-scoped `clearedTokens` — but in doing so, it silently dropped the ONLY coverage
this corpus had for the cross-identity polarity round 3's own fix is about. Restored the pre-`48547eec`
scratch-identity construction as THREE NEW, separate scenarios (kept alongside the existing same-identity
ones, never replacing them), with the assertion INVERTED to match round-3's correct behavior:

- `7a7e041b-mixed-cross-identity` — `deadTok2` minted+cleared under an unrelated scratch identity must
  SURVIVE `protectOccupantContentBeforeDelete`'s copy-aside (the same-identity sibling asserts it's
  dropped).
- `25f6a7dc-tombstoned-cross-identity` — a legacy-`token`-field record naming an unrelated-tombstoned token
  must still get its OWN pending-divert record minted (coverage is not satisfied by a foreign tombstone).
- `25f6a7dc-probeA-cross-identity` — `markedFinalFullyCoveredByClear`'s own coverage proof must NOT treat a
  cross-identity tombstone as covering `final`; the file must be KEPT (never unlinked), and the
  cross-identity token must resurrect after a reboot (kept content is genuinely re-read, not quietly
  dropped).

All three pass against the fix in this card; see the Tests section below for the RED/GREEN discipline
applied (these three are coverage ADDITIONS for round-3's pre-existing identity-scoping, not discriminators
of this card's own SF1/SF2 changes — they pass identically before and after this card's own fix, since
round-3's cross-identity attribution semantics are unchanged by SF1/SF2).

## N3 (round 2) — SF2's first committed check was mislabeled as a discriminator

`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs`'s Scenario 2 originally labeled its first check
(`t1 stays filtered despite the identity drift`) `*** SF2 FIX ***`, implying it only passes with this
card's own fix. It does not — it passes on pre-this-card `main` too: X's own final AND its in-memory entry
are rewritten atomically by the SAME clear in that specific step, so nothing up to that point in the
scenario ever needed the drifted-identity fix to get this far. Relabeled `(s2 precondition)`. The genuine
SF2 discriminator is the LATER check (`the repo fully lifts once every genuinely-outstanding token is
cleared, despite the identity drift`), which remains labeled `*** SF2 FIX ***`.

## NIT5 — `pendingLatchIdFor`'s bucket vs. `keptUnreadableLatchFiles`'s own basename key (residual, no test)

`pendingLatchIdFor` maps BOTH a clean final `<hash>.json` and its own crash-left `.json.tmp-<pid>`
residue to ONE logical id, for listing/clear-by-id purposes. `tombstoneIfNotSurviving`'s own condition (b)
guard (`keptUnreadableLatchFiles`) is keyed by PHYSICAL BASENAME, not by that logical id. So a
kept-unreadable mark placed on one physical member of that pair does not block a tombstone whose
`touchedFinalBasenames` names only the OTHER member — the two namings of "the same logical latch" are not
reconciled at the (b) guard. Flagged as a residual, no repro built and no test added (per the manager's own
scoping of this card to SF1/SF2/SF3/NIT4) — a follow-up card should repro it directly against
`clearTokenFromPendingIndices`/`clearActiveEntryTokenAtKey`'s own by-token tombstone calls before deciding
whether it is reachable in practice.

## Tests

`merge-quarantine-0d3b64c6-sf1-sf2-tombstone-scope.mjs` — ROUNDS 1-3's own 6 scenarios: 1 (SF1), 2 (SF2),
3 (round-2 B1), 4 (round-3 case A — the literal-namespace collision SF-3 closes), 5 (round-3 M2
discriminator — a case only `.direct` can recognize), 6 (the 7-route drift matrix: token/identity/
recorded-path/key/active-id/pending-id/pending-id-2spell, ported from the reviewer's own
`zz-cr-0d3b64c6-r2-scratch.mjs`, never committed — scratch, deleted after porting). RED/GREEN proven via
`scripts/negative-control.mjs` at two refs: round 1 (`--ref 23dabc63`, the pre-this-card HEAD) and round 2
(`--ref d7a01a79`, this card's own round-1 commit) — both failed reverted, passed restored, tree
byte-identical both times. **Later rounds add their own scenarios in the SAME file, numbered onward from
7 — see each round's own section below (Round 4, Round 5) for its scenarios' count and intent, never
restated here: Round 4 added, and Round 5 then DELETED, two of its own scenarios (Nit 5) — a second count
written here would have gone stale the same way this one just did.**

**Mutation tests, run directly (not via negative-control) — all three confirmed RED:**

| mutation | what it does | result against this test file |
|---|---|---|
| **M1** (identity-ignoring) | `tokenTombstonedForIdentity` returns `owners.direct.size>0 \|\| owners.literal.size>0`, ignoring `recordIdentity` entirely | **RED, 3 failures**: Scenario 3's B1 check, both of Scenario 4's case-A checks. SF1/SF2/M2-discriminator/drift-matrix checks all stayed green (they don't exercise cross-identity matching at all). |
| **M2** (literal-only matching) | drops the `.direct` check and the resolvability gate entirely: `return owners.literal.has(literalRepoPathKey(recordIdentity))` | **RED, 4 failures**: Scenario 4's two case-A checks (literal-only reopens the SAME collision, by a different mechanism than M1) AND Scenario 5's own two checks (its whole point — a case ONLY `.direct` can recognize). |
| **M3** (S1 reverted at by-key) | `clearMergeQuarantineByKey`'s own tombstone call reverted to passing the normalized `identity` local instead of the raw `identityRepoPath` parameter | **RED, 4 failures**: exactly the 4 of 7 drift routes that delegate through `clearMergeQuarantineByKey` (identity, recorded-path, key, active-id). The 3 that don't (token, pending-id, pending-id-2spell) stayed green — correctly isolating M3's own blast radius to that one call site. |

Each mutation was applied as a throwaway edit to the real source, rebuilt, run, confirmed RED with the
exact failure set named above, then reverted (restored from a pre-mutation backup) and rebuilt; the file
is ALL PASS again after each revert.

`merge-quarantine-raise-protect-failure.mjs` — 3 new scenarios (SF3, above), all passing against this
card's own fix. Not independently RED/GREEN-proven against this card's own SF1/SF2 change (they test
round-3's pre-existing cross-identity semantics, unaffected by SF1/SF2 either way — see the SF3 section
above for why); the pre-existing same-identity siblings they sit alongside were themselves already
RED/GREEN-proven by card `48547eec`.

Full `merge-quarantine*.mjs` corpus, `pnpm --filter @loom/daemon guards`, and an EOL check: see the
commit / worker report for the exact counts.

## Do not

- Do not re-widen `tombstoneIfNotSurviving`'s survival scan back to a global (cross-identity) scan "to be
  safe" — that is the exact SF1 regression this card fixes; the scope change is what makes each holder's
  own release tombstoned at its own turn, independent of a sibling identity's own timing.
- Do not defer a `tombstoneIfNotSurviving` call past the write loop it currently precedes in
  `clearActiveEntryTokenAtKey`/`clearTokenFromPendingIndices` — see the "Rejected alternative" section
  above; that reopens `8db913e2` CR2-B1's own stale-bytes resurrection hazard for whichever holder is
  processed first in a multi-holder sweep.
- Do not invent a second "time-stable identity" helper alongside `literalRepoPathKey` — reuse the one
  `repo-lock.ts` already exports; a second, independently-derived normalization would drift from it over
  time exactly like the `clearedTokens`-identity-scoping class this card is already about.
- Do not read the canonicalRepoLockKey discrepancy noted above as settling which host's behavior is
  "the real one" — it is recorded as an observation on two different hosts/fixture shapes, not a claim;
  do not cite "key same? true" (or its negation) as a general property of `canonicalRepoLockKey` without
  re-deriving it for the specific fixture shape in question.
- Do not read SF3's three new scenarios as discriminators of THIS card's own SF1/SF2 fix — they pin
  round-3's pre-existing cross-identity polarity (the gap `48547eec` silently opened by re-attributing to
  same-identity), not anything SF1/SF2 changed.
- Do not merge `clearedTokens`'s two namespaces back into one shared `Set` "for simplicity" — that is
  the exact round-2 B1 regression; `direct(X)` must only ever be checked against `.direct`, `literal(X)`
  only against `.literal`, never cross-namespace.
- Do not pass an already-normalized identity (a local already run through `directPathIdentity`) into
  `tombstoneIfNotSurviving` at any call site — always the RAW `repoPath`, or the literal namespace
  silently collapses to a duplicate of the direct one (S1) and contributes nothing.
- Do not revert the by-id pending bucket (`clearMergeQuarantineLatchFile`) back to tombstoning once per
  bucket KEY — a bucket can span several distinct raw `repoPath` spellings sharing one `directPathIdentity`,
  and `literalRepoPathKey` is not spelling-insensitive; call once per raw spelling in `rawRepoPaths`.
- Do not trust "tokens are process-unique UUIDs" as a safety argument on its own — it is TRUE but
  insufficient: the pre-existing `398f476c`/`f575cebf` bleed class copies a genuine token's VALUE into a
  second identity's own record, so the real question is always whether a READER's identity form can
  wrongly equal an ATTRIBUTION form left by a DIFFERENT identity's clear for that SAME value — a question
  about path-identity stability over time, not about value uniqueness. See the corrected Collision
  analysis section.
- Do not consult `.literal` unconditionally in `tokenTombstonedForIdentity` — gate it on
  `classifyLiteralGate`'s own verdict (round 5's ancestor walk; superseded round 3's
  `!isRepoPathCurrentlyResolvable`, then round 4's leaf-only lstat — see those sections and the Round 5
  section below), checked only after `.direct` alone has already missed — removing the gate reopens
  case (A) exactly as M2 (literal-only matching) reproduces.
- Do not read case (A)'s closure as closing (B)/(C) too — (B) (direct-namespace, a junction's TARGET
  deleted and recreated) and (C) (a plain directory deleted and recreated, no junction at all) are
  structural limitations of using `realpath`/path text as a stand-in for logical repo identity, confirmed
  pre-existing against `23dabc63`, and not touched by any round of this card.
- ⛔ **SUPERSEDED BY ROUND 5 — do not re-gate `.literal` on `isRepoPathCurrentlyResolvable`, in ANY form
  (direct call, or a hand-rolled single lstat on the leaf alone).** Both were tried (rounds 3 and 4) and
  both were reproduced fail-open by a real Code Review (round 4's own MAJOR reproduced round 3's; round
  5's own MAJOR reproduced round 4's, one level up the ancestry — see that section). Gate on
  `classifyLiteralGate`'s own ancestor walk instead; do not re-derive a leaf-only shortcut "for simplicity"
  without re-reading why both prior shortcuts failed.
- Do not trust a committed test's own green as proof it discriminates a specific regression class without
  running the actual mutation — S2 found exactly this gap in round 1's own SF1/SF2 scenarios; the only
  thing that confirmed Scenario 3 actually catches the identity-ignoring class was running that mutation
  and watching it fail.

## Do not (Round 5 additions)

- Do not stop the ancestor walk at the FIRST existing component without first checking whether it, or any
  existing ancestor ABOVE it, is a link — round 4's own regression (and the shape a naive "nearest
  existing ancestor" fix would reproduce one level up) was reading "the leaf's own lstat failed" as
  sufficient; it is not, because the SAME ENOENT fires for a path naming a child of a dangling link.
- Do not re-add `isRepoPathCurrentlyResolvable`-based gating, or any single-lstat-on-the-leaf shortcut, to
  `classifyLiteralGate`/`classifyLiteralGateFromFs` — see the "SUPERSEDED BY ROUND 5" bullet above; both
  shapes were tried and both were reproduced fail-open by a real Code Review.
- Do not re-add legacy-shape (`Set<string>`) support to `clearedTokens`'s `.literal` field, or any
  seeding/narrowing helper for it — `clearedTokens` is in-memory only and resets every reboot (see its own
  doc comment), so there is no durable blob that could ever predate whatever the current shape is. This
  was round 4's own dead weight, deleted by Nit 5; do not re-derive a need for it. (Round 6 note:
  `.literal`'s own shape has since reverted to a plain `Set<string>` — see the Round 6 section — so this
  warning now applies to that shape too, not the round-4/5 `Map` this bullet originally described.)
- ⛔ **SUPERSEDED BY ROUND 6 — Minor 1 and Minor 3 above no longer describe the current mechanism.** Minor
  1 (a re-pointed-then-fully-deleted junction) is GENERALIZED and subsumed by Round 6's own single accepted
  residual (a redirection Loom cannot observe from the path alone) — read that section, not this one.
  Minor 3 (a fail-CLOSED over-block from 8.3/subst/nested-link TARGET COMPARISON) no longer applies at
  all: Round 6 deleted target comparison entirely, so there is nothing left for it to mis-trip. Round 6's
  OWN residual (the same redirection types) is a fail-OPEN, the OPPOSITE direction — `lstat`/
  `isSymbolicLink()` cannot see a mount point, `subst` drive or DFS redirect as a link at all. Do not cite
  either original paragraph's own direction (fail-closed, over-block) as still true.
- Do not re-derive `classifyLiteralGateFromFs`'s own fs dependency as separate, independently
  monkey-patchable `fs.*` references — it is a PURE function over an injected `{realpathNative, lstat}`
  (round 6: no `readlink` any more, see below) precisely so the table-driven unit test can exercise it
  without touching a real filesystem; only `classifyLiteralGate`'s own thin real-fs binding looks up
  `fs.*` directly, ON EACH CALL (never captured once), so Scenario 9/13's `fs`-method monkey-patching
  stays observed.

## Do not (Round 6 additions)

- **Never re-add a target-composition match (`"match-target"`) to `classifyLiteralGate`/
  `classifyLiteralGateFromFs`, under any name or shape.** Five straight Code Review rounds (3 through 6)
  each found a fail-open in some form of "does this path's current target still equal what was stored at
  clear time" — it cannot be made sound against CHAINED redirections (MAJOR 1) and INVISIBLE redirections
  (mount points, `subst`, DFS — the Round 6 residual). The classifier proves only "this could not possibly
  be the same place" now; do not widen that to "this looks like the same place."
- Do not let an existing, non-link ancestor during the walk (rule 3's own "keep walking" branch) stop the
  walk — it says nothing about whether an ancestor ABOVE it is a link (MAJOR 1's own repro: `T1` became a
  link while `P`, nearer the leaf, did not). The walk must reach either a link, the root, or an error —
  never stop early on a plain existing node.
- Do not let `lstat(leaf)` succeeding (rule 2) fall through to the walk for ANY reason — "exists but isn't
  a link, so let's see if its ancestors are" is exactly the round-5 regression (MAJOR 2) this round fixes;
  rule 2 is unconditional on WHAT exists, only on THAT something exists.
- ⛔ **SUPERSEDED BY ROUND 7 — the Round 6 residual's own framing was too WIDE.** Round 6 named "a
  redirection Loom cannot observe from the path alone" as one undifferentiated class; round 7 found a
  `\\?\Volume{GUID}\…` junction is invisible EVEN WHEN THE ENTRY ITSELF (not just its target) is present,
  which round 6's own two checks (lstat succeeding, `isSymbolicLink()`) could not see at all — closed by
  round 7's own checks (i)/(ii). Read the Round 7 section's own (narrower) residual before citing "the
  accepted residual" from round 6's text.
- Do not cite a scenario NUMBER's own historical framing (e.g. "Scenario 8 proves a match") without
  checking which round's text you're reading — Scenario 8's own EXPECTATION flipped in round 6; the round
  4/5 sections above describe what it ONCE proved, not what it proves now.

## Do not (Round 7 additions)

- Do not re-derive "while walking" (check (i)'s own ruling wording) as excluding the LEAF's own rule-2
  check — the identical `lstat` `ENOENT`-doesn't-mean-absent hazard applies there too (`recordIdentity`
  naming the dangling junction entry itself, not a child of it); `presentInParentListing` is called at
  BOTH the leaf's own branch and every ancestor-walk branch, deliberately wider than the ruling's own
  narrower phrasing — see the Round 7 section's own repro paragraph for why.
- Do not re-apply check (ii) (the realpath-vs-lexical comparison) at every ancestor during the walk — it
  fires ONLY at the nearest EXISTING one, by deliberate ruling scope. A SECOND invisible redirect, deeper
  in the chain than the nearest existing ancestor, is part of the accepted residual, not a gap to close by
  widening this check's own reach.
- Do not verify a fix against this class of bug using an `ops` object borrowed from an earlier scratch
  repro without checking it implements EVERY current `LiteralGateFsOps` member — an `ops` missing
  `readdir` makes every `presentInParentListing` call throw a `TypeError`, silently misclassified as
  `"error"` ⇒ `"direct-only"` by accident, which looks EXACTLY like a genuine fix succeeding. This round's
  own verification caught itself doing exactly this against the reviewer's own pre-round-7 scratch
  scripts, and re-verified with a correctly-equipped `ops` before trusting any of it.
- Do not treat the 8.3-short-name over-block in check (ii) as a bug — same "keep more, never less"
  direction every reader in this module already defaults to; fixing it would need a third, case/8.3-
  insensitive comparison primitive this module doesn't have.
- Do not treat the Round 7 residual ((a) a redirection mechanism GONE entirely with nothing left for
  `readdirSync` to find, or (b) a UNC/DFS/POSIX-mount redirect changed and then also gone, with no parent
  directory entry for either shape of redirect to be listed under) as closable by narrowing `"open"`'s own
  presence-match — same reasoning as round 6's own (now-superseded) residual: the SF2 drift routes depend
  on it.

## Do not (Round 8 additions)

- Do not compare `real`/`probe` in check (ii) without routing BOTH sides through
  `normalizeForAncestorComparison` first — comparing either side raw (or lowercased-only, round 7's own
  shape) reopens the exact fail-CLOSED regression this round fixes for ANY `\\?\<drive>:\…`-spelled
  `recordIdentity` or any ancestor walk reaching a UNC share root.
- Do not widen `normalizeForAncestorComparison`'s own prefix-strip to `\\?\UNC\…` or `\\?\Volume{…}…` —
  those are EXACTLY the redirections checks (i)/(ii) exist to detect; stripping them would silently
  swallow round 7's own fix. Only the local-drive form (`\\?\<letter>:`) is safe to strip, per
  `isUnsafeToCanonicalize`'s own exemption (`projects/vault-path.ts`).
- Do not call `directPathIdentity` directly on either side of check (ii)'s comparison as a shortcut to
  "reuse its normalization" — it re-invokes `realpath`, making the comparison VACUOUS (both sides
  converge to the same `realpath(probe)` value regardless of whether `probe` is a genuine redirect).
  Reuse only its LOWERCASE-ON-WIN32 rule, as `normalizeForAncestorComparison` does, never the whole
  function.
