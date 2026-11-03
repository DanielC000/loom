# 668bc52c — exhaustion/rotation transcript fixtures sandbox HOME/USERPROFILE, never the real homedir

## Narrative

`pty/claude-transcript.ts`'s `engineTranscriptPath` always resolves under the real `os.homedir()`
(never under a test's own `LOOM_HOME`), and `CLAUDE_PROJECTS_ROOT` (the fallback-scan root
`resolveTranscriptFile` falls through to when the direct path misses) is captured at MODULE LOAD time,
not read fresh per call. Three test files wrote real transcript fixtures through this path with no
isolation at all: `context-watcher-context-exhausted.mjs`, `busy-worker-watcher-context-exhausted.mjs`,
and `engine-session-rotation.mjs` (the last already had unique-per-run ids, via card `7d70b27b`, to
avoid a cross-run collision — but still wrote into the real `~/.claude/projects`, only cleaned
best-effort).

The fix reuses the convention already proven for four earlier siblings (`companion-memory-recall.mjs`,
`resume-already-live-guard.mjs`, `periodic-snapshot.mjs`, `shutdown-snapshot.mjs`, card `f432cbb8`/
`9878e520`, regression-guarded by `real-homedir-transcript-leak-isolation.mjs`): sandbox
`process.env.HOME`/`process.env.USERPROFILE` to a managed temp dir, set BEFORE the first import of
anything under `../dist` (a dynamic `await import()`, not a static top-of-file import — a static import
would run before the sandbox assignment and freeze `CLAUDE_PROJECTS_ROOT` at the real home regardless of
what the sandbox later does). No new env var or DI seam was introduced — deliberately rejected in favor
of this existing, lower-risk mechanism (see the card's own worker_report for why).

`real-homedir-transcript-leak-isolation.mjs`'s `TARGETS` array now also covers these three files, and a
new static guard (`transcript-realhome-sandbox-guard.mjs`, in `STATIC_GUARD_REPO_PATHS`) fails any NEW or
changed test file that calls a transcript-path function without this same sandbox preceding its first
dist import.

**Named residual:** the guard also treats a file as safe when it uses `withEngineTranscriptFixture`
(`_transcript-fixture.mjs`, card `99aedfa0`) — that helper still writes its fixture under the REAL
`os.homedir()`, it just guarantees teardown (a try/finally that throws if its own real-homedir dir
survives) instead of this card's own avoid-it-entirely sandbox. That is a deliberate, pre-existing,
different mitigation for the same class of hazard, not a second instance of the leak this card fixes —
this card did not change or audit that helper's own call sites.

## Do not

- Do not write a transcript fixture via `engineTranscriptPath`/`resolveTranscriptFile`/
  `engineTranscriptExists`/`listAllTranscriptIds` in any `packages/daemon/test/*.mjs` file without first
  sandboxing `process.env.HOME` AND `process.env.USERPROFILE` to an owned temp dir (`mkdtempManaged`),
  before the first import of anything under `../dist` — a static top-of-file import runs too early and
  freezes `CLAUDE_PROJECTS_ROOT` at the real home.
- Do not introduce a new env var or dependency-injection seam for this — the existing HOME/USERPROFILE
  sandbox is the established, lower-risk convention; adding a second mechanism would fork the pattern
  for no benefit.
- `context-watcher-worker-ratios.mjs` (card `dacc6d9e`'s scenario 19) will need this same sandbox the
  moment that file lands — it was not yet merged when this record was written, so it could not be fixed
  here; apply the identical pattern to it rather than re-deriving a new one.
- Do not widen `transcript-realhome-sandbox-guard.mjs` to a text/regex scan — a regex can't distinguish
  a real `process.env.HOME =` assignment from the same text sitting in a comment, a string, or an `==`
  comparison, and would both false-positive and false-negative on this corpus; it must stay an AST scan.

## Source

`packages/daemon/test/context-watcher-context-exhausted.mjs`, `busy-worker-watcher-context-exhausted.mjs`,
`engine-session-rotation.mjs` (the sandbox block near each file's top). `real-homedir-transcript-leak-isolation.mjs`
(regression coverage). `transcript-realhome-sandbox-guard.mjs` (the static corpus-wide guard).
