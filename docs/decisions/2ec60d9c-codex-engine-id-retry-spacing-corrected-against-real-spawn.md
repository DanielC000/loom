# 2ec60d9c — `CODEX_ENGINE_ID_RETRY_MS` retry spacing, corrected against a real codex spawn

## Narrative

Card 2ec60d9c (DoD-1): retry spacing for `captureCodexEngineSessionId`'s engine-session-identity discovery in `packages/daemon/src/pty/host.ts`. Env-overridable (`LOOM_CODEX_ENGINE_ID_RETRY_MS`) so a hermetic test can shrink it, mirroring `CODEX_BUSY_STALE_MS`'s own `LOOM_CODEX_BUSY_STALE_MS` convention.

Corrected against a REAL codex spawn (this card's own DoD-4 real-spawn test) — a first design that fired ONE retry ~2s after the ready marker was WRONG about WHEN codex actually creates the rollout file: it is NOT created at process boot. A real run observed the file's on-disk mtime landing ~13 seconds AFTER the ready marker first rendered — the file is created lazily, around when the FIRST real turn is actually submitted/begins processing, not at bare boot. A fixed one-shot ~2s-later retry can therefore MISS every real session whose first turn takes longer than that to actually start (a busy host, a slow model response, or — the specific case the real-spawn test hit — this host's OWN personal `~/.codex/config.toml` carrying extra plugin/marketplace MCP servers whose "Starting MCP servers (N/4)" episode can itself take several seconds before the first turn even begins).

See `CODEX_ENGINE_ID_MAX_ATTEMPTS` (same file) for the retry COUNT this spacing multiplies against.

## Discovery scan, not a hook report (DoD-1, `captureCodexEngineSessionId`'s own doc)

`captureCodexEngineSessionId` discovers + reports a codex session's engine-session identity via a discovery SCAN — see `pty/codex-transcript.ts#findConversationIdForSpawn`'s own doc for why a scan (rather than a hook report) is the only mechanism available for codex. It fires `onEngineSessionId` the SAME way claude's own SessionStart-hook branch does (`deliverHook`, same file), so every downstream consumer (DB persistence, `worker_transcript`, dead-session sweeping) treats a codex session identically once this lands — no separate codex-only plumbing needed past this one call. `previousEngineId` is always null here: unlike claude's own SessionStart rotation handling, codex has no rotation concept to report. Best-effort throughout: never gates kickoff/busy-detection either way (both already latch/fire off `screenScan` alone, independent of this), and stops retrying the instant the pty exits.

## `findConversationIdForSpawn`'s own doc (codex-transcript.ts's site, DoD-1)

`findConversationIdForSpawn` (`packages/daemon/src/pty/codex-transcript.ts`) exists because codex has no SessionStart-hook equivalent to REPORT its own conversation id the way claude's engine does — `CodexLive.engineSessionId` (`pty/host.ts`) would stay permanently null without it. Codex writes its rollout file's FIRST line (`session_meta`, carrying `session_id`+`cwd`) essentially at conversation start — well before any TUI output a human/Loom would ever observe — so this function DISCOVERS the id instead of being told it: it scans every rollout file created at/after `sinceMs` (a cheap `stat`-only filter before ever reading a candidate's content) and returns the `session_id` of the one whose OWN `session_meta.payload.cwd` matches `cwd` — the newest such match, if more than one candidate somehow qualifies (e.g. two sessions spawned into the same cwd within the same window). Unlike `resolveTranscriptFile` (which matches an ALREADY-KNOWN id against a filename substring), this function has no id to match against yet — cwd + recency is the only correlator available at spawn time. It returns null (never throws) when nothing matches, including a genuinely-not-yet-written file — the caller (`pty/host.ts`'s `captureCodexEngineSessionId`) is responsible for any retry.

## Do not

- Do not revert to a single fixed-delay retry for engine-session-id discovery — a real-spawn test showed a one-shot ~2s-later check misses sessions whose first turn is slow to start.

## Single resolution site, not a per-caller conditional (DoD-2, `sessions/transcript.ts`'s own site)

A separate DoD item on this card: `sessions/transcript.ts`'s harness-dependent exports each take an optional trailing `harness` param and dispatch through `transcriptOpsFor`, ONE resolver — mirroring `PtyHost.findAnyLive`'s own "one resolver, not a per-caller conditional" shape: scattering a `harness === "codex"` check across each of this module's ~20 call sites would let the codex/claude branches drift independently, the way the reverted `Live.kind` discriminator did (card `353f6dc4` M10). `harness` mirrors `Session.harness`'s own type (undefined/null/`"claude"` ⇒ claude; `"codex"` ⇒ codex) so a call site passes a session's own `.harness` field verbatim.

### Do not (2)

- Do not add a per-call-site `harness === "codex"` conditional to `sessions/transcript.ts` — route through `transcriptOpsFor` instead, or the codex/claude branches risk drifting independently (as `Live.kind` did).

### Source (2)

JSDoc header comment, `packages/daemon/src/sessions/transcript.ts`, lines 35-42 as of this tranche's HEAD.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`CODEX_ENGINE_ID_RETRY_MS`'s top-of-const doc): lines 56-71, as of this tranche's HEAD. Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The "Discovery scan, not a hook report" section above is a second site, same card: `captureCodexEngineSessionId`'s own JSDoc, extracted by tranche 18. The "`findConversationIdForSpawn`'s own doc" section above is a third site, same card: `findConversationIdForSpawn`'s own JSDoc (`packages/daemon/src/pty/codex-transcript.ts`) — extracted by tranche 2 on that file (card `32d90bb2`); source lines joined into a flowing paragraph and `*` comment markers stripped, with no change to the facts or the argument's structure.
