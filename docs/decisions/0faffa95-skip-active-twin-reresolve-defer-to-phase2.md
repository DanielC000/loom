# 0faffa95 — `clearTokenFromPendingIndices` defers a re-resolved ACTIVE TWIN entirely to phase 2

From Code Review `d7eaad3d` of `3315b08a` (`bdf747fc`) — reproduced with a hermetic scratch probe (not
committed) before any fix was written, mirroring `3315b08a`'s own precedent.

## The hazard

`3315b08a`'s own re-resolve-by-identity fallback (fired when a target's snapshotted `pending` wrapper is
no longer `pendingUnresolvedQuarantines.includes()`-true) can re-resolve `live` onto an entry that is
ALSO an **active twin** — one `protectOccupantContentBeforeDelete`'s own BOTH-INDICES branch
(`atFilenameSameIdentity && atFinalBasenameSameIdentity`) just re-pointed: it calls
`replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename, written.entry)` for the twin's own key,
but the armedKeys union feeding `written.entry` is gated to `atFilenameIdx` alone
(`@decision c9114934`/`cd5a3cf9`) — the twin's own `armedKeys` never join it. `clearTokenFromPendingIndices`'
re-derived plan (`ownedArmedKeys`, and the reduce branch's own write loop) is sourced purely from
`live.entry.armedKeys`, so the twin's key is invisible to both, even though `activeQuarantines` now
genuinely points that key at `live.entry`.

## Confirmed repro (both scenarios; see
`merge-quarantine-0faffa95-active-twin-defer-to-phase2.mjs`)

- **REDUCE** (the re-derived plan survives a token after the union): in-memory state is correct
  (`activeQuarantines` is re-pointed, `token` is dropped) but the twin's own on-disk latch file is NEVER
  rewritten, and "phase 2" (`clearActiveEntryTokenAtKey`'s own walk inside `clearMergeQuarantineByToken`)
  never visits it either — by the time phase 2 runs, the in-memory entry no longer carries `token`, so
  phase 2's own `!entry.tokens.includes(token)` guard skips it. A restart before anything else touches
  that key resurrects `token` as outstanding there.
- **REMOVE** (nothing survives the union): SAFE. The remove branch never mutates `live.entry.tokens`
  itself (it only ever deletes keys it OWNS), so phase 2 still finds `token` present on the twin's entry
  and fully lifts it there, including unlinking the twin's own physical latch file — this is the "phase 2
  backstops" case named in the card.

**Test-design limitation (same backstop, a different test):** `3315b08a`'s own S2 scenario
(`merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs`) tries to check that the remove branch's
`ownedArmedKeys` — re-derived fresh via `entryStillOwnsKey` against the re-resolved `live.entry`, never
reused from the stale pre-pass plan — actually gets durably processed, by writing a real on-disk latch
file at the owned key and asserting it's gone after the clear. Verified (forcing `ownedArmedKeys` to
`[]` locally and restoring) that this check CANNOT go red: phase 2 independently re-discovers and cleans
that same key regardless, for the identical structural reason as the REMOVE bullet above — a
REMOVE-shaped clear's `live.entry.tokens` is exactly the one token being cleared, and
`entryStillOwnsKey`'s subset test forces any occupant it can discover to itself carry that same token,
which phase 2's own token-filtered walk over `activeQuarantines` would reach on its own either way. S2's
check is kept as an end-state outcome guard (the file is genuinely gone, by whichever path) — it is not,
and cannot be, a unit-isolating proof of `ownedArmedKeys`' own correctness in the remove branch. Do not
re-derive this by trying to force a RED there again; this is why there isn't one.

## The fix

In the re-resolve branch only, immediately after resolving `live`: scan `activeQuarantines.values()` for
a reference-equal (`===`) match to `live.entry`. If found, log (disclosure-safe: repoPath + sourceFile
only) and `continue` — skip remove/reduce here entirely, deferring to `clearActiveEntryTokenAtKey`
(phase 2). **This is complete for a twin armed at a SINGLE key — the only shape this card's own repro
constructs and verifies** (`merge-quarantine-0faffa95-active-twin-defer-to-phase2.mjs`'s T2 carries
exactly one `armedKeys` entry, `kTwin`): `clearActiveEntryTokenAtKey`'s own `armedKeysForEntry` falls
back to the ONE key it was found at (`entry.armedKeys?.length ? entry.armedKeys : [key]`) precisely
because `written.entry.armedKeys` is empty (never unioned, per `c9114934`/`cd5a3cf9`) — so for a
single-key twin that fallback is harmless (there is only one key to begin with) and
`clearActiveEntryTokenAtKey` correctly walks it AND separately re-writes every PENDING slot sharing the
SAME object reference (`collectPendingIndices((p) => p.entry === updated)`, its own dual-tracked-twin
loop, `@decision ae79d492`) — durably rewriting the stranded target's own pending slot in the same pass
that fixes the twin's latch.

**Known residual, NOT closed by this card (card `6be6c9ff`):** for a twin armed at MORE THAN ONE key,
the SAME `armedKeys`-empty gap means `armedKeysForEntry`'s one-key fallback only ever covers whichever
key phase 2's own iteration happened to land on — the twin's OTHER key(s) are never durably rewritten by
this call, even though `activeQuarantines` was re-pointed for all of them. This record's "complete" claim
does not extend to that shape; see card `6be6c9ff` for the multi-key gap itself and card `f00e9de8` for
the related question of an armed twin's own in-memory tokens being dropped by the re-point.

## Do not

- Do not move this skip into the ordinary (non-re-resolve) `indexOf`-found path — `clearMergeQuarantineByToken`'s
  own `activeMatches` filter already excludes an entry that is an active twin BY REFERENCE from
  `nonTwinPendingIndices` before this loop ever starts; this hazard only arises when a twin is
  DISCOVERED mid-loop via the re-resolve fallback, never for an entry whose wrapper was never replaced.
- Do not read the REMOVE scenario's safety as license to narrow the skip to the REDUCE case only — the
  skip condition (an active-twin reference) is the same regardless of which plan would have been
  derived; letting REMOVE "pass through" here too is what keeps the fix simple and correct for both, and
  avoids re-deriving (and risking drift on) the remove-vs-reduce distinction a second time, redundantly,
  right before immediately discarding it.
- Do not assume a bare `liveMatches.length === 0` is reachable via `protectOccupantContentBeforeDelete`'s
  own mutations — that is the ONLY path shown here, and every real branch there either re-points an
  EXISTING same-identity slot (preserving it) or mints an independent new one (never fewer); this says
  nothing about every OTHER function in this module. The 0-candidate test in
  `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs` exercises the defensive branch directly
  (via the `clearTokenFromPendingIndicesTestOnly` seam, with the SAME index passed twice) precisely
  because no cascade through protect's own mutations can produce it — do not try to "upgrade" that test
  to a construction routed only through protect; it would be testing a state THAT path cannot produce.

## Verification

- `merge-quarantine-0faffa95-active-twin-defer-to-phase2.mjs` — both scenarios above, asserting on-disk
  state (never memory alone): the twin's own latch no longer carries `token`, the stranded target's own
  pending-slot file is durably rewritten too, the surviving token (REDUCE) is preserved, and a simulated
  restart (fresh module re-import + `reenterMergeQuarantinesAtBoot`) does not resurrect `token`.
- `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs` — two added scenarios: a re-derive-to-REMOVE
  case (fresh `ownedArmedKeys`, the `indexOf(live)` splice path) and the fail-closed 0/>1 live-candidate
  path (>1 via a genuine untouched same-identity twin; 0 via the `TestOnly` seam, see the Do-not above).
- All `merge-quarantine*.mjs` run individually, in both env states (`env -u LOOM_DEV -u LOOM_SUPERVISED` /
  `LOOM_DEV=1 LOOM_SUPERVISED=1`), with a FRESH temp `LOOM_HOME` per file.
- `pnpm --filter @loom/daemon guards`, committed first.
