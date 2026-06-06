import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { useAttention } from "../lib/attention";
import { useState } from "react";
import { Panel, SectionLabel, Badge, Button } from "../components/ui";
import { color, font } from "../theme";
import { Stat, PlanUsageStrip, AttentionRow, FleetRow, FleetCard, EventRow } from "../components/fleet";

// Phase 3 — MISSION CONTROL: a god-eye view of every orchestration at once, so you don't have to
// pick a single manager. Three regions: a global status strip, an ATTENTION QUEUE (shared with the
// shell bell via useAttention), and FLEET (projects → managers → workers) beside a global ACTIVITY
// feed. All derived from existing endpoints (/api/sessions + per-manager events). The fleet widgets
// (FleetCard/FleetRow/PlanUsageStrip/…) live in components/fleet so the project-scoped Overview can
// compose the same surface against a project-filtered session set.

export default function MissionControl() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 2000 });
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 2000 });
  const { items: attention } = useAttention();

  const all = sessions.data ?? [];
  const managers = all.filter((s) => s.role === "manager");
  const workers = all.filter((s) => s.role === "worker");
  const globalPaused = (status.data?.pausedScopes ?? []).includes("global");

  // Each manager's event timeline → the activity feed.
  const eventQueries = useQueries({
    queries: managers.map((m) => ({
      queryKey: ["orchEvents", m.id],
      queryFn: () => api.orchestrationEvents(m.id),
      refetchInterval: 3000,
    })),
  });
  const allEvents = eventQueries
    .flatMap((q) => (q.data as OrchestrationEvent[] | undefined) ?? [])
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts));

  // Order projects by recent activity: each project ranks by its most-recent-active member across
  // any of its managers/workers, most-recent first — so the project you're actively driving floats
  // up. (Same project-tier behaviour as before, now via the shared mostRecentActivity util.)
  const sessionsByProject = new Map<string, SessionListItem[]>();
  for (const s of [...managers, ...workers])
    (sessionsByProject.get(s.projectName) ?? sessionsByProject.set(s.projectName, []).get(s.projectName)!).push(s);
  const projectNames = [...sessionsByProject.keys()]
    .sort((a, b) => mostRecentActivity(sessionsByProject.get(b)!) - mostRecentActivity(sessionsByProject.get(a)!));

  // Per-project Fleet card mode: small fixed-size summary by default; a card expands to the full
  // managers→workers view. State holds the EXPANDED project names (empty = all small). Persisted to
  // localStorage so the expanded set survives a reload (cheap, best-effort).
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("mc.fleetExpanded") ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const toggleExpanded = (pn: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(pn) ? next.delete(pn) : next.add(pn);
    try { localStorage.setItem("mc.fleetExpanded", JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  // Attention items resolved to their owning project (via the item's session id) → a per-project
  // "needs a human" count for the small summary cards. Reuses the already-derived attention queue.
  const attnByProject = new Map<string, number>();
  for (const item of attention) {
    const s = item.workerSessionId ? all.find((x) => x.id === item.workerSessionId) : undefined;
    if (s) attnByProject.set(s.projectName, (attnByProject.get(s.projectName) ?? 0) + 1);
  }

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ["orchStatus"] });
  const refreshSessions = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const pause = useMutation({ mutationFn: () => api.pauseOrchestration(), onSuccess: refreshStatus });
  const resume = useMutation({ mutationFn: () => api.resumeOrchestration(), onSuccess: refreshStatus });
  const kill = useMutation({ mutationFn: () => api.killOrchestration(), onSuccess: () => { refreshStatus(); refreshSessions(); } });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Plan-usage strip — the user's REAL Claude account headroom (5h / 7d), distinct from the
          per-session context occupancy on the /usage page. */}
      <PlanUsageStrip />

      {/* Global status strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <Badge tone={globalPaused ? "red" : "phosphor"}>{globalPaused ? "orchestration: paused" : "orchestration: running"}</Badge>
        <div style={{ display: "flex", gap: 10 }}>
          <Stat label="projects" value={projectNames.length} />
          <Stat label="managers" value={managers.length} />
          <Stat label="workers" value={workers.length} />
          <Stat label="attention" value={attention.length} tone={attention.length ? "amber" : "muted"} />
        </div>
        <span style={{ flex: 1 }} />
        <ClearUsageHoldButton onCleared={refreshSessions} />
        <Button variant="default" disabled={pause.isPending} onClick={() => pause.mutate()}>Pause</Button>
        <Button variant="default" disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</Button>
        <Button variant="danger" disabled={kill.isPending} onClick={() => kill.mutate()}>Kill all</Button>
      </div>

      {/* Attention queue */}
      <div>
        <SectionLabel>Attention queue ({attention.length})</SectionLabel>
        {attention.length === 0 && <Panel><span style={{ color: color.textMuted }}>Nothing needs you right now.</span></Panel>}
        {attention.map((item) => (
          <AttentionRow key={item.key} item={item}
            onOpen={item.workerSessionId ? () => navigate(`/review/${item.workerSessionId}`) : undefined} />
        ))}
      </div>

      {/* Fleet + activity */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16 }}>
        <div>
          <SectionLabel>Fleet</SectionLabel>
          {projectNames.length === 0 && <Panel><span style={{ color: color.textMuted }}>No active sessions.</span></Panel>}
          {/* Small summary cards flow in a multi-column grid; an expanded card spans the full width
              (gridColumn 1/-1) and renders the full managers→workers view, identical to before. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, alignItems: "start" }}>
            {projectNames.map((pn) => {
              // Within a project: managers ordered by activity; each manager's workers ordered by
              // activity under it (hierarchy intact); orphan workers ordered among themselves.
              const projManagers = managers.filter((m) => m.projectName === pn).sort(bySessionActivity);
              const projWorkers = workers.filter((w) => w.projectName === pn);
              const looseWorkers = projWorkers
                .filter((w) => !projManagers.some((m) => m.id === w.parentSessionId))
                .sort(bySessionActivity);

              if (!expanded.has(pn)) {
                return (
                  <FleetCard key={pn} name={pn} managers={projManagers} workers={projWorkers}
                    attention={attnByProject.get(pn) ?? 0} onExpand={() => toggleExpanded(pn)} />
                );
              }
              return (
                <Panel key={pn} style={{ gridColumn: "1 / -1" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{pn}</span>
                    <span style={{ flex: 1 }} />
                    <Button variant="ghost" style={{ padding: "0 6px" }} title="Collapse" onClick={() => toggleExpanded(pn)}>⤡</Button>
                  </div>
                  {projManagers.map((m) => (
                    <div key={m.id} style={{ marginBottom: 8 }}>
                      <FleetRow s={m} star />
                      {workers.filter((w) => w.parentSessionId === m.id).sort(bySessionActivity).map((w) => (
                        <div key={w.id} style={{ paddingLeft: 16 }}><FleetRow s={w} /></div>
                      ))}
                    </div>
                  ))}
                  {looseWorkers.map((w) => <FleetRow key={w.id} s={w} />)}
                  {projManagers.length === 0 && looseWorkers.length === 0 && (
                    <span style={{ color: color.textMuted, fontSize: 12 }}>idle — no live manager</span>
                  )}
                </Panel>
              );
            })}
          </div>
        </div>

        <div>
          <SectionLabel>Activity</SectionLabel>
          <Panel grid style={{ maxHeight: "62vh", overflow: "auto" }}>
            {allEvents.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
            {allEvents.slice(0, 100).map((e) => <EventRow key={e.id} e={e} />)}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// Global usage-hold override: drop the awareness latch (~/.loom/tmp/claude-usage.json) so new
// worker_spawn is unblocked WITHOUT touching any session — for a transient overload with real
// headroom (the plan-usage strip above shows the real account figures). HUMAN-only; mirrors the
// per-session "clear rate limit" but global. Shows a transient "✓ unblocked" on success; alerts on error.
function ClearUsageHoldButton({ onCleared }: { onCleared: () => void }) {
  const [done, setDone] = useState(false);
  const clear = useMutation({
    mutationFn: () => api.clearUsageHold(),
    onSuccess: () => { setDone(true); onCleared(); window.setTimeout(() => setDone(false), 4000); },
    onError: (e) => window.alert((e as Error).message),
  });
  return (
    <Button variant="default" disabled={clear.isPending}
      title="Clear the GLOBAL usage hold (the worker_spawn block) without touching any session — for a transient overload"
      onClick={() => clear.mutate()}>
      {done ? "✓ hold cleared" : clear.isPending ? "Clearing…" : "Clear usage hold"}
    </Button>
  );
}
