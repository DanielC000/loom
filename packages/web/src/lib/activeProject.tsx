import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project, SessionListItem } from "@loom/shared";
import { api } from "./api";
import { mostRecentActivity } from "./sessions";

// One persisted "active project" that scopes the detail pages (Overview / Board / Git / Vault),
// woven into the App header. Backed by localStorage under the EXISTING `loom.projectId` key, so
// Workspace's prior selection seeds it for free. Mission Control + Terminals stay god-eye and ignore it.
const STORAGE_KEY = "loom.projectId";

interface ActiveProjectValue {
  /** The resolved active project id ("" only when there are no projects). Scopes the detail pages. */
  projectId: string;
  /** Persist a new active project (writes localStorage). */
  setProjectId: (id: string) => void;
  /**
   * Non-archived work projects, for the header selector. Reserved homes (the "Platform" home) are
   * excluded by `api.projects()` and are NOT selectable here — that home is reached via the Platform
   * page, which renders its board directly.
   */
  projects: Project[];
}

const Ctx = createContext<ActiveProjectValue | null>(null);

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [storedId, setStoredId] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? "");

  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  // Shared cache with the pages that already poll this; used only to pick a fallback when the stored
  // project no longer resolves, so a one-time read suffices (no refetchInterval of our own here).
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });

  const setProjectId = useCallback((id: string) => {
    setStoredId(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const active = useMemo(() => (projectsQ.data ?? []).filter((p) => !p.archivedAt), [projectsQ.data]);

  // Resolve the effective project. While projects load, trust the stored value (no flicker). Once
  // loaded: keep the stored id if it still resolves to a work project; otherwise gracefully fall back
  // to the most-recently-active work project (then the first) so the app never renders empty. A stored
  // id that no longer resolves (e.g. an old reserved-home id) falls through to this fallback.
  const projectId = useMemo(() => {
    if (!projectsQ.data) return storedId;
    if (storedId && active.some((p) => p.id === storedId)) return storedId;
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
  }, [storedId, projectsQ.data, active, sessionsQ.data]);

  const value = useMemo<ActiveProjectValue>(
    () => ({ projectId, setProjectId, projects: active }),
    [projectId, setProjectId, active],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActiveProject(): ActiveProjectValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useActiveProject must be used within ActiveProjectProvider");
  return v;
}
