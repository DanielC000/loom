# 495fd320 — a `null`-content latch (or orphan) file made two "never throws" helpers throw

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 495fd320 — a `null`-content latch (or orphan) file made two "never throws" helpers throw

A SEPARATE finding from the SAME Code Review `9d6dc6b8` of card `29fe2372` — reproduced by that reviewer,
then independently confirmed by a worker's own hermetic repro before any fix was written. Both
`quarantineFileRepoPathIdentity` and `orphanFileTokensAccountedForByUpdate` (Follow-up `29fe2372` above)
document themselves as fail-closed/"Never throws" — but `JSON.parse("null")` succeeds and returns the
bare value `null`, and every `JSON.parse(raw)` call site in this module only ever guards the PARSE call
itself with a try/catch; nothing guarded the very next `parsed.repoPath`/`parsed.tokens` property read.
That read throws a `TypeError` ("Cannot read properties of null (reading 'repoPath')") for `null`, and
only for `null` — every other top-level JSON value (array, number, string, boolean) is already safe to
property-access, returning `undefined` for a missing field rather than throwing.

### The repro

`R` raises `t1`, `t2` (one entry, two outstanding tokens). `R`'s own final latch file is hand-edited to
fold in an orphan reference `O` via `orphanLatchFiles: [O]`. A fresh boot (PASS 1 never reads an orphan
reference's own content, only a final's) is followed by writing the bare literal `null` into `O`. A
PARTIAL clear (`clearMergeQuarantineByToken(R, t2)`, `t1` remains outstanding) reaches
`rewriteOrphanLatchFilesAfterPartialClear` → `orphanRewriteOwnershipConfirmed` →
`quarantineFileRepoPathIdentity(O)`, which throws. `orphanFileTokensAccountedForByUpdate` has the
identical hole, reached via the same gate's own layer (2) — PRE-FIX, always shadowed by the identity
check above throwing first.

**Effect, worse than a merely-skipped orphan rewrite:** every caller of `clearMergeQuarantineByToken`
inside `packages/daemon/src/git/worktrees.ts` and `git/batch-merge.ts` is an `onTreeDeathSettled` closure,
invoked from inside `git/bounded.ts`'s `rawViaDirectSpawn`/`rawViaWinJobLauncher`, each inside a
`void`'d async IIFE with no surrounding try/catch of its own. The throw escapes as an UNHANDLED
REJECTION, and the `reject(...)` a few lines below it NEVER runs — so the bounded git promise this
callback is nested inside never settles at all. On this Node version (default `--unhandled-rejections`
behavior) that is not merely a hang: it crashes the whole daemon process. See the matching bounded.ts
Follow-up in `docs/decisions/24c0bdba-kill-confirm-canonical-merge-commits.md` for that half of the fix.

### The fix

A new shared guard, `isReadableLatchRecord(value): value is Record<string, unknown>` (returns
`typeof value === "object" && value !== null`), placed immediately after EVERY `JSON.parse(raw)` call in
this module whose result then has a property read off it — never only at the two helpers the CR named by
name. Audited and fixed (all reachable from runtime clear/raise/protect paths, never boot-time PASS 1/
1b/safety-tmp — those already wrap the full parse-and-validate block in a try/catch that treats ANY throw,
including this one, as corrupt/fail-closed, by pre-existing design):
`quarantineFileRepoPathIdentity`, `differentUnresolvableOccupantRepoPathAt`,
`unincorporatedOccupantRepoPathAt`, `confirmedDurableBackingElsewhere`, `readFinalOnDiskSurvivingTokens`,
`reconcileMarkedBasenameBeforeWrite`, `markedFinalFullyCoveredByClear`, `protectOccupantContentBeforeDelete`,
`resolveRaiseOverwrite`, `orphanFileTokensAccountedForByUpdate`, `protectForeignTmpResidueBeforeSweep`.

A guarded `isReadableLatchRecord(parsed) === false` is treated exactly like the pre-existing
corrupt-JSON catch branch at each site (return the same fallback that branch already returns) — never a
new, differently-shaped outcome. `rewriteOrphanLatchFilesAfterPartialClear`'s own pre-existing
fail-closed logging (`"keeping ${orphanFile} UNTOUCHED (left stale)..."`) now fires for a `null`-content
orphan exactly as it already did for genuinely corrupt JSON, rather than throwing.

### Round 2 (Code Review `a45e4011`) — a documentation gap, not a code defect

The CR confirmed the production code correct and complete at all 11 sites, all 3 `git/bounded.ts` settle
call sites, and the crash claim — but found this record's own first-draft wording overclaimed. `isReadableLatchRecord`
excludes `null` (the only value that THROWS on property access) but, since its check is
`typeof value === "object"`, it ALSO rejects a bare scalar (number/string/boolean) — never a throw risk,
but a REAL, separate behavior change at exactly the two sites that read on-disk tokens with no OTHER
check ahead of it: `markedFinalFullyCoveredByClear` and `orphanFileTokensAccountedForByUpdate`. A latch
whose content used to be a bare scalar made `readSurvivingOnDiskTokens` return an empty token array,
which both callers' own `.every(...)` then read as VACUOUSLY covered/accounted-for (fail-OPEN) — now
rejected before that reader is ever reached, so both instead return "cannot prove this" (fail-CLOSED,
strictly safer, never a regression — just not something to leave undocumented as a side effect of the
null-crash fix). Every OTHER guarded site already had its own `typeof parsed.repoPath === "string"`
check ahead of any token read, which a scalar already failed identically before this guard existed, so
those nine sites see no behavior change at all; an array or `{}` passes unchanged everywhere, pre- and
post-fix. `isReadableLatchRecord`'s own doc comment (merge-quarantine.ts) and both affected functions'
own `@decision 495fd320` notes now state this precisely, and the test file's header does too. No source
behavior changed in round 2 — only documentation.

### Tests

`test/merge-quarantine-null-latch-guard.mjs` (new file — this bug's own concern is orthogonal to this
card's own `-raise-protect-failure.mjs` home, so it gets its own): the repro above, plus a second orphan
reference `O-valid` on the SAME record (same identity, tokens a subset of `R`'s own) listed FIRST-after
`O-null` in `orphanLatchFiles`, proving `O-null`'s own poison never aborts the REST of the per-file loop
— `O-valid` still gets durably rewritten to the reduced token set. A negative control repeats the same
shape with genuinely corrupt (unparsable) JSON instead of `null`, proving the new guard changes nothing
for the case that already worked. Proven RED via `scripts/negative-control.mjs --ref 43a65f27` (absolute,
pre-fix) and GREEN after, tree restored byte-identical.

All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green.

### Do not

- Do not guard only the two helpers the Code Review named by name — audit EVERY `JSON.parse(raw)` site in
  this module whose result feeds a subsequent property read; this card found nine further ones with the
  identical hole (`differentUnresolvableOccupantRepoPathAt`, `unincorporatedOccupantRepoPathAt`,
  `confirmedDurableBackingElsewhere`, `readFinalOnDiskSurvivingTokens`, `reconcileMarkedBasenameBeforeWrite`,
  `markedFinalFullyCoveredByClear`, `protectOccupantContentBeforeDelete`, `resolveRaiseOverwrite`,
  `protectForeignTmpResidueBeforeSweep`) that the CR's own report never named.
- Do not add the guard to the boot-time PASS 1/1b/safety-tmp recovery loops (`reenterMergeQuarantinesAtBoot`'s
  three inline parsers around lines ~4094/4335/4465) — those already wrap their own full parse-and-validate
  block in a try/catch that treats ANY throw (this one included) as corrupt/fail-closed; adding a second,
  redundant guard there is dead code, not a fix.
- Do not harden `readSurvivingOnDiskTokens` (the shared on-disk-token chokepoint, `7a7e041b`) itself
  instead of its callers — every call site that could pass it a `null` already returns before reaching it,
  once ITS OWN `typeof parsed.repoPath` guard (or, for the two sites with no such guard —
  `readFinalOnDiskSurvivingTokens`/`orphanFileTokensAccountedForByUpdate` — the new
  `isReadableLatchRecord` check directly) is in place; a second guard inside the chokepoint itself would be
  an unreachable, unverifiable duplicate of the real fix.
- Do not describe `isReadableLatchRecord` as excluding only `null` — it excludes every non-object JSON
  value, which includes a scalar too; say so explicitly, and name the two sites
  (`markedFinalFullyCoveredByClear`, `orphanFileTokensAccountedForByUpdate`) where that incidental
  exclusion is an actual fail-open→fail-closed behavior change, not merely a crash fix (round 2).
