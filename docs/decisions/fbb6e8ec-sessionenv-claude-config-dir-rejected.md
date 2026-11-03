# fbb6e8ec — reject a `sessionEnv` key named CLAUDE_CONFIG_DIR, rather than threading a per-session root through every transcript reader

## Background

Card `a92a0913` made `claudeConfigHome()` (`pty/claude-config.ts`) and the transcript-root readers/deny
rules (`pty/claude-transcript.ts`) honour `CLAUDE_CONFIG_DIR` — but only the DAEMON's own ambient
`process.env.CLAUDE_CONFIG_DIR`, read fresh per call. That card's own "Correction" paragraph flagged a gap
it deliberately did not close: a human-set PROJECT `sessionEnv` entry for `CLAUDE_CONFIG_DIR` overrides
that var for one session's own spawn (`buildSpawnEnv`, `pty/host.ts`, merges `sessionEnv` into the CHILD
process env, AFTER the `processEnv` copy) — so the REAL spawned engine can write its transcripts under a
different root than the one every reader/deny-rule resolves. That reader/deny-rule split is fail-open on
a trust boundary (card `ac90ca8e`/`31613c1e`/`d78f8217`): a companion/auditor/worker whose native Read/Glob
is denied the transcript root could read the RELOCATED root instead, since the deny rule never followed it
there.

## Two options considered

- (a) Resolve the transcript root from the session's own spawn env, threading it through the deny-rule
  builders (`transcriptRootReadDenyRules`/`otherProjectTranscriptDenyRules`) AND every transcript reader
  (`resolveTranscriptFile`/`engineTranscriptPath`/`engineTranscriptExists`/`listAllTranscriptIds`).
- (b) Reject/scrub `CLAUDE_CONFIG_DIR` as a `sessionEnv` key outright — the simpler, fail-closed option.

## Decision: (b), kept narrow — owner-approved 2026-11-03

(a)'s blast radius is large and lands on correctness-critical hot paths with no existing per-session
override parameter: the four transcript-reader functions above are called from ~13 real sites across
`sessions/service.ts`, `sessions/context.ts` (context-exhaustion detection — `@decision f432cbb8` requires
this stay SYNCHRONOUS, inside the M2 busy-gate drain window), `sessions/liveness.ts`, `sessions/scratch-gc.ts`,
`sessions/scratch-largest-dirs.ts`, `sessions/recycle-settle-reconcile.ts`, `sessions/transcript.ts`,
`orchestration/context-exhaustion.ts`, `orchestration/crash-orphaned-workers.ts`, `gateway/server.ts`,
`pty/host.ts`, `pty/claude-adapter.ts`, `pty/codex-adapter.ts`. None of them currently carry a per-session
env/override parameter — threading one through means either a DB lookup or passing the full session row
at every call site, on paths that are either hot or safety-critical (liveness sweep, GC, crash-orphan
recovery). High risk for what is meant to be the SAFE fix.

(b) is one shared validator call plus one scrub: `validateProjectConfigOverride` (`mcp/platform.ts`) is
the SAME function the human REST **PATCH** (`gateway/server.ts`) and the elevated Platform Lead's
`project_configure` (`mcp/platform.ts`, `@decision 3ad2b286`'s route) both call — one check closes both of
those PATCH-shaped entry points. It does NOT cover the two REST **create** routes, `POST /api/projects`
(`gateway/server.ts` ~:5165, storing `config: b.config ?? {}` at ~:5255) and `POST /api/setup/project-init`
(~:4314, storing the same shape at ~:4374) — both store a raw, unvalidated `config` straight from the
request body, `sessionEnv` included, with no call to `validateProjectConfigOverride` at all. The spawn-time
scrub in `buildSpawnEnv` (`pty/host.ts`) is the REAL backstop that closes the gap those two routes leave
open; the validator alone does not. Fixing the two create routes is deliberately out of scope here — filed
as its own, separate card. No legitimate use of a per-project `CLAUDE_CONFIG_DIR` override was found: `sessionEnv` is a
generic raw env passthrough (no UI, docs, or feature treats this name as a supported per-project knob —
grepped `packages/web`, `docs/`, and the test corpus for zero hits of `sessionEnv`+`CLAUDE_CONFIG_DIR`
together), and there is direct precedent for refusing it: `keys/credentialSessionEnv.ts`'s
`RESERVED_ENV_VAR_PREFIXES` already reserves the whole `CLAUDE_` prefix on the sibling credential-delivery
env path, for exactly this load-bearing-clobber reason (`@decision f44cc187`/`0ab1593a`).

## Deliberately NARROW to the one exact name, not the whole `CLAUDE_` prefix

The owner approved (b) on the explicit condition that this card stays scoped to `CLAUDE_CONFIG_DIR` alone.
Widening the `sessionEnv` config validator's reservation to the whole `CLAUDE_` prefix (matching
`credentialSessionEnv.ts`'s own reservation) is a **considered, deliberately deferred** option, not a
rejected one — it could silently break an existing user's legitimate `sessionEnv` entry (e.g. a
project-scoped `CLAUDE_CODE_*` tuning var delivered this way today), and that is a separate decision this
card does not make. Revisit as its own card if a future incident shows the narrower CLAUDE_CONFIG_DIR-only
reservation isn't enough.

## Case sensitivity

Environment variable names are case-insensitive on win32 and case-sensitive on POSIX. Both the validator
(`claudeConfigDirSessionEnvKeyError`, `mcp/platform.ts`) and the `buildSpawnEnv` backstop scrub
(`pty/host.ts`) match on the CURRENT process's `process.platform`, never a fixed case transform — the
daemon and the engine it spawns always share one host, so there is no cross-platform case to reconcile.
On win32, any case-variant spelling of `claude_config_dir` is caught; on POSIX, only the exact-case
`CLAUDE_CONFIG_DIR` is reserved (a differently-cased POSIX key is left alone, matching how the real
engine's own env lookup would treat it).

## No carve-out for rotating an already-stored value

Unlike the dotted-key check (`@decision 12400719`), there is no `priorSessionEnvKeys`-style exception that
lets an already-stored `CLAUDE_CONFIG_DIR` have its VALUE rotated. Since no legitimate use was ever found,
every write carrying this key — new or a rotation of an existing one — is rejected outright.

## Existing stored rows: no migration, scrub at spawn instead

No evidence any project ever stored this (zero hits in the test corpus; no feature ever wrote one). Rather
than a DB migration script, `buildSpawnEnv` (`pty/host.ts`) unconditionally drops every `sessionEnv`-sourced
`CLAUDE_CONFIG_DIR`-matching key at spawn time — this neutralizes any already-stored legacy value
transparently, with no DB write needed, the moment this fix is live. The validator rejection stops a NEW
PATCH-shaped write going forward (see the "Two options considered" section above for the two REST create
routes it does NOT cover); the spawn-time scrub is what actually closes the gap for every entry point,
PATCH or create, past or future. A dropped legacy value is logged once per spawn (`console.warn`, `[pty]` prefix, matching
this file's existing diagnostic style) naming the KEY only, never the value — so the project owner can see
why their setting is being ignored without the log line itself becoming a disclosure vector. Checked
against `log-message-content-gate.mjs`'s `redactedExcerpt(` call-site census: this line does not call
`redactedExcerpt(` at all (it never logs content, only a fixed key name), so it is correctly outside that
census's scope.

## The daemon's own `CLAUDE_CONFIG_DIR` keeps working

The scrub in `buildSpawnEnv` targets the `sessionEnv`-sourced value ONLY — the daemon's own
`process.env.CLAUDE_CONFIG_DIR`, copied into the child env by the earlier `processEnv` loop in the same
function, is untouched. That remains `a92a0913`'s supported relocation path: set `CLAUDE_CONFIG_DIR` in
the daemon's own environment to relocate it for every project.

## Do not

- Do not widen the `sessionEnv` reservation to the whole `CLAUDE_` prefix here — see "Deliberately
  NARROW" above; that is a separate decision, not something this card's scope covers.
- Do not add a `priorSessionEnvKeys`-style rotation carve-out for this key, the way the dotted-key check
  has one — no legitimate use case was found, so there is nothing to preserve a rotation path for.
- Do not scrub the daemon's own `process.env.CLAUDE_CONFIG_DIR` in `buildSpawnEnv` — only the
  `sessionEnv`-sourced value. Scrubbing the daemon's own value would break `a92a0913`'s supported path.
- Do not log the dropped value, ever — only the key name. The whole point of this backstop is to surface
  *that* something was ignored, not to echo the secret-shaped path back into the daemon's shared log.
- Do not thread a per-session override through the transcript readers/deny-rule builders as a "better"
  fix later without re-opening this decision — that was option (a), rejected above for its blast radius
  on correctness-critical hot paths.

## Source

Validator: `claudeConfigDirSessionEnvKeyError` / `validateProjectConfigOverride` (`packages/daemon/src/mcp/platform.ts`).
Spawn-time backstop: `buildSpawnEnv` (`packages/daemon/src/pty/host.ts`).
Tests: `packages/daemon/test/sessionenv-claude-config-dir-guard.mjs`, `packages/daemon/test/claude-config-dir-sessionenv-spawn-scrub.mjs`.
