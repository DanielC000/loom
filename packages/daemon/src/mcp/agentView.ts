import type { Agent, AgentListItem } from "@loom/shared";
import { pickFields } from "./entityRowFields.js";

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
 * COMPILE-TIME TOTALITY for the full:true path (card b6e3493f). `projectAgentList` below used to
 * return `full:true` rows unprojected — an OPT-OUT shape that ships every column on an `Agent` row (and
 * anything a future caller enriches it with) straight to the wire. Sentinelled against `AgentListItem`
 * (id + every `Agent` field + `projectName`), NOT bare `Agent`: `projectAgentList`'s own `rows: Agent[]`
 * parameter structurally accepts an `AgentListItem[]` too (it's a subtype), and `db.listAllAgents():
 * AgentListItem[]` already exists — so a `keyof Agent`-only sentinel would silently drop `projectName`
 * the moment any future caller passes it through, with no build error and no test failure to catch it.
 * Every CURRENT caller (platform.ts / setup.ts `list_all_agents`) passes plain `Agent[]` (from
 * `db.listAgents`), so `projectName` comes back `undefined` today — and every caller's response goes
 * through this router's `ok()` envelope (`JSON.stringify`), which drops an undefined-valued key
 * entirely, so the wire payload for today's callers is byte-identical to the prior raw-row shape.
 */
const AGENT_LIST_FIELDS: Record<keyof AgentListItem, 1> = {
  id: 1, projectId: 1, name: 1, startupPrompt: 1, position: 1, profileId: 1,
  endpoint: 1, ioSchema: 1, projectName: 1,
};
const AGENT_LIST_KEYS = Object.keys(AGENT_LIST_FIELDS) as (keyof AgentListItem)[];

/** Project ONE agent row to the full (non-summary) shape `full:true` returns. See AGENT_LIST_FIELDS. */
const toFullAgentRow = (a: Agent): AgentListItem => pickFields(a as AgentListItem, AGENT_LIST_KEYS);

/**
 * Apply the shared MCP-layer list shape to an already-fetched agent list: optional offset/limit
 * pagination, then summary projection unless full:true. Pure — no db access. Sibling of projectSessionList.
 */
export function projectAgentList(
  rows: Agent[],
  opts: { full?: boolean; limit?: number; offset?: number } = {},
): AgentListItem[] | AgentSummary[] {
  let page = rows;
  if (opts.offset !== undefined) page = page.slice(opts.offset);
  if (opts.limit !== undefined) page = page.slice(0, opts.limit);
  return opts.full ? page.map(toFullAgentRow) : page.map(toAgentSummary);
}
