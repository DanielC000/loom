# 8a79dd31 — the fresh-divert write itself had no occupant read, at EITHER of its two call sites

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 8a79dd31 — the fresh-divert write itself had no occupant read, at EITHER of its two call sites

The 29fe2372 card's own "Do not" section (above) flagged this as explicitly OUT of its own scope:
`divertRaiseEntry`'s `indices.length === 0` branch and `enterMergeQuarantine`'s own direct unresolvable
brand-new-divert branch both called `writePendingDivertFile(pendingDivertFilenameFor(repoPath), entry)`
with ZERO read of whatever currently occupies that deterministic filename first — `writePendingDivertFile`'s
own jsdoc states plainly it has "no degraded-occupant guard". If that file is currently another live
record's own latch for the SAME identity (e.g. a same-identity record's file left behind by a failed
graduation write, or a kept-unreadable file), its tokens were silently destroyed, with zero in-memory
signal, surviving only until the next reboot discards them for good — a FAIL-OPEN.

### The repro (first reported `blocked`, before any production edit)

Two hermetic scenarios in `merge-quarantine-raise-protect-failure.mjs`, each hand-crafting an independent
occupant record at `pendingDivertFilenameFor(identity)` that THIS PROCESS's own in-memory
`pendingUnresolvedQuarantines` never scanned (standing in for the card's own "left behind by a failed
graduation write, or a kept-unreadable file" shape — `collectPendingIndices` matches only by object
presence in that array, never by reading the directory, so an out-of-band file reaches
`indices.length === 0` / `pendingIndices.length === 0` exactly the same way):
- **`8a79dd31-fresh-divert`** — `enterMergeQuarantine`'s own direct unresolvable brand-new-divert branch.
- **`8a79dd31-divert-raise-entry`** — `divertRaiseEntry`'s own `indices.length === 0` branch, reached via
  `resolveRaiseOverwrite`'s `mustDivert` decision at the OTHER named call site.

Both proven RED on `HEAD` at report time (the occupant's own content, and token, destroyed outright,
confirmed gone after a fresh-process reboot with no clear ever issued) before any fix was written.

### Manager's ruling — route through ONE chokepoint first, then fix it there

A duplicated writer is exactly the divergence this module keeps paying for: `enterMergeQuarantine`'s own
brand-new-unresolvable branch carried an INLINE copy of `divertRaiseEntry`'s own `indices.length === 0`
mint logic, rather than calling through it.

**Step A (refactor-only, commit `da810900`):** extracted the shared mint logic into `mintPendingDivert`,
called by both `divertRaiseEntry`'s own branch and `enterMergeQuarantine`'s own branch. Verified
behaviour-preserving via a direct A/B: with ONLY the hoist applied (no occupant-check yet), the 323
pre-existing checks in `merge-quarantine-raise-protect-failure.mjs` stayed green and the 4 new 8a79dd31
checks stayed RED, byte-identical to the pre-refactor baseline. Incidentally, this consolidation also gave
`enterMergeQuarantine`'s own call site the double-fault safety-tmp fallback (`attemptDivertSafetyTmpFallback`)
it had never had — its own prior inline copy omitted it entirely.

**Step B (the fix, inside that one chokepoint):** `reconcilePendingDivertTargetBeforeMint(entry)`, called
by `mintPendingDivert` before ever writing — reads the primary filename's CURRENT content fresh:
- ENOENT → nothing real there, write `entry` unchanged at the primary filename (today's fast path,
  unchanged for the overwhelming majority of mints).
- The SAME identity already occupies it → union its on-disk tokens into `entry` (via
  {@link readSurvivingOnDiskTokens}, which already subtracts `clearedTokens` — never resurrecting an
  already-cleared token), never dropping one — mirrors `reconcileMarkedBasenameBeforeWrite`'s own
  identity+token-union pattern, still written at the SAME primary filename (one merged record, not two).
- A DIFFERENT identity, OR an unreadable/corrupt/EISDIR file → ⛔ never overwrite it AND never move it
  (relocating it could break whatever else still references its own path) — `entry` is written UNCHANGED
  to a distinct `pendingDivertCollisionFilenameFor` filename instead (`pending-<24hex>-collision-<8hex>.json`),
  leaving the occupant byte-untouched. `mintPendingDivert` also keeps the caller's own in-memory
  `activeQuarantines` placement in sync with the reconciled (possibly unioned) object via
  `replaceEntryEverywhere`, the same "keep in-memory consistent with the newly-durable bytes" discipline
  round 2 of this card already established for `writeMergeQuarantineLatch`'s own chokepoint.

**Boot discovery of the collision filename — verified, not assumed.** `reenterMergeQuarantinesAtBootImpl`'s
PASS 1 scans every file ending in `.json` (`files = all.filter((f) => f.endsWith(".json"))`) and classifies
by CONTENT, never by filename shape — the same generic mechanism that already recovers an ordinary
`pending-<24hex>.json` file despite its basename never matching any registered repo's own key hash. A
collision-suffixed name needs no scan change. `pendingLatchIdFor` (the id-derivation chokepoint for a
human-facing listing/clear-by-id) DOES need one: a new `PENDING_DIVERT_COLLISION_RE` is added to its
hash-the-whole-basename dispatch, alongside `PENDING_DIVERT_RE`/`PENDING_DIVERT_TMP_RE`.

**Correction (Round 2, Code Review `ddb58ffa`) — the generic fallback id is NOT usable, for either shape.**
The paragraph above originally claimed the generic `.indexOf(".json")` fallback "would still produce a
stable, unique id... just an unusually long, unhashed one" — WRONG. `clearMergeQuarantineLatchFile`
validates its own `id` argument against a 24-hex shape and REJECTS anything else outright as an "invalid
latch id" — a non-hex fallback string is not merely inelegant, it is a latch that can never be cleared by
id at all. See Round 2 below for the real bug this left in place (the crash-left TMP residue of a
collision filename, which `PENDING_DIVERT_COLLISION_RE` alone does not match).

### Tests

Four scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`8a79dd31-fresh-divert`** / **`8a79dd31-divert-raise-entry`** — the original repro shapes, now
  asserting the FIX: the occupant's content survives, the union lands at the SAME primary filename
  carrying BOTH tokens (one record, not a diverted-elsewhere pair), and both tokens survive a
  fresh-process reboot as one record.
- **`8a79dd31-different-identity-diverts`** — a GENUINELY different identity (a true hash-of-identity
  collision stand-in) occupies the primary filename; asserts the occupant's file is byte-identical
  afterward, the raiser's own entry lands at a distinct collision-suffixed file (regex-matched), and after
  a fresh-process reboot BOTH survive as two separate entries (never merged).
- **`8a79dd31-unreadable-occupant-stays-byte-identical`** — the primary filename holds a foreign
  identity's own real bytes, but every read of it fails persistently (an "unknown" read failure, per
  `63e49ee2` — never ENOENT) during the raise; asserts the occupant's bytes are byte-identical once
  readable again (never touched despite the read failure), the raiser diverts to a collision file, and
  both survive a reboot.

All four proven RED against commit `da810900` (Step A, the pure refactor with no occupant-check) and
GREEN with the fix applied, via `scripts/negative-control.mjs` (tree restored byte-identical). All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30). Line endings re-verified CR==LF via the
`tr -dc` recipe on both touched files.

## Round 2 (Code Review `ddb58ffa`) — SHIP, plus a real bug in this card's own new code, anchor/test follow-up

CR `ddb58ffa` shipped the fix as fail-closed, all 34 `merge-quarantine*.mjs` files green, and the wiring
proven (14 of the new checks above RED under a dist-stripped build before being fixed, confirming they
actually exercise the real compiled module). Found, and fixed in this same round: one real bug the
original round introduced, two documentation/anchor gaps, and several untested divert branches.

### Real bug — a crash-left collision-tmp residue could never be cleared by id

`pendingLatchIdFor` recognized the CLEAN collision shape (`PENDING_DIVERT_COLLISION_RE`) but not its own
crash-left torn-write residue — `pending-<24hex>-collision-<8hex>.json.tmp-<pid>-<hex>`
(`writePendingDivertFile`'s own tmp-then-rename, interrupted before the rename, exactly the same shape
`PENDING_DIVERT_TMP_RE` already covers for the ORDINARY (non-collision) pending-divert file). It fell
through to the generic `.indexOf(".json")` fallback, which — per the correction above — produces a
non-24-hex id that `clearMergeQuarantineLatchFile` then rejects outright: the latch could never be cleared
by id at all, reproduced against the real compiled dist before any fix was written.

**The fix:** `PENDING_DIVERT_COLLISION_TMP_RE` (`merge-quarantine.ts`), mirroring `PENDING_DIVERT_TMP_RE`'s
own shape with the `-collision-<8hex>` infix, added to `pendingLatchIdFor`'s hash-the-whole-basename
dispatch alongside the other three. No boot-side change needed — PASS 1b's own pre-existing, content-based
"no resolvedKey, unresolvable" branch already recovers it with zero code changes, same reason
`PENDING_DIVERT_TMP_RE` itself needed none.

### Anchors — `@decision 8a79dd31` resolved to no record file

Every `@decision 8a79dd31` anchor this card's own first round added was retargeted to
`@decision 8db913e2 (Follow-up 8a79dd31)` — the same shape the existing `dd34da46` anchors already use for
a follow-up section living inside this SAME record file — so the guard extract actually injects one. The
older `29fe2372`/`495fd320`/`6c04633d` anchors are untouched (a separate, already-filed concern).

### Tests

Five more scenarios in `merge-quarantine-raise-protect-failure.mjs`, closing `reconcilePendingDivertTargetBeforeMint`'s
own untested divert branches plus one lifecycle gap:
- **`8a79dd31-corrupt-json-diverts`** — the primary filename holds genuinely unparseable bytes (not JSON
  at all). Asserts the garbage is byte-identical afterward and the raiser diverts to a collision file.
- **`8a79dd31-null-and-no-repopath-divert`** — two isolated shapes, each its own identity: the bare literal
  `null` (`495fd320`'s own null-latch class), and a syntactically valid object with no `repoPath` field at
  all. Both must divert, never overwrite.
- **`8a79dd31-eisdir-diverts`** — a DIRECTORY sits at the primary filename. Unlike `8db913e2`'s own round 1
  EISDIR trap on the ACTIVE-final side (where EISDIR means "nothing real, proceed"), this card's own ruling
  explicitly groups a PENDING mint target's own EISDIR with "never overwrite, never move" — asserts the
  directory survives untouched and the raiser diverts to a collision file.
- **`8a79dd31-different-identity-diverts`** (extended) — a new LIFECYCLE assertion: releasing the raiser's
  own (last, only) token sweeps its own collision-suffixed file off disk, and the foreign occupant's own
  entry is unaffected.
- **`8a79dd31-collision-tmp-residue-clearable-by-id`** — the real-bug repro above: a hand-crafted
  crash-left collision-tmp residue is recovered at boot, `quarantineLatchFileIdsFor` now derives a valid
  24-hex id for it (not the raw, non-hex basename), and `clearMergeQuarantineLatchFile` on that id succeeds
  (`ok:true`) and sweeps the residue off disk.

A test-hygiene note, not a module bug: the three corrupt/null/no-repoPath garbage fixtures above have no
identity attached and are never swept by anything in the module itself — each scenario now explicitly
unlinks its own garbage file afterward, or it would pollute a LATER scenario's own fresh boot scan of this
SAME shared `MERGE_QUARANTINE_DIR` as a spurious "orphan corrupt latch matching no registered repo"
(caught the hard way: it fail-closed-quarantined an UNRELATED later scenario's own clean repo).

All new assertions proven RED/confirmed against the pre-this-round code and GREEN after. All 34
`merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

### Do not

- Do not let a fresh-mint write site (`divertRaiseEntry`'s own `indices.length === 0` branch,
  `enterMergeQuarantine`'s own direct unresolvable brand-new-divert branch) call `writePendingDivertFile`
  directly — route through `mintPendingDivert`, the ONE chokepoint, or a future call site reopens this
  exact duplicated-writer divergence. **(Widened by Follow-up 6451a749, in `6451a749`'s own record)** — this rule is NOT scoped
  to "a fresh mint": `protectOccupantContentBeforeDelete` was a THIRD writer of this SAME deterministic
  path, reached from a COPY-ASIDE rather than a mint, that bypassed this chokepoint entirely and
  rediscovered the identical bug. The rule is "every writer of `pendingDivertFilenameFor`'s own
  deterministic path, whatever its own reason for writing there, routes through ONE shared,
  occupant-aware chokepoint" — see Follow-up 6451a749 for the generalized helper.
- Do not treat a different-identity (or unreadable/corrupt/EISDIR) occupant at the primary filename as
  something to relocate — leave it BYTE-UNTOUCHED and divert the NEW entry to a distinct collision filename
  instead. Moving the occupant can break whatever else still references its own path (the same "never move
  what you can't confirm is safe to move" posture `8db913e2`'s own round 1 EISDIR trap already taught).
- Do not add a new specially-shaped pending filename to this module without also registering it in
  `pendingLatchIdFor`'s own dispatch — every other shape (`PENDING_DIVERT_RE`, `PENDING_DIVERT_TMP_RE`,
  `SAFETY_TMP_RE`) hashes its whole basename there rather than relying on the generic `.json`-index fallback.
- Do not register only a new filename's CLEAN shape and assume its own crash-left `.json.tmp-<pid>-<hex>`
  residue is covered by the same regex — `PENDING_DIVERT_COLLISION_RE` matching the clean collision shape
  did NOT also match its own torn-write residue (Round 2's own real bug); a new shape needs BOTH its clean
  and its tmp-residue regex registered, mirroring the `PENDING_DIVERT_RE`/`PENDING_DIVERT_TMP_RE` pair.
- Do not assume the generic `.indexOf(".json")` fallback in `pendingLatchIdFor` is merely "unhashed but
  usable" for an unregistered shape — `clearMergeQuarantineLatchFile` rejects any non-24-hex id outright, so
  an unregistered shape's latch can never be cleared by id at all, not just inelegantly.
- Do not leave an identity-less garbage fixture (corrupt JSON, bare `null`, a repoPath-less object) behind
  in `MERGE_QUARANTINE_DIR` after a test scenario — nothing in the module itself ever sweeps it, and a
  LATER scenario's own fresh boot scan of this SAME shared directory can fail-closed-quarantine an
  unrelated, otherwise-clean repo as a side effect of the orphan-broadcast mechanism finding it. Unlink it
  explicitly at the end of the scenario that created it.
