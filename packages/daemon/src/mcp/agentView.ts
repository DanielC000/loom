import type { Agent } from "@loom/shared";

// Shared MCP-layer projection for the cross-project agent list tools (platform + setup
// `list_all_agents`). The exact sibling of sessionView.ts: a PRESENTATION projection only — it never
// touches the db query; the same Agent[] is fetched, then thinned + capped here so an aggregate read
// across every project can't overflow the tool-result token cap.

/**
 * The lightweight agent row `list_all_agents` returns by DEFAULT — a compact projection that keeps
 * just what's needed to orient/triage an agent (its id, project, name, board position, profile, and
 * endpoint flag) and DROPS the heavy/unbounded fields: the multi-KB `startupPrompt` (a full agent
 * brief) and the open-ended `ioSchema` blob. Mirrors SessionSummary / tasks_list's TaskSummary: an
 * un-projected aggregate of every project's agents overflowed at ~104K chars (PL Auditor finding #5),
 * so a default list read here stays bounded. Callers that need the full prompt opt in with full:true.
 */
export type AgentSummary = Pick<
  Agent,
  "id" | "projectId" | "name" | "position" | "profileId" | "endpoint"
>;

/** Project ONE agent row down to its summary (drops startupPrompt + ioSchema). profileId normalises to null. */
export const toAgentSummary = (a: Agent): AgentSummary => ({
  id: a.id,
  projectId: a.projectId,
  name: a.name,
  position: a.position,
  profileId: a.profileId ?? null,
  endpoint: a.endpoint,
});

/**
 * Backstop cap on a DEFAULT (summary) cross-project agent list so an aggregate read across every
 * project can't overflow the tool-result token cap with no explicit limit. Mirrors
 * {@link DEFAULT_SESSION_SUMMARY_CAP}. Sized BELOW the budget by measurement: a worst-case summary
 * row is ~250 chars, so 100 rows ≈ 25K chars — comfortably under the ~48K-char "safely under the
 * tool-result cap" figure the transcript pager uses (TRANSCRIPT_PAGE_CHAR_BUDGET), with headroom.
 * Agents (unlike sessions) have NO process lifecycle, so there is no exited/state exclusion here —
 * only this projection + cap. Callers opt past it with an explicit limit/offset; full:true is NOT capped.
 */
export const DEFAULT_AGENT_SUMMARY_CAP = 100;

/**
 * Apply the shared MCP-layer list shape to an already-fetched agent list: optional offset/limit
 * pagination, then summary projection unless full:true. Pure — no db access. Sibling of projectSessionList.
 */
export function projectAgentList(
  rows: Agent[],
  opts: { full?: boolean; limit?: number; offset?: number } = {},
): Agent[] | AgentSummary[] {
  let page = rows;
  if (opts.offset !== undefined) page = page.slice(opts.offset);
  if (opts.limit !== undefined) page = page.slice(0, opts.limit);
  return opts.full ? page : page.map(toAgentSummary);
}
