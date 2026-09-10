# 8f36be30 — the `stranded` fallthrough notice reports observed fields, never asserts a stall cause

## Narrative

Card `8f36be30`: the fallthrough `stranded` branch of `notifyManagerOfIdleWorker`'s message-building
`switch` is the ONLY one of its kinds that both (a) recommends `worker_merge` unconditionally and (b)
asserts "finished a turn" with no observable field the reader can check it against — every other kind
already carries its own discriminating detail (`minutesSinceStart`, `wakeAt`, `status`,
`minutesSinceReport`). `w.turnSeq`/`w.lastActivity` are the same point-in-time-read fields
`buildBrokenSpawnMsg` already reports for the sibling broken-spawn notice — reused here rather than
inventing a second idiom.

The fix is to report OBSERVED fields only and not assert a cause from them: whether a given elapsed time
since last activity is routine for a particular worker's turns is a judgment only the reader (the
manager, who knows this worker's normal pace) can make — the notice states `turnSeq` and minutes since
`lastActivity` and lets the reader decide, rather than asserting "stalled" or "done" outright.

## Do not

- Do not assert a stall cause (e.g. "this worker is stuck") from `turnSeq`/`lastActivity` alone — report
  the observed fields and let the reader judge against that worker's normal turn pace.
- Do not invent a second reporting idiom for elapsed-time detail — reuse `buildBrokenSpawnMsg`'s own
  `turnSeq`/`lastActivity` fields for the `stranded` fallthrough notice, the same fields its sibling
  broken-spawn notice already reports.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`notifyManagerOfIdleWorker`'s message-building
`switch`, the "Card 8f36be30" comment immediately above the `stranded` fallthrough case): lines 9806-9812,
as of main `c51b7bc2` (introducing commit `4c74db3e8a50237a17b6bb26cca3751ab9567597`, `fix(sessions):
report turnSeq/elapsed and a merge caution in worker nudges`). Extraction tranche 35.
