# 48bda567 — the OPPOSITE age order of "4b06875f-migrate-union-drops-dual-arm", fixed inside `armQuarantineKey` itself

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 48bda567 — the OPPOSITE age order of "4b06875f-migrate-union-drops-dual-arm", fixed inside `armQuarantineKey` itself

Card `48bda567`, filed from `4b06875f`'s Round 3's own deliberate exclusion ("The OPPOSITE age order ... is a
PRE-EXISTING, separately-carded fail-open under the LEGACY rule too"). This is a defect in the plain
`{...older}` LEGACY rule itself — it predates `4b06875f` entirely and is NOT caused by Round 3's own
explicit-rule scoping fix.

**The shape:** `armQuarantineKey`'s legacy union takes `older.resolvedKey` unconditionally, with no
regard for WHAT that value means. PASS 1's migrate branch stamps a migrating latch's own `resolvedKey` to
its freshly-computed `currentKey` — a SELF-REFERENTIAL, uninformative value (it just means "no second arm
needed"). When that migrating latch happens to be OLDER than a real dual-arm entry sharing its key, the
legacy rule picks the self-referential value, discarding the dual-arm's own genuine secondary key
outright — even though `armedKeys` itself is still correctly dual-armed in memory THIS boot (the
in-memory arm set was never the broken part). The migrate-write pass then durably persists exactly this
union, so the next boot reads a self-referential `resolvedKey` and never re-arms the lost secondary key —
W (the repo the lost key would have blocked) reads fully unblocked. Measured directly against the real
compiled module (card `48bda567`'s own worker report): at boot-0, BEFORE any reboot, the refusal text
ALSO already stops naming the lost key's own repo, for the identical reason (nothing informative left to
report) — this is not merely a post-reboot symptom.

**The fix:** a small, scoped correction inside `armQuarantineKey` itself (`merge-quarantine.ts`, right
after computing the union, before folding `key` into `armedKeys`): if the union's own `resolvedKey` equals
`key` (self-referential) AND exactly one of `prior.resolvedKey` / `entry.resolvedKey` is defined and
`!== key` (genuinely informative), take that informative one instead. Otherwise the legacy result is left
completely untouched. `armQuarantineKey` has exactly ONE caller in this whole file —
`armKeyUnlessDegradedCollision` — so this reaches precisely "every boot-time dual-arm/migrate union" and
nothing else, mirroring Round 3's own scoping discipline in the opposite direction (Round 3 scoped the
explicit rule AWAY from this chokepoint; this fix is scoped TO it and nowhere else).

### Options weighed (see the card's own body for the full write-up)

- **(a) — SHIPPED.** Preserve the secondary arm's own informative `resolvedKey`, age-independent, inside
  `armQuarantineKey`. Minimal: uses the existing scalar field, touches one call site, no persisted-format
  change.
- **(b) — rejected.** Persist the arm set (`armedKeys`) itself instead of relying on a single scalar
  `resolvedKey` to reconstruct it each boot. `armedKeys` is DELIBERATELY never persisted today
  (`merge-quarantine.ts`'s own comment at the strip-before-write site: "A restart rebuilds it fresh via
  arming, and a stale persisted value from a PRIOR process's keying would be actively misleading to a
  human reading the raw file"). Reversing that would duplicate card `398f476c`'s own identity-model
  redesign scope (that card's body names exactly this kind of change as "a structural rearchitecture ...
  not a scoped bugfix"). Out of proportion for this card.
- **(c)** — nothing better identified; (a) is minimal and provably scoped to exactly the chokepoint this
  bug lives in.

### Effect on named invariants (verified, not merely argued)

- **`82032b5c`/`c9114934`** (a protective copy never resurrects a resolved collision's losing side;
  `clear-by-path-still-proceeds-and-protects` must stay green): orthogonal. `enterMergeQuarantine`'s own
  `existing` branch (the runtime-union mechanism these cards govern) never calls `armQuarantineKey` or
  `unionQuarantineEntries` at all — it hand-builds its own union object directly. Re-ran
  `clear-by-path-still-proceeds-and-protects` and `d2582692-clearing-union-winner-keeps-loser-pending`
  after the fix: both still green.
- **`4b06875f`'s probes B/C/D/E and both age-order variants**: Probes B and D each build their dual-arm
  fixture via a SINGLE file booted alone (`buildDualArmFixture`) — `prior` is `undefined` at that arm, so
  the correction's own guard (gated on a real `prior ? union : entry`) never engages; no union happens
  there at all. Probe E is about the on-disk reader for the (unrelated) explicit-rule call sites. The
  original A-older scenario is a NO-OP under the fix (its own `older.resolvedKey` was already informative,
  `!== key`, so the correction's outer guard never fires) — proven via `negative-control` with ONLY
  `merge-quarantine.ts` reverted: the A-older scenario's own CRITICAL check passes in BOTH the reverted
  (correction absent) and restored (correction present) phases.
- **`d2582692`**: its own mechanism (the safety-tmp recovery pass, `sourcesOnlyUnion`) calls
  `unionQuarantineEntries` directly, bypassing `armQuarantineKey` entirely (that card's own record says so
  explicitly: "instead of a direct `armQuarantineKey` union"). Unreachable from a correction scoped inside
  `armQuarantineKey`.
- **`d163aef5` boot guard** (`armKeyUnlessDegradedCollision`): untouched. The correction sits strictly
  downstream of whatever eviction/collision decision that guard already made — it only ever adjusts the
  `resolvedKey` FIELD of a union the guard already decided was legitimate (same-tier, no eviction); it
  never changes whether an eviction happens or who wins a collision. **Corrected (CR `31ba43b4`):** a
  "same-tier, no eviction" union reached this way is not limited to the migrate-vs-real-dual-arm shape
  this card repros — PASS 1b's own tmp-residue handling can ALSO reach it with two independently
  informative, genuinely different `resolvedKey` values on either side (a `.json` + `.tmp` pair, or two
  tmps, sharing one hash), which d163aef5's guard correctly treats as a legitimate union (both sides
  equally resolvable) rather than an eviction. See the "Do not" bullet below for why this correction stays
  safe there, and card `1e739f4a` for the separate, later masking bug this does NOT fix.

### Overlap

- **`398f476c`** (identity-model redesign): related in spirit (a union losing information about a second
  identity) but far narrower in scope — uses the existing scalar `resolvedKey` field, touches one
  chokepoint, no persisted-format change. The SAME legacy `{...older}` rule also carries
  `repoPath`/`branch`/`reason`/`enteredAt` from the older side — in the B-older order, the union's own
  `repoPath` becomes the migrating latch's own path (e.g. a subdirectory of the real repo) rather than the
  real repo's own path, even at boot-0 before any reboot. That is the exact "a union object can only
  represent one identity's own repoPath at a time" shape `398f476c` already owns. This card's fix does
  NOT touch it, and the new B-older test scenario deliberately does not assert on `repoPath` — only on the
  dual-arm's own `armedKeys`/object identity, which is what this card's own bug actually breaks.
- **`050a4428`**: different call sites entirely (the explicit-rule protect/pending-divert sites' SECOND
  union against a stale in-memory pending copy, never `armQuarantineKey`). No sequencing dependency either
  direction.
- `consumeMatchedPendingsIntoArmedEntry`'s own `foreignUnion` (card `48bda567`'s own body names this) is
  the SAME bug CLASS at a different (runtime, not boot) call site — unreproduced, left out of scope here.

### Do not

- Do not widen this correction beyond `armQuarantineKey`'s own single call site — never a second
  `unionQuarantineEntries` option flag for it (that function already carries one, `explicitResolvedKeyRule`,
  scoped to the two protect/pending-divert sites per `4b06875f`'s own Round 3; a second flag for a THIRD rule read by
  a THIRD caller set is harder to reason about than arbitration living at the one caller that needs it).
- Do not persist `armedKeys` to fix this instead — see "Options weighed" above; that reverses a deliberate
  existing design decision and duplicates `398f476c`'s own larger scope.
- Do not read the `repoPath`/`branch`/`reason`/`enteredAt` older-side-wins behavior as a defect this card
  fixes or as something still open here — it is `398f476c`'s own documented scope; this card's fix is
  scoped to `resolvedKey` only.
- Do not trust a `repoPath === <expected>` assertion on a B-older (or any age-dependent) dual-arm union
  fixture — assert on `armedKeys` / object identity instead (see the B-older scenario's own comment for
  why the first drafted assertion here was wrong, and failed for a reason unrelated to this card's actual
  bug).
- **CORRECTED (CR `31ba43b4`)** — do NOT read the "both sides genuinely informative and different" shape
  as structurally unreachable. It IS reachable through a real call site: a secondary-arm caller passes
  the PRIMARY arm's own RESULT as `entry`, not the raw parsed entry (`armKeyUnlessDegradedCollision`'s
  `key` argument is the raw entry's own `resolvedKey` field, but its `entry` argument is the primary arm's
  RESULT — if that primary arm itself unioned with an older `prior`, the result's own `resolvedKey` can
  already differ from the raw field used as `key`); separately, PASS 1b primary-arms every tmp residue at
  its own `currentKey`, so a `.json` + `.tmp` pair (or two tmps, per `92c645cc`) sharing one hash can
  collide there with two independently-informative keys. Card `1e739f4a` owns fixing the actual outcome —
  TODAY a later, unconditional tmp-promotion self-stamp masks it. This correction is SAFE there regardless:
  its own outer guard (`merged.resolvedKey === key`) is false whenever both sides are genuinely different
  and informative (the plain legacy result can never equal `key` in that case), so the correction simply
  never fires — see `armQuarantineKeyTestOnly`'s own doc comment and the
  `48bda567-no-fire-both-sides-informative-and-different` scenario, which is a REGRESSION PIN on that
  outer guard (it passes with the correction removed, and with the guard itself deleted too), never
  discrimination evidence that the shape can't occur.

### Tests

`merge-quarantine-runtime-union-provenance.mjs`: `48bda567-migrate-union-drops-dual-arm-b-older` (RED on
the legacy rule, GREEN after the fix — negative-control proven, byte-identical tree restore),
`48bda567-no-fire-both-sides-informative-and-different` (unit-level, via the test-only
`armQuarantineKeyTestOnly` export — a REGRESSION PIN proving the correction's own outer guard stays false,
and the result is deep-equal to the plain legacy union, when both sides are genuinely different and
informative; it is NOT evidence the shape is unreachable — see the "Do not" bullet above). The original
`4b06875f-migrate-union-drops-dual-arm` (A-older) scenario stays green with the correction present AND
absent (negative-control, same run). All 34 `merge-quarantine*.mjs` files and `guards` re-run clean.
