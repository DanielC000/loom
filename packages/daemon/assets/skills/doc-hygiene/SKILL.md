---
name: doc-hygiene
description: Apply whenever writing or editing documentation, notes, or knowledge files (vault notes, READMEs, design/architecture docs, changelogs). Enforces rewrite-in-place over append, no contradictions, and bounded docs. Shipped and kept current by Loom.
---

# doc-hygiene

Rules to apply on **every** documentation edit. Docs are a living source of truth, not an append-only log. A reader should be able to trust that what a doc says now is what is true now.

## Rules

1. **No contradictions.** A document must not assert two things that cannot both be true. Before adding a statement, scan the surrounding doc for anything it conflicts with and reconcile them in the same edit.

2. **Rewrite in place — never append "UPDATE:" notes.** When information becomes outdated, debunked, or false, **edit the original sentence/section to be correct**. Do not leave the stale text and bolt on "UPDATE:", "EDIT:", "Note (2026):", "~~struck-through~~ now actually…", or a trailing correction. Replace the wrong content with the right content as if it had always been right. (Git history preserves what changed — the doc itself should read clean.)

3. **Tidy loose ends.** Resolve dangling references, half-finished sentences, TODOs that are now done, and links to things that moved or were deleted. If a section is now empty or redundant, remove it.

4. **Keep docs bounded.** Don't let a doc grow without limit. Prefer revising existing sections to adding new ones. Consolidate duplicated explanations into one canonical place and link to it. Length should track the size of the subject, not the number of times it was touched.

## How to apply

- **Editing an existing doc:** read the whole relevant section first, fold new information into it, and delete what the new information supersedes. The diff should show the doc moving from one correct state to another — not accreting.
- **Status/decision claims:** only state something is "done", "fixed", "verified", or "decided" if it is actually true right now; if you're changing a prior claim, overwrite it, don't annotate it.
- **When unsure whether old content is still true:** verify before deleting; if it contradicts current reality, surface that rather than silently keeping both versions.
