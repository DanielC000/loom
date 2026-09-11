# e07b1b1a — recover a manager/platform's fleet when its recycle successor dies before SessionStart, never resurrect onto a dead predecessor

## Narrative

Follow-up to `f349f5cb` (LINEAGE LINK only): when a recycle successor (M2) spawns but dies before
SessionStart, `reconcileNeverStartedRecycleSuccessor` unlinks `recycled_from` so the predecessor (M1)
becomes `resume()`-eligible — but the FLEET (reparented onto M2 at recycle time) stayed stranded on dead
M2, and an unconditional `setTimeout(() => pty.stop(oldId,"hard"), 3000)` still killed M1 regardless.

Full Code Review round-1/round-2 narrative (MAJOR `resumability:"dead"` fix, MINOR m1/m2/m3, NITs) is on
the card body (`tasks_get e07b1b1a`); trimmed here to fit `PER_RECORD_MAX_BYTES`.

## Design

`SessionService.settleRecycleHandoff` replaces the bare `setTimeout` at both call sites with an async poll
loop: wait the 3s flush floor (lets `recycle_me`'s MCP response flush first), then poll, READY checked
FIRST every iteration:
- `pty.hasReachedReady(freshId)` → stop the predecessor as before, even after an unresolved alert already
  fired (then also records `recycle_fleet_resolved`).
- `!pty.isAlive(freshId)` → successor PROCESS confirmed dead regardless of SessionStart (never via
  `hasSuccessor`, which early-returns once `engineSessionId` is captured). Calls
  `recoverFleetAfterFailedRecycleSuccessor`.
- Neither within `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` → `recordUnresolvedRecycleOutcome` fires ONCE, loop
  CONTINUES slower — the bound gates the ALERT, never the observation.

`recoverFleetAfterFailedRecycleSuccessor(oldId, freshId, role)` checks `pty.isAlive(oldId)` FIRST:
- **M1 not alive**: records `recycle_fleet_unresolved{reason:"successor-died", oldStillLive:false}`, M2
  UNTOUCHED (no unlink/archive/lastError/resumability) — it's the only possible fleet owner.
- **M1 alive**: `unlinkAndArchiveDeadRecycleSuccessor` unlinks `recycled_from`, overwrites `lastError`,
  archives, AND `db.setResumability(freshId, "dead")` (same gate crash-recovery already checks for every
  unresumable row — else a later tick could resume dead M2 as a SECOND manager). Reverse-reparents
  workers/wakes/questions/cap-queue+drain (manager only)/pending (`carryPendingToSuccessor`); platform also
  restores `processState` to `"live"` via `Db.restoreLiveAfterConfirmedAlive`. Records
  `recycle_fleet_recovered` + a durable nudge to M1.

Three `OrchestrationEventKind`s, filed under the predecessor id: `recycle_fleet_recovered`,
`recycle_fleet_unresolved{reason, oldStillLive}`, `recycle_fleet_resolved` — all classify to attention-push's
`"worker-crashed"`, named explicitly by `alertLine()`. The unresolved nudge is HONEST — never claims a
human WAS alerted (false with no Companion grant/alertWebhook).

## Harness readiness

Claude: `hasReachedReady` is a genuine guarantee, within `READY_FALLBACK_ABSOLUTE_CEILING_MS` (45s default)
from spawn, for any successor that stays alive (`pty/host.ts`'s SessionStart handler re-arms a capped
fallback so elapsed-since-spawn never exceeds it). Codex: `CODEX_BOOT_READY_TIMEOUT_MS` (45s default) is
DIAGNOSTIC-ONLY (@decision 448f1b4a) — never sets `bootReady:true`; a stuck-but-alive codex successor can
sit `bootReady:false` forever (the codex gap below). `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` is
`Math.max(both) + 10s`.

## Do not

- Re-check M2's readiness at one fixed point — react to real signals; a time bound only for a genuine hang.
- Stop observing once the timeout is crossed, or treat it as proof of failure — it gates the ALERT only,
  and means "unknown", not "confirmed dead".
- Derive "failed" from `!hasSuccessor(oldId)` alone — test `pty.isAlive(freshId)`.
- Gate the archive+lastError-overwrite on "not already archived" — a Lead successor with no live workers is
  archived by `archiveOnExit` first, with no lastError of its own.
- Touch M2 (archive/lastError/resumability) when the predecessor is ALSO not alive — it's the only possible
  fleet owner; touching it overwrites its TRUE `[loom:orphaned-fleet]` banner (@decision 6cd3ce9e).
- Skip `setResumability(freshId, "dead")` when archiving a recovered-onto dead successor, or reparent back
  onto a predecessor without confirming `pty.isAlive(oldId)` first — either lets a dead identity come back.
- Call `db.setProcessState(id, "live")` directly for the restore — use `Db.restoreLiveAfterConfirmedAlive`.
- Claim "a human has been alerted" in the unresolved nudge — say what Loom actually did.
- Lower `RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS` below the `Math.max` bound above.
- Leave `recycle_fleet_resolved` unclassified — a human alerted "unresolved" must also hear it resolved.

## Accepted gaps (not fixed here)

- **Daemon restart mid-settle** (card `08c81809`): the loop is purely in-memory, lost on restart. M1 stays
  live (never stopped) but `resume()` is refused by the superseded-session guard (not yet unlinked); M2's
  post-restart outcome isn't certain. Re-scoped as its own card.
- **Wider unguarded window after `recycle_me`**: M1 hard-stopped exactly 3s after `recycle_me`; now it stays
  live+unguarded for however long settle takes — narrow, not a new failure class.
- **No terminal state for a codex successor alive but never `bootReady`**: loop polls forever, slowly —
  bounded cost; codex's own diagnostic timeout still fires independently.

## Source

`sessions/service.ts` (`settleRecycleHandoff`, `unlinkAndArchiveDeadRecycleSuccessor`,
`recoverFleetAfterFailedRecycleSuccessor`, `recordUnresolvedRecycleOutcome`), `db.ts`
(`restoreLiveAfterConfirmedAlive`), `shared/src/types.ts`, `companion/attention-push.ts`, `pty/host.ts`.
Tests: `recycle-manager-fleet-recovery{,-late-signals}.mjs`, `companion-attention-push.mjs` §23. Full
narrative + line citations: card `e07b1b1a`'s own body.
