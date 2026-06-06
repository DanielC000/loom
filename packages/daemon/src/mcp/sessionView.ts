import type { SessionListItem } from "@loom/shared";

// Shared MCP-layer projection for the cross-project session list tools (audit list_sessions +
// platform list_all_sessions). This is a PRESENTATION projection only — it never touches the db
// query semantics; the same enriched SessionListItem[] is fetched, then thinned here.

/**
 * The lightweight session row the list tools return by DEFAULT — a compact projection that keeps
 * just what's needed to triage + address a session (its id, project, agent, lifecycle state, and
 * context meters) and DROPS the heavy/verbose fields (title, cwd, engineSessionId, branch, worktree
 * path, lineage ids, errors, rate-limit bookkeeping). Mirrors tasks_list's TaskSummary: a full list
 * of dozens of enriched session rows was a 300K+ blob, so a default list read here stays bounded.
 * Callers that need a whole record opt in with full:true (or read one transcript via transcript_read).
 */
export type SessionSummary = Pick<
  SessionListItem,
  | "id" | "projectId" | "projectName" | "agentName" | "role" | "processState"
  | "busy" | "archivedAt" | "createdAt" | "lastActivity" | "model"
  | "ctxInputTokens" | "ctxTurns"
>;

/** Project ONE enriched session row down to its summary. Optional fields normalise to null. */
export const toSessionSummary = (s: SessionListItem): SessionSummary => ({
  id: s.id,
  projectId: s.projectId,
  projectName: s.projectName,
  agentName: s.agentName,
  role: s.role ?? null,
  processState: s.processState,
  busy: s.busy,
  archivedAt: s.archivedAt ?? null,
  createdAt: s.createdAt,
  lastActivity: s.lastActivity,
  model: s.model ?? null,
  ctxInputTokens: s.ctxInputTokens ?? null,
  ctxTurns: s.ctxTurns ?? null,
});

/**
 * Apply the shared MCP-layer list shape to an already-fetched, already-filtered session list:
 * optional offset/limit pagination, then summary projection unless full:true. Pure — no db access.
 */
export function projectSessionList(
  rows: SessionListItem[],
  opts: { full?: boolean; limit?: number; offset?: number } = {},
): SessionListItem[] | SessionSummary[] {
  let page = rows;
  if (opts.offset !== undefined) page = page.slice(opts.offset);
  if (opts.limit !== undefined) page = page.slice(0, opts.limit);
  return opts.full ? page : page.map(toSessionSummary);
}
