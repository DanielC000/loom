# 9223fe84 — claude's own settings files can set ANTHROPIC_* / apiKeyHelper: detect and warn, never neutralize

Decision c8eeda93 scrubs the DAEMON's inherited `ANTHROPIC_*` / `AWS_BEARER_TOKEN_BEDROCK` from the process env of every spawned session. That scrub does not reach claude's OWN settings files. A Loom-spawned claude gets only `--settings <per-session file>` (`pty/host.ts` `buildSpawnArgs`; file written by `writeSessionSettings`, `pty/claude-settings.ts`) and Loom restricts no setting sources, so user-level `<CLAUDE_CONFIG_DIR|home>/.claude/settings.json` / `settings.local.json`, and a project's or worktree's `.claude/settings(.local).json`, still apply on top. Any of them can carry `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_API_KEY` / … or an `apiKeyHelper` — the same spend/routing surface, outside the scrub. A worktree-level file is the more dangerous vector: it outranks user scope and a worker can commit one. (Precedence per claude's documented settings model — managed > CLI `--settings` > local project > shared project > user; not re-verified against a live CLI.)

## Decision

- **Detect and warn, read-only.** `pty/claude-settings-routing-scan.ts`:
  - ONE shared predicate (`isClaudeRoutingEnvKey` = c8eeda93's `isAnthropicSpawnEnvKey`, now in the leaf `pty/anthropic-env-key.ts` and re-exported by `host.ts`, OR `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`) plus the literal key `apiKeyHelper`, used by both scans.
  - Key names come from worker-writable files, so every reported list passes `sanitizeKeyNames`: only `[A-Za-z0-9_]{1,128}` names are listed, the rest are counted (`+N unprintable`), and at most 20 names per file are listed (`+N more`). A file over 256KB gives `available:false` with reason `oversize:<file>`.
  - **Boot, user level:** scans `claudeUserSettingsDir()` (`claude-config.ts`: `$CLAUDE_CONFIG_DIR` ITSELF when set, since it replaces `~/.claude` with no extra `.claude` level; else `<home>/.claude`) `/settings(.local).json` async at boot; one `[boot]` log line when something is found; result served on `served_status` / `GET /api/deploy-status` as `claudeSettingsRouting: {available, reason?, findings:[{file, keys[]}]}`. `available:false` (+ a fixed-vocabulary `reason`) means the scan failed or has not landed yet — never clean.
  - **Per spawn, worktree level:** `kickWorktreeSettingsRoutingScan(sessionId, cwd)` is called from `PtyHost.spawn()`, fire-and-forget (void, never awaited, `fs.promises`, byte-capped, never throws). Logs one line per spawn ONLY when something is found: session id + path relative to the worktree + key NAMES.
  - Loom itself writes no `.claude/settings*.json` into worktrees (skills inject into `.claude/skills`; the CLI's own `settings.local.json` holds permissions, no routing keys), so a hit is the project's or the agent's file.
- **Not neutralized.** Blanking the keys in Loom's per-session `--settings` `env` was rejected:
  1. Unverified: whether an empty-string env value or empty `apiKeyHelper` counts as unset or as a literal empty value needs a real claude run, and a wrong guess could break auth for every session.
  2. It needs a hand-listed set of names, which c8eeda93 forbids (new `ANTHROPIC_*` knobs appear).
  3. It would clobber legitimate setups (a user-level gateway/Bedrock login, a project `sessionEnv` gateway) and force special-casing of the `LOOM_PASS_ANTHROPIC_ENV` hatch.
  4. It cannot override managed settings and does nothing for settings content a project owns.
- **Limit:** detection happens at spawn (worktree) and boot (user level), so a file written mid-session is seen only at the next spawn/resume.
- No board card is filed; the surfaces are the boot line, the per-spawn line, and `served_status`.

## Do not

- Do not log, return or serve a VALUE of any scanned key — names only (`test/claude-settings-routing-scan.mjs` plants a sentinel secret and asserts it appears nowhere).
- Do not make the per-spawn scan synchronous, awaited, or part of `createPty`'s hot path — the spawn path does only `existsSync`.
- Do not read `available:false` as clean, and do not turn a scan failure into an empty `findings` with `available:true`.
- Do not edit, rewrite or delete any settings file the scan finds — owner/project files are never touched.
- Do not fork the key predicate into a second copy; extend `isClaudeRoutingEnvKey`.
- Do not widen the scan to managed/enterprise settings paths without a new decision; Loom cannot neutralize them either way.
- Do not measure the oversize cap on the DECODED string: invalid UTF-8 inflates on decode (`0xFF` → U+FFFD, +2 bytes), so the fs seam returns the raw `Buffer` and the cap is compared on its byte length.

## Follow-up (card 37f7b100)

- **Finding labels.** User-level findings are labelled `settings.json` / `settings.local.json`, relative to the resolved user settings dir (`claudeUserSettingsDir()`), not `.claude/settings.json` — the label base is that dir itself, whether it is `$CLAUDE_CONFIG_DIR` or `<home>/.claude`. Worktree-level findings keep the `.claude/settings*.json` form (labelled relative to the worktree cwd).
- **Oversize check.** `ScanFsSeam.readCapped` returns the raw bytes read; `oversize:<label>` is decided on that byte count before decoding, so an at-cap file with invalid UTF-8 is scanned, not misreported as oversize. Still fail-closed: an over-cap or unreadable file is never reported clean.
- **`.claude` literal.** `claudeUserSettingsDir()` builds the unset-case path from `CLAUDE_DOCTRINE_DIR` (`pty/claude-dirname.ts`, a leaf) instead of a hand-written literal; the resolved path is unchanged.
