# dbc6bcac — latch a confirmed-missing transcript so a broken session doesn't re-pay the fallback scan

## Narrative

Card `dbc6bcac`: `engineTranscriptExists`'s FALLBACK path (only reached once its own cheap direct
`existsSync` check misses) is a synchronous `O(projects)` `readdirSync` of `~/.claude/projects` — fine as
a one-off diagnostic, but the branch that calls it (the `7c1fc117` null-read diagnosis, `pty/host.ts`'s
`Stop`/`StopFailure` case) is anomalous-path-only, so a persistently-broken session (one whose transcript
never comes back) would otherwise re-pay that scan on EVERY subsequent `Stop`.

The fix: check the cheap direct path first. If it hits, there is nothing to throttle — this is the common,
inexpensive "found-but-no-usage" case, and it also means a session already latched as missing has
RECOVERED, so the latch is cleared for a fresh diagnosis next time. Only when the direct check misses does
the code consult the latch: skip the expensive fallback scan (and its log line) entirely once it's already
confirmed this session's transcript is genuinely missing, since a repeat scan would find the same nothing.

## Do not

- Do not call the `O(projects)` `readdirSync` fallback unconditionally on every anomalous null read — a
  persistently-broken session would re-pay that scan on every subsequent `Stop` with no new information
  gained.
- Do not leave a "confirmed missing" latch set once the direct `existsSync` check hits again — that would
  wrongly suppress a fresh diagnosis for a session that has since recovered.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `Stop`/`StopFailure` case, the
`engineTranscriptExists` fallback-throttle branch), as of commit `c433346f9…` (this tranche's starting
HEAD). Extracted by card `6ba43dfa` (tranche 23 on `pty/host.ts`); no wording changed beyond compressing
wrapped source lines into a flowing paragraph and stripping `//` comment markers.
