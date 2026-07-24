import type { Agent } from "@loom/shared";

// Cross-project agent-prompt search (card 80b7a33b) — the third of the Lead's raw-sqlite-forensics
// gaps: hunting a stale/renamed reference (a project name, a tool, a skill) across every agent's
// startupPrompt in the fleet. `db.listAgents(projectId)` already returns the full row incl.
// startupPrompt, so no new storage/indexing is needed here — this is a pure substring scan, the exact
// sibling of `lintStalePrompts` (projects/prompt-lint.ts), which already scans every agent's
// startupPrompt for ONE project reactively, on that project's own rename write. This generalizes the
// same idea to an ad-hoc, cross-project, caller-driven query.

/** Backstop cap on a default `agent_prompt_search` read — bounds the result payload the same way
 *  {@link DEFAULT_AGENT_SUMMARY_CAP} bounds `list_all_agents`. */
export const DEFAULT_PROMPT_SEARCH_CAP = 50;

/** Hard ceiling on an explicit `limit` — a fat-fingered value can't force an unbounded scan result. */
export const MAX_PROMPT_SEARCH_CAP = 200;

export interface AgentPromptSearchHit {
  agentId: string;
  projectId: string;
  projectName: string;
  agentName: string;
  /** A short excerpt around the first match — not the full prompt (agent_get already covers reading
   *  one agent's whole startupPrompt; a search result is for triage, not a bulk prompt dump). */
  snippet: string;
}

/** One project's agents, projected down to just what the search + result shaping need. */
export interface PromptSearchProject {
  id: string;
  name: string;
  agents: Array<Pick<Agent, "id" | "name" | "startupPrompt">>;
}

/** A short, whitespace-collapsed excerpt centered on one match, with ellipsis markers when truncated. */
function snippetAround(text: string, matchIndex: number, matchLen: number, radius = 80): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLen + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

/**
 * Case-insensitive LITERAL substring search over every agent's startupPrompt across the given projects.
 * Pure/no I/O — callers supply the already-loaded {project, agents} pairs (mirrors `lintStalePrompts`'s
 * own pure-function shape), so this stays independently testable without a live Db. Stops as soon as
 * `limit` hits are found (project/agent iteration order — insertion order from the caller), reporting
 * `truncated:true` so a capped result is self-evidently partial rather than "that's everything".
 */
export function searchAgentPrompts(
  projects: PromptSearchProject[],
  query: string,
  limit: number,
): { hits: AgentPromptSearchHit[]; truncated: boolean } {
  const needle = query.toLowerCase();
  const hits: AgentPromptSearchHit[] = [];
  let truncated = false;
  outer:
  for (const project of projects) {
    for (const agent of project.agents) {
      const prompt = agent.startupPrompt || "";
      if (!prompt) continue;
      const idx = prompt.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      if (hits.length >= limit) { truncated = true; break outer; }
      hits.push({
        agentId: agent.id,
        projectId: project.id,
        projectName: project.name,
        agentName: agent.name,
        snippet: snippetAround(prompt, idx, query.length),
      });
    }
  }
  return { hits, truncated };
}
