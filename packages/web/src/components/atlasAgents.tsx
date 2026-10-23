// The Atlas agent-roster kit — card c6160c7d (Atlas build plan P2-2). One roster behind three
// mounts: the project node's band panel, the Agents node page, and the tree's quick-spawn dialog.
//
// The ONE reason this is a component kit rather than three local renderers: the spawn controls and
// the go-live guard must be IDENTICAL wherever they appear. Round 3 drew a spawn pop-over that
// listed worker agents as spawnable and carried no guard at all (card 939922ee) — a second copy of
// this logic is exactly how that happens, so there is one `useSpawnActions` and one `AgentActions`,
// and a mount chooses only how much room to give them.
//
// ⛔ Nothing here fetches a roster. lib/atlasAgents.ts composes it off existing `api.*` calls and the
// mounts hand these components finished rows. The two MUTATIONS do live here — they are the actions,
// and `api.startSession`/`api.stopSession` are the same two calls pages/Overview.tsx already fires.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { AgentEditor, AgentForm, useAgentWrites } from "./agentEditor";
import { SpawnControls } from "./SpawnControls";
import { Button, Panel, SectionLabel, StatusPill } from "./ui";
import { RoleBadge } from "../lib/roleDisplay";
import { errorText } from "../lib/loopbackCredential";
import { useActiveProject } from "../lib/activeProject";
import { goLiveHeldControl, goLiveSessionPill } from "../lib/sessions";
import { sessionVitals, useAgentRoster, type RosterAgent } from "../lib/atlasAgents";
import { color, radius } from "../theme";

/**
 * The two writes an Atlas spawn surface can make, wired exactly as pages/Overview.tsx's own
 * `AgentControl` wires them: a spawn that invalidates `["allSessions"]`, and a GRACEFUL stop (a
 * clean Ctrl-C, resumable) that invalidates the same key.
 *
 * `meta: { inlineError: true }` on the spawn is carried over too — a refused spawn belongs beside
 * the button that asked for it, not in the global mutation-error toast.
 */
function useSpawnActions(agentId: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const spawn = useMutation({
    meta: { inlineError: true },
    mutationFn: (role?: "manager" | "plain") => api.startSession(agentId, role),
    onSuccess: invalidate,
  });
  // `inlineError` on BOTH, unlike pages/Overview.tsx's own pair, which carries it on the spawn only
  // and lets a refused stop fall through to the global mutation-error modal. A refused stop belongs
  // beside the button that asked for it for the same reason a refused spawn does — and the two
  // settings must agree, or the row draws an inline message with a modal stacked over it.
  const stop = useMutation({
    meta: { inlineError: true },
    mutationFn: (sessionId: string) => api.stopSession(sessionId, "graceful"),
    onSuccess: invalidate,
  });
  return { spawn, stop };
}

/**
 * The control cluster for one agent: either the spawn split-button, or — when the go-live guard is
 * holding — the disabled "Live" plus a graceful Stop.
 *
 * The split button is `components/SpawnControls.tsx` VERBATIM, the same component the classic
 * Overview and the Workspace sessions header drive, so the primary's "Spawn · <role>" label, the ▾
 * role override's three labels and its left anchoring (card 74915cad) are the same everywhere.
 */
export function AgentActions({ entry, onEdit }: { entry: RosterAgent; onEdit?: () => void }) {
  const { spawn, stop } = useSpawnActions(entry.agent.id);
  return (
    <div className="loom-agentrow-actions" data-testid={`atlas-agent-actions-${entry.agent.id}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {entry.managerLive && entry.session ? (
          // The testid stays `…-live-…` whatever the label: it addresses THE HELD CONTROL, and a
          // `starting` manager is held for the same reason a live one is (card 318b5a21).
          <Button variant="primary" disabled title={goLiveHeldControl(entry.session).title}
            data-testid={`atlas-agent-live-${entry.agent.id}`}>{goLiveHeldControl(entry.session).label}</Button>
        ) : (
          <SpawnControls profileRole={entry.role} pending={spawn.isPending}
            onSpawn={(r) => spawn.mutate(r)} />
        )}
        {entry.managerLive && (
          <Button variant="danger" disabled={stop.isPending}
            data-testid={`atlas-agent-stop-${entry.agent.id}`}
            title="Stop this session — graceful Ctrl-C, clean and resumable"
            onClick={() => stop.mutate(entry.session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
        {/* ALWAYS enabled, including behind the go-live guard: editing an agent's DEFINITION is not a
            lifecycle action, and a running manager is exactly the one whose prompt you most often
            want to correct. The delete inside the editor is what carries the live-session guard. */}
        {onEdit && (
          <Button variant="ghost" data-testid={`atlas-agent-edit-${entry.agent.id}`}
            title={`Edit ${entry.agent.name} — its rig, startup prompt, or delete it`}
            onClick={onEdit}>Edit</Button>
        )}
      </div>
      {spawn.isError && <span className="loom-agentrow-err">{errorText(spawn.error)}</span>}
      {stop.isError && <span className="loom-agentrow-err">{errorText(stop.error)}</span>}
    </div>
  );
}

/** Name, rig badge and live pill — the identity half of every roster mount, so a row in a 250px
 *  band column and a card on the node page introduce the agent the same way. */
function AgentIdentity({ entry }: { entry: RosterAgent }) {
  const s = entry.session;
  const pill = s ? goLiveSessionPill(s) : null;
  return (
    <>
      <div className="loom-agentrow-head">
        <RoleBadge role={entry.role} />
        <strong className="loom-agentrow-name" title={entry.agent.name}>{entry.agent.name}</strong>
        <span style={{ flex: 1 }} />
        {pill && <StatusPill tone={pill.pending ? "amber" : "phosphor"} glow={pill.pending} label={pill.label} />}
      </div>
      {/* The `title` matters here: a band column is ~250px, so this line ellipsises there while the
          node page shows it whole. The hover is what makes the truncated form still answerable.
          The empty-vitals fallback is the PILL'S OWN label, never a hardcoded "live": a session that
          has not taken a turn yet reports no gen/turns/context, and a `starting` row is exactly that
          — so the literal printed "live" directly under a pill reading "starting" (card 318b5a21). */}
      <span className="loom-agentrow-meta" title={s ? sessionVitals(s) : rigLine(entry)}>
        {s ? (sessionVitals(s) || pill!.label) : rigLine(entry)}
      </span>
    </>
  );
}

/** "Orchestrator rig · browser" / "no rig · plain session". The one line that answers "what will
 *  this button actually start", which is the question the whole card exists to answer. Kept short
 *  enough to survive a band column rather than written for the full-width card and truncated there. */
function rigLine(entry: RosterAgent): string {
  if (!entry.profileName) return "no rig · plain session";
  return [entry.profileName, ...entry.capabilities].join(" · ");
}

/** The compact roster row — the band panel and the quick-spawn dialog. Identity over actions in one
 *  narrow column, because a ~250px band column cannot put them on one line without the split button
 *  losing its label to an ellipsis. */
export function AgentRosterRow({ entry }: { entry: RosterAgent }) {
  return (
    <div className="loom-agentrow" data-testid={`atlas-agent-row-${entry.agent.id}`}>
      <AgentIdentity entry={entry} />
      <AgentActions entry={entry} />
    </div>
  );
}

/** The full-size roster card — the Agents node page, where there is room for the rig line AND the
 *  agent's own description of what it is for. `onEdit` is the node's editor hook; the band row and
 *  the quick-spawn dialog deliberately pass none (a 250px column has no room, and a spawn pop-over
 *  is not where a definition gets rewritten). */
export function AgentRosterCard({ entry, onEdit }: { entry: RosterAgent; onEdit?: () => void }) {
  return (
    <Panel className="loom-agentcard" data-testid={`atlas-agent-card-${entry.agent.id}`}>
      <AgentIdentity entry={entry} />
      {entry.session && <span className="loom-agentrow-meta">{rigLine(entry)}</span>}
      <AgentActions entry={entry} onEdit={onEdit} />
    </Panel>
  );
}

/**
 * The line that answers the next question. Pinned to the bottom of whatever scrolls above it
 * (`position: sticky`), because "where did Dev go?" is asked precisely when the roster is long
 * enough to scroll — the moment a non-sticky note would be out of view.
 */
export function WorkersDispatchedNote({ workers }: { workers: RosterAgent[] }) {
  if (workers.length === 0) return null;
  const names = workers.map((w) => w.agent.name).join(" · ");
  return (
    <p className="loom-agentnote" data-testid="atlas-agents-worker-note">
      <span className="loom-agentnote-names" title={names}>{names}</span>
      {" "}are <strong>dispatched</strong> by a manager, never spawned here.
    </p>
  );
}

/** A roster with nothing in it says which of the two reasons applies, because they need different
 *  answers: define an agent, or dispatch a worker from a manager. */
export function RosterEmpty({ workers, projectName }: { workers: RosterAgent[]; projectName?: string }) {
  return (
    <p className="loom-bandempty" data-testid="atlas-agents-empty">
      {workers.length > 0
        ? `Every agent${projectName ? ` in ${projectName}` : ""} is a worker rig, and a manager dispatches those. Nothing to spawn by hand.`
        : `No agents defined${projectName ? ` in ${projectName}` : ""} yet.`}
    </p>
  );
}

// ── The quick-spawn dialog ─────────────────────────────────────────────────────────────────────

/**
 * Spawn without first navigating anywhere — the `＋` on the Agents tree node opens this.
 *
 * The trigger renders no dialog until it is pressed, and the dialog is what reads the roster — so
 * the tree, which is mounted on EVERY Atlas route, issues no agent/profile request of its own until
 * someone actually asks to spawn something.
 *
 * Always visible, muted at rest — not hover-only as the mockup drew it. This is the one control
 * that answers "how do I spawn an agent?", the question that opened this card; an affordance that
 * exists only under a pointer cannot answer it on a touch screen, and is the last thing a reader
 * finds on a desktop.
 */
export function AgentsQuickSpawn({ projectId, projectName, testId = "atlas-quickspawn", trigger = "plus" }: {
  projectId: string;
  projectName?: string;
  /**
   * The testid STEM for this trigger and the dialog it opens (`<stem>-open` / `<stem>`). Defaulted,
   * not required, so the Agents-node mount keeps its original ids — but the PROJECT tree rows (card
   * 318b5a21) must pass their own: a workspace has many project rows, so one shared id would make
   * every `getByTestId` in the suite ambiguous the moment a second project exists.
   */
  testId?: string;
  /**
   * How the trigger draws itself (card 5968d7e0). `"plus"` is the tree's bare `＋`; `"button"` is the
   * node head's labelled `Spawn +`, which sits in an action cluster where a lone glyph would read as
   * decoration rather than the node's primary action. Defaulted, so both tree mounts are byte-
   * identical — this prop adds a SECOND trigger shape, never a second dialog or a second guard.
   */
  trigger?: "plus" | "button";
}) {
  const [open, setOpen] = useState(false);
  const label = projectName ? `Spawn an agent in ${projectName}` : "Spawn an agent";
  return (
    <>
      {trigger === "button" ? (
        <Button variant="primary" data-testid={`${testId}-open`} aria-label={label} title={label}
          aria-expanded={open} onClick={() => setOpen(true)}>
          Spawn <span aria-hidden>+</span>
        </Button>
      ) : (
        <button type="button" className="loom-atlas-plus" data-testid={`${testId}-open`}
          aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(true)}>+</button>
      )}
      {open && (
        <QuickSpawnDialog projectId={projectId} testId={testId}
          title={projectName ? `Spawn in ${projectName}` : "Spawn an agent"}
          onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/**
 * The scrim + panel every Atlas agent dialog is drawn in, and the Escape handler that closes it.
 *
 * @decision c6160c7d — a CENTRED DIALOG, never a pop-over anchored to the tree row. The tree body
 * scrolls, and a non-`visible` overflow on one axis computes to `auto` on the other, so an
 * absolutely-positioned panel would be clipped on BOTH.
 */
function AtlasAgentDialog({ testId, label, width, maxHeight, onClose, children }: {
  testId: string;
  label: string;
  width: string;
  maxHeight: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} role="dialog" aria-modal aria-label={label} data-testid={testId}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "10vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width, maxHeight, background: color.panel,
          border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: 14,
          display: "flex", flexDirection: "column", gap: 10, boxSizing: "border-box" }}>
        {children}
      </div>
    </div>
  );
}

function QuickSpawnDialog({ projectId, title, testId, onClose }: {
  projectId: string;
  title: string;
  testId: string;
  onClose: () => void;
}) {
  const { roster, isLoading } = useAgentRoster(projectId);
  const { setProjectId } = useActiveProject();
  return (
    <AtlasAgentDialog testId={testId} label={title} width="min(560px, 92vw)" maxHeight="76vh" onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>{title}</SectionLabel>
        <span style={{ flex: 1 }} />
        {/* The Agents node is scoped to the ACTIVE project, so this exit re-scopes on its way there —
            otherwise a reader who opened a sibling project's row `＋` and pressed Roster would land on
            a different project's roster than the one the dialog just showed them. Re-scoping here is
            correct precisely because it is an explicit navigation, unlike opening the dialog itself,
            which must leave the active project alone. */}
        <Link to="/agents" onClick={() => { setProjectId(projectId); onClose(); }}
          className="loom-btn loom-btn-default loom-bandlink"
          data-testid={`${testId}-roster`}>Roster <span aria-hidden>↗</span></Link>
        <Button variant="ghost" data-testid={`${testId}-close`} aria-label="Close the spawn panel"
          title="Close" onClick={onClose} style={{ padding: "0 8px", lineHeight: 1.2 }}>×</Button>
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }}>
        {isLoading && <p className="loom-bandempty">Reading the roster…</p>}
        {!isLoading && roster.spawnable.length === 0 && <RosterEmpty workers={roster.workers} />}
        {!isLoading && roster.spawnable.map((entry) => <AgentRosterRow key={entry.agent.id} entry={entry} />)}
      </div>
      <WorkersDispatchedNote workers={roster.workers} />
    </AtlasAgentDialog>
  );
}

// ── The agent editor dialog (card 318b5a21) ────────────────────────────────────────────────────

/**
 * Agent CRUD on the Agents node — the SAME editor pages/Projects.tsx mounts, in this node's own
 * dialog frame. `agentId: null` is CREATE.
 *
 * It re-resolves the agent from the `["agents", projectId]` cache on every render rather than taking
 * an `Agent` object from its caller: after an assign-profile write the caller's row is a stale
 * snapshot, and the bind `<select>` reads `agent.profileId` — so a captured object would leave the
 * dropdown showing the OLD rig until the dialog was reopened.
 *
 * ⛔ This dialog mounts no roster and no spawn control. Agent definition and agent lifecycle are
 * different jobs, and a Delete sitting next to a Spawn is a mis-click away from the wrong one.
 */
export function AgentEditDialog({ projectId, agentId, onClose }: {
  projectId: string;
  agentId: string | null;
  onClose: () => void;
}) {
  // `editing` tracks which agent the dialog is on, so a CREATE can hand off to the fresh agent's own
  // editor without the host having to re-render the dialog around it.
  const [editing, setEditing] = useState<string | null>(agentId);
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  // Edition discovery, off the SAME shared key pages/Projects.tsx reads it from — one cached fetch
  // for the whole app. It gates which rigs the bind dropdown offers; `isSuccess &&` holds it false
  // until the query settles so an end user never flashes a dev-layer rig mid-load.
  const platformHomeQ = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const isDev = platformHomeQ.isSuccess && !!platformHomeQ.data?.project;
  const { create, update, remove } = useAgentWrites(projectId, {
    onCreated: (agent) => setEditing(agent.id),
    onDeleted: onClose,
  });
  const agent = editing ? agentsQ.data?.find((a) => a.id === editing) ?? null : null;
  // The delete guard's own count — `processState === "live"` here, NOT `holdsGoLiveSlot`: this is not
  // the go-live guard, it mirrors what the DAEMON refuses a delete for, and widening it client-side
  // would disable a button the server would have allowed.
  const liveCount = (sessionsQ.data ?? []).filter((s) => s.agentId === editing && s.processState === "live").length;
  const creating = editing === null;
  const title = creating ? "New agent" : "Edit agent";
  return (
    <AtlasAgentDialog testId="atlas-agent-editor" label={title} width="min(760px, 94vw)" maxHeight="82vh" onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>{title}</SectionLabel>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" data-testid="atlas-agent-editor-close" aria-label="Close the agent editor"
          title="Close" onClick={onClose} style={{ padding: "0 8px", lineHeight: 1.2 }}>×</Button>
      </div>
      {/* A REAL `minHeight`, not just `flex:1`. The panel above is content-sized (its own `maxHeight`
          is a cap, not a height), so a `flex:1` child inside it resolves to its content — which is
          what collapsed the prompt textarea to a single line the first time this was eyeballed. The
          floor is what AgentEditor's own `flex:1` textarea then grows into. */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: "min(440px, 50vh)", flex: 1, overflowY: "auto" }}>
        {creating ? (
          <AgentForm onCreate={(b) => create.mutate(b)} pending={create.isPending} onCancel={onClose} />
        ) : agent ? (
          <AgentEditor key={agent.id} agent={agent} profiles={profilesQ.data ?? []} isDev={isDev}
            liveCount={liveCount}
            onAssignProfile={(profileId) => update.mutate({ id: agent.id, patch: { profileId } })}
            onSavePrompt={(startupPrompt) => update.mutate({ id: agent.id, patch: { startupPrompt } })}
            onDelete={() => remove.mutate(agent.id)}
            saving={update.isPending} deleting={remove.isPending} />
        ) : (
          // Not "loading": the agent may equally have been deleted from another surface while this
          // was open, and the editor has nothing to show either way.
          <p className="loom-bandempty" data-testid="atlas-agent-editor-gone">
            {agentsQ.isPending ? "Reading the agent…" : "That agent is no longer in this project."}
          </p>
        )}
      </div>
    </AtlasAgentDialog>
  );
}

/** A labelled pair for the "what a spawn does" panel — a term and the sentence that defines it. */
export function SpawnTermRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="loom-spawnterm">
      <span className="loom-spawnterm-t">{term}</span>
      <span className="loom-spawnterm-d">{children}</span>
    </div>
  );
}

