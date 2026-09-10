# 772d15bd — an explicit `followUpOn` reopening a terminal-column task never auto-moves it, but says so in the body and the event

## Narrative

**DoD-3:** when `platformEscalate`'s explicit `followUpOn` path reuses a task sitting in the terminal
(resolved) column, the fix DELIBERATELY never moves that task out of the terminal column — even though
`targetWasTerminal` is true. Auto-reopening a card the Lead deliberately closed is its own surprising
behaviour change: the Lead may have closed it because the underlying issue genuinely resolved, and a
manager's follow-up evidence doesn't know that. Leaving the column alone, while making the
reopened-ness visible IN the card body (a distinct heading, via `appendEscalationDetail`'s
`terminalReopen` flag), lets the Lead decide whether to move it, rather than Loom silently deciding for
them.

**DoD-2** (`appendEscalationDetail`'s `terminalReopen` parameter): set ONLY when this append is an
explicit `followUpOn` reopening a target that was sitting in the terminal column. Without it, the
appended section is byte-identical to an ordinary append onto a still-open card — so a human reading the
card (or the Lead, on the no-live-Lead `deliveryStatus:"boarded"` path where nothing else ever tells
them) has no way to tell "routine follow-up" from "someone reopened a thread I'd already closed" from
the body alone. A distinct heading is the cheapest artifact that survives that path: it costs nothing
extra to write and needs no live recipient to be seen.

**DoD-1:** the `followedUp`/`targetWasTerminal` flags are stamped into the filed `orchestration_event`'s
`detail` even though the caller already gets these two fields back in the return value — that return
dies at the calling manager the moment it doesn't act on it (the whole failure this card exists to
close). Recording them HERE too means a forensic read of this task's escalation history
(`listEscalationsForProject`/`listEscalationsForPlatform`) can always tell "was this event a reopen of a
closed thread" without depending on anyone having paid attention when the call returned. Free to write;
costs nothing to omit when false.

## Do not

- Do not auto-move a reopened terminal-column task out of that column on an explicit `followUpOn` — the
  Lead may have closed it because the issue genuinely resolved; let them decide.
- Do not omit `terminalReopen`'s distinct heading on a reopen-of-terminal append — without it a reopen is
  indistinguishable from a routine follow-up in the body alone.
- Do not rely on the return value alone to record `followedUp`/`targetWasTerminal` — also stamp them on
  the filed event, so a later forensic read doesn't depend on the caller having acted on the return.

## Source

Inline comments in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s reuse branch
[DoD-3], its filed-event `detail` [DoD-1], and `appendEscalationDetail`'s own JSDoc `terminalReopen`
doc [DoD-2], as of this tranche's HEAD).
