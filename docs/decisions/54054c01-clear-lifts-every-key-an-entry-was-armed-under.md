# 54054c01 — a quarantine clear lifts every key an entry was armed under, and a key-unverifiable entry stays pending rather than guessed

## Narrative

Three residuals from `7673d096`'s approving re-review (reviewer `708793d4`), all reproduced cross-process
against the real `dist`.

### 1. `clearMergeQuarantine`/`clearMergeQuarantineByToken` only ever addressed the CURRENT key

`reenterMergeQuarantinesAtBoot`'s PASS 1 can arm one `MergeQuarantineEntry` under TWO map keys at once — its
freshly-recomputed current key AND its recorded `resolvedKey` (when they differ and the registered path
isn't currently resolvable, so PASS 1 declines to migrate/delete the original file — see `7673d096`'s own
record). Both `clearMergeQuarantine` and `clearMergeQuarantineByToken`'s full-clear path used to compute
only `canonicalRepoLockKey(repoPath)` fresh at clear time and delete/rewrite exactly that one map slot and
exactly that one on-disk latch path (`quarantinePathFor(repoPath)`, also freshly recomputed). When the two
keys differ — the exact "repo absent at a prior boot" shape PASS 1's dual-arm exists for — a clear issued
while the repo is STILL absent recomputes the SAME degraded key PASS 1 armed it under, so it reports
success and does make that ONE slot disappear, but:
- the entry's OTHER map slot (at its `resolvedKey`) is left exactly as armed, and
- the entry's PHYSICAL latch file (which never got migrated — it still lives at `hash(resolvedKey)`, not
  `hash(currentKey)`) survives untouched on disk.

Repro E: raise while present (writes the real, toplevel-keyed latch with `resolvedKey` set), boot with the
whole repo absent (PASS 1 dual-arms under both the degraded current key and `resolvedKey`), human clear
while STILL absent (reports success, but only lifts the degraded-key slot and deletes nothing on disk since
`quarantinePathFor(repoPath)` at clear time addresses a path that was never written). The root stays
refused, and a LATER boot re-reads the never-deleted original file and re-quarantines everything again.

**Fix (round 1 — SUPERSEDED, see "Code Review round 2" below):** `clearMergeQuarantine` initially looked up
the entry once, then deleted every `activeQuarantines` map key whose VALUE **is** that entry (reference
equality). This was itself wrong — round 2 found a REBUILT entry (a union, an orphan merge) breaks reference
equality at the entry's OTHER key — and is replaced by an explicit, threaded `armedKeys` set.
`clearMergeQuarantineByToken`'s PARTIAL-clear branch
(tokens remain after removing one) now also updates every map slot pointing at the pre-clear entry, so an
in-memory query through either key reflects the same reduced token set; its own `writeMergeQuarantineLatch`
call is left addressing only the current key's path, same as before — deliberately not extended to migrate
or delete a still-possibly-stale `resolvedKey` file on a PARTIAL clear, since (unlike a full clear, which
is intentionally discarding the quarantine outright) rewriting under a freshly-recomputed key that may
itself be a degraded fallback risks exactly the destructive-migration-on-an-unverifiable-key hazard
`7673d096` already fixed once for PASS 1. The full-clear path has no such risk: it only ever DELETES, never
migrates/rewrites, so addressing both keys is safe regardless of whether either is a degraded fallback.

New primitives: `quarantineHashForKey`/`quarantinePathForKey`/`deleteMergeQuarantineTmpResidueForKey`/
`deleteMergeQuarantineLatchByKey` — the by-repoPath originals now delegate to these, so a caller holding a
raw KEY (an entry's own `resolvedKey`) can address its on-disk latch without re-deriving it from a repoPath
it may not currently trust.

### 2. A one-boot fail-open for a key-unverifiable, no-`resolvedKey` latch

PASS 1's "stale key, not currently resolvable" branch used to warn and fall through to `armQuarantineKey`
regardless of whether the parsed entry carried a `resolvedKey`. For a latch written BEFORE that field
existed (a pre-upgrade latch, filed under the legacy pre-toplevel-walk hash) with the whole repo absent at
the very boot that introduces this code, `entry.resolvedKey` is `undefined` — there is no second key to
dual-arm under — so the entry is armed under ONLY the current key, which (because the path is absent) is a
degenerate existing-ancestor-fallback value, not the real toplevel key the repo will resolve to once it's
back. If the repo remounts later in that SAME process (no restart in between), a live query recomputes the
REAL toplevel key, which was never armed — `assertRepoNotQuarantined` silently returns `{ok:true}`:
fail-open, for the rest of that boot.

Repro G: manufacture a pre-upgrade-shaped latch (no `resolvedKey` field) under the LEGACY hash for a
subdir-bound repo, move the whole physical repo away, call `reenterMergeQuarantinesAtBoot`, then move the
repo back (same process) and assert — pre-fix this read `{ok:true}` for both the subdir and the toplevel
path once restored.

**A second, sharper gap found WHILE building the fix/test for this:** the obvious place to intervene looked
like the EXISTING "stale key, not resolvable" branch — i.e. still gated behind `freshHash !== hash`. That is
wrong for the "whole repo absent" shape specifically: when NOTHING in the path's ancestor chain resolves at
all, `canonicalRepoLockKey`'s own fallback (`resolveGitToplevelSync` finding no `.git` anywhere and
returning the reconstructed direct path unchanged) degrades to EXACTLY the same value the legacy
(pre-toplevel-walk) algorithm would also produce for a subdir-bound path — both are "the direct realpath of
the bound path, no git walk." So `freshHash` coincidentally EQUALS the legacy filename's own hash, and PASS
1 treats the latch as "already correctly keyed" — never entering the stale-key branch at all, old code and
new code identically falling through to a plain `armQuarantineKey(byRepoKey, currentKey, entry)` under the
degraded key. This is NOT the same bug as the one-boot fail-open described above, but it is the one that
ACTUALLY FIRES for the literal "whole repo absent" repro shape — confirmed by instrumenting
`activeMergeQuarantineFor` directly and observing a `directHit` (not a pending-list match) on the very first
post-boot query.

**Fix (restructured):** PASS 1 now checks `!isRepoPathCurrentlyResolvable(entry.repoPath) &&
!entry.resolvedKey` UNCONDITIONALLY, before the `freshHash !== hash` comparison — never trusting a
hash-equality that can be coincidental precisely because the unresolvable fallback and a pre-upgrade direct
key can degrade to the same value. When `resolvedKey` IS present (even if currently unresolvable), behavior
is UNCHANGED from inside the (now-secondary) `freshHash !== hash` check — dual-arm under both the current
and recorded key, exactly as `7673d096` already fixed. When absent, the entry is
pushed onto a new module-level `pendingUnresolvedQuarantines` array and `continue`d past — it is NOT armed
into `activeQuarantines`/`byRepoKey` under any guessed key at all. `activeMergeQuarantineFor` now checks
`activeQuarantines` first and, on a miss, scans `pendingUnresolvedQuarantines` for an entry whose OWN
`canonicalRepoLockKey(repoPath)` — recomputed fresh, right now — matches the query's key. A match is
reported as active for THIS query either way, but it is only PERMANENTLY graduated into `activeQuarantines`
(durably re-persisted under that key, removed from the pending list) once `isRepoPathCurrentlyResolvable`
also confirms the path itself genuinely resolves — the SAME gate PASS 1's own migrate decision already
uses. A query made while STILL absent finds the match (both the pending entry's own key and the query's key
recompute to the identical degraded fallback) but is deliberately left IN the pending list rather than
pinned to that degraded key: pinning it there would silently reopen the exact one-boot fail-open this fix
closes, just one query later — a SUBSEQUENT remount recomputes a genuinely different (real) key, and an
already-graduated entry sitting under the stale degraded key would miss it exactly like the original bug.
Leaving it pending means every later query re-derives the comparison fresh, so the FIRST query made after a
genuine remount is the one that actually graduates it. `listActiveMergeQuarantines` (diagnostic) and
`reenterMergeQuarantinesAtBoot`'s own return value both include pending entries too, so neither a status
read nor a caller inspecting the boot-time report sees a blind spot that only `activeMergeQuarantineFor`
would otherwise resolve. `clearMergeQuarantine` also sweeps `pendingUnresolvedQuarantines` (matched the
same way) so a human clear issued while the repo is still unresolvable actually lifts a pending entry too.

**This "self-heals on a later boot" claim was WRONG as originally written, and round 2 found it the hard
way (R1/R2 below) — correct it in place, do not restate the old claim elsewhere.** The ORIGINAL on-disk
latch file for a pending entry is never touched BY PASS 1 ITSELF (no migrate, no delete there — exactly
the "never destroy on an unverifiable key" posture `7673d096` already established). But `
activeMergeQuarantineFor`'s own GRADUATION step is a SEPARATE write path, round 1 left unaddressed: it
wrote the new durable latch under the now-known key but never deleted the stale source file the pending
entry was loaded from. The stale file survived indefinitely — not "until a later boot migrates it" (PASS
1's migrate branch never runs again for a file whose own embedded hash happens to coincidentally still
match some later computation, per finding 2's own coincidence) — and resurrected the quarantine the next
time anything booted after a human believed they'd cleared it. See "Code Review round 2" below for the fix
(graduation now deletes its own source file once the new write succeeds).

### 3. Test vacuity in `test/merge-quarantine-unresolvable-path.mjs`

The original file called `enterMergeQuarantine(subdir, ...)` directly in the SAME process that later called
`reenterMergeQuarantinesAtBoot([subdir])`. `enterMergeQuarantine` already leaves `activeQuarantines` keyed
correctly (under the real toplevel key) as a side effect of the raise itself — so every "(restored) …
refused" assertion downstream passed whether or not PASS 1's own re-entry logic armed anything at all; only
the file-preserved-on-disk checks actually exercised the fix.

**Fix:** the raise step now runs in a genuinely separate child process (`execFileSync(process.execPath,
["--input-type=module", "-e", childScript], { env: { ...process.env, LOOM_HOME: loomHome } })` — the same
technique `test/merge-quarantine-boot-hardening.mjs`'s own SCENARIO NC2 already uses), which writes the
real, toplevel-keyed latch to the shared `LOOM_HOME` and then exits — leaving the PARENT process's own
`activeQuarantines` map genuinely empty before it ever calls `reenterMergeQuarantinesAtBoot`. Two new
scenarios were added to the same file: one reproducing Repro E (fix 1, above) and one reproducing Repro G
(fix 2, above).

## Code Review round 2 (reviewer `708793d4`'s follow-up CHANGES-NEEDED on commit `e1f3fca2`)

Two more MAJOR gaps in round 1's own fix, both reproduced cross-process.

### R1/R2 — graduation never deleted the pending entry's own stale source file

Round 1's fix for finding 2 (above) made `activeMergeQuarantineFor` GRADUATE a pending entry once its path
is verified resolvable: write a fresh durable latch under the now-known key, remove it from
`pendingUnresolvedQuarantines`. It never deleted the OLD file the pending entry was originally loaded from.
That stale file survives on disk, named under whatever hash it was loaded under (the legacy hash in R1's
shape) — a LATER boot reads it fresh, mismatches it against the current key again (exactly as PASS 1 already
handles for the general "stale key" case), and RE-QUARANTINES the repo — even after a human clear believed
they'd lifted everything, because the clear only ever touched the GRADUATED entry's own (now-current) key
and file, never knew the old one existed.

- **R1** reproduces this via scenario G's own shape: a legacy-hash latch, whole repo absent at boot (pending,
  via finding 2's fix), remount (graduates, writes under the toplevel key), clear (lifts the graduated
  entry), reboot (re-reads the never-deleted legacy file, re-quarantines).
- **R2** reproduces the SAME bug through a DIFFERENT door, deliberately chosen to rule out "this is really
  just finding 2's own coincidence resurfacing": only the LEAF is missing, the TOPLEVEL stays present
  throughout. `canonicalRepoLockKey` finds the real toplevel key immediately via the existing-ancestor-
  tolerant walk — no coincidental hash match is involved at all — yet the entry still goes pending
  (`isRepoPathCurrentlyResolvable` checks the LEAF itself, not an ancestor) and still graduates later,
  leaving the exact same orphaned legacy file behind.

**Fix:** `pendingUnresolvedQuarantines` now holds `{ entry, sourceFile }` pairs — `sourceFile` is the exact
on-disk filename (not a full path) PASS 1 loaded the entry from, carried purely in memory (never part of the
persisted `MergeQuarantineEntry` shape). Graduation deletes `sourceFile` ONLY AFTER the new durable write
under the verified key actually succeeds — the identical ordering rule PASS 1's own migrate branch already
uses (never delete the one surviving durable copy before a replacement is confirmed written). A human clear
issued while an entry is STILL pending (never graduated) also deletes its `sourceFile`, for the same reason.

### R3 — clear relied on reference equality, which a rebuilt entry breaks

Round 1's clear fix scanned `activeQuarantines` for every map key whose VALUE `===` the entry being cleared.
That assumption — "an entry occupying two keys is the SAME object at both" — holds only until something
REBUILDS the entry via a spread (`{ ...entry, ... }`) at just ONE of its keys. Two real call sites do exactly
that: `armQuarantineKey`'s own union (two latches colliding onto one key) and PASS 2's orphan-filename merge
(`{ ...existing, orphanLatchFiles: merged }`). Each one used to write the rebuilt object back to ONLY the key
it was looking up by — the entry's OTHER armed key kept pointing at the STALE pre-rebuild object. A clear
keyed off reference equality then found and lifted only the slot holding the (rebuilt) object it happened to
look up first, leaving the stale slot (and its own un-migrated physical file) to resurrect the refusal the
instant a later query used that OTHER key.

R3's repro: a real raise (child process, `resolvedKey` set, dual-armed by PASS 1 while absent) PLUS an
unmatched corrupt orphan latch present at the SAME boot. PASS 2's orphan merge rebuilds the entry at whichever
key it looks up by first; pre-fix, the OTHER key kept the pre-merge object. `clearMergeQuarantine` while still
absent reported success and genuinely lifted ONE slot — but a query through the other key, after remounting,
still found the stale object and read REFUSED again; `listActiveMergeQuarantines` likewise still carried one
leftover entry for the repo.

**Fix:** `MergeQuarantineEntry` now carries `armedKeys?: string[]` — an explicit, IN-MEMORY-ONLY (never
persisted — `writeMergeQuarantineLatch` strips it before serializing) record of every `activeQuarantines`/
`byRepoKey` map key this exact logical entry currently occupies. `armQuarantineKey` folds the key it's asked
to arm into the result's `armedKeys` and RETURNS the rebuilt object — every dual-arm call site (PASS 1, PASS
1b) now THREADS that return value into its second call (`armQuarantineKey(byRepoKey, resolvedKey, armedEntry)`,
not the original `entry`), and re-sets the FIRST key's slot to the final, fully-armed object afterward — or
the first slot would keep pointing at an object whose `armedKeys` is missing the second key. PASS 2's orphan
merge, `enterMergeQuarantine`'s own existing-entry branch, and `clearMergeQuarantineByToken`'s partial-clear
all iterate `existing.armedKeys` (falling back to `[key]` for a legacy entry with none) instead of a single
key or a reference scan. `clearMergeQuarantine` and `listActiveMergeQuarantines` follow the same rule — the
latter also now de-dupes via `new Set(...)`, since an entry armed under two keys otherwise appears twice in
`activeQuarantines.values()`.

### Residual closed — a fresh raise now merges into a matching pending entry

Round 1 left a residual: `enterMergeQuarantine` only ever checked `activeQuarantines`, never
`pendingUnresolvedQuarantines`, so a fresh raise landing while an old pending latch for the same repo was
still unresolved minted an unrelated SECOND entry — orphaning the pending one's own identity/tokens until
something else happened to query and graduate it independently. `enterMergeQuarantine` now also checks
`pendingUnresolvedQuarantines` for a key match before falling back to a brand-new entry; a match unions the
fresh raise into the pending entry (via the same `unionQuarantineEntries` PASS 1 itself uses — the pending
entry, being strictly older, keeps its own branch/reason/identity per the existing "longest-outstanding raise
wins" rule, while the token sets combine), writes it durably under the now-known key, and — once that write
succeeds — removes the pending entry and deletes ITS OWN stale source file, exactly like an ordinary
graduation.

### Minor — the lazy-resolve's per-query cost on a pending entry

Every `activeMergeQuarantineFor` MISS against `activeQuarantines` that still has ANY pending entries pays a
`canonicalRepoLockKey` call (and, on a key match, an `isRepoPathCurrentlyResolvable` call) per pending entry,
for as long as that entry stays pending — which, for a repo that is gone FOR GOOD, is the remaining lifetime
of the process. This is bounded (the pending list only ever holds entries PASS 1 could not verify at load
time — a small, fixed-at-boot population, not something that grows during normal operation) and the
per-call cost is the same existing-ancestor filesystem walk `7673d096`'s own record already measured as
noise next to a real git subprocess call. Acceptable; not a reason to cache or special-case it further.

## Code Review round 3 (reviewer `708793d4`'s re-review of commit `b7efd2d3`)

One CRITICAL (round 2's own fix introducing a fail-open-across-a-restart regression) and one minor gap in
`armQuarantineKey` itself, both reproduced cross-process against the built `dist`.

### CRITICAL — a self-deleting latch for a TOPLEVEL-bound repo

Round 2's fix for finding 1 (graduation, and `enterMergeQuarantine`'s merge-into-pending path, delete the
pending entry's stale `sourceFile` once the new write succeeds) never checked whether that source file IS
the file the new write just produced. For a repo bound AT its own git toplevel (no subdir), the OLD legacy
key algorithm and the CURRENT toplevel-walking one compute the IDENTICAL value — there is no walk to differ
on, present or absent (unlike a subdir-bound repo, where the two algorithms genuinely diverge). So a
pending entry's own stale filename can be the EXACT SAME name a graduation's (or a merge's) fresh write just
produced, and unconditionally unlinking it deletes the quarantine that write just durably wrote — not a
leftover. The repo stays enforced only in THIS process's own memory; a RESTART finds nothing on disk and
silently lifts it, with NO clear ever having happened. All of round 2's own new tests were subdir-bound
(R1/R2/RESIDUAL), so none of them could ever exercise this — it needs a repo with NO distinguishing walk at
all.

- **Path A** (graduation): a pre-upgrade latch for a toplevel-bound repo, absent at boot (pending), moved
  back; the query that graduates it writes under the SAME filename the pending entry was loaded from, then
  deletes that "stale" file — i.e. the one it just wrote. `assertRepoNotQuarantined` still reads `{ok:false}`
  in THIS process (in-memory state is intact), but the latch DIRECTORY now holds nothing for this repo, and
  a child-process reboot reports `quarantined:false`.
- **Path B**: the identical bug via `enterMergeQuarantine`'s merge-into-pending path instead of a
  lazy-query graduation.

**Fix:** one shared helper, `deleteSourceLatchIfSuperseded(sourceFile, writtenEntry)` — computes the
basename the just-written entry's OWN latch would occupy (`quarantinePathFor(writtenEntry.repoPath)`) and
unlinks `sourceFile` ONLY when it differs from that basename. Used by graduation, `enterMergeQuarantine`'s
merge-into-pending path, AND (for consistency, even though it was already safe there — see below) PASS 1's
own migrate branch. PASS 1's migrate branch was never actually exposed to this bug because it's gated on
`freshHash !== hash` (which, for the migrate branch specifically, structurally guarantees the OLD filename
and the fresh one differ) — but routing it through the same shared helper means that safety no longer
depends on a human remembering to keep two independently-written checks in sync.

New test fixtures: `makeToplevelRepo` (a repo with no subdir) and scenarios TOPLEVEL-A/TOPLEVEL-B, each
proving the file survives graduation/merge, a child-process reboot still reads `quarantined:true` with NO
clear ever issued, and an explicit clear afterward genuinely lifts it.

### Minor — `armQuarantineKey`'s union wrote to only ONE key

`armQuarantineKey(byRepoKey, key, entry)` computed the final unioned+armed object and called
`byRepoKey.set(key, armed)` — only the ONE key it was invoked with. When the entry it unions with (`prior`,
found already sitting at `key`) is ITSELF already dual-armed under a SECOND key (inherited into the union's
own `armedKeys` via `unionQuarantineEntries`), that OTHER key kept pointing at the stale PRE-union object —
nothing in this function (or, depending on processing order, any caller) ever revisited it. A query through
that other key would see only its own half of the merged data; a clear through it would lift an incomplete
picture, identical in shape to round 2's own R3 (reference equality breaking on a rebuilt object) but now
reachable from `armQuarantineKey` itself, independent of PASS 2's orphan-merge path R3 fixed.

This is specifically an ORDERING bug: PASS 1's own dual-arm call sites already re-thread their SECOND call's
result back onto their FIRST key (round 2's own fix) — which happens to self-heal the case where the
ALREADY-dual-armed entry is the one being processed SECOND (its own second-arm call touches the stale key
directly). The bug surfaces only when the already-dual-armed entry is processed FIRST and a later,
single-armed entry collides with it — the later entry has no second-arm call of its own to ever revisit the
first entry's OTHER key.

**Fix:** `armQuarantineKey` now sets the final armed object at EVERY key in its OWN `armedKeys`, not just
`key` — `for (const k of armed.armedKeys ?? [key]) byRepoKey.set(k, armed);`. This makes the result
order-independent: regardless of which of two colliding entries PASS 1 happens to read first, by the time
BOTH have been processed, every key either has ever occupied ends up pointing at the SAME final object.

New scenario UNION-KEYS: two latches, one dual-armed (a manufactured `resolvedKey` distinct from its own
current key) and one single-armed, deliberately colliding at the dual-armed one's SECOND key. Since
`fs.readdirSync`'s own order for two hash-named files isn't something a test can dictate, the scenario
determines the ACTUAL read order empirically (two placeholder files, then a real `readdirSync`) and assigns
the dual-arm role to whichever file will be read FIRST — the one shape that reliably reproduces the bug —
rather than hardcoding an assumed order and risking a flaky RED proof.

## Do not

- Do not go back to addressing only `canonicalRepoLockKey(repoPath)` freshly recomputed in either clear
  function — an entry armed under two keys (current + `resolvedKey`) needs both lifted, or the un-lifted
  slot (and its never-migrated physical file) resurrects the "cleared" quarantine on the next boot.
- Do not extend `clearMergeQuarantineByToken`'s PARTIAL-clear branch to migrate/delete a stale
  `resolvedKey` latch file the way the full-clear path now does — a partial clear's own rewrite addresses
  a freshly-recomputed key that may itself be an unverified/degraded fallback; deleting the other (possibly
  the only genuinely verified) copy on that basis reopens the exact destructive-migration-on-an-
  unverifiable-key hazard `7673d096` closed for PASS 1.
- Do not arm a PRE-upgrade, no-`resolvedKey`, currently-unresolvable latch under its freshly-computed
  fallback key in `byRepoKey`/`activeQuarantines` — push it to `pendingUnresolvedQuarantines` and let
  `activeMergeQuarantineFor` re-resolve it lazily instead; a key guessed once at boot load time can
  silently stop matching the moment the repo actually resolves.
- Do not gate the no-`resolvedKey`/unresolvable check behind `freshHash !== hash` — when nothing in the
  path's ancestor chain resolves, the unresolvable-fallback key can coincidentally EQUAL a pre-upgrade
  latch's own (legacy, direct-path) filename hash, since both reduce to "no toplevel walk." A hash-equality
  check alone would then wrongly treat the entry as "already correctly keyed" and arm it under the degraded
  key via the normal fall-through — reopening exactly the bug this fix closes, undetected by the one check
  that looked like it should have caught it.
- Do not forget `listActiveMergeQuarantines`/`reenterMergeQuarantinesAtBoot`'s own return value need to
  include `pendingUnresolvedQuarantines` too — a diagnostic read or a boot-time caller must not see a blind
  spot that a live `activeMergeQuarantineFor` query would otherwise silently resolve on its own.
- Do not graduate a pending entry out of `pendingUnresolvedQuarantines` on a KEY MATCH alone — gate it on
  `isRepoPathCurrentlyResolvable` too. A match made while still absent pins the entry to a degraded
  fallback key that a later genuine remount will not reproduce, reopening the same one-boot fail-open this
  fix exists to close, just one query later.
- Do not write a boot-re-entry test that raises via the real `enterMergeQuarantine` in the SAME process
  that then calls `reenterMergeQuarantinesAtBoot` — that leaves the raising process's own in-memory
  `activeQuarantines` entry sitting there regardless of whether the boot logic under test does anything at
  all, making every later assertion pass vacuously. Raise in a genuinely separate child process (see
  `test/merge-quarantine-boot-hardening.mjs`'s SCENARIO NC2), or manufacture the on-disk latch by hand
  without ever calling the real raise function in the test's own process.
- Do not let a pending entry's GRADUATION (`activeMergeQuarantineFor`) write the new durable latch without
  also deleting the pending entry's own `sourceFile` once that write succeeds — leaving the old file behind
  is exactly R1/R2: a later boot re-reads it, mismatches it against the (by-then-different) current key
  again, and re-quarantines a repo a human already believed they'd cleared.
- Do not go back to reference equality (`v === entry`) — or any single-key shortcut — for finding every key
  an entry occupies in `clearMergeQuarantine`/`clearMergeQuarantineByToken`/PASS 2's orphan merge. Use
  `entry.armedKeys` (falling back to `[key]` only for a legacy entry that predates the field). A union or an
  orphan merge REBUILDS the entry at ONE key; reference equality silently stops finding it at the others
  (R3).
- Do not add a NEW dual-arm (or multi-arm) call site without threading `armQuarantineKey`'s return value
  into every subsequent call for the SAME logical entry — the first call's result is a rebuilt object with
  `armedKeys` including only the FIRST key; a later call built on the ORIGINAL (un-rebuilt) `entry` instead
  produces an object whose `armedKeys` is missing the first key entirely.
- Do not let `armedKeys` leak into the persisted JSON — it is in-memory bookkeeping ONLY, rebuilt fresh by
  arming on every boot; `writeMergeQuarantineLatch` must keep stripping it before serializing.
- Do not delete a "stale" source latch (graduation, `enterMergeQuarantine`'s merge-into-pending, PASS 1's
  migrate) without first checking it isn't the SAME file the just-written entry now occupies — route every
  such delete through `deleteSourceLatchIfSuperseded`, never a bare `fs.unlinkSync`. A toplevel-bound repo's
  old and current keys can coincide exactly, and deleting "the old file" then deletes the one just written.
- Do not write a toplevel-bound-repo test for this area assuming `freshHash !== hash` always holds the way
  it does for a subdir-bound repo — for a toplevel-bound repo, the legacy and current key algorithms are
  IDENTICAL, so that comparison can never distinguish "stale" from "already correct" at all.
- Do not have `armQuarantineKey` write its result to only the `key` it was called with — write it to EVERY
  key in the final object's OWN `armedKeys`, or a key the union inherited from an already-dual-armed `prior`
  keeps pointing at the stale pre-union object.
- Do not assume `fs.readdirSync`'s order for two hash-named fixture files is predictable (alphabetical,
  creation-order, or otherwise) when writing a test whose RED-ness depends on processing order — determine
  the actual order empirically (write placeholders, read the directory, THEN assign roles) rather than
  hardcoding an assumption that can make the test's own RED proof flaky.

## Source

`packages/daemon/src/git/merge-quarantine.ts` (`clearMergeQuarantine`, `clearMergeQuarantineByToken`,
`activeMergeQuarantineFor`, `listActiveMergeQuarantines`, `enterMergeQuarantine`,
`reenterMergeQuarantinesAtBoot`'s PASS 1/1b/PASS 2, `pendingUnresolvedQuarantines`,
`PendingUnresolvedQuarantine`, `MergeQuarantineEntry.armedKeys`, `armQuarantineKey`,
`unionQuarantineEntries`, `deleteSourceLatchIfSuperseded`, `quarantineHashForKey`/`quarantinePathForKey`/
`deleteMergeQuarantineTmpResidueForKey`/`deleteMergeQuarantineLatchByKey`),
`packages/daemon/test/merge-quarantine-unresolvable-path.mjs`.
