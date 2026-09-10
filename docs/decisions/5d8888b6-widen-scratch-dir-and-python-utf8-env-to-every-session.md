# 5d8888b6 — Widen `LOOM_SCRATCH_DIR` and force Python UTF-8 env, for EVERY session

## Narrative

Card 5d8888b6 (`pty/host.ts`, `buildSpawnEnv` / `scratchDirEnv`) does two related widenings of a
session's spawn env, both unconditional (no capability gate):

**`LOOM_SCRATCH_DIR`** — an out-of-tree, per-session scratch root — used to be told only to a
browser-testing spawn (`@playwright/mcp`'s `checkFile` guard only allows a write inside `--output-dir`
or the subprocess's inherited cwd, so that agent needed this exact path to stage a `browser_file_upload`
source file or persist an explicit-path screenshot). This decision widens it to EVERY session
(`sessionId`-only now, the `mcpServers` gate is gone) since any agent can benefit from a repo-external
place to stage a throwaway file (e.g. the shared Python venv / document-conversion tooling previously had
no such pointer outside a browser-testing spawn). Additive-widening only: a browser-testing spawn still
gets exactly the same value it always did.

**`PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`** — the standard, safe way to make every child Python
interpreter (e.g. one an agent invokes ad hoc, or the shared markitdown venv) decode/encode as UTF-8
regardless of the host's locale, instead of Windows' default legacy code page (`cp1252` and similar),
which raises `UnicodeEncodeError` on ordinary Loom data (arrows, emoji, box-drawing — verified first-hand
on this project's own board JSON). This is a GLOBAL interpreter-behavior change for every Python child
this spawn's env reaches, not a narrow tweak — set before the `sessionEnv` merge, like every other var in
`buildSpawnEnv`, so a project that needs a different Python encoding can still override it.

## Do not

- Do not re-gate `LOOM_SCRATCH_DIR` behind `browserTesting`/`mcpServers` — the widening to every session
  is deliberate; a narrower re-gate would silently take the scratch pointer away from every other capability
  that now depends on it.
- Do not set the Python UTF-8 vars AFTER the `sessionEnv` merge — they must precede it so a project's
  deliberate override still wins.

## Source

Inline doc comments above `buildSpawnEnv` (the PYTHONIOENCODING/PYTHONUTF8 paragraph) and above
`scratchDirEnv` in `packages/daemon/src/pty/host.ts`, as of main `afce859a`.
