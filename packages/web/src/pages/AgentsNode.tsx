import { Link } from "react-router-dom";
import { useActiveProject } from "../lib/activeProject";
import { useAgentRoster } from "../lib/atlasAgents";
import { AgentRosterCard, RosterEmpty, SpawnTermRow, WorkersDispatchedNote } from "../components/atlasAgents";
import { Badge, Panel, SectionLabel, StatusPill } from "../components/ui";
import { RoleBadge } from "../lib/roleDisplay";
import { plural } from "../lib/atlasHome";
import { color, font } from "../theme";

// THE AGENTS NODE — card c6160c7d (Atlas P2-2), the project tier's roster at full size.
//
// This node exists because round 4 found the gap the owner named: "how are the spawnable agents
// spawned for projects? I dont see a UI element for that?" (card 939922ee). The band panel on the
// project node answers it at a glance; THIS page answers it properly — every spawnable agent at
// full size, every worker rig named rather than silently filtered away, and a plain statement of
// what a spawn actually does, which is the question a spawn button never answers on its own.
//
// ⛔ Agent CRUD (create / rename / re-profile / delete) is NOT here. Round 4 homes those three
// writes to this node, but they are a whole editor that lives on the Projects node today and
// reaching it is one click from the head below. Building a second one would be a second editor to
// keep in step, which is the duplication this plan exists to avoid — see
// docs/decisions/c6160c7d-atlas-agents-node.md.

export default function AgentsNode() {
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;
  const { roster, isLoading } = useAgentRoster(projectId);

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
          {/* The way to agent CRUD, named for what it does rather than for where it goes — the
              Projects node is where an agent is defined, and this is the only reason to leave. */}
          <Link to="/projects" className="loom-btn loom-btn-default loom-bandlink"
            data-testid="atlas-agents-define" title="Define agents on the Projects node">
            Define agents <span aria-hidden>↗</span>
          </Link>
        </div>

        {roster.spawnable.length === 0
          ? <RosterEmpty workers={roster.workers} projectName={project?.name} />
          : (
            <div className="loom-agentgrid" data-testid="atlas-agent-grid">
              {roster.spawnable.map((entry) => <AgentRosterCard key={entry.agent.id} entry={entry} />)}
            </div>
          )}
        <WorkersDispatchedNote workers={roster.workers} />
      </section>

      <div className="loom-agentsplit">
        <WorkerRigs roster={roster} />
        <WhatASpawnDoes />
      </div>
    </div>
  );
}

/** The worker rigs, as DEFINITIONS. They carry a live pill because a dispatched worker is a real
 *  running thing worth seeing from here — but no control, because nothing a human presses here
 *  would be correct: a hand-spawned worker gets a branch nobody is reviewing. */
function WorkerRigs({ roster }: { roster: ReturnType<typeof useAgentRoster>["roster"] }) {
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
              ? <StatusPill tone={w.session.busy ? "amber" : "phosphor"} glow={w.session.busy}
                  label={w.session.busy ? "busy" : "live"} />
              : <Badge tone="muted">idle</Badge>}
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
          A live manager shows <strong>Live + Stop</strong>, never a second spawn.
        </SpawnTermRow>
        <SpawnTermRow term="Then">
          A session starts under this project and joins the fleet.
        </SpawnTermRow>
      </div>
    </Panel>
  );
}
