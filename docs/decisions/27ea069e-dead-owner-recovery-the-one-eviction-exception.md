# 27ea069e — dead-owner recovery: the ONE exception to evict-on-settle-only

## Narrative

Evict-on-settle (deleting an entry from the map the moment it settles, inside `run()`'s own `.then`/`.catch`) is right for the normal case, but a `run()` invocation can outlive the manager session that started it — that manager crashed, was stopped, or is otherwise gone — with no live caller left who could ever be handed its outcome through the normal settle path. `evictDeadOwner()` force-removes such an entry AHEAD of its own settlement, letting a fresh `attach()` on the same `key` start a genuinely new invocation instead of dedup-attaching to (or spin-polling) one that can never be delivered. See `SessionService.confirmWorkerMergeTracked` (per-call defensive check) and `reconcileDeadOwnerMergeOps` (boot-time sweep).

**Accepted tradeoff:** `evictDeadOwner` can only remove the MAP ENTRY, never cancel the orphaned `run()` itself (there's no handle to cancel a bare Promise) — the old op's real work keeps executing in the background, unreachable, until it eventually settles on its own. That late settle is harmless: `attach()`'s identity-guarded delete (`this.entries.get(key) === fresh`) means it can only clear its OWN (already-detached) entry, never the successor `evictDeadOwner` made room for — so the tradeoff trades "stuck pending forever" for a lingering, functionally-inert background call, not a resurrected/duplicated result. The remaining host-load question — could the orphaned run and its successor both drive a real gate command CONCURRENTLY — is bounded by the daemon-global `GateSemaphore` (`orchestration.maxConcurrentGates`): it serializes actual gate RUNS across the whole daemon, so the orphaned run and the fresh one can't execute gates at the same time even though both are technically "in flight" JS-side.

## Do not

- Do not treat `evictDeadOwner` as cancelling the orphaned invocation — it only detaches the map entry; the old `run()` keeps executing in the background until it settles on its own, harmlessly, because the identity-guarded delete can only clear its own entry.

## Source

Inline comments in `packages/daemon/src/orchestration/pending-ops.ts`: the class doc's "DEAD-OWNER RECOVERY" paragraph (lines 244-250) and `evictDeadOwner`'s own "ACCEPTED TRADEOFF" paragraph (lines 487-497), as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.

## `isManagerLineageDead`: a lineage is dead only when NO link anywhere in it is live

`sessions/service.ts`'s `isManagerLineageDead` is the check feeding `evictDeadOwner` above and
`ownerSessionAlive` (see `docs/decisions/d5e67146-tombstone-pending-liveness-signal.md` for that field's
own doc — the correction narrative below is the same incident, told from this check's side). A manager's
LINEAGE is "dead" for pending-merge-op purposes only when there is no LIVE session anywhere in its
recycle chain — none of these can ever come back to observe a pending op's outcome through the normal
`attach()`/settle path. Deliberately conservative: `"starting"` (every spawn/resume/recycle path inserts
a session row at `processState:"starting"`) is a genuinely transient window that closes SYNCHRONOUSLY,
with no intervening `await`, before any pty is even wired up — every call site flips it to `"live"` a
handful of lines after the insert. An op owner, by construction, has already made a real MCP call — it
cannot still be inside that pre-pty window — so `liveLineageSuccessor` simply reuses the SAME
`processState === "live"` liveness test every other reader in this file already uses, rather than
special-casing a state no real caller can be caught in.

CORRECTED (card `257d534d`, Code Reviewer `213fe600` finding F1 on card `d5e67146`): the ORIGINAL version
of this check asked only "has THIS session (the one an op was minted under) exited or been archived" — no
lineage walk. A manager/worker recycle hard-stops the PREDECESSOR's pty and never rewrites a pending op's
`managerSessionId`, so that session-only check read a recycled-but-alive lineage as "dead" and evicted its
RUNNING op, even though every settle nudge for that same op resolves through `liveLineageSuccessor` and
would have reached the live successor just fine. Since card `81d795de` made a mid-batch recycle an
ORDINARY event (a `mergeBatch` finalize can now span tens of minutes, comfortably outliving one manager
turn), this was not a corner case — eviction and nudge-delivery disagreed about the exact same op. Fixed
by reusing the SAME `liveLineageSuccessor` primitive both `ownerSessionAlive` and every settle nudge
already resolve through, so "will eviction fire" and "will anyone actually be told" can never drift apart
again. Fails toward evicting on doubt, unchanged.

### Do not (2)

- Do not check only the minting session's own `processState`/`archivedAt` to decide a lineage is dead —
  walk the WHOLE recycle chain (`liveLineageSuccessor`), or a recycled-but-alive lineage reads as dead and
  its running op is wrongly evicted.
- Do not let eviction and settle-nudge delivery use two different liveness checks — both must resolve
  through the SAME `liveLineageSuccessor` primitive, or they can disagree about the same op.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `isManagerLineageDead`: lines
6326-6357, as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
