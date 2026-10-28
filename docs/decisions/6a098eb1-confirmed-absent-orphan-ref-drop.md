# 6a098eb1 — why a boot-time `orphanLatchFiles` drop on file ABSENCE ALONE is unsafe

Follow-up from the Code Review of `da716192` (reviewer `a9a0bbf8`, finding #2): `da716192`'s own
cross-key strip only ever subtracts `allMigratingSources` — a basename that is NEITHER migrating this
boot NOR exists on disk any more (superseded by some EARLIER boot this one never observed) was only ever
LOGGED (`warnDanglingOrphanRefsNotMigratingThisBoot`, "...so nothing strips it"), never stripped.

This card implemented the strip, verified it against the card's own narrow named repro (boot 3 of
`cross-key-strip-degraded-and-pending-bystanders`), then found — by running the FULL `merge-quarantine*.mjs`
corpus, not just the one scenario — that it breaks at least 8 pre-existing, already-reviewed test files.
**The fix was reverted.** This record is kept as the reasoning for why, so the next person who reaches for
"just drop it if it's not on disk" does not have to re-derive this from scratch. The actual follow-up is
card `5669cb78` — a provenance-based tombstone of PHASE-3-retired basenames, never a bare absence check.

## The core problem

A cold `fs.stat` on a basename tells you only one bit: does something exist at this path RIGHT NOW. It
cannot tell apart:
- **Genuinely stale** — this basename WAS a real file, referenced legitimately, and was later deleted by
  an earlier boot's own PHASE 3 (the card's own boot-3 repro: O was a real migrate source, deleted at
  boot 2, and a bystander's reference to it survives unstripped into boot 3).
- **A legitimate FORWARD reference** — this basename names a file some OTHER write (not yet run) is about
  to create, and the reference was durably persisted (by a real production fold, or — demonstrably — by
  an established test-fixture technique used across this corpus) BEFORE that write ever ran.

Both produce the exact same observable state at the moment `reenterMergeQuarantinesAtBootImpl` reads it:
a reference naming a file that is not currently on disk. There is no third signal available from a cold
boot read that distinguishes them — no timestamp, no tombstone, no "this was once real" marker survives
in the data this function has access to.

## The producer enumeration (from the original approval's "Addition 1")

Every site in `merge-quarantine.ts` that adds a genuinely NEW basename to some entry's own
`orphanLatchFiles` (not a pure pass-through union of an ALREADY-EXISTING `orphanLatchFiles` field from one
entry into another), classified as:

- **(a)** names a real file in `MERGE_QUARANTINE_DIR` at the time it is added, confirmed by construction.
- **(b)** can legitimately be absent while still meaningful at add time, or becomes legitimately absent
  later without anything else ever stripping it.

| Site | Added value | Class | Why |
|---|---|---|---|
| `writeSafetyTmpResidueAtHash` (`selfReference:true`) | `path.basename(tmp)` | (a) | Self-reference to the tmp this SAME call just wrote+fsync'd. Excluded from any future drop by the EXISTING `fd189d91` strip-on-next-read (two call sites in the main PASS1 read loop and the safety-tmp recovery loop), not by anything this card touched. |
| Phase 0 pending-protection (`protectiveSourceFile`) | same pattern | (a) | Same self-ref lifecycle as above. |
| `divertUnreadableBootLatch` and every boot-time fold-on-read/unlink/write-failure push | `f` | (a) | `f` is the exact file whose read/unlink/write JUST failed with a genuine non-ENOENT errno, or whose content is confirmed corrupt/present. |
| `writePendingDivertFile`'s collision-divert fold (`filename`) | `filename` | (a) | Added only when a fresh read of `filename` just confirmed it unreadable/corrupt/a different identity — all three confirm presence. |
| `writePendingDivertFile`'s write-failure self-ref (`finalBasename`) | `finalBasename` | (a) | `final` is the path this whole function started with — it currently holds something. |
| `mintPendingDivert`/`divertRaiseEntry`'s double-fault safety-tmp fallback (`safetyTmpBasename`) | `safetyTmpBasename` | (a), self-ref, same exclusion as the two self-ref rows above. |
| `divertRaiseEntry`'s double-fault fallback, ALSO folding `base.sourceFile` | `base.sourceFile` | (b), NOT excluded, intentionally droppable LATER | Added, then `sweepOwnLatchFileUnlessOwnedElsewhere(base.sourceFile)` deletes it moments later by design. Becomes stale on a LATER boot — exactly the shape a provenance-based fix (5669cb78) would need to track, not something a bare absence check can safely drop. |
| `consumeMatchedPendingsIntoArmedEntry`'s `ownSourceFiles`/`otherSourceFiles`/`failedToDelete`/`toFold` | various `p.sourceFile`s, or files whose unlink/write just failed | (a) | Traced to a real on-disk file at add time, in every PRODUCTION call path I found. |
| PHASE 1b's degraded-occupant fold (`sources`) | migrate `sources` | (a), already excluded via `allMigratingSources.has(f)` | Never deleted while degraded-occupied; tracked until a human clears the occupant. |
| PHASE 3's own unlink-failure folds, and the end-of-boot safety-tmp-recovery fold | `f` / failed basenames | (a) | Unlink/write JUST failed — still present. |
| PASS 2's orphan broadcast (`orphanFilenames`) | `orphanFilenames` | (a) at broadcast; (b) once a human eventually clears them | Real, unmatched-corrupt files discovered via `readdirSync` THIS boot. |
| `testOnlyInjectUnprotectedPending` | an arbitrary caller-supplied `sourceFile` | (b), excluded explicitly by the pre-existing `p.sourceFile` self-reference guard | "A disk layout no real (post-fix) code path can produce" (its own doc comment). |

**This enumeration found NO production site that durably persists an `orphanLatchFiles` reference BEFORE
its target file exists.** Every production ADD site confirms the referenced file's presence at the
moment it is recorded. That conclusion is now directly CONTESTED by two test files' own doc comments (see
below) — stated here as an open question, not resolved, because I have no way to adjudicate a
disagreement between my own reading of this module's production code paths and another author's stated
belief about what they stand in for.

## The 8 forward-reference fixtures that broke

Running the full `merge-quarantine*.mjs` corpus (not just the one scenario this card's own repro lives in)
surfaced 8 pre-existing, previously-green files that construct the EXACT ambiguous shape above on purpose,
as an established, cross-file test-fixture technique: write an entry's real final to disk with an
`orphanLatchFiles` reference to a basename that does not exist yet, boot ONCE to load that entry into
memory with the reference intact, THEN create the referenced file, THEN exercise the real runtime
behavior under test (a partial clear, a rewrite, a reconcile) via a non-boot call.

- **`merge-quarantine-orphan-sweep-content-aware.mjs:107-116`** — states it OUT LOUD: *"O's basename is
  picked now but the FILE is written only AFTER the reboot below — it genuinely does not exist yet, so
  this boot's own PASS 1/PASS 2 orphan handling never reads or arms it at all... Hand-edit A's own final
  JSON to name O in its own orphanLatchFiles — standing in for a REAL PRODUCTION FOLD whose own durable
  write of that reference landed before O itself ever existed (same technique
  merge-quarantine-round2-pins.mjs SITE 1 documents)."*
- **`merge-quarantine-round2-pins.mjs:102-127`** (SITE 1, "orphan-kept-mark-blocks-rewrite") — *"A's own
  real final JSON is hand-edited to list a SEPARATE file (T's own canonical-key final path, never
  actually raised FOR T itself) as an `orphanLatchFile` — a stand-in for the real production path, same
  technique this project's own 29fe2372 scenarios use (merge-quarantine-raise-protect-failure.mjs)."*
  `tFinalBasename` at line 144 IS `T`'s own CURRENT canonical-key hash (`finalBasenameForKey(Kt)`), not a
  stale/legacy one — see "The discriminator that doesn't work" below.
- **`merge-quarantine-raise-protect-failure.mjs:3006-3022`** (`29fe2372-isolate-b`) — `someFile =
  pendingDivertFilenameForTest(x)`, a deterministic `pending-<24hex>.json` name derived from `x`'s own
  identity, written into `x`'s real final's `orphanLatchFiles` at line 3014; comment at line 3022:
  *"Write someFile's content AFTER boot — it was never classified by PASS1 at all."*
- **`merge-quarantine-null-latch-guard.mjs:106-114`** — *"Neither orphan file exists on disk yet at this
  point... both are created only AFTER the boot, below, exactly like the card's own repro sequence."*
- **`merge-quarantine-58957b1e-armed-latch-stale-mark-union.mjs:145,152-160`** — `parkAt` writes W's real
  final with `orphanLatchFiles: [pSourceFile]` at line 145; `pSourceFile`'s own backing file
  (`pPath`/`k2FinalPath`) is written only at lines 158-160, AFTER the boot call (line 155) that arms W
  from disk — comment at line 156: *"NOW write P's own real backing files, AFTER both boot calls already
  ran."*
- **`merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs:469-472`** — `pReduceSourceFile =
  "pending-c93e-rtu-preduce-test.json"`; comment at line 472: *"W's own real file, written with
  orphanLatchFiles naming P-reduce's own sourceFile UP FRONT"* — before P-reduce's own pending record is
  ever constructed.
- **`merge-quarantine-64119847-tied-twin-private-tokens.mjs:163-168`** (scenario 2,
  `64119847-orphanref-private-token-survives`) — `orphanFile = "custom-orphan-64119847-s2.json"`;
  `parkWAt` writes W's real final naming it; `injectP(..., orphanFile)` makes `orphanFile` a PENDING
  entry's own `sourceFile` via the test-only injection seam — no real file is ever written at that path.
- **`merge-quarantine-clear-by-path.mjs:2435-2444`** (`AL1`) — hand-edits `sub`'s real final to add
  `orphanBasenameAL1` to its `orphanLatchFiles`, reboots to load it (line 2439: *"reload so the hand-edited
  orphanLatchFiles reaches memory"*), then writes the orphan file's content — comment at line 2443:
  *"foreign occupant, written AFTER boot."*

## The discriminator that doesn't work

The first idea tried, before reverting: only drop a confirmed-absent reference when the basename does
NOT match any CURRENTLY REGISTERED repo's own canonical key (`hashToRepo`, already built at the top of
this function) — i.e., only drop a basename that isn't "something this repo would use if it ever raised."
This fails immediately against the `58957b1e`/`c93e9e7a` shape: `pSourceFile`/`pReduceSourceFile` are
SYNTHETIC `pending-<name>.json` strings, not canonical-key hashes of any repo at all, registered or not —
they are PENDING entries' own `sourceFile` identifiers, which an active entry's `orphanLatchFiles`
legitimately cross-references as a "tie" (the same mechanism `tiedViaKeyOrOrphanRef` reads elsewhere in
this module). A discriminator keyed on "is this a registered repo's canonical hash" has nothing to say
about a tie to a pending twin that simply hasn't been (re-)written yet. No other discriminator derivable
from the CURRENT disk/memory state at boot time was found that separates the two cases either — see "The
core problem" above for why this is more than a missed heuristic.

## Open question — do not treat as decided either way

Two of the eight fixtures (`orphan-sweep-content-aware.mjs`, `round2-pins.mjs`) explicitly assert, in
their own authored comments, that the shape they construct is *"a stand-in for the real production
path"* / *"a real production fold whose own durable write of that reference landed before [the target]
itself ever existed."* My own enumeration above found NO such production site — every real ADD site I
could trace confirms the referenced file's presence at add time. This disagreement is unresolved. It is
possible the test comments describe a production path that exists but wasn't found by this enumeration
(a site missed, or a cross-process/cross-boot interaction not visible from reading this one file in
isolation); it is also possible the comments describe an aspirational "defensive against a shape we
believe COULD happen" rather than a verified-reachable one. Either way: **do not resolve this by
assertion in either direction** without first finding (or definitively ruling out) the actual production
call site.

## Do not

- Do not drop an `orphanLatchFiles` reference on file absence alone, at boot or anywhere else in this
  module — a cold `fs.stat`/`fs.existsSync` cannot distinguish a genuinely stale reference from a
  legitimate forward reference to a file a separate write is about to create, and at least 8 existing
  test fixtures (two claiming a production analogue) rely on exactly that forward-reference shape
  surviving a boot untouched.
- Do not trust "this basename isn't any registered repo's own canonical key" as a safe discriminator for
  dropping — a PENDING entry's own synthetic `sourceFile` (never a canonical hash) is just as legitimate a
  forward-reference target as a registered repo's not-yet-written final; `58957b1e`/`c93e9e7a` demonstrate
  this directly.
- Do not re-attempt a general "confirmed absent ⇒ drop" fix for this residual without first landing some
  form of PROVENANCE tracking (e.g., card `5669cb78`'s own proposed tombstone of PHASE-3-retired
  basenames specifically) — absence alone is not, and cannot become, a sufficient signal.
- Do not run only the one scenario a card's own repro lives in before trusting a fix in this file — the
  full `merge-quarantine*.mjs` corpus is where this card's own regression actually surfaced; the single
  targeted scenario stayed green throughout.
