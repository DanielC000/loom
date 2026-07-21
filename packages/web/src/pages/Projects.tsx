import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { COLUMN_PRESETS, DEFAULT_COLUMN_PRESET_ID, presetById, presetToDesired, type Agent, type Project } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, Button, Input, Select, SectionLabel, Chip, Dot, PresetAccentDots } from "../components/ui";
import { color, font, radius } from "../theme";
import { roleDisplay, roleColor } from "../lib/roleDisplay";
import type { SessionRole } from "@loom/shared";

// Starter agents seeded on project creation (editable afterward via the preset editor). Generic
// role scaffolds — the canonical, project-specific prompts get filled in per project.
const TEMPLATE_AGENTS: { name: string; startupPrompt: string }[] = [
  { name: "Orchestrator", startupPrompt: "You are the lead orchestrator for this project. Plan work into board tasks, spawn and review workers, and merge their branches via your loom-orchestration tools." },
  { name: "Planning & Triage", startupPrompt: "Triage incoming work for this project into clear, well-scoped board tasks, each with a sharp definition of done." },
  { name: "Dev", startupPrompt: "Implement the assigned board task on your worktree branch. Keep the change small and focused; run the build/tests; then report." },
  { name: "Bugfix", startupPrompt: "Reproduce, fix, and verify the assigned bug on your worktree branch. Add a regression check; then report." },
  { name: "Content Strategy", startupPrompt: "Work on content and strategy for this project, grounded in the vault notes." },
];

// PROJECTS — the workspace's definition/config layer: create and manage projects, and define each
// project's agents (create, assign a Profile, edit the startup prompt, delete). A three-pane
// master→list→detail: the Projects rail (filter + live-dot + create) selects a project; the Agents
// column carries that project's manage header + its agents; the Editor pane holds the create forms and
// the selected agent's startup-prompt editor. NO live-session interaction lives here — spawn / resume /
// fork / stop, terminals + transcripts live on the Terminals and Overview pages; stopped sessions live
// on the Archive page (archiving is automatic). Renamed + repositioned from the old "Workspace" page
// (card 274f9ba9): now a Config surface, adjacent to Profiles & Skills — the "define your actors" cluster.
export default function Projects() {
  const qc = useQueryClient();
  // The active project is the shared, header-persisted selection (see lib/activeProject) — the
  // project rail WRITES to it. The agent selection stays local to this page.
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

  // The Editor pane is a single detail slot: a "creating" intent (project / agent) takes precedence over
  // the selected-agent editor, so the roomy pane doubles as the create surface (fixing the old cramped
  // 320px-rail create form). Selecting a project or an agent clears any in-flight create.
  const [creating, setCreating] = useState<null | "project" | "agent">(null);
  const [filter, setFilter] = useState("");

  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  // Profiles are platform-level (cross-project), so this is a single global query, not project-scoped.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  // Cross-project live sessions — the source for the rail's live-dot AND the "stop the fleet first" guard
  // on destructive project/agent ops (archive/delete disable while a related session is live). Archived
  // projects feed the restore / permanent-delete footer. Both are cheap loopback reads, invalidated by
  // the mutations (the live set also polls, mirroring the header picker's live marker).
  const globalSessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  const archivedProjects = useQuery({ queryKey: ["archivedProjects"], queryFn: api.archivedProjects });
  const { liveByProject, liveByAgent } = useMemo(() => {
    const byProject = new Map<string, number>();
    const byAgent = new Map<string, number>();
    for (const s of globalSessions.data ?? []) {
      if (s.processState !== "live") continue;
      byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + 1);
      byAgent.set(s.agentId, (byAgent.get(s.agentId) ?? 0) + 1);
    }
    return { liveByProject: byProject, liveByAgent: byAgent };
  }, [globalSessions.data]);

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
      setProjectId(project.id); setAgentId(null); setCreating(null);
    },
  });
  const createAgent = useMutation({
    mutationFn: (b: { name: string; startupPrompt: string }) => api.createAgent(projectId!, b),
    // Select the new agent so the editor pane switches straight to its prompt — the create form was the
    // pane's transient occupant; hand it back to the freshly-made agent.
    onSuccess: (agent) => { qc.invalidateQueries({ queryKey: ["agents", projectId] }); setAgentId(agent.id); setCreating(null); },
  });
  const updateAgent = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; startupPrompt?: string; profileId?: string | null } }) => api.updateAgent(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", projectId] }),
  });
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
  const selectedAgent = agents.data?.find((t) => t.id === agentId) ?? null;

  const pickProject = (id: string) => { setProjectId(id); setAgentId(null); setCreating(null); };
  const pickAgent = (id: string) => { setAgentId(id); setCreating(null); };

  const q = filter.trim().toLowerCase();
  const filteredProjects = (projects.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Projects</SectionLabel>
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>
          create and manage projects and their agents · live sessions live on Terminals and Overview
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "244px 320px minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        {/* ── Projects rail: filter + live-dotted list + create + archived footer ─────────────────── */}
        <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <SectionLabel style={{ margin: 0 }}>All projects</SectionLabel>
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{projects.data?.length ?? 0}</span>
          </div>
          <Input placeholder="Filter projects…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />
          {/* Create sits at the TOP of the rail — the primary action is reachable without scrolling past the
              list (owner ask, card ee742d5b). The reveal-collapsed form still opens in the roomy Editor pane. */}
          <Button variant={creating === "project" ? "primary" : "default"} style={{ textAlign: "center" }}
            onClick={() => setCreating((c) => (c === "project" ? null : "project"))}>
            ＋ New project
          </Button>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: "56vh", overflowY: "auto", marginRight: -4, paddingRight: 4 }}>
            {filteredProjects.map((p) => (
              <ProjectRow key={p.id} name={p.name} selected={p.id === projectId} live={liveByProject.get(p.id) ?? 0}
                onClick={() => pickProject(p.id)} />
            ))}
            {filteredProjects.length === 0 && (
              <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12, padding: "6px 2px" }}>
                {projects.data?.length ? "No projects match the filter." : "No projects yet."}
              </span>
            )}
          </div>
          {(archivedProjects.data?.length ?? 0) > 0 && (
            <ArchivedProjects projects={archivedProjects.data!}
              onRestore={(id) => restoreProject.mutate(id)}
              onDelete={(p) => { const t = window.prompt(deletePrompt(p.name)); if (t === p.name) deleteProject.mutate(p.id); else if (t !== null) window.alert("name did not match — not deleted"); }} />
          )}
        </Panel>

        {/* ── Agents column: the selected project's manage header + its agents ────────────────────── */}
        {selectedProject ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: font.head, fontSize: 15, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedProject.name}</span>
                {(liveByProject.get(selectedProject.id) ?? 0) > 0 && (
                  <span title={`${liveByProject.get(selectedProject.id)} live session${liveByProject.get(selectedProject.id) === 1 ? "" : "s"}`}><Dot tone="phosphor" glow /></span>
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {selectedProject.repoPath && <Chip label="repo" value={<PathTail path={selectedProject.repoPath} />} />}
                {selectedProject.vaultPath && <Chip label="vault" value={<PathTail path={selectedProject.vaultPath} />} />}
              </div>
              <ProjectManage key={selectedProject.id} project={selectedProject}
                liveCount={liveByProject.get(selectedProject.id) ?? 0}
                onSave={(patch) => updateProject.mutate({ id: selectedProject.id, patch })}
                onArchive={() => archiveProject.mutate(selectedProject.id)}
                onDelete={() => deleteProject.mutate(selectedProject.id)}
                saving={updateProject.isPending} archiving={archiveProject.isPending} deleting={deleteProject.isPending} />
            </Panel>

            <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <SectionLabel style={{ margin: 0 }}>Agents</SectionLabel>
                <Button variant={creating === "agent" ? "primary" : "ghost"} style={{ padding: "2px 8px" }}
                  onClick={() => setCreating((c) => (c === "agent" ? null : "agent"))}>＋ New agent</Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: "56vh", overflowY: "auto", marginRight: -4, paddingRight: 4 }}>
                {(agents.data ?? []).map((t) => {
                  const prof = t.profileId ? profiles.data?.find((p) => p.id === t.profileId) ?? null : null;
                  return (
                    <AgentRow key={t.id} name={t.name} selected={t.id === agentId}
                      icon={prof?.icon ?? null} role={prof?.role ?? null} live={liveByAgent.get(t.id) ?? 0}
                      onClick={() => pickAgent(t.id)} />
                  );
                })}
                {(agents.data?.length ?? 0) === 0 && (
                  <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12, padding: "6px 2px" }}>
                    No agents yet — ＋ New agent to define one.
                  </span>
                )}
              </div>
            </Panel>
          </div>
        ) : (
          <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Select a project on the left to manage its agents.</span></Panel>
        )}

        {/* ── Editor pane: create forms (roomy) ⇄ the selected agent's prompt editor ⇄ empty state ── */}
        <Panel style={{ minHeight: "72vh", padding: 6, display: "flex", flexDirection: "column" }}>
          {creating === "project" ? (
            <EditorFrame title="New project" subtitle="a fresh project — repo, board, and starter agents">
              <ProjectForm onCreate={(b) => createProject.mutate(b)} pending={createProject.isPending} onCancel={() => setCreating(null)} />
            </EditorFrame>
          ) : creating === "agent" && selectedProject ? (
            <EditorFrame fill title="New agent" subtitle={`for ${selectedProject.name} — its startup prompt is injected as the first turn of each session`}>
              <AgentForm onCreate={(b) => createAgent.mutate(b)} pending={createAgent.isPending} onCancel={() => setCreating(null)} />
            </EditorFrame>
          ) : selectedAgent ? (
            <AgentEditor key={selectedAgent.id} agent={selectedAgent} profiles={profiles.data ?? []}
              liveCount={liveByAgent.get(selectedAgent.id) ?? 0}
              onAssignProfile={(profileId) => updateAgent.mutate({ id: selectedAgent.id, patch: { profileId } })}
              onSavePrompt={(startupPrompt) => updateAgent.mutate({ id: selectedAgent.id, patch: { startupPrompt } })}
              onDelete={() => deleteAgent.mutate(selectedAgent.id)}
              saving={updateAgent.isPending} deleting={deleteAgent.isPending} />
          ) : (
            <EmptyPane project={!!selectedProject} />
          )}
        </Panel>
      </div>
    </div>
  );
}

// The strong-confirm body for a PERMANENT project delete — names the irreversible cascade and asks the
// human to type the project name back. Shared by the manage panel + the archived-projects list.
function deletePrompt(name: string): string {
  return `PERMANENTLY delete "${name}" and ALL of it — its agents, sessions, tasks, schedules, API keys, runs and saved transcripts. This CANNOT be undone.\n\nType the project name (${name}) to confirm:`;
}

// A path shown tail-first (…/last/two segments) so a long absolute path reads at a glance in a Chip
// without overflowing the narrow column. The full path is the title (hover to read).
function PathTail({ path }: { path: string }) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const tail = parts.slice(-2).join("/");
  return <span title={path}>{parts.length > 2 ? `…/${tail}` : path}</span>;
}

// A selectable list row (project or agent). Its own hover state (mirroring the header ActiveProjectControl
// pattern) gives a quiet panel2 wash on hover; the selected row gets a phosphor left-rule + phosphor text —
// a clear master-list selection without the old wall of identical outlined pills.
function ListRow(
  { selected, onClick, title, children }:
  { selected: boolean; onClick: () => void; title?: string; children: ReactNode },
) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} title={title} aria-pressed={selected}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", cursor: "pointer",
        background: selected || hover ? color.panel2 : "transparent",
        border: "none", borderLeft: `2px solid ${selected ? color.phosphor : "transparent"}`,
        borderRadius: radius.sm, padding: "6px 8px",
        color: selected ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 13,
      }}>
      {children}
    </button>
  );
}

function ProjectRow({ name, selected, live, onClick }: { name: string; selected: boolean; live: number; onClick: () => void }) {
  return (
    <ListRow selected={selected} onClick={onClick} title={name}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {live > 0 && <span title={`${live} live session${live === 1 ? "" : "s"}`}><Dot tone="phosphor" glow /></span>}
    </ListRow>
  );
}

function AgentRow(
  { name, selected, icon, role, live, onClick }:
  { name: string; selected: boolean; icon: string | null; role: string | null; live: number; onClick: () => void },
) {
  return (
    <ListRow selected={selected} onClick={onClick} title={role ? `${name} · ${role}` : name}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {live > 0 && <span title={`${live} live session${live === 1 ? "" : "s"}`}><Dot tone="phosphor" glow /></span>}
      {icon && <span aria-hidden>{icon}</span>}
      {role && <span style={{ fontSize: 10, color: roleColor(role as SessionRole | null), fontFamily: font.mono }}>{roleDisplay(role as SessionRole | null).short}</span>}
    </ListRow>
  );
}

// A titled frame for the editor pane's create surfaces — a small header (title + one-line subtitle) over
// the form body, so the roomy right pane reads as a deliberate "New …" workspace rather than a bare form.
// `fill` lets the body stretch to the pane's full height (a flex column) so a form with a grow-to-fit
// textarea — the create-agent form — actually uses the roomy pane; the default (project form) stays a
// compact, top-aligned column at a comfortable measure. Root is `flex:1` (not `height:100%`): the Editor
// Panel gets its height from `minHeight:72vh` while sitting in an `alignItems:start` grid, so its `height`
// is `auto` and a percentage height would collapse to content — `flex:1` honors the flex min-height.
function EditorFrame({ title, subtitle, children, fill = false }: { title: string; subtitle: string; children: ReactNode; fill?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 8, gap: 12 }}>
      <div>
        <div style={{ fontFamily: font.head, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>{title}</div>
        <div style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12, marginTop: 3 }}>{subtitle}</div>
      </div>
      <div style={fill
        ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", maxWidth: 760 }
        : { maxWidth: 520 }}>{children}</div>
    </div>
  );
}

// The editor pane's resting state — a quiet, on-brand prompt (not a bare muted line). Adapts its hint to
// whether a project is selected (pick an agent) or not (pick a project first).
function EmptyPane({ project }: { project: boolean }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
      <div style={{ fontFamily: font.head, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
        {project ? "No agent selected" : "No project selected"}
      </div>
      <div style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12, maxWidth: 360, lineHeight: 1.6 }}>
        {project
          ? "Select an agent to view and edit its startup prompt, or ＋ New agent to define one."
          : "Select a project on the left to manage its agents, or ＋ New project to create one."}
      </div>
    </div>
  );
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
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>Manage project
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="vault path" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
          <Button variant="primary" disabled={!dirty || saving}
            onClick={() => onSave({ name: name.trim(), vaultPath: vaultPath.trim() })}>{saving ? "Saving…" : "Save changes"}</Button>
          <ReferenceReposEditor project={project} />
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

// The reference-repos list editor (reference-repos epic Phase 4, card f4888775). Edits a project's
// `referenceRepos` — the read-only SIBLING repos a worker may consult, DISTINCT from the one load-bearing
// primary `repoPath` (its own field, shown as a Chip above, never merged into this list). Add / remove
// rows, then Save persists via the phase-2 PATCH /api/projects/:id; the server validates each entry
// (absolute path + existing git repo) and 400s with a clear reason we surface INLINE (not an alert).
// An empty list renders a quiet "none" line, never a phantom blank row — a blank row appears only when
// the human deliberately ＋ Adds one. Blank/whitespace rows are trimmed out at save, so an all-blank add
// is not "dirty" and never round-trips a bogus entry to the validator.
function ReferenceReposEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const saved = project.referenceRepos ?? [];
  const [repos, setRepos] = useState<string[]>(saved);
  const [error, setError] = useState<string | null>(null);
  // The persisted candidate: trimmed, blanks dropped. Dirty (and the payload) both key off this, so a
  // stray empty row neither enables Save nor reaches the server.
  const clean = repos.map((r) => r.trim()).filter(Boolean);
  const dirty = JSON.stringify(clean) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: () => api.updateProject(project.id, { referenceRepos: clean }),
    onMutate: () => setError(null),
    // Sync local rows to what the server actually stored (the source of truth) so `dirty` settles cleanly.
    onSuccess: (updated) => { setRepos(updated.referenceRepos ?? []); qc.invalidateQueries({ queryKey: ["projects"] }); },
    onError: (e) => setError((e as Error).message),
  });

  // Any edit clears a stale server error so it never lingers past the input it referred to.
  const edit = (i: number, v: string) => { setError(null); setRepos((rs) => rs.map((r, j) => (j === i ? v : r))); };
  const remove = (i: number) => { setError(null); setRepos((rs) => rs.filter((_, j) => j !== i)); };
  const add = () => { setError(null); setRepos((rs) => [...rs, ""]); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <div>
        <SectionLabel style={{ margin: 0 }}>Reference repos</SectionLabel>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>read-only sibling repos · absolute git paths</span>
      </div>
      {repos.length === 0 ? (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "2px 0" }}>No reference repos.</span>
      ) : (
        repos.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Input placeholder="/absolute/path/to/repo" value={r} onChange={(e) => edit(i, e.target.value)}
              aria-label={`Reference repo ${i + 1}`} style={{ flex: 1 }} />
            <Button variant="ghost" title="Remove this reference repo" aria-label={`Remove reference repo ${i + 1}`}
              onClick={() => remove(i)} style={{ padding: "4px 9px" }}>✕</Button>
          </div>
        ))
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <Button onClick={add}>＋ Add repo</Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save reference repos"}
        </Button>
      </div>
      {error && (
        <span role="alert" style={{ fontFamily: font.mono, fontSize: 11, color: color.red, lineHeight: 1.5 }}>{error}</span>
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
    <div style={{ marginTop: 2, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
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

function ProjectForm({ onCreate, pending, onCancel }: { onCreate: (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean; presetId: string }) => void; pending: boolean; onCancel: () => void }) {
  const [name, setName] = useState(""), [repoPath, setRepo] = useState(""), [vaultPath, setVault] = useState("");
  const [seedAgents, setSeed] = useState(true);
  // Board preset to seed the new project's columns with. Defaults to Agent Dev so a fresh project keeps
  // today's exact board; any other choice is applied via the atomic columns API right after creation.
  const [presetId, setPreset] = useState(DEFAULT_COLUMN_PRESET_ID);
  const preset = presetById(presetId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="repo path" value={repoPath} onChange={(e) => setRepo(e.target.value)} />
      <Input placeholder="vault path (optional)" value={vaultPath} onChange={(e) => setVault(e.target.value)} />
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
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <Button variant="primary" disabled={!name || !repoPath || pending}
          onClick={() => onCreate({ name, repoPath, vaultPath, seedAgents, presetId })}>{pending ? "Creating…" : "Create project"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AgentForm({ onCreate, pending, onCancel }: { onCreate: (b: { name: string; startupPrompt: string }) => void; pending: boolean; onCancel: () => void }) {
  const [name, setName] = useState(""), [startupPrompt, setPrompt] = useState("");
  // Fills its EditorFrame `fill` body: name at natural height, the prompt textarea grows (`flex:1`) to take
  // the rest of the pane so the roomy Editor pane is actually used, buttons pinned below.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
      <Input placeholder="agent name" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        style={{ flex: 1, minHeight: 200, width: "100%", boxSizing: "border-box", resize: "none", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: 8, fontFamily: font.mono, fontSize: 13, lineHeight: 1.5 }}
        placeholder="startup prompt (injected as the first turn of each new session)"
        value={startupPrompt} onChange={(e) => setPrompt(e.target.value)} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={!name || pending} onClick={() => onCreate({ name, startupPrompt })}>{pending ? "Creating…" : "Create"}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// The selected agent's detail: an editor header (name + profile-assign + delete, all relocated here out of
// the old cramped rail) over the roomy startup-prompt editor. Remounted per agent (key=agent.id) so the
// textarea + assignment reset on switch; after Save the query refetches and `dirty` clears.
function AgentEditor(
  { agent, profiles, liveCount, onAssignProfile, onSavePrompt, onDelete, saving, deleting }:
  { agent: Agent; profiles: { id: string; name: string; role: string | null; icon: string | null }[];
    liveCount: number; onAssignProfile: (profileId: string | null) => void; onSavePrompt: (startupPrompt: string) => void;
    onDelete: () => void; saving: boolean; deleting: boolean },
) {
  const [prompt, setPrompt] = useState(agent.startupPrompt);
  const dirty = prompt !== agent.startupPrompt;
  const live = liveCount > 0;
  // `flex:1` (not `height:100%`) so the editor fills the Editor Panel's `minHeight:72vh`: that Panel sits in
  // an `alignItems:start` grid so its `height` is `auto`, against which a percentage height collapses to
  // content — the flex min-height is what the prompt textarea's own `flex:1` then grows into.
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 8, gap: 10 }}>
      {/* Editor header: identity + profile assignment + delete */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.head, fontSize: 14, color: color.text }}>{agent.name}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
          profile
          {/* Assign / clear the Profile — it supplies the spawn role/rig; the prompt comes from the agent. */}
          <Select value={agent.profileId ?? ""} onChange={(e) => onAssignProfile(e.target.value || null)} style={{ maxWidth: 220 }}>
            <option value="">— none —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.icon ? `${p.icon} ` : ""}{p.name}{p.role ? ` (${p.role})` : ""}</option>
            ))}
          </Select>
        </label>
        {/* Permanently delete this agent (cascades its sessions). Disabled while it has a live session —
            the server blocks it too ("stop the fleet first"). Behind a confirm. */}
        <Button variant="danger" disabled={live || deleting}
          title={live ? "stop the fleet first — this agent has a live session" : "permanently delete this agent and its sessions"}
          onClick={() => { if (window.confirm(`Permanently delete agent "${agent.name}" and ALL its sessions? This cannot be undone.`)) onDelete(); }}>
          {deleting ? "Deleting…" : "Delete agent"}
        </Button>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>Startup prompt</span>
        <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>injected as the first turn of each new session</span>
      </div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: "100%", boxSizing: "border-box", resize: "none",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
        }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => onSavePrompt(prompt)}>{saving ? "Saving…" : "Save"}</Button>
        {dirty
          ? <Button onClick={() => setPrompt(agent.startupPrompt)}>Reset</Button>
          : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
      </div>
    </div>
  );
}
