# 809cc4b5 — an oversized resume doc is flagged at MANAGER spawn, mirroring the mid-session watcher

## Narrative

A manager's resume doc grew past the harness `Read` tool's cap and broke a successor's cold Read. `composeManagerStartupPrompt` now checks `resumeDocSizeWarning` (`sessions/resume-doc-notes.ts` — the SAME check the Platform Lead's resume doc already had) at spawn/recycle time too: if the resolved doc is already oversized, its `[loom:resume-doc-size]` note is prepended AHEAD of the "Where things live" pointer block — mirroring `composePlatformLeadStartupPrompt`'s ordering, so a cold-booting successor sees "rotate this" before it's told where to read the doc.

This only covers the spawn/recycle moment. The mid-session case — a doc that grows oversized while its manager stays live, never recycling — is covered separately by `ResumeDocWatcher` (`orchestration/resume-doc-watcher.ts`), which resolves the SAME path via the SAME `resolveResumeDocPath` — one source of truth for both call sites, so the two checks can never disagree on which file they mean.

## The `ResumeDocWatcher` site: simpler than its structural twins, by design

`ResumeDocWatcher` is a structural twin of `ContextWatcher`/`IdleWatcher`, but SIMPLER on purpose: unlike
context occupancy (which only grows within a session and needs an explicit recycle to reset), a resume
doc's size is SELF-CLEARING — the moment a manager rotates it (the nudge's own ask), the file shrinks
back under threshold and the very next tick naturally stops nudging. There is no "acknowledged" state to
survive a restart, so the cooldown is a plain IN-MEMORY `Map`, not a persisted DB column: a daemon
restart just clears it, and the worst case is one extra nudge on the next tick if the doc is still
oversized — never a correctness issue, and deliberately cheaper than `ContextWatcher`'s persisted
escalation state.

## Do not

- Do not add a second, spawn-time-only size check or path-resolution formula — reuse `resumeDocSizeWarning` + `resolveResumeDocPath` so the spawn-time check and `ResumeDocWatcher`'s mid-session check stay a single source of truth.
- Do not reorder the size-warning note behind the "Where things live" pointer block — a cold-booting successor must see "rotate this" before it's told where to read the (oversized) doc.
- Do not persist the `ResumeDocWatcher` cooldown to a DB column — it is deliberately a plain in-memory `Map`; the doc's size is self-clearing, so a restart clearing the cooldown costs at most one extra nudge, never a correctness issue.

## Source

JSDoc comment above `composeManagerStartupPrompt` in `packages/daemon/src/sessions/manager-prompt.ts`: originally lines 29-37, as of this tranche's HEAD. Introduced by commit `427b3dc82152ee3f2f17a28704dfacaeead6b0d1` (`fix(orchestration): enforce a hard resume-doc size budget with a proactive auto-rotate nudge before the Read cap`). Relocated by card `4c6a1edf` ("manager-prompt.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into a flowing paragraph.

This card is ALSO cited in `packages/daemon/src/sessions/resume-doc-notes.ts` (`RESUME_DOC_WARN_BYTES`'s own doc comment) — no lane was open on that file this tranche; a future tranche there extends this record with a new section rather than a second file.

The "`ResumeDocWatcher` site" section above: class docstring above `ResumeDocWatcher` in
`packages/daemon/src/orchestration/resume-doc-watcher.ts`, originally lines 36-42, as of this tranche's
HEAD. No wording changed; `*`-prefixed lines joined into a flowing paragraph. The rest of that
docstring (what the watcher does, why it exists relative to the spawn-time check, and the
bounded/never-throw guarantee) is Class C/A and stays inline, verbatim, at that file.
