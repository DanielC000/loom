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
