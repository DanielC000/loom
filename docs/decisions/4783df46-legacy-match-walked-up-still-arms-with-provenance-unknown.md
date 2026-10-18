# 4783df46 — a mismatched LEGACY-tier match still arms fail-closed, now carrying `provenanceUnknown`

From 8bff3cae's own CR round 2 (reviewer `dca09063`) — pre-existing, not part of that card's delta.
8bff3cae/3a9e0027 fixed this shape (source (b): never trust a LEGACY-tier `hashToRepo` match's current key
without re-verifying it still hashes to the file's stale filename) for PASS 1's migrate branch (a clean,
parseable latch). This card is the same shape at the TWO sites 3a9e0027 never touched:
`reenterMergeQuarantinesAtBoot`'s deferred corrupt-latch loops — `deferredCorruptJsons` and its
`.json.tmp-<pid>` twin `deferredCorruptTmps`.

## The bug

Both sites match a corrupt latch's hash via `hashToRepo.get(hash)`, which can hit the LEGACY tier —
`legacyQuarantineHashFor(p)`, a FROZEN hash of `p`'s own direct (never-walking) path, indexed for every
registered `p` regardless of resolvability. A hit is a real identity fact about `matchedRepo` — but both
sites then armed/wrote a placeholder at `key = canonicalRepoLockKey(matchedRepo)` with NO check that `key`
is still `matchedRepo`'s own VERIFIED identity. `key` can mismatch the hash for TWO reasons, and this fix
deliberately does NOT distinguish them: `matchedRepo` lost its own `.git` and walked up to an ancestor; OR
it was NEVER its own toplevel — a pre-`7673d096` project bound to a plain subdir of a shared repo (e.g. a
vault project inside a shared vault repo). Either way the placeholder lands at a DIFFERENT repo's key.

**Repro (P/T/X, matching 8bff3cae's test's `legacy-tier-match-never-blocks-unrelated-repo` and the
reviewer's `probe5-r2.mjs`):** `P` a real repo; `T=P/t` starts with its own `.git`; a CORRUPT latch is
filed at `sha(canonicalRepoLockKey(T))`. `T` loses its `.git` (collapsing onto `P`'s key); `X=T/sub` gets
its own `.git`. Pre-fix: `P blocked=true` (WRONG), `T blocked=true`, `X blocked=false` (`X`'s true
identity is unrecoverable from a corrupt latch under ANY design). Confirmed hermetically, both shapes,
both `LOOM_DEV` states, INVESTIGATE-FIRST, before any source edit.

## The divert hazard (why the "obvious" fix doesn't work)

Tested whether a mismatched match should DIVERT to `pendingUnresolvedQuarantines` instead (mirroring
`f5c42043`'s ancestor tier), via the real `reenterMergeQuarantinesAtBootTestOnly` injection hook (no
source edit): `P` reads open right after boot, but the FIRST query of `T` triggers
`activeMergeQuarantineFor`'s own lazy-graduation path, which arms unconditionally at the query's fresh key
with NO verification — since `T` never regains its own `.git`, that graduation durably arms `P`'s key
anyway. Diverting only DELAYS the same false positive from boot time to query time; it never avoids it.
Confirmed both `LOOM_DEV` states.

Generalizes: `activeMergeQuarantineFor`'s lazy-graduation has no test coverage for a claimant degrading
directly into an already-registered, resolvable, distinct SIBLING (every `f5c42043`/`883e29bc` scenario
remounts with its own `.git`, or degrades into an unregistered ancestor). Tracked separately — out of
scope here.

## The ruling

Keep arming FAIL-CLOSED at the mismatched key at both sites — unchanged arm/clear DECISION — but mark
`provenanceUnknown: true` so the existing remediation machinery (`82032b5c`/`9a55fb90`) refuses a bare
clear-by-id and names the affected repo(s), plus a loud `console.warn` and a `reason` saying the current
key "no longer hashes to this file (walked up, or a pre-`7673d096` subdir binding)". Reasoning (Lead):
`X`'s true identity is unrecoverable under EITHER design — the only axis that moves is whether `P` is
blocked NOW (visible, human-clearable) or LATER at an unpredictable query (the divert hazard, plus a
transient fail-open window). Hardening lazy-graduation risks regressing `f5c42043`/`883e29bc` for a rare
shape — carded separately.

The hash check — `quarantineHashForKey(canonicalRepoLockKey(matchedRepo)) === hash` — is ONE shared
helper, `legacyMatchStillResolvesToHash(key, hash)`; 3a9e0027's own PASS1-migrate check (source (b)) now
calls it too — one copy across all three call sites.

## Do not

- Do not divert a mismatched legacy match to pending as "the fix" — lazy-graduation re-arms the same key
  the moment anything queries it. See "The divert hazard".
- Do not harden lazy-graduation as part of THIS card — shared with `f5c42043`/`883e29bc`; own card.
- Do not hand-roll a second hash-equality check — call `legacyMatchStillResolvesToHash`.
- Do not read `provenanceUnknown:true` as an arm/clear DECISION change — only remediation TEXT and the
  clear-by-id REFUSAL change (verified: armed key / blocked set / clear-by-path success are identical).
- Do not assume a verified (non-mismatched) match gets `provenanceUnknown` — the helper returns `true`
  there; the positive-control scenario pins clear-by-id still succeeds.
- **(CR round 2, MAJOR)** Do not write a NEW placeholder at a corrupt-latch site without tracking/deleting
  the superseded SOURCE file it replaces. `deferredCorruptTmps`'s "no real sibling data" branch did this
  (pre-existing, fixed this round): it wrote a fresh placeholder but never unlinked the original corrupt
  tmp `f`. Two failures from one gap: a successful clear-by-path doesn't survive a reboot (the SAME
  leftover tmp re-arms the repo); and a verified-case leftover gets re-read + UNIONED into the real entry
  EVERY boot (a `placeholder:true` final never marks `cleanlyParsedKeys`, so the "already covers" unlink
  shortcut never fires), growing its token set by one per boot forever. Fixed via
  `deleteSourceLatchIfSuperseded(f, armed, key)` (same helper the json site's own delete uses), called
  synchronously right after a successful `bootWriteLatch` — never deferred, since a `.json.tmp-<pid>`
  basename can't collide with another key's write target this pass. On a GENUINE unlink failure (a
  directory-shaped residue, or any other non-ENOENT error), fold `f` into `orphanLatchFiles` and
  re-persist via `replaceEntryEverywhere` + `bootWriteLatch` (mirrors `c870618c`'s own fold-on-failure
  shape) — this fold is LOAD-BEARING, not defensive dead code: it is the only thing that keeps a residue
  the unlink itself could never remove from being silently dropped off this entry's own bookkeeping.
  Pinned directly (CR round 2's own `unlink-failure-folds-into-orphanlatchfiles` scenario, added one
  re-review later, via a directory fixture that forces a genuine EPERM/EISDIR, never ENOENT) — note that
  scenario deliberately does NOT assert "stays open across a reboot": an undeletable residue re-arms the
  repo every subsequent boot regardless of the fold, which is expected, not a defect the fold is meant to
  close.

## Verification

`test/merge-quarantine-legacy-match-walked-up-4783df46.mjs`, FIVE scenarios, one process (shared
`LOOM_HOME`, reset between scenarios — the production `LOOM_HOME` const is frozen at first import): json
core repro, tmp (the actual MAJOR bug site), a positive/negative control (verified match, no
`provenanceUnknown`), a token-growth pin (4 reboots, `tokens.length === 1` every time), and (CR round 2,
added one re-review later) an unlink-FAILURE fixture — a directory-shaped tmp residue forces a genuine
EPERM/EISDIR, never ENOENT — pinning the fold into `orphanLatchFiles`. Scenarios 1/2 capture
`console.warn`, assert the wording + the placeholder's `reason`, pin blocked/open/`provenanceUnknown`/
clear-by-id-refuses/clear-by-path-works, AND reboot AFTER the clear to assert the repo stays open AND the
corrupt source file is gone from disk. Green, both `LOOM_DEV` states.

RED/GREEN: round 1's assertions were confirmed against the pre-fix source during INVESTIGATE-FIRST. The
MAJOR fix's six regression-pin assertions were verified by reverting ONLY the
`deleteSourceLatchIfSuperseded` tracking hunk, clearing `tsconfig.tsbuildinfo`, rebuilding, confirming
exactly those six went RED, then restoring BYTE-IDENTICAL (`cmp`-verified) and rebuilding. The fold-on-
failure scenario's own single new assertion was verified the same way, reverting only the fold's body.

Also run clean: every other `merge-quarantine*.mjs` (40 total), the listed importer tests, `pnpm --filter
@loom/daemon guards`, and the comment-anchor lint — see the worker report for the exact list.

**Out of scope (carded separately):** the corrupt SAFETY-tmp recovery path diverts a mismatched-key match
to pending WITHOUT `provenanceUnknown` — a different pre-existing gap. Do not fold it in on "same shape"
— it diverts, which the divert hazard found unsafe for THESE two sites; whether that applies there too is
for the separate card.

## Follow-up f118b475 — the corrupt SAFETY-TMP recovery site closes the gap flagged above

The "Out of scope" note above is now closed. `reenterMergeQuarantinesAtBootImpl`'s corrupt SAFETY-TMP
recovery loop (the `for (const f of safetyTmpFiles)` loop's own `catch` branch) used to route EVERY tier
of its `hashToRepo`/`unresolvedClaimantsByHash`/`ancestorHashToRepo` fallback cascade through one
`pushPlaceholder()` helper that unconditionally diverted to `pendingUnresolvedQuarantines` — including the
first two tiers, which (per this card's own ruling) must arm instead. The same divert hazard this record
already proved (lazy-graduation re-arms the walked-up key unconditionally at query time anyway) applies
identically here — diverting never avoided the false positive, it only delayed it to the first query.

**The fix mirrors TWO different siblings for TWO different concerns — stated precisely, not as one bare
"mirrors exactly" claim (that wording was imprecise in the original round and corrected here):**

1. **For the ARM-AND-PROVENANCE decision**, it mirrors `deferredCorruptJsons`/`deferredCorruptTmps`
   exactly, scoped to their first two tiers only: gate on `isRepoPathCurrentlyResolvable(matchedRepo)`
   (unresolvable ⇒ unchanged divert, no `provenanceUnknown`); when resolvable, compute `key =
   canonicalRepoLockKey(matchedRepo)`, call the SAME shared `legacyMatchStillResolvesToHash(key, hash)`,
   arm fail-closed at `key` via `armCurrentKeyUnlessDegradedCollision` regardless of the result, and set
   `provenanceUnknown: verified ? undefined : true` with matching warn/reason text. The THIRD
   (ancestor-only) tier is byte-unchanged — per `f5c42043`'s own ruling it stays a pure, unconditional
   pending-divert, never arm/write.
2. **For the DEGRADED-OCCUPIED self-reference**, it mirrors the CLEAN-PARSE branch in this SAME
   safety-tmp loop (`@decision 97cff6db`, round 3, finding E) — NOT `deferredCorruptJsons`/
   `deferredCorruptTmps`, which never need this check inline at all: their own migrate sources instead
   flow through the SHARED `migratedSourcesByKey`/Phase-1b mechanism, which already has its own
   dedicated degraded-occupied handling (folding sources into `orphanLatchFiles` + a protected
   self-reference) generically, for every migrate source. The safety-tmp recovery loop's own tracking
   (`safetyTmpRecoveryByFile`) has no such shared phase — the clean-parse branch handles its
   degraded-occupied case INLINE, right where it arms, and `resolveAndArm` needed the identical inline
   check (see "Code Review round: a CRITICAL over-unblock" below — this was missed in the first round).

**Durable write, never a new inline write (882d6cff's own rule):** the armed placeholder is tracked via
`safetyTmpRecoveryByFile.set(f, key)` — the SAME end-of-boot write/unlink pass the try-branch's own
successfully-parsed safety-tmp entries already use (`bootWriteLatch(key, unionEntry)` then `unlinkSync(f)`
on success, else log + leave the residue in place). No new write pass was added; arming only mutates
`byRepoKey` in-memory, mid-loop, exactly like the existing try-branch already does.

**Verified via `test/merge-quarantine-legacy-match-walked-up-4783df46.mjs`, three new scenarios:**
`walked-up-safety-tmp-arms-ancestor-with-provenance-unknown` (the core P/T/X repro, mirroring scenarios
1/2 exactly for the safety-tmp shape — warn text, `provenanceUnknown`, clear-by-id refuses, clear-by-path
works, reboot survives with the residue gone), `non-walked-legacy-match-safety-tmp-no-provenance-unknown`
(the positive control, mirroring scenario 3), and `safety-tmp-write-failure-leaves-residue-in-place` (a
manager-requested addition: when the end-of-boot write genuinely fails, the residue stays on disk rather
than being lost). The write-failure scenario uses an EXISTING technique — empirically verified first via
a scratch probe, no production seam added — planting a directory at the key's own `final` write path to
force a genuine `EPERM`/`EISDIR` on `fs.renameSync`, the same class of trick scenario 5 already uses for
an unlink failure. **Disclosed, not hidden:** because that `final` path also ends in `.json`, PASS 1's own
file scan independently treats the same directory as the matched repo's own corrupt `.json` final (a
pre-existing, already-tested code path) and unions its placeholder with the safety-tmp site's — this is
structurally unavoidable (every write target here is, by construction, a path PASS 1's own scan also
reads) and does not undermine the scenario: the discriminating check (confirmed via negative-control) is
the specific log line this card's own new write/unlink pass emits on a write failure, which fired on
GREEN and did not fire on RED (old code logged a different message via its own divert+absorb path
instead); the "T blocked"/"residue survives" outcomes alone are NOT discriminating, since old code
produced the same surface outcome for the unrelated, coincidental reason that it never attempted this
write at all.

Negative control: `scripts/negative-control.mjs --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-legacy-match-walked-up-4783df46.mjs` — RED (reverted to HEAD): 6
checks failed (5 in the core-repro scenario, 1 the write-failure scenario's own discriminating
precondition); GREEN (restored): all checks pass; tree restored byte-identical.

## Code Review round: a CRITICAL over-unblock the first round missed

The first round's `resolveAndArm` armed its placeholder at a degraded-occupied key with NO self-reference
of its own — exactly the gap the clean-parse branch's `@decision 97cff6db` (round 3, finding E) already
closed a few lines above it in this SAME loop, which the CR's repro proved reachable and harmful:

**Repro (CR-supplied, re-verified by this worker against this worktree's own build before any fix was
written):** `X` is a path that NEVER exists, with a real `.json` final at `sha(ksub)` recording
`resolvedKey: ksub` (so `ksub` lands in `degradedOccupiedKeys`). `sub` is a genuinely resolvable nested
repo whose OWN current key is `ksub`, with a CORRUPT safety-tmp residue beside X's final (same hash,
`.tmp-safety-<pid>-<hex>` suffix). On boot: `resolveAndArm` arms sub's synthetic placeholder at `ksub`,
which `armQuarantineKey` UNIONS into X's own entry (X's real, non-placeholder shape wins the union's
identity, per `unionQuarantineEntries`' placeholder-vs-real tie-break). The end-of-boot write is correctly
refused (`bootWriteLatch`'s own `degradedOccupiedKeys` check), so the residue is kept on THIS boot — but
with no self-reference, an ORDINARY clear of the wholly UNRELATED `X` later lets
`sweepTmpResidueForHashIfUnreferenced`/the sweep machinery treat the residue as unreferenced and durably
unlink it, and `sub` reads open afterward — DURABLY, surviving a reboot. Pre-fix (parent commit, before
any of card f118b475's work), `sub` stayed blocked through the identical sequence — this is a genuine
regression introduced by the first round's own fix, not a pre-existing gap.

**The fix:** mirror the clean-parse branch's own finding-E check exactly, inside `resolveAndArm`'s
resolvable-arm branch, right after `safetyTmpRecoveryByFile.set(f, key)`: when `degradedOccupiedKeys.has(key)`,
ALSO push a pending reference built from the PRE-union `placeholder` (never the armed/unioned result,
mirroring the clean-parse branch's own use of pre-union `entry`), self-referencing `f` in its own
`orphanLatchFiles`. Verified via a new scenario (`safety-tmp-degraded-occupied-key-self-references`,
modeled on `merge-quarantine-migrate-source-owner-durable.mjs`'s own `round3-E-degraded-occupied-
source-clobbered` scenario, adapted to the CORRUPT-residue shape) — clears X, then asserts `sub` is
STILL blocked, both in-process and after a reboot. Negative control: RED on the pre-self-reference code
(both the same-process and post-reboot assertions failed), GREEN after, tree restored byte-identical.

**Every OTHER difference between `resolveAndArm` and the clean-parse branch, checked and reasoned
through (per the CR's own instruction, not just the one that mattered):**
- *Content source:* the clean-parse branch carries forward real parsed fields (`resolvedKey`,
  `resolvedKeys`, `contributorRepoPaths`, `provenanceTracked`, pre-existing `orphanLatchFiles`);
  `resolveAndArm`'s placeholder is synthetic (corrupt content, nothing to carry forward) — same posture
  as `deferredCorruptJsons`/`deferredCorruptTmps`'s own placeholders.
- *`detectUnknownProvenance`:* the clean-parse branch calls it unconditionally (a signature-mismatch
  heuristic over `resolvedKey`/`contributorRepoPaths`); `resolveAndArm` never does, because its
  placeholder carries neither field — calling it would be a structural no-op. Matches the json/tmp
  sibling sites, which don't call it for their own placeholders either.
- *`orphanLatchFiles` self-strip (`fd189d91`):* the clean-parse branch strips `f` from a PARSED
  `orphanLatchFiles` that might already self-reference it; `resolveAndArm`'s synthetic placeholder never
  has an `orphanLatchFiles` field to strip from — nothing to do.
- *Secondary-key dual-arm (`secondaryKeysToAttempt`):* **corrected** — the clean-parse branch calls this
  on the UNION (`armedSafety`, the primary arm's own return value, ~:5373), never on the raw parsed
  entry. `resolveAndArm` skips it not because its placeholder lacks a parsed `resolvedKey` (that's true
  but not the reason), but because the placeholder adds NO key knowledge of its own — and `armQuarantineKey`
  (~:877) already re-sets the PRIOR's own keys into the union's `armedKeys` on every arm, primary or
  secondary. Extending the prior's own claim to a second key is `armQuarantineKey`'s job when the prior
  itself carries one; `resolveAndArm` deliberately does not try to re-derive or widen it from a
  content-less placeholder — not extending the prior's claim is the conservative choice.
- *Degraded-occupied self-reference:* was MISSING — this round's CRITICAL fix, above.
- *End-of-function delete mechanism:* previously a bare best-effort `unlinkSync` for both branches' own
  `safetyTmpRecoveryByFile`-tracked entries (unlike the json/tmp siblings' own migrate-source delete,
  which already used the protected `deleteSourceLatchIfSuperseded`) — now reconciled, see "Item 2" below.
- *How `matchedRepo` is found at all:* the clean-parse branch's `entry.repoPath` comes directly from the
  parsed JSON; `resolveAndArm` must re-derive it via the `hashToRepo`/`unresolvedClaimantsByHash`/
  `ancestorHashToRepo` cascade, since corrupt content carries no usable `repoPath` — structurally
  necessary; this cascade is the entire reason the catch branch exists.

## Item 2 (MINOR): adopted the protected delete, not merely exempted

The end-of-boot safety-tmp write/unlink pass (shared by the clean-parse branch's own entries and, after
this card, `resolveAndArm`'s) used a bare `fs.unlinkSync` wrapped in a swallow-everything `try/catch` —
"best-effort — harmless leftover beside a good final." Checked whether this is actually safe to leave as
a reasoned exemption, and concluded it is SAFE TO IMPROVE rather than merely exempt: `deleteSourceLatchIfSuperseded`
(the same protected delete the json/tmp sibling sites already use) adds, for free, a check against
`physicalOwnerRepoPaths`/a surviving `pendingUnresolvedQuarantines` reference, and on a GENUINE
(non-ENOENT) failure folds `f` into `orphanLatchFiles` and re-persists — the fold 4783df46's own CR round
2 called load-bearing. None of its extra guard conditions can fire differently from the bare unlink in
the ORDINARY case (same unlink attempt underneath), so this is a pure strict improvement, not a behavior
change for the common path. Adopted directly in the shared end-of-function pass. Verified via a new
scenario (`safety-tmp-undeletable-residue-folds-into-orphanlatchfiles`, same directory-shaped-residue
technique as the pre-existing `unlink-failure-folds-into-orphanlatchfiles` scenario) — negative control:
RED pre-adoption (the fold assertion failed), GREEN after.

## Item 3: the claimants tier, confirmed unchanged

Added `claimants-tier-corrupt-safety-tmp-still-diverts` (two registered repos sharing one degraded
ancestor hash, both absent, with a corrupt safety-tmp matching that shared hash) — confirms both still
divert to `pendingUnresolvedQuarantines` individually (never armed, no new `.json` final written
anywhere), unaffected by this card: `resolveAndArm`'s `!isRepoPathCurrentlyResolvable` branch always
fires for a claimant, by construction of `unresolvedClaimantsByHash` (every claimant is unresolvable).

## Do not (f118b475 additions)

- Do not apply this ruling to the ancestor-only tier of the safety-tmp recovery loop — `f5c42043`'s rule
  still governs it unconditionally; it is never proof of ownership regardless of resolvability.
- Do not add a new, separate write pass for the safety-tmp site's resolvable-arm branch — reuse the
  EXISTING `safetyTmpRecoveryByFile` end-of-boot write/unlink pass the try-branch's own clean-parse
  entries already go through; a second write pass would violate `882d6cff`'s "never write per-file,
  inline, inside this read loop" rule a second, needless way.
- Do not read the write-failure scenario's "T blocked"/"residue survives" assertions as proof of the fix
  by themselves — they also hold on pre-fix code, for an unrelated reason (the old divert path never
  attempts this write at all). Only the scenario's own discriminating precondition check (the new
  write-failure log line) actually proves the new code path ran.
- **Never arm a safety-tmp placeholder at a degraded-occupied key without the self-reference.** Arming
  into a union that a DIFFERENT, unrelated entry's identity wins is not itself wrong (that union is how
  enforcement works in-process) — but without a self-referencing pending entry naming `f`, an ORDINARY
  clear of that unrelated occupant can later sweep the residue as "unreferenced," durably over-unblocking
  the real match across a reboot. This is CRITICAL, not defensive: it is a fail-OPEN regression, the
  opposite direction of every other posture this record and its siblings maintain.
- Do not assume `deferredCorruptJsons`/`deferredCorruptTmps` are the right sibling to mirror for the
  degraded-occupied case specifically — they reach that protection through the SHARED
  `migratedSourcesByKey`/Phase-1b mechanism their own migrate sources flow through, never inline; the
  safety-tmp recovery loop's `safetyTmpRecoveryByFile` tracking has no equivalent shared phase, so the
  TRUE sibling for this one concern is the clean-parse branch's own inline check, a few lines above.
