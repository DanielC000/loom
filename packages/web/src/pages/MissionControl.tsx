import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { useAttention, isRateLimited, type AttentionItem } from "../lib/attention";
import { Panel, SectionLabel, StatusPill, Badge, Chip, Meter, Button, Dot } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

// Phase 3 — MISSION CONTROL: a god-eye view of every orchestration at once, so you don't have to
// pick a single manager. Three regions: a global status strip, an ATTENTION QUEUE (shared with the
// shell bell via useAttention), and FLEET (projects → managers → workers) beside a global ACTIVITY
// feed. All derived from existing endpoints (/api/sessions + per-manager events).

function sessionStatus(s: SessionListItem): { tone: Tone; label: string; glow?: boolean } {
  if (isRateLimited(s)) return { tone: "red", label: "rate-limited" };
  if (s.processState !== "live") return { tone: "muted", label: s.processState };
  if (s.busy) return { tone: "amber", label: "busy", glow: true };
  return { tone: "phosphor", label: "idle" };
}

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

  // Order projects by recent activity: each project ranks by the most-recent lastActivity across
  // any of its managers/workers, most-recent first — so the project you're actively driving floats up.
  const recentByProject = new Map<string, number>();
  for (const s of [...managers, ...workers]) {
    const ts = +new Date(s.lastActivity);
    recentByProject.set(s.projectName, Math.max(recentByProject.get(s.projectName) ?? 0, ts));
  }
  const projectNames = [...recentByProject.keys()].sort((a, b) => recentByProject.get(b)! - recentByProject.get(a)!);

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ["orchStatus"] });
  const refreshSessions = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const pause = useMutation({ mutationFn: () => api.pauseOrchestration(), onSuccess: refreshStatus });
  const resume = useMutation({ mutationFn: () => api.resumeOrchestration(), onSuccess: refreshStatus });
  const kill = useMutation({ mutationFn: () => api.killOrchestration(), onSuccess: () => { refreshStatus(); refreshSessions(); } });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
          {projectNames.map((pn) => {
            const projManagers = managers.filter((m) => m.projectName === pn);
            const looseWorkers = workers.filter((w) => w.projectName === pn && !projManagers.some((m) => m.id === w.parentSessionId));
            return (
              <Panel key={pn} style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text, marginBottom: 8 }}>{pn}</div>
                {projManagers.map((m) => (
                  <div key={m.id} style={{ marginBottom: 8 }}>
                    <FleetRow s={m} star />
                    {workers.filter((w) => w.parentSessionId === m.id).map((w) => (
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

function Stat({ label, value, tone: t = "phosphor" }: { label: string; value: number; tone?: Tone }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", border: `1px solid ${color.border}`, borderRadius: 4, padding: "4px 12px", minWidth: 64 }}>
      <span style={{ fontFamily: font.mono, fontSize: 20, color: tone[t] }}>{value}</span>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>{label}</span>
    </span>
  );
}

function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 10px", marginBottom: 6 }}>
      <Dot tone={item.tone} glow={item.tone === "amber"} />
      <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[item.tone], textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{item.kind}</span>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis" }}>{item.text}</span>
      <span style={{ flex: 1 }} />
      {onOpen && <Button onClick={onOpen}>Open</Button>}
    </div>
  );
}

function FleetRow({ s, star }: { s: SessionListItem; star?: boolean }) {
  const st = sessionStatus(s);
  const ctx = s.ctxInputTokens ?? 0;
  const window = contextWindowForModel(s.model);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: star ? color.phosphor : color.text, fontWeight: star ? 700 : 400 }}>
        {star ? "★ " : ""}{star ? "mgr " : "w:"}{s.id.slice(0, 8)}
      </span>
      <StatusPill tone={st.tone} label={st.label} glow={st.glow} />
      {s.taskId && <Chip label="task" value={s.taskId.slice(0, 8)} />}
      {s.branch && <Chip label="branch" value={s.branch} tone="cyan" />}
      {ctx > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Meter value={ctx} max={window} tone={ctx > window * CONTEXT_WARN_RATIO ? "amber" : "phosphor"} width={60} />
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{(ctx / 1000).toFixed(1)}k</span>
        </span>
      )}
    </div>
  );
}

function EventRow({ e }: { e: OrchestrationEvent }) {
  return (
    <div style={{ display: "flex", gap: 8, fontFamily: font.mono, fontSize: 12, padding: "2px 0", borderBottom: `1px solid ${color.border}` }}>
      <span style={{ color: color.textMuted, whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleTimeString()}</span>
      <span style={{ color: color.cyan, whiteSpace: "nowrap" }}>{e.kind}</span>
      <span style={{ color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)}` : ""}{e.taskId ? ` t:${e.taskId.slice(0, 8)}` : ""}
      </span>
    </div>
  );
}
