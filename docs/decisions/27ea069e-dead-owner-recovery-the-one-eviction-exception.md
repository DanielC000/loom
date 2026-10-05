# 27ea069e — dead-owner recovery: the ONE exception to evict-on-settle-only

## Narrative

Evict-on-settle (deleting an entry from the map the moment it settles, inside `run()`'s own `.then`/`.catch`) is right for the normal case, but a `run()` invocation can outlive the manager session that started it — that manager crashed, was stopped, or is otherwise gone — with no live caller left who could ever be handed its outcome through the normal settle path. `evictDeadOwner()` force-removes such an entry AHEAD of its own settlement, letting a fresh `attach()` on the same `key` start a genuinely new invocation instead of dedup-attaching to (or spin-polling) one that can never be delivered. See `SessionService.confirmWorkerMergeTracked` (per-call defensive check) and `reconcileDeadOwnerMergeOps` (boot-time sweep).

**Accepted tradeoff:** `evictDeadOwner` can only remove the MAP ENTRY, never cancel the orphaned `run()` itself (there's no handle to cancel a bare Promise) — the old op's real work keeps executing in the background, unreachable, until it eventually settles on its own. That late settle's EFFECT ON THE REGISTRY is harmless: `attach()`'s identity-guarded delete (`this.entries.get(key) === fresh`) means it can only clear its OWN (already-detached) entry, never the successor `evictDeadOwner` made room for. ⛔ **The sentence that used to follow — claiming the remaining host-load question is "bounded by the daemon-global `GateSemaphore`" — is WRONG; see "Card 47a22d40" below, which corrects it and narrows WHEN eviction may fire at all.**



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

`confirmWorkerMergeTracked`'s own call site is unaffected on the healthy path: two managers/retries
racing a genuinely in-flight merge, or a manager that recycled mid-merge, stay byte-identical to before
this check existed.

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

## Card `47a22d40` — the "Accepted tradeoff" paragraph was wrong about the surrounding git work, not just the gate run

The original "Accepted tradeoff" paragraph above reasoned only about whether the orphaned `run()` and its
successor could both drive a real GATE COMMAND concurrently — and concluded that was safe because
`GateSemaphore` serializes gate runs daemon-wide. That reasoning is correct as far as it goes, but it
answers the wrong question: the gate command is only one step inside `confirmWorkerMerge`. The surrounding
git work it wraps — `computeWorktreeGateStamp`'s fresh-stamp read, `captureGatedTip`, the pre-gate
union-merge, and `finalizeMerge`'s squash/cleanup — runs UNCOORDINATED against the SAME worktree path, with
no lock of its own, well before `gateSemaphore.runExclusive` ever serializes anything. `GateSemaphore`
protects nothing here.

Worker `2100dbc4` (card `19f959ea`, 2026-10-05) reproduced this 100% with real production code, no fault
injection: shorten the test's own post-gate `waitBriefly` budget so a dead-owner re-call lands while the
FIRST op is still genuinely `state:"running"` (not abandoned — a live promise actually executing in this
process), and `confirmWorkerMergeTracked`'s dead-owner check evicts it every time, minting a FRESH
`confirmWorkerMerge` that races the orphaned one's still-in-flight union-merge/squash/finalize against the
SAME worktree. Observed outcomes were nondeterministic across repeated runs: sometimes a lucky `merged:true`,
sometimes a reported failure whose text matched the production symptom verbatim, sometimes
`ALREADY_MERGED` paired with "could not verify the branch tip ... now unreadable." Full write-up and
repro: project memory `mrt-dead-owner-release-flake-pre-existing` (v2).

### The deeper error: dead ownership alone was never grounds to evict a RUNNING entry

`PendingOpRegistry`'s own class doc already states the invariant this bug violated: a `state:"running"`
entry is PROCESS-LOCAL and is, by construction, always backed by a currently-executing `run()` promise in
THIS exact process (`entries` is populated synchronously at mint, before `run()`'s first `await`, and
cleared synchronously inside that same `run()`'s own `.then`/`.catch` — see `attach()`). It can therefore
never be a genuine restart orphan (a real daemon restart wipes the whole in-memory registry; THAT case is
recovered separately, from the DURABLE `pending_gate_ops` table, by `reconcileOrphanedGateOps` — a
deliberately distinct mechanism, see `index.ts`'s boot sequence). A dead OWNER only means nobody is left to
be notified when the op settles — it says nothing about whether the op itself is still progressing, and a
RUNNING entry, by the invariant above, always is, until it demonstrably isn't.

### The fix: gate eviction on elapsed time, not ownership alone

Both call sites (`confirmWorkerMergeTracked`'s per-call check and `reconcileDeadOwnerMergeOps`'s boot
sweep) now also require `SessionService.isDeadOwnerOpStuck` — the op must have been running longer than
`SessionService.deadOwnerEvictionCeilingMs` (the SAME ceiling `confirmWorkerMergeUntilSettled` already uses
to decide when IT gives up waiting: `gateCommandTimeoutMs * 6`, else `DEFAULT_REST_MERGE_CEILING_MS`,
resolved per the op's own project) before eviction may fire at all. Below that ceiling, a dead-owner'd
RUNNING entry is left alone — the call falls through to the ordinary `pendingOps.attach()` dedupe
(keyed purely by `key`, independent of which manager is calling), which already hands every attached
caller the SAME shared settle, for free, with no new registry API. This is the SAME underlying mechanism
`confirmWorkerMergeTracked`'s lineage-resolved-key arm already relies on for the recycle trigger (see the
class's own `peekPendingMerge`/`lineageResolvedPendingOp` doc) — now also covering the dead-owner trigger.

This preserves the ONE case eviction is genuinely still needed for: an entry that has DEMONSTRATED, by
clock rather than by owner-liveness alone, that it will never settle (a true stuck promise — a bug, or a
hung child process with no timeout anywhere in its chain) — past the ceiling, there is no legitimate way
a real merge could still be in flight, so eviction is the only way to free a permanently-wedged `key` for
future recovery, even though (per the "Accepted tradeoff" above, otherwise unchanged) it still can't cancel
the orphaned `run()` itself.

### Do not (3)

- Do not evict a RUNNING `PendingOpRegistry` entry on dead ownership alone — a dead owner proves only that
  nobody is left to be notified when the op settles, never that the op itself has stopped progressing.
  Always gate eviction on `isDeadOwnerOpStuck` (elapsed time since mint past the shared ceiling) too.
- Do not re-derive the ceiling (`gateCommandTimeoutMs * 6` / `DEFAULT_REST_MERGE_CEILING_MS`) at a second
  call site — both `confirmWorkerMergeTracked` and `reconcileDeadOwnerMergeOps` must resolve it through the
  SAME `SessionService.deadOwnerEvictionCeilingMs` helper, or the two can silently diverge.
- Do not read `GateSemaphore` as covering anything outside the gate COMMAND itself — the union-merge,
  worktree-stamp read, and squash/finalize around it are unserialized against a concurrent op on the same
  worktree.

### Source (3)

`packages/daemon/src/sessions/service.ts`: the `@decision 47a22d40` anchors at
`confirmWorkerMergeTracked`'s dead-owner check, `reconcileDeadOwnerMergeOps`, `deadOwnerEvictionCeilingMs`,
and `isDeadOwnerOpStuck`. Card `47a22d40`; discovering card `19f959ea`; project memory
`mrt-dead-owner-release-flake-pre-existing`.
