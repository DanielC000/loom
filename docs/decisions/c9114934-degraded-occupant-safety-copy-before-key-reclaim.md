# c9114934 — a degraded occupant's own content survives its shared key being legitimately reclaimed

Split from `d4b25feb` (defect C, the in-memory twin of `4480b077`/`c870618c`'s own on-disk defect) by Lead
ruling. `4480b077`'s own decision record names the residual explicitly: "a legitimate clear of a
resolvable repo can destroy a degraded, colliding sibling's own backing file... tracked separately on
card `d4b25feb`, not fixed here." `e1cb7d33` ruled the clear itself must PROCEED (never refuse) — this
card's scope is purely to stop that proceeding clear from being the degraded occupant's *extinction*
event.

## The shape

`X` (unresolvable; a stale/manufactured `resolvedKey` walking to `Ky`) is armed by PASS 1 directly at
`Ky` (no `prior` yet — nothing else occupies `Ky` at that point). `Y` (resolvable, genuinely owns `Ky`)
takes PASS 1's own MIGRATE branch for a stale-named latch targeting `Ky` — but since `Ky` is already in
`degradedOccupiedKeys` (X's own trusted `resolvedKey`), the write is correctly refused and PASS 1b's own
hand-rolled fold folds `Y`'s stale source filename into `X`'s own `orphanLatchFiles`, and separately
tracks `Y`'s own standalone entry as an independent pending record (this half already worked before this
card).

`X`'s own exclusive durable backing is physically the SAME file as `Ky`'s own canonical physical slot.
When a human later runs the ordinary, legitimate `clearMergeQuarantine(y)` — which correctly PROCEEDS,
per `e1cb7d33`'s own retraction — `clearMergeQuarantineByKey(Ky, y)` deletes whatever occupies `Ky`
(in-memory AND on disk) without checking whether the occupant is genuinely `y`'s own identity or a wholly
unrelated, degraded sibling that merely shares the walked-up key. `X`'s only copy is destroyed as
collateral, with nothing having ever given it a durable copy under a different name.

## The fix is CLEAR-TIME, not boot-time — read this before touching Phase 1b again

The fix lives in `deleteMergeQuarantineLatchByKey` (`git/merge-quarantine.ts`), called right before the
unconditional unlink it already performs — never in `reenterMergeQuarantinesAtBoot`'s Phase 1b fold. This
is a deliberate reversal of the FIRST design tried (protect preemptively, at boot, whenever a degraded
occupant is found to be collision-folded) — that design was built, tested green against this card's own
repro, and then found to cause a real regression once run against the FULL corpus. Both false starts are
recorded below so neither is tried again.

**False start 1 — protect `occupant` itself at Phase 1b fold time, preemptively.** Caused a double-report:
`occupant` by fold time can already be the POST-union object (a migrating sibling's own fall-through
`armQuarantineKey` call unions BEFORE Phase 1b ever runs — Phase 1b's fold is not where the union
happens, it just adds `orphanLatchFiles` on top of whatever `armQuarantineKey`'s own fall-through already
produced). Persisting that union durably immortalizes the sibling's token under the occupant's identity
forever, surviving even the sibling's own later clear.

**False start 2 — capture X's PRE-union content at arm-time (a new `originalDegradedEntryByKey` map,
keyed by resolvedKey) and protect THAT at Phase 1b fold time instead.** Fixed false start 1's token-bleed,
and fixed 3 of 4 regressed scenarios — but still regressed
`round4-G2-reversed-occupant-wins-union`: a PREEMPTIVE protective file is written on boot 1 (whenever a
collision is merely detected, whether or not anything will ever actually clear it), and it then COEXISTS
FOREVER alongside X's own ORIGINAL physical file (which nothing ever deletes if no clear ever runs) — on
every later boot, BOTH get independently read as two distinct, un-reconciled objects for the same
identity. `listActiveMergeQuarantines()`'s own reference-based dedup — and
`assertQuarantineIdentityInvariantTestOnly`'s invariant — have no way to know the two files represent one
entity, since nothing in this module's architecture reconciles a bare pending-divert record against a
separately-armed-at-key record by content. The scenario never clears anything across its 3 boots, so a
preemptive copy is pure, permanent, incurable duplication.

**The fix that stuck: protect ONLY at the instant a destructive unlink is about to happen, and ONLY when
it's genuinely needed.** `deleteMergeQuarantineLatchByKey(key, clearingRepoPath?)` — when
`clearingRepoPath` is passed — calls `protectDegradedOccupantBeforeDelete(final, clearingRepoPath)` BEFORE
`fs.unlinkSync(final)`. That function reuses `differentUnresolvableOccupantRepoPathAt` (the SAME runtime
check `e1cb7d33`'s own WRITE-side guard, `wouldOverwriteDifferentUnresolvableOccupant`, already trusts) to
read what's ACTUALLY on disk at `final` right now and ask: does it belong to a different, currently-
unresolvable identity? Only if so does it read the file's full content, strip `resolvedKey` (so a later
boot's PASS 1 never re-arms it at the stale key — see "Do not" below), write it under a NEW, disjoint
`pending-<24hex>.json` filename (reusing `d4b25feb`'s own `writePendingDivertFile`/`pendingDivertFilenameFor`
rather than inventing a third on-disk format), and re-point any EXISTING pending reference to `final`'s
own basename onto that new file. Because this only ever fires at the exact moment of an actual delete —
never preemptively — there is no window where a protective copy and the original can coexist unreconciled:
either the original survives untouched (nothing was deleted, no copy made) or it's gone and the copy is
the SOLE surviving record. `clearMergeQuarantineByKey` is the one caller that passes `clearingRepoPath`
through (see "the UNION-KEYS trap" below for the one case where it must NOT).

## The UNION-KEYS trap — compare against the in-memory entry, never a bare on-disk repoPath string

`differentUnresolvableOccupantRepoPathAt` compares a raw `repoPath` string read off disk against the
identity being cleared. That alone is not enough: UNION-KEYS (card `54054c01`) legitimately dual-arms ONE
entity under two keys, and the SECOND key's own physical file is never rewritten once
`armQuarantineKey`'s fall-through union absorbs it in-memory — it can sit there, untouched, forever
showing its OWN pre-union `repoPath` string, even though it is the SAME entity now being cleared via the
OTHER key. A clear via either key must lift both (card `54054c01`'s own invariant) — treating the second
key's stale on-disk string as a "different, unresolvable occupant" would wrongly protect it, and the
resulting extra pending reference broke `merge-quarantine-unresolvable-path.mjs`'s own UNION-KEYS
scenario (measured: "a clear via the dual-armed repo ALSO lifts the single-armed one" and "no latch file
survives for either repoPath" both went FAIL).

**Fix:** `clearMergeQuarantineByKey` computes `clearingRepoPath` ONCE, by comparing the IN-MEMORY `entry`
actually being cleared (captured before any key is deleted) against `identityRepoPath`:
`directPathIdentity(entry.repoPath) !== directPathIdentity(identityRepoPath) ? identityRepoPath :
undefined`. For UNION-KEYS, `entry.repoPath` IS what's being cleared (`clearMergeQuarantineByRecordedPath`
passes `entry.repoPath` itself as `identityRepoPath`) — equal, so `clearingRepoPath` is `undefined` and
NO protection check ever runs, regardless of what either key's own stale file happens to say. For this
card's own genuine collision, `entry.repoPath` (X) differs from `identityRepoPath` (Y) — protection runs.
This is the "no bare identity-string-vs-file-content compare" constraint the card's own body named up
front, satisfied by comparing the LIVE in-memory entry, never the raw on-disk string alone.

## `armQuarantineKey` itself (Hook 2) — NOT implemented; this is card `398f476c`'s own scope, not ours

The card's own problem statement additionally names `armQuarantineKey`/`unionQuarantineEntries`'s own
UNCONDITIONAL cross-identity union (when `prior` and `entry` are different identities sharing one key) as
a candidate for the SAME extinction shape, reachable from PASS 1b's own tmp-mirror, the deferred-corrupt-
json path, or PASS 2's orphan merge. Per Lead ruling, Hook 2 was to be added ONLY if a scenario could
first be shown driving one of those three named paths to the SAME extinction, RED on HEAD.

This was investigated using `merge-quarantine-pass1-degraded-union-guard.mjs`'s own pre-existing
`deferred-flush-no-stale-snapshot` fixture (two both-unresolvable identities sharing one manufactured
`resolvedKey`, unioned via `armQuarantineKey` directly in PASS 1's own main loop — a 4th call site, not
literally one of the three named) extended with a clear step. Measured directly against the real dist
build: the LOSING identity is unqueryable by its own path immediately after boot (before any clear), and
clearing the WINNING identity then deletes both sides' physical files.

**This is NOT a new finding — it is exactly `a2f381dc`'s own documented, already-ruled-on "M-2" residual**
("a union that drops the losing side's own identity entirely... no per-site re-point can fix it... the
only real fix is redefining the module's own identity model — a structural rearchitecture, not a scoped
bugfix"), ruled **ACCEPT AND DOCUMENT** with its own dedicated follow-up card already filed: `398f476c`
("X is unqueryable by its own path when it loses a union") — the same card `e1cb7d33`'s own Scope Note
cites for the identical reason. `a2f381dc`'s own precedent deliberately added **no new test** for M-2
itself (documented, not asserted) — this card follows that same precedent rather than duplicating it.

**Conclusion: Hook 2 is `398f476c`'s scope, not this card's.** `armQuarantineKey` is left untouched here.
A per-site fix at the three named call sites would not close `398f476c`'s own identity-model gap anyway
(per `a2f381dc`'s own "Do not" — no per-site re-point can reach M-2), so there is nothing this card could
correctly add there even if the Lead's gate had been met literally.

## Round 2 (CR `5e1ece2e`, Lead ruling gen 409) — two regressions in round 1's own fix, plus a documented residual

Round 1's own fix (above) correctly closed the original shape, but Code Review `5e1ece2e` found it had
introduced two NEW regressions of its own, plus surfaced a THIRD, pre-existing gap this card's own
mechanism cannot reach without `398f476c`'s identity-model redesign.

**MAJOR #1 — a cleared latch resurrected via a stale same-repo subdir path.**
`differentUnresolvableOccupantRepoPathAt` alone (directPathIdentity-different + currently-unresolvable)
is NOT enough to call an occupant "foreign": a now-deleted SUBDIRECTORY of the very repo being cleared
(`Z = <Y>/gone-subdir`) is unresolvable and string-different from `Y` too, while its own ancestor-walked
`canonicalRepoLockKey` is IDENTICAL to `Y`'s (it collapses onto the SAME physical repo, no `.git` of its
own). Protecting it mints a pending record under `Z`'s own stale path — which re-blocks `Y`'s own
"cleared" quarantine the moment that subdirectory exists again (a `.gitignore`'d build dir recreated, a
checkout restoring it, etc.) and a boot runs.
⛔ **This round's own fix (gate on `canonicalRepoLockKey(occupantRepoPath) === key`) was ITSELF REVERTED
in round 3 — see that section below.** It cannot tell this harmless same-repo-subdir shape apart from a
genuinely FOREIGN nested repo whose checkout is merely missing right now (both ancestor-walk to the SAME
key); skipping protection on that premise silently and unrecoverably destroys the foreign repo's own
quarantine instead. Recorded here for the historical narrative only — do not re-derive or re-apply it.

**MAJOR #2 — fail-open: the "already protected" early return silently dropped a second collision's
tokens.** The original code checked `pendingUnresolvedQuarantines.some(p => p.sourceFile === filename)`
and, if already protected (e.g. from an EARLIER clear protecting the SAME degraded occupant at a
DIFFERENT shared key), returned immediately — before reading `final`'s own content at all. The physical
file at THIS key still gets unconditionally unlinked by the caller regardless, so that second collision's
own token(s) were destroyed with no copy anywhere.
This round's own fix (union whatever pending reference already exists, by `filename` OR by `final`'s own
still-unmigrated basename) had a SECOND bug of its own, found in round 3 — see that section below: the
"unmigrated basename" ref can be the SAME live object `armQuarantineKey`'s own unconditional in-memory
union already merged a colliding sibling's tokens into at boot, and unioning FROM it durably bleeds those
tokens into the protected occupant's own record. Test (updated in round 3):
`dual-collision-union-survives-second-protect` (one degraded identity colliding independently at two
different keys; clearing the second key alone still leaves the degraded identity quarantined with BOTH
tokens intact, union never drops the first) plus new `!tokens.includes("y-token")` assertions on the
existing in-memory-twin scenarios.

**MAJOR #3 — the reversed-ordering case, DEFERRED to `398f476c` (documented here, not fixed).** The fix
above gates on `clearMergeQuarantineByKey`'s own `clearingRepoPath` (`entry.repoPath !== identityRepoPath`
⇒ protect). But when TWO wholly unresolvable identities (not a resolvable sibling migrating in — the
DIRECT `armQuarantineKey` union case) share one manufactured `resolvedKey`, `unionQuarantineEntries` keeps
the OLDER side's own identity. If the sibling named in the clear call (`Y`) happens to be OLDER, the
union's own `repoPath` becomes `Y`'s — so `entry.repoPath === identityRepoPath` and NO protection is ever
attempted, regardless of ordering elsewhere. This is `a2f381dc`'s own M-2 residual one level over: there
is no surviving object representing the losing side's identity to protect in the first place — only
`398f476c`'s own identity-model redesign (tracking provenance over token sets, not one `repoPath` per
object) can close it. A REPORT-ONLY scenario (`reversed-tie-break-no-protection-report-only`, mirroring
`a2f381dc`'s own M-2 precedent of documenting without a new assertion) prints the outcome: the union
winner, and that zero protective copies exist and the losing identity is unqueryable anywhere afterward.
Appended to card `398f476c`'s own triage note.

## Round 3 (CR `8050192c`, Lead ruling gen 409) — FAIL CLOSED, a genuine union-source fix, and an accepted alias shape

Code Review `8050192c` on round 2's own commit (`ebb31560`) found round 2's own MAJOR #1 fix was ITSELF a
regression, and round 2's own MAJOR #2 fix still bled a sibling's token into a protected occupant's
record under a slightly different trigger than round 2's own tests happened to exercise.

**(1) Round 2's `occupantKey === key` skip is REVERTED — the Lead's ruling is FAIL CLOSED, as a
deliberate safety-mechanism policy, not a narrower technical fix.** The CR's own counter-example: a
GENUINELY FOREIGN nested repo (`Y/vendor/foreign-repo`, its own `.git`, a real distinct key) whose
checkout is simply MISSING at the moment `Y` is cleared. From this process's own inputs at clear time,
that is byte-for-byte INDISTINGUISHABLE from round 2's own `gone-subdir` shape — both ancestor-walk to
`Y`'s own key while absent; only what the path turns out to BE once restored tells the two apart, and
that information does not exist yet at clear time. Round 2's own skip silently and permanently destroyed
the foreign repo's quarantine (fail-OPEN, unrecoverable) to avoid a harmless, one-time, fully-recoverable
re-block of the same-repo-subdir case (fail-CLOSED). The Lead ruled: a safety mechanism's two failure
modes are not symmetric — pay the recoverable cost every time, rather than risk the unrecoverable one.
`protectDegradedOccupantBeforeDelete` now protects EVERY `differentUnresolvableOccupantRepoPathAt` hit,
unconditionally, exactly as round 1 originally did — `key` is no longer a parameter of that function.

The former `gone-subdir-not-foreign` test is REPLACED by `gone-subdir-reblocks-once-then-clearable`,
pinning the FAIL-CLOSED CONTRACT directly: `clearMergeQuarantine(y)` DOES mint a protective copy for the
same-repo subdir too; while the subdir stays gone, `y` stays free (the copy is merely pending, not yet
armed anywhere); once the subdir is restored and a boot runs, `y` is RE-BLOCKED (the cost); an ORDINARY
clear immediately afterward removes it for good, because `differentUnresolvableOccupantRepoPathAt` now
sees the occupant as "different but CURRENTLY RESOLVABLE" and returns `undefined` — no new protective
copy, the file is simply deleted. **The precise bound (CR `32679c84`'s own flapping probe): one re-block
PER CLEAR PERFORMED WHILE THE PATH IS STILL UNRESOLVABLE — a clear done once the path has RESOLVED is
FINAL.** Clearing the same occupant repeatedly while it stays absent can re-mint the same pending record
each time (each such clear is itself a fresh FAIL-CLOSED protect, since the occupant is still foreign-
shaped from this process's own inputs) — the probe measured this as one re-block per clear-while-absent,
with no growth across repeats, never an unbounded or escalating cost. **Correcting the false premise
named in round 2's own MAJOR #1 write-up above: a pending-divert record is NOT permanent ONCE ITS OWN
PATH RESOLVES AGAIN.** Once its own `repoPath` becomes resolvable, the ordinary boot migrate-write pass
(the SAME mechanism that migrates any other stale-keyed latch) picks it up on its own
`enteredAt`/content merits and migrates it into a real latch at its own canonical key — this is what
produces the re-block, and it is also what makes a SUBSEQUENT clear (performed once resolvable) durably
final.

A new scenario, `foreign-nested-repo-quarantine-survives`, proves the reverted check's actual job: the
SAME setup as the subdir case, but the path is later restored as a REAL, SEPARATE git repo (its own
`.git`, a genuinely different key) — after a reboot its own quarantine is still enforced, migrated to ITS
OWN key, never lost, and (unlike the subdir case) `Y` itself is NOT re-blocked, since the two keys
genuinely differ once the real identity is known.

**(2) MAJOR #2 (token bleed): union only from a DURABLE source, never a live boot-time union object.**
`protectDegradedOccupantBeforeDelete`'s own `atFinalBasenameIdx` lookup (a boot-time degraded-divert
push, e.g. `flushDegradedDiverts`'s own `{entry: byRepoKey.get(resolvedKey), sourceFile}`) can reference
the EXACT SAME in-memory object `armQuarantineKey`'s own unconditional fall-through arm (for a resolvable
sibling whose "stale-key migrate" branch does NOT `continue` — it falls through into the SAME generic
`armQuarantineKey(byRepoKey, currentKey, entry)` call every "current, no-migration-needed" latch takes)
already unioned a colliding sibling's own tokens into, well before any clear ever runs — this is the
SAME pre-existing, deliberate in-memory union the original card's own narrative already names ("armQuarantineKey
is unconditional... only the WRITE is gated"), just never previously fed into a DURABLE write. Round 2's
own fix unioned `toPersist` (always clean, re-read straight off `final`'s own disk bytes) against
WHICHEVER pending ref it found first — `atFilenameIdx` (safe: a ref THIS function itself wrote on a prior
call) OR `atFinalBasenameIdx` (UNSAFE: the live, possibly-contaminated boot object) — durably writing the
sibling's own token into the protected occupant's standalone record. Measured directly: a probe against
`ebb31560`'s own compiled `dist` reproduced it on the FIRST ever protect call for the base in-memory-twin
fixture (no second collision needed at all).

**Fix:** the union source is now `atFilenameIdx`'s own entry ONLY, never `atFinalBasenameIdx`'s. When
only `atFinalBasenameIdx` matches (the first protect call for an occupant with a pre-existing boot-time
divert ref), `toWrite` is `toPersist` alone — the ref is still re-pointed to the new `filename`, but its
own `.entry` field is overwritten with `toWrite` (the clean, durable content), not left as the stale
boot object, so a LATER protect call that finds this SAME ref via `atFilenameIdx` sees the clean truth
too, never perpetuating the contamination one call further. New assertions
(`!tokens.includes("y-token")`) on both in-memory-twin scenarios' protective file and across all 3
reboots — RED on `ebb31560`, GREEN after.

**(3) The junction-alias shape: ACCEPTED, same recoverable class as (1), documented only.** A Windows
junction/symlink (or any other OS-level alias) pointing two distinct paths at the same physical repo
produces the identical "ancestor-walk lands on the SAME key while one spelling is temporarily
unresolvable" shape as the plain subdir case — FAIL CLOSED already covers it for the same reason (1)
does: protecting it costs one recoverable re-block if the alias turns out harmless, and not protecting it
risks losing a genuinely different repo's quarantine if it doesn't. No separate code path or test is
needed; this is recorded so a future reader does not treat the alias shape as an unaddressed gap.

## Round 4 (CR `32679c84`) — HEALTHY and MERGEABLE, with three small items before merge

**(1) The `atFinalBasenameIdx` `.entry` overwrite needed a test that could actually catch its own
regression.** The CR mutated the dist back to the OLD, stale re-point (`{entry: <the stale object>,
sourceFile: filename}` instead of `{entry: toWrite, sourceFile: filename}`) and found EVERY existing
scenario still reported green. Root cause: `writePendingDivertFile(filename, toWrite)` already runs
BEFORE that re-point line, so the DURABLE FILE on disk is correct regardless of what the re-point line
does — and every existing assertion either reads that file directly, or reads it indirectly via a
`rebootSim()` (a fresh module re-import, which also only ever reads from disk). Neither path can ever
see a stale in-memory ref; only a query against the LIVE object, in the SAME process, with no reboot,
can. Added to `in-memory-twin-clear-destroys-degraded-file`, immediately after the original clear: an
in-process `activeMergeQuarantineFor(x)` check (no reboot) asserting it does NOT carry `y-token`, then a
SECOND, genuinely independent degraded collision for `x` at a different key `kw` (a fresh resolvable
repo `w`), armed via an in-process `reenterMergeQuarantinesAtBoot([w, x])` re-scan (no reimport) and
cleared via `clearMergeQuarantine(w)` — triggering a second `protectDegradedOccupantBeforeDelete` call
that would read the FIRST protect's own ref back via `atFilenameIdx`. Verified RED by hand-reverting the
re-point line to its old form and rebuilding: the in-process check failed immediately, and the SECOND
protect's own written file durably carried `y-token` too (plus, as an unplanned bonus, the reboot loop's
own `y-token`-absence checks caught it as well, since the contamination this time reached the durable
file). GREEN restored after reverting the mutation back. See that scenario's own "round 4, PIN" block.

**(2) Record wording tightened — the bound is per-clear, not a flat one-shot guarantee.** The CR's own
flapping probe (clearing the same gone-subdir occupant repeatedly WHILE it stays unresolvable) measured
one re-block minted per such clear, with no growth across repeats — never an escalating or unbounded
cost — but ALSO never fewer than one per clear-while-absent, since each such clear is independently
FAIL-CLOSED. The bound is: **one re-block per clear performed WHILE the path is still unresolvable; a
clear performed once the path has RESOLVED is final.** "Not permanent" (round 3's own correction of
round 2's false premise) means NOT permanent ONCE THE OCCUPANT'S OWN PATH RESOLVES AGAIN — while it
stays unresolvable, a pending-divert record can legitimately be re-minted by repeat clears, and that is
expected, not a leak.

**(3) Three nitpicks in the test file**, all fixed: a `foreign-nested-repo-quarantine-survives` check
that claimed "migrated to its own key" while only verifying the unrelated fact that `y`'s own repoPath is
absent — now asserts the real claim directly (the canonical latch file exists at `kForeign`'s own hash);
an `in-memory-twin-clear-destroys-degraded-file` reboot-loop check using `.some(e => cond && !other)`
(passes if ANY matching entry lacks the token even while a DIFFERENT one carries it) — now uses
`.find()` to pin down THE entry first, then asserts on it directly; and an unguarded `pendingAfterClear[0]`
array-index read in `gone-subdir-reblocks-once-then-clearable` that would throw (crashing the whole test
process, losing every later assertion) if a RED run ever produced zero protective copies — now guarded.

## Do not

- Do not protect a degraded occupant preemptively, at BOOT time (Phase 1b's fold, or any other boot-time
  pass) — see the two false starts above. Protection must happen exactly once, at the instant a
  destructive unlink is about to run, driven by `deleteMergeQuarantineLatchByKey`'s own `clearingRepoPath`
  parameter — never earlier.
- Do not derive `clearingRepoPath` (or decide whether to protect at all) from a bare repoPath-string
  compare against a key's own on-disk file content — compare against the IN-MEMORY entry actually being
  cleared (captured before any key is deleted). See "The UNION-KEYS trap" above for the real regression
  this closes.
- Do not add a "does this occupant's own ancestor walk land on the SAME key being cleared" check to
  decide whether to protect (round 2's own MAJOR #1 fix, REVERTED in round 3) — that question is
  undecidable from this process's own inputs (a stale same-repo subdir and a genuinely foreign nested
  repo whose checkout is merely missing look byte-identical), and skipping protection on it silently and
  unrecoverably destroys the foreign case. FAIL CLOSED: protect every
  `differentUnresolvableOccupantRepoPathAt` hit, unconditionally — the cost is a cleanly recoverable
  re-block for the harmless case (one per clear performed WHILE the path is still unresolvable; a clear
  done once it resolves is final), which is the ACCEPTED tradeoff, not a residual to "fix" away.
- Do not early-return (or overwrite) when a pending-divert file already exists for the occupant being
  protected (round 2, MAJOR #2) — union the new collision's content into whatever is already there, and
  always persist/re-point the union, every time. But (round 3) do not union from JUST ANY existing
  reference either: union ONLY from a ref keyed by `pendingDivertFilenameFor`'s own `filename` (a
  durable record THIS function itself wrote on a prior call) — NEVER from a ref keyed by `final`'s own
  basename (a boot-time degraded-divert push), whose `.entry` can be the SAME live object
  `armQuarantineKey`'s own unconditional in-memory union already merged a colliding sibling's tokens
  into. When only the latter exists, write `toPersist` alone and OVERWRITE that ref's own `.entry` with
  the result — never leave it pointing at the stale, possibly-contaminated boot object. (Round 4, CR
  `32679c84`: this overwrite is load-bearing in a way no file-level or reboot-based check can ever
  catch — the DURABLE file is already correct by the time this line runs either way, so only a
  same-process, no-reboot query right after the clear, plus a SECOND same-process protect call that
  reads this same ref back via `atFilenameIdx`, can ever observe a regression here. See
  `in-memory-twin-clear-destroys-degraded-file`'s own round-4 PIN block.)
- Do not write a new on-disk format for this protection — reuse `d4b25feb`'s own `pending-<24hex>.json`
  (`writePendingDivertFile`/`pendingDivertFilenameFor`); `97cff6db`'s `SAFETY_TMP_RE` format is a
  same-boot write-collision pre-image recovered by union on the NEXT boot, not a format meant to stand as
  an independent, indefinitely-coexisting record.
- Do not persist the protected copy's own `resolvedKey` — doing so re-enters the "has resolvedKey,
  unresolvable" `armQuarantineKey` branch on the NEXT boot instead of the plain pending-divert branch,
  reopening the exact collision this fix exists to close.
- Do not change `clearMergeQuarantineByKey`'s own delete behavior at the shared key — the clear must
  still proceed, still lift the slot, still delete the physical file; `e1cb7d33`'s retraction already
  settled this. This card's fix is purely additive durability for the LOSING side, never a refusal.
- Do not wire `clearingRepoPath` through the OTHER three `deleteMergeQuarantineLatchByKey` call sites
  (the pending-entry `armedKeys` sweeps in `clearMergeQuarantineByKey`/`clearMergeQuarantineByRecordedPath`/
  `clearPendingEntryByToken`-adjacent code) without re-deriving whether they can even reach the collision
  shape — each already gates on `pendingEntryStillOwnsKey`, which confirms the key's occupant IS the
  pending entry's own identity before lifting it, so the "different identity" case this card protects
  against cannot arise there; adding the parameter unconditionally everywhere was considered and is
  unnecessary complexity for paths that already exclude the hazard structurally.

## Verification

`test/merge-quarantine-pass1-migrate-union.mjs`'s `in-memory-twin-clear-destroys-degraded-file` scenario,
promoted from report-only to asserting: no protective copy exists before the clear; `Ky`'s shared
physical file is still correctly deleted (`Y` legitimately owns `Ky` now); `X`'s protective copy is
minted by that SAME clear call; `X` survives — enforced, findable by its own path — across ≥3 reboots
with a STABLE file count (no new protective copy minted per boot, since a protected entry carries no
`resolvedKey` and so is never re-armed/re-protected on a later boot). `in-memory-twin-clear-x-removes-
safety-copy` continues from there: clearing `X` by its own path removes its protective copy with no
residue, and it does not resurrect on a later boot.

Regression coverage: the full `merge-quarantine*.mjs` corpus (27 files, serial, each its own fresh
`LOOM_HOME`) — including `merge-quarantine-migrate-source-owner-durable.mjs` (the 4 scenarios false start
2 broke: `minor2-stale-snapshot-double-report`, `round4-G2-recovery-writeback-clobbers-degraded-occupant`,
`round4-G2-reversed-occupant-wins-union`, `round4-minor2-sub-older`) and `merge-quarantine-unresolvable-
path.mjs` (UNION-KEYS, the scenario the identity-compare fix closes) — all green.

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs --test packages/daemon/test/merge-quarantine-
unresolvable-path.mjs --test packages/daemon/test/merge-quarantine-migrate-source-owner-durable.mjs`: RED
reverted to the pre-fix parent, GREEN restored, tree confirmed byte-identical after, measured directly off
the tool's own summary.

`pnpm --filter @loom/daemon guards` — all 30 guards pass.

**Round 2 (CR `5e1ece2e`) verification:** `test/merge-quarantine-pass1-migrate-union.mjs` grew three new
scenarios — `gone-subdir-not-foreign` (MAJOR #1 — later REPLACED by round 3's own
`gone-subdir-reblocks-once-then-clearable`, see below), `dual-collision-union-survives-second-protect`
(MAJOR #2), `reversed-tie-break-no-protection-report-only` (MAJOR #3, report-only). Regression coverage:
the full `merge-quarantine*.mjs` corpus (27 files, serial, each its own fresh `LOOM_HOME`) plus 13
adjacent non-`merge-quarantine`-named files calling
`enterMergeQuarantine`/`clearMergeQuarantine*`/`deleteMergeQuarantineLatchByKey` (found via
`grep -lE "enterMergeQuarantine|clearMergeQuarantine|deleteMergeQuarantineLatchByKey" test/*.mjs | grep -v
merge-quarantine-`) — all green. `pnpm --filter @loom/daemon guards` — all 30 guards pass.

**Round 3 (CR `8050192c`) verification:** `gone-subdir-not-foreign` REPLACED by
`gone-subdir-reblocks-once-then-clearable` (pins the FAIL-CLOSED contract: a protective copy IS minted
for the same-repo subdir, `y` stays free while the subdir stays gone, `y` is re-blocked once the subdir
is restored and a boot runs, and a further ordinary clear — performed once resolvable — removes it for
good with no new protective copy; see round 4 item 2 below for the precise bound this scenario pins).
New scenario `foreign-nested-repo-quarantine-survives` (the CR's own counter-
example: the SAME setup, but the path is restored as a real, separate repo with its own `.git` and a
genuinely different key — its own quarantine survives the reboot, migrated to its own key, and `y` is
correctly NOT re-blocked). `!tokens.includes("y-token")` assertions added to both in-memory-twin
scenarios' own protective file (immediately after the clear) and across all 3 reboots. All 15 scenarios
in the file pass; the same 27-file `merge-quarantine*.mjs` corpus, the same 13 adjacent files, and
`pnpm --filter @loom/daemon guards` (30 guards) all stay green.

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-pass1-migrate-union.mjs --ref HEAD` (ref = round 2's own `ebb31560`):
RED — exactly 4 scenarios fail, each for the described reason: both in-memory-twin scenarios on the new
`y-token` absence assertions (the bleed, reproduced on the very FIRST protect call);
`gone-subdir-reblocks-once-then-clearable` on "a protective copy IS minted" (round 2's skip suppressed
it); `foreign-nested-repo-quarantine-survives` on "a protective copy is minted"/"still enforced"/"still
quarantined after the reboot" (the fail-open data loss). GREEN restored after the fix, tree confirmed
byte-identical after, measured directly off the tool's own summary.

**Round 4 (CR `32679c84`) verification:** hand-mutated `protectDegradedOccupantBeforeDelete`'s own
`atFinalBasenameIdx` re-point back to its OLD form (`{ entry: pendingUnresolvedQuarantines[atFinalBasenameIdx].entry,
sourceFile: filename }`, i.e. keep the stale object) and rebuilt — RAN ONLY
`in-memory-twin-clear-destroys-degraded-file` (`--scenario=` flag): RED, exactly the two new round-4 PIN
checks plus (unplanned, but welcome) the three existing round-3 `y-token`-absence reboot checks, since
the contamination this time reached the durable file too. Reverted the hand-edit (confirmed byte-for-
byte identical to the committed source via `git diff`), rebuilt: GREEN, the full scenario and the
rest of the file unaffected. All 15 scenarios in the file pass with the real fix; the same 27-file
`merge-quarantine*.mjs` corpus, the same 13 adjacent files, and `pnpm --filter @loom/daemon guards` (30
guards) all stay green, run both before and after the commit.
