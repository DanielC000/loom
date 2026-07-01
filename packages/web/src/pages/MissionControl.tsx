import { useNavigate } from "react-router-dom";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { useAttention, attentionOpenTarget, dismissAttention } from "../lib/attention";
import { useState } from "react";
import { Panel, SectionLabel, Badge, Button } from "../components/ui";
import { color, font } from "../theme";
import { Stat, PlanUsageStrip, AttentionRow, FleetRow, FleetCard, EventRow, WaveConsumption } from "../components/fleet";
import { archivedOnlyProjects, ARCHIVED_ONLY_CAP, type ArchivedOnlyProject } from "../lib/fleet";
import { ReviewQueue } from "../components/reviewQueue";
import { AuditReplayPanel } from "../components/auditReplay";

// Attention severity ranking — surfaces the REVIEW/decision bottleneck at the top of the queue. Merge
// requests already live in the dedicated Review queue above; among the rest, a needed human DECISION or a
// stalled manager (red, blocking the wave) outranks the recoverable amber states (rate-limit/stuck). The
// parallel ceiling is human review, so what needs a human first must read first.
const ATTN_RANK: Record<string, number> = {
  "NEEDS A HUMAN": 0,
  "MANAGER ASLEEP": 1,
  "CONTEXT OVERFLOW": 2,
  "CRASH-LOOPED": 3,
  "RATE-LIMITED": 4,
  "STUCK-BUSY": 5,
  "QUEUE DRAINED": 6,
};
const attnRank = (kind: string, tone: string) => ATTN_RANK[kind] ?? (tone === "red" ? 3.5 : 7);

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
  // Archived (now-exited) sessions across all projects, newest-archived first — the live feed above
  // EXCLUDES archived rows, and sessions auto-archive on exit, so past runs only live here. Used to
  // restore history access to Run Replay (a god-eye view of LIVE orchestration otherwise loses every
  // finished wave). Polled lazily (15s) — archived rows don't change second-to-second.
  const archived = useQuery({ queryKey: ["allArchivedSessions"], queryFn: api.allArchivedSessions, refetchInterval: 15000 });
  const { items: attention } = useAttention();

  const all = sessions.data ?? [];
  const managers = all.filter((s) => s.role === "manager");
  const workers = all.filter((s) => s.role === "worker");
  const globalPaused = (status.data?.pausedScopes ?? []).includes("global");

  // Pending merges are the review/merge gate's queue — pulled OUT of the generic attention list into
  // the dedicated Review queue centerpiece below (so they aren't shown twice). Verification is the
  // bottleneck, so these diffs-awaiting-a-decision sit at the top of the page.
  const reviewWorkerIds = attention.filter((i) => i.kind === "MERGE REQUEST" && i.workerSessionId).map((i) => i.workerSessionId!);
  const otherAttention = attention
    .filter((i) => i.kind !== "MERGE REQUEST")
    .sort((a, b) => attnRank(a.kind, a.tone) - attnRank(b.kind, b.tone));

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

  // Fully-archived projects — those present ONLY in the archived set (all their sessions have exited, so
  // they're absent from the live `projectNames` above). MC builds its fleet from the RUNNING set, so these
  // finished waves would otherwise drop off the god-eye entirely. Derived O(n) (a live-name Set + one pass
  // over the archive; see lib/fleet.ts) and rendered as MUTED cards BELOW the live fleet, so live projects
  // always rank first and archived history can never crowd the active fleet.
  const archivedOnly = archivedOnlyProjects(projectNames, archived.data ?? []);

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
    const sid = item.sessionId ?? item.workerSessionId;
    const s = sid ? all.find((x) => x.id === sid) : undefined;
    if (s) attnByProject.set(s.projectName, (attnByProject.get(s.projectName) ?? 0) + 1);
  }

  // Replay roots: every manager you can replay — LIVE managers first (the wave you're driving, ordered
  // live-then-recency), then the ARCHIVED managers of past/exited runs (newest-archived first, as the
  // feed already returns them). Since sessions auto-archive on exit, a finished run's manager is gone
  // from the live feed and lives only in `archived` — without this merge the panel would show only the
  // current wave and "replay any past run too" (above) would be a lie. Dedup by id, live row wins.
  const liveManagerIds = new Set(managers.map((m) => m.id));
  const archivedManagers = (archived.data ?? []).filter((s) => s.role === "manager" && !liveManagerIds.has(s.id));
  const replayRoots: SessionListItem[] = [
    ...[...managers].sort((a, b) => {
      const liveA = a.processState === "live" ? 1 : 0, liveB = b.processState === "live" ? 1 : 0;
      if (liveA !== liveB) return liveB - liveA;
      return mostRecentActivity([b]) - mostRecentActivity([a]);
    }),
    ...archivedManagers,
  ];

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
        {/* These counts derive from the LIVE session feed (api.allSessions excludes archived rows, and
            sessions auto-archive on exit), so they read ACTIVE orchestration only — labelled as such so
            the number reads as correct-scope, not broken. Finished runs stay reachable via Run Replay. */}
        <div style={{ display: "flex", gap: 10 }}>
          <Stat label="active projects" value={projectNames.length} />
          <Stat label="active managers" value={managers.length} />
          <Stat label="active workers" value={workers.length} />
          <Stat label="attention" value={attention.length} tone={attention.length ? "amber" : "muted"} />
        </div>
        <span style={{ flex: 1 }} />
        <ClearUsageHoldButton onCleared={refreshSessions} />
        <Button variant="default" disabled={pause.isPending} onClick={() => pause.mutate()}>Pause</Button>
        <Button variant="default" disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</Button>
        <Button variant="danger" disabled={kill.isPending} onClick={() => kill.mutate()}>Kill all</Button>
      </div>

      {/* Review queue — the merge gate as the fast-triage centerpiece (this card's surface). Shown
          above the generic attention queue because diff verification is the orchestration bottleneck. */}
      {reviewWorkerIds.length > 0 && <ReviewQueue workerIds={reviewWorkerIds} />}

      {/* Attention queue — everything else needing a human (merge requests live in the Review queue). */}
      <div>
        <SectionLabel>Attention queue ({otherAttention.length})</SectionLabel>
        {otherAttention.length === 0 && <Panel><span style={{ color: color.textMuted }}>Nothing needs you right now.</span></Panel>}
        {otherAttention.map((item) => (
          <AttentionRow key={item.key} item={item}
            onOpen={(() => { const t = attentionOpenTarget(item); return t ? () => navigate(t) : undefined; })()}
            onDismiss={item.dismissKey ? () => dismissAttention(item.dismissKey!) : undefined} />
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
              // This project's archived (exited) sessions — folded into the compact card as muted history
              // so it doesn't go blank the moment the wave auto-archives.
              const projArchived = (archived.data ?? []).filter((s) => s.projectName === pn);
              const looseWorkers = projWorkers
                .filter((w) => !projManagers.some((m) => m.id === w.parentSessionId))
                .sort(bySessionActivity);

              if (!expanded.has(pn)) {
                return (
                  <FleetCard key={pn} name={pn} managers={projManagers} workers={projWorkers} archived={projArchived}
                    attention={attnByProject.get(pn) ?? 0} onExpand={() => toggleExpanded(pn)} />
                );
              }
              return (
                <Panel key={pn} style={{ gridColumn: "1 / -1" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{pn}</span>
                    <span style={{ flex: 1 }} />
                    <WaveConsumption sessions={[...projManagers, ...projWorkers]} />
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

          {/* Fully-archived projects — finished waves with zero live sessions, kept glanceable as MUTED
              cards. Rendered AFTER the live grid (live always ranks first) and collapsed behind a small
              affordance + capped, so they never crowd the active fleet. */}
          <ArchivedOnlyFleet projects={archivedOnly} />
        </div>

        <div>
          <SectionLabel>Activity</SectionLabel>
          <Panel grid style={{ maxHeight: "62vh", overflow: "auto" }}>
            {allEvents.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
            {allEvents.slice(0, 100).map((e) => <EventRow key={e.id} e={e} />)}
          </Panel>
        </div>
      </div>

      {/* Wave replay — scrub a wave/session's durable audit timeline + diff it against another run. The
          observability surface for "what actually happened" once a wave is several agents deep. Roots are
          managers, live first then by recency, so the default subject is the wave you're driving now. */}
      <AuditReplayPanel managers={replayRoots} />
    </div>
  );
}

// Fully-archived projects strip — the finished-wave tier of the fleet. Every project here has zero live
// sessions (present only in the archive), so MC's running-derived fleet would drop it entirely; we surface
// each as a MUTED FleetCard so past waves stay glanceable. Kept OUT of the way per the owner's constraint:
// collapsed behind a "N archived project(s)" affordance (closed by default) AND, once open, capped at
// ARCHIVED_ONLY_CAP cards (the affordance still reports the true total) so archived history can never crowd
// the active fleet above it.
function ArchivedOnlyFleet({ projects }: { projects: ArchivedOnlyProject[] }) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;
  const shown = projects.slice(0, ARCHIVED_ONLY_CAP);
  const overflow = projects.length - shown.length;
  return (
    <div style={{ marginTop: 12 }}>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide fully-archived projects" : "Show fully-archived projects"}
        style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, padding: "2px 6px" }}>
        {open ? "▾" : "▸"} {projects.length} archived project{projects.length === 1 ? "" : "s"}
      </Button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, alignItems: "start", marginTop: 8 }}>
          {shown.map((p) => (
            <FleetCard key={p.name} name={p.name} managers={[]} workers={[]} archived={p.archived}
              attention={0} onExpand={() => { /* no live sessions to expand into */ }} muted />
          ))}
          {overflow > 0 && (
            <span style={{ alignSelf: "center", fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
              +{overflow} more archived
            </span>
          )}
        </div>
      )}
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
