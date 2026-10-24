import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { COLUMN_PRESETS, DEFAULT_COLUMN_PRESET_ID, presetById, presetToDesired, profileRoleBindsAsPlainSession, type Agent, type Project } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { useFrameOwnsNodeIdentity } from "../lib/atlasNodeHead";
import { Panel, Button, Input, Select, SectionLabel, Chip, Dot, PresetAccentDots } from "../components/ui";
// The agent editor, the create form and the three agent writes all live in components/agentEditor.tsx
// since card 318b5a21 — the Atlas Agents node mounts the SAME ones. This page keeps the frame (the
// three-pane master→list→detail) and supplies the callbacks; it owns no copy of the form.
import { AgentEditor, AgentForm, PLAIN_BIND_GROUP_LABEL, useAgentWrites } from "../components/agentEditor";
// The project lifecycle panel, the two repo-list editors and the four project writes left for
// components/projectLifecycle.tsx on card c9b78d80, for the same reason — the Atlas project node's
// Settings tab mounts the SAME ones. This page keeps its rail/column frame and the archived footer.
import { ProjectManage, deletePrompt, useProjectLifecycleWrites } from "../components/projectLifecycle";
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
  const ownIdentity = !useFrameOwnsNodeIdentity();
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
  // Edition discovery (the SAME shared query key Platform.tsx/Skills.tsx use → one cached fetch): the
  // dev/self-host edition has the reserved Platform home; an end-user npm install gets `project: null`
  // back (card 8d82be67 — the route is always 200). Gates which profiles the agent bind-dropdown offers
  // (see AgentEditor). `isSuccess &&` holds it false until the query settles, so an end user never
  // flashes a dev-layer rig mid-load.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = platformHome.isSuccess && !!platformHome.data?.project;
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

  // Resumable retry across a partial failure (card 5ccd5ee3): if the columns/agent-seed steps below fail
  // AFTER the project was already created, re-clicking "Create project" must not create a SECOND project
  // on the same repo. This ref stashes the project created by the most recent attempt, keyed by that
  // attempt's own create inputs — a retry with the SAME inputs reuses it and only re-runs the remaining
  // steps; a changed input (the user edited the form after a failure) invalidates the stash, forcing a
  // fresh create. It's a ref (not state) purely as in-memory bookkeeping across retries within this mount,
  // and does NOT survive a page reload/remount — acceptable here because the ["projects"] invalidation
  // right after creation (below) means a reloaded user at least SEES the half-created project in the
  // list, rather than it being invisible and inviting a blind re-create.
  const createdProjectRef = useRef<{ key: string; project: Project } | null>(null);
  const createProject = useMutation({
    mutationFn: async (b: { name: string; repoPath: string; vaultPath: string; seedAgents: boolean; presetId: string }) => {
      const createKey = JSON.stringify({ name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath });
      let project: Project;
      if (createdProjectRef.current && createdProjectRef.current.key === createKey) {
        project = createdProjectRef.current.project;
      } else {
        project = await api.createProject({ name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath });
        createdProjectRef.current = { key: createKey, project };
        // The project is real server-side the instant this call returns — invalidate NOW, not only in
        // onSuccess below, so a subsequent columns/agent-seed failure doesn't leave it invisible in the list.
        qc.invalidateQueries({ queryKey: ["projects"] });
      }
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
  // The three agent writes, from the shared hook — the invalidations live there, this page supplies
  // only what happens AFTERWARDS in its own pane. Select the new agent so the editor pane switches
  // straight to its prompt: the create form was the pane's transient occupant; hand it back to the
  // freshly-made agent. On a delete, drop the selection if it was the agent that went.
  const { create: createAgent, update: updateAgent, remove: deleteAgent } = useAgentWrites(projectId, {
    onCreated: (agent) => { setAgentId(agent.id); setCreating(null); },
    onDeleted: (id) => { if (agentId === id) setAgentId(null); },
  });
  // --- HUMAN-only project/agent management (rename / archive / restore / PERMANENT delete + agent
  // delete). The four project writes come from the shared hook — the invalidations live there, this page
  // supplies only what happens AFTERWARDS: a project that just stopped existing can't stay selected, and
  // the agent selection below it goes with it. The server enforces the reserved-home + live-session
  // guards and returns the reason, surfaced verbatim via the *Err clients. ---
  const clearSelectionIfGone = (id: string) => { if (projectId === id) { setProjectId(""); setAgentId(null); } };
  const {
    update: updateProject, archive: archiveProject, restore: restoreProject, remove: deleteProject,
  } = useProjectLifecycleWrites({ onArchived: clearSelectionIfGone, onDeleted: clearSelectionIfGone });

  const selectedProject = projects.data?.find((p) => p.id === projectId) ?? null;
  const selectedAgent = agents.data?.find((t) => t.id === agentId) ?? null;

  const pickProject = (id: string) => { setProjectId(id); setAgentId(null); setCreating(null); };
  const pickAgent = (id: string) => { setAgentId(id); setCreating(null); };

  const q = filter.trim().toLowerCase();
  const filteredProjects = (projects.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* The frame's crumbs and node head already say "Projects" inside Atlas, so this row goes there
          (card a7f23a2f) — and its copy points at "Terminals and Overview", two destinations the Atlas
          tree no longer has. Unchanged under the classic shell, where both still hold. */}
      {ownIdentity && (
        <div data-testid="page-identity" style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <SectionLabel style={{ margin: 0 }}>Projects</SectionLabel>
          <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>
            create and manage projects and their agents · live sessions live on Terminals and Overview
          </span>
        </div>
      )}

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
                saving={updateProject.isPending} archiving={archiveProject.isPending} deleting={deleteProject.isPending}
                // Scoped to the CURRENTLY selected project, not just "a save succeeded": `updateProject`
                // is owned by this parent component, which does not remount on project switch (only the
                // child ProjectManage below does, via key={selectedProject.id}) — without this check, a
                // warning from saving project A keeps rendering after switching to project B.
                staleStartupPrompts={updateProject.isSuccess && updateProject.data?.id === selectedProject.id ? updateProject.data.staleStartupPrompts : undefined} />
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
            <AgentEditor key={selectedAgent.id} agent={selectedAgent} profiles={profiles.data ?? []} isDev={isDev}
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
  // The badge states the BOUND PROFILE's role — but a profile confers only manager / worker / assistant,
  // so a row carrying any other role (setup, operator, platform, …) advertises powers the spawn silently
  // drops. Flag it where the claim is made (card 57deed24): the editor note's amber △ leads, the role
  // label goes MUTED, and the row tooltip carries the one shared wording.
  // The label is muted rather than recolored amber deliberately — `operator` and `setup` ALREADY render
  // amber as their own tone, so tinting the label would be invisible on exactly the two roles that carry
  // this flag most often, and would overload one colour with two meanings. Dropping the label out of its
  // saturated tone reads as "recorded, not in force" against EVERY role's colour, which is the point.
  // `profileRoleBindsAsPlainSession` answers CONFERRAL — never `isDevLayerRole`, which answers picker
  // VISIBILITY and is false for setup / operator / workspace-auditor (the c40489c6 trap).
  const roleKey = role as SessionRole | null;
  const bindsPlain = profileRoleBindsAsPlainSession(roleKey);
  return (
    <ListRow selected={selected} onClick={onClick}
      title={role ? `${name} · ${role}${bindsPlain ? ` (${PLAIN_BIND_GROUP_LABEL})` : ""}` : name}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {live > 0 && <span title={`${live} live session${live === 1 ? "" : "s"}`}><Dot tone="phosphor" glow /></span>}
      {icon && <span aria-hidden>{icon}</span>}
      {role && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: bindsPlain ? color.textMuted : roleColor(roleKey), fontFamily: font.mono }}>
          {bindsPlain && <span data-testid="agent-row-plain-bind" aria-hidden style={{ color: color.amber }}>△</span>}
          {roleDisplay(roleKey).short}
        </span>
      )}
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
