# 9fe04d18 — `searchProjectMemory` returns every hit inline; ordering is supporting, not load-bearing

## Narrative

`searchProjectMemory` (`packages/daemon/src/mcp/projectMemorySearch.ts`) is the
`agent_prompt_search` (promptSearch.ts) sibling for the HIGHER-circulation surface: a memory note
reaches every session whose kickoff matches it (workers included), where an agent prompt only
reaches whoever holds that agent. It closes the same raw-sqlite-forensics gap `agent_prompt_search`
closed for prompts — "has this defect/phrasing propagated into other projects' memory stores" —
which today only `memory_list` (loom-tasks) answers, and only for the caller's own project.

It mirrors `searchAgentPrompts`' contract deliberately: case-insensitive LITERAL substring,
pure/no I/O (callers supply the already-loaded `{project, notes}` pairs), bounded with an explicit
`truncated` flag. Two departures are both load-bearing per the card's own triage history: (1) it
matches against BOTH `title` and `text` (agent prompts have no titled/text split); (2) it collects
EVERY match before capping, then orders by `retrievalCount` DESCENDING.

Why (2) is shaped this way: a phrase census here is a triage tool, not a clearance, and the
corrective finding on this very card (a carrier sitting unread inside an already-enumerated
probe's own hit set) showed that ordering alone does not fix the failure that mattered
(selectively skipping a probe's hits) but IS still useful for "where does the eye land" /
severity — so it's kept, but as the SUPPORTING half, not the load-bearing one. The load-bearing
half is simply returning every hit inline with its snippet in ONE result, same as
`agent_prompt_search` already does, so there is no per-probe "go read this set" round-trip to be
skipped in the first place.

## Do not

- Do not replace "collect every match, return every hit inline in one result" with a per-probe
  paginated or round-trip design — that reopens exactly the failure the corrective finding behind
  this card exists to prevent: a probe's own hits going selectively unread.
- Do not treat `retrievalCount`-DESCENDING ordering as sufficient triage protection by itself; it
  is the supporting half, never a substitute for returning every hit.

## Source

`packages/daemon/src/mcp/projectMemorySearch.ts`, module doc comment — originally lines 3-26,
introduced whole by commit `ed78be3cd`. The `@decision 9fe04d18` anchor now sits at the removed
site (inside departure (2)); the surrounding purpose/contract description and the
`retrievalCount:0` ambiguity paragraph stay inline at the same site, unchanged.
