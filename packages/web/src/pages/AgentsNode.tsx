import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useActiveProject } from "../lib/activeProject";
import { rosterTally, useAgentRoster, type RosterAgent } from "../lib/atlasAgents";
import { AgentEditDialog, AgentRosterCard, RosterEmpty } from "../components/atlasAgents";
import { ProjectSchedules } from "../components/projectSchedules";
import { Button, Panel, SectionLabel } from "../components/ui";
import { api } from "../lib/api";
import { color, font, fs } from "../theme";

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
//
// THE LAUNCH BAY (card 699fe92a, owner pick direction B via request 891ed41f) rebuilt the page's own
// layout: two labelled GROUPS of one card kind, rather than a card grid plus a rows panel plus a
// static explainer.
//
// @decision 699fe92a — the static "What a spawn does" panel is REMOVED at the owner's instruction;
// do not reinstate a generic explainer here. Its four facts live on the card and on the controls
// that perform them.

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
  // The SAME `["schedules"]` cache entry the Schedules strip at the foot of the page already reads,
  // so a card's own `CRON` fact costs no second request and cannot disagree with the strip. The two
  // are deliberately not the same statement: the fact says "this agent is on a clock", the strip
  // says when it next fires, whether it is on, and where it is managed from.
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const cronFor = (entry: RosterAgent): string[] =>
    (schedules.data ?? []).filter((s) => s.agentId === entry.agent.id).map((s) => s.cron);

  if (!projectId) {
    return (
      <Panel style={{ maxWidth: 560, padding: "18px 20px" }} data-testid="atlas-agents-no-project">
        <p style={{ margin: 0, color: color.textDim, fontFamily: font.mono, fontSize: fs.body, lineHeight: 1.7 }}>
          No project is active yet. Pick one in the entity tree — this node lists whichever project the
          tree has open.
        </p>
      </Panel>
    );
  }

  return (
    <div className="loom-atlas-home" data-testid="atlas-agents-node">
      <section className="loom-atlas-primary">
        <div className="loom-atlas-primaryhead loom-bayhead">
          <span className="loom-atlas-primarylbl">Launch bay</span>
          {/* ONE sentence that reconciles the two counts this tab used to state without ever
              relating them — the tab badge counts every agent, this used to count only the
              spawnable ones, and nothing on screen said why they differed. Its own class, not the
              band's shared `loom-bandcount`: that one is `nowrap` because every other use of it is
              a bare number, and this one carries a project name that can be arbitrarily long. */}
          <span className="loom-bandcount loom-agentscount" data-testid="atlas-agents-count">
            {isLoading ? "…" : rosterTally(roster, project?.name)}
          </span>
          <span style={{ flex: 1 }} />
          {/* ONE wrapper, so the two head actions WRAP TOGETHER. Without it the tally's own wrap
              point split them across two lines — "＋ New agent" right-aligned on the first, the exit
              orphaned at the left of the second (measured at 900px). */}
          <span className="loom-bayhead-acts">
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
          </span>
        </div>

        {/* TWO GROUPS, ONE CARD KIND. The split used to be two visual languages for one entity —
            spawnable agents as cards, worker rigs as rows in a panel with different type, different
            spacing and a different status treatment — so a reader had to learn the tab twice. Now
            the only difference is the group it is in and the weight it is drawn at, and each group
            bar states WHY its members are there, which is where the orphan "…are dispatched by a
            manager" line and the rigs panel's own footer (the same sentence, said twice, 150px
            apart) both ended up. */}
        <BayGroup label="You spawn these" why="press Spawn and a session starts under this project"
          count={roster.spawnable.length}>
          {roster.spawnable.length === 0
            ? <RosterEmpty workers={roster.workers} projectName={project?.name} />
            : (
              <div className="loom-agentgrid" data-testid="atlas-agent-grid">
                {roster.spawnable.map((entry) => (
                  <AgentRosterCard key={entry.agent.id} entry={entry} cron={cronFor(entry)}
                    onEdit={() => setEditing({ agentId: entry.agent.id })} />
                ))}
              </div>
            )}
        </BayGroup>

        {/* The rigs group draws ONLY when there is a rig to draw. An empty group bar would be a
            heading over nothing — and the sentence it carries is about rigs this project HAS, so on
            a project with none it would be answering a question nobody could have asked. */}
        {roster.workers.length > 0 && (
          <BayGroup label="Your manager dispatches these" count={roster.workers.length}
            why="each lands on its own worktree branch — edit the rig here, dispatch it from the manager"
            whyTestId="atlas-agents-worker-note">
            <div className="loom-agentgrid" data-testid="atlas-worker-rigs">
              {roster.workers.map((entry) => (
                <AgentRosterCard key={entry.agent.id} entry={entry} dispatched cron={cronFor(entry)}
                  testId={`atlas-worker-rig-${entry.agent.id}`}
                  onEdit={() => setEditing({ agentId: entry.agent.id })} />
              ))}
            </div>
          </BayGroup>
        )}
      </section>

      {/* This project's cron schedules (card 102bc915) — the one surface classic /overview carried
          that no Atlas project-node tab did. It lands HERE rather than in a band panel or a tab of
          its own for two reasons. A Schedule is keyed to an AGENT (`s.agentId`), so this node is
          already the surface that owns the things it is about; and the band is a FIXED five-column
          grid — a sixth panel shrinks all five rather than adding one. Its tracks at 1440 are
          287 / 220 / 152 / 135 / 321 px (re-weighted by card b4442d27; 102bc915's own 195.8 ×3
          predates it), and only the WORKSPACE node still draws the band at all (card 269f46ef).

          The id set is the roster union, NOT a second api.agents read: `useAgentRoster` partitions
          every one of this project's agents into exactly these two lists, so the union IS the set
          Overview builds from `agents.data` — same membership, no extra request, and it cannot drift
          from the roster rendered directly above it. The strip around it is a visual HOME (card
          699fe92a: it used to float belonging to nothing), never a second implementation. */}
      <div className="loom-baysched" data-testid="atlas-agents-schedules">
        <ProjectSchedules
          agentIds={new Set(scheduleAgents.map((a) => a.id))}
          agentName={(id) => scheduleAgents.find((a) => a.id === id)?.name ?? id.slice(0, 8)} />
      </div>

      {editing && (
        <AgentEditDialog projectId={projectId} agentId={editing.agentId} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

/**
 * One labelled group of the bay: who dispatches these, why, and how many.
 *
 * The `why` is the group's own reason for existing, which is where the two sentences the tab used to
 * say 150px apart ended up — the orphan "…are dispatched by a manager, never spawned here" line and
 * the worker-rigs panel's own footer were the same fact, stated twice because neither group had a
 * place to carry it. `whyTestId` keeps the rigs group's copy addressable under the id that sentence
 * has always had.
 */
function BayGroup({ label, why, count, whyTestId, children }: {
  label: string;
  why: string;
  count: number;
  whyTestId?: string;
  children: ReactNode;
}) {
  return (
    <section className="loom-baygroup">
      <div className="loom-baygroup-bar">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>{label}</SectionLabel>
        <span className="loom-baygroup-why" data-testid={whyTestId}>{why}</span>
        <span style={{ flex: 1 }} />
        <span className="loom-baygroup-n">{count}</span>
      </div>
      {children}
    </section>
  );
}
