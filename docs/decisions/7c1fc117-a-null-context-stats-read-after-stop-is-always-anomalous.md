# 7c1fc117 — a null context-stats read at Stop is ALWAYS anomalous; distinguish the two null causes

## Narrative

Card `7c1fc117`: `deliverHook`'s `Stop`/`StopFailure` case reads context stats every turn. Because a
`Stop`/`StopFailure` hook only ever fires for a turn that actually ran (see `sha:c433346f`), a null read
here is never a normal "nothing to measure yet" case — it is ALWAYS anomalous. Before this card, a null
read was swallowed with zero signal, which permanently froze the persisted context counter (the
recycle-nudge watcher's only input) with no trace left behind to diagnose it from.

The fix distinguishes the two possible causes of a null read so a future freeze is diagnosable at a
glance instead of re-investigated from scratch: the transcript file itself is missing/unresolvable (a
cheap re-check via `engineTranscriptExists`, which shares `readContextStats`' own `resolveTranscriptFile`
resolution) versus the file exists but no assistant line in it carries a `usage` field.

## Do not

- Do not swallow a null context-stats read at this chokepoint without logging which of the two causes it
  was — doing so silently and permanently freezes the persisted context counter with no trace.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `Stop`/`StopFailure` case, the
context-stats null-read diagnostic branch), as of commit `c433346f9…` (this tranche's starting HEAD).
Extracted by card `6ba43dfa` (tranche 23 on `pty/host.ts`); no wording changed beyond compressing wrapped
source lines into a flowing paragraph and stripping `//` comment markers.
