<!-- title: 14f14d92 — resume-doc boot snapshot + Platform Lead filename lookup -->

# 14f14d92 — resume-doc boot snapshot + Platform Lead filename lookup

Source: card 14f14d92. No prior out-of-band record existed for this id before this extraction.

## The incident

The orchestrator resume doc is load-bearing — it's injected into every manager spawn, and
`rotation-check.ts` guards it with marker/floor checks — but until this card, nothing ever backed
it up. `rotation-check.ts` only *verifies* an archive a caller claims to have written
(`fs.statSync` on a caller-supplied path); it never writes one itself.

On 2026-09-05, the Platform Lead truncated its own resume doc to 0 bytes and survived only because
the doc's text was still live in the agent's context — a recycled or restarted seat would have
lost it outright, with no backup anywhere to recover from.

## The fix

`resume-doc-snapshot.ts` takes a best-effort, non-blocking snapshot of every project's resolved
resume doc at daemon boot, before any agent can spawn or resume and touch it, into a sibling
`<name>.archive/auto-<ISO>.md`. It is deliberately a *snapshot*, not a rotation: it copies (never
moves) the active doc, and only ever touches the `auto-`-prefixed files it wrote itself when
pruning old snapshots — so it can never collide with, overwrite, or prune a real rotation archive
an agent wrote by hand. It also refuses to write an empty or partial snapshot over a good prior
one (skip-missing / skip-empty), since doing so would turn this exact fix into the data-loss mode
it exists to prevent.

## Decision: the Platform Lead resume doc needs its own filename lookup

A project's primary resume doc is found via `resolveResumeDocPath`, honoring that project's
`orchestration.resumeDocFilename` override — the same resolution `composeManagerStartupPrompt`/
`ResumeDocWatcher` already use. That lookup alone was never going to snapshot the file the
2026-09-05 incident actually happened to: the Platform Lead's own resume doc(s) don't live under
that per-project filename scheme. They live directly in the reserved "Loom Platform" project's
vault dir (`vaultPath === LOOM_HOME`, `LOOM_DEV`-gated) as `PLATFORM-LEAD-RESUME.md` and any
per-lineage sibling `PLATFORM-LEAD-RESUME-<lineageId>.md`.

Rather than hand-roll a second regex for that filename shape, `findPlatformLeadResumeDocs`
enumerates a home dir via the exact same `isResumeDocFilename` pattern
`platform-lead-prompt.ts` already uses for its own staleness detection, so the two can never
silently drift apart. This makes the boot sweep a no-op (empty list) for every ordinary project —
none of them contain a file matching the pattern — while covering the one project the 2026-09-05
incident was actually about.
