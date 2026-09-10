# 21a77e85 — `readContextStats` is a whole-file read, deliberately NOT tail-bounded

## Narrative

Card `21a77e85`: `readContextStats`'s single-pass transcript read, called from the `Stop`/`StopFailure`
Stop-hook chokepoint in `pty/host.ts`, is `O(file size)` rather than a bounded tail-scan. A tail-bounded
read isn't implementable here: `readContextStats`'s own doc has the evidence — the `turns` count needs a
whole-session total (a tail read cannot see turns that happened earlier in the file), and
`lastUserTurnText` can sit arbitrarily far from EOF behind a long tool-only stretch (a run of tool calls
with no further user turn pushes the last real user text back from the end of the file by an unbounded
amount).

The cost is real but bounded well inside the budget it competes against: ~44 ms measured at 8.4 MB on the
host this was measured on — roughly two orders of magnitude below the ~40s give-up/park budget this
chokepoint also runs under (see `readContextStats`'s own doc, `packages/daemon/src/sessions/context.ts`,
for the full measurement set across 7 real transcripts and the budget comparison). This read runs for
EVERY session at every
`Stop`/`StopFailure`, regardless of role — the daemon doesn't know at this chokepoint whether a session is
a worker or a manager, and a manager's own context occupancy matters just as much ("who recycles the
manager").

## Do not

- Do not replace this with a tail-bounded scan to save the `O(file size)` cost — `turns` and
  `lastUserTurnText` are both provably unrecoverable from a tail-only read; see `readContextStats`'s own
  doc (`packages/daemon/src/sessions/context.ts`) for the full argument.
- Do not skip this read for a session because its role is known to be low-priority — the chokepoint
  doesn't discriminate by role on purpose, since a manager's own context occupancy is just as load-bearing
  as a worker's.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `Stop`/`StopFailure` case, the
context-occupancy refresh immediately before `readContextStats` is called), as of commit `c433346f9…`
(this tranche's starting HEAD). Extracted by card `6ba43dfa` (tranche 23 on `pty/host.ts`); no wording
changed beyond compressing wrapped source lines into a flowing paragraph and stripping `//` comment
markers. This card is also cited (without its own record, as of this extraction) at the `readContextStats`
definition site in `packages/daemon/src/sessions/context.ts`, in `packages/daemon/src/pty/adapter.ts`
(the `PtyHostAdapter` contract doc, three sites), and in `packages/daemon/src/sessions/service.ts` — this
record covers only the `pty/host.ts` call-site narrative (the bound proof + the every-session rationale);
it does not attempt to cover the others.
