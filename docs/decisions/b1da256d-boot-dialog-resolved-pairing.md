# b1da256d — boot-dialog-stuck RESOLVE pairing: fire site, durable pairing, and web ordering

## Fire site: the `anyHookObserved` false→true flip, not `case "SessionStart":`

`pty/host.ts`'s `deliverHook` fires `onClaudeBootDialogResolved` on the FIRST hook of any kind for a given
Live incarnation — captured as the `anyHookObserved` false→true flip, before the write that follows —
rather than inside the `case "SessionStart":` block. This runs exactly once per Live incarnation (every
spawn/resume/fork/recycle reseeds `anyHookObserved` false for a real claude Live; a shell/canned Live
seeds it true and never reaches this code), and it covers a non-SessionStart first hook under
`READY_FALLBACK` — the exact gap `e2a3c613`'s own record documents at its Round 4 cut: that card's rounds
2-3 fired the resolve ONLY inside `case "SessionStart":`, which never fires when SessionStart is missed
but some other hook (e.g. `PreToolUse`) still proves the engine is past boot. A SessionStart-only design
can never close that gap, because the signal it reads is exactly the one missing in the failure case this
card exists to catch. Proven directly: `claude-boot-dialog-stuck.mjs` scenario 19 is RED when the fire
site is reverted to the round-3 `case "SessionStart":` design (see that file's RED-BEFORE-GREEN note).

## Pairing: durable, kind-filtered, copies the paired stuck row's own ids

`SessionService.handleClaudeBootDialogResolved` derives the pairing decision from DURABLE event history
alone (`Db.listEventsForWorkerKinds`, kind-filtered to `claude_boot_dialog_stuck`/`claude_boot_dialog_resolved`
so a long-lived session's event history stays cheap to scan) — never from in-memory `Live` state, which a
resume/restart replaces with a fresh object holding no memory of a prior alarm. It fires a resolved event
only when the LATEST of the two kinds is an unpaired stuck row; otherwise it's a no-op.

Round 2 (Code Review 6bddda13): the appended resolved event copies `managerSessionId`/`taskId` from that
PAIRED STUCK ROW, never re-derives them from the session's current `parentSessionId`/`taskId`.
`db.reparentLiveWorkers`/`relinkWorkerToManager` can reparent a worker between its stuck and resolved
episodes (a manager recycle, a self-heal relink) — re-deriving at resolve time would file the resolved
half under the NEW manager while the stuck half (and whoever it actually nudged) stayed filed under the
OLD one, splitting one logical pair across two managers. Copying from `latest` also makes
`listEventsForWorkerKinds` the only query this method runs (round 1's `getSession` lookup is gone).
Proven by `claude-boot-dialog-stuck-no-self-nudge.mjs` (J2): stuck under M1 → relinked to M2 → resolved ⇒
the resolved row carries M1, never M2.

## Web ordering: the single-server-query precondition holds BY CONSTRUCTION

`packages/web/src/lib/fleet.ts`'s `activeBootStuckAlerts` sorts its input by `ts` alone, no extra
rowid/seq tiebreak, on the premise that a stuck/resolved pair for one session always arrives from the
SAME server query. **Round 3 (card `43084723`) changed WHICH query that is — see that card's own record
for the visibility gap this closed and the full before/after.** In short: round 2's per-session
`managerId`-keyed fan-out (`GET /api/orchestration/events?managerId=`, `Db.listEvents`) is GONE, replaced
by one cross-session, kind-filtered read (`kinds=claude_boot_dialog_stuck,claude_boot_dialog_resolved`,
`Db.listRecentEventsByKinds`). The precondition holds even more strongly now: there is only ONE query,
full stop, so there's no "did both land in the same query" question left to ask. No client-visible
ordinal was added to `OrchestrationEvent`'s wire shape — still unnecessary.

## Membership

- **Durable-audit**: YES — both kinds are in `db.ts`'s durable-audit event-kind list (`deleteAgent`'s
  cascade-exclusion set), so they survive agent deletion with a dangling session id. See
  `durable-audit-event-survives-agent-delete.mjs`.
- **Event-triggers**: NO — neither kind is in `EVENT_TRIGGER_EVENT_KINDS` (`packages/shared/src/types.ts`).
  A detector's own internal lifecycle pair, not a user-automation signal; the owner-facing path is
  `attention-push.ts`'s classification below.
- **`classify()`** (`companion/attention-push.ts`): `claude_boot_dialog_stuck` → `"escalation"` when
  `detail.parentNudged === false` (see `e2a3c613`'s record), else `null`. `claude_boot_dialog_resolved` →
  `null`, unconditionally — a resolve clears an already-filed alert, never itself a fresh owner-facing one.

## Do not

- Do not move the fire site back into `deliverHook`'s `case "SessionStart":` block — that is the round-3
  design `e2a3c613`'s Round 4 cut rejected, and it structurally cannot cover a non-SessionStart first hook
  (see scenario 19's RED-BEFORE-GREEN proof above).
- Do not re-derive `managerSessionId`/`taskId` in `handleClaudeBootDialogResolved` from the session's
  current `parentSessionId`/`taskId` — copy them from the paired stuck row (`latest`), or a reparent/relink
  between the two episodes splits one logical pair across two managers.
- Do not merge `bootStuckEvents` into `allEvents` in `lib/attention.ts` — this was round 2's own
  `e2a3c613` bug (Code Review e5290bc2 MAJOR): a parentless session's `idle_report`/`context_escalated`/
  `board_quiet_cause`/`merge_request` events wrongly fed `latestIdle`/`latestContext`/`latestQuiet`/
  `latestMerge`, and a live manager (in both sets) had its events double-counted. Keep
  `activeBootStuckAlerts` fed from its own, kind-filtered `bootStuckEvents`, never merged into `allEvents`.
- Do not re-add a per-manager/per-session fan-out (`bootStuckCandidates` + one `managerId`-keyed query per
  candidate) to fetch these two kinds — see `43084723`'s own record for why that shape loses a worker's
  unresolved event the moment its filing manager stops being live.
