# 062fa934 — `deploySignatureMismatch` is checked before `supervisorChanged` in the live-claim ladder

## Narrative

Card 062fa934 ordered the two caveats `resumeFleetOnBoot`'s `liveClaim` construction can apply to the
"your merged code is now LIVE" nudge. `deploySignatureMismatch` is checked FIRST, ahead of
`intent.supervisorChanged`, because it is a strictly stronger doubt: a turbo cache-replay signature
(see `deploy-staleness.ts`'s module doc) means this process's OWN build identity can't be trusted at
all — a caveated "code is live EXCEPT the supervisor" claim would still be asserting the one thing now
in question (that the running process's build actually is the merged code). So a mismatch pre-empts
the weaker, more specific `supervisorChanged` caveat rather than being checked after it.

This gates the CLAIM text, not the restart itself — the restart already happened either way. WHO
reads this and WHEN: the requesting manager/platform Lead, in this exact post-`daemon_restart` nudge,
every time this process's own `resumeFleetOnBoot` runs (the only place this codebase asserts "your
merged code is live" to an agent). Per the card's DoD, this must NOT become a refusal — only the
ASSURANCE that follows the restart is withheld, never the restart itself.

## Do not

- Do not check `intent.supervisorChanged` before `deploySignatureMismatch` — a signature mismatch is
  the strictly stronger doubt and must win the ladder.
- Do not turn this into a refusal of the restart — the restart has already happened; only the "your
  code is live" assurance that follows it is ever withheld or caveated.

## Canonical call site (`served-status.ts`)

Code Review MINOR, same card: `served-status.ts`'s `currentDeployStaleness()` is the ONE production
read of `computeDeployStaleness()` that carries the captured `processBuiltSha`/`processBuiltDirty`
pair, so `buildServedStatus` (the `served_status` tool / `GET /api/deploy-status`) and
`SessionService.resumeFleetOnBoot`'s nudge above (this record's own topic) read the identical signal
rather than two independently-wired calls that could silently drift — e.g. one passing the pair, the
other forgetting to and always reading `deploySignatureMismatch: false`. Every other positional param
`currentDeployStaleness` passes stays at its real-production default (undefined).

`currentDeployStaleness` is NOT the only production caller of `computeDeployStaleness()`:
`manager-prompt.ts`'s `composeManagerStartupPrompt` (the `[loom:deploy-stale]` manager-spawn advisory)
calls `computeDeployStaleness()` directly, with no override, and so always reads
`deploySignatureMismatch: false`. That is deliberate, not an oversight:
that call site only ever reads the mtime-derived `stale`/`commitsBehind`/`runningCodeBuiltAt` fields —
it has no use for the signature-mismatch detector the captured pair exists to feed, so it was never
worth wiring through the same module-level state.

- Do not add a fourth independent `computeDeployStaleness()` call site that needs
  `deploySignatureMismatch` — if a THIRD caller ever needs it, route it through
  `currentDeployStaleness()` instead.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s `liveClaim`
construction: line 4766, as of this tranche's HEAD (tranche 13).

Canonical-call-site section: inline comment in `packages/daemon/src/served-status.ts`, above
`currentDeployStaleness`: lines 55-73, as of this tranche's HEAD.
