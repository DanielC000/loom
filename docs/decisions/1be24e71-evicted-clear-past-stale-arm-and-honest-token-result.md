# 1be24e71 — an evicted entry's clear already lifts past a stale secondary arm; the token clear now reports an honest result

From d163aef5 CR round 4 (finding 3): the evicted D (diverted to pending because winner Z holds a stale secondary arm at D's key K2) could not be lifted by any route while Z kept that arm.

## Premise check (measured on main d436511e, the round-4 P1 fixture, one fresh LOOM_HOME per route)

| Route | Result |
|---|---|
| by token (`clearMergeQuarantineByToken(d, "d-token")`) | D's file unlinked, d-token gone after a reboot, Z still quarantined. Returned `void`. |
| by path (`clearMergeQuarantineByRecordedPath`, `clearMergeQuarantineReporting`) | same durable lift; reply `stillQuarantined:true`, reason names Z. |
| by id (`clearMergeQuarantineLatchFile(hash(K2))`) | refused: "matches BOTH an active quarantine (Z) AND a pending entry for a DIFFERENT repo (D)". Nothing cleared. Correct. |

So the DoD's durable-lift clause was already met. Two independent mechanisms each suffice (`negative-control --mutant`, behavioural RED only when BOTH are disabled; each alone leaves every scenario green):
- (A) `physicalOwnerRepoPaths` withholds Z's claim when the file's confirmed occupant is a different, UNRESOLVABLE entry (the `differentUnresolvableOccupantRepoPathAt` gate, introduced by commit 838520c4, anchor `a50faa55`).
- (B) `activeOwnerClaimIsSettledByCoverage` (05a3b6ad) settles an active owner's claim when a fresh read proves the whole content is covered by this clear.
The first draft of this card's plan credited 05a3b6ad alone; the mutant disproved that. Whether (B) is needed for a RESOLVABLE evicted entry is NOT established: a probe with two real repos (Z's file carrying a stale `resolvedKey` equal to D's real key, both boot orders) left nothing pending and armed each at one key, because e7652e06's freshness gate declines Z's stale secondary when both sides are resolvable. No resolvable-eviction fixture was found, so nothing here claims (B) covers one.

Isolation of each mechanism's own tests (`negative-control --mutant`, one mechanism disabled at a time): `merge-quarantine-05a3b6ad-fresh-target-covered-clear.mjs` goes RED with (B) disabled alone (19 failing assertions), so it pins (B) in isolation. `merge-quarantine-a50faa55-raiser-selfheal-strands-occupant-clear.mjs` and `merge-quarantine-migrate-source-owner-durable.mjs` (the two files 838520c4 touched) stay GREEN with (A) disabled alone and go RED only with (A)+(B) disabled (3 and 1 failing assertions): nothing pins (A) in isolation today. Not fixed here.

## What this card changes

`clearMergeQuarantineByToken` returned `void`, so a caller could not tell "D lifted, still blocked by Z's stale arm" from a no-op. It now returns `ClearByTokenResult`: `matched` (an entry held the token when the call started; false = a no-op), `lifted` (`matched` and no active or pending entry holds the token now), `durable:false` (present only when a durable write failed during the call), `stillBlockedBy {repoPath, reason}` when the pure `stillBlockedEntryFor` re-check still finds `repoPath` blocked (also logged once), and `refusedBeforeClear`/`reason` on the pre-clear foreign-key refusal. The re-check is skipped while no entry exists at all.

`lifted` is the IN-MEMORY outcome, and a failed durable write leaves it true (`clearActiveEntryTokenAtKey` drops the token from memory regardless, and a reboot may re-arm it). We chose to ADD `durable:false` rather than gate `lifted` on the write: callers that act on the in-process state (the auto-clear sites) must keep seeing the token gone, while the honest caveat travels beside it. `durable` is false when the call-scoped `writeFailedIdentitiesThisCall` set is non-empty OR `decideDeferredTombstones` withheld any tombstone (card a090d65c: a kept file still physically holds the token, so no tombstone is written and a reboot re-arms it, with no write failure at all), so it is conservative: any recorded write failure or withheld tombstone in the call sets it, even for an unrelated identity the call touched. Measured on a090d65c: a pending claimant Z whose sole file is another repo's key file; `clearMergeQuarantine(W)` keeps that file (`latchKept`), then two by-token clears for Z returned `{lifted:true, matched:true}`, Z read unblocked in-process, and a reboot re-armed both tokens. The tombstone withholding is the designed fail-closed behaviour; only its silence was the defect.

Callers (grep of `packages/*/src`): the eight auto-clear sites after a confirmed-dead kill (`batch-merge.ts` x2, `worktrees.ts` x2, `writer.ts` x3, `vault/versioner.ts`) all call it as a bare statement. Ignoring the value there is correct: the in-process caller has no human route to surface it to, and the function logs the still-blocked case itself. There is no REST, MCP or web caller. No test used the old return value.

## By-id offer (R2): no change

Route builders (`routeIdWouldBeRefused`, `byIdClearRefusalFor`) and `assertRepoNotQuarantined`'s text already withhold the dead bare id for D and name the `{repoPath}` route. The raw `quarantineLatchFileIdsFor(D)` still returns hash(K2), and `GET /internal/merge-quarantine/list` exposes it as a listing id next to `repoPath`; it is not presented as a followable route, so it is left alone.

## Do not

- Do not change `physicalOwnerRepoPaths` to stop crediting a stale secondary arm: the credit is deliberate (`9cabd143`, `8db913e2`); the occupant gate and the coverage settle already decide it.
- Do not make the by-id clear disambiguate an ambiguous id by guessing (`613e4592`, `8e8bc0be`).
- Do not compute `stillBlockedBy` with a mutating resolver (`resolveQuarantineFor`/`activeMergeQuarantineFor`): it would change the state being reported (`1b49fb56`).

## Tests

`merge-quarantine-1be24e71-evicted-clear-past-stale-arm.mjs`: token, path and Reporting lifts across a reboot with Z staying; the by-id offer and refusal; an uncovered-token control (D holding two tokens keeps its file); a clear-the-winner control (a clean clear reports no `stillBlockedBy`). Also: a no-op token, and a `durable:false` write-failure scenario (D holding two tokens, openSync failing on its file); `merge-quarantine-3b1944b6` pins the `refusedBeforeClear` object (new `round6-route-token-markfail`) and the bogus-token no-op (`round8-q2b`). Not covered: a RESOLVABLE evicted entry (no reachable fixture found, see above).
