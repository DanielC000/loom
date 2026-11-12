// The agent roster behind every Atlas spawn surface — card c6160c7d (Atlas build plan P2-2:
// docs/plans/archive/atlas-ui/03-decomposition.md row P2-2).
//
// ⛔ Composed CLIENT-SIDE from calls lib/api.ts already exposes, per the plan's one hard rule
// (docs/plans/archive/atlas-ui/02-architecture.md). No `api.ts` member was added for this card: a roster is
// `api.agents(projectId)` × `api.profiles()` × `api.allSessions()` — three reads the Atlas homes
// already make, through the SAME cache keys the classic Overview fills, joined once here instead of
// three times in three components.
//
// Pure functions first, hooks at the bottom — the same split lib/atlasHome.ts uses, for the same
// reason: the roster a 250px band panel shows, the one the full node page shows and the one the
// quick-spawn dialog shows are ONE derivation, so the three can never disagree about which agent is
// spawnable or which one the go-live guard is holding.
import { useQuery } from "@tanstack/react-query";
import { contextPercentFor, type Agent, type ProfileSummary, type SessionListItem, type SessionRole } from "@loom/shared";
import { api } from "./api";
import { holdsGoLiveSlot, shortModel } from "./sessions";
import { plural } from "./atlasHome";

/** One agent, with everything a spawn control needs to render and gate itself. */
export interface RosterAgent {
  agent: Agent;
  /** The agent's PROFILE role — what actually applies server-side on a default spawn. */
  role: SessionRole | null;
  /** The bound rig's name, for the card's "which rig is this" line. `null` = a plain agent. */
  profileName: string | null;
  /** The rig's opt-in capabilities, already worded for display (never raw field names). */
  capabilities: string[];
  /**
   * The bound rig itself (card 699fe92a). The card states a rig as labelled FACTS — engine, grants
   * — rather than one run-together grey string, and those read fields `profileName`/`capabilities`
   * never carried. Carried as the WHOLE row rather than three more flattened fields so the next
   * fact the card needs is a derivation here, not another field on every mount.
   */
  profile: ProfileSummary | null;
  /** This agent's live session, if it has one. */
  session: SessionListItem | null;
  live: boolean;
  /**
   * THE GO-LIVE GUARD. A manager-role agent that already holds its go-live slot must not be
   * re-spawned — a human double-spawning the orchestrator is a footgun — so its control becomes a
   * disabled held button plus a graceful Stop. Every other agent (a non-manager holding its own
   * slot included) keeps spawn enabled.
   *
   * @decision 318b5a21 — the test is lib/sessions' `holdsGoLiveSlot`, never a local `=== "live"`.
   */
  managerLive: boolean;
}

export interface AgentRoster {
  /** The agents a human may start by hand, in the project's own agent order. */
  spawnable: RosterAgent[];
  /** The worker rigs — named, never offered. See `splitRoster` for why they are shown at all. */
  workers: RosterAgent[];
}

const EMPTY_ROSTER: AgentRoster = { spawnable: [], workers: [] };

/**
 * Join an agent to its rig and the session holding its go-live slot.
 *
 * That lookup is `agentId` + lib/sessions' `holdsGoLiveSlot`, the SAME predicate
 * pages/Overview.tsx's own `liveSessionFor` now calls — so the Atlas roster and the classic Overview
 * cannot disagree about when a manager may be spawned. Card c6160c7d carried Overview's then-narrow
 * `=== "live"` form here verbatim for exactly that reason; card 318b5a21 confirmed the narrow form
 * was a real double-spawn hole and moved BOTH surfaces onto the fixed predicate together.
 */
export function rosterAgent(
  agent: Agent,
  profiles: readonly ProfileSummary[] | undefined,
  sessions: readonly SessionListItem[] | undefined,
): RosterAgent {
  const profile = profiles?.find((p) => p.id === agent.profileId) ?? null;
  const role = profile?.role ?? null;
  const session = (sessions ?? []).find((s) => s.agentId === agent.id && holdsGoLiveSlot(s)) ?? null;
  const live = session !== null;
  return {
    agent,
    role,
    profileName: profile?.name ?? null,
    capabilities: rigCapabilities(profile),
    profile,
    session,
    live,
    managerLive: role === "manager" && live,
  };
}

/** The rig's opt-in capabilities as display words. Empty for a rig that adds none — the common case,
 *  where printing "no capabilities" would be noise rather than information. */
export function rigCapabilities(profile: ProfileSummary | null): string[] {
  if (!profile) return [];
  const out: string[] = [];
  if (profile.browserTesting) out.push("browser");
  if (profile.documentConversion) out.push("documents");
  if (profile.restrictedTools) out.push("restricted tools");
  return out;
}

/**
 * Split a project's agents into the two lists every Atlas spawn surface shows.
 *
 * Worker-role agents are EXCLUDED from `spawnable` for the same reason pages/Overview.tsx excludes
 * them: a worker is Loom-DRIVEN — a manager dispatches it onto an isolated worktree branch via
 * `worker_spawn` — so a hand-spawn button for one is a footgun, not a feature.
 *
 * They are still returned, in `workers`, because "where did Dev go?" is the next question a reader
 * asks once they notice the roster is shorter than the agent list (round 4's own finding, card
 * 939922ee). Naming them as definitions answers it; offering them as buttons would be the bug.
 */
export function splitRoster(
  agents: readonly Agent[] | undefined,
  profiles: readonly ProfileSummary[] | undefined,
  sessions: readonly SessionListItem[] | undefined,
): AgentRoster {
  if (!agents) return EMPTY_ROSTER;
  const rows = agents.map((a) => rosterAgent(a, profiles, sessions));
  return {
    spawnable: rows.filter((r) => r.role !== "worker"),
    workers: rows.filter((r) => r.role === "worker"),
  };
}

/**
 * A live session's one-line vitals — "gen 3 · 318 turns · 41%" — with each part dropped when the
 * session has not reported it. `contextPercentFor` (@loom/shared) is the ONE rounding rule every
 * context readout in the product shares, including worker_list's own `ctxPct`; re-deriving it here
 * would be a second rule that drifts from it silently.
 */
export function sessionVitals(s: SessionListItem): string {
  const pct = contextPercentFor(s.ctxInputTokens, s.model);
  return [
    s.gen ? `gen ${s.gen}` : null,
    s.ctxTurns ? `${s.ctxTurns} turns` : null,
    pct === null ? null : `${pct}%`,
  ].filter(Boolean).join(" · ");
}

// ── The Launch Bay card's facts (card 699fe92a) ────────────────────────────────────────────────
// The Agents node's card used to hold a badge, a name, one grey line and two buttons — nothing on
// it answered "which one do I want". These are the facts that now do, each derived from a field the
// page ALREADY fetched and had been throwing away (the agent's own startup prompt; the rig's model,
// harness and skill subset). No new `api.ts` member was added for any of them, which is the same
// hard rule the roster itself was built under.

/** What this agent will spawn ON — `"claude · opus-4-8"`, or `"claude · default"` for a rig that
 *  pins no model. A plain agent (no rig at all) still spawns on the default engine, so it reads the
 *  same way rather than leaving the fact blank and the question open. */
export function engineLine(entry: RosterAgent): string {
  const p = entry.profile;
  return `${p?.harness ?? "claude"} · ${p?.model ? shortModel(p.model) : "default"}`;
}

/** One `GRANTS` chip. `capability` is an opt-in host capability the rig confers (browser, documents);
 *  `skills` is the rig's skill subset, which every rig has — so the two are toned apart. */
export interface GrantChip { label: string; kind: "capability" | "skills" }

/** The rig's grants as chips. A plain agent has no rig and therefore no grants to state — an empty
 *  list, so the card omits the row rather than printing "none" on every plain agent. */
export function grantChips(entry: RosterAgent): GrantChip[] {
  const p = entry.profile;
  if (!p) return [];
  const chips: GrantChip[] = entry.capabilities.map((label) => ({ label, kind: "capability" }));
  // `skills: null` is "deliver every skill", NOT "no skills" — the two are opposite facts and the
  // nullable field reads as the wrong one if it is counted rather than branched on.
  chips.push({ label: p.skills === null ? "all skills" : plural(p.skills.length, "skill"), kind: "skills" });
  return chips;
}

/**
 * The agent's own mission, in its own words — the first real paragraph of the startup prompt it
 * injects, which the product stores on every agent and has never shown anywhere.
 *
 * A prompt that opens with a markdown heading is naming the agent, which the card's name line
 * already says one row above; the first paragraph that is NOT a heading is the one that states what
 * the agent is for. With no prompt at all there is no mission to state, so it says so and falls back
 * to the role's own description — the copy `lib/roleDisplay.tsx` already ships, passed in rather than
 * imported so this stays a pure string function with no component dependency.
 */
export function missionLine(startupPrompt: string, roleDescription: string): string {
  const paragraphs = startupPrompt.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const body = paragraphs.find((p) => !/^#{1,6}\s/.test(p)) ?? paragraphs[0];
  return body ? body.replace(/\s+/g, " ") : `No startup prompt — ${roleDescription}`;
}

/**
 * The one sentence that reconciles the two counts this tab used to state without ever relating them:
 * the tab badge counts EVERY agent, the roster head counted only the spawnable ones, and nothing on
 * screen said why they differed (defect 6 of the card's own measured list).
 *
 * Both halves are named, so the badge's number is accounted for. The one-sided cases say so in words
 * rather than printing a `0` beside a group the page does not even draw.
 */
export function rosterTally(roster: AgentRoster, projectName?: string): string {
  const where = projectName ? ` in ${projectName}` : "";
  const { spawnable, workers } = roster;
  if (spawnable.length === 0 && workers.length === 0) return `No agents${where} yet`;
  if (workers.length === 0) return `${plural(spawnable.length, "agent")}${where} — all spawned by you`;
  if (spawnable.length === 0) return `${plural(workers.length, "agent")}${where} — all dispatched by your manager`;
  return `${plural(spawnable.length + workers.length, "agent")}${where} — ${spawnable.length} you spawn, ${workers.length} your manager dispatches`;
}

// ── The inline quick-start's picker (card f3b18f27) ────────────────────────────────────────────
// The Sessions tab starts a session from a `<select>` rather than a dialog, so it needs one thing no
// other spawn surface does: a rule for WHICH agent the picker is pointed at when nothing has been
// chosen yet, or when what WAS chosen is no longer spawnable. Both pure, both here rather than in the
// component, for the same reason `splitRoster` is.

/**
 * The spawnable agent a picker is pointed at: the one asked for while it is still spawnable, else the
 * first in the project's own agent order, else nothing.
 *
 * ⚠️ The fallback is the load-bearing half, not the happy path. `roster.spawnable` is re-derived on
 * every `["agents"]`/`["profiles"]`/`["allSessions"]` settle, so the chosen agent can leave the list
 * under a reader who is still looking at it — deleted from the Agents tab, or re-bound to a worker
 * rig, which drops it from `spawnable` outright. Holding the stale id would leave the control pointed
 * at an agent the picker no longer offers: a Spawn button that posts a 404, with the `<select>`
 * showing some other agent's name (a `value` no `<option>` carries renders as the first option).
 */
export function resolveSpawnPick(
  spawnable: readonly RosterAgent[],
  wanted: string | null,
): RosterAgent | null {
  return spawnable.find((e) => e.agent.id === wanted) ?? spawnable[0] ?? null;
}

/**
 * One picker option's label: the agent's name, and `· live` when it already holds its go-live slot.
 *
 * The marker is there because the control CHANGES SHAPE on a live pick — `AgentActions` draws the
 * held control plus a Stop instead of a Spawn (the go-live guard) — and a picker that read as a flat
 * list of startable agents would make that look like a broken button rather than a guard. `live` is
 * `holdsGoLiveSlot`'s answer for EVERY role, not just a manager's, so the marker is honest on a row
 * whose Spawn stays enabled too: it says "this one is already running", which is worth knowing
 * either way.
 */
export function spawnPickLabel(entry: RosterAgent): string {
  return entry.live ? `${entry.agent.name} · live` : entry.agent.name;
}

// ── The standing operators (the Workspace root's own roster) ───────────────────────────────────
// The project tier's roster is "which agents may I start here"; the workspace tier's is "which
// cross-project operators are standing right now". Different question, different shape — these are
// singletons that live ABOVE every project, and the surfaces that own their lifecycle (the Platform
// node, the Companion page) carry their controls.
//
// @decision c6160c7d — a readout, never a second place to start or stop one.

export interface StandingOperator {
  session: SessionListItem;
  role: SessionRole;
  /** Where this operator's own controls live — the surface that owns its lifecycle. */
  home: { to: string; label: string };
}

/** Which roles are standing cross-project operators, AND where each one is managed from — ONE map,
 *  so "is this an operator" and "where are its controls" can never disagree. A role absent here is
 *  a project fleet member, which is the complement this panel is showing. */
const OPERATOR_HOME: Record<string, { to: string; label: string }> = {
  platform: { to: "/platform", label: "Platform" },
  setup: { to: "/platform", label: "Platform" },
  auditor: { to: "/platform", label: "Platform" },
  "workspace-auditor": { to: "/platform", label: "Platform" },
  assistant: { to: "/companion", label: "Companion" },
};

/**
 * Every LIVE standing operator across the whole workspace, most-recently-active first.
 *
 * Derived from the SAME `["allSessions"]` entry the workspace node already reads for its fleet
 * counts — so the two can never disagree about what is running, and this panel costs no request.
 * The fleet counts deliberately EXCLUDE these rows (a companion is not a fleet member); this panel
 * is that exclusion's complement, not a second view of the same set.
 */
export function standingOperators(sessions: readonly SessionListItem[] | undefined): StandingOperator[] {
  const out: StandingOperator[] = [];
  for (const session of sessions ?? []) {
    if (session.processState !== "live") continue;
    const role = session.role;
    // The map is the membership test: an entry exists for exactly the operator roles, so a role with
    // no home is not an operator and a new operator role cannot be added without naming where it is
    // managed from.
    const home = role ? OPERATOR_HOME[role] : undefined;
    if (!role || !home) continue;
    out.push({ session, role, home });
  }
  return out.sort((a, b) => +new Date(b.session.lastActivity ?? 0) - +new Date(a.session.lastActivity ?? 0));
}

// ── Hooks ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The project's roster, off the three cache keys the Atlas homes already fill.
 *
 * `["agents", projectId]` and `["profiles"]` are the SAME keys pages/Overview.tsx uses, so an Atlas
 * surface mounted after a visit to the classic Overview reads them warm, and a mutation fired from
 * either invalidates both identically.
 */
export function useAgentRoster(projectId: string): { roster: AgentRoster; isLoading: boolean } {
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: ({ signal }) => api.agents(projectId, signal), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: ({ signal }) => api.profiles(signal) });
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  return {
    roster: splitRoster(agentsQ.data, profilesQ.data, sessionsQ.data),
    // The ROSTER is only trustworthy once the agents AND the profiles have landed: a resolved agent
    // list joined against an unresolved profile list yields every agent at role `null`, which reads
    // as a complete roster of plain agents — including the worker rigs, offered as spawnable.
    isLoading: agentsQ.isPending || profilesQ.isPending,
  };
}
