# 92c645cc — keep the merge-quarantine latch's durable tmp until a superseding write succeeds, on every path

From the final delta review of `bde5d1fe` (`docs/decisions/bde5d1fe-*`), which established: a sweep/unlink
of tmp residue may run only AFTER a durable write of the state that supersedes it has succeeded — never
before, never unconditionally. Two remaining sites broke this rule.

## Narrative

**Site 1 — `reenterMergeQuarantinesAtBoot`'s PASS 1b unlinked a real tmp beside a corrupt final.**
PASS 1b's "this tmp is stale residue, safe to delete" branch gated on `byRepoKey.has(matchedRepo's key)`.
But `byRepoKey` is ALSO populated by PASS 1's corrupt-but-hash-matched catch branch with a GENERIC
fail-closed placeholder entry, regardless of whether that branch's own self-heal `writeMergeQuarantineLatch`
call actually succeeded. So: a corrupt final + a tmp holding the real fsync'd entry + a failed self-heal
write (e.g. EMFILE) made PASS 1b wrongly treat the tmp as stale residue beside an already-good final — and
delete it — when the "final" was really just the unwritten placeholder. The real branch/reason/opId were
lost permanently (not fail-open — the repo stays quarantined — but the identifying detail is gone for good).

**Fix:** a new `cleanlyParsedKeys: Set<string>`, populated ONLY in PASS 1's successful-parse path (never
the catch/corrupt branch). PASS 1b's gate now checks `cleanlyParsedKeys`, not `byRepoKey`. When the final
was NOT cleanly parsed, PASS 1b falls through to its existing tmp-parse-and-recover logic, which `armQuarantineKey`-unions
the recovered entry with whatever placeholder PASS 1 left — `unionQuarantineEntries` picks its winning
identity by placeholder-ness FIRST (the non-placeholder side always wins outright when they differ,
round 2), falling back to the OLDER `enteredAt` only when both sides agree on placeholder-ness; a real
tmp's non-placeholder content therefore wins over PASS 1's placeholder explicitly, never merely because
its `enteredAt` happens to be older. Test: `test/merge-quarantine-pass1b-clean-parse-gate.mjs`
(SCENARIO CFRT), with a STALE-TMP-STILL-SWEPT regression guard confirming a genuinely stale tmp beside an
already-clean final is still swept as before.

**Site 2 — `writeMergeQuarantineLatch`'s own tmp name was reused across calls (NOT reproduced by the
original card; reproduced in this round).** The tmp name was the deterministic `<final>.tmp-<pid>`. A
SECOND call to `writeMergeQuarantineLatch` for the SAME repoPath, in the SAME process (e.g. a later token
appended via `enterMergeQuarantine`, or `clearMergeQuarantineByToken`'s partial-clear rewrite), opens that
exact same path with `"w"` — which TRUNCATES whatever an EARLIER call's own fsync'd-but-never-renamed write
left there, before the new write's own fsync is known to succeed. A fault strictly between the truncating
`open()` and the new write's completion destroys the earlier durable record and leaves nothing in its
place. Reproduced: call 1 succeeds; call 2 (rename blocked by a directory at `final`) leaves a real
2-token tmp; call 3 (same repo, `fs.writeSync` patched to throw once, simulating a crash in that exact
window) leaves the SAME tmp file at 0 bytes — the 2-token content from call 2 is gone and nothing replaced
it. At boot, a 0-byte tmp fails to parse and falls to the generic fail-closed placeholder, same loss as
site 1.

**Fix:** every `writeMergeQuarantineLatch` call now mints a FRESH, unique tmp name —
`<final>.tmp-<pid>-<8 hex chars>` (reusing the already-imported `randomUUID`) — so no later call for the
same repoPath can ever truncate an earlier call's still-pending tmp. `reenterMergeQuarantinesAtBoot`'s
tmp-residue regex widened from `/\.json\.tmp-\d+$/` to `/\.json\.tmp-\d+(-[0-9a-f]+)?$/` so PASS 1b still
recovers BOTH the new shape and the legacy bare-pid one (a pre-upgrade daemon's latch, or any test
fixture that manufactures a bare-pid tmp). **(Round 2 correction — see below: before round 2, PASS 1b
iterated every matching tmp but persisted only ONE of them to disk, whichever it happened to process
last; the in-memory union was real, the on-disk union was not. Round 2 made the disk write match the
in-memory union.)** The prefix-based sweep helpers (`deleteMergeQuarantineTmpResidueForKey`/
`deleteMergeQuarantineTmpResidue`) needed no change — they already match via `startsWith`, independent of
suffix shape.

**The accumulation trade-off, and the conditional sweep.** A unique name per call means a run of failed
writes for the same repoPath now LEAVES BEHIND one tmp per failed attempt, instead of overwriting one
file — never silently losing data, but accumulating residue. `writeMergeQuarantineLatch` takes a new
`sweepOtherTmpsOnSuccess` parameter (default `false`): on a successful rename, it ALSO deletes every
OTHER leftover `.json.tmp-*` for the same key — but only when the caller passes `true`, and a caller may
only do that when the entry it just wrote is PROVABLY a superset of anything an older tmp for that key
could hold (so the sweep can never discard an outstanding token/identity this write didn't already carry
forward).

Enabled (`true`) at exactly one call site: `enterMergeQuarantine`'s "append a fresh token to the existing
in-memory entry" branch — the entry written there is syntactically `[...existing.tokens, token]`, a
visible superset of `existing.tokens` with no dependency on boot-time bookkeeping to prove it.

Deliberately left at the default (`false`, no sweep) at every other call site:
- `enterMergeQuarantine`'s fresh-entry branch (no existing/pending record for this key) — reaching this
  branch at all implies boot recovery already fully resolved or never saw this key, but proving no foreign
  tmp can possibly exist here depends on boot-recovery invariants rather than anything local to this call;
  not worth the risk for a rare case.
- `enterMergeQuarantine`'s pending-merge branch (merging a fresh raise into a boot-time
  `pendingUnresolvedQuarantines` entry) — the pending entry's own token set traces back to boot-time
  bookkeeping (a pre-7673d096, unresolvable-at-boot latch) that this function cannot locally re-verify is
  complete relative to every sibling tmp for the same key.
- `clearMergeQuarantineByToken`'s partial-clear rewrite — explicitly asked about by review: this path
  DROPS a token on purpose (`current.tokens.filter((t) => t !== token)`), so the written entry is a
  SUBSET, not a superset, of the pre-clear state. Never safe to auto-sweep from here.
- Every `writeMergeQuarantineLatch` call inside `reenterMergeQuarantinesAtBoot` itself (self-heal
  placeholder, key migration, PASS 1b's tmp promote, PASS 2's orphan-reference merge) — all boot-time
  paths operating on freshly-loaded, not-yet-cross-checked state; the superset property isn't a question
  this function can answer about its own boot-time callers without re-deriving the whole PASS 1/1b/2
  invariant, which is out of scope here.

Test: `test/merge-quarantine-truncation-repro.mjs` drives the truncation repro directly, and
`test/merge-quarantine-pass1b-clean-parse-gate.mjs`'s SWEEP-ON-SUCCESS scenario drives three failed
renames followed by one success, asserting only the final and zero tmp files survive, plus a legacy
bare-pid tmp is still recovered at boot.

## Round 2 (Code Review `f861ac30` of commit `15ac5473`, CHANGES, two Majors reproduced)

**Item 2 — the self-heal placeholder is a SECOND door into site 1's loss, across TWO boots.** Boot 1:
PASS 1's self-heal write for a corrupt final SUCCEEDS (a valid, cleanly-parsing placeholder), while PASS
1b's own promote of the real tmp FAILS (e.g. EMFILE). Boot 2: the placeholder final now parses cleanly,
so the old `cleanlyParsedKeys` gate (keyed only on "parsed without throwing") wrongly treats it as real
and deletes the real tmp as stale residue — lost for good, with no third boot able to recover it.

**Fix:** a new, PERSISTED `placeholder?: true` field on every entry this module mints itself as generic
fail-closed/self-heal boilerplate (never a real raise); `cleanlyParsedKeys` now gates on `!placeholder`.
A LEGACY, field-less placeholder (written before this field existed) is still recognized by branch text
alone, via two shared consts (`PLACEHOLDER_BRANCH_CORRUPT`/`PLACEHOLDER_BRANCH_UNRESOLVED`) every
placeholder-minting call site now imports rather than hand-copies. Safe: `git check-ref-format` rejects
both a space and a `(` in a branch name, so neither placeholder string can ever be a real branch.

**Item 2b — PASS 1b persisted one tmp's content, not the union, when a key had more than one tmp.** A
fresh-entry write plus an append's own rewrite (both blocked from renaming) leave TWO tmps for one key.
The old PASS 1b wrote+unlinked each tmp INLINE as visited; `byRepoKey` was genuinely unioned in memory,
but the ON-DISK final ended up as whichever tmp was visited LAST. **Correction to this record's own
earlier claim** (Site 2 fix, above): "it already iterates and unions every matching file" was true in
MEMORY only, never on disk, until this round.

**Fix:** PASS 1b defers every tmp's write/unlink to one per-key pass, run after every tmp (real or
corrupt) has been armed into `byRepoKey`. A corrupt tmp's fail-closed handling is likewise deferred
(`deferredCorruptTmps`), so visiting order can never decide whether a sibling's real data survives; a
corrupt tmp whose key already has real data contributes no placeholder — it's folded into that key's own
unlink list, swept only once that key's real union write durably succeeds.

**Item 3 — the union must prefer the non-placeholder identity explicitly, never by `enteredAt`.** A
placeholder is always stamped `Date.now()`; a real tmp missing `enteredAt` falls back to `Date.now()`
too, so a clock set back could make either side look "older". **Fix:** when exactly one side is a
placeholder, the non-placeholder side's identity wins unconditionally; `enteredAt` only arbitrates when
both sides agree on placeholder-ness.

**Item 1 (test only) —** `SCENARIO PARTIAL-CLEAR-WRITE-FAILURE` (`merge-quarantine-boot-hardening.mjs`)
`.find()`-picked "the first" `.tmp-*` by `readdirSync` order to park across a reset — no ordering
guarantee across two random-hex suffixes, ~1 run in 3 parked the wrong one and lost tokenB. Fixed by
tracking and parking every tmp for the hash.

**Item 4 (test gap) — `merge-quarantine-pass1b-clean-parse-gate.mjs`:** `MULTI-TMP-UNION` (a real tmp + a
0-byte corrupt sibling, no final, roles swapped across two PHYSICALLY-FIXED filenames — never names whose
text is assumed to control `readdirSync`'s order, per `docs/decisions/54054c01-*` — asserting the
final's on-disk content, not just memory, plus a stable second boot), `MULTI-TMP-UNION-WRITE-FAILURE`
(both tmps survive a failed union write, then both recover on the next boot), and
`LEGACY-PLACEHOLDER-FIELDLESS` (a hand-written, field-less placeholder is recognized and never counted
as a clean parse).

## Do not

- Do not gate PASS 1b's stale-tmp sweep on `byRepoKey.has(...)` — a corrupt-but-matched placeholder from
  PASS 1's catch branch populates that map too, even when its own write failed. Gate on a dedicated
  clean-parse marker instead.
- Do not go back to a deterministic (pid-only) tmp name in `writeMergeQuarantineLatch` — it lets a later
  call for the same repoPath truncate an earlier call's still-durable tmp before the new write is
  confirmed.
- Do not pass `sweepOtherTmpsOnSuccess:true` from `clearMergeQuarantineByToken`'s partial-clear branch, the
  pending-merge branch, the fresh-entry branch, or any boot-time write inside
  `reenterMergeQuarantinesAtBoot` — none of them can locally prove the entry being written is a superset
  of every older tmp for that key.
- Do not narrow `reenterMergeQuarantinesAtBoot`'s tmp-residue regex back to bare digits only — it must
  still match the legacy pre-upgrade/foreign-pid shape alongside the new `<pid>-<random>` one.
- Do not count a cleanly-`JSON.parse`'d final as real data without also checking `isPlaceholderEntryShape`
  — a self-heal placeholder's own successful write makes it parse exactly as cleanly as real data on the
  NEXT boot.
- Do not hand-write either placeholder branch string at a new call site — import
  `PLACEHOLDER_BRANCH_CORRUPT`/`PLACEHOLDER_BRANCH_UNRESOLVED`, or a hand-copied drift between call sites
  reopens the legacy-recognition gap these consts exist to close.
- Do not let `unionQuarantineEntries` fall back to `enteredAt` when the two sides disagree on
  placeholder-ness — the non-placeholder side's identity wins explicitly first.
- Do not write a corrupt tmp's fail-closed placeholder inline, before every sibling tmp for that key has
  been read — defer it, or iteration order can decide whether real data survives.
- Do not unlink a tmp that contributed to a key's union before that key's OWN single write has durably
  succeeded — on failure, every tmp for that key (real and corrupt alike) stays exactly where it was.
- Do not write a test whose RED-ness (or role assignment) depends on an assumption that two tmp
  filenames' TEXT controls `readdirSync`'s real enumeration order — keep physical filenames fixed and swap
  CONTENT between roles instead (see `docs/decisions/54054c01-*`'s own guard on this).
- Do not strip a tmp's stale `resolvedKey` from `byRepoKey`'s dual-arm to make PASS 1b single-arm
  immediately like PASS 1 — see "PASS 1b's one-boot dual-arm vs PASS 1's immediate single-arm" below:
  it's harmless as-is, and the matching change is more invasive than it looks (deleting an arming slot,
  not just never adding one).

## PASS 1b's one-boot dual-arm vs PASS 1's immediate single-arm (card `3c109dad`) — deliberately left as-is

Code Review `684b3538` of `cac93b4c` flagged an asymmetry between how PASS 1 and PASS 1b each handle a
STALE `resolvedKey` once the path is confirmed resolvable. PASS 1b's per-key promote loop
(`for (const [key, tmps] of tmpsToUnlinkByKey)`, above) writes the final with `resolvedKey: key` (the
current key), but the SAME step also re-arms the promoted object at every key in its OWN `armedKeys` —
which, for a tmp that itself carried a stale `resolvedKey`, still includes that stale key (dual-armed
earlier in the tmp-reading loop's `if (entry.resolvedKey && entry.resolvedKey !== currentKey)` branch).
So the PROMOTING boot ends dual-armed at `[currentKey, staleKey]`; every boot AFTER it, reading the
just-written final (whose persisted `resolvedKey` now equals `currentKey`), single-arms at `currentKey`
only. The in-memory armed set for the identical on-disk state differs between the promoting boot and
every boot after it.

PASS 1's own resolvable stale-key migrate branch (`if (freshHash !== hash) { if (resolvableNow) { ... } }`)
re-keys `entry.resolvedKey = currentKey` BEFORE the shared `armQuarantineKey` step runs, so its own
dual-arm condition (`entry.resolvedKey !== currentKey`) is already false by the time arming happens — it
single-arms immediately, even within the migrating boot itself. PASS 1b doesn't match that shape.

**Decided: do not change PASS 1b to match PASS 1.** Three reasons:

1. **The asymmetry only ever shrinks what a stale key can still reach, never what it can avoid.**
   `activeMergeQuarantineFor` and every write path always address an entry by its CURRENT, freshly
   recomputed key, never a stale one (confirmed by reading that function — its only non-current-key
   lookups are the separate `pendingUnresolvedQuarantines` identity matches, unrelated to this). The only
   thing a stale key's continued presence in `armedKeys` ever enabled was a human `/clear-by-path {id}`
   using an old latch id — a convenience (`quarantineLatchFileIdsFor` can hand out more than one id for
   the same entry), never an enforcement property. Losing it one boot sooner (PASS 1b) or never having it
   at all (PASS 1) are both acceptable; nothing is ever LESS enforced either way.
2. **PASS 1 and PASS 1b are not the same shape, so "re-key before arming" doesn't transplant cleanly.**
   PASS 1 processes ONE final per repo — re-keying before its single arm call costs nothing. PASS 1b must
   accumulate a UNION across potentially several sibling tmp files for the SAME key, each of which may
   carry its OWN distinct stale `resolvedKey` from a different earlier write. The dual-arm during the
   tmp-reading loop is what lets `armQuarantineKey`'s union logic (see its own doc comment) track every
   key a later promote might still need to settle under — it is load-bearing scaffolding for the
   multi-tmp union, not an omittable step PASS 1 happens to skip.
3. **Matching PASS 1 exactly would mean actively DELETING `byRepoKey` entries at promote time, not just
   never adding them** — by the time the per-key promote loop runs, the dual-arm from reason 2 has already
   happened. "Fixing" this symmetrically would need the promote step to strip the stale key's slot, a more
   invasive change than PASS 1's own "never arm it in the first place" shape, for a benefit (reason 1)
   that's already best-effort/optional.

Not tested further — this is a documented close, not an implemented fix. If this asymmetry is ever shown
to matter operationally (e.g. a `/clear-by-path {id}` using a PASS-1b-promoted old id is reported broken
across a restart when a human expected it to keep working), re-open as its own card rather than
re-deriving this reasoning from scratch.

## Source

Card `92c645cc`. Round 1 discovered from `bde5d1fe`; round 2 from Code Review `f861ac30` of commit
`15ac5473`. Tests (RED against the old shape, GREEN restored): `merge-quarantine-pass1b-clean-parse-gate.mjs`
(round 1: CFRT, STALE-TMP-STILL-SWEPT; round 2: MULTI-TMP-UNION, MULTI-TMP-UNION-WRITE-FAILURE,
LEGACY-PLACEHOLDER-FIELDLESS), `merge-quarantine-truncation-repro.mjs`,
`merge-quarantine-boot-hardening.mjs` (round 2: de-flaked SCENARIO PARTIAL-CLEAR-WRITE-FAILURE).
