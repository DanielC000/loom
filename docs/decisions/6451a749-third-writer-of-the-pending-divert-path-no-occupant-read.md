# 6451a749 — a THIRD writer of the pending-divert path, with no occupant read at all

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 6451a749 — a THIRD writer of the pending-divert path, with no occupant read at all

The 8a79dd31 Round 2 "Do not" section (above) named exactly two fresh-mint call sites as the ones routed
through `mintPendingDivert`. Code Review `ddb58ffa` of that round found a THIRD writer of the SAME
deterministic `pendingDivertFilenameFor(...)` path that bypassed the chokepoint entirely:
`protectOccupantContentBeforeDelete` (reached from `protectDegradedOccupantBeforeDelete`/
`protectUnincorporatedOccupantBeforeDelete` when a RAISE's own guard-skipped write, `e1cb7d33`, is about
to clobber a foreign/degraded occupant's physical `final` — its job is to copy that occupant's content
aside, durably, before letting the write through). Its only union source was the IN-MEMORY
`pendingUnresolvedQuarantines` lookup (`atFilenameIdx`); it never read whatever currently occupied that
deterministic filename ON DISK, reopening the exact 8a79dd31 bug shape at a third location:

1. **Never-scanned same-identity occupant.** An on-disk record for the SAME identity, physically sitting
   at `pendingDivertFilenameFor(occupantRepoPath)` but never scanned into THIS process's own
   `pendingUnresolvedQuarantines` (e.g. left by an earlier raise's own divert in a DIFFERENT process, or a
   kept-unreadable file), was silently overwritten and its own token destroyed outright — surviving only
   until the next reboot discards it for good.
2. **Collision-file blind spot.** Once an identity's own record had already been diverted to a
   `-collision-` file (because a genuinely different identity occupies the primary `pendingDivertFilenameFor`
   slot — 8a79dd31's own rule), `protectOccupantContentBeforeDelete`'s primary-name-only lookup could
   never find that collision record. The next time this SAME identity was discovered as a foreign degraded
   occupant at some OTHER key's `final`, protect's blind write to the PRIMARY filename destroyed the very
   occupant 8a79dd31's own reconcile had specifically refused to touch there.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios in `merge-quarantine-raise-protect-failure.mjs`, each confirmed RED against
`HEAD` (before any fix) and the fresh-process reboot assertion this card's own DoD required:

- **`6451a749-never-scanned`** — a hand-crafted, same-identity occupant record at
  `pendingDivertFilenameFor(d)`, never scanned into this process's memory, is destroyed by R's own raise
  discovering D as a foreign occupant at R's own key.
- **`6451a749-collision-file`** — D's own record already lives at a `-collision-` file (because `foreign`,
  a genuinely different identity, occupies D's own primary slot); a LATER raise (R2) discovering D as a
  foreign occupant at R2's own key overwrites `foreign`'s own primary file outright.

### Manager's ruling — one shared, generalized chokepoint; carry every field forward; converge collisions

1. **ONE shared occupant-aware helper, generalized from `reconcilePendingDivertTargetBeforeMint`, used by
   BOTH `mintPendingDivert` and `protectOccupantContentBeforeDelete`. No third copy.**
2. **The same-identity union carries tokens AND `orphanLatchFiles`/`contributorRepoPaths`/
   `provenanceUnknown`/`provenanceTracked`, matching `unionQuarantineEntries`**, so
   `protectOccupantContentBeforeDelete`'s own PRE-EXISTING in-memory-match union (which already called
   `unionQuarantineEntries` and so already carried all four fields) is never silently narrowed by routing
   through the generalized helper instead.
3. **Union into an EXISTING same-identity collision file rather than minting a fresh one each time** — the
   collision name's 24-hex prefix is deterministic per identity, so scan `MERGE_QUARANTINE_DIR` for
   `pending-<thatprefix>-collision-*.json` (never a tmp residue), union into the first one that is both
   readable and genuinely the same identity, and mint a fresh collision file only when none qualifies.
   Otherwise repeated collisions against the same foreign primary occupant would proliferate records
   without bound.
4. Widen 8a79dd31's own "Do not" rule (see the edit to that section, above) to cover EVERY writer of
   `pendingDivertFilenameFor`'s own deterministic path, not just a fresh mint.

### The fix

- **`readPendingDivertFileAt(filePath)`** (`merge-quarantine.ts`) — reads a pending-divert filename's own
  CURRENT on-disk content right now and reconstructs a `MergeQuarantineEntry` from it, via the SAME
  explicit field whitelist (`82032b5c`/`db0a9db0`) every other reader of a parsed latch record in this
  module already trusts. Returns `"enoent"` / `"unsafe"` / `{state:"entry", entry}` — the caller decides
  what either non-entry state means for its own write.
- **`unionIntoOnDiskPendingEntry(onDisk, entry)`** — unions via `unionQuarantineEntries` ITSELF (never a
  hand-rolled re-implementation), answering the open question from the card: yes, carry every field
  forward, not just tokens. Normalizes `unionQuarantineEntries`'s own always-an-array `armedKeys` back to
  `undefined` when empty, mirroring `divertRaiseEntry`'s own "never a cosmetic `armedKeys: []`" rule — a
  pending-only record is never armed anywhere.
- **`findExistingSameIdentityCollisionFile(repoPath)`** — scans `MERGE_QUARANTINE_DIR` for an existing
  `-collision-` file sharing `repoPath`'s own deterministic prefix, returning the first one that is both
  readable and genuinely the same identity (sorted for determinism). Never matches a crash-left tmp
  residue (`PENDING_DIVERT_COLLISION_TMP_RE`'s own shape).
- **`reconcilePendingDivertTarget(entry)`** — the renamed, generalized `reconcilePendingDivertTargetBeforeMint`.
  ENOENT → primary, unchanged. Same identity at the primary → union there via
  `unionIntoOnDiskPendingEntry`. Different identity, or unreadable/corrupt/EISDIR/no-repoPath → never
  overwrite, never move — union into an EXISTING same-identity collision file if
  `findExistingSameIdentityCollisionFile` finds one, else mint a brand-new collision filename. Called by
  BOTH `mintPendingDivert` (unchanged call shape, just the new name) and `protectOccupantContentBeforeDelete`
  (new).
- **`protectOccupantContentBeforeDelete`** now builds `toPersist` exactly as before (unchanged field
  carry-forward from `final`'s own parsed content), then calls `reconcilePendingDivertTarget(toPersist)`
  instead of deriving `priorEntry`/`toWrite` from the in-memory `atFilenameIdx` lookup alone. Its own
  `atFilenameIdx`/`atFinalBasenameIdx` in-memory re-pointing logic (keeping a stale boot-time pending
  reference in sync with the new durable bytes) is unchanged in SHAPE, just now computed against the
  RESOLVED `filename` the helper returns rather than the raw, un-reconciled primary name. Its own
  double-fault fallback (the safety write ALSO fails) now unions from `toWrite` — the already-reconciled
  result of a FRESH disk read at `filename`, a file disjoint from `final` — rather than `toPersist` alone;
  `c9114934`'s own "never use `atFinalBasenameIdx`'s own live entry as a union source" rule is untouched
  by this (that rule was never about `toWrite`, which was never derived from it).

### Tests

Three scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`6451a749-never-scanned`** — asserts the never-scanned occupant's own token (AND its own
  branch/reason, proving the field-carry-forward survives, not just tokens) now SURVIVES, unioned at the
  same primary filename, both in-process and across a fresh-process reboot.
- **`6451a749-collision-file`** — asserts the foreign occupant's own primary file stays BYTE-IDENTICAL
  (never overwritten) and its own token survives a fresh-process reboot. The in-process-only assertion
  from the initial repro report was corrected: the foreign occupant's own token was never scanned into
  this process's memory by construction (the whole point of the fixture), so `listActiveMergeQuarantines()`
  — a purely in-memory read — was never going to report it either before or after the fix; the
  byte-identical and reboot checks are what actually discriminate.
- **`6451a749-collision-reuse`** (manager's own point 3) — two INDEPENDENT degraded records for ONE
  identity X, discovered via two separate resolvable repos' own clears, each reach
  `protectOccupantContentBeforeDelete`. Asserts exactly ONE collision file exists for X's own identity
  after both (never two), that one file carries BOTH tokens, and both survive a fresh-process reboot as
  one record. `findExistingSameIdentityCollisionFile` is a pure disk scan with no in-memory dependency, so
  this is exercised identically whether or not the SAME process happened to track the first collision file.

All three proven RED against the pre-fix `protectOccupantContentBeforeDelete` (the `6451a749-never-scanned`/
`6451a749-collision-file` shapes; `6451a749-collision-reuse` exercises the NEW collision-reuse rule, which
did not exist before this round at all) and GREEN after. All 34 `merge-quarantine*.mjs` files re-verified
individually, each exit 0 — including `merge-quarantine-unknown-provenance.mjs`, whose own
`withDistMutation` anchor text (`PROTECT_WHITELIST_LINE`) hard-coded the exact line that used to follow
`protectOccupantContentBeforeDelete`'s own field-whitelist block (`const filename =
pendingDivertFilenameFor(occupantRepoPath);`) — moved by this card's own refactor to `const finalBasename
= path.basename(final);` — updated to match, same disambiguating-suffix technique as before (a bare
`provenanceTracked: ...` line alone recurs five times in the compiled file; the multi-line anchor,
ending at whatever line genuinely follows in THIS function, is what makes the match unique). All static
guards (`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF
via the `tr -dc` recipe on every touched file.

### Do not

- Do not let ANY writer of `pendingDivertFilenameFor`'s own deterministic path — a fresh mint, a raise
  diverting away from `final`, OR a copy-aside protecting a foreign/degraded occupant before an
  unconditional unlink — derive its own union source from an in-memory lookup ALONE. Route through
  `reconcilePendingDivertTarget`, which re-reads disk fresh every time; a future fourth writer that
  "just this once" trusts memory reopens this exact bug class a third time. **(Corrected by Round 2
  below)** — the reverse mistake is just as real: a caller holding its own in-memory record (e.g.
  `protectOccupantContentBeforeDelete`'s own `atFilenameIdx` match) must union that record INTO the
  chokepoint's disk-based result too, never let the disk read REPLACE it. The rule is "union every
  source you have — disk AND memory — never let either one substitute for the other."
- Do not union a same-identity on-disk occupant by tokens alone — use `unionQuarantineEntries` itself (or
  thread its own result through, as `unionIntoOnDiskPendingEntry` does), carrying `orphanLatchFiles`/
  `contributorRepoPaths`/`provenanceUnknown`/`provenanceTracked` forward too. A token-only union silently
  narrows `protectOccupantContentBeforeDelete`'s own PRE-EXISTING behavior for the in-memory-match case.
- Do not mint a brand-new collision file for an identity that already has one — scan for an EXISTING
  `-collision-` file matching that identity's own deterministic prefix first
  (`findExistingSameIdentityCollisionFile`), and union into the first readable, genuinely-same-identity
  match. Skipping this lets repeated collisions against one foreign primary occupant proliferate records
  without bound.
- Do not assert a hand-crafted occupant's own token appears in `listActiveMergeQuarantines()` (a purely
  in-memory read) when that occupant was deliberately constructed to be "never scanned into memory" — it
  never will be, before OR after any fix, and the assertion is vacuous in both directions. Assert the
  on-disk byte-identity and the fresh-process reboot read instead, which actually scans disk.
- Do not hard-code a `withDistMutation`-style anchor string against a specific trailing line of code
  without re-verifying it's still unique and still present after any refactor touching that function — a
  renamed/moved line silently drops the match count to zero (a loud failure here, but only because this
  module's own `withDistMutation` throws on a non-1 occurrence count; a less careful mutation harness
  could instead match the WRONG site silently).

## Round 2 (Code Review `45c8250c`) — NOT SHIP: Round 1's own "go through the shared helper" ruling quietly REPLACED the in-memory union source instead of ADDING to it

CR `45c8250c` found Round 1's own fix to be a Critical fail-open regression, reproduced, plus one Minor
and two test gaps. The Lead's own ruling (Round 1, above) is partly to blame: "route through one shared,
occupant-aware chokepoint" was correct, but the chokepoint itself only ever reads DISK — it was never
meant to also BE the in-memory union source, and Round 1's own implementation of
`protectOccupantContentBeforeDelete` wired it that way anyway, deleting the pre-existing in-memory lookup
entirely rather than keeping it as a second, additive source.

### CRITICAL — the disk-only chokepoint union silently dropped tokens an in-memory record already held

`protectOccupantContentBeforeDelete`'s Round 1 code computed `toWrite` ENTIRELY from
`reconcilePendingDivertTarget`'s own disk read, then OVERWROTE the in-memory record at `atFilenameIdx`
with that disk-only object. An in-memory pending record can legitimately hold MORE tokens than its own
physical backing file right now — an EARLIER durable write for the SAME identity already failed, leaving
it "quarantined IN THIS PROCESS ONLY" (`mergeTokenIntoPendingEntries`'s own failed-rewrite branch has NO
safety-tmp fallback at all; `mintPendingDivert`'s own triple fault is the analogous shape for a fresh
mint). Replacing that richer in-memory object with the disk-only union silently ERASED the extra tokens
from memory too — not merely failed to add them — so the identity they protected was UNBLOCKED, both
in-process and after a reboot: the exact fail-open this whole card exists to prevent, reintroduced by its
own Round 1 fix.

**The CR's own repro:** raise unresolvable D (`tD1` → mints `pending-<hash>.json`); raise D again with
`fs.openSync` failing on that same file (`tD2` is unioned into memory by `mergeTokenIntoPendingEntries`,
but its own rewrite fails with no safety-tmp fallback — `tD2` survives ONLY in memory, at the pending
entry's own pre-existing `sourceFile`); plant D's own degraded record at R's own key's `final` (same
"degraded occupant" shape every scenario in this file uses); R raises, reaching
`protectOccupantContentBeforeDelete` for D. Pre-fix: the in-memory re-point overwrites memory with the
disk-only union (`tD1` + R's own current token) — `tD2` is gone, from memory AND disk, permanently.

### The fix

Union ALL THREE sources, never just the chokepoint's own disk read: the fresh disk read (inside
`reconcilePendingDivertTarget`, unchanged) ∪ the in-memory record already tracked at `atFilenameIdx`
(still safe to read — `c9114934` forbids only `atFinalBasenameIdx`, a DIFFERENT lookup, as a union source;
that rule is untouched) ∪ `toPersist` (also already folded into the disk read). Concretely:
`protectOccupantContentBeforeDelete` now computes `atFilenameIdx`/`atFinalBasenameIdx` against the
chokepoint's own resolved `filename` (as Round 1 already did), then — when `atFilenameIdx >= 0` — unions
the in-memory record there into the chokepoint's own disk-reconciled result via `unionQuarantineEntries`,
and uses THAT as `toWrite` for both the write and the in-memory re-point. When no in-memory record exists
at `filename` (the common case — nothing to add), `toWrite` is exactly the chokepoint's own result,
unchanged from Round 1.

This is NOT scoped to the primary-filename case alone: the same fold applies uniformly whether
`reconcilePendingDivertTarget` resolved to the primary filename, an EXISTING reused collision file, or a
brand-new one — an in-memory record can in principle be stranded at any of those names, and the fold
doesn't need to know which case it is.

### Minor — the double-fault `kept` fallback must not borrow a foreign `orphanLatchFiles` reference

Round 1's own double-fault branch (the CHOSEN write, to `filename`, ALSO fails) built `kept` by spreading
the newly-folded `toWrite` wholesale, including its `orphanLatchFiles`. Those file references can belong
to WHATEVER OTHER record lives at `filename` — the on-disk occupant the chokepoint unioned in, or (after
the CRITICAL fix above) the folded-in in-memory record — never to `kept` itself, which is self-owned at
`finalBasename`, a DIFFERENT physical file. Carrying them forward risks a LATER clear of `kept` sweeping a
file that other record still legitimately references, destroying content `kept` never owned.

**The fix:** `kept`'s own `orphanLatchFiles` is sourced from `toPersist` alone — `final`'s own parsed
content, which genuinely belongs to `kept`'s own lineage — plus the `finalBasename` self-reference, exactly
as every prior round of this card (`c9114934`, `4900c365`) already established for this branch. Tokens
still carry forward from the folded `toWrite` (fail-closed): only the file-reference field is scoped.
Reachable and pinned directly (see Tests) — not merely a theoretical risk.

### Test gaps — the MINT path's own collision reuse, and a negative control for it

Round 1's only test of the collision-reuse rule (`6451a749-collision-reuse`) drove it exclusively through
`protectOccupantContentBeforeDelete`. `mintPendingDivert` — the OTHER caller of
`reconcilePendingDivertTarget`, reached from a fresh RAISE rather than a copy-aside — was never exercised
against an EXISTING same-identity collision file at all. Separately, nothing proved that
`findExistingSameIdentityCollisionFile`'s own scan correctly SKIPS a collision-suffixed file that happens
to sit at the right deterministic prefix but names a genuinely DIFFERENT identity (8a79dd31's own
"different identity → never reuse, mint fresh" rule, now applied to the collision slot itself, not just
the primary one).

### Tests

Four scenarios added to `merge-quarantine-raise-protect-failure.mjs`:
- **`6451a749-inmemory`** — the CR's own CRITICAL repro, verbatim. Asserts D's own second token (held in
  memory only before R's raise) is now durably written to disk, still tracked in-process, and survives a
  fresh-process reboot — alongside D's first token, D's own newly-discovered current token, and R's own
  token, all four as one record.
- **`6451a749-double-fault-orphan-scope`** — the Minor's own repro: D's pre-existing pending record
  already carries a genuine orphan reference; R's raise forces the chosen write to fail (double fault).
  Asserts `kept` carries BOTH tokens forward (fail-closed) but does NOT inherit the foreign orphan
  reference, that `kept` DOES self-reference `final`'s own basename, and that the foreign orphan file
  itself is untouched on disk throughout.
- **`6451a749-mint-reuse`** — the first test-gap closure: an identity's own collision file, hand-crafted
  and never scanned into memory (mirroring 8a79dd31-fresh-divert's own setup, now at the collision slot),
  is correctly found and unioned into by a fresh RAISE reaching `mintPendingDivert` directly — never
  `protectOccupantContentBeforeDelete`. Asserts exactly one collision file survives, carrying both tokens,
  across a fresh-process reboot.
- **`6451a749-mint-reuse-negative`** — the negative control: a collision-suffixed file sits at the right
  deterministic prefix for identity X, but its own content names a GENUINELY DIFFERENT identity (a true
  hash-of-identity collision stand-in, same technique `8a79dd31-different-identity-diverts` already uses
  at the primary slot). Asserts the scan correctly skips it (byte-identical afterward, never reused) and
  mints a brand-new, distinct collision file for X instead.

All four scenarios proven RED on commit `b393bafa` (this card's own Round 1 commit) and GREEN after, via
`scripts/negative-control.mjs` — exactly 4 failures in the RED phase (3 from `6451a749-inmemory`, 1 from
`6451a749-double-fault-orphan-scope`'s own orphan-scope assertion), confirming both the CRITICAL and the
Minor are genuinely reachable regressions, not theoretical. The two test-gap scenarios
(`6451a749-mint-reuse`/`-negative`) exercise logic Round 1 already shipped correctly and are GREEN in
both phases — closing the gap in coverage, not a regression proof. All 34 `merge-quarantine*.mjs` files
re-verified individually, each exit 0. All static guards (`pnpm --filter @loom/daemon guards`)
re-verified green (30/30). Line endings re-verified CR==LF via the `tr -dc` recipe.

### Do not

- Do not let a shared chokepoint's own disk-based union REPLACE a caller's separate in-memory union
  source — fold both together. `reconcilePendingDivertTarget` deliberately has NO in-memory awareness
  (by design — `mintPendingDivert`'s own callers never have a competing in-memory record for the identity
  they're minting, by construction); `protectOccupantContentBeforeDelete` is DIFFERENT precisely because
  it CAN be reached with a richer in-memory record already present, and must therefore add its own
  `atFilenameIdx` fold on top, not assume the chokepoint already covers it.
- Do not let a double-fault fallback's own self-owned record inherit `orphanLatchFiles` from whatever OTHER
  record it unioned against — only `orphanLatchFiles` ever carries a FILE reference (never just data), and
  a fallback record living at ITS OWN distinct physical name must never claim ownership of a file some
  OTHER still-live record continues to reference. Tokens and other metadata fields carry forward fine;
  `orphanLatchFiles` is the one field that needs scoping to the fallback's own lineage.
- Do not assume testing a shared helper through ONE of its callers proves both — `mintPendingDivert` and
  `protectOccupantContentBeforeDelete` reach `reconcilePendingDivertTarget` under genuinely different
  in-memory preconditions (the latter can find a stranded in-memory record the former structurally never
  will), so a scenario driving the collision-reuse rule through one caller says nothing about the other.
