# c1f2f095 — the manager's resume-doc path is resolved SERVER-SIDE and Read verbatim, never re-derived by the agent

## Narrative

`composeManagerStartupPrompt`'s context block emits the resume doc as a FULLY-RESOLVED absolute path, built SERVER-SIDE via `resolveResumeDocPath` (`sessions/resume-doc-notes.ts`) from the resolved `vaultPath` PLUS the project's `orchestration.resumeDocFilename` config (defaults to `"Orchestrator Log.md"` — Loom's own convention — when unset, so every project that doesn't override it is byte-identical to before this existed). `vaultPath` IS the project's vault directory (e.g. `.../Obsidian Vault/Projects/Loom`) — NOT the vault root.

The agent Reads the emitted path verbatim, with zero derivation of its own, instead of reconstructing it from memory and mis-spelling the vault root, or assuming a filename that isn't this project's actual convention. Both failure modes were observed in practice: a hand-written prompt line AND a generic derivation formula each independently drifted from the real file on disk when a project's resume doc used a non-default name.

## Do not

- Do not have the agent derive or reconstruct its own resume-doc path (from memory, or from a generic vault-root + default-filename formula) — Read the daemon-resolved absolute path the prompt already hands it, verbatim.
- Do not give the manager's context block and any other resume-doc consumer (e.g. `ResumeDocWatcher`) two independent path-resolution formulas — both must call the same `resolveResumeDocPath`, or they can silently diverge on a project with a non-default `resumeDocFilename`.

## Source

JSDoc comment above `composeManagerStartupPrompt` in `packages/daemon/src/sessions/manager-prompt.ts`: originally lines 19-27, as of this tranche's HEAD. Introduced by commit `7b26153e2cde8e544b0b44c177b2c496326b4cec` (`feat(orchestration): make the daemon-resolved manager resume-doc path the single source of truth`). Relocated by card `4c6a1edf` ("manager-prompt.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into a flowing paragraph.

This card is ALSO cited in `packages/daemon/src/sessions/resume-doc-notes.ts` (the `resolveResumeDocPath` function's own doc comment) — no lane was open on that file this tranche; a future tranche there extends this record with a new section rather than a second file.
