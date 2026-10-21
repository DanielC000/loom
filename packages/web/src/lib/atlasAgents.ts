// The agent roster behind every Atlas spawn surface — card c6160c7d (Atlas build plan P2-2:
// docs/plans/atlas-ui/03-decomposition.md row P2-2).
//
// ⛔ Composed CLIENT-SIDE from calls lib/api.ts already exposes, per the plan's one hard rule
// (docs/plans/atlas-ui/02-architecture.md). No `api.ts` member was added for this card: a roster is
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

/** One agent, with everything a spawn control needs to render and gate itself. */
export interface RosterAgent {
  agent: Agent;
  /** The agent's PROFILE role — what actually applies server-side on a default spawn. */
  role: SessionRole | null;
  /** The bound rig's name, for the card's "which rig is this" line. `null` = a plain agent. */
  profileName: string | null;
  /** The rig's opt-in capabilities, already worded for display (never raw field names). */
  capabilities: string[];
  /** This agent's live session, if it has one. */
  session: SessionListItem | null;
  live: boolean;
  /**
   * THE GO-LIVE GUARD. A manager-role agent that is already live must not be re-spawned — a human
   * double-spawning the orchestrator is a footgun — so its control becomes a disabled "Live" plus a
   * graceful Stop. Every other agent (a live NON-manager included) keeps spawn enabled.
   *
   * @decision c6160c7d — keyed on `processState === "live"`, NOT on lib/atlasHome's `isLiveSession`.
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
 * Join an agent to its rig and its live session.
 *
 * The live-session lookup is `agentId` + `processState === "live"`, carried VERBATIM from
 * pages/Overview.tsx's own `liveSessionFor` rather than reusing lib/atlasHome's `isLiveSession`
 * (which also counts `starting`). The two predicates genuinely differ, and the guard is a
 * behavioural contract this card is reusing, not redesigning: widening it here would make the Atlas
 * roster and the classic Overview disagree about when a manager may be spawned, which is exactly the
 * divergence phase 2 is not allowed to introduce.
 */
export function rosterAgent(
  agent: Agent,
  profiles: readonly ProfileSummary[] | undefined,
  sessions: readonly SessionListItem[] | undefined,
): RosterAgent {
  const profile = profiles?.find((p) => p.id === agent.profileId) ?? null;
  const role = profile?.role ?? null;
  const session = (sessions ?? []).find((s) => s.agentId === agent.id && s.processState === "live") ?? null;
  const live = session !== null;
  return {
    agent,
    role,
    profileName: profile?.name ?? null,
    capabilities: rigCapabilities(profile),
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
  const agentsQ = useQuery({ queryKey: ["agents", projectId], queryFn: () => api.agents(projectId), enabled: !!projectId });
  const profilesQ = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  return {
    roster: splitRoster(agentsQ.data, profilesQ.data, sessionsQ.data),
    // The ROSTER is only trustworthy once the agents AND the profiles have landed: a resolved agent
    // list joined against an unresolved profile list yields every agent at role `null`, which reads
    // as a complete roster of plain agents — including the worker rigs, offered as spawnable.
    isLoading: agentsQ.isPending || profilesQ.isPending,
  };
}
