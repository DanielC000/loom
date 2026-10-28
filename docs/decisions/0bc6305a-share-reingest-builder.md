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

No other difference was found — every field assignment in the returned object (`tokens`, `resolvedKey`,
`resolvedKeys`, `armedKeys`, `orphanLatchFiles`, `contributorRepoPaths`, `reducedContributorRepoPaths`,
`provenanceUnknown`, `provenanceTracked`, `genuineContributorKeys`) used the identical expression shape in
both twins once the three parameters above are accounted for.

## Field-set proof (before/after, both twins)

A throwaway harness (`$LOOM_SCRATCH_DIR`, never committed) drove both call sites against the same two
fixtures — one through `reconcileMarkedBasenameBeforeWrite`'s reingest arm (marked basename, armed write),
one through `reconcileClearedEntryIfPlaceholder` (identity-wide human clear of a still-placeholder entry)
— capturing the full returned object's key/value set immediately before this refactor (`git stash`-free:
a temporary single-line revert of the two call sites back to their original inline bodies, built, run,
restored) and immediately after. Diff: **none** — every key and every value, including array ORDER inside
`tokens`/`resolvedKeys`/`orphanLatchFiles`/`contributorRepoPaths`, matched exactly for both twins.

## Do not

- Do not reimplement this build inline at a third call site — route through
  `buildReingestedEntryFromDisk`, passing `NO_DROPS` when the caller has nothing of its own to subtract.
- Do not assume `callerLabel` can be dropped as "just use `arguments.callee.name`" or similarly derived —
  it must stay an explicit parameter since the two callers' own literal strings predate this refactor and
  are preserved verbatim for continuity of the existing `43cf3b26` cap-eviction log line's wording.
- Do not fold the pre-build gating (read/parse/identity/placeholder-shape checks, or
  `reconcileMarkedBasenameBeforeWrite`'s own `"unreadable"` sentinel) into this helper — that part
  genuinely differs between the two callers and must stay separate, per the analysis above.

## Verification

- `pnpm build` clean.
- Full quarantine corpus (`packages/daemon/test/merge-quarantine*.mjs`) green under both
  `env -u LOOM_DEV` and `LOOM_DEV=1`, run in foreground chunks, one lane — see the worker report for the
  per-chunk pass/fail counts.
- `pnpm --filter @loom/daemon guards` green after committing.
