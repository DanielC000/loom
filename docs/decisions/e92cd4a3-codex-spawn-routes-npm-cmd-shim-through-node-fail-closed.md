# e92cd4a3 — `createCodexPty` spawns an npm `.cmd` shim as node + its real entry, and fails closed on an unparsable shim

Card `e92cd4a3` (follow-up from the `2ef54430` Code Review). On Windows `codex` resolves to
`%APPDATA%\npm\codex.cmd`; handing that straight to node-pty runs it through `cmd.exe` implicitly, so every
codex argv element (model pin, `-c` overrides, provider URL, any future element) was subject to cmd.exe
parsing (`%VAR%` expansion, `^` stripping). The codescape and usage-status spawn sites already resolved the
shim through `winCmdShimSpawnTarget` (`pty/resolve-bin.ts`, see `8ddd12c6`); codex was the odd one out.
`createCodexPty` now calls that SAME resolver immediately before `spawn()` (no second resolver). Off win32,
or for a non-`.cmd` bin, it is a byte-identical passthrough.

## Decision: fail closed

An unrecognisable shim (pnpm-global, npm<=6, hand-written wrapper) makes `parseNpmCmdShim` throw and the
codex spawn fails with the error naming the shim path. Falling back to the implicit cmd.exe would silently
reinstate the exact bug class for the shapes we cannot parse, and `2ef54430` already treats an
unresolvable provider setup as a fail-closed spawn. The user-facing remedy is a real npm-global codex
install (or `LOOM_CODEX_BIN` pointing at a real executable).

## Consequences

- Behaviour change: a Windows codex installed via `pnpm add -g` (or any non-standard `codex.cmd`) now
  refuses to spawn. It previously ran through the implicit cmd.exe. The error says to install codex as an
  npm global so `%APPDATA%\npm\codex.cmd` is a standard npm shim, and names the shim path it found.

## Do not

- Do not add a cmd.exe / `shell:true` / implicit-shell fallback for a codex shim that does not parse.
- Do not write a second shim resolver for codex; extend `winCmdShimSpawnTarget` if a new shim shape must be supported (see `adeb453f`).
- Do not point a Windows codex test fixture at a bare `@node fixture %*` `.cmd`; use an npm cmd-shim-shaped fixture (`test/_codex-npm-shim.mjs`) so the test exercises the real resolver.
