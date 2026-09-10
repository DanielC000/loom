# 5907b71e — classify a restart wake's cause/impact (part 1) and de-dup a later completion escalation by SHA (part 2)

## Narrative

Card 5907b71e has two parts, both aimed at the same problem: a self-hosting session took ~10 restart
wakes for routine deploys/version-syncs another session triggered, and each currently burned a FULL
re-check turn confirming "nothing for me."

**Part 1 — wake impact classification** (`RestartWakeImpact`, `orchestration/restart.ts`): for one
resumed session, answers the questions a boot-resume wake should actually ask — did THIS session cause
the restart (`causal`), how many of its own workers were resumed (`liveWorkersResumed`), how many queued
inbound messages were replayed onto it (`queuedIoReplayed`), does it have a genuinely new answered
question (`hasUnconsumedAnswer`), and does it have board work nothing else will ever re-surface
(`strandedBoardWork`, later narrowed by card `61cc91c6`). `isNoOpManagerWake` (pure, exported for the
hermetic test) is the predicate a genuinely unaffected bystander must satisfy — non-causal AND zero on
every other stake — for `resumeFleetOnBoot` to resume it silently (card `b5664b5b`).

**Part 2 — completion-escalation SHA dedup**: `extractCommitShas` (`orchestration/restart.ts`) pulls
candidate 7-40 hex git SHAs out of free text (lower-cased, de-duped, permissive by design — false
positives are mild since the dedup only fires on an exact token match in both places, and the durable
board task is always still filed regardless). `resumeFleetOnBoot` uses it against `intent.reason` to
find the SHA(s) a restart's wake names, and `SessionService`'s in-memory `deployShaWindow` map
(sessionId → `{shas, atMs}`, pruned by `SHA_DEDUP_TTL_MS`) records which SHAs were actually DELIVERED to
which session (`recordDeployShasDelivered`, gated by card `066d317c` to only fire when the reason text
was actually shown). A later `platform_escalate` "X COMPLETE + DEPLOYED" report naming the SAME SHA is
then recognized as a duplicate of a turn the session already saw, and its live nudge is suppressed (the
durable board task is still filed either way). In-memory by design: the deliver (resume on boot) and the
read (escalation) both happen in the SAME post-restart daemon process, and a missed dedup is harmless
(one extra turn, not a correctness bug).

## Do not

- Do not force the full re-orient nudge onto a session that is non-causal and zero on every
  `RestartWakeImpact` stake — use `isNoOpManagerWake` and resume it silently.
- Do not record a delivered SHA against a session unless its actual enqueued text named the reason — see
  `066d317c`.
- Do not persist the SHA-dedup window to disk or share it across daemon processes — it is deliberately
  in-memory and process-local; a missed dedup after a daemon restart is an accepted, harmless cost, not a
  bug to "fix" with persistence.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`: lines 4383-4385
and 4408-4417, as of this tranche's HEAD (tranche 11). Cross-referenced (read-only) against `service.ts`
lines 1971-1979, and `orchestration/restart.ts` lines 237-293, which define/implement both parts.
