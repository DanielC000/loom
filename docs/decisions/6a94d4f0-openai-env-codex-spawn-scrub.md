# 6a94d4f0 — the daemon's inherited OPENAI_* / CODEX_API_KEY / CODEX_ACCESS_TOKEN never reaches a codex session

Codex analogue of `c8eeda93`. `createCodexPty` builds its env through `buildSpawnEnv` (`pty/host.ts`), which copied the daemon's whole `process.env` minus a short list. An exported `OPENAI_API_KEY` would silently move every codex session from the owner's ChatGPT login (auth in `CODEX_HOME`) to per-token billing, and `OPENAI_BASE_URL` would silently reroute it. The stored-credential path was already closed (`0ab1593a` denies `OPENAI_`/`CODEX_` prefixes); only the inherited-daemon-env path was open.

`buildSpawnEnv` takes a fifth parameter `openAi: "off" | "scrub" | "pass"`. `createCodexPty` passes `"scrub"` (or `"pass"` when the hatch is on); `createPty` (claude) passes nothing, so claude spawns are byte-identical. The match (`isOpenAiSpawnEnvKey`) is case-insensitive: prefix `OPENAI_`, plus the exact names `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`.

The ChatGPT login is unaffected: `CODEX_HOME` and every other `CODEX_*` name still pass through. A project `sessionEnv` entry still wins (a keys-only warn names it). The hatch is the human-only daemon-process env `LOOM_PASS_OPENAI_ENV=1` (`isPassOpenAiEnvEnabled`, `paths.ts`), deliberately separate from `LOOM_PASS_ANTHROPIC_ENV`: different harness, different billing surface.

## Do not

- Do not log a VALUE of any scrubbed var — key names only.
- Do not widen the match to the whole `CODEX_` prefix — `CODEX_HOME` carries the ChatGPT login and must keep flowing.
- Do not fold the hatch into `LOOM_PASS_ANTHROPIC_ENV`, and do not read it from a project `sessionEnv` or any agent-writable surface.
- Do not apply the scrub to claude spawns (they never use `OPENAI_*`; the default `"off"` keeps them byte-identical).
- Do not move the scrub after the `sessionEnv` merge — a deliberate project override must still win.

**Migration:** a setup that relied on the daemon's own exported `OPENAI_*` reaching codex must set it in the project's `sessionEnv`, or fleet-wide set `LOOM_PASS_OPENAI_ENV=1`. Logging: only the silent-scrub line ("not forwarding the daemon's inherited …") is once per daemon process; the `sessionEnv` warn and the `LOOM_PASS_OPENAI_ENV=1` forward line fire on every codex spawn. All name keys only, never values.
