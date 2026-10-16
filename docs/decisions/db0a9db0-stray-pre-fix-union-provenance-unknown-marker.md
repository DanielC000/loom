# db0a9db0 — a pre-82032b5c stray-union latch is marked `provenanceUnknown` at boot, so clear-by-id fails closed on it

This is the follow-up `82032b5c` round 2 boarded but did not fix ("pre-round-2 stray union files may
already exist on disk from when round 1's own fix was live in production — a separate card"), widened to
cover every PRE-82032b5c (pre-commit-`48aeb324`) daemon, not only round-1-of-82032b5c-era strays. `96e6aa58`
(landed as `d96f796b`) then gated `consumeMatchedPendingsIntoArmedEntry`'s own sibling-absorb writes on
ownership — unrelated to, and unaffected by, this card.

## The shape (verified, not merely argued — see "Verification" below)

A pre-`48aeb324` daemon's `enterMergeQuarantine` `existing` branch (as it existed at commit `60c8052c`,
`packages/daemon/src/git/merge-quarantine.ts` lines 953-987) absorbed a sibling raise directly into an
already-armed, degraded (unresolvable) occupant's own entry object:

```
const entry: MergeQuarantineEntry = { ...existing, tokens: [...existing.tokens, token] };   // line 959
...
writeMergeQuarantineLatch(entry, true, undefined, true);                                     // line 982
```

`writeMergeQuarantineLatch` (same commit, lines 465-489) with `targetKey=undefined` resolves its write
target via `quarantinePathFor(entry.repoPath)` → `quarantinePathForKey(canonicalRepoLockKey(entry.repoPath))`
(lines 295-301) — a FRESH recompute from the degraded occupant's own (unresolvable) `repoPath`, never the
key actually in `armedKeys`. The pre-`48aeb324` `MergeQuarantineEntry` type (same commit, lines 26-78) has
no `contributorRepoPaths` field at all — it does not exist yet, so none of this write's three calls could
ever populate one.

Net effect: a degraded occupant `X` (unresolvable, originally armed at its own `resolvedKey` `Ky`) that
absorbs a sibling raise from a genuinely resolvable `Y` (whose own `canonicalRepoLockKey(Y)` is `Ky`)
leaves TWO files on disk: `Ky`'s own tracked file, STALE (only `X`'s original token), and a SECOND,
untracked file at `hash(canonicalRepoLockKey(X))` — `X`'s own fresh walked-up key, which is NOT
necessarily `Ky` (it is only `Ky` if `X`'s own ancestor walk, recomputed right now, still lands there;
measured directly, this is typically a DIFFERENT value — see "Verification") — carrying the COMPLETE
union (`X`'s and `Y`'s tokens together) with no record that `Y` was ever involved.

## Why a CURRENT (post-`48aeb324`, post-`d96f796b`) boot mis-arms this and fails open

PASS 1 (`reenterMergeQuarantinesAtBootImpl`) processes every file in the quarantine directory. For the
stray file: `currentKey = canonicalRepoLockKey(entry.repoPath)` recomputes to the SAME value that named
the file (nothing about `X`'s ancestor structure changed between the stray write and this boot), so
`freshHash === hash` — PASS 1's own `if (freshHash !== hash)` migrate/divert branch is skipped entirely,
and the file falls through to the ordinary dual-arm path, arming the COMPLETE union at both its own
walked-up key AND `Ky` (`entry.resolvedKey`), with no contributor marker.

`clearMergeQuarantineLatchFile` (and `assertRepoNotQuarantined`) ask `ambiguousIdentitiesFor` whether a
bare id is safe to act on. `ambiguousIdentitiesFor`'s `contributorRepoPaths` reads the (absent) field —
empty. Its `siblingRepoPaths` (`canonicalSiblingsFor`) only ever finds a PENDING entry whose own
`directPathIdentity` DIFFERS from the active entry's — the one pending reference this shape produces
(PASS 1's own `883e29bc` degraded-divert twin) shares `X`'s OWN identity, not `Y`'s, so it is correctly
excluded by that same-identity check and contributes nothing either. Both axes report zero ambiguity, and
a bare clear-by-id on `Ky`'s own id proceeds unrefused — hard-deleting both physical files and silently
lifting `Y`'s own still-outstanding unconfirmed-kill token as a side effect, with no disclosure anywhere
in the refusal text or the clear result that `Y` was ever involved.

This is a GENUINELY DIFFERENT gap from the already-fixed `9a55fb90` scenario
(`merge-quarantine-pass1-migrate-union.mjs`'s `clear-by-id-refused-on-canonical-collision`): there, `Y` has
its OWN separate, standalone latch file that boot migrates into a genuinely separate PENDING record with
a DIFFERENT `directPathIdentity` than the active entry — `canonicalSiblingsFor` finds it, and the fix
correctly refuses. Here, defect (A)'s pre-fix write already ERASED `Y`'s distinct identity into `X`'s own
`tokens` array, years before `contributorRepoPaths` existed to record it — there is nothing left on disk
for `canonicalSiblingsFor` to find; the information was destroyed when the stray file was originally
written, not lost by anything boot does now. `82032b5c`'s own "Do not" list already states this field's
job is narrow and can never be inferred from a boot-time union after the fact.

## The fix: `detectUnknownProvenance`

A PERSISTED, STICKY boolean, `MergeQuarantineEntry.provenanceUnknown`, set whenever ALL of the following
hold — read purely from `entry`'s own static signature, independent of current resolvability or which
boot-time branch (degraded-divert / migrate / dual-arm) reaches it (**round 2 corrected this — see below;
round 1's own condition gated on resolvability and is superseded, not merely extended**):

- `entry.resolvedKey` is set;
- `entry.tokens.length > 1` — LOAD-BEARING, not incidental: `enterMergeQuarantine` mints exactly one fresh
  token per raise (its own doc), so a single-token entry structurally CANNOT represent more than one
  raiser, regardless of every other condition here. A single-token legacy entry is therefore NEVER marked,
  with no corresponding risk to justify marking it (test scenario `single-token-legacy-file-unaffected`).
- `entry.contributorRepoPaths` is absent/empty — a POST-fix union already names its contributor(s); there
  is nothing unknown left to mark (test scenario `post-fix-contributor-union-unaffected`).
- `entry.provenanceTracked` is absent — the round-2 precision guard; see below.
- the file's own physical hash `!== quarantineHashForKey(entry.resolvedKey)` — the file does NOT sit at
  the hash its own `resolvedKey` would imply (the exact shape `quarantinePathFor(entry.repoPath)` with
  `targetKey=undefined` produces for a degraded occupant).

Detection cannot distinguish the real defect from a wholly BENIGN legacy shape — the SAME repo raised more
than once under the pre-fix code, with no second identity EVER actually involved, happens to produce an
on-disk file that is BYTE-IDENTICAL to a genuine cross-identity union (dual-armed, multiple tokens,
mismatched `resolvedKey`) once the bytes alone are all that is left to look at. **Lead's ruling: fail
closed anyway.** The benign case loses only the clear-by-id shortcut (clear-by-path still works and still
lifts it); the real case, left undetected, silently destroys a different repo's own outstanding
unconfirmed-kill token. A redirected clear is strictly cheaper than a silent, undisclosed loss of
enforcement (test scenario `benign-same-identity-legacy-multi-raise-accepted-false-positive` — the accepted
false positive, explicit).

Applied at all three boot-time JSON-parse sites that already carry `contributorRepoPaths` forward (PASS 1
main loop, PASS 1b tmp-residue recovery, safety-tmp recovery) via the one shared helper, never three
copies — called ONCE, immediately after parsing, UNCONDITIONALLY, before any branch dispatch or mutation
(round 2's own fix; see below for why this ordering is load-bearing). The helper's very first check is
`if (entry.provenanceUnknown) return true;` so an already-marked entry (sticky) never needs re-derivation.

`unionQuarantineEntries` ORs the field from both sides (never AND — sticky once either side carries it).
Every explicit-field-whitelist copy/rebuild site that is NOT a bare object spread
(`protectDegradedOccupantBeforeDelete`'s own JSON whitelist, `mergeTokenIntoPendingEntries`'s cross-matched
merge) carries it forward explicitly, mirroring exactly how `contributorRepoPaths` already does it there —
`mergeTokenIntoPendingEntries` needed its OWN cross-matched OR (not just a bare `...base.entry` spread),
for the identical reason `contributorRepoPaths` already needed one: a non-`base` matched entry's own flag
would otherwise be silently dropped. Every other copy/rebuild site (`armQuarantineKey`'s own union-wrapping
spread, `consumeMatchedPendingsIntoArmedEntry`'s spreads, `clearActiveEntryTokenAtKey`'s partial-clear
rebuild) is a plain object spread and carries the field automatically, with no code change needed.

`ambiguousIdentitiesFor`/`ambiguousIdentitiesForLatchId` grew a third, independent axis,
`unknownProvenance` (plus `unknownProvenanceKeyPath` when the entry's own `resolvedKey` is a genuinely
readable path — see below), and `totalAmbiguousCount` folds it in. The two existing refusal-text call sites
(`clearMergeQuarantineLatchFile`'s active and pending branches, `assertRepoNotQuarantined`'s ambiguous
branch) were restructured to count `namedIdentities.length` for what they NAME, never the (now-wider)
`totalAmbiguousCount` — the two can disagree the moment an entry carries BOTH named contributors AND
`unknownProvenance` (a `provenanceUnknown`-marked entry can later also gain a REAL, properly-tracked
contributor via a fresh post-upgrade raise) — and append a second, generic clause when `unknownProvenance`
is set. Byte-identical to the pre-this-card text whenever `unknownProvenance` is false, which is every
case these sentences were ever written for.

`remediationTextFor` names ONLY `clear-by-path` with the entry's own repoPath (never a fabricated
identity) plus one generic sentence when `unknownProvenance` is set: the entry may fold together raises
from more than one repo from before provenance tracking existed, and clearing lifts all of them — confirm
no process is running under the listed path(s) AND under the entry's own `resolvedKey`, NAMED, when that
key is itself an absolute filesystem path. `canonicalRepoLockKey` always returns one today (a realpath of
a resolved `.git` toplevel, or the nearest existing ancestor — `repo-lock.ts`'s own doc) — `absoluteKeyPathOrUndefined`
guards rather than assumes this (`path.isAbsolute`), per the instruction never to fabricate a path to name
when it cannot be confirmed. For a protect-copy pending entry specifically (`protectDegradedOccupantBeforeDelete`'s
own whitelist), `resolvedKey` is routinely ABSENT entirely (that whitelist deliberately never copies it —
`c9114934`'s own rule) — this is the ordinary, expected case for that shape, never evidence of an
"unresolvable" key that was attempted and failed.

## Round 2 (CR `c8e6bc09`) — detection must read the file's OWN signature, never a branch-dependent fact

Round 1's own `detectUnknownProvenance` gated on `resolvableNow` (`if (resolvableNow) return false;`) and
was called ONLY at the dual-arm fallthrough (`freshHash === hash`). **BLOCKER, reproduced on commit
`b8b6167a`:** on a LATER boot where `X` has since become resolvable (e.g. a human runs `git init` on what
used to be a dangling path), PASS 1 takes the `freshHash !== hash && resolvableNow` MIGRATE branch for
`X`'s own stale (`Ky`) file instead — `detectUnknownProvenance` returned `false` unconditionally there
(the resolvability gate), and the stray file's OWN dual-arm fallthrough ALSO never marked it (same gate,
now true since `X` is resolvable) — so the union migrated to its new key completely UNMARKED.
`clearMergeQuarantineLatchFile(hash(Ky))` then succeeded unambiguously, silently lifting `Y`'s own token —
the EXACT fail-open this card exists to close, reopened one boot later. This falsified the field's own
doc claim ("a later boot has no more information than an earlier one did") — a later boot that happens to
land in a DIFFERENT branch had strictly LESS information, because detection was never called there at all.

**THE FIX, two parts that work together:**

1. **Detect on the file's own signature, in EVERY branch, before any write in that branch.** The
   defect-A shape is a multi-token file whose physical hash does not equal `quarantineHashForKey(its own
   resolvedKey)`, with no `contributorRepoPaths` — true of the ORIGINAL stray file regardless of whether
   `X` happens to be resolvable on any GIVEN boot. Calling `detectUnknownProvenance(entry, hash)`
   immediately after parsing — before `currentKey`/`freshHash` are even computed, before the migrate
   branch's own `entry = {...entry, resolvedKey: currentKey}` rewrite — means the FIRST boot that ever
   writes this entry (whichever branch that happens to be) persists the marker durably. For a branch that
   never writes this boot (the degraded-divert branch does not touch disk), the mark stays in-memory only
   for that boot; it costs nothing, because the NEXT boot re-derives the identical answer from the SAME,
   unchanged physical bytes — the file's own signature does not depend on resolvability, so re-deriving it
   fresh every time is exactly as safe as reading a persisted value back.
2. **The precision guard — `provenanceTracked`.** The CR also found that CURRENT code can legitimately
   produce a file whose hash differs from `quarantineHashForKey(its own resolvedKey)` for a reason that
   has nothing to do with the legacy defect: `consumeMatchedPendingsIntoArmedEntry` stamps `resolvedKey`
   onto an entry while leaving its OWN physical file at a different, still-correct secondary key (the
   `buildDualArmFixture` shape several sibling tests already exercise). Marking THAT shape would newly
   refuse clear-by-id for a CURRENT user who never touched the legacy defect at all. Fix: `writeMergeQuarantineLatch`
   now stamps every latch it writes with a persisted `provenanceTracked: true`, unconditionally, and
   `detectUnknownProvenance` additionally requires its ABSENCE. A legacy (pre-landing) file never carries
   it. A file written strictly BETWEEN `48aeb324` (the 82032b5c landing) and THIS round's own landing also
   lacks it (the field did not exist yet) — a same-identity multi-raise written in that narrow window can
   still be marked `provenanceUnknown`: an ACCEPTED, BOUNDED false positive (fail-closed, still clearable
   by path, identical in kind to the pre-`48aeb324` benign false positive this card already accepts).

`provenanceTracked` is carried forward at every copy/rebuild site exactly like `provenanceUnknown`
(`unionQuarantineEntries` ORs it; `protectDegradedOccupantBeforeDelete`'s whitelist and
`mergeTokenIntoPendingEntries`'s cross-matched merge carry it explicitly; every plain-spread site carries
it automatically).

Two nitpicks fixed in the same round: the PENDING-tier refusal sentence
(`clearMergeQuarantineLatchFile`'s pending branch) used to splice a bare noun-phrase clause directly after
"whose own token set carries", producing the grammatically broken "...carries this entry's own provenance
is incomplete..." whenever `unknownProvenance` was the ONLY source of ambiguity (no named contributors) —
fixed by making each clause ("whose own token set carries...", "whose own provenance is incomplete...")
a full standalone clause joined with `", and "`. And `readableKeyPathOrUndefined` was renamed
`absoluteKeyPathOrUndefined` (its own behavior — `path.isAbsolute` — is what it actually checks; "readable"
implied a filesystem-existence check it never performed).

## Do not

- Do not re-derive `provenanceUnknown` only at the ONE site that happens to be easiest to reach — a
  persisted, sticky field must be carried forward at EVERY copy/rebuild site, exactly like
  `contributorRepoPaths` already has to be, or a later boot's PRIMARY parse silently drops a durably
  written marker and falls back to re-derivation alone, which can miss it once some later event (e.g. a
  partial clear reducing `tokens.length` to 1) changes the structural shape out from under it. (This is
  not hypothetical — PASS 1's own main-loop parse was the FIRST site fixed in this card's own development
  and was, for a time, the one site that DIDN'T carry the field forward; caught only by the
  restart-persistence test scenario going RED against the card's own in-progress fix, not by reasoning
  about it in the abstract.)
- Do not try to make detection precise enough to never mark a benign same-identity multi-raise — the bytes
  alone cannot distinguish the two shapes; a detector that tried to narrow further by inventing some other
  heuristic would either miss real cases (fail-open, the actual defect) or still accept the same false
  positive under a different name. Mark both; let clear-by-path absorb the cost.
- Do not name a specific second identity in `unknownProvenance`'s own remediation clause — the whole point
  of this field is that the daemon genuinely does NOT know who else may be folded in. Naming one anyway
  would be exactly the kind of confident-but-wrong text `82032b5c` round 4's own Lead ruling already
  retracted for a different route.
- Do not use `totalAmbiguousCount` (or `ambiguousCount`) to drive a refusal sentence's own named-identity
  COUNT — use `namedIdentities.length` instead. The two are no longer the same number once an entry can
  carry both named contributors and `unknownProvenance` at once.
- Do not assume `canonicalRepoLockKey`'s return value is always an absolute path without checking — guard
  via `absoluteKeyPathOrUndefined` (or an equivalent explicit check) at the point of use; never fabricate a
  path to print in a refusal when that check fails.

## Do not (round 2 additions)

- Do not gate `detectUnknownProvenance` (or any future revision of it) on resolvability, or on WHICH
  boot-time branch (degraded-divert / migrate / dual-arm) reaches it — this is the exact round-1 defect:
  a file's own signature does not change depending on what the REPO happens to be doing on a given boot,
  and gating on something that CAN change between boots (resolvability) reopens the fail-open this card
  exists to close, one boot later, non-deterministically.
- Do not call `detectUnknownProvenance` AFTER a branch has already mutated `entry` (in particular, after
  the migrate branch's own `entry = {...entry, resolvedKey: currentKey}` rewrite) — by then the ORIGINAL
  `resolvedKey` this detection needs to compare against is already gone. Call it once, immediately after
  parsing, before any branch dispatch at all.
- Do not stamp `provenanceTracked` anywhere except `writeMergeQuarantineLatch`'s own write — every OTHER
  write helper (`writeSafetyTmpResidueAtHash`, `writePendingDivertFile`) must faithfully carry forward
  whatever value the entry it's given ALREADY decided, never originate a fresh `true` of its own; only
  `writeMergeQuarantineLatch` is the chokepoint for "this is new, correctly-tracked content."
- Do not read the ~2-month window between `48aeb324` and this round's own landing as something to go back
  and backfill — a file written in that window simply lacks `provenanceTracked`, and the resulting
  possible false positive is explicitly accepted (bounded, fail-closed, still clearable by path) rather
  than chased with a second migration mechanism.

## Round 3 (CR) — the test's own mutation technique was itself unsafe; never mutate the real shared dist

Round 2's own `carry-forward-sites-pinned-via-dist-mutation` scenario mutated the REAL, shared
`packages/daemon/dist/git/merge-quarantine.js` in place (write the mutated bytes → run → restore in a
`finally`). This is fine as a ONE-OFF, interactively-run negative-control proof (exactly what this
record's own earlier rounds did), but it is NOT safe as a standing, committed test: the merge gate runs
test files CONCURRENTLY (`LOOM_GATE_TEST_CONCURRENCY`), every lane importing the SAME compiled module —
while this scenario's own mutation window is open, any sibling quarantine test running in another lane
silently runs against mutated code. Worse, a gate TIMEOUT `SIGKILL`s the child before its `finally` can
run, leaving the mutation in `main`'s own dist permanently — for every later gate run, and for the LIVE
daemon's own next restart.

**THE FIX:** `withDistMutation` now copies the SMALL, fully-enumerated import closure
`merge-quarantine.js` actually needs — `paths.js`, `pty/resolve-bin.js`, `pty/claude-dirname.js`,
`git/repo-lock.js`, `git/merge-quarantine.js` (enumerated by hand from each file's own `^import` lines,
transitively, until every leaf has none — read them again yourself if this import graph ever changes) —
into a fresh `os.tmpdir()` directory, preserving their relative structure so their own untouched `./`/
`../` specifiers still resolve correctly, mutates ONLY the copy of `merge-quarantine.js`, and imports
THAT copy. The real `dist/` is never opened for writing at all. A `(byte-identical guard)` check, backed
by a SHA-256 hash of the real file captured BEFORE any mutation-scenario code runs, fires after EVERY
mutation attempt (not just once at the end) — so the test fails loudly, by name, the instant anything
ever writes the real file, from any cause, not only a bug in this helper's own copy logic.

**Audit (requested by the CR, not fixed here):** grepped the whole `packages/daemon/test/*.mjs` corpus for
any OTHER test writing into `dist/`. Every hit outside this file writes to a SYNTHETIC/fixture `dist`
directory under a throwaway repo or temp root (`deploy-staleness.mjs`, `dist-importer-check-glue.mjs`,
`dist-importer-direct-scan.mjs`, `served-status-dist-drift.mjs`, `vault-versioner-wiring.mjs`), never the
real shared one — confirmed by reading each site, not just pattern-matching "dist" in a path. One
GENUINE exception found: `graceful-teardown-hard-exit-backstop.mjs` writes real, uniquely
PID-and-random-suffixed sibling files directly into the real `packages/daemon/dist/` (e.g.
`graceful-teardown.clockshim-<pid>-<rand>.js`, lines ~580/803-804/825-826), with its own pid-liveness-
gated sweep for stale siblings left by a crashed prior run (`sweepStaleDistSiblings`, lines ~105-122) —
a DIFFERENT shape from this card's own defect (it creates new, uniquely-named files rather than
overwriting the shared `merge-quarantine.js` in place, so a concurrent lane importing the real compiled
module by its own real name is unaffected), but it still writes into the shared `dist/` tree and was
flagged for the Lead to card, not fixed here.

## Round 4 (CR, test-only) — the whitelist pin (3) was vacuous, and `provenanceTracked`'s own carry was pinned at only one site

Round 3's own `carry-forward-sites-pinned-via-dist-mutation` scenario's pin (3)
(`protectDegradedOccupantBeforeDelete`'s whitelist) selected the protective copy to read back by "exactly
one `pending-*.json` file in `MERGE_QUARANTINE_DIR`" — but that directory is SHARED across every
sub-check within this one scenario's single `LOOM_HOME` (each SCENARIO gets its own fresh `LOOM_HOME`,
but sub-checks WITHIN one scenario do not), and the baseline sub-check's own protective file is never
cleaned up. By the time the MUTATED sub-check ran, the directory held TWO pending files — the baseline's
leftover plus the mutated run's own — so `protectiveFiles.length !== 1` was true regardless of whether
the real mutation did anything, silently returning `undefined` and making the downstream check pass
VACUOUSLY. Reproduced directly: with a TEMPORARY no-op in place of every one of the scenario's own
mutations (an env-gated test-only override, never committed), pin (3) alone kept PASSING while every
sibling pin correctly failed — proof the vacuity was real, not theoretical.

**THE FIX:** select the protective copy by X's own IDENTITY (`parsed.repoPath === x3`), never by file
count, and assert non-vacuously that EXACTLY ONE match was found for that identity (never zero, never
more than one) — asserted inside the shared helper itself, so both call sites (baseline and mutated) get
it for free. Re-verified with the SAME no-op-mutation technique: with the override in place, pin (3) now
correctly FAILS alongside every other pin; with the real mutations restored, every pin (now eleven — see
below) passes as designed.

`provenanceTracked`'s own carry-forward (the precision guard) was pinned at only ONE site — PASS 1's own
primary parse, and only INDIRECTLY, via scenario (g)'s own single-boot check. Its remaining five
carry-forward sites (PASS 1b's parse, safety-tmp's parse, `unionQuarantineEntries`'s own OR, the protect
whitelist's own parse, and `mergeTokenIntoPendingEntries`'s own cross-matched OR) had no pin of their own
at all. Five new pins — (7)-(11), same `carry-forward-sites-pinned-via-dist-mutation` scenario — close
that gap, each mirroring scenario (g)'s own CURRENT-format (`provenanceTracked: true`) shape at its own
site. PASS 1b's and safety-tmp's own pins ((7)/(8)) drive the full `detectUnknownProvenance` round-trip
in a SINGLE boot (a dropped carry WRONGLY marks a current-format dual-arm `provenanceUnknown`, since
detection runs immediately at parse time, before any union); the union/whitelist/
`mergeTokenIntoPendingEntries` pins ((9)/(10)/(11)) check the carried field directly, the same style
(1)/(2)/(3)/(6) already use for `provenanceUnknown` — a union's own result is never re-fed through
`detectUnknownProvenance` within the same boot, so there is no same-boot "wrongly marked" outcome to
observe there; the field's own direct presence/absence is the observable.

**Out of scope, carded separately (per the Lead):** a BRAND-NEW entry created at RUNTIME
(`enterMergeQuarantine`'s own fresh-entry branch) never sets `provenanceTracked: true` on its OWN
in-memory object — only `writeMergeQuarantineLatch`'s own WRITE stamps it, onto the serialized bytes,
never back onto the in-memory entry itself. Harmless today (a fresh runtime entry never reaches
`detectUnknownProvenance`, which only runs at boot-time parse), but a latent inconsistency between the
in-memory and on-disk shapes of a brand-new entry, worth closing for its own sake. Not fixed in this
test-only round.

## Verification

`packages/daemon/test/merge-quarantine-unknown-provenance.mjs` — 9 scenarios, each in its own child
process with its own fresh `LOOM_HOME`, mirroring every sibling `merge-quarantine*.mjs` file:

- `stray-union-marked-and-fails-closed-then-clear-by-path-lifts-both` — the exact repro (a hand-written
  latch pair matching defect (A)'s own persisted shape exactly, derived from `60c8052c`, never guessed):
  marked, clear-by-id refuses, both identities stay enforced, and `clearMergeQuarantineByRecordedPath`
  (the REAL function behind the route the refusal text names) actually lifts both.
- `benign-same-identity-legacy-multi-raise-accepted-false-positive` — the accepted false positive,
  explicit: marked, refused by id, still clearable by path; a bystander repo whose key the entry's own
  `resolvedKey` names is blocked by the entry's own pre-existing dual-arm mechanics (`883e29bc`, unrelated
  to and unchanged by this card) and reads clear again only once the union itself is cleared.
- `single-token-legacy-file-unaffected` — never marked, clear-by-id unaffected.
- `post-fix-contributor-union-unaffected` — a REAL runtime union via the current, fixed
  `enterMergeQuarantine`, never marked, still driven entirely by the pre-existing `82032b5c` mechanism.
- `partial-clear-persists-marker-and-survives-restart` — a partial clear (`clearMergeQuarantineByToken`)
  durably rewrites `provenanceUnknown: true` into BOTH physical files' own bytes for the first time (it
  is in-memory-only immediately after the first boot); a fresh boot (`reboot.reenterMergeQuarantinesAtBoot`
  against a separately re-imported module instance) reads it back via the sticky carry-forward and
  clear-by-id still refuses afterward.
- **(Round 2)** `round2-migrate-branch-fails-closed-then-clear-by-path-lifts-both` — the exact blocker:
  the scenario (a) fixture, then `X` becomes resolvable (`git init`) on a SECOND boot, triggering PASS 1's
  migrate branch for `X`'s own stale file. Still marked, `Y` still reachable/enforced, clear-by-id still
  refuses, clear-by-path still lifts both. RED on `b8b6167a` (round 1).
- **(Round 2)** `current-format-dual-arm-with-provenance-tracked-unaffected` — the precision guard: a
  hand-written, CURRENT-format (`provenanceTracked: true`) dual-arm at a secondary key (the
  `buildDualArmFixture` shape) is never marked; clear-by-id behaves exactly as on `main`.
- **(Round 2, mutation technique corrected in Round 3; the whitelist pin's own vacuity fixed and five
  `provenanceTracked` pins added in Round 4 — see below)** `carry-forward-sites-pinned-via-dist-mutation`
  — pins EACH carry-forward site the CR named (and, by Round 4, `provenanceTracked`'s own remaining
  sites too) with its own ONE-SITE mutation of a THROWAWAY COPY of the minimal import closure (never the
  real, shared `packages/daemon/dist/` — see Round 3): `unionQuarantineEntries`'s OR in both directions
  for BOTH fields ((1)/(2) `provenanceUnknown`, (9) `provenanceTracked`, each proven lost under the
  mutation that drops its own side), `protectDegradedOccupantBeforeDelete`'s whitelist for BOTH fields
  ((3) `provenanceUnknown`, (10) `provenanceTracked` isolated — via the REAL
  `buildRuntimeUnionFixture`-shaped protect trigger — a degraded `X` absorbing a real runtime raise from
  `Y`, then `clearMergeQuarantine(y)` triggering the protective copy, read back by X's own IDENTITY, with
  an explicit non-vacuity assertion that exactly one match was found — see Round 4), PASS 1b's and
  safety-tmp's own parse+detection for BOTH fields ((4)/(5) `provenanceUnknown`, via hand-constructed
  `.json.tmp-<pid>` / `.json.tmp-safety-` residue matching the stray shape; (7)/(8) `provenanceTracked`,
  via the SAME residue shapes but a current-format dual-arm that must stay UNMARKED), and
  `mergeTokenIntoPendingEntries`'s cross-matched OR for BOTH fields ((6) `provenanceUnknown`, (11)
  `provenanceTracked` — two separate pending sources for one identity, the marker on the NON-base,
  later-entered one). Every site: an unmutated baseline check (marker present/absent as expected)
  immediately followed by the SAME fixture shape run against the ONE-SITE mutation (the expected
  carry lost) — never a bare "it passed," always a demonstrated RED/GREEN pair, confirmed by Round 4's
  own no-op-mutation audit: with a temporary no-op override in place of every real mutation, ALL ELEVEN
  pins fail; with the real mutations restored, all eleven pass.
- **(Round 2)** `pending-tier-refusal-drives-real-clear-by-path-route` — a genuinely PENDING-ONLY match
  (via the `reenterMergeQuarantinesAtBootTestOnly` injection seam, a `pending-<hex>.json`-shaped
  sourceFile whose id can never collide with any active entry's own armedKeys-derived id): refuses,
  asserts the refusal text is GRAMMATICAL (the round-2 nitpick fix), and drives
  `clearMergeQuarantineByRecordedPath` — the real function behind the named route — to confirm it lifts.

Proven via `pnpm --filter @loom/daemon negative-control --ref b8b6167a --file packages/daemon/src/git/merge-quarantine.ts
--test packages/daemon/test/merge-quarantine-unknown-provenance.mjs`: RED against round 1 (`b8b6167a`) —
3 of 9 scenarios failed, each for a DIFFERENT, expected reason: the migrate-branch scenario (4 checks,
the actual blocker), the dist-mutation scenario (crashes at its OWN protect-whitelist sub-check, since
that mutation's target text — the `provenanceTracked` carry-forward — does not exist in round 1's
compiled output at all, confirming these sub-checks are genuinely round-2-specific rather than vacuously
passing), and the pending-tier scenario (1 check, the grammar nitpick). The other 6 scenarios correctly
still passed on round 1, since none of them exercises anything round 2 changed. GREEN after (all 9),
clean byte-identical restore confirmed.

`X`'s own fresh walked-up key differing from `Ky` (the precondition each scenario asserts explicitly
before relying on it) was measured directly, not assumed: `X` is a path under the OS temp directory that
never exists at all, with no `.git` anywhere in its own ancestor chain, so its walked-up key degrades to a
value with no relationship to `Y`'s (or `Z`'s) real, resolvable key — reproducing the "untracked,
unreferenced hash" `82032b5c`'s own round-1 text already measured for the live runtime-union defect this
card's own stray-file residual descends from.

## Follow-up 150aed7b — the scalar-only gate never reached the hash check for an array-only record

Card `150aed7b`, flagged by `43cf3b26`'s own round-3 Code Review (`5220fda9`): `detectUnknownProvenance`'s
own precondition `if (!entry.resolvedKey) return false;` reads ONLY the scalar field. Card `43cf3b26`
generalized `resolvedKey` (singular) to `resolvedKeys` (plural, N keys) at every OTHER read site in this
module via its own `informativeKeysFor` helper (scalar ∪ plural, deduped) — but this detector's own gate
was never updated to match. An array-only record (plural `resolvedKeys` populated, no scalar at all —
`43cf3b26`'s own `probe2.mjs`/"plural-only-no-scalar" shape) short-circuited at the scalar check and
never reached the hash-mismatch comparison at all, regardless of whether it would otherwise match the
defect-A signature this detector exists to catch.

### Confirmed reachable, not merely theoretical

All THREE call sites that construct `entry` from raw parsed JSON parse `resolvedKey` (scalar) and
`resolvedKeys` (plural) as separate fields, straight off the raw bytes, and call
`detectUnknownProvenance` immediately after, before any other derivation — PASS 1's own main loop, PASS
1b's tmp-residue recovery, and the safety-tmp recovery pass. An array-only record reaching ANY of the
three arrives at the scalar-only gate with `entry.resolvedKey === undefined` identically at all three;
none of them derives the scalar from the plural array first. Confirmed directly at each site (not
inferred from one and assumed for the others) before writing the fix.

### The fix

Generalized the gate to `informativeKeysFor(entry).length === 0` (the SAME helper `43cf3b26` already
introduced for every other scalar-only gate in this module) and the hash check to
`informativeKeysFor(entry).some((k) => quarantineHashForKey(k) !== hash)`. With exactly one informative
key (the pre-150aed7b population of every record that ever reached this function, since `43cf3b26`'s own
plural field didn't exist before it), `.some()` over a one-element array reduces to the ORIGINAL
single-key comparison byte-for-byte — this is a pure generalization, never a behavior change for any
record shaped the way every existing caller already produces.

**Why `.some()`, not `.every()`:** the scalar case's original semantics were "the one recorded key
mismatches the physical hash ⇒ suspicious." Generalizing to N keys while preserving that same meaning
means each key is independently checked against the SAME predicate and ORed together — exactly how this
module's own sibling helper (`secondaryKeysToAttempt`'s per-key boot-time re-arm loop) already treats a
plural `resolvedKeys` as N independent candidates, never as a single aggregate fact.

### Do not

- Do not revert to deriving a single scalar from `informativeKeysFor(entry)[0]` (e.g. "pick the first
  key") before the hash check — that silently drops every OTHER key's own independent signal and
  reintroduces an order-dependent, arbitrary answer for a record carrying more than one key.
- Do not forget this detector is called at THREE sites, not one — a future change here must be verified
  against all three, since they share no common call-through chokepoint (unlike most write-side logic in
  this module, which funnels through `writeMergeQuarantineLatch`).

### Tests

`merge-quarantine-unknown-provenance-array-only-150aed7b.mjs` (new, 2 scenarios, each in its own child
process with its own fresh `LOOM_HOME`): `scalar` (the pre-existing, unchanged behavior — a positive
control) and `array-only` (the fix — a record shaped identically except `resolvedKeys` instead of
`resolvedKey`, now ALSO correctly flagged `provenanceUnknown:true`). Verified this does not regress
`merge-quarantine-dual-key-persistence-43cf3b26.mjs`'s own `plural-only-no-scalar` scenario — that
scenario's own record carries `provenanceTracked: true`, so it never reaches the generalized gate at all
(short-circuits earlier, at the `provenanceTracked` check); all 12 of that file's scenarios re-confirmed
green, unaffected. `pnpm --filter @loom/daemon negative-control --file
packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-unknown-provenance-array-only-150aed7b.mjs --test
packages/daemon/test/merge-quarantine-dual-key-persistence-43cf3b26.mjs` proves RED (reverted to `HEAD`
— the array-only scenario fails, the 43cf3b26 suite unaffected in both phases) → GREEN (restored) →
byte-identical clean tree.

### CR follow-up (same card) — precision/coverage, and a text-side asymmetry

**Six more scenarios** added to the array-only test (8 total): `provenance-tracked-array-only-unaffected`
and `single-token-array-only-unaffected` (the precision guard and the one-token guard both still apply to
an array-only record, not just the scalar case); `self-ref-scalar-plus-foreign-plural-flagged` (a scalar
that hashes to its OWN physical file — i.e. would NEVER trip the old scalar-only check alone — paired
with a genuinely foreign plural key; the foreign key, not the scalar, must still trip detection);
`array-only-pass1b-tmp-residue` and `array-only-safety-tmp` (the OTHER two call sites sharing the
identical scalar/plural raw-JSON parse pattern, confirmed directly — a bare `.json.tmp-<n>` or
`.json.tmp-safety-<n>-<hex>` residue with no `.json` final, since `hashToRepo` is always empty in this
suite and can never make either site's own "stale, skip" branch fire).

**A separate, real bug this round surfaced: the remediation TEXT still named only the scalar
`resolvedKey`**, never any plural key — `AmbiguousIdentities.unknownProvenanceKeyPath` (singular) was
computed as `absoluteKeyPathOrUndefined(entry.resolvedKey)` at its two construction sites
(`ambiguousIdentitiesFor`, `ambiguousIdentitiesForLatchId`) and ad hoc at a third (the pending-tier
refusal in `clearMergeQuarantineLatchFile`). This gave FALSE text for an array-only record ("resolvedKey
is not recorded... no further repo to name" even when a real foreign key sat in `resolvedKeys`) and named
the WRONG repo for a self-referencing scalar (naming the entry's own key, which is never foreign, instead
of a genuinely foreign plural key sitting right next to it).

**THE FIX:** `unknownProvenanceKeyPathsFor(entry, ownKey?)` — ONE shared helper, used at all three sites
— returns every one of `entry`'s own `informativeKeysFor` OTHER than `ownKey` (via
`secondaryKeysToAttempt`, the SAME per-key exclusion `43cf3b26`'s own boot-time re-arm loop already
uses), filtered to absolute-path-shaped values, deduped. `ownKey` omitted (the pending tier, which has no
single armed key) falls back to every informative key. `AmbiguousIdentities.unknownProvenanceKeyPath`
(singular `string | undefined`) is now `unknownProvenanceKeyPaths` (plural `string[]`);
`remediationTextFor` names every one of them, or falls back to the old "nothing to name" text only when
the array is genuinely empty.

**A real regression caught in the same round, before it ever reached a committed state:** the first draft
named the array via `JSON.stringify(ambiguous.unknownProvenanceKeyPaths)` — `JSON.stringify` DOUBLES every
backslash in a Windows path, so the embedded text no longer byte-matched the real path string.
`merge-quarantine-runtime-union-provenance.mjs`'s own `48bda567-migrate-union-drops-dual-arm-b-older`
scenario (a pre-existing, unrelated test asserting `refusal.reason.toLowerCase().includes(w.toLowerCase())`)
caught this immediately on a full re-run. Fixed by joining with plain single-quotes
(`.map((p) => \`'${p}'\`).join(", ")`) — the SAME convention `contributorRepoPaths`' own clause already
uses — never `JSON.stringify` a path destined for an exact-text match.

**Tests:** the self-ref and pure-array-only scenarios each also drive a real
`clearMergeQuarantineLatchFile` refusal and assert the refusal text names the foreign key (never the
self-reference, never the old "nothing to name" fallback). `pnpm --filter @loom/daemon negative-control
--file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-unknown-provenance-array-only-150aed7b.mjs --ref 3a9e0027` proves
5 of 8 scenarios RED (every one that depends on either the generalized detection or the text fix) →
GREEN (restored) → byte-identical clean tree. `merge-quarantine-runtime-union-provenance.mjs` and
`merge-quarantine-unknown-provenance.mjs` re-confirmed green after the backslash fix.
