import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Session, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { bySessionActivity } from "../lib/sessions";
import { TerminalPane } from "../components/Terminal";
import { TranscriptPane } from "../components/TranscriptPane";
import { Composer } from "../components/Composer";
import { SessionWakes } from "../components/SessionWakes";
import { SessionQueue } from "../components/SessionQueue";
import { Panel, Button, Input, Select, SectionLabel, StatusPill } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber", auditor: "muted", run: "muted" };

// Starter agents seeded on project creation (editable afterward via the preset editor). Generic
// role scaffolds — the canonical, project-specific prompts get filled in per project.
const TEMPLATE_AGENTS: { name: string; startupPrompt: string }[] = [
  { name: "Orchestrator", startupPrompt: "You are the lead orchestrator for this project. Plan work into board tasks, spawn and review workers, and merge their branches via your loom-orchestration tools." },
  { name: "Planning & Triage", startupPrompt: "Triage incoming work for this project into clear, well-scoped board tasks, each with a sharp definition of done." },
  { name: "Dev", startupPrompt: "Implement the assigned board task on your worktree branch. Keep the change small and focused; run the build/tests; then report." },
  { name: "Bugfix", startupPrompt: "Reproduce, fix, and verify the assigned bug on your worktree branch. Add a regression check; then report." },
  { name: "Content Strategy", startupPrompt: "Work on content and strategy for this project, grounded in the vault notes." },
];

// Per-project working view: create project/agent, spawn or resume sessions, attach a terminal.
export default function Workspace() {
  const qc = useQueryClient();
  // The active project is the shared, header-persisted selection (see lib/activeProject) — the
  // left-rail project buttons WRITE to it. The agent selection stays local to Workspace.
  const { projectId, setProjectId } = useActiveProject();
  const [agentId, setAgentId] = useState<string | null>(() => {
    // One-time read-migration: the persisted key was renamed loom.topicId → loom.agentId in the
    // Topics→Agents rename. If only the legacy key is present, adopt + rewrite it so the last
    // selection survives the rename, then drop the old key.
    const v = localStorage.getItem("loom.agentId");
    if (v !== null) return v;
    const legacy = localStorage.getItem("loom.topicId");
    if (legacy !== null) { localStorage.setItem("loom.agentId", legacy); localStorage.removeItem("loom.topicId"); }
    return legacy;
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<"terminal" | "transcript">("terminal");
  useEffect(() => { agentId ? localStorage.setItem("loom.agentId", agentId) : localStorage.removeItem("loom.agentId"); }, [agentId]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  // Profiles are platform-level (cross-project), so this is a single global query, not project-scoped.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["sessions", agentId], queryFn: () => api.sessions(agentId!), enabled: !!agentId });

  const createProject = useMutation({
    mutationFn: async (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean }) => {
      const project = await api.createProject({ name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath });
      if (b.seedAgents) for (const t of TEMPLATE_AGENTS) await api.createAgent(project.id, t);
      return project;
    },
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["agents", project.id] });
      setProjectId(project.id); setAgentId(null); setSessionId(null);
    },
  });
  const createAgent = useMutation({
    mutationFn: (b: { name: string; startupPrompt: string }) => api.createAgent(projectId!, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", projectId] }),
  });
  const updateAgent = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; startupPrompt?: string; profileId?: string | null } }) => api.updateAgent(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", projectId] }),
  });
  const selectedAgent = agents.data?.find((t) => t.id === agentId) ?? null;
  const selectedProfile = selectedAgent?.profileId ? profiles.data?.find((p) => p.id === selectedAgent.profileId) ?? null : null;
  // role omitted = auto (the agent's profile role applies, server-side); "manager"/"plain" = per-spawn override.
  const spawn = useMutation({
    mutationFn: (role?: "manager" | "plain") => api.startSession(agentId!, role),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", agentId] }); },
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.resumeSession(id),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", agentId] }); },
  });
  // Manual graceful stop (Ctrl-C ×2 — clean + resumable) for a live/idle session.
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions", agentId] }),
  });
  // Manual rate-limit override + retry-now: clears the park + global latch and re-submits the held
  // turn (server mirrors RateLimitWatcher.resume). On success the parked pill clears via refetch; the
  // global RATE-LIMITED attention toast/item self-clears too. Errors surface like archive (alert).
  const clearRl = useMutation({
    mutationFn: (id: string) => api.clearSessionRateLimit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions", agentId] });
      qc.invalidateQueries({ queryKey: ["allSessions"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  // Fork an idle session: branch its conversation into a fresh divergent session, then attach to it.
  const fork = useMutation({
    mutationFn: (id: string) => api.forkSession(id),
    onSuccess: (s) => { setSessionId(s.id); qc.invalidateQueries({ queryKey: ["sessions", agentId] }); },
  });
  // Archive an EXITED session (a manager cascades to its workers) out of the rail. Clears the local
  // selection if it pointed at an archived session, and invalidates the rail + god-eye queries so the
  // session vanishes from Workspace/Terminals/Mission Control. A live group is rejected server-side.
  const archive = useMutation({
    mutationFn: (id: string) => api.archiveSession(id),
    onSuccess: (r) => {
      if (sessionId && r.archived.includes(sessionId)) setSessionId(null);
      qc.invalidateQueries({ queryKey: ["sessions", agentId] });
      qc.invalidateQueries({ queryKey: ["allSessions"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  // Manager first, then platform, then workers — so the orchestrator isn't lost among its workers.
  const roleRank = (r?: string | null) => (r === "manager" ? 0 : r === "platform" ? 1 : r === "worker" ? 2 : 3);
  // Fold each manager's workers into a collapsible group under it, so a manager with many workers
  // doesn't blow out the Sessions box. A worker is grouped only when its spawning manager is also in
  // this agent's list; orphan workers (no/unknown parent) stay top-level. Workers sort by spawn time.
  const allSessions = sessions.data ?? [];
  const sessionIds = new Set(allSessions.map((s) => s.id));
  const workersByManager = new Map<string, Session[]>();
  const topLevel: Session[] = [];
  for (const s of allSessions) {
    if (s.role === "worker" && s.parentSessionId && sessionIds.has(s.parentSessionId)) {
      (workersByManager.get(s.parentSessionId) ?? workersByManager.set(s.parentSessionId, []).get(s.parentSessionId)!).push(s);
    } else {
      topLevel.push(s);
    }
  }
  // Within each tier, the shared activity comparator (live-first → most-recent → spawn-order). Role
  // rank stays the PRIMARY top-level key so the orchestrator isn't lost among plain/orphan sessions;
  // activity orders within a role. Workers sort by activity under their manager (hierarchy intact).
  for (const ws of workersByManager.values()) ws.sort(bySessionActivity);
  const orderedTop = topLevel.sort((a, b) => roleRank(a.role) - roleRank(b.role) || bySessionActivity(a, b));
  // Collapsed by default (to keep the box small); a group auto-expands while one of its workers is selected.
  const [expandedManagers, setExpandedManagers] = useState<Set<string>>(new Set());
  const toggleManager = (id: string) =>
    setExpandedManagers((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const renderRow = (s: Session) => {
    // A manager with live-list workers confirms before archiving the whole group (cascade).
    const workerCount = s.role === "manager" ? (workersByManager.get(s.id)?.length ?? 0) : 0;
    const onArchive = () => {
      if (workerCount > 0 && !window.confirm(`Archive this manager and its ${workerCount} worker${workerCount === 1 ? "" : "s"}? They'll move to the Archive tab.`)) return;
      archive.mutate(s.id);
    };
    return (
      <SessionRow key={s.id} s={s} selected={s.id === sessionId}
        onSelect={() => setSessionId(s.id)} onResume={() => resume.mutate(s.id)} resuming={resume.isPending}
        onStop={() => stop.mutate(s.id)} stopping={stop.isPending}
        onFork={() => fork.mutate(s.id)} forking={fork.isPending}
        onClearRateLimit={() => clearRl.mutate(s.id)} clearingRateLimit={clearRl.isPending}
        onArchive={onArchive} archiving={archive.isPending} />
    );
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel>
          <SectionLabel>Projects</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {projects.data?.map((p) => (
              <Button key={p.id} variant={p.id === projectId ? "primary" : "default"} style={{ textAlign: "left" }}
                onClick={() => { setProjectId(p.id); setAgentId(null); setSessionId(null); }}>{p.name}</Button>
            ))}
          </div>
          <ProjectForm onCreate={(b) => createProject.mutate(b)} />
        </Panel>

        {projectId && (
          <Panel>
            <SectionLabel>Agents</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {agents.data?.map((t) => {
                const prof = t.profileId ? profiles.data?.find((p) => p.id === t.profileId) ?? null : null;
                return (
                  <Button key={t.id} variant={t.id === agentId ? "primary" : "default"} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
                    onClick={() => { setAgentId(t.id); setSessionId(null); }}
                    title={prof ? `profile: ${prof.name}${prof.role ? ` · ${prof.role}` : ""}` : "no profile"}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                    {prof?.icon && <span>{prof.icon}</span>}
                    {prof?.role && <span style={{ fontSize: 10, color: tone[roleTone[prof.role]], fontFamily: font.mono }}>{prof.role}</span>}
                  </Button>
                );
              })}
            </div>
            {/* Assign / clear the selected agent's Profile — the profile supplies the spawn role/rig; the prompt comes from the agent. */}
            {selectedAgent && (
              <div style={{ marginTop: 10 }}>
                <SectionLabel style={{ margin: "4px 0" }}>Profile · {selectedAgent.name}</SectionLabel>
                <Select style={{ width: "100%" }} value={selectedAgent.profileId ?? ""}
                  onChange={(e) => updateAgent.mutate({ id: selectedAgent.id, patch: { profileId: e.target.value || null } })}>
                  <option value="">— none —</option>
                  {profiles.data?.map((p) => (
                    <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}{p.role ? ` (${p.role})` : ""}</option>
                  ))}
                </Select>
              </div>
            )}
            <AgentForm onCreate={(b) => createAgent.mutate(b)} />
          </Panel>
        )}

        {agentId && (
          <Panel>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <SectionLabel style={{ margin: 0, flex: 1 }}>Sessions</SectionLabel>
              <SpawnControls profileRole={selectedProfile?.role ?? null} onSpawn={(role) => spawn.mutate(role)} pending={spawn.isPending} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {orderedTop.map((s) => {
                const workers = workersByManager.get(s.id);
                return (
                  <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {renderRow(s)}
                    {workers && workers.length > 0 && (
                      <WorkerGroup workers={workers} renderRow={renderRow}
                        open={expandedManagers.has(s.id) || workers.some((w) => w.id === sessionId)}
                        onToggle={() => toggleManager(s.id)} />
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        )}
      </div>

      <Panel style={{ height: "72vh", padding: 6, display: "flex", flexDirection: "column" }}>
        {sessionId ? (
          <>
            <div style={{ marginBottom: 6, display: "flex", gap: 6 }}>
              {(["terminal", "transcript"] as const).map((t) => (
                <Button key={t} variant={rightTab === t ? "primary" : "default"} onClick={() => setRightTab(t)}>
                  {t === "terminal" ? "Terminal" : "Transcript"}
                </Button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              {rightTab === "terminal"
                ? <TerminalPane sessionId={sessionId} />
                : <TranscriptPane sessionId={sessionId} />}
            </div>
            <SessionWakes sessionId={sessionId} />
            <SessionQueue sessionId={sessionId} />
            <Composer sessionId={sessionId} />
          </>
        ) : selectedAgent ? (
          <AgentPresetEditor key={selectedAgent.id} agent={selectedAgent}
            onSave={(startupPrompt) => updateAgent.mutate({ id: selectedAgent.id, patch: { startupPrompt } })}
            saving={updateAgent.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select an agent to view/edit its startup prompt, or spawn a session to attach a live terminal.</p>}
      </Panel>
    </div>
  );
}

function SessionRow({ s, selected, onSelect, onResume, resuming, onStop, stopping, onFork, forking, onClearRateLimit, clearingRateLimit, onArchive, archiving }:
  { s: Session; selected: boolean; onSelect: () => void; onResume: () => void; resuming: boolean;
    onStop: () => void; stopping: boolean; onFork: () => void; forking: boolean;
    onClearRateLimit: () => void; clearingRateLimit: boolean;
    onArchive: () => void; archiving: boolean }) {
  const isManager = s.role === "manager";
  const canResume = s.processState === "exited" && s.resumability !== "dead";
  const live = s.processState === "live";
  // §19c park: a usage cap parked this session until rateLimitedUntil. Surface it instead of the
  // live/busy pill, with the reset time + a one-line "transient? clear & retry" hint and the override.
  const rateLimited = !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
  const st = rateLimited
    ? { tone: "red" as const, label: `rate-limited · ${new Date(s.rateLimitedUntil!).toLocaleTimeString()}` }
    : live
      ? (s.busy ? { tone: "amber" as const, label: "busy", glow: true } : { tone: "phosphor" as const, label: "live" })
      : { tone: "muted" as const, label: s.processState };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Panel selected={selected} onClick={onSelect}
        style={{ flex: 1, padding: "6px 8px", ...(isManager && !selected ? { border: `1px solid ${color.phosphor}` } : null) }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: isManager ? color.phosphor : color.text, fontWeight: isManager ? 700 : 400 }}>
            {isManager ? "★ " : ""}{s.id.slice(0, 8)} · {s.role ?? "session"}
          </span>
          <span style={{ flex: 1 }} />
          <StatusPill tone={st.tone} label={st.label} glow={"glow" in st ? st.glow : undefined} />
        </div>
        {rateLimited && (
          <div style={{ marginTop: 4, fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
            transient overload? clear &amp; retry now — re-submits the held turn.
          </div>
        )}
      </Panel>
      {rateLimited && <Button disabled={clearingRateLimit} title="Clear the rate-limit hold + the global usage latch and re-submit the held turn now (mirrors the auto-resume path)"
        onClick={(ev) => { ev.stopPropagation(); onClearRateLimit(); }}>Clear rate limit &amp; retry now</Button>}
      {live && <Button disabled={forking || s.busy} onClick={(ev) => { ev.stopPropagation(); onFork(); }}
        title={s.busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}>Fork</Button>}
      {live && <Button disabled={stopping} title="Stop this session — graceful Ctrl-C, clean and resumable"
        onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>}
      {canResume && <Button disabled={resuming} title="Resume this session and attach its terminal" onClick={onResume}>Resume</Button>}
      {s.resumability === "dead" && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>dead</span>}
      {/* Archive is exited-only (a live session must be stopped first) — moves it (and a manager's
          workers) out of the rail into the Archive tab. */}
      {!live && <Button disabled={archiving} title="Archive this session out of the rail (a manager archives its workers too)"
        onClick={(ev) => { ev.stopPropagation(); onArchive(); }}>Archive</Button>}
    </div>
  );
}

// Collapsible block of a manager's workers, indented under its row with a phosphor rail. The toggle
// summarises the worker count + how many are currently busy, so a collapsed group still signals activity.
function WorkerGroup({ workers, open, onToggle, renderRow }:
  { workers: Session[]; open: boolean; onToggle: () => void; renderRow: (s: Session) => ReactNode }) {
  const busy = workers.filter((w) => w.processState === "live" && w.busy).length;
  return (
    <div style={{ marginLeft: 10, paddingLeft: 8, borderLeft: `1px solid ${color.border}`, display: "flex", flexDirection: "column", gap: 6 }}>
      <button onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: "2px 0",
          fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim,
        }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>
        {workers.length} worker{workers.length === 1 ? "" : "s"}
        {busy > 0 && <span style={{ color: color.amber }}>· {busy} busy</span>}
      </button>
      {open && workers.map(renderRow)}
    </div>
  );
}

// Spawn split-button: the primary action spawns from the agent's profile (no role → the profile's role
// applies server-side); the ▾ menu overrides the role per-spawn. "From profile" = auto, "Manager" =
// explicit manager, "Plain" = force-plain (ignore the profile's role → a role-null session).
function SpawnControls({ profileRole, onSpawn, pending }:
  { profileRole: SessionRole | null; onSpawn: (role?: "manager" | "plain") => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const options: { label: string; role?: "manager" | "plain" }[] = [
    { label: "From profile (default)", role: undefined },
    { label: "Manager", role: "manager" },
    { label: "Plain", role: "plain" },
  ];
  return (
    <div style={{ position: "relative", display: "inline-flex" }} onMouseLeave={() => setOpen(false)}>
      <Button variant="primary" disabled={pending} onClick={() => { setOpen(false); onSpawn(undefined); }}
        title={`Spawn from profile — role: ${profileRole ?? "plain"}`}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        Spawn{profileRole ? ` · ${profileRole}` : ""}
      </Button>
      <Button variant="primary" disabled={pending} onClick={() => setOpen((o) => !o)} title="Override the spawn role"
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "none", padding: "4px 6px" }}>▾</Button>
      {open && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 20, minWidth: 170,
          background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: 4, overflow: "hidden",
          display: "flex", flexDirection: "column" }}>
          {options.map((o) => (
            <button key={o.label} disabled={pending} onClick={() => { setOpen(false); onSpawn(o.role); }}
              className="loom-btn loom-btn-ghost"
              style={{ textAlign: "left", background: "transparent", border: "none", color: color.text,
                fontFamily: font.mono, fontSize: 12, padding: "6px 10px", cursor: "pointer" }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean }) => void }) {
  const [name, setName] = useState(""), [repoPath, setRepo] = useState(""), [vaultPath, setVault] = useState("");
  const [seedAgents, setSeed] = useState(true);
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="repo path" value={repoPath} onChange={(e) => setRepo(e.target.value)} />
      <Input placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
        <input type="checkbox" checked={seedAgents} onChange={(e) => setSeed(e.target.checked)} />
        seed starter agents (Orchestrator · Planning · Dev · Bugfix · Content)
      </label>
      <Button variant="primary" disabled={!name || !repoPath || !vaultPath}
        onClick={() => { onCreate({ name, repoPath, vaultPath, seedAgents }); setName(""); setRepo(""); setVault(""); }}>Create project</Button>
    </div>
  );
}

function AgentForm({ onCreate }: { onCreate: (b: { name: string; startupPrompt: string }) => void }) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <Input placeholder="agent name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        style={{ width: "100%", height: 64, boxSizing: "border-box", resize: "vertical", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: 8, fontFamily: font.mono, fontSize: 13 }}
        placeholder="startup prompt (injected as the first turn of each new session)"
        value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <Button variant="primary" disabled={!name} onClick={() => { onCreate({ name, startupPrompt }); setName(""); setPrompt(""); }}>Create</Button>
    </div>
  );
}

// View + edit an agent's startup-prompt preset. Remounted per agent (key=agent.id) so the
// textarea state resets on switch; after Save the query refetches and `dirty` clears.
function AgentPresetEditor(
  { agent, onSave, saving }: { agent: Agent; onSave: (startupPrompt: string) => void; saving: boolean },
) {
  const [prompt, setPrompt] = useState(agent.startupPrompt);
  const dirty = prompt !== agent.startupPrompt;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 8 }}>
      <div style={{ marginBottom: 6 }}>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Startup prompt — {agent.name}</strong>
        <span style={{ color: color.textMuted, fontSize: 12 }}>{" "}· injected as the first turn of each new session in this agent</span>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
        }} />
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave(prompt)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setPrompt(agent.startupPrompt)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
      </div>
    </div>
  );
}
