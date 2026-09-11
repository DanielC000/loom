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

## `readContextStats` resolves via `resolveTranscriptFile`, not the bare computed path — defense in depth

`readContextStats` resolves the transcript file via `resolveTranscriptFile` (computed path first, else a
scan of `~/.claude/projects/*` by the globally-unique engine session id) rather than the direct computed
path alone: the direct path is exposed to the SAME project-dir-encoding-drift class `resolveTranscriptFile`
already exists to guard `engineTranscriptExists` against, and a miss here used to fail SILENTLY (a caught
`readFileSync` ENOENT → `null`), permanently freezing the caller's persisted context counter with zero
signal — the same freeze this card's diagnostic-branch fix targets, from the read-resolution side rather
than the null-cause-logging side.

This is defense-in-depth only, not the fix for every freeze cause — the engine itself rotating to a new
transcript file mid-session (handled by `pty/host.ts`'s SessionStart handler) is the OTHER, confirmed more
common cause, and is a separate mechanism this resolution change does not address.

### Do not (2)

- Do not resolve `readContextStats`' transcript file via the bare computed path alone — route through
  `resolveTranscriptFile` so a project-dir-encoding-drift miss doesn't silently freeze the context counter.
- Do not treat this defense-in-depth resolution fix as covering the mid-session transcript-rotation freeze
  cause — that is a separate, more common cause handled by `pty/host.ts`'s SessionStart handler.

### Source (2)

JSDoc comment above `readContextStats` in `packages/daemon/src/sessions/context.ts`, lines 93-100 as of
this tranche's HEAD.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `Stop`/`StopFailure` case, the
context-stats null-read diagnostic branch), as of commit `c433346f9…` (this tranche's starting HEAD).
Extracted by card `6ba43dfa` (tranche 23 on `pty/host.ts`); no wording changed beyond compressing wrapped
source lines into a flowing paragraph and stripping `//` comment markers.
