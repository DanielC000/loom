# 58b0bb60 — `Project.noGateByDesign` suppresses the no-gate warning project-wide, not merely for one merge

## Narrative

A project can declare itself deliberately gateless (`noGateByDesign`) — vault/markdown/knowledge projects with no buildable code — to opt OUT of the "unverified: no gateCommand configured" warning entirely. An UNFLAGGED gateless project (or repo) still warns, so a genuinely missing gate stays surfaced rather than silently accepted. The flag's reach is project-WIDE: it suppresses the warning for the primary repo AND every registry entry, unchanged by the later, narrower per-entry `RepoRegistryEntry.noGateByDesign` flag (card `22629cb2`) that composes alongside it by OR — see that card's own record for how the two flags combine.

## Do not

- Do not assume a project's `noGateByDesign` only covers its primary repo — it suppresses the warning project-wide, across every registry entry too.
- Do not treat an unflagged gateless project/repo as intentionally silent — only the explicit flag opts out; anything else still warns.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`confirmWorkerMergeTracked`'s plain-GREEN return, the `gateWarning` derivation), as of this tranche's HEAD.
