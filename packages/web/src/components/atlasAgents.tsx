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
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { profileRoleBindsAsPlainSession } from "@loom/shared";
import { api } from "../lib/api";
import { AgentEditor, AgentForm, PLAIN_BIND_GROUP_LABEL, UnsavedCloseBar, useAgentWrites } from "./agentEditor";
import { SpawnControls } from "./SpawnControls";
import { RepinGrantsControl } from "./RepinGrants";
import { Button, Panel, SectionLabel, Select, StatusPill } from "./ui";
import { RoleBadge, roleColor, roleDisplay } from "../lib/roleDisplay";
import { errorText } from "../lib/loopbackCredential";
import { useActiveProject } from "../lib/activeProject";
import { goLiveHeldControl, goLiveSessionPill } from "../lib/sessions";
import {
  engineLine, grantChips, missionLine, resolveSpawnPick, sessionVitals,
  spawnPickLabel, useAgentRoster, type RosterAgent,
} from "../lib/atlasAgents";
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
export function AgentActions({ entry }: { entry: RosterAgent }) {
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
      </div>
      {/* Re-pin grants (card 158cb01a): the agent's live manager only — never a roster row without a session. */}
      {entry.managerLive && entry.session && <RepinGrantsControl session={entry.session} />}
      {spawn.isError && <span className="loom-agentrow-err">{errorText(spawn.error)}</span>}
      {stop.isError && <span className="loom-agentrow-err">{errorText(stop.error)}</span>}
    </div>
  );
}

/**
 * The one Edit button, for BOTH card weights — a spawnable agent's and a worker rig's.
 *
 * ALWAYS enabled, including behind the go-live guard: editing an agent's DEFINITION is not a
 * lifecycle action, and a running manager is exactly the one whose prompt you most often want to
 * correct. The delete inside the editor is what carries the live-session guard.
 *
 * It sits OUTSIDE `AgentActions` (card 699fe92a) because a worker rig has an Edit and deliberately
 * no spawn and no stop — it is the one control the two weights share, and a dispatched rig must
 * never reach the spawn cluster to get it (card 318b5a21 put the Edit there; this only moves where
 * the button is declared, never which rows carry one).
 */
function AgentEditButton({ entry, onEdit }: { entry: RosterAgent; onEdit: () => void }) {
  return (
    <Button variant="ghost" data-testid={`atlas-agent-edit-${entry.agent.id}`}
      title={`Edit ${entry.agent.name} — its rig, startup prompt, or delete it`}
      onClick={onEdit}>Edit</Button>
  );
}

/** The amber △ for a bound profile whose role the bind would NOT confer. Drawn by BOTH the compact
 *  roster row and the node card, so the flag reads the same wherever the role claim is made. */
function PlainBindMark({ entry, inline }: { entry: RosterAgent; inline?: boolean }) {
  // The badge states the BOUND PROFILE's role — but a profile confers only manager / worker / assistant,
  // so a card carrying any other role (setup, operator, platform, …) advertises powers the spawn silently
  // drops. Flag it where the claim is made (card 57deed24, re-homed here from the deleted Projects list by
  // card acbb6df6): an amber △ beside the badge, with the editor note's own wording as its tooltip.
  // `profileRoleBindsAsPlainSession` answers CONFERRAL — never `isDevLayerRole`, which answers picker
  // VISIBILITY and is false for setup / operator / workspace-auditor (the c40489c6 trap).
  if (!profileRoleBindsAsPlainSession(entry.role)) return null;
  return (
    <span data-testid={`atlas-agent-plain-bind-${entry.agent.id}`} role="img" aria-label={PLAIN_BIND_GROUP_LABEL}
      title={PLAIN_BIND_GROUP_LABEL} style={{ color: color.attnText, marginRight: inline ? 4 : undefined }}>△</span>
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
        <PlainBindMark entry={entry} />
        <RoleBadge role={entry.role} />
        <strong className="loom-agentrow-name" title={entry.agent.name}>{entry.agent.name}</strong>
        <span style={{ flex: 1 }} />
        {pill && <StatusPill tone={pill.pending ? "work" : "live"} glow={pill.pending} label={pill.label} />}
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

/**
 * THE LAUNCH BAY CARD — the Agents node's full-size agent. ONE card, two weights: the agent you
 * spawn, and the worker rig your manager dispatches.
 *
 * @decision 699fe92a — `dispatched` is a WEIGHT, never a capability switch: `splitRoster`'s
 * partition is still the only reason a rig has no spawn, so never reach for this prop to hide a
 * control on a spawnable agent.
 *
 * `testId` defaults to the spawnable id every spec already addresses; a dispatched card passes the
 * worker rig's own (`atlas-worker-rig-<id>`), so "the worker is not in the spawnable roster" stays
 * sayable.
 */
export function AgentRosterCard({ entry, onEdit, dispatched = false, cron = [], testId }: {
  entry: RosterAgent;
  onEdit: () => void;
  /** Draw this as a manager-dispatched worker rig: lower weight, dispatch stamp, no lifecycle. */
  dispatched?: boolean;
  /** This agent's own cron expressions, if the project schedules it. Read from the SAME
   *  `["schedules"]` key the Schedules strip below the bay reads — never a second request. */
  cron?: string[];
  testId?: string;
}) {
  const role = roleDisplay(entry.role);
  const pill = entry.session ? goLiveSessionPill(entry.session) : null;
  const grants = grantChips(entry);
  // THE LEADING EDGE — liveness, answerable peripherally without reading a single pill, plus the
  // dashed subordinate weight for a rig. It rides `Panel`'s own `style` prop, NOT a class, and so do
  // the two properties below it: `Panel` writes `background` / `border` / `padding` as INLINE
  // styles and spreads `style` LAST, so a stylesheet rule for any of the three is silently INERT.
  // Measured on the first eyeball of this card — the dashed edge, the muted rig surface and
  // `padding: 0` were all written as CSS, all three did nothing, and the card still looked close
  // enough to the mockup to pass a glance.
  const edge = pill ? (pill.pending ? color.work : color.live) : color.lineStrong;
  const classes = `loom-baycard${dispatched ? " is-dispatched" : ""}`;
  return (
    <Panel className={classes} data-testid={testId ?? `atlas-agent-card-${entry.agent.id}`}
      style={{
        padding: 0,
        borderLeft: `2px ${dispatched ? "dashed" : "solid"} ${edge}`,
        ...(dispatched ? { background: color.inset } : null),
      }}>
      <div className="loom-baycard-head">
        {/* The role's own sigil from the ONE presentation map, at a size you can read, in the role's
            own signal colour. The role IDENTIFIER is untouched — this is the legibility layer on top
            of it, exactly as `RoleBadge` is, and it is `aria-hidden` because the label beside it
            already says the same thing in words. */}
        <span className="loom-baysigil" style={{ color: roleColor(entry.role) }} aria-hidden>{role.sigil}</span>
        <span className="loom-baycard-id">
          <strong className="loom-baycard-name" title={entry.agent.name}>{entry.agent.name}</strong>
          {/* The tier is dropped when it only repeats the label — "Companion · companion" states
              one fact twice, which is the defect this whole card is about, at 9.5px. */}
          <span className="loom-baycard-role" style={{ color: roleColor(entry.role) }}>
            <PlainBindMark entry={entry} inline />{role.label}
            {role.tierLabel.toLowerCase() !== role.label.toLowerCase() &&
              <span className="loom-baycard-tier"> · {role.tierLabel}</span>}
          </span>
        </span>
        {pill && <StatusPill tone={pill.pending ? "work" : "live"} glow={pill.pending} label={pill.label} />}
      </div>

      <p className="loom-baymission">{missionLine(entry.agent.startupPrompt, role.description)}</p>

      <dl className="loom-bayfacts">
        <dt>Rig</dt>
        <dd>
          {entry.profileName
            ? <span className="loom-bayfact">{entry.profileName}</span>
            : <span className="loom-baychip is-none">no rig · plain session</span>}
        </dd>
        <dt>Engine</dt>
        <dd><span className="loom-bayfact">{engineLine(entry)}</span></dd>
        {grants.length > 0 && <>
          <dt>Grants</dt>
          <dd>{grants.map((g) => (
            <span key={g.label} className={`loom-baychip${g.kind === "capability" ? " is-cap" : ""}`}>{g.label}</span>
          ))}</dd>
        </>}
        {cron.length > 0 && <>
          <dt>Cron</dt>
          <dd>{cron.map((c) => <span key={c} className="loom-baychip is-cron">{c}</span>)}</dd>
        </>}
      </dl>

      {/* No gen · turns · context strip on this card (card 291cc8aa, owner: "remove the "gen 487 ·
          103 turns 23% context" from the cards"). The status pill above already says the agent is
          live; the counters belong to the session itself, not the agent's launch card. */}

      <div className="loom-baycard-bar">
        {dispatched
          ? <span className="loom-baystamp">Manager-dispatched</span>
          : <AgentActions entry={entry} />}
        <span style={{ flex: 1 }} />
        <AgentEditButton entry={entry} onEdit={onEdit} />
      </div>
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
 *  answers: define an agent, or dispatch a worker from a manager.
 *
 *  `testId` is defaulted so every pre-existing mount keeps the id it already had. The Sessions tab's
 *  quick-start (below) passes its own: the Atlas project node parks every VISITED tab body in the DOM
 *  with `hidden` rather than unmounting it, so the Agents tab's own empty line and this one can be in
 *  one document at once — and a shared id would resolve both and trip strict mode in any spec that
 *  addresses either. */
export function RosterEmpty({ workers, projectName, testId = "atlas-agents-empty" }:
  { workers: RosterAgent[]; projectName?: string; testId?: string }) {
  return (
    <p className="loom-bandempty" data-testid={testId}>
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
export function AgentsQuickSpawn({ projectId, projectName, testId = "atlas-quickspawn", trigger = "plus", tabIndex }: {
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
  /** The `"plus"` trigger's tabIndex. The tree's project rows pass -1 except on the row holding the
   *  tree's roving Tab stop (card fa8a2887). Unset = the button's native order. */
  tabIndex?: number;
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
        <button type="button" className="loom-atlas-plus" data-testid={`${testId}-open`} tabIndex={tabIndex}
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
function AtlasAgentDialog({ testId, label, width, maxHeight, height, scrimPadding = "10vh 16px", onClose, children }: {
  testId: string;
  label: string;
  width: string;
  maxHeight: string;
  /** A FIXED panel height, for a dialog whose body should fill the frame rather than size to content. */
  height?: string;
  scrimPadding?: string;
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
        alignItems: "flex-start", justifyContent: "center", padding: scrimPadding, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width, maxHeight, height, background: color.surface,
          border: `1px solid ${color.lineStrong}`, borderRadius: radius.base, padding: 14,
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

// ── The inline quick-start (card f3b18f27) ─────────────────────────────────────────────────────

/**
 * Start a session for one of this project's agents without opening anything — a picker and the
 * roster's own spawn controls, on one line, beside the sessions already running.
 *
 * @decision f3b18f27 — never give this surface a spawn call, a guard or a spawnable-list rule of its
 * own. The picker is the only new thing here; every control below it is `AgentActions` verbatim.
 */
export function AgentQuickStart({ projectId, projectName, testId = "atlas-quickstart" }: {
  projectId: string;
  projectName?: string;
  /** The testid STEM for the picker, the rig line and the empty note (`<stem>-agent` / `-rig` /
   *  `-empty`). Defaulted for the one mount there is; a prop so a second one can never collide. */
  testId?: string;
}) {
  const { roster, isLoading } = useAgentRoster(projectId);
  // The REQUEST, not the answer: `null` means "nothing chosen yet" and resolves to the first
  // spawnable agent. Storing the resolved entry instead would freeze a row that the next roster
  // settle may have changed (a session started elsewhere flips `managerLive`, and the control's own
  // shape depends on it).
  const [wanted, setWanted] = useState<string | null>(null);
  const pick = resolveSpawnPick(roster.spawnable, wanted);
  return (
    <div className="loom-quickstart" data-testid={testId}>
      {isLoading && <span className="loom-agentrow-meta">Reading the roster…</span>}
      {!isLoading && !pick && (
        <RosterEmpty workers={roster.workers} projectName={projectName} testId={`${testId}-empty`} />
      )}
      {!isLoading && pick && (
        <>
          {/* `value` is the RESOLVED pick, never `wanted` — so a chosen agent that left the roster
              re-points the control at an agent that is really there, instead of leaving the select
              showing the first option while the buttons act on a stale id. */}
          <Select value={pick.agent.id} data-testid={`${testId}-agent`}
            aria-label="Which agent to start a session for"
            onChange={(e) => setWanted(e.target.value)}>
            {roster.spawnable.map((entry) => (
              <option key={entry.agent.id} value={entry.agent.id}>{spawnPickLabel(entry)}</option>
            ))}
          </Select>
          {/* "What will this button actually start" — the one line `rigLine` exists for, and the
              reason a bare agent name is not enough beside a Spawn button. */}
          <span className="loom-agentrow-meta" data-testid={`${testId}-rig`} title={rigLine(pick)}>
            {rigLine(pick)}
          </span>
          {/* `key` is the pick: a fresh `AgentActions` per agent, so its own mutation state cannot
              outlive the agent it belongs to — otherwise a refusal raised for one agent stays
              printed under the next one the reader picks, blaming it for a failure that was not
              its own. */}
          <AgentActions key={pick.agent.id} entry={pick} />
        </>
      )}
    </div>
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
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: ({ signal }) => api.agents(projectId, signal), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: ({ signal }) => api.profiles(signal) });
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  // Edition discovery, off the SAME shared key pages/Projects.tsx reads it from — one cached fetch
  // for the whole app. It gates which rigs the bind dropdown offers; `isSuccess &&` holds it false
  // until the query settles so an end user never flashes a dev-layer rig mid-load.
  const platformHomeQ = useQuery({ queryKey: ["platformHome"], queryFn: ({ signal }) => api.platformHome(signal), retry: false });
  const isDev = platformHomeQ.isSuccess && !!platformHomeQ.data?.project;
  const { create, update, saveGrants, rename, remove } = useAgentWrites(projectId, {
    // The create form's draft is now the agent, so nothing is unsaved until the editor says otherwise.
    onCreated: (agent) => { setDirty(false); setCloseArmed(false); setEditing(agent.id); },
    onDeleted: onClose,
  });
  const agent = editing ? agentsQ.data?.find((a) => a.id === editing) ?? null : null;
  // The delete guard's own count — `processState === "live"` here, NOT `holdsGoLiveSlot`: this is not
  // the go-live guard, it mirrors what the DAEMON refuses a delete for, and widening it client-side
  // would disable a button the server would have allowed.
  const liveCount = (sessionsQ.data ?? []).filter((s) => s.agentId === editing && s.processState === "live").length;
  const creating = editing === null;
  const title = creating ? "New agent" : "Edit agent";
  // Every exit (Escape, the scrim, ×) goes through `requestClose` (card dd83149f, audit A-04): clean
  // closes at once, dirty arms the editor's "Unsaved …" bar instead. Same two-step as the board card
  // dialog (pages/Board.tsx `requestClose`). Delete still closes directly: it is already behind its own
  // confirm, and the draft belongs to the agent it deletes.
  //
  // @decision dd83149f — never close this dialog over a dirty draft without an explicit Discard.
  const [dirty, setDirty] = useState(false);
  const [closeArmed, setCloseArmed] = useState(false);
  const requestClose = useCallback(() => { if (dirty) setCloseArmed(true); else onClose(); }, [dirty, onClose]);
  const keepEditing = useCallback(() => setCloseArmed(false), []);
  return (
    // Near full-viewport (owner wish, card 5e628a76): a FIXED height, not a content-sized cap, so the
    // prompt field below has real room to grow into. Capped so a wide monitor still reads as a dialog.
    <AtlasAgentDialog testId="atlas-agent-editor" label={title} width="min(1280px, 100%)"
      height="min(1000px, calc(100dvh - 48px))" maxHeight="calc(100dvh - 48px)" scrimPadding="24px clamp(8px, 2vw, 24px)"
      onClose={requestClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>{title}</SectionLabel>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" data-testid="atlas-agent-editor-close" aria-label="Close the agent editor"
          title="Close (Esc)" onClick={requestClose} style={{ padding: "0 8px", lineHeight: 1.2 }}>×</Button>
      </div>
      {/* The create form has no one-click save (it needs a name), so its bar offers only the way out. */}
      {creating && closeArmed && dirty && (
        <UnsavedCloseBar what="new agent" onDiscard={onClose} onKeepEditing={keepEditing} />
      )}
      {/* `flex:1` + `minHeight:0` inside the panel's FIXED height: this body takes everything below the
          header and scrolls itself, and AgentEditor's prompt textarea grows into it. (A content-sized
          panel is what once collapsed the textarea to one line; the fixed height above prevents that.) */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1, overflowY: "auto" }}>
        {creating ? (
          <AgentForm onCreate={(b) => create.mutate(b)} pending={create.isPending} onCancel={onClose} onDirtyChange={setDirty} />
        ) : agent ? (
          <AgentEditor key={agent.id} agent={agent} profiles={profilesQ.data ?? []} isDev={isDev}
            liveCount={liveCount}
            onAssignProfile={(profileId) => update.mutate({ id: agent.id, patch: { profileId } })}
            onSavePrompt={(startupPrompt) => update.mutate({ id: agent.id, patch: { startupPrompt } })}
            onSaveGrants={(patch) => saveGrants.mutate({ id: agent.id, patch })}
            onDelete={() => remove.mutate(agent.id)}
            saving={update.isPending} savingGrants={saveGrants.isPending} grantsError={saveGrants.error as Error | null}
            grantsErrorAgentId={saveGrants.variables?.id}
            onRename={(name) => rename.mutate({ id: agent.id, name })} renaming={rename.isPending}
            renameError={rename.error as Error | null} renameErrorAgentId={rename.variables?.id}
            deleting={remove.isPending}
            onDirtyChange={setDirty} closeArmed={closeArmed} onDiscardClose={onClose} onKeepEditing={keepEditing} />
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

