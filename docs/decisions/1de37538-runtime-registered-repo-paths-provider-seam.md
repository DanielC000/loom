# 1de37538 — a late-bound, live-called provider lets Step B share PASS 1's own registered-identity predicates

Split out of `97a5b64f`'s own record as a deferred, investigate-first weigh-it card (2026-10-29), then
re-opened and built the same day after the investigation's own corrected repro met its reopen trigger.

## The gap

`armForeignOrphanContentInMemoryIfUnenforced` (merge-quarantine.ts, "Step B" from card `5d0820c7`) is the
runtime counterpart of `reenterMergeQuarantinesAtBootImpl`'s PASS 1: both union a foreign/ghost identity's
secondary claim into whatever currently occupies that key. PASS 1 additionally marks the union
`provenanceUnknown: true` (closing `clear-by-id` for it, per `db0a9db0`/`e7652e06`) via two predicates —
`secondaryArmClaimsADifferentRegisteredIdentitysKey` and
`priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity` — both of which need `registeredRepoPaths`,
a list that reached only `reenterMergeQuarantinesAtBoot` (from `index.ts`'s own `db.listAllRegisteredRepoPaths()`
call). Step B had no such list and could never originate this stamp, by construction: `armQuarantineKey`
(the bare union primitive it calls) only ever *propagates* an already-set `provenanceUnknown` via
`unionQuarantineEntries`'s sticky OR, never originates one.

## The investigation (card `1de37538`, investigate-first phase)

Confirmed structurally (grep: `registeredRepoPaths` existed only inside PASS 1's own closure and two
boot-only helpers) and, after a correction, empirically. The first repro attempt failed to reproduce the
reboot-side stamp at all — root cause: both predicates require their OWN subject to be
`isRepoPathCurrentlyResolvable` (`secondaryArmClaimsADifferentRegisteredIdentitysKey` needs the
**secondary claimant** resolvable; `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity` needs
the **prior occupant** resolvable with a non-fresh claim at that key). The first attempt raised the
registered repo `V` directly at `V`'s own key, where `isKeyVerifiedFor(V, keyV)` is tautologically always
true — neither predicate can ever fire against that shape.

The corrected repro built the card's own named shape literally: `U` raised and dual-armed at
`[keyU, keyV]` (via a hand-edited `resolvedKey` on `U`'s own on-disk latch, then a REAL reboot to pick it
up — never a hand-set in-memory field), `V` a separate, registered, resolvable repo (never itself
raised — a pure filesystem fact), `A` the clearer, `T` an unresolvable ghost whose own `resolvedKey` is
`keyV`. Clearing `A` triggers Step B's unconditional union of `T` into `U`'s entry at `keyV` (the
`resolvableNow`-only decline check never applies to unresolvable `T`). Result, stable across 9 repeated
runs with fresh random paths/tokens: in-process `provenanceUnknown` at `keyV` = **false**; rebooting the
identical on-disk bytes with the identical `registeredRepoPaths` = **true**. A negative control (omitting
`V` from `registeredRepoPaths` on reboot) flipped the result back to false, isolating `registeredRepoPaths`
membership as the deciding variable.

## The fix — option (b), never option (a)

`setRegisteredRepoPathsProvider` (exported) + `liveRegisteredRepoPaths` (private getter): a late-bound,
module-level provider, read LIVE on every call (never snapshotted), defaulting to `null` ⇒ `[]` —
byte-identical to pre-fix behavior when unset. If the set provider throws, the throw is caught and
logged, treated as "no registered repos known" — never propagated, never a stricter refusal. Wired
exactly once, in `index.ts`, immediately after the `canonicalRepoPaths` computation and before the
boot-time `reenterMergeQuarantinesAtBoot` call (see "Round 2" below for what it's actually wired to).

`secondaryArmClaimsADifferentRegisteredIdentitysKey` and
`priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity` are hoisted from PASS 1's own closure (inside
`reenterMergeQuarantinesAtBootImpl`) to module scope, each taking `registeredRepoPaths: string[]` as an
explicit parameter instead of a boot-only closure capture — the closure-scoped `const`s of the same names
are DELETED outright (not kept as thin pass-throughs); `armKeyUnlessDegradedCollision`'s own call site —
PASS 1's one caller of both — is edited to pass its own `registeredRepoPaths` parameter through explicitly
at both call sites. Step B (`armForeignOrphanContentInMemoryIfUnenforced`'s secondary-key loop) now runs
the IDENTICAL stamp check PASS 1 does — fed by `liveRegisteredRepoPaths()` instead of a closure capture —
immediately before its own `armQuarantineKey` call, for every secondary key.

Module import set is unchanged (still only `fs`/`path`/`crypto`/`paths.js`/`repo-lock.js`) — the seam is a
bare function reference the module never resolves itself; the ~70 hermetic test files that import this
module directly need zero changes, since none of them ever calls the setter.

## Round 2 (Code Review of `d5d6c580`) — S1 (parity bug in what the provider was wired to), N1-N3

**S1 (BLOCKING) — the provider was wired to the WRONG list.** `setRegisteredRepoPathsProvider` was
originally wired to `db.listAllRegisteredRepoPaths()` (live + reserved + archived). But PASS 1's own
`registeredRepoPaths` parameter — the one `reenterMergeQuarantinesAtBoot` is actually called with, and the
one both predicates above test membership against — is `index.ts`'s own `canonicalRepoPaths`, built from
`db.listProjects()` (live, non-reserved, non-archived ONLY; deliberately narrower — see
`Db.listAllRegisteredRepoPaths`'s own doc comment, which states the two lists answer different questions
on purpose). For `V` an ARCHIVED (or reserved) project's repo colliding at a secondary key: the ORIGINAL
wiring made Step B stamp `provenanceUnknown` in-process (`V` IS in `db.listAllRegisteredRepoPaths()`)
while a real reboot — which only ever consults `canonicalRepoPaths` — does NOT (the mismatch/decline
branch instead, since `V` is absent there) — the EXACT fail-open-vs-fail-closed inversion this card exists
to close, now reproduced in the OPPOSITE direction (Step B MORE eager than reboot, not less).

**The fix:** `index.ts`'s own `canonicalRepoPaths`-building loop is extracted into
`computeCanonicalRepoPaths` (new file, `packages/daemon/src/projects/canonical-repo-paths.ts` — a small,
side-effect-free module, hermetically importable with no daemon/DB boot, since `index.ts` itself cannot
be). `index.ts` now calls it twice — once to build `canonicalRepoPaths` (unchanged use, just via the
extracted helper), once inside the provider closure (`() => computeCanonicalRepoPaths(db)`, called LIVE
on every Step B use, never the stale `db.listAllRegisteredRepoPaths()`) — so the two can never again read
two different definitions of "registered" for the same question. `partitionQuarantinesByRegistration`'s
own, separate `db.listAllRegisteredRepoPaths()` call (for the boot-time orphan-latch SUMMARY log, which
deliberately WANTS the broader reserved/archived-inclusive list) is untouched — that is a genuinely
different question ("is this latch's repo known to Loom at all, for display purposes") from what PASS 1
and Step B both need ("can a merge land on this right now").

**Test added:** `merge-quarantine-1de37538-canonical-repo-paths-parity.mjs` — (A) a unit-level check that
`computeCanonicalRepoPaths` excludes an archived project's repo while `db.listAllRegisteredRepoPaths`
includes it (the raw fact S1 depends on); (B) a raw SOURCE-TEXT pin on `index.ts` itself (never `dist/**`
— tsc keeps comments either way, but reading source needs no build step to react to a revert) asserting
BOTH the `canonicalRepoPaths` assignment and the `setRegisteredRepoPathsProvider` call reference
`computeCanonicalRepoPaths(db)`, and that the provider call never names `listAllRegisteredRepoPaths` — the
genuine RED/GREEN discriminator (see below); (C) the card's own full integration shape (`U` dual-armed,
`A` the clearer, `T` a ghost) with `V` a REAL archived project (via a real temp-`LOOM_HOME` `Db`,
`db.insertProject` with `archivedAt` set) and the REAL `computeCanonicalRepoPaths(db)` wired as the
provider — in-process now agrees with reboot (both false); (D) the SAME shape with the provider
illustratively wired back to the OLD, wrong list — reproduces the exact S1 mismatch (in-process true,
reboot false) — always green (it documents the defect, not a live regression guard on its own; (B) is).

RED proof: `node packages/daemon/scripts/negative-control.mjs --file packages/daemon/src/index.ts --test
packages/daemon/test/merge-quarantine-1de37538-canonical-repo-paths-parity.mjs --ref d5d6c580` —
`computeCanonicalRepoPaths`/`canonical-repo-paths.ts` did not exist at `d5d6c580` at all, so only
`index.ts` is revertable via this tool (a file negative-control cannot find at a given ref throws rather
than reverting) — check (B) alone is what goes RED there (the wiring line's own text differs), which is
sufficient: (A)/(C)/(D) never depend on `index.ts`'s content, only on the now-existing shared helper and
`merge-quarantine.ts`'s own (unchanged-since-round-1) seam. GREEN after restore, tree byte-identical.

## Do not

- Do not thread `registeredRepoPaths` through runtime callers (option a) — rejected: large, uneven blast
  radius (`GitWriter`'s checkout/createBranch/commit across 3 construction sites, `mergeBranch`'s already-
  11-param signature across ~12 internal kill-recovery call sites), and its failure polarity depends on
  disciplined wiring at every one of those sites rather than one safe default.
- Do not call `setRegisteredRepoPathsProvider` from anywhere but `index.ts`'s own boot sequence — it is
  boot-time wiring, not a runtime or test-time lever. A test sets its own provider directly on its own
  dynamically-imported module instance (each `?b=N`-suffixed import gets independent module state).
- Do not snapshot the provider's result at wiring time — `liveRegisteredRepoPaths()` must call it fresh on
  every use, or a project registered after boot would be invisible to Step B indefinitely.
- Do not let `secondaryArmClaimsADifferentRegisteredIdentitysKey`/
  `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity` drift into two separately-maintained
  copies again — PASS 1 and Step B must always call the SAME module-scope function.
- Do not construct a repro of this shape by raising the registered identity directly at its own key — its
  claim there is tautologically fresh, and neither predicate can fire against it. The reachable shape
  needs a DIFFERENT, resolvable identity (`prior`) holding the colliding key via a non-fresh secondary
  claim — see "The investigation" above for why the first repro attempt failed.
- Do not wire the provider to `db.listAllRegisteredRepoPaths()` (round 2, S1) — it is DELIBERATELY broader
  than PASS 1's own `registeredRepoPaths` (`canonicalRepoPaths`, `db.listProjects()`-derived): it also
  counts reserved and archived projects, so using it for the provider makes Step B MORE eager than a
  reboot for exactly those, the opposite-direction version of the bug this card exists to close. Always
  call `computeCanonicalRepoPaths(db)` — the one function both the boot call and the provider must share.

## Tests

`merge-quarantine-1de37538-step-b-provider-seam.mjs` (new): (UNSET) in-process stays false while a real
reboot against the same bytes still sets it true — the gap persists whenever the provider isn't wired;
(SET-INCLUDED) in-process now equals reboot, both true; (NEGATIVE CONTROL) provider set but `V` excluded
⇒ false on both legs; (PROVIDER-THROWS) a throwing provider never propagates and is treated as no
registered repos known. All four scenarios derive their state from real boots/raises/clears — never a
hand-set derived field. Timed solo: ~3s (no `TEST_TIMEOUT_OVERRIDES` entry needed).

RED proof: `node packages/daemon/scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts
--file packages/daemon/src/index.ts --test packages/daemon/test/merge-quarantine-1de37538-step-b-provider-seam.mjs
--ref 107e997f` (the sha immediately before this card's own commit) — RED before the fix, GREEN after,
tree restored byte-identical.

Targeted re-run (one lane, foreground) of every pre-existing test that greps for
`armForeignOrphanContentInMemoryIfUnenforced`, `armKeyUnlessDegradedCollision`,
`secondaryArmClaimsADifferentRegisteredIdentitysKey`, `priorHoldsKeyViaNonFreshClaimOnADifferentRegisteredIdentity`,
or `secondaryKeysToAttempt`, plus `merge-quarantine-97a5b64f-armed-latch-writes-keep-fields.mjs` (named
explicitly) — all pass; exact file list and results in the worker's own `worker_report`, not restated
here. `pnpm --filter @loom/daemon guards`: 31/31 pass.
