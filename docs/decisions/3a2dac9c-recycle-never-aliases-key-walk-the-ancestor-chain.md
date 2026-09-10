# 3a2dac9c — a `worker_recycle` never aliases its key onto the recycled session; both the read and write sides must walk the ancestor chain

## Narrative

One op per `key` at a time (spawn: `spawn:${taskId}`; merge: `merge:${workerSessionId}`; gate: `gate:${workerSessionId}`; merge-batch: see below). A `worker_recycle` mints a fresh session id for the recycled worker but never rewrites or aliases the old `merge:${workerSessionId}` key onto it — so both the READ side (`peekPendingMerge`) and the WRITE side's own key selection (`confirmWorkerMergeTracked`, before calling `attach()`) walk this worker's `recycledFrom` chain backward and prefer an ANCESTOR's key when a RUNNING op is found under one. Without this walk, a confirm addressed to the successor would mint a SECOND, concurrent op for the same worktree (two `confirmWorkerMerge` invocations racing the same git state), and a peek addressed to the successor would read blind to the predecessor's still-in-flight op (worker_list showing no pending merge for a worker that, under its old identity, has one running).

The same walk was later needed for the merge-batch key too. That key (`merge-batch:${managerSessionId's LINEAGE ROOT}:${sorted, comma-joined LINEAGE ROOTS of the resolved candidate set's workerSessionIds}`) was originally minted from raw session ids by card f944d4e4; this card rebuilt both halves from `lineageRootId` (stable across a manager/candidate recycle, byte-identical to the raw id for a never-recycled session) for the same reason as the merge key above — a mid-batch manager or candidate recycle must not fracture the dedupe key into two. `SessionService.mergeBatchTracked`'s own doc has the full rationale for why the key is the RESOLVED candidate set (not the raw request), why `baseMainSha` is deliberately excluded from it, and why lineage-rooting specifically (not just recycledFrom) was needed on top.

## Do not

- Do not key a pending merge/merge-batch op on a raw session id that a recycle could later replace — key on the lineage root (or walk the `recycledFrom` chain) on BOTH the read and write sides, or a recycle mid-flight silently forks the dedupe into two op identities for one underlying worktree.

## Source

Inline comment in `packages/daemon/src/orchestration/pending-ops.ts` (`PendingOpRegistry`'s class doc, key-scheme paragraph): lines 210-223, as of commit `507e966583ff18068f5e7e56942acfe67001ee94`. Relocated by card `a1491009` (tranche 1); no wording changed beyond joining wrapped source lines into a flowing paragraph and stripping `*` comment markers.

## `peekPendingMerge` walks the lineage to find it, and attributes a hit to the true predecessor

Card `3a2dac9c`, out of `eeb26621`'s investigation ("THE HOLE"): a merge op is minted under whichever
worker session id was live when `confirmWorkerMergeTracked` called `attach()`. `worker_recycle` mints a
fresh successor id and carries ZERO op state — the op keeps running under the PREDECESSOR's key forever
(nothing rewrites or aliases it). A bare `peek(merge:${workerSessionId})` against the SUCCESSOR's id
therefore went blind to a real, still-running merge for that exact worktree/branch the instant a recycle
landed mid-gate — a false negative on "is a merge in flight?" for `worker_list`/`worker_status`/
`/api/sessions` alike. `lineageResolvedPendingOp` walks `recycledFrom` backward to find it.

SEMANTIC CONSEQUENCE (flagged in the card, not patched around): this changes what a non-null result on a
successor's OWN id MEANS — it can now be a PREDECESSOR's op, not this session's own. `predecessorSessionId`
carries that attribution (set only when the op's true origin differs from `workerSessionId`), mirroring
the predecessor-attribution `settleNudgeAttribution` already gives the gate nudge — so a reader can tell
"my op" from "my predecessor's op" instead of the two being indistinguishable.

`peekPendingMerge`'s `worker` parameter accepts either a bare `workerSessionId` (re-fetches its
`recycledFrom`) or a `{ id, recycledFrom }` seed (card `1c51de69` DoD-3) — every current caller (the
`/api/sessions` REST route, the fleet-hub WS push, `worker_list`/`worker_status`) already holds the full
session row it was called with, so passing that row through saves the redundant `getSession` point-read
this function used to make on every single call.

### Do not (2)

- Do not treat a non-null `peekPendingMerge` result on a session's own id as necessarily that session's
  own op — it can be a predecessor's, surfaced via the lineage walk; check `predecessorSessionId`.
- Do not re-fetch the session row inside `peekPendingMerge` when the caller already holds it — pass the
  `{ id, recycledFrom }` seed through instead of a bare id.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `peekPendingMerge`: lines 6296-6319,
as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped source
lines joined into a flowing paragraph and the `*` comment markers stripped.
