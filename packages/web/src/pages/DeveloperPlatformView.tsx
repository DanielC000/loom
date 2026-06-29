import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, SessionRole, Schedule } from "@loom/shared";
import { api } from "../lib/api";
import Board from "./Board";
import { PlatformSessionTile } from "../components/PlatformSessionTile";
import { AgentPromptEditor } from "../components/AgentPromptEditor";
import { RunHistory } from "../components/RunHistory";
import { Panel, Button, Input, SectionLabel, StatusPill, Badge } from "../components/ui";
import { color, font } from "../theme";

// Platform Manager P6 — the DEV-edition Platform surface (the "Loom Platform" home), rendered by the
// consolidated Platform page when the reserved "Loom Platform" project exists (LOOM_DEV). SEPARATE from
// the project picker: the reserved "Loom Platform" project is hidden from the ordinary project list (GET
// /api/projects excludes reserved); this view is its only surface. It shows + controls:
//   1. the Platform Lead + Auditor agents, with human spawn/stop controls + live status,
//   2. the live platform sessions (Lead/Auditor terminals),
//   3. the Platform board — the Auditor findings + manager escalations backlog (reused Board),
//   4. the Auditor's schedule (kind:"auditor") cadence controls.
// Everything here reuses EXISTING REST: discovery is read-only (api.platformHome); spawn = startSession
// (role platform/auditor), stop = stopSession, cadence = createSchedule. No new write/elevated surface.
export function DeveloperPlatformView() {
  const home = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome });
  // Profiles resolve each agent's role (platform=Lead, auditor=Auditor) — the human spawn role + chip.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });

  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Platform home…</p>;
  if (home.isError || !home.data) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>No reserved “Loom Platform” project found — the platform layer may not be seeded yet.</p>;
  }
  const { project, agents } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // Classify by the bound profile's role, falling back to the seeded names if a profile is missing.
  const lead = agents.find((a) => roleOf(a) === "platform") ?? agents.find((a) => a.name === "Platform Lead");
  const auditor = agents.find((a) => roleOf(a) === "auditor") ?? agents.find((a) => a.name === "Platform Auditor");

  // Live sessions belonging to the reserved project (the platform sessions), newest first.
  const platformSessions = (sessions.data ?? [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveFor = (agentId?: string) =>
    agentId ? platformSessions.find((s) => s.agentId === agentId && s.processState === "live") : undefined;
  const liveCountFor = (agentId?: string) =>
    agentId ? platformSessions.filter((s) => s.agentId === agentId && s.processState === "live").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Platform
          <Badge tone="cyan">{project.name}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            the management layer above all projects · hidden from the project picker
          </span>
        </SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "4px 0 0", fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
          The Platform Lead is the always-available, human-driven operator above all projects; the Auditor is the
          scheduled, read-and-file-only transcript reviewer. Spawning either is a human go-live action — you may run
          several Leads concurrently (they coordinate via the board). Findings + manager escalations land on the
          board below for you to triage.
        </p>
      </div>

      {/* --- 1. Agent go-live controls (Lead + Auditor) --- */}
      <section>
        <SectionLabel>Agents</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          <AgentControl agent={lead} role="platform" session={liveFor(lead?.id)} liveCount={liveCountFor(lead?.id)} missingLabel="Platform Lead agent not seeded" />
          <AgentControl agent={auditor} role="auditor" session={liveFor(auditor?.id)} liveCount={liveCountFor(auditor?.id)} missingLabel="Platform Auditor agent not seeded" />
        </div>
      </section>

      {/* --- 2. Live platform sessions (the Lead/Auditor terminals) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Sessions
          <span style={{ color: color.textMuted, fontWeight: 400 }}>({platformSessions.filter((s) => s.processState === "live").length} live)</span>
        </SectionLabel>
        <PlatformSessions sessions={platformSessions} />
      </section>

      {/* --- 4. Auditor cadence (kind:"auditor" schedules) --- */}
      <section>
        <SectionLabel>Auditor schedule</SectionLabel>
        <AuditorSchedules auditorId={auditor?.id} />
      </section>

      {/* --- 5a. Lead history — every Lead RUN (role:"platform" session), newest-first, live+exited+archived.
              Collapsed by default (history runs long; tuck it away until the human wants it). --- */}
      <CollapsibleHistory title="Lead history"
        hint="every Lead run — when it ran, context cost, duration; expand to read the transcript">
        <RunHistory reservedProjectId={project.id} sessions={platformSessions} role="platform"
          emptyLabel="No Lead runs yet — the Platform Lead hasn’t run." />
      </CollapsibleHistory>

      {/* --- 5b. Auditor history — every audit RUN (auditor session), newest-first, live+exited+archived.
              Collapsed by default (same as Lead history). --- */}
      <CollapsibleHistory title="Auditor history"
        hint="every audit run — trigger, context cost, findings filed; expand to read the transcript">
        <RunHistory reservedProjectId={project.id} sessions={platformSessions} role="auditor"
          emptyLabel="No audit runs yet — the Auditor hasn’t run." showFindings />
      </CollapsibleHistory>

      {/* --- 3. The Platform board — findings + escalations backlog (reused Board component) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Board
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            Auditor findings + manager escalations — triage by dragging cards
          </span>
        </SectionLabel>
        <Board projectId={project.id} />
      </section>
    </div>
  );
}

// A history section that's collapsed by default — the Lead/Auditor run logs get long, so tuck them
// away until the human asks. Reuses the AgentPromptEditor disclosure idiom (▾/▸ chevron, phosphor when
// open) fused with SectionLabel's header typography, so the affordance reads identically to the rest of
// the cockpit. Session-only state (a reload re-collapses — acceptable; persistence is optional here).
function CollapsibleHistory({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
          padding: 0, margin: "4px 0 8px", cursor: "pointer", textAlign: "left", width: "100%" }}>
        <span aria-hidden style={{ color: open ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 12, width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
          {title}
        </span>
        <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
          {hint}
        </span>
      </button>
      {open && children}
    </section>
  );
}

// One agent's go-live card: live status + a spawn button and a stop button (graceful, when live). Spawn
// role is the agent's platform role — "platform" (Lead) spawns the human-equivalent operator; "auditor"
// spawns the read-and-file-only Auditor. Both are HUMAN-only REST. The Lead is NOT a singleton: its Spawn
// button stays enabled while a Lead is live, so the human can mint additional concurrent Leads (they
// coordinate via the board). The Auditor keeps its disabled-while-live gate unchanged.
function AgentControl({ agent, role, session, liveCount, missingLabel }:
  { agent?: Agent; role: "platform" | "auditor"; session?: SessionListItem; liveCount: number; missingLabel: string }) {
  const qc = useQueryClient();
  const spawn = useMutation({
    mutationFn: () => api.startSession(agent!.id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const roleLabel = role === "platform" ? "Lead" : "Auditor";
  const isPlatform = role === "platform";

  if (!agent) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>{missingLabel}</span></Panel>;
  }
  const live = session?.processState === "live";
  // Platform Lead: never gated on live (multiple concurrent Leads allowed). Auditor: keep the create-only
  // UX where Spawn is disabled while a run is live.
  const spawnDisabled = spawn.isPending || (!isPlatform && live);
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={role === "platform" ? "phosphor" : "cyan"}>{roleLabel}</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {isPlatform && liveCount > 0 && (
          <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 11 }}>{liveCount} live</span>
        )}
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={spawnDisabled}
          title={isPlatform
            ? (live ? `Spawn another ${roleLabel} — multiple may run concurrently` : `Spawn the ${roleLabel} (human go-live)`)
            : (live ? `${roleLabel} is already live` : `Spawn the ${roleLabel} (human go-live)`)}
          onClick={() => spawn.mutate()}>
          {spawn.isPending ? "Spawning…" : isPlatform ? `Spawn ${roleLabel}` : live ? "Live" : `Spawn ${roleLabel}`}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
      {/* View / edit this reserved-home agent's startup prompt (the spawn kickoff). */}
      <AgentPromptEditor key={`prompt-${agent.id}`} agent={agent} homeKey={["platformHome"]} />
    </Panel>
  );
}

// The live platform-session terminals (Lead/Auditor), tiled with a graceful-stop + maximize control.
// Dead/exited rows are dropped (the live set only) — mirrors the Terminals grid, scoped to the reserved
// project. Each tile is the shared PlatformSessionTile (status + PresetPrompts + Stop + maximize, NO
// Fork — these are elevated platform sessions, so forking is withheld to avoid minting an unaudited
// elevated session off-screen; spawn fresh Leads from the Agents controls above instead). Multiple live
// Leads may be tiled here at once.
function PlatformSessions({ sessions }: { sessions: SessionListItem[] }) {
  const live = sessions.filter((s) => s.processState === "live");
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>No platform sessions running. Spawn the Lead or Auditor above.</p>;
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 };
  return (
    <div style={grid}>
      {live.map((s) => <PlatformSessionTile key={s.id} session={s} height={440} />)}
    </div>
  );
}

// Cheap client-side cron gate (the daemon does the real parse + 400s anything it can't compute).
function looksLikeCron(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && t.split(/\s+/).length === 5;
}
function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

// The Auditor's cadence: list its kind:"auditor" schedules (enable/disable + delete) and add a new one.
// A fired auditor schedule boots the Platform Auditor (startAuditor, role locked server-side). Reuses
// the existing schedule REST — createSchedule passes kind:"auditor" so the Scheduler routes it right.
function AuditorSchedules({ auditorId }: { auditorId?: string }) {
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const [cron, setCron] = useState("0 9 * * *");

  const create = useMutation({
    mutationFn: () => api.createSchedule({ agentId: auditorId!, cron: cron.trim(), enabled: true, kind: "auditor" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateSchedule(v.id, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });

  if (!auditorId) return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>No Auditor agent — cannot schedule.</span></Panel>;
  // Surface schedules targeting the Auditor agent (any kind), so an existing cadence is always visible.
  const mine = (schedules.data ?? []).filter((s) => s.agentId === auditorId);
  const cronValid = looksLikeCron(cron);

  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Put the Auditor on a cadence — each fire boots the read-and-file-only Auditor to scan recent transcripts
        and file findings to the board. Reading many transcripts costs tokens, so favour a sparse cadence.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {mine.map((s) => <AuditorScheduleRow key={s.id} s={s} onToggle={(enabled) => toggle.mutate({ id: s.id, enabled })}
          onRemove={() => remove.mutate(s.id)} busy={toggle.isPending || remove.isPending} />)}
        {mine.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No auditor schedule yet.</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 160 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Adding…" : "Add cadence"}
        </Button>
        {create.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(create.error as Error).message.includes("400") ? "Daemon rejected the cron expression." : (create.error as Error).message}</span>}
      </div>
    </Panel>
  );
}

function AuditorScheduleRow({ s, onToggle, onRemove, busy }:
  { s: Schedule; onToggle: (enabled: boolean) => void; onRemove: () => void; busy: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim,
      border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 8px" }}>
      <span style={{ color: color.cyan }}>{s.cron}</span>
      <span style={{ fontSize: 10, color: s.kind === "auditor" ? color.phosphor : color.amber }}>kind:{s.kind}</span>
      <span style={{ flex: 1 }}>next · {fmt(s.nextFireAt)}</span>
      <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted }}>{s.enabled ? "ON" : "OFF"}</span>
      <Button style={{ padding: "0 8px" }} disabled={busy} onClick={() => onToggle(!s.enabled)}>{s.enabled ? "Disable" : "Enable"}</Button>
      <Button variant="danger" style={{ padding: "0 8px" }} disabled={busy} onClick={onRemove}>Delete</Button>
    </div>
  );
}
