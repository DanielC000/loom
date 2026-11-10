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
 *  - an INTERVAL skip is also refused (the gate runs) while the candidate's own tip carries a settled red run_gate self-check,
 *    unless the manager supplies a recorded `overrideReason` (card 4a95e9fc); cadence=never never forces, it only warns
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

/** A settled RED worker `run_gate` self-check recorded against the candidate branch's own tip (card 4a95e9fc). `overrideReason`
 *  is the manager's RECORDED (never authenticated) reason for landing it ungated anyway; absent ⇒ no override. */
export interface RedSelfCheck { opId: string; head: string; overrideReason?: string }

export type MergeGateDecisionReason = "every" | "owed" | "interval-due" | "red-self-check" | "skip-never" | "skip-interval";
export interface MergeGateDecision {
  /** Set when a red self-check on the candidate's tip bore on this decision: it FORCED the gate (`reason:"red-self-check"`),
   *  was OVERRIDDEN (an interval skip carrying `overrideReason`), or is merely WARNED about (gate off — never forced). */
  redSelfCheck?: RedSelfCheck;
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
  /** The latest settled red self-check on the candidate's own tip, if any (see {@link redSelfCheckOnTip}). Forces the gate on an
   *  INTERVAL skip unless it carries an `overrideReason`; under cadence "never" (a human switched the gate off) it only rides
   *  along as a warning — it never forces or refuses. */
  red?: RedSelfCheck,
): MergeGateDecision {
  const { cadence, interval } = resolveMergeGateCadence(orch);
  const gated = (reason: MergeGateDecisionReason): MergeGateDecision => ({ gate: true, cadence, interval, reason, identityValue: "on" });
  if (cadence === "every") return gated("every");
  if (state.gateOwed) return gated("owed");
  if (cadence === "interval" && state.ungatedSinceLastPass + pending + K > interval!) return gated("interval-due");
  if (cadence === "interval" && red && red.overrideReason === undefined) return { ...gated("red-self-check"), redSelfCheck: red };
  const skip: MergeGateDecision = cadence === "never"
    ? { gate: false, cadence, interval, reason: "skip-never", identityValue: "off", skipReason: "gate-disabled" }
    : { gate: false, cadence, interval, reason: "skip-interval", identityValue: "off", skipReason: "gate-interval" };
  return red ? { ...skip, redSelfCheck: red } : skip;
}

/**
 * Card 4a95e9fc — the latest settled self-check verdict on EXACTLY `tip`, from a branch's `worker_gate` events (chronological,
 * oldest first). Returns the red's `{opId, head}` only when the NEWEST verdict-bearing event on that tip is a fail — so a later
 * green on the same tip clears it. Counts only real run_gate verdicts: a row needs the `settleHead` a run_gate settle stamps, and
 * a cancelled run, a thrown-error row (`error`), a landing-check/dist-importer row, or a row on another head carries no verdict
 * for this tip and is skipped. The head set is the branch's tip plus the commits reached through merges of main
 * (`mergeOfMainHeadSet`, git/mainline-watch.ts), so a union-merge forward of main that a cancelled/refused confirm left on the
 * branch cannot launder a red stamped below it; each head keeps the newest-verdict-wins rule and the newest red across the set
 * is returned. A NEW commit by the worker is a new head and out of scope (a known limit).
 */
export function redSelfCheckOnTip(events: readonly { detail?: Record<string, unknown> | undefined }[], tipOrHeads: string | readonly string[] | null | undefined): { opId: string; head: string } | undefined {
  const heads = typeof tipOrHeads === "string" ? [tipOrHeads] : (tipOrHeads ?? []).filter(Boolean);
  let best: { opId: string; head: string; at: number } | undefined;
  for (const head of heads) {
    // Newest verdict-bearing event on THIS head decides it (a later green on the same head clears its red).
    for (let i = events.length - 1; i >= 0; i--) {
      const d = events[i]!.detail;
      if (!d) continue;
      // A run whose tree moved mid-run (`headCurrent:false`) also stamps the settle worktree head: a RED counts on either head,
      // a GREEN only on the head the run started on (fails closed).
      const onHead = d.settleHead === head || (d.passed === false && d.settleWorktreeHead === head);
      if (!onHead) continue;
      if (d.cancelled === true || typeof d.error === "string" || d.landingCheckOnly === true || d.distImporterCheckOnly === true) continue;
      if (typeof d.passed !== "boolean") continue;
      if (d.passed === false && typeof d.opId === "string" && (!best || i > best.at)) best = { opId: d.opId, head, at: i };
      break;
    }
  }
  return best ? { opId: best.opId, head: best.head } : undefined;
}

export function agentViewOf(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, repoKey = "primary", pending = 0): MergeGateAgentView {
  const d = decideMergeGate(state, orch, 1, pending);
  return { repoKey, cadence: d.cadence, interval: d.interval, ungatedSinceLastPass: state.ungatedSinceLastPass, nextLandingGated: d.gate, gateOwed: state.gateOwed };
}

export function statusOf(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, repoKey = "primary", pending = 0): MergeGateStatus {
  return { ...agentViewOf(state, orch, repoKey, pending), lastPassAt: state.lastPassAt, lastFailure: state.lastFailure, recent: state.recent };
}

/** One-line manager-facing text for a landing ("ungated 3/5" / "the periodic gated landing"). Never a pass claim.
 *  `gatedLanding` is whether this landing's cadence DECISION said to gate (i.e. `!gateDisabled`) — that alone
 *  does NOT mean a gate actually ran or passed: an inert docs-only diff (card db9b0130) can skip the gate even
 *  on a landing that was due, so `inertSkip` (true whenever NO real gate ran and none was reused — see
 *  `confirmWorkerMerge`'s own `inertSkip` local) disambiguates the two outcomes within a gated-and-periodic
 *  landing. A REUSED verdict is a real pass for this purpose (`inertSkip` stays false for it). */
export function counterNote(state: MergeGateState, orch: { mergeGate: "on" | "off"; mergeGateInterval?: number | undefined }, opts: { gatedLanding: boolean; periodic: boolean; inertSkip?: boolean }): string | undefined {
  const { cadence, interval } = resolveMergeGateCadence(orch);
  if (cadence === "every") return undefined;
  const of = interval ? `/${interval}` : "";
  if (opts.gatedLanding && opts.periodic) {
    if (opts.inertSkip) return `inert docs-only diff — gate SKIPPED (not a pass); the periodic gated landing is still owed by the next non-inert landing (ungated ${state.ungatedSinceLastPass}${of})`;
    return `this was the periodic gated landing (gate green ⇒ ungated counter reset to ${state.ungatedSinceLastPass}${of})`;
  }
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
