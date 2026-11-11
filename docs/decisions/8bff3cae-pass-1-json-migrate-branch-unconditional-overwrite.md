# 8bff3cae — PASS 1's own .json migrate branch had the same unconditional-overwrite shape 1e739f4a flagged but never reproduced

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 8bff3cae — PASS 1's own `.json` migrate branch had the SAME unconditional-overwrite shape Follow-up 1e739f4a's own "Do not" section flagged but never reproduced

Card `8bff3cae`, filed by the Lead directly off that "Do not" bullet: "a THIRD near-identical arbitration
site (PASS 1's own `.json` migrate branch, `entry.resolvedKey = currentKey`) has the SAME
unconditional-overwrite SHAPE but was explicitly left untouched — flagged, not reproduced." This card's own
worker ran INVESTIGATE-FIRST (hermetic repro, temp `LOOM_HOME`, real git repos, no source edit until the
Lead ruled) and confirmed TWO independent fail-opens, both closed by the SAME fix below.

### Repro 1 — a legacy (pre-43cf3b26) scalar-only dual-arm is discarded with no array to fall back on

A record written by code predating card `43cf3b26` (no `resolvedKeys` field exists yet) already carries an
informative scalar `resolvedKey` naming a genuine cross-repo dual-arm partner (the 4b06875f/48bda567
shape) — the SAME shape Follow-up 1e739f4a's own Fix 1 protects at the PHASE 2 promote site. PASS 1's
migrate branch (`entry = {...entry, resolvedKey: currentKey}`) overwrote that scalar unconditionally, with
nothing folding the discarded value into `resolvedKeys` first (the field didn't exist when this record was
last written, so there's nothing to fall back on). The dual-arm partner (the witness) goes unblocked on
the SAME boot the migrate runs, and stays unblocked across reboot-sims — a real, durable upgrade-window
regression, confirmed via `merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs`'s own
`legacy-scalar-dual-arm` scenario (RED on `d694e77d` before this card's fix, same-boot AND both reboot
legs; GREEN after).

A CONTROL (`current-format-pin`, same shape but `resolvedKeys` already carries the dual-arm key — a
record already written by 43cf3b26-generation code) was ALREADY green before this card's fix: the write
chokepoint's own `unionResolvedKeysRetaining` fold already covers it. This bounds the bug precisely to the
legacy, scalar-only, no-array case — once a record has been through one post-43cf3b26 write, this gap
cannot recur for it.

### Repro 2 — a shared-ancestor-key sibling loses its OWN enforcement when the other side diverges

A SECOND, independent fail-open with no dual-arm at all. A plain subdir (no `.git` of its own) collapses
onto its parent repo's own canonical key (7673d096's toplevel walk) — if the subdir itself raises a
quarantine while in that state, the physical file is filed at `sha256(parentKey).json`, so the PARENT
repo's own enforcement is, in practice, backed by that exact file (both repoPaths genuinely share one
key). If the subdir LATER gains its own `.git` (its canonical key diverges from the parent's), PASS 1's
migrate branch moved that file to the subdir's own new key with no check for whether the STALE key it was
abandoning still names a DIFFERENT, currently-registered, resolvable repo — the parent's own identity
never changed at all, yet it went unblocked the instant the unrelated sibling's own key happened to
diverge. Confirmed via the same test's `shared-ancestor-sibling-survives-divergence` scenario (RED on
`d694e77d`, both the migrate boot and a second reboot-sim; GREEN after).

This is the manager's own probe question, answered with evidence — but the premise needs correcting
first (CR `0b975d2a`, MINOR (a)): the code does NOT drop the record's own old key at all. Source (a)
(below) ALWAYS keeps the migrating record's OWN already-self-stamped scalar `resolvedKey` (its own prior
key, from the write that stamped it there) — the Lead's ruling is that this is **intentional and
fail-closed**, not a residual: it keeps enforcement pinned to the EXACT path that was originally
quarantined, even after the migrate. The accepted consequence is that if a NEW, unrelated repo is later
re-`init`-ed at that exact old path (reusing the same real filesystem location), it inherits the stale
block too, until a human clears it — an over-block, never an under-block, and the SAME direction
`92c645cc`'s own accepted PASS-1-vs-PASS-1b asymmetry already lives with. What source (b) is actually for
is the SEPARATE, genuinely new fail-open this card closes: a DIFFERENT, currently-registered, resolvable
repo (never the migrating record's own prior self) whose key happens to still hash to the exact same
stale filename right now — the shared-ancestor-collapse shape above. That other repo's own key is always
recomputed fresh from its own registered path, never guessed from the hash — but see CR `0b975d2a`'s
BLOCKING finding below for why a naive version of that recompute was still wrong.

### The fix — two sources, no new mechanism; the SECOND source is deferred, not inline

Immediately before `entry = {...entry, resolvedKey: currentKey}`:
- Source (a), folded in RIGHT THERE, inline: if `entry.resolvedKey` is informative relative to
  `currentKey` (`isInformativeKey`, the SAME helper Follow-up 1e739f4a's Fix 1 and the write chokepoint
  already share), fold it into `entry.resolvedKeys` via `unionResolvedKeysRetaining` before the scalar
  overwrite runs. Safe inline because it is THIS entry's own, already-recorded secondary identity — no
  cross-entry race to get wrong.
- Source (b), queued into `staleKeyRetentionCandidates`, resolved LATER: look up `hashToRepo.get(hash)` —
  the SAME map, built once above from `registeredRepoPaths`, the corrupt-parse branches already use for
  the identical purpose. If a match exists and its own `canonicalRepoLockKey` differs from `currentKey`,
  queue `{currentKey, staleKey}` — never fold it in immediately.

**Round 1 of this fix (REVERTED before merge, caught by this card's own DoD re-run, never shipped)** —
folding source (b) in immediately, inline, alongside (a): reproduces as a NEW regression against
`merge-quarantine-migrate-source-owner-durable.mjs` (card `97cff6db`) — proven RED by re-running that
file directly, GREEN once reverted. Two of its own scenarios share the EXACT shape this card's own
`shared-ancestor-sibling` repro does (a plain subdir's stale key coincides with ANOTHER registered
repo's current key) — but there, that OTHER repo (`teamA`, or `sub`'s true owner) has its OWN
quarantine data of some kind THIS SAME BOOT (a clean parse OR a corrupt tmp), landing on the SAME
physical file via its OWN independent primary arm. Folding the stale key in at READ TIME, before that
OTHER entry has had its own chance to arm, let `armQuarantineKey`'s own union logic merge the migrating
entry's content INTO that other, unrelated entry — corrupting it (a corrupt-tmp placeholder's content
silently inheriting a stale sibling's tokens, caught by `round3-minor4-deferred-corrupt-placeholder-
survives-phase3-delete`'s own content assertion). An earlier narrower attempt (checking `byRepoKey.has`
right after PASS 1's own read loop, or checking for another physically-identically-NAMED file via
`files.some(...)`) failed the SAME regression for two DIFFERENT reasons: the former runs before a
corrupt-tmp-derived placeholder (armed+written DEEP inside its own later resolution cascade, not at
PASS 1's own read loop) has had its chance; the latter only catches a literal filename collision, never
a DIFFERENT, differently-named file that shares the same CANONICAL KEY (the `!stale-teamA-*.json` shape).

**The fix (SHIPPED):** resolve `staleKeyRetentionCandidates` in ONE pass, placed immediately before
PASS 1's own migrate-WRITE phase — after EVERY other way this boot can independently arm a key (clean
parse, corrupt `.json`, corrupt tmp, safety-tmp recovery) has already fully settled into `byRepoKey`,
and before any of THIS pass's own writes run. For each candidate: if `byRepoKey.has(staleKey)` — some
OTHER repo's own primary arm (of ANY shape) already, legitimately covers it — leave it alone entirely.
Otherwise, arm `staleKey` as the migrating entry's own secondary via the SAME `armKeyUnlessDegradedCollision`
primitive the existing per-file secondary-arm loop already uses.

No new field, no new map, no new cap — every primitive reused (`isInformativeKey`, `hashToRepo`,
`unionResolvedKeysRetaining`, `armKeyUnlessDegradedCollision`) was already built for a sibling purpose;
only the ORDERING (collect during the read loop, decide once, late) is new, and it mirrors this same
function's own pre-existing `migratedSourcesByKey`/`degradedOccupiedKeys` collect-then-write discipline.

### Round 2 (Code Review `0b975d2a`) — a LEGACY-tier `hashToRepo` match can recompute to an ANCESTOR's key, not `hash`'s own true owner, durably blocking an unrelated repo

**BLOCKING.** `hashToRepo` (built once, above PASS 1's own read loop) has TWO tiers: a FRESH tier
(`quarantineHashFor(p)`, only for a currently-resolvable `p` — by construction, `canonicalRepoLockKey(p)`
always hashes back to exactly this value) and a LEGACY tier (`legacyQuarantineHashFor(p)`, set
UNCONDITIONALLY for every registered `p` regardless of resolvability — a repo's own RAW realpath, never
toplevel-walked). Source (b) matched on `hashToRepo.get(hash)` and then recomputed
`canonicalRepoLockKey(staleKeyStillOwnedBy)` FRESH — correct when the match came from the fresh tier
(the recompute reproduces the SAME hash by construction), but NOT when it came from the legacy tier: a
registered repo `T` that HAD its own `.git` at raise time (so its legacy hash equals its OWN raw path's
hash) can later LOSE that `.git` — `canonicalRepoLockKey(T)`, recomputed now, toplevel-walks up to
whatever ancestor DOES still have a `.git` (its parent `P`), a DIFFERENT value than the hash that matched.
The pre-fix code trusted the recompute anyway, queuing `P`'s own key as "the stale key to retain" —
durably arming an entry that was never, at any point, meaningfully associated with `P` at all: `P`
durably blocked, and its only remedy (clearing `P`) collaterally lifts `X`'s own, genuine block too — a
human cannot clear the WRONG block without also destroying the RIGHT one.

Reproduced hermetically by the reviewer (`probe1.mjs`: outer repo `P`; `T = P/t`, its own repo; `X =
T/sub`, a plain subdir of `T` that raises while collapsed onto `T`'s own key; then `T`'s `.git` is
removed and `X` gets its own `.git` instead) before any further source edit — RED at commit `085aff66`
(`P` durably blocked on every boot after the migrate), confirmed still RED there independently by this
card's own worker, and confirmed GREEN only after the fix below.

**The fix:** before queuing a source-(b) candidate, re-verify that the freshly-recomputed key's OWN hash
still equals `hash` — `quarantineHashForKey(staleKeyStillLive) === hash`. This is automatically true for
a fresh-tier match (true by construction) and is exactly the check that rejects a legacy-tier match whose
owner has since lost its own `.git` — no new field or map, the SAME `quarantineHashForKey` helper the
write chokepoint already calls.

### Do not

- Do not fold source (b) in INLINE, at PASS 1's own read-loop time, even if it looks like the exact same
  shape as source (a) — Round 1 above (REVERTED before merge, see "The fix" above for the full narrative)
  is the record of exactly why: a not-yet-read sibling's own primary arm for that same key must be given
  its full chance first, including the corrupt-tmp cascade's own LATE, deep-inside-its-own-resolution
  arm+write — resolve `staleKeyRetentionCandidates` in the ONE deferred pass only, at its current
  placement (immediately before PASS 1's own migrate-write phase).
- Do not trust a `hashToRepo.get(hash)` match's freshly-recomputed `canonicalRepoLockKey` without
  re-verifying `quarantineHashForKey(that key) === hash` first — Round 2 above is the record of exactly
  why: the LEGACY tier can match on a repo's own raw path that no longer represents its current
  toplevel-walked identity, and trusting the recompute anyway arms a wrong, unrelated ancestor key.
- Do not read source (a)'s own old-key retention as a residual to someday "fix" — it is the Lead's own
  intentional, fail-closed ruling (see Repro 2's closing paragraph above); the one accepted consequence
  (a later re-`init` at the exact same old path inherits the stale block) is a DELIBERATE over-block, not
  an under-block, and needs no remedy beyond the existing human clear path.

### Tests

`merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs` (new, 5 scenarios): `legacy-scalar-dual-arm`
and `shared-ancestor-sibling-survives-divergence` (both RED on `d694e77d`, GREEN after, asserted through
`assertRepoNotQuarantined` across same-boot + two reboot-sims), `current-format-pin` (the control, green
both before and after — proves the fix is additive, never a behavior change to the already-correct array
path), and two Round-2 additions turning the reviewer's own hermetic probes into committed regression
tests: `legacy-tier-match-never-blocks-unrelated-repo` (named for the `hashToRepo` LEGACY tier it
exercises, never "ancestor tier" — that name belongs to the unrelated `ancestorHashToRepo` mechanism;
`probe1.mjs`'s own P/T/X shape — asserts P stays UNblocked and X stays blocked across 3 reboots, plus
that clearing the never-blocked P genuinely reports `wasQuarantined:false` via
`clearMergeQuarantineReporting` — NOT the originally-shipped check, which read `clearMergeQuarantine`'s
own `void` return and so passed vacuously regardless of whether P was blocked; re-verified by this card's
own worker to go RED, specifically on this real check, with the hash-equality guard removed (`tsconfig.
tsbuildinfo` cleared before each rebuild) — and that clearing P never collaterally lifts X's own genuine
block either; RED at `085aff66`, GREEN after) and `realistic-raise-source-a-retention` (`probe2.mjs`'s
own shape — a REAL `enterMergeQuarantine` raise rather than a hand-crafted `.json` final; RED on
`d694e77d`, GREEN after). **CR `0b975d2a` round 2 correction:** that last scenario NEVER reaches source
(b) at all — the migrating record's own self-stamped scalar (source (a), always retained, see Repro 2's
closing paragraph) is what keeps `R` blocked, so it stays green even with the hash-equality check removed
AND with source (b) disabled entirely (both independently re-verified by this card's own worker). It is a
realistic-record-SHAPE regression pin for source (a), never evidence for source (b)'s own over-filter
direction — only `shared-ancestor-sibling-survives-divergence` (whose hand-crafted stale file carries NO
self-stamped scalar) actually exercises (b), and it alone goes RED when (b) is disabled.
`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-migrate-resolvedkey-8bff3cae.mjs --ref d694e77d`
independently proves RED→GREEN→clean-tree for the whole file.
`merge-quarantine-migrate-source-owner-durable.mjs` (card `97cff6db`) is explicitly re-confirmed green —
it is what caught Round 1 of this fix as a regression (see "The fix" above) and is the one file in this
card's own DoD sweep most likely to catch a reversion of the deferred-resolution ordering. All 37
`merge-quarantine*.mjs` files plus every other test importing `merge-quarantine.js` (51 files total)
re-run clean under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`; `pnpm --filter @loom/daemon
guards` all pass; `node packages/daemon/assets/comment-anchor-lint.mjs .` reports `orphanAnchors: 0`.
