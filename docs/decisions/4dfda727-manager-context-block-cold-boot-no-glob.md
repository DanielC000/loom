# 4dfda727 — manager spawn gets a "Where things live" context block so a cold boot never Globs for its resume doc

## Narrative

PL Auditor finding #8: a cold-boot orchestrator had no way to construct its own resume-doc path (the daemon knows the vault root, but never told the agent), so it Globbed for the doc from the user's home directory — a broad Glob that hits the 20s ripgrep cap. `composeManagerStartupPrompt` fixes this by injecting a small "Where things live" context block (the project's absolute `repoPath` + `vaultPath`, later extended to the fully-resolved resume-doc path itself — see `docs/decisions/c1f2f095-…`) into a MANAGER session's startup prompt at spawn, so the agent reads its roots verbatim instead of searching for them.

## Do not

- Do not let a manager Glob from its home directory for project files it can instead read by the absolute path this block already hands it — that's the exact 20s-ripgrep-cap failure this block exists to prevent.

## Source

JSDoc comment above `composeManagerStartupPrompt` in `packages/daemon/src/sessions/manager-prompt.ts`: originally lines 6-11, as of this tranche's HEAD. Introduced by commit `4dfda7278c6ea73440fd658b9c046c154648013a` (`fix(sessions): inject absolute repo+vault paths into manager startup context so orchestrators stop globbing for the resume doc`; no board card cited anywhere in the block, the file, or the introducing commit message — sha-keyed per the extraction program's rule; verify with `git cat-file -t 4dfda727`). Relocated by card `4c6a1edf` ("manager-prompt.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into a flowing paragraph.
