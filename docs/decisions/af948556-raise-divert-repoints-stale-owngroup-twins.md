# af948556 — the raise-divert branch re-points an `ownGroup` member's own active slot before diverting

From round-2 CR `c2f970da` of card `37452ddd` — a code-read hypothesis, confirmed REACHABLE by a
hermetic repro, then confirmed by Code Review `bfa97ca3` to be a genuine, exploitable, IN-PROCESS
**FAIL-OPEN** — not merely an invariant-violation curiosity.

## Severity: fail-open

In `consumeMatchedPendingsIntoArmedEntry`'s raise-divert branch (`skipDegradedOccupantGuard` true, the
fold-in read of the raiser's own fresh key returns `"unreadable"`), every matched pending index is
spliced out of `pendingUnresolvedQuarantines` at the top of the function, then the raiser's own identity
group (`ownGroup`) is unioned BY VALUE into `raiserUnion` and diverted. Pre-fix, no
`replaceEntryEverywhere` call re-pointed whatever slot an `ownGroup` member's own object reference already
occupied in `activeQuarantines` — an 883e29bc/64283e06 boot twin, armed under a DIFFERENT, degraded
walked-up key from an earlier boot.

That left two live, non-reference-equal objects for one identity: a STALE one at the old key (missing the
raise's own fresh token) and the correct `raiserUnion` (pending-only, holding the fresh token). **Right
after the raise, with no query in between, clearing the stale object's own two pre-existing tokens —
`clearMergeQuarantineByToken(d, tok-b)` then `(d, tok-c)` — emptied the stale object and, through whatever
sweep fires once an active entry empties, also lifted `raiserUnion`, even though it still carried D's own
fresh, never-cleared token.** Measured pre-fix: both `S`'s key and `D`'s own identity reported OPEN while
D's fresh token was still outstanding — a real, silent, in-process unquarantine, not merely a tripped
invariant check.

The removed comment ("Nothing has been armed into `activeQuarantines` yet") was true only for a fresh
raise with no prior boot twin — false whenever one already exists.

## The fix

`for (const p of ownGroup) replaceEntryEverywhere(activeQuarantines, p.entry, raiserUnion);`, added right
before `divertRaiseEntry(raiserUnion)`. `replaceEntryEverywhere` only replaces an EXISTING map value
reference-equal to `p.entry`; it never adds a key — pure re-pointing, never a union source (c9114934),
never an arm of `key` itself (no double-arm: `Kd` is still never written by this branch — only the
divert's own pending-mint, then ordinary lazy graduation on a later query, arms it).

`Ks` (the twin's old key) is re-pointed to `raiserUnion`, which carries every `ownGroup` token PLUS the
fresh one, so `S` stays blocked including D's new token. `Kd` is not armed by this branch. No slot opens,
none double-arms. The same clear-by-token ordering that fail-opened pre-fix now correctly leaves both `S`
and `D` blocked until the fresh token is also released.

## Precondition note (Lead ruling)

Reachability requires an unreadable `final` at the raiser's own fresh key exactly where
`consumeMatchedPendingsIntoArmedEntry`'s own internal fold-check reads it — rare in production (a
transient I/O failure on that one specific read), but real: the same class every other
`keptUnreadableLatchFiles` call site in this module already treats as live.

## Do not

- Do not call `replaceEntryEverywhere` with `raiserUnion` as a UNION SOURCE elsewhere in this branch —
  it is a REPLACEMENT target only, consumed by `ownGroup`'s own prior values (c9114934).
- Do not also `activeQuarantines.set(key, raiserUnion)` here — the raiser's own fresh key is never armed
  by a diverted raise; only `foreignGroups`'s own re-insertion and eventual lazy graduation arm a new key.
- Do not assume `divertRaiseEntry`'s own `collectPendingIndices` call needs a matching fix — by the time
  it runs, `ownGroup`'s own pending slots are already spliced out by this function's top-of-function
  splice; `divertRaiseEntry` only ever sees entries NOT already consumed here.
- Do not assume this fix covers the `foreignGroups` branch (~L1529-1543) — a SEPARATE, as-yet-untouched
  same-class candidate, carded separately. Out of scope here; do not touch it from this card.
- Do not trust a mid-window assertion that runs after `activeMergeQuarantineFor(d)` (or any query of D's
  own fresh key) — that query itself lazily graduates the pending record and self-heals the pre-fix
  duplicate, so most naive "fixed" assertions pass on BOTH the broken and fixed code. Assert immediately
  after the raise, before any such query.

## Tests

`packages/daemon/test/merge-quarantine-raise-divert-strands-twin-af948556.mjs` — its own dedicated file;
each scenario gets a freshly-imported module instance, so `assertQuarantineIdentityInvariantTestOnly().ok`
is directly meaningful, unlike in the shared, 4700-line `merge-quarantine-raise-protect-failure.mjs`.

- **SCENARIO 1** — mid-window, strictly before any query of D's own key: the GLOBAL identity invariant
  holds, exactly one D-repoPath object exists, `S`'s slot already includes D's fresh token with no later
  query needed. Two WITNESSES precede it (E's bytes at `Kd`'s final unchanged; a pending record for D
  exists on disk) so injection-numbering drift can never silently exercise a different branch and pass
  vacuously.
- **SCENARIO 2** — THE FAIL-OPEN: clears `tok-b` then `tok-c` with no query in between; asserts `S` and
  `D` BOTH stay blocked (fresh token outstanding), then that releasing the fresh token too lifts both.

Proven RED (6 checks fail, across both scenarios, including the fail-open assertions) on pre-fix `HEAD`
(only the `replaceEntryEverywhere` line deleted) / GREEN after, via a surgical delete-rebuild-restore,
`tsbuildinfo` cleared each time, restore confirmed byte-identical via `cmp`.
