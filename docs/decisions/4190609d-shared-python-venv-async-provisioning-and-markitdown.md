# sha:4190609d — the shared Loom-managed Python venv, async provisioning, and the markitdown capability

Relocated from CLAUDE.md (docs relocation, card `e0ba98c1`). Keyed to the introducing commit `sha:4190609d` (`feat(profiles): opt-in markitdown document-to-markdown MCP capability`), verified with `git rev-parse`.

## `documentConversion` (markitdown MCP)

A session whose resolved Profile sets `documentConversion` spawns with its OWN per-session stdio markitdown MCP (Microsoft `markitdown-mcp`, resolved to an ABSOLUTE path) and its single tool `mcp__markitdown__convert_to_markdown` allowlisted, so a research/document rig can convert PDF/Office/images/HTML to Markdown to save tokens.

- ffmpeg: AUDIO conversion needs `ffmpeg` on PATH; document formats do not. Without ffmpeg, `markitdown[all]`'s `pydub` prints a harmless "Couldn't find ffmpeg or avconv" to stderr on every invocation. Loom does NOT install or suppress it.
- Structurally identical to `browserTesting`: default OFF and fully additive (every existing spawn byte-identical when off); pinned on the session row so resume/fork/recycle keep it. HUMAN-set only (Profiles UI/REST), never an agent MCP tool (it launches a host process).
- Binary resolution (`pty/host.ts` › `markitdownMcpServer`): first the human-only `LOOM_MARKITDOWN_BIN` override (an already-installed binary, and the TEST seam so CI never builds a venv), else a single `fs.existsSync(loomVenvBin(…))`. Warm venv: inject it. Cold: return null (THIS spawn skips the MCP, like Playwright's missing-cli) and kick BACKGROUND provisioning. A later spawn picks it up once the venv lands.
- The kick is RETRYABLE and DIAGNOSTIC: a failed attempt no longer dead-ends, and the classified reason plus captured error tail is surfaced via the status model and REST.
- One-time USER setup is just a base Python ≥3.10 on PATH (or `python.interpreterPath`); Loom owns the venv and the install.

## The shared venv (`python/venv.ts`)

Loom owns ONE shared venv under `<LOOM_HOME>/python/venv`, NOT a venv per tool.

**Event-loop discipline (load-bearing).** The spawn HOT PATH (`createPty` → `buildMcpServers`) does NO blocking work, only `fs.existsSync(loomVenvBin(binary))`. Creating the venv plus `pip install markitdown[all]` takes minutes, so provisioning is fully ASYNC (`child_process.spawn`, never `spawnSync`) and BEST-EFFORT, off the event loop, mirroring `git/worktrees.ts` `createWorktree`. A synchronous venv-create/pip on the spawn path would FREEZE the whole daemon (every spawn/resume, the web UI, all HTTP/MCP) for the entire install.

**`ensurePythonPackageAsync({ package, binary, probeImport?, timeoutMs?, interpreterOverride? })`** is the reusable surface every Python-backed capability calls OFF the hot path. It creates the venv if missing (from a base Python found by async `discoverBasePythonAsync`: `python.interpreterPath` FIRST, then `python3` → `python` → win32 `py -3`), pip-installs, and returns a CLASSIFIED `{ binary, outcome, errorTail }`: the ABSOLUTE console-script path plus `ready` on success, else `binary:null` with the specific failure (`no-base-python` / `venv-create-failed` / `pip-failed` / `timeout` / `disabled`) and the captured ~4KB stdout+stderr tail. venv/pip run with PIPED stdio (NOT `stdio:'ignore'`) so the real cause (proxy / SSL / resolver / timeout) is surfaced. It is idempotent (a ready venv hits a fast import-probe path), BOUNDED (every spawn has a timeout; the markitdown `pip install` gets ~15 min / `900_000`ms because `markitdown[all]` is heavy; killed-on-exceed is classified `timeout`; venv-create/probe keep fast bounds), and NEVER throws.

**Retry/dedupe.** The markitdown consumer kicks it deduped ONLY while a job is genuinely IN-FLIGHT (concurrent spawns never launch parallel installs), but a fresh kick is allowed after a TERMINAL outcome, so a profile-save pre-warm, a later spawn, or the human-only retry all actually retry (the old PERMANENT one-shot dead-ended every retry until a daemon restart).

**Status and REST.** Status `{ state: idle|installing|ready|failed, reason, errorTail, binary, lastAttemptAt }` is read via human-only loopback `GET /api/python/provisioning`; `POST /api/python/provisioning/retry` re-kicks it off the event loop. Both are NOT agent MCP tools (provisioning launches a host process; same trust posture as the git/vault/gateCommand writers). On success the resolved path is memoized (the cold case re-checks `fs.existsSync` each spawn until warm).

**Switches and config.** `LOOM_PYTHON_NO_PROVISION=1` disables real venv/pip provisioning (CI hermetic tests plus an ops escape hatch). Loom installs PACKAGES, never the interpreter. `python.interpreterPath` is a top-level human-only config resolved by `resolveConfig` and carried to the daemon resolver via the session-env transport `pythonSessionEnv` → `LOOM_PYTHON_INTERPRETER`; it points at a host EXECUTABLE, so like `obsidian.path`/`gateCommand` the agent-facing config validator REJECTS it. It is a per-project config with no platform-override layer and resolves to the first project that sets one, else PATH discovery.

**Pre-warm (`python/prewarm.ts`).** The venv is pre-warmed off the hot path to close the cold-skip window, at daemon boot if any profile sets `documentConversion` and when a profile is SAVED with it on. Both reuse the same deduped async kick (`prewarmMarkitdown`), so the first documentConversion session usually finds the MCP warm.

## Do not

- Do not run `spawnSync` (or any blocking venv/pip work) on the spawn hot path.
- Do not make the provisioning kick a permanent one-shot, or let it throw.
- Do not expose provisioning or `python.interpreterPath` as an agent MCP tool or agent-settable config.
