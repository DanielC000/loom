# 3388be4d — The role-scoped transcript-root deny lives solely at the `PtyHost.createPty` spawn chokepoint

## Narrative

Every OTHER role keeps config's startupModeCycles verbatim — byte-identical to before this change. Card 3388be4d: the role-scoped transcript-root deny (formerly applied here, card ac90ca8e / 44fa586a) now lives at the single `PtyHost.createPty` spawn chokepoint (`withTranscriptRootDenyForSpawn`), keyed off `opts.role` — the session's PINNED role, threaded on every spawn path regardless of whether this method's own `agent`/`resolveAgentSpawn` re-resolution ever runs (it fixes the agent-row-missing resume/fork fallback that used to drop the deny). Nothing to do here any more.

## Do not

- Do not recompute the role-scoped transcript-root deny at this (or any other) call site — it now lives solely at the `PtyHost.createPty` spawn chokepoint, keyed off `opts.role`, so every spawn path (including an agent-missing resume/fork fallback) inherits it uniformly.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveAgentSpawn`), originally part of lines 3070-3107 as of commit `9818aa2627c6f58c26aaaec6fc33d70c468c3943`. Relocated by card `3c50eae9` (`docs/adr/92cfc09e` convention); no wording changed.
