# 6cd3ce9e — archiveOnExit skips archiving a manager/platform that still owns live workers

## Context

`index.ts`'s `onExit` archives every exited non-`run` session by default (any "stopped" session
leaves the live rail for Archive). That default is wrong for a manager/platform that still owns
≥1 LIVE worker/child session at the instant it exits — for ANY exit cause (a deliberate human
Stop, an interrupt, an unexpected death): archiving would silently strand the fleet, since
Archive drops the row off every rail/god's-eye list (`listSessions`/`listWorkers` exclude
archived rows) while its children stay live+busy with no live parent to review/merge/stop them —
invisible until a human happens to notice.

Filed from a real incident (card `6cd3ce9e` itself, a Platform Auditor finding): a
`[Request interrupted by user]` on a manager session drove it to exit AND be archived while the
three workers it owned stayed live and busy — leaving them parentless, with no session able to
review or merge their branches, and no fresh crash to explain it.

`archiveOnExit` is the after-the-fact twin of `endMe`'s "live-workers" gate
(docs/decisions/3b015fc7-end-me-is-self-scoped-with-two-refusal-gates.md): that gate REFUSES a
VOLUNTARY self-stop up front, while the pty is still alive, so the stop itself can be blocked.
Here the pty is ALREADY DEAD by the time `onExit` runs — there is nothing left to refuse, so the
only lever left is what happens to the ROW.

## Decision

`archiveOnExit` skips the archive for a manager/platform session with ≥1 live worker: it leaves
the row exited-but-unarchived (still on the live rail, still resumable via the normal resume
flow, which un-archives regardless), and files a distinct durable `manager_exited_with_live_workers`
event naming the stranded count — an audit-trail record mirroring the existing strand-family
events `worker_report_undelivered`/`worker_exited_without_report`, retrievable via
`listEventsForSession`/a Lead's audit sweep.

`useAttention` (web) only polls orchestration events for LIVE managers, so a dead manager's event
alone would never reach Mission Control. The same call also stamps a `[loom:orphaned-fleet]`
`lastError` banner on the row — this is what actually surfaces it: `web/src/lib/attention.ts`'s
`isOrphanedFleet` reads this role-agnostic session-row signal exactly like the existing
`isCrashLooped`/`[loom:crash-loop]` pair, turning it into a red "ORPHANED FLEET" attention item +
shell bell regardless of role/liveness.

Deliberately does NOT change auto-resume policy: an INTENDED stop is still never auto-resumed by
the crash-recovery watchdog (`recordUnexpectedExit`'s `intended` gate is untouched) — this only
keeps the row (and its orphaned children) VISIBLE so a human (or a resumed successor) can act.

## Do not

- Do not read the skipped archive as a refusal — the exit itself is never blocked; only the
  row's post-exit archive step changes.
- Do not assume this changes auto-resume behavior for an intended stop — it doesn't; it only
  changes visibility of the exited row.
- Do not rely on the durable event alone to surface this to a human — without the
  `[loom:orphaned-fleet]` `lastError` banner, a dead manager's own event is invisible to
  `useAttention`'s live-manager-only poll.

## Consequences

- A manager/platform with NO live children — the overwhelming common case — archives exactly as
  before; every non-manager/platform role (worker/run/assistant/etc.) is byte-identical to the
  old unconditional call.
- A manager/platform that exits with live workers now stays visible on the live rail (with a red
  "ORPHANED FLEET" attention item) instead of silently disappearing into Archive with its
  children left parentless.
- Resuming the exited row re-adopts its orphaned children; a sibling manager can otherwise merge
  an orphan's branch but cannot stop its session (parent-scoped), so resuming or reparenting is
  the intended recovery path.

## Source

JSDoc comment on `SessionService.archiveOnExit` (`packages/daemon/src/sessions/service.ts`), as of
this worktree's HEAD before this extraction (tranche 39). Wrapped source lines joined into flowing
paragraphs, `*` comment markers stripped, no wording changed beyond that.
