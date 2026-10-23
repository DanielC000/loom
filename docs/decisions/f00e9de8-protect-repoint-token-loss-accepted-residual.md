# f00e9de8 — `protectOccupantContentBeforeDelete`'s `atFinalBasenameIdx` re-point can drop an armed
twin's own in-memory-only tokens; accepted as a logged residual, not fixed

From Code Review `3e2c79c5` of `0faffa95`, Q1 — a design question first, investigated before any fix:
should the both-indices/`atFinalBasenameIdx`-only re-point in `protectOccupantContentBeforeDelete` ever
recover an armed twin's own in-memory-only tokens? `0faffa95`'s own decision record names this card
explicitly as the separately-open residual: "Card `f00e9de8` (the related question of an armed twin's own
in-memory tokens being dropped by the re-point) remains separately open."

## The shape

`protectOccupantContentBeforeDelete` (`merge-quarantine.ts`) re-reads `final`'s own on-disk bytes into
`toPersist`, optionally unions `atFilenameIdx`'s own in-memory entry on top (`@decision 8db913e2`,
Follow-up `6451a749` Round 2), and writes the result as `written.entry`. When `atFinalBasenameIdx` also
matches a SAME-IDENTITY armed twin (`atFinalBasenameSameIdentity`, `@decision 8db913e2` Follow-up
`cd5a3cf9`), both the both-indices branch and the `atFinalBasenameIdx`-only branch call
`replaceEntryEverywhere(activeQuarantines, oldAtFinalBasename, written.entry)` — re-pointing EVERY key
that referenced the twin onto `written.entry`. `written.entry` never includes `oldAtFinalBasename`'s own
tokens (`@decision 8db913e2` Follow-up `37452ddd`: "re-point for the REPLACEMENT only, never as a union
source — `c9114934` still forbids unioning `atFinalBasenameIdx`'s own tokens into `toWrite`"), so any
token the twin held ONLY in memory — never reflected in `final`'s own on-disk bytes — is dropped the
instant this re-point runs.

## Q1 — reproduces; the loss is now PERMANENT where it used to be "accidentally" recoverable

Confirmed by code reading, no fix needed to observe it: the token vanishes from the in-memory entry
immediately, in-process, the moment the re-point runs — no reboot required. Before `0faffa95`/`6be6c9ff`
landed, the twin's OWN other on-disk latch file (at its own armed key) could still physically carry that
token untouched (nothing had yet made a later clear correctly visit every one of a multi-key twin's
armed keys), so a REBOOT could "accidentally" resurrect it from disk. After `0faffa95` (defers a
re-resolved active twin to phase 2) and `6be6c9ff` (`liveArmedKeys` makes phase 2 correctly visit every
key a multi-key twin reaches), a later clear that reaches the twin's key via `clearActiveEntryTokenAtKey`
now durably REWRITES that latch from the post-re-point (token-less) in-memory entry — erasing the last
surviving durable copy. Landing those two cards closed the accidental-survival path; the loss is now
final once any clear touches the twin's key, not merely until the next reboot.

## Q2 — real-world reachable, but via a genuine durable-write FAILURE, not an ordinary successful raise

**Correction, found while building this card's own test (verified empirically, not merely reasoned
about): the investigation's first-pass claim that an ORDINARY, no-fault raise elsewhere could reach this
divergence was WRONG.** `enterMergeQuarantine`'s own unresolvable-raise branch (`d`'s own repoPath is
never currently resolvable in the `37452ddd-twin-repoint-finalbasename` shape) does NOT go through the
`existing`/armed-key write loop at all — `isRepoPathCurrentlyResolvable` gates that branch, so an
unresolvable D's own re-raise instead matches the twin by IDENTITY against `pendingUnresolvedQuarantines`
and routes through `mergeTokenIntoPendingEntries`, which re-points `activeQuarantines` in memory
UNCONDITIONALLY (`replaceEntryEverywhere`, before any write is attempted) but then durably rewrites the
SAME file the twin's own pending reference already names — `final` (R's own slot) in this exact shape.
An ordinary, successful raise therefore keeps `final` and memory in sync; it does NOT reproduce Q1's
shape on its own.

**The genuine mechanism is the one `6451a749`'s own repro already used: a durable-write FAILURE for that
exact file** (disk-full, a permission error, an EACCES/ENOSPC-shaped condition this module already
handles everywhere as a first-class case) — `mergeTokenIntoPendingEntries`'s in-memory merge
(`replaceEntryEverywhere`) runs BEFORE its own `writePendingDivertFile` call, so a failure of THAT write
alone leaves the twin's in-memory tokens durably ahead of `final`'s own stale bytes, with `e1cb7d33`'s
own "a raise must persist" guarantee honored via memory. This is real-world reachable (this whole module
exists to handle exactly these failure classes) but via a FAULT, not an ordinary success — the test below
reproduces it with the same `injectOpenSyncFailureForPrefix` fault-injection technique `37452ddd`'s own
double-fault scenarios already use, never a hand-constructed state no real code path could produce.

## Q3 — quote `c9114934`, and why `cd5a3cf9`'s identity check does not close the gap enough to union safely

`c9114934`'s own "Do not" (quoted verbatim): "union ONLY from a ref keyed by `pendingDivertFilenameFor`'s
own `filename` ... NEVER from a ref keyed by `final`'s own basename (a boot-time degraded-divert push),
whose `.entry` can be the SAME live object `armQuarantineKey`'s own unconditional in-memory union already
merged a colliding sibling's tokens into."

`cd5a3cf9` (landed after `c9114934`) added `atFinalBasenameSameIdentity` — gating every use of
`oldAtFinalBasename` on `directPathIdentity(oldAtFinalBasename.repoPath) === occupantIdentity`. This does
NOT fully close the contamination vector `c9114934` warns about: `unionQuarantineEntries` (`:806-857`)
deliberately keeps the OLDER side's own `repoPath` on any union, so a boot-time `armQuarantineKey`
cross-identity union (`:907-923`) can produce an object whose `repoPath` still equals the occupant's own
verified identity while its token set secretly includes a foreign sibling's tokens — exactly the shape
`c9114934` Round 3's MAJOR #2 bug reproduced and fixed ("a probe against `ebb31560`'s own compiled dist
reproduced it on the FIRST ever protect call for the base in-memory-twin fixture" — same-identity at
`atFinalBasenameIdx` AND contaminated, simultaneously).

Worse: the fields meant to flag cross-identity contamination (`contributorRepoPaths`/`provenanceUnknown`)
do not reliably catch it either. `unionQuarantineEntries`'s own comment (`:816-817`, `@decision 82032b5c`)
states it "never originate[s] a new entry here" for `contributorRepoPaths` — it only propagates an
ALREADY-SET value forward. The only site that actually ORIGINATES `contributorRepoPaths` (stamps a losing
identity's own `repoPath` into it for the first time) is `consumeMatchedPendingsIntoArmedEntry`
(`:1606-1613`, `@decision 82032b5c` round 6) — the RAISE path. `armQuarantineKey`'s own boot-time
fall-through (PASS 1/1b) never stamps it on a cross-identity union. So an entry contaminated purely via a
boot-time `armQuarantineKey` union carries NO field-level signal distinguishing it from a genuinely pure
twin — there is no discriminator available today to gate a safe union.

## Q4 — decision: accept as a documented, LOGGED residual

Same posture/severity class as the existing `armedKeys` residual (`@decision 8db913e2` "armedKeys — left
unfixed (Lead ruling)"): fail-closed in effect, bounded harm. The entry stays armed/blocking under its
OTHER tokens and keys — this never unblocks a repo. Only the specific dropped token's own distinguishing
trace is lost (e.g. a specific merge-op's own outstanding marker), not the occupant's overall quarantine.
A union fix is NOT safely buildable today (see Q3) without reopening `c9114934` Round 3's MAJOR #2 —
closing it for real needs `398f476c`'s own token-level identity-model work, not a local gate here.

**The fix actually shipped: logging only.** `logProtectRepointDroppedTokens` (`merge-quarantine.ts`,
directly above `protectOccupantContentBeforeDelete`) computes, right before EACH of the two
`atFinalBasenameIdx` re-point call sites (the both-indices branch and the `atFinalBasenameIdx`-only
branch), the COUNT of `oldAtFinalBasename`'s own tokens absent from `written.entry`. If non-zero, it logs
one disclosure-safe `console.warn` naming the dropped COUNT plus the twin's own `repoPath`/`armedKeys` —
NEVER a token value. No union, no fail-closed/fail-open change, no behavior change at all beyond the log
line. A control case (nothing dropped) logs nothing.

## Do not

- Do not union `oldAtFinalBasename`'s own tokens into `toWrite`/`written.entry` at either re-point site,
  even now that `atFinalBasenameSameIdentity` verifies `repoPath` — a repoPath match does not prove the
  token set is uncontaminated (see Q3); doing so anyway silently reopens `c9114934` Round 3's MAJOR #2.
- Do not treat `contributorRepoPaths`/`provenanceUnknown` being empty/undefined as proof an entry's token
  set is pure — `armQuarantineKey`'s own boot-time cross-identity union never originates either field
  (only `consumeMatchedPendingsIntoArmedEntry`'s raise-side union does), so an empty value here means "no
  raise-side union has flagged it yet," not "this entry was never cross-identity-unioned."
- Do not log a token VALUE in `logProtectRepointDroppedTokens` or any future caller of it — COUNT plus
  `repoPath`/`armedKeys` only, mirroring this module's other disclosure-safe, logging-only warnings (e.g.
  the `clearMergeQuarantineByToken`-adjacent "relocated co-occupant" warnings at `@decision 182c01cc`).
- Do not read this card as closed/fixed — it is an ACCEPTED RESIDUAL with a disclosure mitigation, not a
  correctness fix. Real closure is `398f476c`'s own scope (token-level identity provenance); re-attempting
  a local union fix here without that work first will very likely reopen a MAJOR-severity regression.

## Verification

`merge-quarantine-raise-protect-failure.mjs` — three new scenarios plus a control:
- **`f00e9de8-dropped-tokens-finalbasename-only`** (the `atFinalBasenameIdx`-only branch) — builds the
  twin exactly per Q2's corrected mechanism: write the initial `<Krhash>.json` latch, boot, then raise
  the twin's own (unresolvable) identity a SECOND time with `injectOpenSyncFailureForPrefix` targeting
  `<Krhash>.json` itself, so the in-memory merge succeeds (`replaceEntryEverywhere` runs unconditionally)
  while the durable rewrite of that exact file fails — the twin now genuinely holds an in-memory-only
  token absent from `final`'s own on-disk bytes when the foreign repo raises.
- **`f00e9de8-dropped-tokens-both-indices`** (the both-indices branch, two distinct objects X/Y) — X and
  Y are both written to disk BEFORE the one boot call (mirroring `37452ddd-branch1-dual-twin`'s own
  already-proven construction) so they boot as two separate objects; X's own in-memory-only token is then
  added by directly mutating the twin's own live, shared object (`activeMergeQuarantineFor` returns the
  live reference) rather than via a second raise — raising D's identity after Y already exists merges
  every pending index sharing that identity (`mergeTokenIntoPendingEntries`) into ONE object, which would
  destroy the two-separate-objects precondition this scenario needs; this was discovered empirically while
  building the scenario, not assumed. The finalbasename-only scenario above already covers the realistic
  write-failure trigger for this same divergence; this scenario's own job is only to prove the
  both-indices branch's own re-point and logging behave identically.
- **`f00e9de8-no-drop-no-warning`** — the negative control: the exact same single-file twin shape as
  `37452ddd-twin-repoint-finalbasename`, with NO second raise before the foreign repo raises, so nothing is
  dropped. Asserts the warning never fires.

Each positive scenario asserts the warning fires exactly once, with the correct dropped-token COUNT, and
that the warning text never contains the dropped token's own literal value.

All `merge-quarantine*.mjs` run individually, in both env states (`env -u LOOM_DEV -u LOOM_SUPERVISED` /
`LOOM_DEV=1 LOOM_SUPERVISED=1`), fresh temp `LOOM_HOME` per file. `pnpm --filter @loom/daemon guards`,
committed first.

`log-message-content-gate.mjs`'s own census (section 4) is an exact-count census of `redactedExcerpt(`
calls in `pty/host.ts` and `sessions/service.ts` ONLY (per that test's own header) — this card's new
warning is in `git/merge-quarantine.ts`, routes through no `redactedExcerpt(` call, and is not a session/
agent-text log at all (it names a repoPath/key/count, never user or agent content). That census is not
affected by, and does not cover, this change.
