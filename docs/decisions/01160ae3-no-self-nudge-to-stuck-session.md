# 01160ae3 — never nudge the stuck session itself from `handleClaudeBootDialogStuck`

## Narrative

The boot-dialog-stuck detector (`pty/host.ts`'s `dialogStuckTimer`) fires when an unattended-role
session has not reached `SessionStart` within `CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS`, on the theory that
the pty is likely sitting on a blocking CLI dialog (workspace-trust / MCP-server-enable / external-
`@import` / an unknown future one with the same shape) with nobody watching a live terminal to notice.

An earlier version of `handleClaudeBootDialogStuck` (`sessions/service.ts`) enqueued a nudge to the
*stuck session itself*, in addition to notifying its parent manager and recording the durable event. Code
Review round 2 (`2c44891b`) caught this as a blocking defect: the detector's whole premise is "detect and
notify only, never auto-answer anything" — but a self-nudge violates that premise in practice, not just in
spirit.

`enqueueSystemNudge` routes through `enqueueDurableMessage`, the same durable-queue path every other
agent/warning message takes — it is eventually *drained* and *typed into the pty*, terminated by an Enter
keypress. The gate that normally holds a message back until a session is genuinely ready to receive input
is `live.ready` — but `READY_FALLBACK_MS` (20s) unconditionally forces `live.ready = true` well before this
detector's own, much longer timeout ever fires, specifically to avoid wedging a session whose
`SessionStart` hook never arrives. `busy` is similarly not a reliable hold: give-up recovery and
heal-if-stuck both clear it independently of whether a dialog is actually showing. So by the time this
detector's timeout elapses, nothing in the drain pipeline is actually still holding the nudge back — it
will be typed straight into whatever is on screen, and the trailing Enter will confirm the dialog's
currently-highlighted option. For the three known dialog families (workspace trust, MCP-server-enable,
external imports) the highlighted/default option is not guaranteed to be the safe one.

This is the exact outcome the card's own DoD prohibits ("do not auto-answer anything that isn't on an
explicit allowlist with a reviewed safe choice") — the self-nudge effectively auto-answers an
unreviewed, often-unsafe default, dressed up as a notification.

## Do not

- Do not re-add an `enqueueSystemNudge`/`enqueueDurableMessage` call targeting the STUCK session from
  `handleClaudeBootDialogStuck` (or any future variant of this detector) — any text enqueued to a session
  in this state will be drained and typed into its pty, and the terminating Enter will confirm whatever
  dialog option happens to be highlighted.
- Do not treat `live.ready`/`busy` as a reliable hold against this — `READY_FALLBACK_MS` already forces
  `ready` true, and give-up recovery / heal-if-stuck already clear `busy`, well before this detector's own
  timeout can fire.
- Do not notify anyone other than the parent manager (plus the durable `claude_boot_dialog_stuck` event) —
  a parentless/manager-owned session's own coverage is out of scope here, tracked separately (card
  `e2a3c613`).

## Source

`packages/daemon/src/sessions/service.ts`, `handleClaudeBootDialogStuck` — fixed per Code Review round 2
(`2c44891b`) on card `01160ae3`.
