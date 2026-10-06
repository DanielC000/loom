import { useQuery } from "@tanstack/react-query";
import type { AgentListItem } from "@loom/shared";
import { api } from "./api";

// The god-eye cross-project agent list, from the bulk GET /api/agents endpoint — ONE round-trip, shared
// by Schedules/EventTriggers' target pickers, Settings' poll-job picker (each previously ran its own
// client N+1: api.projects() then Promise.all(projects.map(p => api.agents(p.id))), ~26 sequential
// round-trips on mount) and the Profiles editor's grant-reach confirm.
//
// @decision 3c4e0df6 — ONE owner per react-query key: ["allAgents"] holds the RAW rows, and a consumer
// wanting another shape derives it with `select`. A second queryFn PROJECTING this key serves its
// reduced shape to every other consumer from cache — a successful load of the wrong thing, never an error.

/** The ONE fetcher behind the `["allAgents"]` cache. Shared by both hooks below so the key can never be
 *  populated with two different shapes depending on which page mounted first. */
const ALL_AGENTS_QUERY = { queryKey: ["allAgents"] as const, queryFn: api.allAgents };

/**
 * Every agent across every project, RAW — each row carries `profileId`, `projectId` and `projectName`.
 *
 * ⚠️ Callers deciding anything on the ABSENCE of a row (e.g. "no agent is bound to this profile") must
 * gate on `isSuccess`, never on `data` being truthy: an unresolved or failed fetch is NOT an answer, and
 * collapsing it into an empty list is how a privilege check silently passes. See lib/profileGrantReach.
 */
export function useAllAgents() {
  return useQuery(ALL_AGENTS_QUERY);
}

/**
 * The same list projected to flat "Project / Agent" labels, for a target picker.
 *
 * `select` runs PER OBSERVER and never writes back to the cache, so this shares one fetch with
 * `useAllAgents` while leaving the cached rows raw for everyone else.
 */
export function useAllAgentLabels() {
  return useQuery({
    ...ALL_AGENTS_QUERY,
    select: (agents: AgentListItem[]) => agents.map((a) => ({ id: a.id, label: `${a.projectName} / ${a.name}` })),
  });
}
