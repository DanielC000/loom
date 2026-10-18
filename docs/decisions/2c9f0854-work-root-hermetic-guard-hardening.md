# 2c9f0854 — hardening the `LOOM_PROJECT_WORK_ROOT` hermetic guard and `refreshProjectsWorkRootUsage`'s cache isolation

Round-3 Code Review follow-ups on card `5eace211` (the Loom-managed per-project work dir).

## Decision 1 — the hermetic guard requires the override to MATCH, not merely be UNDER tmp

`_guard.mjs`'s `requireHermeticEnv()` used to accept any `LOOM_PROJECT_WORK_ROOT` that merely resolved
under the OS temp dir (`assertUnderOsTmpdir`). That is not enough: a throwaway isolated daemon (CLAUDE.md's
own isolated-daemon-for-UI-review recipe) has its own genuine `LOOM_HOME` and its own derived
`-projects` sibling, ALSO under the OS temp dir — a pin-less test inheriting that ambient value would pass
the old check and go on to walk/mutate that OTHER daemon's real throwaway root instead of its own.

The fix: `requireHermeticEnv` now computes what `PROJECTS_WORK_ROOT` would derive to from THIS test's own
`LOOM_HOME` (mirroring `paths.ts`'s own `path.dirname`/`path.basename` formula exactly) and only accepts an
ambient `LOOM_PROJECT_WORK_ROOT` that equals that derived default, or a value the test explicitly
registered via the new `pinProjectWorkRootOverrideForTest(value)` (which itself still requires the pinned
value to pass `assertUnderOsTmpdir`). Anything else is refused, even if it is itself a legitimate
temp-dir-rooted path belonging to something else.

## Decision 2 — `refreshProjectsWorkRootUsage`'s override calls are fully isolated from shared state

The optional `bounds`/`warnBytes` override parameters (card `5eace211` Code Review MINOR 5) used to (a)
be ignored by the in-flight dedupe — a concurrent override caller could silently receive a DIFFERENT
caller's default-bounds in-flight result instead of running its own — and (b) have their result written
to the shared `cached` module state unconditionally, so a test's override call could poison what
`served_status`/`getCachedProjectsWorkRootUsage()` report for every other reader.

The fix: an override call (either parameter explicitly passed) never touches `refreshInFlight` and never
writes to `cached` — it always computes and returns its own isolated result. Only a call using the exact
default bounds (i.e. the production `kickProjectsWorkRootUsageRefresh` path, which never passes either
param) participates in the shared dedupe/cache, byte-identical to before for that path.

## Do not

- Do not widen the hermetic guard's `LOOM_PROJECT_WORK_ROOT` acceptance back to a bare
  tmp-dir-containment check — see Decision 1; it must match this test's own derived default or a value
  pinned via `pinProjectWorkRootOverrideForTest`.
- Do not let an override call to `refreshProjectsWorkRootUsage` join the shared `refreshInFlight` dedupe
  or write to the module-level `cached` — see Decision 2; only the exact-default-bounds call may touch
  either.
- Do not test `buildServedStatus`'s propagation of `projectsWorkRootTruncated`/`projectsWorkRootOverCeiling`
  by relying on an override call's result landing in the shared cache (that was the Decision 2 bug) — use
  the `__setProjectsWorkRootUsageCacheForTest` test seam to inject a value directly instead.
