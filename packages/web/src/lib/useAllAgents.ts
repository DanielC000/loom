import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

// Flat "Project / Agent" label list, god-eye across every project — shared by Schedules/EventTriggers'
// target pickers and Settings' poll-job picker (previously each ran its own client N+1: api.projects()
// then Promise.all(projects.map(p => api.agents(p.id))), ~26 sequential round-trips on mount). Backed
// by the bulk GET /api/agents endpoint, ONE round-trip.
export function useAllAgents() {
  return useQuery({
    queryKey: ["allAgents"],
    queryFn: async () => {
      const agents = await api.allAgents();
      return agents.map((a) => ({ id: a.id, label: `${a.projectName} / ${a.name}` }));
    },
  });
}
