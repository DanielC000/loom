import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { useAttention, isRateLimited, type AttentionItem } from "../lib/attention";
import { useState } from "react";
import { Panel, SectionLabel, StatusPill, Badge, Chip, Meter, Button, Dot } from "../components/ui";
import { color, font, radius, tone, type Tone } from "../theme";

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

// ── Fleet summary (small mode) ─────────────────────────────────────────────────
// A FIXED-SIZE per-project card: a roll-up status, manager/worker counts, a worker-state
// composition bar, worst-case context pressure, and a hint of the busiest manager. Expands to the
// full FleetRow list. Same component kit + tokens as the rest of the page (no new color/chart deps).

// Roll-up status — worst-of across the project's sessions: rate-limited > busy > idle > no-live-mgr.
function fleetRollup(sessions: SessionListItem[]): { tone: Tone; label: string; glow?: boolean } {
  if (sessions.some(isRateLimited)) return { tone: "red", label: "rate-limited" };
  if (sessions.some((s) => s.processState === "live" && s.busy)) return { tone: "amber", label: "busy", glow: true };
  if (sessions.some((s) => s.role === "manager" && s.processState === "live")) return { tone: "phosphor", label: "idle" };
  return { tone: "muted", label: "no live manager" };
}

// Worker-state tally for the composition bar — each worker lands in exactly one bucket.
function workerBuckets(workers: SessionListItem[]) {
  let busy = 0, idle = 0, rl = 0, offline = 0;
  for (const w of workers) {
    if (isRateLimited(w)) rl++;
    else if (w.processState !== "live") offline++;
    else if (w.busy) busy++;
    else idle++;
  }
  return { busy, idle, rl, offline, total: workers.length };
}

// Worst-case context occupancy across the fleet (the session closest to its window) — the figure
// that signals "someone needs recycling soon". 0/0 when no session reports ctx.
function worstContext(sessions: SessionListItem[]): { ctx: number; window: number; ratio: number } {
  let ctx = 0, window = 0, ratio = 0;
  for (const s of sessions) {
    const c = s.ctxInputTokens ?? 0;
    if (c <= 0) continue;
    const w = contextWindowForModel(s.model);
    const r = c / w;
    if (r > ratio) { ratio = r; ctx = c; window = w; }
  }
  return { ctx, window, ratio };
}

const SEG_TONE = { busy: "amber", idle: "phosphor", rl: "red", offline: "muted" } as const;

// Stacked horizontal bar of worker states (flex-weighted by count). Degrades cleanly: 0 workers →
// an empty track; 1 worker → a single full segment.
function CompBar({ buckets }: { buckets: ReturnType<typeof workerBuckets> }) {
  const segs = ([["busy", buckets.busy], ["idle", buckets.idle], ["rl", buckets.rl], ["offline", buckets.offline]] as const)
    .filter(([, n]) => n > 0);
  return (
    <div style={{ display: "flex", height: 8, width: "100%", borderRadius: radius.sm, overflow: "hidden", background: color.border }}>
      {segs.map(([key, n]) => (
        <div key={key} title={`${key} ${n}`} style={{ flexGrow: n, flexBasis: 0, background: tone[SEG_TONE[key]] }} />
      ))}
    </div>
  );
}

function FleetCard({ name, managers, workers, attention, onExpand }: {
  name: string;
  managers: SessionListItem[]; // activity-sorted by the caller
  workers: SessionListItem[];
  attention: number;
  onExpand: () => void;
}) {
  const sessions = [...managers, ...workers];
  const roll = fleetRollup(sessions);
  const buckets = workerBuckets(workers);
  const wc = worstContext(sessions);
  const ctxHot = wc.ratio > CONTEXT_WARN_RATIO;
  const topMgr = managers[0];
  const topSt = topMgr ? sessionStatus(topMgr) : null;

  return (
    <Panel style={{ height: 188, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
      {/* header: roll-up dot + name + expand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot tone={roll.tone} glow={roll.glow} />
        <span style={{ fontFamily: font.head, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "0 6px" }} title="Expand" onClick={onExpand}>⤢</Button>
      </div>

      {/* status + counts */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusPill tone={roll.tone} label={roll.label} glow={roll.glow} />
        <span style={{ flex: 1 }} />
        <Chip label="mgr" value={managers.length} />
        <Chip label="wkr" value={workers.length} />
        {attention > 0 && <Chip label="attn" value={attention} tone="red" />}
      </div>

      {/* worker-state composition bar + legend */}
      <CompBar buckets={buckets} />
      <div style={{ display: "flex", gap: 10, fontFamily: font.mono, fontSize: 10 }}>
        <span style={{ color: color.amber }}>busy {buckets.busy}</span>
        <span style={{ color: color.phosphor }}>idle {buckets.idle}</span>
        {buckets.rl > 0 && <span style={{ color: color.red }}>rl {buckets.rl}</span>}
        {buckets.offline > 0 && <span style={{ color: color.textMuted }}>off {buckets.offline}</span>}
        {buckets.total === 0 && <span style={{ color: color.textMuted }}>no workers</span>}
      </div>

      {/* worst-case context pressure */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, width: 28 }}>ctx</span>
        <Meter value={wc.ctx} max={wc.window || 1} tone={ctxHot ? "amber" : "phosphor"} width={110} />
        <span style={{ fontFamily: font.mono, fontSize: 10, color: ctxHot ? color.amber : color.textMuted }}>
          {wc.ctx > 0 ? `${Math.round(wc.ratio * 100)}%` : "—"}
        </span>
      </div>

      {/* busiest / most-recent manager hint */}
      <div style={{ marginTop: "auto", fontFamily: font.mono, fontSize: 11, color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {topMgr && topSt
          ? <>★ mgr {topMgr.id.slice(0, 8)} · <span style={{ color: tone[topSt.tone] }}>{topSt.label}</span></>
          : <span style={{ color: color.textMuted }}>no live manager</span>}
      </div>
    </Panel>
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
