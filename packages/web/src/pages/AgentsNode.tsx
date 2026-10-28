import { useState } from "react";
import { Link } from "react-router-dom";
import { useActiveProject } from "../lib/activeProject";
import { useAgentRoster } from "../lib/atlasAgents";
import { AgentEditDialog, AgentRosterCard, RosterEmpty, SpawnTermRow, WorkersDispatchedNote } from "../components/atlasAgents";
import { ProjectSchedules } from "../components/projectSchedules";
import { Badge, Button, Panel, SectionLabel, StatusPill } from "../components/ui";
import { RoleBadge } from "../lib/roleDisplay";
import { plural } from "../lib/atlasHome";
import { goLiveSessionPill } from "../lib/sessions";
import { color, font } from "../theme";

// THE AGENTS NODE — card c6160c7d (Atlas P2-2), the project tier's roster at full size.
//
// This node exists because round 4 found the gap the owner named: "how are the spawnable agents
// spawned for projects? I dont see a UI element for that?" (card 939922ee). The band panel on the
// project node answers it at a glance; THIS page answers it properly — every spawnable agent at
// full size, every worker rig named rather than silently filtered away, and a plain statement of
// what a spawn actually does, which is the question a spawn button never answers on its own.
//
// Agent CRUD (create / re-profile / re-prompt / delete) IS here as of card 318b5a21 — the parity row
// c6160c7d could not carry. It arrived the only way it was ever allowed to: the editor that lived on
// the Projects page was MOVED to components/agentEditor.tsx and is mounted here, in this node's own
// dialog frame. There is one editor, not two — which is why retiring that page (card 5afd71bd) cost
// Atlas no agent-definition surface: it had already left.
//
// @decision 318b5a21 — never build a second editor here. Mount components/agentEditor.tsx's.

export default function AgentsNode() {
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;
  const { roster, isLoading } = useAgentRoster(projectId);
  // `null` = closed; `{ agentId: null }` = the create form; `{ agentId: "…" }` = that agent's editor.
  // A wrapper object rather than a bare `string | null`, because `null` has to mean two things.
  const [editing, setEditing] = useState<{ agentId: string | null } | null>(null);
  // Every agent in this project, spawnable rigs and worker rigs alike — what the Schedules panel
  // below filters the god-eye schedule list down to. Declared ABOVE the `!projectId` early return
  // with the other hooks' results, so both render paths read the same roster.
  const scheduleAgents = [...roster.spawnable, ...roster.workers].map((entry) => entry.agent);

  if (!projectId) {
    return (
      <Panel style={{ maxWidth: 560, padding: "18px 20px" }} data-testid="atlas-agents-no-project">
        <p style={{ margin: 0, color: color.textDim, fontFamily: font.mono, fontSize: 13, lineHeight: 1.7 }}>
          No project is active yet. Pick one in the entity tree — this node lists whichever project the
          tree has open.
        </p>
      </Panel>
    );
  }

  return (
    <div className="loom-atlas-home" data-testid="atlas-agents-node">
      <section className="loom-atlas-primary">
        <div className="loom-atlas-primaryhead">
          <span className="loom-atlas-primarylbl">Spawnable agents</span>
          {/* Its own class, not the band's shared `loom-bandcount`: that one is `nowrap` because
              every other use of it is a bare number, and this one carries a project name that can
              be arbitrarily long — on a phone it pushed the head's own button off the column. */}
          <span className="loom-bandcount loom-agentscount" data-testid="atlas-agents-count">
            {isLoading ? "…" : plural(roster.spawnable.length, "agent")}
            {project ? ` in ${project.name}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          {/* Define an agent HERE now, on the node that lists them (card 318b5a21). The primary, so
              it reads ahead of the exit beside it: creating an agent is the action, leaving is not. */}
          <Button variant="primary" className="loom-bandlink" data-testid="atlas-agents-new"
            title={project ? `Define a new agent in ${project.name}` : "Define a new agent"}
            onClick={() => setEditing({ agentId: null })}>＋ New agent</Button>
          {/* The exit SURVIVES the editor landing here (card 318b5a21), and survived the Projects
              page being retired (card 5afd71bd) — but its destination changed, because what it is an
              exit TO did. This node is scoped to ONE project's roster, so the thing a reader wants
              from here is another project's roster; the Projects page used to be the only surface
              listing them all, and the Workspace node is now, as its Projects grid plus the tree's
              own project tier. Opening a project there scopes to it, and this node is its Agents tab.
              Named for what it does, not for where it goes, so the label is unchanged. */}
          <Link to="/home" className="loom-btn loom-btn-default loom-bandlink"
            data-testid="atlas-agents-define" title="See every project on the Workspace node">
            All projects <span aria-hidden>↗</span>
          </Link>
        </div>

        {roster.spawnable.length === 0
          ? <RosterEmpty workers={roster.workers} projectName={project?.name} />
          : (
            <div className="loom-agentgrid" data-testid="atlas-agent-grid">
              {roster.spawnable.map((entry) => (
                <AgentRosterCard key={entry.agent.id} entry={entry}
                  onEdit={() => setEditing({ agentId: entry.agent.id })} />
              ))}
            </div>
          )}
        <WorkersDispatchedNote workers={roster.workers} />
      </section>

      <div className="loom-agentsplit">
        <WorkerRigs roster={roster} onEdit={(id) => setEditing({ agentId: id })} />
        <WhatASpawnDoes />
      </div>

      {/* This project's cron schedules (card 102bc915) — the one surface classic /overview carried
          that no Atlas project-node tab did. It lands HERE rather than in a band panel or a tab of
          its own for two reasons. A Schedule is keyed to an AGENT (`s.agentId`), so this node is
          already the surface that owns the things it is about; and the band is a FIXED five-column
          grid whose tracks measure 283.9 / 244.7 / 195.8 / 195.8 / 195.8 px at 1440 — a sixth panel
          is not additive, it shrinks all five (to 239.3 / 206.3 / 165.1 ×3, measured). So the home
          tab is untouched and nothing the owner sees there moves.

          The id set is the roster union, NOT a second api.agents read: `useAgentRoster` partitions
          every one of this project's agents into exactly these two lists, so the union IS the set
          Overview builds from `agents.data` — same membership, no extra request, and it cannot drift
          from the roster rendered directly above it. */}
      <ProjectSchedules
        agentIds={new Set(scheduleAgents.map((a) => a.id))}
        agentName={(id) => scheduleAgents.find((a) => a.id === id)?.name ?? id.slice(0, 8)} />

      {editing && (
        <AgentEditDialog projectId={projectId} agentId={editing.agentId} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/** The worker rigs, as DEFINITIONS. They carry a live pill because a dispatched worker is a real
 *  running thing worth seeing from here — and, since card 318b5a21, an Edit, because the footer has
 *  always said "edit the rig here" and a worker rig is an agent like any other. Still no SPAWN and no
 *  STOP: a hand-spawned worker gets a branch nobody is reviewing, which is the lifecycle control
 *  nothing a human presses here would make correct. */
function WorkerRigs({ roster, onEdit }: {
  roster: ReturnType<typeof useAgentRoster>["roster"];
  onEdit: (agentId: string) => void;
}) {
  return (
    <Panel style={{ padding: "10px 12px 12px" }} data-testid="atlas-worker-rigs">
      <div className="loom-bandhead">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>Worker rigs</SectionLabel>
        <span className="loom-bandcount">manager-dispatched</span>
      </div>
      <div style={{ paddingTop: 8 }}>
        {roster.workers.length === 0 && (
          <p className="loom-bandempty">No worker rigs defined in this project.</p>
        )}
        {roster.workers.map((w) => (
          <div key={w.agent.id} className="loom-workerrig" data-testid={`atlas-worker-rig-${w.agent.id}`}>
            <RoleBadge role={w.role} />
            <strong className="loom-agentrow-name">{w.agent.name}</strong>
            <span className="loom-workerrig-rig">
              {[w.profileName, ...w.capabilities].filter(Boolean).join(" · ")}
            </span>
            <span style={{ flex: 1 }} />
            {w.session
              ? <WorkerRigPill session={w.session} />
              : <Badge tone="muted">idle</Badge>}
            <Button variant="ghost" data-testid={`atlas-agent-edit-${w.agent.id}`}
              title={`Edit ${w.agent.name} — its rig, startup prompt, or delete it`}
              onClick={() => onEdit(w.agent.id)}>Edit</Button>
          </div>
        ))}
        <p className="loom-bandfoot" style={{ fontFamily: font.mono }}>
          A manager dispatches a worker onto its own worktree branch. Edit the rig here; dispatch it
          from the manager.
        </p>
      </div>
    </Panel>
  );
}

/** A dispatched worker's pill, through the SAME `goLiveSessionPill` every other agent readout uses —
 *  so a worker mid-startup reads "starting", not a settled "live" (card 318b5a21). */
function WorkerRigPill({ session }: { session: NonNullable<ReturnType<typeof useAgentRoster>["roster"]["workers"][number]["session"]> }) {
  const pill = goLiveSessionPill(session);
  return <StatusPill tone={pill.pending ? "amber" : "phosphor"} glow={pill.pending} label={pill.label} />;
}

/** What pressing the button does, in the product's own terms. Static copy, deliberately: it states
 *  the spawn contract (profile role applies server-side, the override is per-spawn, the guard keys
 *  off liveness) that the controls themselves can only imply. */
function WhatASpawnDoes() {
  return (
    <Panel style={{ padding: "10px 12px 12px" }} data-testid="atlas-spawn-explainer">
      <div className="loom-bandhead">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>What a spawn does</SectionLabel>
      </div>
      <div style={{ paddingTop: 8 }}>
        <SpawnTermRow term="Primary">
          Spawns from the agent's <strong>rig</strong> — the rig's role is what applies server-side.
        </SpawnTermRow>
        <SpawnTermRow term="Override">
          The ▾ picks a role for <em>this spawn only</em>: from profile, manager, or plain. It never
          edits the rig.
        </SpawnTermRow>
        <SpawnTermRow term="Guard">
          A manager that is already live <em>or still starting</em> shows <strong>Stop</strong>, never a
          second spawn.
        </SpawnTermRow>
        <SpawnTermRow term="Then">
          A session starts under this project and joins the fleet.
        </SpawnTermRow>
      </div>
    </Panel>
  );
}
