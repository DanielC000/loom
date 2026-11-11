# 1e739f4a — the promote-site self-stamp (shipped) and a reverted PASS 1b primary-arm divert attempt

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 1e739f4a — the promote-site self-stamp (Fix 1, SHIPPED); a divert attempt at the PASS 1b
primary-arm collision (Round 1, REVERTED after Code Review)

From CR `31ba43b4` of card `48bda567` round 3 — its own "Do not" bullet named TWO further findings:
PASS 1b's own tmp-PROMOTION write durably loses a dual-arm's secondary key, and the "both sides
informative and different" union shape — reachable at PASS 1b's own PRIMARY arm, not just the
secondary-arm site `48bda567-no-fire-both-sides-informative-and-different` regression-pins — was
genuinely reachable but masked by the first bug. Both REPRODUCED first (merge-quarantine.ts, before any
fix): `one-tmp`/`two-tmps`/`json-plus-tmp`/`json-plus-tmp-subpath` in the new
`merge-quarantine-tmp-promotion-dual-arm.mjs`, all RED on main (`42ae41c`) except the `one-json-control`
negative control.

### Fix 1, SHIPPED — PHASE 2's own promote-site self-stamp (merge-quarantine.ts, PHASE 2, search
`isInformativeKey`)

`const armedForWrite: MergeQuarantineEntry = { ...unionEntry, resolvedKey: key };` unconditionally
overwrote `unionEntry.resolvedKey` with the promote key, regardless of whether `unionEntry.resolvedKey`
already carried a genuinely informative secondary key — PASS 1b's own primary+secondary arm sequence
(immediately above PHASE 2 in the read loop) correctly dual-arms BOTH keys in memory THIS boot, but the
promoted `.json` final's own persisted `resolvedKey` field can only ever carry one value, and this stamp
threw away whichever one it already had in favor of the self-referential promote key — even when nothing
about the entry was ever wrong (e.g. an unrelated, harmless stale tmp sharing a hash with an already-
correct `.json` final, `json-plus-tmp`).

**Origin, traced via `git log -S`:** commit `a1401880` (card `92c645cc` round 2). That card's own
decision record (`docs/decisions/92c645cc-fresh-tmp-name-and-conditional-sweep.md`, "PASS 1b's one-boot
dual-arm vs PASS 1's immediate single-arm") argued the loss was harmless ("the only thing a stale key's
continued presence ever enabled was a human `/clear-by-path {id}` convenience... nothing is ever LESS
enforced either way") — true only when the lost key is a disposable self-migration marker, false when it
is a genuine cross-repo dual-arm (the exact load-bearing shape `4b06875f`/`48bda567` established). That
round never considered the latter because, at the time, nothing dual-armed a tmp sharing a key with a
pre-existing `.json` final the way this card's fixtures do. Corrective cross-reference added to that
record (see below).

**The fix (SHIPPED):** a shared `isInformativeKey(entry, key)` helper (defined once, used by
`armQuarantineKey`'s own `48bda567` correction, this promote-site write, and the log-only check below, so
all three can never again drift on what "informative" means) — only stamp `resolvedKey: key` when
`unionEntry.resolvedKey` is NOT already informative (undefined, or already equals `key`); when it IS
informative, keep it untouched.

**Reviewer's own note on this fix's shape (CR `cd9b1e3e`):** `unionEntry.resolvedKey` can, in principle,
be preserved even when it is a DISPOSABLE self-migration marker left over from some earlier state rather
than a genuine cross-repo dual-arm — Fix 1 cannot and does not distinguish the two (nothing in the
in-memory object marks WHICH kind a given informative key is). The failure direction this produces is
OVER-block, never under-block: at worst a key stays armed slightly longer than strictly necessary, and a
human `/clear-by-path` on it still lifts it correctly — this is the same direction, and the same
remediation, `92c645cc`'s own accepted PASS-1-vs-PASS-1b asymmetry already lives with. Not a regression
this fix introduces; a pre-existing shape of the scalar-`resolvedKey` design this fix does not change.

### Round 1 (REVERTED after Code Review `cd9b1e3e`) — PASS 1b's own primary-arm union can silently drop
a genuinely different, equally informative secondary key

With Fix 1 alone, a SECOND, independent loss remained: when a second tmp's raw entry collides, at
`armCurrentKeyUnlessDegradedCollision`'s own PRIMARY arm, with an already-armed result where BOTH sides'
own `resolvedKey` are genuinely informative and DIFFERENT (`two-tmps`: tmp #1 armed at K1, tmp #2's own
raw entry carries K2) — `unionQuarantineEntries`'s plain legacy `{...older}` rule keeps exactly ONE
side's `resolvedKey` (by age) and has no representation for the other at all. `armedKeys` stays
correctly triple-armed `[Ky, K1, K2]` in memory THIS boot (the in-memory arm set was never the broken
part, same as `48bda567`'s own finding), but only one of K1/K2 can ever survive in the scalar
`resolvedKey` field written to disk.

**First ruling (since REVISED — see below):** the Lead initially ruled this should be FIXED here rather
than deferred to `398f476c` (whose own identity-model redesign covers the scalar `resolvedKey`'s
inability to represent two identities PASSIVELY, not actively DROPPING an arm this boot's own processing
already knows is enforced) — a divert was implemented: keep the legacy rule's winner untouched; push the
LOSING side's key into `pendingUnresolvedQuarantines`, protecting whichever tmp file physically carries
it from this key's own unlink step, so a future boot re-reads that surviving tmp and re-derives the SAME
divert. Verified GREEN at the time against the card's own test matrix (`two-tmps` closing fully, both
witnesses blocked across two reboots, idempotent).

**Code Review `cd9b1e3e` found this UNSOUND and the Lead REVISED the ruling — three findings, none
caught by the card's own matrix because none of them are reachable FROM it in isolation:**
- **CRITICAL 1** — any `activeMergeQuarantineFor(Y)` query or raise on Y after the divert absorbs the
  diverted pending entry as a cross-tier sibling. `consumeMatchedPendingsIntoArmedEntry` (`~:1301`)
  carries its OWN FOURTH unconditional `resolvedKey: key` self-stamp and unlinks the protected tmp — so a
  query or raise between boots (not exercised by `two-tmps`, which never queries/raises between boots)
  unblocks BOTH W1 and W2 after the next reboot, worse than Fix 1 alone (which at least keeps W1).
- **CRITICAL 2** — with Y REGISTERED (the normal production case; `two-tmps` deliberately stays
  unregistered to reach the full parse path — see the file header), PASS 1b's own early-delete gate
  (`~:4677`, gated on `cleanlyParsedKeys`) unlinks the protected tmp UNREAD on the very next boot, once
  the promoted `.json` final itself parses cleanly — so W2 is unblocked after exactly one reboot, the
  divert never even getting a chance to re-derive itself.
- **MAJOR 3** — the divert's own identity gate silently dropped a DIFFERENT-identity collision (Y vs
  Y's own subdirectory) with no log at all — worse than simply accepting the residual, which at least
  would have been visible.

Making the divert durable needs a REAL multi-arm representation (tracking identity over token/key SETS,
not one scalar `resolvedKey`/`armedKeys` pair) — `398f476c`-scale, not a scoped bugfix for this card.

### Round 2, SHIPPED — the divert removed; the residual logged instead, never silently

**Revised ruling:** remove the Round 1 divert entirely. At the PASS 1b collision (search
`isInformativeKey(priorAtCurrentKey`), when both resolvedKeys are informative and DIFFERENT (ANY
identity, same or different — Round 1's own identity gate, MAJOR 3 above, is also removed), do not
attempt recovery at all. Emit ONE `console.error` naming the dropped key, both source files (the current
tmp, and — via a best-effort reverse lookup through `originalEntryBySource`, or the `.json` final's own
basename when the losing side isn't traceable to a surviving tmp — the other side), and pointing at card
`43cf3b26`, so the residual is visible and never silent, on every boot it recurs.

### ACCEPTED RESIDUALS, both owned by card `43cf3b26` (not fixed by 1e739f4a; reported, never silently
widened)

1. **Two informative, DIFFERENT keys colliding at PASS 1b's own primary arm (same OR different
   identity)** — the loser is dropped from the persisted `resolvedKey` field and loudly logged (never
   silent); `armedKeys` still correctly represents it in memory for the boot that saw the collision, but
   nothing persists that past a reboot. Pinned as a REGRESSION PIN (not a bug report) by the `two-tmps`
   scenario below: W1 (the kept key) stays blocked across two reboots; W2 (the dropped key) is UNBLOCKED
   after the first reboot and stays that way — asserting that IS pinning the residual's real, current
   behaviour, not a regression in the test.
2. **A `.json` FINAL losing the union** (Round 1's own identified sub-case) — there is no existing file a
   future fix could safely reuse without first solving (1)'s own identity-model gap anyway, since both
   residuals are the SAME root cause (a scalar `resolvedKey` cannot represent two identities) surfacing at
   slightly different call shapes.

### Overlap

- **`398f476c`** (identity-model redesign): both residuals above are, in spirit, `398f476c`'s own
  eventual territory — a real fix needs identity tracked over token/key SETS, not a scalar. `43cf3b26` is
  the card that owns actually doing that work (or deciding it's `398f476c` itself); this record only
  documents the two residuals, not a plan to close them.
- **`48bda567`**: Fix 1 is the SAME bug class (a self-referential stamp masking a genuine dual-arm) at a
  DIFFERENT call site (promote vs. `armQuarantineKey`'s own union), fixed the same way, now sharing
  `isInformativeKey` with it. The residuals above are the SAME union shape `48bda567`'s own "Do not"
  bullet named as reachable-but-masked at this file's PRIMARY arm, as opposed to the regression-pinned
  secondary-arm shape that bullet itself pins.
- **`92c645cc`**: its own decision record's "the loss is harmless" reasoning is corrected below — never
  read that record's own section as still endorsing an unconditional self-stamp for a genuine dual-arm.

### Do not

- Do not widen Fix 1 beyond the ONE promote-site write — it already mirrors `armQuarantineKey`'s own
  `48bda567` correction via the shared `isInformativeKey` helper; a THIRD near-identical arbitration site
  (PASS 1's own `.json` migrate branch, `~L4516`, `entry.resolvedKey = currentKey`) has the SAME
  unconditional-overwrite SHAPE but was explicitly left untouched — flagged, not reproduced, filed as a
  separate card by the Lead. Do not fold it into this card's own fix without a fresh repro and ruling.
- Do not re-attempt a divert at the PASS 1b collision without first closing `398f476c`'s own
  identity-model gap — Round 1 above is the record of exactly why a narrower attempt is unsound: it is
  reachable by a query, a raise, or simply registering the repo, none of which the fixing card's own
  narrow test matrix happened to exercise. A new attempt needs to independently prove it survives ALL
  THREE of those before it can be trusted, not just the matrix that originally motivated it.
- Do not touch `consumeMatchedPendingsIntoArmedEntry`'s own FOURTH self-stamp (`~:1301`, CRITICAL 1 above)
  from this card — it is not reachable without a divert in this card's own fixtures, and is carded
  separately (card `43cf3b26`) rather than folded in here.
- Do not read either ACCEPTED RESIDUAL above as fixed, or as something this card's own test matrix closes
  — it does not, by design; `two-tmps` is a REGRESSION PIN on the residual's current behaviour, not a
  claim that behaviour is correct. Re-open via card `43cf3b26`.
- Do not trust `armedKeys` alone as proof of reboot survival — `two-tmps`'s own precondition check shows
  `armedKeys` was ALREADY correct in memory on the very commit this card reproduces as RED; Fix 1's own
  bug was never in-memory enforcement, only PERSISTENCE.

### Tests

`merge-quarantine-tmp-promotion-dual-arm.mjs` (7 scenarios): `one-json-control` (negative control, never
reaches PHASE 2), `one-tmp` and `registered-y` (Fix 1, unregistered and registered respectively — both
closed), `raise-y-after-boot0` (Fix 1's own kept key survives a genuine runtime raise + reboot, not just
a plain reboot), `json-plus-tmp`/`json-plus-tmp-subpath` (Fix 1, an unrelated harmless tmp never destroys
an already-correct final), and `two-tmps` (the REGRESSION PIN described above — asserts the
`console.error` fires naming the dropped key and card `43cf3b26`, asserts W1 survives two reboots, asserts
W2 stays unblocked after both, asserts the on-disk file set never grows/duplicates across either reboot).
All scenarios RED on main (`42ae41c`) before Fix 1, GREEN after, negative-control proven (reverted Fix 1
in the compiled `dist/git/merge-quarantine.js` directly — a byte-copy aside before mutating, `cmp`-verified
restore after — rather than rebuilding from a reverted `.ts`, so the control exercises exactly the shipped
artifact); every scenario re-confirmed RED again under that reversion. Every scenario in
`merge-quarantine-runtime-union-provenance.mjs` (including `48bda567-migrate-union-drops-dual-arm-b-older`,
`48bda567-no-fire-both-sides-informative-and-different`, `4b06875f-migrate-union-drops-dual-arm`,
`clear-by-path-still-proceeds-and-protects`, and every `4b06875f` probe B/D scenario) and
`merge-quarantine-raise-protect-failure.mjs` (probes C/E) stay green.
`d2582692-clearing-union-winner-keeps-loser-pending` (`merge-quarantine-pass1-degraded-union-guard.mjs`)
stays green. All 35 `merge-quarantine*.mjs` files, every OTHER test importing `merge-quarantine.js`
(batch-merge/vault-commit/kill-confirm/quarantine-admission families), and `pnpm --filter @loom/daemon
guards` (30/30) re-run clean — under both `LOOM_DEV` unset and `LOOM_DEV=1`.
