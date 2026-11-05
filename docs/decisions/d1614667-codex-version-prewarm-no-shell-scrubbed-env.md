# d1614667 — the codex `--version` prewarm uses the session shim resolver and the session OPENAI_* scrub

`prewarmCodexVersionAsync` (`pty/codex-doctrine.ts`) used to run `execFile(bin, ["--version"], {shell: win32})`. That was the last codex exec going through a shell: a timeout killed only `cmd.exe` and could orphan the node child, and the exec inherited the daemon's raw env (`OPENAI_API_KEY`/`OPENAI_BASE_URL`).

Now it calls `resolveCodexLaunchTarget` (`pty/resolve-bin.ts`, the same unit `PtyHost.resolveCodexLaunch` uses: `winCmdShimSpawnTarget`, fail closed with the e92cd4a3 remedy text) and spawns node on the shim's real entry directly, with an env built by `buildCodexVersionProbeEnv` (drops `isOpenAiSpawnEnvKey` names unless the human-only `LOOM_PASS_OPENAI_ENV=1` hatch is set; `CODEX_HOME` flows).

A refused (unparsable shim) or failed prewarm is best-effort: it logs a `[codex-doctrine] codex version prewarm failed (continuing)` line and leaves the cached version unset. It never throws and never falls back to a shell.

## Do not

- Do not reintroduce `shell:true` or a cmd.exe fallback for this exec (see `e92cd4a3`, `8ddd12c6`).
- Do not re-implement the shim resolution or the OPENAI_* predicate locally: both live in `resolve-bin.ts` and are shared with the session spawn so the two paths cannot drift.
- Do not pass the daemon's raw `process.env` to this exec.
