import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { COLUMN_PRESETS, DEFAULT_COLUMN_PRESET_ID, presetById, presetToDesired, type Agent, type Project, type SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Input, Select, SectionLabel, PresetAccentDots } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber", auditor: "muted", setup: "cyan", "workspace-auditor": "muted", run: "muted" };

// Starter agents seeded on project creation (editable afterward via the preset editor). Generic
// role scaffolds — the canonical, project-specific prompts get filled in per project.
const TEMPLATE_AGENTS: { name: string; startupPrompt: string }[] = [
  { name: "Orchestrator", startupPrompt: "You are the lead orchestrator for this project. Plan work into board tasks, spawn and review workers, and merge their branches via your loom-orchestration tools." },
  { name: "Planning & Triage", startupPrompt: "Triage incoming work for this project into clear, well-scoped board tasks, each with a sharp definition of done." },
  { name: "Dev", startupPrompt: "Implement the assigned board task on your worktree branch. Keep the change small and focused; run the build/tests; then report." },
  { name: "Bugfix", startupPrompt: "Reproduce, fix, and verify the assigned bug on your worktree branch. Add a regression check; then report." },
  { name: "Content Strategy", startupPrompt: "Work on content and strategy for this project, grounded in the vault notes." },
];

// Per-project working view: create/manage projects and agents, and edit each agent's startup prompt.
// Live-session interaction (spawn / resume / fork / stop, terminals + transcripts) lives on the
// Terminals and Overview pages; stopped sessions live on the Archive page (archiving is automatic).
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
  useEffect(() => { agentId ? localStorage.setItem("loom.agentId", agentId) : localStorage.removeItem("loom.agentId"); }, [agentId]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  // Profiles are platform-level (cross-project), so this is a single global query, not project-scoped.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  // Cross-project live sessions — the source for the "stop the fleet first" guard on destructive
  // project/agent ops (archive/delete disable while a related session is live). Archived projects feed
  // the restore / permanent-delete section. Both are cheap loopback reads, invalidated by the mutations.
  const globalSessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const archivedProjects = useQuery({ queryKey: ["archivedProjects"], queryFn: api.archivedProjects });
  const liveByProject = new Map<string, number>();
  const liveByAgent = new Map<string, number>();
  for (const s of globalSessions.data ?? []) {
    if (s.processState !== "live") continue;
    liveByProject.set(s.projectId, (liveByProject.get(s.projectId) ?? 0) + 1);
    liveByAgent.set(s.agentId, (liveByAgent.get(s.agentId) ?? 0) + 1);
  }

  const createProject = useMutation({
    mutationFn: async (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean; presetId: string }) => {
      const project = await api.createProject({ name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath });
      // Seed the chosen board preset through the SAME atomic columns API the editor uses (no new
      // endpoint). The default preset matches PLATFORM_DEFAULTS, so skip the call — a fresh project
      // already inherits that board and applying it would be a no-op write.
      if (b.presetId && b.presetId !== DEFAULT_COLUMN_PRESET_ID) {
        await api.updateProjectColumns(project.id, presetToDesired(presetById(b.presetId)));
      }
      if (b.seedAgents) for (const t of TEMPLATE_AGENTS) await api.createAgent(project.id, t);
      return project;
    },
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["agents", project.id] });
      setProjectId(project.id); setAgentId(null);
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
  // --- HUMAN-only project/agent management (rename / archive / restore / PERMANENT delete + agent
  // delete). All DESTRUCTIVE ops invalidate the relevant react-query keys; the server enforces the
  // reserved-home + live-session guards and returns the reason, surfaced verbatim via the *Err clients. ---
  const updateProject = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; vaultPath?: string } }) => api.updateProject(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: (e) => window.alert((e as Error).message),
  });
  const archiveProject = useMutation({
    mutationFn: (id: string) => api.archiveProject(id),
    onSuccess: (_r, id) => {
      if (projectId === id) { setProjectId(""); setAgentId(null); }
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["archivedProjects"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  const restoreProject = useMutation({
    mutationFn: (id: string) => api.restoreProject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["archivedProjects"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  const deleteProject = useMutation({
    mutationFn: (id: string) => api.deleteProjectPermanent(id),
    onSuccess: (_r, id) => {
      if (projectId === id) { setProjectId(""); setAgentId(null); }
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["archivedProjects"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  const deleteAgent = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: (_r, id) => {
      if (agentId === id) setAgentId(null);
      qc.invalidateQueries({ queryKey: ["agents", projectId] });
      qc.invalidateQueries({ queryKey: ["allSessions"] });
    },
    onError: (e) => window.alert((e as Error).message),
  });
  const selectedProject = projects.data?.find((p) => p.id === projectId) ?? null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel>
          <SectionLabel>Projects</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {projects.data?.map((p) => (
              <Button key={p.id} variant={p.id === projectId ? "primary" : "default"} style={{ textAlign: "left" }}
                onClick={() => { setProjectId(p.id); setAgentId(null); }}>{p.name}</Button>
            ))}
          </div>
          {selectedProject && (
            <ProjectManage key={selectedProject.id} project={selectedProject}
              liveCount={liveByProject.get(selectedProject.id) ?? 0}
              onSave={(patch) => updateProject.mutate({ id: selectedProject.id, patch })}
              onArchive={() => archiveProject.mutate(selectedProject.id)}
              onDelete={() => deleteProject.mutate(selectedProject.id)}
              saving={updateProject.isPending} archiving={archiveProject.isPending} deleting={deleteProject.isPending} />
          )}
          <ProjectForm onCreate={(b) => createProject.mutate(b)} />
          {(archivedProjects.data?.length ?? 0) > 0 && (
            <ArchivedProjects projects={archivedProjects.data!}
              onRestore={(id) => restoreProject.mutate(id)}
              onDelete={(p) => { const t = window.prompt(deletePrompt(p.name)); if (t === p.name) deleteProject.mutate(p.id); else if (t !== null) window.alert("name did not match — not deleted"); }} />
          )}
        </Panel>

        {projectId && (
          <Panel>
            <SectionLabel>Agents</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {agents.data?.map((t) => {
                const prof = t.profileId ? profiles.data?.find((p) => p.id === t.profileId) ?? null : null;
                return (
                  <Button key={t.id} variant={t.id === agentId ? "primary" : "default"} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}
                    onClick={() => setAgentId(t.id)}
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
                {/* Permanently delete this agent (cascades its sessions). Disabled while it has a live
                    session — the server blocks it too ("stop the fleet first"). Behind a confirm. */}
                {(() => {
                  const liveAgent = liveByAgent.get(selectedAgent.id) ?? 0;
                  return (
                    <Button variant="danger" disabled={liveAgent > 0 || deleteAgent.isPending}
                      title={liveAgent > 0 ? "stop the fleet first — this agent has a live session" : "permanently delete this agent and its sessions"}
                      style={{ marginTop: 8, width: "100%" }}
                      onClick={() => { if (window.confirm(`Permanently delete agent "${selectedAgent.name}" and ALL its sessions? This cannot be undone.`)) deleteAgent.mutate(selectedAgent.id); }}>
                      {deleteAgent.isPending ? "Deleting…" : "Delete agent"}
                    </Button>
                  );
                })()}
              </div>
            )}
            <AgentForm onCreate={(b) => createAgent.mutate(b)} />
          </Panel>
        )}
      </div>

      <Panel style={{ height: "72vh", padding: 6, display: "flex", flexDirection: "column" }}>
        {selectedAgent ? (
          <AgentPresetEditor key={selectedAgent.id} agent={selectedAgent}
            onSave={(startupPrompt) => updateAgent.mutate({ id: selectedAgent.id, patch: { startupPrompt } })}
            saving={updateAgent.isPending} />
        ) : <p style={{ color: color.textMuted, padding: 12 }}>Select an agent to view and edit its startup prompt. Live sessions are managed on the Terminals and Overview pages.</p>}
      </Panel>
    </div>
  );
}

// The strong-confirm body for a PERMANENT project delete — names the irreversible cascade and asks the
// human to type the project name back. Shared by the manage panel + the archived-projects list.
function deletePrompt(name: string): string {
  return `PERMANENTLY delete "${name}" and ALL of it — its agents, sessions, tasks, schedules, API keys, runs and saved transcripts. This CANNOT be undone.\n\nType the project name (${name}) to confirm:`;
}

// Per-project management: rename + edit vaultPath (Save), soft-archive (reversible "delete"), and a
// PERMANENT delete behind a type-the-name confirm naming the cascade. Archive + permanent-delete are
// DISABLED while the project has a live session (the server blocks them too — "stop the fleet first").
// Reserved/system projects never reach here (they're excluded from the project list this renders from).
function ProjectManage(
  { project, liveCount, onSave, onArchive, onDelete, saving, archiving, deleting }:
  { project: Project; liveCount: number; onSave: (patch: { name?: string; vaultPath?: string }) => void;
    onArchive: () => void; onDelete: () => void; saving: boolean; archiving: boolean; deleting: boolean },
) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [vaultPath, setVault] = useState(project.vaultPath);
  const [confirmText, setConfirmText] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  const dirty = (name.trim() !== project.name || vaultPath.trim() !== project.vaultPath) && !!name.trim() && !!vaultPath.trim();
  const live = liveCount > 0;
  const liveTitle = live ? `stop the fleet first — ${liveCount} live session${liveCount === 1 ? "" : "s"}` : undefined;
  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: "2px 0",
          fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>Manage · {project.name}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
          <Button variant="primary" disabled={!dirty || saving}
            onClick={() => onSave({ name: name.trim(), vaultPath: vaultPath.trim() })}>{saving ? "Saving…" : "Save changes"}</Button>
          <Button disabled={live || archiving} title={liveTitle}
            onClick={() => { if (window.confirm(`Archive "${project.name}"? It moves to the Archived section and can be restored later.`)) onArchive(); }}>
            {archiving ? "Archiving…" : "Archive (reversible)"}
          </Button>
          {!showDelete
            ? <Button variant="danger" disabled={live} title={liveTitle} onClick={() => { setShowDelete(true); setConfirmText(""); }}>Delete permanently…</Button>
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${color.red}`, borderRadius: 4, padding: 8 }}>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.red }}>
                  Permanently delete this project and ALL of it — agents, sessions, tasks, schedules, keys, runs, transcripts. Cannot be undone. Type <strong>{project.name}</strong> to confirm:
                </span>
                <Input autoFocus placeholder={project.name} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
                <div style={{ display: "flex", gap: 6 }}>
                  <Button variant="danger" disabled={confirmText !== project.name || live || deleting} title={liveTitle}
                    onClick={onDelete}>{deleting ? "Deleting…" : "Delete forever"}</Button>
                  <Button onClick={() => setShowDelete(false)}>Cancel</Button>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// Soft-archived projects — restore back to the picker, or permanently delete (strong type-the-name
// confirm via deletePrompt). Collapsed by default so it never crowds the live project list.
function ArchivedProjects(
  { projects, onRestore, onDelete }: { projects: Project[]; onRestore: (id: string) => void; onDelete: (p: Project) => void },
) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: "2px 0",
          fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>Archived · {projects.length}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {projects.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font.mono, fontSize: 12, color: color.textDim }}>{p.name}</span>
              <Button onClick={() => onRestore(p.id)}>Restore</Button>
              <Button variant="danger" onClick={() => onDelete(p)}>Delete</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectForm({ onCreate }: { onCreate: (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean; presetId: string }) => void }) {
  const [name, setName] = useState(""), [repoPath, setRepo] = useState(""), [vaultPath, setVault] = useState("");
  const [seedAgents, setSeed] = useState(true);
  // Board preset to seed the new project's columns with. Defaults to Agent Dev so a fresh project keeps
  // today's exact board; any other choice is applied via the atomic columns API right after creation.
  const [presetId, setPreset] = useState(DEFAULT_COLUMN_PRESET_ID);
  const preset = presetById(presetId);
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="repo path" value={repoPath} onChange={(e) => setRepo(e.target.value)} />
      <Input placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
        board preset
        <Select value={presetId} onChange={(e) => setPreset(e.target.value)} aria-label="Board preset">
          {COLUMN_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.id === DEFAULT_COLUMN_PRESET_ID ? " (default)" : ""}</option>
          ))}
        </Select>
        <span style={{ color: color.textMuted, lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <PresetAccentDots accents={preset.columns.map((c) => c.accentColor)}
            title={preset.columns.map((c) => c.label).join(" → ")} />
          <span>{preset.description} · {preset.columns.map((c) => c.label).join(" → ")}</span>
        </span>
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
        <input type="checkbox" checked={seedAgents} onChange={(e) => setSeed(e.target.checked)} />
        seed starter agents (Orchestrator · Planning · Dev · Bugfix · Content)
      </label>
      <Button variant="primary" disabled={!name || !repoPath || !vaultPath}
        onClick={() => { onCreate({ name, repoPath, vaultPath, seedAgents, presetId }); setName(""); setRepo(""); setVault(""); setPreset(DEFAULT_COLUMN_PRESET_ID); }}>Create project</Button>
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
