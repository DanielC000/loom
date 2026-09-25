import { resolveMergeGateCadence } from "@loom/shared";
import type { MergeGateAgentView, MergeGateOutcomeEntry, MergeGateStatus } from "@loom/shared";

/**
 * @decision 6f13746c — decide ONCE per landing, record ONCE per landed candidate, agents READ-only (see docs/decisions/6f13746c-merge-gate-interval.md).
 *
 * Card 6f13746c — the merge-gate INTERVAL: while a project's human-only `orchestration.mergeGate` is "off",
 * `orchestration.mergeGateInterval` = N lets N branches land UNGATED, then the next landing runs the real
 * gateCommand. This module is PURE (no db, no clock beyond an injected `at`): the durable per-project state
 * shape, the ONE decision function ({@link decideMergeGate}) and the state transitions the ONE recorder in
 * `SessionService` applies. Persistence is `Db.getMergeGateState`/`putMergeGateState`.
 *
 * Rule (the contract both this card and the web card build to):
 *  - gate this landing iff cadence=every, OR gateOwed, OR (cadence=interval AND ungatedSinceLastPass + K > N)
 *  - an ungated landing ⇒ ungatedSinceLastPass += (branches that ACTUALLY landed); cadence=never keeps counting
 *  - ANY passing gate ⇒ counter 0, gateOwed false, lastPass* updated, lastFailure cleared
 *  - a failing gate: recorded in `recent` + `lastFailure` under every cadence; it sets gateOwed ONLY when the
 *    gate was periodic/owed (cadence ≠ every) — under `every` every later merge is gated anyway, and a later
 *    off-switch must not find the project retroactively "owed"
 * Deliberately NOT counted (counter untouched): a landing with no gateCommand at all (already labelled
 * "unverified" by its own warning) and an inert docs-only skip.
 */
export const MERGE_GATE_RECENT_MAX = 6;

export interface MergeGateState {
  ungatedSinceLastPass: number;
  gateOwed: boolean;
  lastPassAt: string | null;
  lastPassSha: string | null;
  recent: MergeGateOutcomeEntry[];
  lastFailure: (MergeGateOutcomeEntry & { result: "fail" }) | null;
}

export function emptyMergeGateState(): MergeGateState {
  return { ungatedSinceLastPass: 0, gateOwed: false, lastPassAt: null, lastPassSha: null, recent: [], lastFailure: null };
}

export type MergeGateDecisionReason = "every" | "owed" | "interval-due" | "skip-never" | "skip-interval";
export interface MergeGateDecision {
  gate: boolean;
  cadence: "every" | "interval" | "never";
  interval: number | null;
  reason: MergeGateDecisionReason;
  /** The value folded into a merge op's verdict-cache identity: a gated decision keys as "on" (a real gate verdict),
   *  an ungated one as "off" — so a cached red is never replayed onto an ungated landing or vice versa. */
  identityValue: "on" | "off";
  /** The `skipReason` an ungated landing stamps (never a pass). Absent when gated. */
  skipReason?: "gate-disabled" | "gate-interval";
}

export function decideMergeGate(
  state: MergeGateState,
  orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined },
  K: number,
  /** In-process RESERVED-but-unsettled ungated landings for this (project, repo) — counted like landed ones so overlapping
   *  confirms cannot overshoot N (see `SessionService.reserveMergeGate`). */
  pending = 0,
): MergeGateDecision {
  const { cadence, interval } = resolveMergeGateCadence(orch);
  const gated = (reason: MergeGateDecisionReason): MergeGateDecision => ({ gate: true, cadence, interval, reason, identityValue: "on" });
  if (cadence === "every") return gated("every");
  if (state.gateOwed) return gated("owed");
  if (cadence === "interval" && state.ungatedSinceLastPass + pending + K > interval!) return gated("interval-due");
  return cadence === "never"
    ? { gate: false, cadence, interval, reason: "skip-never", identityValue: "off", skipReason: "gate-disabled" }
    : { gate: false, cadence, interval, reason: "skip-interval", identityValue: "off", skipReason: "gate-interval" };
}

export function agentViewOf(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, repoKey = "primary", pending = 0): MergeGateAgentView {
  const d = decideMergeGate(state, orch, 1, pending);
  return { repoKey, cadence: d.cadence, interval: d.interval, ungatedSinceLastPass: state.ungatedSinceLastPass, nextLandingGated: d.gate, gateOwed: state.gateOwed };
}

export function statusOf(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, repoKey = "primary", pending = 0): MergeGateStatus {
  return { ...agentViewOf(state, orch, repoKey, pending), lastPassAt: state.lastPassAt, lastFailure: state.lastFailure, recent: state.recent };
}

/** One-line manager-facing text for a landing ("ungated 3/5" / "the periodic gated landing"). Never a pass claim. */
export function counterNote(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, opts: { gatedLanding: boolean; periodic: boolean }): string | undefined {
  const { cadence, interval } = resolveMergeGateCadence(orch);
  if (cadence === "every") return undefined;
  const of = interval ? `/${interval}` : "";
  if (opts.gatedLanding && opts.periodic) return `this was the periodic gated landing (gate green ⇒ ungated counter reset to ${state.ungatedSinceLastPass}${of})`;
  if (opts.gatedLanding) return undefined;
  return `ungated ${state.ungatedSinceLastPass}${of} since the last passing gate${state.gateOwed ? " (a gate is OWED — the next landing runs it)" : ""}`;
}

export function applyUngatedLanding(state: MergeGateState, landed: number): MergeGateState {
  return { ...state, ungatedSinceLastPass: state.ungatedSinceLastPass + Math.max(0, Math.floor(landed)) };
}

function pushRecent(recent: MergeGateOutcomeEntry[], e: MergeGateOutcomeEntry): MergeGateOutcomeEntry[] {
  // One entry per gate op: a batch's K finalizes each report the SAME opId — never K ring rows.
  if (e.opId && recent.some((r) => r.opId === e.opId && r.result === e.result)) return recent;
  return [...recent, e].slice(-MERGE_GATE_RECENT_MAX);
}

export function applyGatePass(state: MergeGateState, p: { at: string; sha: string | null; opId: string | null; periodic: boolean; candidates?: number }): MergeGateState {
  const entry: MergeGateOutcomeEntry = { at: p.at, result: "pass", opId: p.opId, fromSha: state.lastPassSha, toSha: p.sha, ...(p.candidates ? { candidates: p.candidates } : {}) };
  return {
    ungatedSinceLastPass: 0, gateOwed: false, lastPassAt: p.at, lastPassSha: p.sha ?? state.lastPassSha, lastFailure: null,
    recent: p.periodic ? pushRecent(state.recent, entry) : state.recent,
  };
}

export function applyGateFail(state: MergeGateState, p: { at: string; opId: string | null; toSha: string | null; branchTip?: string | null; branch?: string | null; candidates?: number; periodic: boolean }): MergeGateState {
  const entry = { at: p.at, result: "fail" as const, opId: p.opId, fromSha: state.lastPassSha, toSha: p.toSha, ...(p.branchTip !== undefined ? { branchTip: p.branchTip } : {}), ...(p.branch !== undefined ? { branch: p.branch } : {}), ...(p.candidates ? { candidates: p.candidates } : {}) };
  return { ...state, gateOwed: state.gateOwed || p.periodic, lastFailure: entry, recent: pushRecent(state.recent, entry) };
}

/** A HUMAN cadence change (mergeGate / mergeGateInterval) clears `gateOwed` — the escape for an owner whose gate is broken —
 *  and records a `cleared` ring row. The ungated counter is deliberately NOT reset (the "unverified on main" figure stays honest).
 *  A no-op (same object) when nothing was owed. */
export function applyCadenceCleared(state: MergeGateState, at: string): MergeGateState {
  if (!state.gateOwed) return state;
  return { ...state, gateOwed: false, recent: pushRecent(state.recent, { at, result: "cleared", opId: null, fromSha: null, toSha: null, reason: "cadence-changed" }) };
}

export function applyGateNext(state: MergeGateState): MergeGateState {
  return { ...state, gateOwed: true };
}
