# 0bc6305a — one shared helper builds a placeholder reingest for both twins

From `84c1046f`'s own Code Review (session `690b1e0d`), a Minor finding: `merge-quarantine.ts` had two
near-duplicate bodies that rebuild a `MergeQuarantineEntry` from the genuine on-disk record —
`reconcileMarkedBasenameBeforeWrite`'s reingest arm and `reconcileClearedEntryIfPlaceholder`. `84c1046f`'s
own bug was literally drift between them (the clear-side twin carried the 3-field contributor/orphan
union, the write-side twin didn't, at the time); both also omitted `provenanceTracked` until `84c1046f`
fixed it in both, independently, by hand.

## What's actually shared vs. what genuinely differs

Read both bodies field-by-field before unifying (per this card's own instruction to STOP and report any
real behavioural difference rather than paper over it):

- **The gating BEFORE the build genuinely differs and stays separate in each caller.**
  `reconcileMarkedBasenameBeforeWrite` distinguishes a corrupt-but-unreadable-right-now file via its own
  `"unreadable"` sentinel (ENOENT/EISDIR return `entry` unchanged, any other read failure returns the
  string `"unreadable"`); `reconcileClearedEntryIfPlaceholder` has no such sentinel — every read/parse
  failure there returns `entry` unchanged. Unifying this would change the write-side caller's refusal
  behavior, so it was NOT touched.
- **The actual BUILD — once gating has already confirmed `entry` is a bare placeholder and `parsed` is
  genuine same-identity content — was byte-for-byte identical modulo three parameters**, extracted into
  the new shared `buildReingestedEntryFromDisk(final, entry, parsed, dropped, ownershipMap, callerLabel)`:
  - `dropped: DroppedSets` — the write-side twin filtered `tokens`/`orphanLatchFiles`/`contributorRepoPaths`
    through its caller's own `dropped` sets after each union; the clear-side twin had no such parameter and
    never filtered. `reconcileClearedEntryIfPlaceholder` now passes `NO_DROPS` (a no-op filter), which is
    behaviourally identical to its old "don't filter at all" shape.
  - `ownershipMap: ReadonlyMap<string, MergeQuarantineEntry>` — the write-side twin received this as an
    explicit parameter (threaded from its own caller); the clear-side twin read the module-global
    `activeQuarantines` directly inline at its one `positivelyForeignKey` call. `reconcileClearedEntryIfPlaceholder`
    now passes `activeQuarantines` explicitly as the argument — same value, now explicit rather than closed
    over.
  - `callerLabel: string` — forwarded only into `unionResolvedKeysRetaining`'s own diagnostic
    cap-eviction `console.error` line (`${callerLabel} exceeded the ...-key resolvedKeys cap ...`), purely
    cosmetic text identifying which caller tripped the cap. Never read back, never branched on, confirmed
    by reading `unionResolvedKeysRetaining`'s own body. The write-side twin passed the literal string
    `"reconcileMarkedBasenameBeforeWrite-reingest"`; the clear-side twin passed
    `"reconcileClearedEntryIfPlaceholder"`. Both literals are preserved verbatim as the two callers'
    `callerLabel` arguments, so the cap-eviction log line's own wording is unchanged either way.

**Correction (Code Review, this same card): one further value-shape difference was found and is kept,
not reverted — see "orphanLatchFiles/contributorRepoPaths empty-array normalization" below.** Apart from
that one shape, every field assignment in the returned object (`tokens`, `resolvedKey`, `resolvedKeys`,
`armedKeys`, `reducedContributorRepoPaths`, `provenanceUnknown`, `provenanceTracked`,
`genuineContributorKeys`) used the identical expression shape in both twins once the three parameters
above are accounted for.

## orphanLatchFiles/contributorRepoPaths empty-array normalization (Code Review finding)

Before this card, `reconcileClearedEntryIfPlaceholder`'s own inline body computed these two fields as
`entry.X || reingested.X ? [...union] : undefined` — and `[]` is truthy in JS, so whenever either side
was a **defined empty array** (not `undefined`), that condition was still true and the function returned
a defined `[]`, never `undefined`. The shared helper instead always applies
`unioned.length > 0 ? unioned : undefined` (the write-side twin's own pre-existing shape, copied
verbatim) — collapsing an empty union to `undefined` regardless of whether either INPUT side was
`undefined` or a defined `[]`. So for the one input shape "at least one side is a defined, empty array,
and the union is therefore empty," the clear-side twin's OUTPUT changed: `[]` before this card, `undefined`
after.

**Consumer census (why this is being KEPT, not reverted — every read in this file of either field, as of
this card):** every one of them is written defensively against an absent field — `?.includes(...)`,
`?? []`, `?.length`/`.length` (both `undefined?.length` and `[].length` read as falsy/`0`), a `.some(...)`
or `.filter(...)` call chained off `?? []`, or an `X || Y`-style union that already treats `undefined` and
`[]` as interchangeable on its OWN input side. No call site in this file does `X === undefined` or
`Array.isArray(X)` against this ENTRY-level output field to distinguish "never set" from "set to empty"
(the `Array.isArray(parsed.X)` checks elsewhere in this file are PARSE-time validation of raw, untrusted
JSON input, not reads of this field's own prior output, and are unaffected). One shape is better than
two: kept, with this record naming it explicitly and a dedicated regression test
(`merge-quarantine-0bc6305a-clear-side-empty-array-normalization.mjs`) pinning the new, normalized
`undefined` output going forward.

**Real-world reachability:** boot genuinely produces a defined-empty `orphanLatchFiles: []` via a plain
`.filter()` that can empty out an existing array (`merge-quarantine.ts`, the PASS 1 migrate branch and the
safety-tmp recovery branch both strip a just-migrated/soon-deleted self-reference this way) — so this is
not a hypothetical input shape.

## Field-set proof (before/after, both twins)

A throwaway harness (`$LOOM_SCRATCH_DIR`, never committed) drove both call sites against the same two
fixtures — one through `reconcileMarkedBasenameBeforeWrite`'s reingest arm (marked basename, armed write),
one through `reconcileClearedEntryIfPlaceholder` (identity-wide human clear of a still-placeholder entry)
— capturing the full returned object's key/value set immediately before this refactor (`git stash`-free:
a temporary single-line revert of the two call sites back to their original inline bodies, built, run,
restored) and immediately after. Diff: **none** for both fixtures as exercised — but **this harness did
NOT exercise the one input shape that genuinely differs** (either side a defined-empty array for
orphanLatchFiles/contributorRepoPaths on the CLEAR-side twin specifically — see the section above); Code
Review caught that gap by reading the two bodies side-by-side rather than by a harness result, and it is
now closed separately by `merge-quarantine-0bc6305a-clear-side-empty-array-normalization.mjs`, a
committed regression test (not a throwaway harness), proven RED on the pre-this-fix shape and GREEN
after via a temporary same-session revert/rebuild/test/restore cycle. Read this harness's own "Diff: none"
as "none, for every shape this harness's two fixtures happened to construct" — not as a blanket proof of
field-level equivalence across every reachable input shape.

## Do not

- Do not reimplement this build inline at a third call site — route through
  `buildReingestedEntryFromDisk`, passing `NO_DROPS` when the caller has nothing of its own to subtract.
- Do not assume `callerLabel` can be dropped as "just use `arguments.callee.name`" or similarly derived —
  it must stay an explicit parameter since the two callers' own literal strings predate this refactor and
  are preserved verbatim for continuity of the existing `43cf3b26` cap-eviction log line's wording.
- Do not fold the pre-build gating (read/parse/identity/placeholder-shape checks, or
  `reconcileMarkedBasenameBeforeWrite`'s own `"unreadable"` sentinel) into this helper — that part
  genuinely differs between the two callers and must stay separate, per the analysis above.
- Do not "fix" the orphanLatchFiles/contributorRepoPaths empty-array normalization back to the clear-side
  twin's old per-field `X || Y ? [...] : undefined` shape — re-verify the consumer census above first;
  reverting would resurrect the exact two-shapes-for-one-concept drift this card exists to close, for no
  consumer that actually needs the distinction.
- Do not skip the `dropped.contributorRepoPaths.size === 0` fast path's own behavioral-identity
  justification when touching that filter again — it is correct ONLY because filtering against an empty
  `Set` can never remove an element; if a future change makes `dropped.contributorRepoPaths` carry
  meaning beyond pure membership (e.g. a transform), this fast path must be re-justified, not assumed.

## Verification

- `pnpm build` clean.
- Full quarantine corpus (`packages/daemon/test/merge-quarantine*.mjs`) green under both
  `env -u LOOM_DEV` and `LOOM_DEV=1`, run in foreground chunks, one lane — see the worker report for the
  per-chunk pass/fail counts.
- `merge-quarantine-0bc6305a-clear-side-empty-array-normalization.mjs` (new, committed): pins the
  orphanLatchFiles/contributorRepoPaths empty-array normalization above, with a negative control (a
  genuinely non-empty union still survives as a real array) and a mixed-sides scenario (an in-memory
  defined-empty `[]` never short-circuits away disk's own content). Proven RED (3 of 7 checks failing,
  exactly the ones tied to the fix) against a temporary same-session edit simulating the old
  always-return-the-array shape, GREEN after restoring — both via a direct Edit/rebuild/test/restore
  cycle, tree confirmed byte-identical to the fix afterward.
- Re-ran `merge-quarantine-84c1046f-reingest-field-drop.mjs` and
  `merge-quarantine-boot-unreadable-vs-corrupt.mjs` under both `env -u LOOM_DEV` and `LOOM_DEV=1` after
  this round's changes (the contributorRepoPaths fast-path nitpick + the new test) — all green, both
  states.
- `pnpm --filter @loom/daemon guards` green after committing.
