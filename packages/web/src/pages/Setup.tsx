import { type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { Composer } from "../components/Composer";
import { PresetPromptsButton } from "../components/PresetPrompts";
import { Panel, Button, SectionLabel, StatusPill, Badge } from "../components/ui";
import { color, font } from "../theme";

// Setup Assistant E1-7 — the always-available "Set up Loom" surface, SEPARATE from the project picker
// (mirrors Platform.tsx). The reserved "Getting Started" home is hidden from the ordinary project list
// (GET /api/projects excludes reserved); this page is its only way in — by design. It surfaces the
// single Setup Assistant agent with a Start/Resume control + the live setup terminal.
//   • Discovery is read-only (api.setupHome) — the reserved home + its agent + any live setup sessions.
//   • Start spawns via startSession(role "setup"); startSetup is a server-side SINGLETON, so a Start
//     while one is already live just attaches the existing one (never two live setup sessions).
//   • Stop reuses the existing graceful-stop REST. No new write/elevated surface.
// The Setup Assistant is the friendly, user-facing onboarding helper — NOT the Platform Lead.
export default function Setup() {
  const home = useQuery({ queryKey: ["setupHome"], queryFn: api.setupHome });
  // Profiles resolve the agent's role (setup) for the chip; the seeded name is the fallback.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });

  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Setup home…</p>;
  if (home.isError || !home.data) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>No reserved “Getting Started” project found — the setup home may not be seeded yet.</p>;
  }
  const { project, agents } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // The Setup Assistant: the setup-role agent, falling back to the seeded name if no profile resolves.
  const assistant = agents.find((a) => roleOf(a) === "setup") ?? agents.find((a) => a.name === "Setup Assistant") ?? agents[0];

  // Live setup sessions belonging to the reserved home, newest first (the terminal to attach to).
  const setupSessions = (sessions.data ?? [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveSession = assistant
    ? setupSessions.find((s) => s.agentId === assistant.id && s.processState === "live")
    : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Set up Loom
          <Badge tone="cyan">{project.name}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            your onboarding assistant · hidden from the project picker
          </span>
        </SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "4px 0 0", fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
          The Setup Assistant is a friendly, user-facing helper that gets you set up — creating and configuring
          your first projects, agents and profiles, picking default skills, and acting on your behalf (confirming
          big or irreversible actions first). Start it below and tell it what you want to build.
        </p>
      </div>

      {/* --- Go-live control (Start / Resume the singleton Setup Assistant) --- */}
      <section>
        <SectionLabel>Assistant</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          <AssistantControl agent={assistant} session={liveSession} />
        </div>
      </section>

      {/* --- The live setup terminal --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Session
          {liveSession && <StatusPill tone={liveSession.busy ? "amber" : "phosphor"} glow={liveSession.busy} label={liveSession.busy ? "busy" : "idle"} />}
        </SectionLabel>
        <SetupSession session={liveSession} />
      </section>
    </div>
  );
}

// The Setup Assistant's go-live card: live status + a Start button (spawns the singleton setup session;
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
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>Setup Assistant agent not seeded</span></Panel>;
  }
  const live = session?.processState === "live";
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone="cyan">Setup</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={live || spawn.isPending}
          title={live ? "The Setup Assistant is already live" : "Start the Setup Assistant"}
          onClick={() => spawn.mutate()}>
          {spawn.isPending ? "Starting…" : live ? "Live" : "Start setup"}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
    </Panel>
  );
}

// The live setup terminal (one singleton session). Hand-rolled like Platform's session tile — NO Fork
// (forking would mint a second setup session and break the singleton). Empty state prompts Start above.
function SetupSession({ session }: { session?: SessionListItem }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  if (!session) return <p style={{ color: color.textMuted, marginTop: 0 }}>No setup session running. Start the Setup Assistant above.</p>;
  const tile: CSSProperties = { height: 480, padding: 6, display: "flex", flexDirection: "column", maxWidth: 920 };
  return (
    <Panel style={tile}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          <StatusPill tone={session.busy ? "amber" : "phosphor"} glow={session.busy} label={session.busy ? "busy" : "idle"} />
          <span>{session.agentName}{session.role ? ` · ${session.role}` : ""} · {session.id.slice(0, 8)}</span>
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          <PresetPromptsButton sessionId={session.id} />
          <Button style={{ padding: "0 8px" }} disabled={stop.isPending}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(session.id)}>Stop</Button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={session.id} /></div>
      <Composer sessionId={session.id} />
    </Panel>
  );
}
