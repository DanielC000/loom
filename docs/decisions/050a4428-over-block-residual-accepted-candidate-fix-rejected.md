# 050a4428 — the over-block residual is ACCEPTED (unreachable in production); a candidate fix was REJECTED for introducing a worse, NEW fail-open

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 050a4428 — the over-block residual is ACCEPTED (unreachable in production); a candidate fix was REJECTED for introducing a worse, NEW fail-open

Discovered by card 4b06875f round 2 (worker 488af78d) as a FAIL-CLOSED residual, documented inline as an
ACCEPTED RESIDUAL comment pending this card's own investigation. **No fix landed. `merge-quarantine.ts`
is unchanged by this card.** The paragraphs below are kept, lightly trimmed, as the historical record of
what was tried and why each attempt was rejected or found moot — not as a description of current code.

### Step 1 — the original over-block, reproduced via an out-of-band mutation

A hermetic repro against the real compiled module (no mocking otherwise) showed: a dual-armed S [Ks, Kr],
D degraded at Kr with its own CURRENT resolvedKey=Ks (correctly excluded by `excludeLiftedResolvedKey`
when S is cleared, since Ks is one of S's own `liftedKeys`), plus a STALE in-memory
`pendingUnresolvedQuarantines` entry for D carrying a THIRD, genuinely UNRELATED key Kz, manufactured by
an out-of-band `fs.rmSync` of D's own pending-divert file AFTER boot loaded it — standing in for "memory
is stale, disk has since moved on," a shape that needed the out-of-band deletion to construct at all. The
second union's own conflict-guard (`unionQuarantineEntries`'s `symmetricKeyDifference`, gated on BOTH
sides' `informativeKeysFor` being non-empty) never engaged, because `toPersist`'s own informative-key set
was empty — so the plain legacy "one side undefined -> take the other" rule resurrected Kz
unconditionally. Measured consequence: a genuinely unrelated REAL repo Z whose own canonical key happened
to equal the resurrected Kz was reported QUARANTINED after a reboot — a pure over-block, fail-closed
only; nothing under-blocked.

### Step 1b — re-deriving reachability WITHOUT the out-of-band mutation: NONE FOUND

The Lead's own question: is there a PRODUCTION path (never an out-of-band test hack) that unlinks,
renames, or rewrites a pending-divert file while leaving its OWN (or an UNRELATED) surviving
`pendingUnresolvedQuarantines` entry stale/dangling? A full audit of every site that touches a
pending-divert file's disk bytes found none:

1. **All 9 `writePendingDivertFile(` call sites** (`protectOccupantContentBeforeDelete`,
   `consumeMatchedPendingsIntoArmedEntry`'s `foreignGroups`, `mergeTokenIntoPendingEntries`,
   `mintPendingDivert`, `divertRaiseEntry`, `rewriteOrphanLatchFilesAfterPartialClear`,
   `clearTokenFromPendingIndices`, the partial-clear dual-tracked-twin rewrite) each either update
   `pendingUnresolvedQuarantines` in the SAME call immediately before/after the write, re-insert the
   exact unchanged object when nothing changed, or match by OBJECT REFERENCE (never content/identity) —
   never leaving a surviving entry's own array slot stale while its file is rewritten to something else.
2. **`deleteSourceLatchIfSuperseded`** explicitly refuses to unlink a filename any surviving
   `pendingUnresolvedQuarantines` entry still names (`if (pendingUnresolvedQuarantines.some((p) =>
   p.sourceFile === sourceFile)) return true`).
3. **Every sweep/unlink helper** (`sweepOwnLatchFileUnlessOwnedElsewhere`,
   `sweepOrphanLatchFileIfUnreferenced`, `unlinkLatchFileConfirmed`) gates on
   `physicalOwnerRepoPaths`/`survivingSharedClaimRepoPaths`, both of which scan
   `pendingUnresolvedQuarantines` for ANY surviving entry naming that filename — not just the one being
   removed — before any unlink, and every call site removes the entry being cleared from memory FIRST.
4. **`rewriteOrphanLatchFilesAfterPartialClear` / `orphanRewriteOwnershipConfirmed`** was initially the
   one genuine candidate found independently — the SAME shape as card 29fe2372 (an orphan-reference
   rewrite that can't tell "this call's own identity" from "a different, independent record merely
   sharing that identity"). It is **already fixed on main**: layer 2, `anotherLiveEntryOwnsFile`, scans
   `pendingUnresolvedQuarantines` for any OTHER live entry (object-reference-distinct from the one being
   written) owning that exact filename, and refuses the rewrite if one exists.
5. **PASS 1b** builds `pendingUnresolvedQuarantines` fresh from a disk scan once per boot, and every
   write it performs is paired with its own `replaceEntryEverywhere` — memory and disk are consistent at
   the end of boot.
6. **`divertRaiseEntry`'s own write over an existing pending file** splices the matched OLD entries out
   of the array BEFORE writing, pushing the NEW merged entry back only after a successful write — or, on
   failure, leaves memory AHEAD of disk (see Step 2 below), never behind it.

**Conclusion: the Step 1 over-block is ACCEPTED as unreachable without an out-of-band mutation.** It
stays fail-closed, unfixed, exactly as main already behaves.

### Step 2 — the rejected fix ("arm 2"): reject when the first union's own informative-key set is empty

A candidate fix was drafted: capture the FIRST (disk-reconciled) union's own aggregate informative-key
set before the second (in-memory-sibling) union runs, and reject any resolvedKey/resolvedKeys value from
the second union whenever that first set is empty — the condition under which
`unionQuarantineEntries`'s own conflict-guard never engages. **REJECTED at Code Review (7b35b79f),
MAJOR 1**: this cannot distinguish a genuinely stale sibling (Step 1's shape) from a sibling that is the
SOLE SURVIVING COPY of a dual-armed twin's own secondary key, which is exactly what
`mintPendingDivert`/`divertRaiseEntry`'s own TRIPLE-FAULT path produces — a real, nameable production
path, not a contrived one:

`enterMergeQuarantine`'s `existing` branch (merge-quarantine.ts, the divert calls inside the
`mustDivert`/`"unreadable"` arms) diverts a raise into a dual-armed `existing` entry via
`divertRaiseEntry(baseEntry)`, which routes to `mintPendingDivert` (no prior same-identity pending record)
or its own inline merge-and-write. EITHER path can TRIPLE-FAULT on a genuine, ordinary `fs` I/O failure —
`writePendingDivertFile` (plain `fs.openSync`/`writeSync`/`renameSync`, no test gating) fails (ENOSPC,
EACCES, or a transient Windows `EBUSY` from an AV/indexer lock) AND `attemptDivertSafetyTmpFallback`
(also plain fs calls) ALSO fails — landing at the "Triple fault — nothing durable to re-point to; keep
the pre-existing (accepted-residual) shape" branch: `pendingUnresolvedQuarantines.push({entry,
sourceFile})`, an in-memory-ONLY entry carrying the twin's own genuinely-informative secondary key, with
ZERO backing file ever written anywhere. A LATER, same-identity `protectOccupantContentBeforeDelete`
call whose own freshly-read content carries no resolvedKey of its own (so the first union's own
informative-key set is empty, by genuine coincidence rather than staleness) would — under arm 2 — reject
that memory-only key too, silently dropping real, currently-enforced protection for the twin's own
secondary key. Per 4b06875f/883e29bc, `resolvedKey` is not decorative: it IS the post-reboot enforcement
mechanism for a dual-armed twin's own secondary key, so dropping it is a genuine, NEW fail-open — worse
than the accepted over-block it would have fixed.

Proven via a hermetic scenario built from the genuine triple fault (no out-of-band mutation — both the
read failure forcing the divert and the two divert-write failures are injected through the EXISTING
`fs.openSync`/`readFileSync` monkeypatch seams already established in
`packages/daemon/test/merge-quarantine-raise-protect-failure.mjs`, the SAME technique its own
`dd34da46/item3` and `EXISTING-BRANCH coverage` scenarios already use): **"CARD 050a4428,
MEMORY-ONLY-KEY GUARD"**. Step 1 establishes the triple fault (a dual-armed d3 [K3, Kw3], divert into it
fails on both writes). Step 2 raises an unrelated y3, which finds d3 degraded-occupying y3's own key with
ordinary, successfully-readable, no-resolvedKey content — exercising the SECOND union against the
Step-1 memory-only entry with no out-of-band step. On **main**: Kw3 survives in the protective copy, and
(after removing d3's own original physical file — a genuinely redundant, independent source of Kw3 that
the divert never touched, so the reboot check isolates the mechanism under test rather than being masked
by it) a real repo at Kw3 stays blocked after a reboot. A **surgical control** (arm 2 applied temporarily,
rebuilt, reverted byte-identical before commit) turned BOTH of those checks RED — confirming the Code
Review's own concern was real.

### Correcting a false claim from an earlier draft of this record

An earlier draft of this Follow-up asserted "`resolvedKey`/`resolvedKeys` are additive, defensive
over-blocking only... never the sole carrier of D's own real enforcement." **That claim is FALSE and is
retracted.** The MEMORY-ONLY-KEY GUARD scenario above is a direct counter-example: after the triple
fault, `resolvedKey` genuinely IS the sole surviving record of Kw3's own enforcement once the twin's
original physical file is gone — losing it is a real loss of enforcement, not merely "less defensive
over-blocking." Per 4b06875f ("keep a resolvedKey-armed twin blocking its key after a reboot") and
883e29bc, `resolvedKey` is load-bearing POST-REBOOT ENFORCEMENT for a dual-armed twin's own secondary key.
Any future fix attempt in this area must not re-derive the "purely additive" framing as a safety
argument — it is exactly backwards.

### Decision

Revert the fix attempt entirely — `merge-quarantine.ts` is byte-identical to its pre-card state. Keep
only the MEMORY-ONLY-KEY GUARD scenario (`packages/daemon/test/merge-quarantine-raise-protect-failure.mjs`),
proven GREEN on main and RED against the rejected arm-2 control, as a standing regression guard against a
future attempt reintroducing the SAME fail-open. No scenario for the Step 1 over-block itself was kept in
the suite — it reproduces only via the out-of-band mutation this record's own Step 1b found no production
substitute for, so a committed scenario for it would be a scenario for an UNREACHABLE shape, not a
regression guard.

### Interaction with card 398f476c

Unaffected either way. 398f476c is about a union being structurally unable to represent more than one
identity's own queryability at once — a full identity-model redesign; this card's own residual and
rejected fix never touched that scope and neither blocks nor needs it.

### Do not

- **Do not reject a sibling's resolvedKey/resolvedKeys value based on the disk (first-union) side being
  empty** — it cannot distinguish a genuinely stale sibling from the SOLE SURVIVING, memory-only copy of
  a dual-armed twin's own secondary key left by a real triple fault (see "CARD 050a4428,
  MEMORY-ONLY-KEY GUARD" in `merge-quarantine-raise-protect-failure.mjs`) — rejecting on that basis is a
  NEW fail-open, strictly worse than the accepted over-block it would fix.
- Do not revert to the EARLIER "blanket zero" design either ("force `resolvedKey`/`resolvedKeys` to
  `undefined` whenever this call's own adjudication excluded anything") — it fails open for the SAME
  reason, one step earlier: it cannot tell a legitimate key the disk-reconciled side genuinely carries
  apart from one that was adjudicated away.
- Do not treat `resolvedKey`/`resolvedKeys` as "purely additive, defensive over-blocking, safely
  droppable" — see the correction above. Any future design in this area must show it preserves a
  dual-armed twin's own secondary-key enforcement across a genuine triple fault, not just across an
  ordinary clear.
- Do not re-attempt a fix for the Step 1 over-block without first re-deriving Step 1b's own reachability
  audit fresh against whatever the code looks like by then — it is judgment-curated by reading each call
  site, not a filename grep, and a future change to any of the sites named above could reopen the gap.
