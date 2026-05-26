# Loom — Day-One De-Risking Spike

Throwaway. Proves the load-bearing assumptions before the real phase-1 build. See the plan at
`~/.claude/plans/mossy-frolicking-puppy.md` and the architecture at
`Obsidian Vault/Projects/Loom/Architecture.md`.

## Run

```sh
cd spike
npm install          # also confirms node-pty prebuilds on Win11
node server.mjs      # http://127.0.0.1:7878
```

Open http://127.0.0.1:7878, click **Spawn**. Drive from the browser, or script via the HTTP API:

| Endpoint | Purpose |
|---|---|
| `POST /api/spawn {prompt?, altScreen?}` | spawn an interactive claude pty (fixed 120×40) |
| `POST /api/input {loomId, data}` | write raw bytes to the pty (headless steering) |
| `POST /api/stop {loomId, mode}` | `mode`: `graceful` (Ctrl-C ×2), `exitcmd` (`/exit`), `hard` (`pty.kill`) — returns child snapshot taken **before** the stop |
| `POST /api/resume {loomId}` | spawn a fresh pty with `--resume <claudeSessionId>`, same cwd |
| `GET /api/state?loomId=` | session view (claudeSessionId, alive, exit, hooks, ringBytes) |
| `GET /api/orphans?pid=` | descendant process tree of a pid (read-only powershell) |
| `GET /api/sessions` | list all |

WS terminal: `ws://127.0.0.1:7878/ws/term/<loomId>` — binary frames = pty bytes, text frames =
control (`{type:sessionId|exit|reset}`); client sends `{type:stdin,data}` / `{type:repaint}`.

The daemon logs every spawn/attach/detach/hook/exit and tees pty output to `logs/<loomId>.log`.

## Findings (fill in while testing)

| # | Demo | Result | Notes |
|---|------|--------|-------|
| 0 | `where claude` == hardcoded path | ✅ | `C:\Users\danie\.local\bin\claude.exe`, node v22.16.0 |
| 0 | node-pty installs/prebuilds on Win11 | ✅ | prebuilt binary, no native compile (2s install) |
| 1 | TUI renders via node-pty→ws→(xterm) | ✅ (pipeline) / 👁 (look) | Full ANSI TUI streams through node-pty→ring→ws; coherent `[2J` frames + real content captured. Final xterm *visual* fidelity is best eyeballed at http://127.0.0.1:7878 |
| 2 | Bidirectional input | ✅ | Typed input → pty stdin ran new turns; menu nav (arrows/Enter) and slash-style input all reached the session |
| 3 | Alt-screen / scrollback | ⚠️ finding | v2.1.150 does **not** use the classic `1049h` alt-screen buffer in either mode — it uses `[2J` full-repaints. `DISABLE_ALTERNATE_SCREEN=1` set as default; scrollback *feel* needs an xterm eyeball |
| 4 | `SessionStart` POSTs `session_id`; `Stop` arrives | ✅ | Captured `session_id` ~1.6s after spawn, **unattended**; `Stop` fires at turn end. Hook→relay→daemon path solid |
| 5a | Graceful stop (Ctrl-C ×2) | ✅ | clean exit **code=0** ~2.8s; **0 orphans**; resumable (same sid reconnected) |
| 5b | Hard stop (`pty.kill`/TerminateProcess) | ✅ | exit **code=1** ~0.5s; **0 orphans even with a running `sleep` tool-child** (node-pty Job Object kills the tree); resumable |
| 6 | Late attach / detach / reattach | ✅ | 30s headless → session stays alive; late attach replays a **complete current frame** (coherent); ws close keeps pty running; reattach coherent |

### Gotchas discovered (load-bearing for Loom)
1. **`--strict-mcp-config` alone does NOT suppress the project `.mcp.json` enable prompt.** A home-level `~/.mcp.json` (docker/sentry) made claude block on "select servers to enable". Fix: pass `--strict-mcp-config` **WITH** an explicit `--mcp-config '{"mcpServers":{…}}'` → claude stops discovering project servers → no prompt. Loom always injects its task MCP server, so its real config is naturally immune.
2. **`--dangerously-skip-permissions` shows a blocking "Bypass Permissions mode" acceptance gate** on launch — fatal for unattended warmup. Fix (matches §9): use `--permission-mode acceptEdits` + a `permissions.allow` Bash allowlist in `--settings`. No gate, fully unattended.
3. **The gate-free Loom spawn config is validated**: `--settings <hooks+permissions> --permission-mode acceptEdits --strict-mcp-config --mcp-config '{"mcpServers":{}}'` boots interactive claude with **zero prompts** and captures the engine id unattended.
4. **node-pty job-object cleanup** means hard kill does not orphan tool children on Windows (the old Jinn-era worry doesn't materialize).

## Decisions this informs
- Risk #1 (ConPTY×TUI) — pipeline ✅, visual eyeball pending. Risk #2 (engine-id capture) — ✅.
- §6 MCP flags also gate startup; §9 acceptEdits is *required* (not just preferred) for unattended warmup.
- §12-Q10 stop: **graceful default** (clean code 0), **hard escalation** (fast, code 1) — both resumable, both orphan-free.
