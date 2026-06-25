import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, SessionListItem } from "@loom/shared";
import { api } from "./api";
import { mostRecentActivity } from "./sessions";

// One persisted "active project" that scopes the detail pages (Board / Git / Vault / Orchestration),
// woven into the App header. Backed by localStorage under the EXISTING `loom.projectId` key, so
// Workspace's prior selection seeds it for free. Mission Control + Terminals stay god-eye and ignore it.
const STORAGE_KEY = "loom.projectId";

interface ActiveProjectValue {
  /** The resolved active project id ("" only when there are no projects). Scopes the detail pages. */
  projectId: string;
  /** Persist a new active project (writes localStorage). */
  setProjectId: (id: string) => void;
  /** Non-archived work projects, for the header selector (reserved homes excluded — see `home`). */
  projects: Project[];
  /**
   * The reserved "Platform" home (where the Workspace Auditor + Platform operator file cards), if the
   * daemon seeds one. `api.projects()` excludes reserved projects, so this is folded in SEPARATELY and
   * surfaced in the picker as the pinned home — NOT mixed into `projects` as an ordinary work project.
   * Selecting it is valid (resolves like any project) so the project-scoped pages (Board / Git / …)
   * point at its board. null when no reserved home exists.
   */
  home: Project | null;
}

const Ctx = createContext<ActiveProjectValue | null>(null);

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [storedId, setStoredId] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? "");

  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  // Shared cache with the pages that already poll this; used only to pick a fallback when the stored
  // project no longer resolves, so a one-time read suffices (no refetchInterval of our own here).
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  // The reserved "Platform" home — folded into the picker since `api.projects()` excludes reserved
  // projects. The endpoint 404s when no home exists (an expected state), so we swallow that to null
  // rather than thrash the query into an error state. Same shared cache key the Platform page uses.
  const setupHomeQ = useQuery({
    queryKey: ["setupHome"],
    queryFn: async () => {
      try { return await api.setupHome(); } catch { return null; }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const home = setupHomeQ.data?.project ?? null;

  const setProjectId = useCallback((id: string) => {
    setStoredId(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const active = useMemo(() => (projectsQ.data ?? []).filter((p) => !p.archivedAt), [projectsQ.data]);

  // Resolve the effective project. While projects load, trust the stored value (no flicker). Once
  // loaded: keep the stored id if it still resolves (a work project OR the reserved home); otherwise
  // gracefully fall back to the most-recently-active WORK project (then the first) so the app never
  // renders empty. The home is opt-in: it's only ever active when the user explicitly selected it —
  // never an auto-fallback target.
  const projectId = useMemo(() => {
    if (!projectsQ.data) return storedId;
    if (storedId && (active.some((p) => p.id === storedId) || storedId === home?.id)) return storedId;
    // The home query may still be in flight — don't fall back yet if the stored id might BE the home
    // (avoids a one-frame flicker to a work project before the home resolves).
    if (storedId && setupHomeQ.isPending) return storedId;
    const byProject = new Map<string, SessionListItem[]>();
    for (const s of sessionsQ.data ?? []) {
      const list = byProject.get(s.projectId) ?? [];
      list.push(s);
      byProject.set(s.projectId, list);
    }
    let best = "";
    let bestTs = -Infinity;
    for (const p of active) {
      const ts = mostRecentActivity(byProject.get(p.id) ?? []);
      if (ts > bestTs) { bestTs = ts; best = p.id; }
    }
    return best || active[0]?.id || "";
  }, [storedId, projectsQ.data, active, sessionsQ.data, home, setupHomeQ.isPending]);

  const value = useMemo<ActiveProjectValue>(
    () => ({ projectId, setProjectId, projects: active, home }),
    [projectId, setProjectId, active, home],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveProject(): ActiveProjectValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveProject must be used within ActiveProjectProvider");
  return v;
}
