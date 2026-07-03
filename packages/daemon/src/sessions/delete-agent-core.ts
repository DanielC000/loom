import type { Db } from "../db.js";
import { deleteArchivedTranscript } from "./transcript.js";

/**
 * PERMANENTLY delete an agent by id — the shared core reused by the human REST DELETE
 * /api/agents/:id handler (gateway/server.ts), the Platform Lead's agent_delete tool
 * (mcp/platform.ts), and SessionService.deleteAgentAsManager. 404 ("agent not found") if unknown;
 * refuses while any of the agent's sessions is still LIVE ("stop the fleet first",
 * db.countLiveSessionsForAgent); else cascades db.deleteAgent and best-effort drops each deleted
 * session's transcript snapshot. Takes `db` directly (not a SessionService) so every call site —
 * including REST, which never depended on SessionService — can call it with what it already has.
 * Callers layer their own guards (requireOwnProject, auditManage) around this; the core itself
 * does no authorization.
 */
export function deleteAgentCore(db: Db, agentId: string): { deleted: true; agentId: string; sessions: number } {
  const agent = db.getAgent(agentId);
  if (!agent) throw new Error("agent not found");
  const live = db.countLiveSessionsForAgent(agentId);
  if (live > 0) throw new Error(`cannot delete an agent with live sessions — stop the fleet first (${live} still live)`);
  const { sessionIds } = db.deleteAgent(agentId);
  for (const sid of sessionIds) deleteArchivedTranscript(agent.projectId, sid); // best-effort snapshot cleanup
  return { deleted: true, agentId, sessions: sessionIds.length };
}
