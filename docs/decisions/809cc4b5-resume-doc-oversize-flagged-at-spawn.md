# 809cc4b5 — an oversized resume doc is flagged at MANAGER spawn, mirroring the mid-session watcher

## Narrative

A manager's resume doc grew past the harness `Read` tool's cap and broke a successor's cold Read. `composeManagerStartupPrompt` now checks `resumeDocSizeWarning` (`sessions/resume-doc-notes.ts` — the SAME check the Platform Lead's resume doc already had) at spawn/recycle time too: if the resolved doc is already oversized, its `[loom:resume-doc-size]` note is prepended AHEAD of the "Where things live" pointer block — mirroring `composePlatformLeadStartupPrompt`'s ordering, so a cold-booting successor sees "rotate this" before it's told where to read the doc.

This only covers the spawn/recycle moment. The mid-session case — a doc that grows oversized while its manager stays live, never recycling — is covered separately by `ResumeDocWatcher` (`orchestration/resume-doc-watcher.ts`), which resolves the SAME path via the SAME `resolveResumeDocPath` — one source of truth for both call sites, so the two checks can never disagree on which file they mean.

## Do not

- Do not add a second, spawn-time-only size check or path-resolution formula — reuse `resumeDocSizeWarning` + `resolveResumeDocPath` so the spawn-time check and `ResumeDocWatcher`'s mid-session check stay a single source of truth.
- Do not reorder the size-warning note behind the "Where things live" pointer block — a cold-booting successor must see "rotate this" before it's told where to read the (oversized) doc.

## Source

JSDoc comment above `composeManagerStartupPrompt` in `packages/daemon/src/sessions/manager-prompt.ts`: originally lines 29-37, as of this tranche's HEAD. Introduced by commit `427b3dc82152ee3f2f17a28704dfacaeead6b0d1` (`fix(orchestration): enforce a hard resume-doc size budget with a proactive auto-rotate nudge before the Read cap`). Relocated by card `4c6a1edf` ("manager-prompt.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into a flowing paragraph.

This card is ALSO cited in `packages/daemon/src/sessions/resume-doc-notes.ts` (`RESUME_DOC_WARN_BYTES`'s own doc comment) — no lane was open on that file this tranche; a future tranche there extends this record with a new section rather than a second file.
