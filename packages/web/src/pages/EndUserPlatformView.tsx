import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, SessionRole, Schedule } from "@loom/shared";
import { api } from "../lib/api";
import Board from "./Board";
import { PlatformSessionTile } from "../components/PlatformSessionTile";
import { AgentPromptEditor } from "../components/AgentPromptEditor";
import { RunHistory } from "../components/RunHistory";
import { Panel, Button, Input, SectionLabel, StatusPill, Badge } from "../components/ui";
import { looksLikeCron } from "./Schedules";
import { color, font } from "../theme";

// Setup Assistant E1-7 / End-User Platform tier B5 — the SHIPPING-edition Platform surface (the reserved
// "Platform" home), rendered by the consolidated Platform page for shipping users (and as the
// dev "View as: End-user" preview). SEPARATE from the project picker (mirrors DeveloperPlatformView).
// The reserved "Platform" home is hidden from the ordinary project list (GET /api/projects
// excludes reserved); this view is its only way in — by design. The reserved home holds TWO agents:
// the operator ("Platform") and the de-privileged Workspace Auditor (B4).
//   • Discovery is read-only (api.setupHome) — the reserved home + its agent(s) + any live sessions.
//   • Operator: Start spawns via startSession(role "setup"); startSetup is a server-side SINGLETON, so a
//     Start while one is already live just attaches the existing one (never two live setup sessions).
//   • Auditor: "Review my workspace" spawns via startSession(role "workspace-auditor") — CREATE-ONLY
//     (NOT a singleton; gotcha #9), so each click is a fresh ephemeral read-and-suggest run.
//   • Stop reuses the existing graceful-stop REST. No new write/elevated surface — both spawns are
//     HUMAN-only REST (no agent MCP path mints a setup OR a workspace-auditor session).
// "Platform" here is the de-privileged, user-facing workspace operator — NOT the dev Platform Lead.
export function EndUserPlatformView() {
  const home = useQuery({ queryKey: ["setupHome"], queryFn: api.setupHome });
  // Profiles resolve each agent's role (setup / workspace-auditor) for the chip; the seeded name is the fallback.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });

  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Platform home…</p>;
  if (home.isError || !home.data) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>No reserved “Platform” project found — the home may not be seeded yet.</p>;
  }
  const { project, agents } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // The operator ("Platform"): the setup-role agent, falling back to its seeded display name if no profile
  // resolves. The reserved home now holds TWO agents (operator + the seeded Workspace Auditor), so we must
  // NOT assume agents[0] (it may be the Auditor) — resolve by role/name, leaving `assistant` undefined if
  // the operator isn't found rather than mis-picking the Auditor. ("Platform" = SETUP_AGENT_NAME, A2.)
  const assistant = agents.find((a) => roleOf(a) === "setup") ?? agents.find((a) => a.name === "Platform");
  // The Workspace Auditor (B4/B5): resolve by its locked role / seeded name — never an index. The seeded
  // profile carries role "workspace-auditor" (cosmetic for routing; the SESSION role is locked server-side).
  const auditor = agents.find((a) => roleOf(a) === "workspace-auditor") ?? agents.find((a) => a.name === "Workspace Auditor");

  // Sessions belonging to the reserved home, newest first (the terminal to attach to).
  const homeSessions = (sessions.data ?? [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveSession = assistant
    ? homeSessions.find((s) => s.agentId === assistant.id && s.processState === "live")
    : undefined;
  // The Auditor is CREATE-ONLY (non-singleton), so there may be several rows — show the NEWEST live one.
  const liveAuditorSession = auditor
    ? homeSessions.find((s) => s.agentId === auditor.id && s.processState === "live")
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Platform
          <Badge tone="cyan">{project.name}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            your workspace operator · hidden from the project picker
          </span>
        </SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "4px 0 0", fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
          Platform is your friendly, user-facing workspace operator — creating and configuring your projects,
          agents and profiles, choosing which skills each rig enables, and acting on your behalf (confirming big
          or irreversible actions first). Start it below and tell it what you want to build. The Workspace Auditor is a
          read-only reviewer — run it any time and it files improvement suggestions onto your home board.
        </p>
      </div>

      {/* --- Go-live controls: the singleton operator + the create-only "Review my workspace" auditor --- */}
      <section>
        <SectionLabel>Assistants</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          <AssistantControl agent={assistant} session={liveSession} />
          <AuditorControl agent={auditor} session={liveAuditorSession} />
        </div>
      </section>

      {/* --- The live operator terminal --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Operator session
          {liveSession && <StatusPill tone={liveSession.busy ? "amber" : "phosphor"} glow={liveSession.busy} label={liveSession.busy ? "busy" : "idle"} />}
        </SectionLabel>
        <SetupSession session={liveSession} />
      </section>

      {/* --- The live auditor terminal (a fresh run per Review click) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Auditor session
          {liveAuditorSession && <StatusPill tone={liveAuditorSession.busy ? "amber" : "phosphor"} glow={liveAuditorSession.busy} label={liveAuditorSession.busy ? "busy" : "idle"} />}
        </SectionLabel>
        <AuditorSession session={liveAuditorSession} />
      </section>

      {/* --- Operator run history — every operator RUN (role:"setup" session), newest-first, live+exited+archived --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Operator history
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            every operator session — when it ran, context cost, duration; expand to read the transcript
          </span>
        </SectionLabel>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role="setup"
          emptyLabel="No operator sessions yet — Platform hasn’t run." />
      </section>

      {/* --- Auditor run history — every Review RUN (workspace-auditor session), newest-first; each Review mints a fresh run --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Auditor history
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            every workspace review — when it ran, context cost, duration; expand to read the transcript
          </span>
        </SectionLabel>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role="workspace-auditor"
          emptyLabel="No reviews yet — click “Review my workspace” above to run one." />
      </section>

      {/* --- Your board — the setup checklist + the Workspace Auditor's suggestions (reused Board component) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Your board
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            your setup checklist + Auditor suggestions — triage by dragging cards
          </span>
        </SectionLabel>
        <Board projectId={project.id} />
      </section>
    </div>
  );
}

// The operator's go-live card: live status + a Start button (spawns the singleton setup session;
// reuses an already-live one server-side) and a graceful Stop when live. HUMAN-only REST (startSession /
// stopSession) — there is no agent MCP path to spawn a setup session.
function AssistantControl({ agent, session }: { agent?: Agent; session?: SessionListItem }) {
  const qc = useQueryClient();
  const spawn = useMutation({
    // inlineError: surface a spawn failure on the card, not the global blocking alert (which wedges
    // automation / first-run). Mirrors the Settings save opt-out.
    meta: { inlineError: true },
    mutationFn: () => api.startSession(agent!.id, "setup"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });

  if (!agent) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>Platform agent not seeded</span></Panel>;
  }
  const live = session?.processState === "live";
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone="cyan">Platform</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={live || spawn.isPending}
          title={live ? "Platform is already live" : "Start Platform"}
          onClick={() => spawn.mutate()}>
          {spawn.isPending ? "Starting…" : live ? "Live" : "Start Platform"}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
      {/* View / edit the operator's startup prompt (the spawn kickoff). */}
      <AgentPromptEditor key={`prompt-${agent.id}`} agent={agent} homeKey={["setupHome"]} />
    </Panel>
  );
}

// The Workspace Auditor's go-live card (B5): a "Review my workspace" button that spawns a workspace-auditor
// session — CREATE-ONLY (gotcha #9), so the button stays enabled even when one is live (each click is a
// fresh ephemeral run; the server never reuses a finished one), unlike the singleton operator above.
// HUMAN-only REST (startSession "workspace-auditor") — no agent MCP path mints a workspace-auditor session.
function AuditorControl({ agent, session }: { agent?: Agent; session?: SessionListItem }) {
  const qc = useQueryClient();
  const review = useMutation({
    meta: { inlineError: true }, // surface a spawn failure on the card, not the global blocking alert
    mutationFn: () => api.startSession(agent!.id, "workspace-auditor"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });

  if (!agent) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>Workspace Auditor not seeded</span></Panel>;
  }
  const live = session?.processState === "live";
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone="amber">Auditor</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {/* CREATE-ONLY: never disabled by `live` — each Review spawns a fresh run (no singleton). */}
        <Button variant="primary" disabled={review.isPending}
          title="Review my workspace — spawns a fresh read-only Auditor run that files improvement suggestions to your home board"
          onClick={() => review.mutate()}>
          {review.isPending ? "Starting…" : "Review my workspace"}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this Auditor run — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {review.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(review.error as Error).message}</span>}
      {/* View / edit the Workspace Auditor's startup prompt (the spawn kickoff). */}
      <AgentPromptEditor key={`prompt-${agent.id}`} agent={agent} homeKey={["setupHome"]} />
      {/* B6: opt-in cadence — co-located with "Review my workspace" because the reserved home is hidden
          from the Schedules-page project picker, so the Auditor can't be targeted there. */}
      <AuditorSchedule agent={agent} />
    </Panel>
  );
}

function fmtFire(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

// B6 — the Workspace Auditor's opt-in cadence. Looks up THIS agent's existing kind:"workspace-auditor"
// schedule (god-eye api.schedules, filtered to the agent + kind) and lets the user create / edit-cron /
// enable-disable / remove a SINGLE cadence. A fired workspace-auditor schedule boots a fresh suggest-only
// Auditor run via startWorkspaceAuditor (role locked server-side) — same human-only REST as the button
// above, never an agent MCP tool. Keyed by the schedule id in the parent so cron state resets on change.
function AuditorSchedule({ agent }: { agent: Agent }) {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const existing = (schedules.data ?? []).find((s) => s.agentId === agent.id && s.kind === "workspace-auditor");
  return <AuditorScheduleForm key={existing?.id ?? "new"} agentId={agent.id} existing={existing} />;
}

function AuditorScheduleForm({ agentId, existing }: { agentId: string; existing?: Schedule }) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(existing?.cron ?? "0 9 * * *");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const create = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.createSchedule({ agentId, cron: cron.trim(), enabled: true, kind: "workspace-auditor" }), onSuccess: invalidate });
  const save = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.updateSchedule(existing!.id, { cron: cron.trim() }), onSuccess: invalidate });
  const toggle = useMutation({ mutationFn: () => api.updateSchedule(existing!.id, { enabled: !existing!.enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteSchedule(existing!.id), onSuccess: invalidate });

  const cronValid = looksLikeCron(cron);
  const dirty = !!existing && cron.trim() !== existing.cron;
  const err = (create.error ?? save.error) as Error | null;

  return (
    <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, fontWeight: 700, color: color.textDim }}>Run automatically</span>
        {existing && <Badge tone={existing.enabled ? "phosphor" : "muted"}>{existing.enabled ? "on" : "paused"}</Badge>}
      </div>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Review your workspace on a schedule, not just on demand — each fire spawns a fresh read-only run.
        Reading transcripts costs tokens, so favour a sparse cadence. Schedules run only while the
        scheduler is enabled (Settings › Scheduler).
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 150 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        {existing ? (
          <>
            <Button variant="primary" disabled={!cronValid || !dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
            <Button disabled={toggle.isPending} onClick={() => toggle.mutate()} title={existing.enabled ? "Pause this cadence (stops firing)" : "Resume this cadence"}>{existing.enabled ? "Disable" : "Enable"}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
          </>
        ) : (
          <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Scheduling…" : "Schedule"}</Button>
        )}
      </div>
      {!cronValid && cron.trim().length > 0 && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
      {existing && <span style={{ color: color.textDim, fontFamily: font.mono, fontSize: 11 }}>next · {fmtFire(existing.nextFireAt)}</span>}
      {err && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{err.message.includes("400") ? "Daemon rejected the cron expression." : err.message}</span>}
    </div>
  );
}

// The live operator terminal (one singleton session). Uses the shared PlatformSessionTile — NO Fork
// (forking would mint a second setup session and break the singleton). Empty state prompts Start above.
function SetupSession({ session }: { session?: SessionListItem }) {
  if (!session) return <p style={{ color: color.textMuted, marginTop: 0 }}>No Platform session running. Start Platform above.</p>;
  return <PlatformSessionTile session={session} height={480} maxWidth={920} />;
}

// The live Auditor terminal — a fresh ephemeral run per "Review my workspace" click (CREATE-ONLY, no
// singleton). Mirrors SetupSession with Auditor stop copy; the shared tile carries the maximize control.
function AuditorSession({ session }: { session?: SessionListItem }) {
  if (!session) return <p style={{ color: color.textMuted, marginTop: 0 }}>No Auditor run active. Click “Review my workspace” above to start one.</p>;
  return (
    <PlatformSessionTile session={session} height={480} maxWidth={920}
      stopTitle="Stop this Auditor run — graceful Ctrl-C, clean and resumable" />
  );
}
