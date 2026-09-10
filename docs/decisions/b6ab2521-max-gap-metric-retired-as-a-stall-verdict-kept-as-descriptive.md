# b6ab2521 — the suite-wide max-gap metric is retired as a stall verdict, kept as a descriptive diagnostic

## Narrative

`f1043732` was deferred pending either (a) a suite-level sampler that can observe an open gap, (b) a
decision to retire the suite-wide gap metric as the wrong instrument, or (c) — a Codescape peer
input — keep the metric but make the detector declare its own incompetence. The lead decision:
**(b) on the verdict, (c) on the mechanism — not (a).**

**Two independent arguments, neither of which (a) can answer:**

1. A genuinely hung long-running unit and a healthy long-running unit produce the *identical*
   reading, because the metric measures gaps between completion events and a hang-in-progress emits
   none. The metric cannot discriminate the failure case from the healthy case at all, so no
   threshold derived from it can ever license "silence beyond this IS a hang."
2. The blindness is intrinsic to gap-metrics, so finer granularity cannot close it. The Codescape
   peer's own instrument already is the (a)-shaped one — updating `lastEventAt` on every
   per-test event, not just per-file — and they report it is still blind inside a single test: one
   legitimately-111-second test emits nothing while it runs. Any "gap between events" metric is
   blind for exactly the duration of whatever unit does not emit; finer granularity buys a smaller
   blind window, never zero. A finer-grained sampler would have bought a smaller blind window and
   left the verdict just as unsupportable — do not scope (a) believing it closes the hole.

**Scope of the retirement — do not widen it:** retired as a stall detector and as a margin/threshold
figure only. Not a claim the number is worthless — it stays as a descriptive run-shape diagnostic.
Not a licence to delete the sampling code. Not applicable to per-file instruments, which remain the
real stall detectors (the proven pattern is a `finally`-wrapped measured-completion line that fires
on pass and on throw alike). `f1043732`'s separate whole-tree-RSS finding is untouched by this and
stayed open on that card.

**The fix, in the instrument itself, not a doc:** every surface that renders the suite-wide max-gap
number bakes an explicit `UNDETERMINED` verdict into the line — "this number bounds gaps OBSERVED
UNDER HEALTHY CONDITIONS; a hung long unit and a healthy long unit read identically, so this is NOT
a stall verdict." "Prefer UNDETERMINED to a wrong reason," implemented in the instrument rather than
left to a caveat a reader can skip. Do not "judge the 60s threshold" by picking a bigger number —
there is no correct threshold to derive from an instrument that cannot discriminate, and
`GATE_EXTEND_IDLE_MS` stays unwidened (a standing rule, unchanged by this decision).

## Do not

- Do not treat the suite-wide max-gap number as a stall verdict or a safety margin, at any
  threshold — it cannot discriminate a hang from healthy long-running work.
- Do not "fix" this by sampling at finer granularity (a per-test rather than per-file gap metric) —
  the blindness is intrinsic to any gap-between-events metric, not a resolution artifact.
- Do not widen `GATE_EXTEND_IDLE_MS` to compensate — unrelated, standing rule.
- Do not delete the sampling code or stop printing the number — it remains a legitimate descriptive
  run-shape diagnostic, just never a verdict.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`, at `maxGapMs`, `formatMaxGapLine`, and
the `runInstrumentedSuite` crash-path note (originally ~lines 736, 761, 788; a fourth citation
remains inline elsewhere in the file). Card `b6ab2521`, decided by the Loom lead 2026-08-26 on
`f1043732`'s own deferred terms, merged as commit `3bd1efd`.
