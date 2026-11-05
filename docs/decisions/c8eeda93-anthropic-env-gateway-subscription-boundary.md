# c8eeda93 — the daemon's inherited ANTHROPIC_* env never reaches a session (subscription vs gateway boundary)

`buildSpawnEnv` (`pty/host.ts`) used to copy the daemon's whole `process.env` into every claude/codex session, minus `CLAUDECODE`/`CLAUDE_CODE_*`/two Loom vars. An exported `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` would silently flip the whole fleet from the owner's subscription login to per-token billing (a spend surface); `ANTHROPIC_BASE_URL` would silently reroute every session through another endpoint. Verified by a pure-seam probe (card c8eeda93 investigation): all `ANTHROPIC_*` passed; `CLAUDE_CODE_USE_BEDROCK/VERTEX`/`CLAUDE_CODE_OAUTH_TOKEN` were already scrubbed by the `CLAUDE_CODE_` prefix.

## Decision

- Inherited env: drop every `ANTHROPIC_*` (case-insensitive — Windows env names are) plus the exact name `AWS_BEARER_TOKEN_BEDROCK`, in the base-copy loop, BEFORE the `sessionEnv` merge.
- Not scrubbed on purpose: `AWS_*`/`GOOGLE_*`/`CLOUD_ML_REGION`/proxy vars (legitimate for every other child; inert for claude without the already-scrubbed `CLAUDE_CODE_USE_*` switches) and `CLAUDE_CONFIG_DIR` (decisions fbb6e8ec / a92a0913).
- Project `sessionEnv` may still set `ANTHROPIC_*` (human REST / Platform Lead only; agent shape omits `sessionEnv`; values masked on read). Every such spawn logs one loud line naming the KEYS only.
- Escape hatch: `LOOM_PASS_ANTHROPIC_ENV=1` in the daemon's own process env (`paths.ts` › `isPassAnthropicEnvEnabled`) restores the old pass-through and logs a loud keys-only line per spawn. Process-env only, literal `"1"` only.
- Stored credentials already cannot use `ANTHROPIC_`/`CLAUDE_`/`OPENAI_` names (`keys/credentialSessionEnv.ts`), so no change there. codex shares `buildSpawnEnv` and is scrubbed identically (harmless; codex reads no `ANTHROPIC_*`). The `OPENAI_API_KEY` analogue for codex is a separate card.

## Do not

- Do not log a VALUE of any `ANTHROPIC_*` var, ever — key names only. The log line exists to say that something is happening, not to echo a secret into the shared daemon log.
- Do not read the hatch from a project `sessionEnv` or any agent-writable surface — it is a human, daemon-process-level decision.
- Do not make the match case-sensitive, or narrow it to a hand-listed set of names: new `ANTHROPIC_*` knobs appear over time.
- Do not widen the scrub to `AWS_*`/`GOOGLE_*`/proxy vars without a new decision — they have legitimate non-claude uses.
- Do not move the scrub after the `sessionEnv` merge — a deliberate project override must still win.

**Addendum (card 9223fe84):** the scrub covers only the process env. claude's own settings files (`env.ANTHROPIC_*`, `apiKeyHelper`) are detected and warned about, key names only, never neutralized — see `9223fe84-claude-settings-routing-keys-detect-and-warn.md`.

**Migration:** a Bedrock/Vertex/gateway setup that relied on the daemon's own exported `ANTHROPIC_*`/`AWS_BEARER_TOKEN_BEDROCK` reaching sessions must now set them in the project's `sessionEnv` (or, deliberately fleet-wide, the human-only `LOOM_PASS_ANTHROPIC_ENV=1`); the daemon logs the scrubbed key names once per process.
