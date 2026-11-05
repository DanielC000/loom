# 7c74acd8 — the kickoff project-memory digest: lead-truncated non-floor notes, and a task-focused related-tier query

Part of the wordiness epic 8c7a0abd. Source: `packages/daemon/src/sessions/project-memory-recall.ts`.

## What was established (code, 2026-11-05)

- The digest has two parts. The **pinned** part is NOT selected by relevance: never-drop (floor) notes pack first against the full `budgetTokens`, ordinary pinned notes rotate least-recently-delivered first; the only relevance input is the cited-by-key reorder (`packCitedRestPrefix`). The **related** part is the FTS5 match of the kickoff text against unpinned notes (`db.searchProjectMemory`).
- At `memory.budgetTokens` 25000 / `topK` 50 (`packages/shared/src/config.ts`) the budget no longer binds on this project, so the digest size is whatever the pinned set plus the FTS hits come to.
- **The related query was not "the whole kickoff".** For a worker it is `opts.kickoffPrompt` (the manager's text, not the agent brief). `tokenizeForProjectMemoryFts` keeps only the first 32 word tokens of 3+ chars, with NO stopword filter, ORed. So filler words ("the", "not", "and") spent the cap and matched nearly every note, and the DoD / later text never reached the query.
- Measured on a 730-note export of this store (the `memory_list` output), unpinned note text: p25 2518, median 3140, p90 3877 chars; the 8 floor notes ~1900.

## What changed

- **B — lead truncation.** A non-floor note over `DIGEST_NOTE_TRUNCATE_OVER_CHARS` (1500) renders as whole paragraphs from the start until 500 chars (hard cut 900) plus `[… N more chars omitted — memory_read <key> for the full note]`. The floor renders unchanged; a note the kickoff cites by key renders in full; the `[v#, date]` stamp and annotations are unchanged. Stored notes are never edited.
- **C — recall query.** `buildRecallQuery(kickoff, taskTitle)`: task title first, then the kickoff's `TASK:` section (up to a `STANDING`/`CONSTRAINTS` line), stopwords dropped before the 32-token cap. No `TASK:` section and no title ⇒ the whole kickoff, today's behaviour. The source label (`title+task-section` / `task-section` / `title+kickoff` / `kickoff`) is logged; no content. Only `spawnWorker` passes a title today; resume, fork, recycle and startNew keep the kickoff-only path.
- The shared tokenizer (also behind near-duplicate detection) is untouched.

## Do not

- Do not apply lead truncation to a never-drop note: the floor is a delivery guarantee and renders in full.
- Do not truncate a note the kickoff cites by key: the reader asked for that one.
- Do not edit or delete a stored note to shrink the digest; selection and rendering only.
- Do not put the stopword filter into `tokenizeForProjectMemoryFts`: near-duplicate coverage shares it.
- Do not read the standing-constraints cut as a content filter. It is a heuristic on the manager's kickoff shape and falls back to the whole text when it does not find a `TASK:` line.
- Do not change `budgetTokens`, `topK` or the floor from this record: they are owner decisions (request `d2b3e43f`).

## Measured effect (hermetic replay, no real DB)

Fixture = the 730 notes as returned by `memory_list`, loaded into a temp-home Db; the real compiled `composeProjectMemoryDigest`; before = raw kickoff query + full notes, after = `buildRecallQuery` + lead truncation; `budgetTokens` 25000. Three representative kickoffs (docs, gate, UI), each with a standing-constraints block. At `topK` 8, which is the related count the live kickoff showed: total digest chars 43994/45206/50035 → 26516/26427/26336; related chars 26103/27315/32144 → 8625/8536/8445; pinned 17891 unchanged. At `topK` 50: 100363/99677/101736 → 69671/70266/71026.
