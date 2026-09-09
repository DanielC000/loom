# 61ab62e3 — the playwright MCP's default output dir must never point at the vault

## Narrative

Card 61ab62e3: `resolvePlaywrightCli`'s companion output-dir config governs not just an explicit `browser_take_screenshot` call but the DEFAULT (implicit, no-filename) artifact for every snapshot-bearing tool response — the MCP's default `snapshot.mode` writes the page's ARIA snapshot to `page-{timestamp}.yml` in `outputDir` on essentially every browser tool call, making `outputDir` a HIGH-FREQUENCY write target, not an occasional one.

An earlier default pointed `outputDir` at `vaultPath` — because it's high-frequency, that littered the user's Obsidian vault with `page-*.yml` on every browser turn. `buildMcpServers` now always passes a repo-EXTERNAL per-session scratch dir (`sessionScratchDir`) instead, so a screenshot (or an implicit snapshot) taken with no explicit path can never land inside the vault or the project working tree.

## Do not

- Do not default the playwright MCP's `outputDir` to `vaultPath` (or omit it) — the MCP's default snapshot mode writes to it on essentially every browser call, so any vault/repo-adjacent default littered real user content on the very first turn.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`resolvePlaywrightCli`'s function doc), as of commit f81f9c1108773e559efe78b7166cbf78b6201480. Relocated by card 614a9fef (tranche 3 on `pty/host.ts`); reworded into flowing narrative (the `page-{timestamp}.yml`/`page-*.yml` specimen and the `buildMcpServers`/`sessionScratchDir` fix carried over verbatim), `*` comment markers stripped.
