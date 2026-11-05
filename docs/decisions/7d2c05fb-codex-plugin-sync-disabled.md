# Codex plugin sync is disabled per invocation (`-c features.plugins=false`)

Card 7d2c05fb. Parity note for `createCodexPty` (`pty/codex-host.ts` `CODEX_PLUGIN_SYNC_OVERRIDE_ARGS`), sitting beside the update-check override (`CODEX_UPDATE_CHECK_OVERRIDE_ARGS`).

## Finding
An approved real codex spawn (2026-11-05, Windows) ran `git ls-remote https://github.com/openai/plugins.git HEAD` and cloned into `CODEX_HOME/.tmp/plugins-clone-*` even with `check_for_update_on_startup=false` and a loopback-only provider: unannounced outbound :443 traffic and disk writes in every session.

## Evidence for the key (codex-cli 0.153.4)
- `codex --help`: `--enable/--disable <FEATURE>` is "Equivalent to `-c features.<name>=true/false`".
- `codex features list` (read-only): `plugins  stable  true`. Also listed: `remote_plugin  stable  true`, `plugin_sharing  stable  true`. The listing does not say what each flag gates.
- Two bounded real `codex exec` runs, temp `CODEX_HOME`, loopback stub provider (HTTP 500, no key), ~39 s each, child processes found by walking up to the captured codex pid:
  - Control (no flag): `git ls-remote https://github.com/openai/plugins.git HEAD`, `git-remote-https`, `fetch --depth 1` and `reset --hard refs/codex/curated-sync` children, and `.tmp/plugins-clone-*`, `.tmp/plugins`, `.tmp/plugins.sha` appeared.
  - `-c features.plugins=false`: no git child, no `.tmp` dir.
- Bound: n=1 per arm, `exec` mode on Windows, not the interactive TUI Loom spawns. `remote_plugin` was not tested alone.

## Does Loom use codex plugins?
No. Grep for "plugin" in `pty/codex-*.ts` finds nothing; the `host.ts` hits are claude-side (plugin-MCP enable prompt).

## Do not
- Do not persist this into the user's real `~/.codex/config.toml`; it stays a per-invocation `-c`.
- Do not drop the argv pin in `test/codex-update-check-spawn-argv.mjs`: a no-op flag reads as a fix.
