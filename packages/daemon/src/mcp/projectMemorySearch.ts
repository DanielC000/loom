import type { ProjectMemoryEntry } from "@loom/shared";

// Cross-project project_memory search (card 9fe04d18) — the `agent_prompt_search` (promptSearch.ts)
// sibling for the HIGHER-circulation surface: a memory note reaches every session whose kickoff
// matches it (workers included), where an agent prompt only reaches whoever holds that agent. Closes
// the same raw-sqlite-forensics gap agent_prompt_search closed for prompts — "has this defect/phrasing
// propagated into other projects' memory stores" — which today only `memory_list` (loom-tasks) answers,
// and only for the CALLER's own project.
//
// Mirrors searchAgentPrompts' contract deliberately: case-insensitive LITERAL substring, pure/no I/O
// (callers supply the already-loaded {project, notes} pairs), bounded with an explicit `truncated`
// flag. Two departures, both load-bearing per the card's triage history (see its DoD):
//  (1) matches against BOTH `title` and `text` (agent prompts have no titled/text split);
//  (2) collects EVERY match before capping, then orders by `retrievalCount` DESCENDING — a phrase
//      census here is a triage tool, not a clearance, and the corrective finding on this very card
//      (a carrier sitting unread inside an already-enumerated probe's own hit set) showed that ordering
//      alone does not fix the failure that mattered (selectively skipping a probe's hits) but IS still
//      useful for "where does the eye land" / severity — so it's kept, but as the SUPPORTING half, not
//      the load-bearing one. The load-bearing half is simply returning every hit inline with its
//      snippet in ONE result, same as agent_prompt_search already does, so there is no per-probe
//      "go read this set" round-trip to be skipped in the first place.
//
// `retrievalCount:0` is measured-ambiguous (see project-memory-recall.ts / the card's own triage): it
// cannot distinguish a note that has NEVER matched a kickoff from one that keeps matching and keeps
// losing the delivery-budget race. This module doesn't try to disambiguate it — callers (platform.ts)
// surface that caveat once, in the result envelope, rather than repeating it per hit.

/** Backstop cap on a default `project_memory_search` read — same posture as DEFAULT_PROMPT_SEARCH_CAP. */
export const DEFAULT_MEMORY_SEARCH_CAP = 50;

/** Hard ceiling on an explicit `limit` — a fat-fingered value can't force an unbounded scan result. */
export const MAX_MEMORY_SEARCH_CAP = 200;

export interface ProjectMemorySearchHit {
  projectId: string;
  projectName: string;
  key: string;
  title: string;
  pinned: boolean;
  /** Raw counter — bumped only on actual kickoff-digest inclusion (see ProjectMemoryEntry's own doc
   *  comment). `0` is AMBIGUOUS: never-matched and matched-then-evicted both read as `0` — see this
   *  module's own doc comment and the envelope-level caveat platform.ts attaches alongside every result. */
  retrievalCount: number;
  /** `retrievalCount > 0` — the same derived fact `memory_list`/`memory_read` expose, kept here so a
   *  reader doesn't have to re-derive it, but it carries the SAME ambiguity as the raw count above. */
  everDelivered: boolean;
  lastRetrievedAt: string | null;
  /** A short excerpt around the first match in `title` (or `text`, whichever the match falls in) — not
   *  the full note body (`memory_list`/`memory_read` already cover reading one note in full). Wider than
   *  `agent_prompt_search`'s own snippet radius: a carrier's danger here turns on whether the matched
   *  phrase is load-bearing for a COMPARISON or a decision (measured false-positive rate 7:1 on a bare
   *  phrase match, per the card's own triage) — a reader needs enough surrounding text to judge that,
   *  not just confirm the substring exists. */
  snippet: string;
}

/** One project's memory notes, projected down to just what the search + result shaping need. */
export interface MemorySearchProject {
  id: string;
  name: string;
  notes: ProjectMemoryEntry[];
}

/** A short, whitespace-collapsed excerpt centered on one match, with ellipsis markers when truncated.
 *  Radius is wider than promptSearch's own 80 — see {@link ProjectMemorySearchHit.snippet}'s doc comment. */
function snippetAround(text: string, matchIndex: number, matchLen: number, radius = 150): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLen + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * Case-insensitive LITERAL substring search over every note's `title`+`text` across the given projects.
 * Pure/no I/O, mirroring `searchAgentPrompts`' own shape so this stays independently testable without a
 * live Db. Unlike `searchAgentPrompts` (which stops as soon as `limit` hits are found, in caller-supplied
 * iteration order), this collects EVERY match first, then orders by `retrievalCount` DESCENDING before
 * capping — see the module doc comment for why the ordering step needs the full match set, not just the
 * first `limit` in project/note iteration order. `truncated:true` when the full match count exceeds
 * `limit`, so a capped result is self-evidently partial.
 */
export function searchProjectMemory(
  projects: MemorySearchProject[],
  query: string,
  limit: number,
): { hits: ProjectMemorySearchHit[]; truncated: boolean; totalMatches: number } {
  const needle = query.toLowerCase();
  const matches: ProjectMemorySearchHit[] = [];
  for (const project of projects) {
    for (const note of project.notes) {
      const haystack = `${note.title}\n${note.text}`;
      const idx = haystack.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      matches.push({
        projectId: project.id,
        projectName: project.name,
        key: note.key,
        title: note.title,
        pinned: note.pinned,
        retrievalCount: note.retrievalCount,
        everDelivered: note.retrievalCount > 0,
        lastRetrievedAt: note.lastRetrievedAt,
        snippet: snippetAround(haystack, idx, query.length),
      });
    }
  }
  // retrievalCount DESCENDING (supporting, not load-bearing — see module doc); a stable, deterministic
  // tie-break on `key` so two equal-count hits don't reorder between calls.
  matches.sort((a, b) => b.retrievalCount - a.retrievalCount || a.key.localeCompare(b.key));
  const truncated = matches.length > limit;
  return { hits: matches.slice(0, limit), truncated, totalMatches: matches.length };
}
