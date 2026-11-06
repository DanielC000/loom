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

## Amendment 2026-11-06 (card 204366ea): the never-drop floor guarantees reachability, not full-body delivery

This SUPERSEDES the first "Do not" above (a never-drop note "renders in full"). Measured on the 736-note export of this project (hermetic replay through the real `retrieveProjectMemoryForKickoff`, temp-home Db): the 8 floor notes were 15,365 chars of body, and the memory section was 16.7k chars at the platform-default 4000-token budget (only 5 of the 9 pinned notes fit, so 3 floor notes were dropped under the ALARM) and ~31.6k at 10000+ tokens, of which ~5k was backlink/mention annotation lines. The digest does not depend on the session role, so a role-scoped pin would need a new note field and a role argument at every call site; it was not built.

- A never-drop note now renders as its header, ONE rule line and a `memory_read` pointer (`floorRuleLine`, `FLOOR_RULE_MAX_CHARS` = 240): the first `>` blockquote line, else the first non-empty line that is not a provenance stamp (`**v<n>`, `**Est.`, `**Established`, bare date) or a heading. An `OWNER DIRECTIVE` line is content. The 8 notes went 15,365 → ~3,500 chars, so all fit even at 4000 tokens. A floor note the kickoff cites by key still renders in full.
- Inbound-backlink, unresolved-outbound-link and auto-detected-mention lines are no longer injected at all (`annotateNote` returns only the linked-Request live state). `memory_read`/`memory_list` still return `backlinks` and `unresolvedOutboundLinks`; mentions had no read surface and are no longer shown anywhere.
- Measured after, same fixture: memory section 13.0-13.8k chars at both 4000 and 10000 tokens (was 16.0-17.0k and 31.3-32.4k), all 9 pinned notes delivered at both.

### Do not (2)

- Do not read "never-drop" as "the body is in the kickoff": it guarantees title + rule line + key. The first line of a floor note must therefore be the rule; a provenance-first note delivers a weaker line.
- Do not re-add backlink/mention/unresolved-link lines to the injected digest without re-measuring; they were ~16% of the section.
- Do not drop the linked-Request annotation from the digest (decision e6d270b3).
