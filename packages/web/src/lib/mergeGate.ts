// Merge-gate CADENCE — the web half of the periodic-gate feature (card 00664e74; daemon side 6f13746c).
//
// While the per-project merge gate is off, an interval N lets N merges land ungated; the next landing
// runs the real gate command. A pass resets the counter; a FAILED periodic gate owes a gate on every
// later landing until one passes.
//
// This module is deliberately JSX-free and import-light (types + pure functions only) so the hermetic
// unit test can load the REAL shipped derivations directly — see packages/web/test/merge-gate.mjs. It is
// also the ONE place the state vocabulary (tone + badge word + sentence) and the interval validation copy
// live, so the Overview strip and the Settings panel can never word the same state differently. The
// mockup README made that a requirement, not a nicety: two surfaces showing the same counter with
// different words is how a reader concludes one of them is stale.

import {
  MERGE_GATE_INTERVAL_MAX,
  resolveMergeGateCadence,
  type MergeGateAgentView,
  type MergeGateCadence,
  type MergeGateOutcomeEntry,
  type MergeGateStatus,
  type OrchestrationConfig,
} from "@loom/shared";
import type { Tone } from "../theme";

// The wire contract (MergeGateStatus / MergeGateOutcomeEntry / MergeGateAgentView) and the cadence
// derivation are OWNED BY @loom/shared as of card 6f13746c — this module deliberately re-exports rather
// than re-declaring them, so the web can never drift from the daemon's own shape or disagree with it about
// what a stored config means. It keeps only what is genuinely web-side: the state vocabulary (tone + badge
// word + sentence), the validation copy, and the rendering-shape helpers.
export type { MergeGateAgentView, MergeGateCadence, MergeGateOutcomeEntry, MergeGateStatus };
/** The verdict-ring entry, under the name the web surfaces already use for it. */
export type MergeGateVerdict = MergeGateOutcomeEntry;
/** A failure entry is the same shape, narrowed to the failing result. */
export type MergeGateFailure = MergeGateOutcomeEntry & { result: "fail" };

/** How many verdicts the strip's editor renders (direction C's borrowing — the last six periodic gates). */
export const RECENT_VERDICT_CAP = 6;

// ── Interval bounds + validation ─────────────────────────────────────────────────────────────────────
// 1..1000 per the contract. N means "ungated landings ALLOWED BETWEEN gates" (README UX problem 3): at
// N=5 five merges land ungated and the sixth runs the gate, so "clear the field" is continuous with
// N → ∞ (never gated) rather than a special case.

export const INTERVAL_MIN = 1;
/** Re-exported from shared, never re-stated: the daemon validator and this field must agree on the ceiling. */
export const INTERVAL_MAX = MERGE_GATE_INTERVAL_MAX;

/** The one validation message both surfaces show. `null` = the raw value is acceptable. */
export function intervalError(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null; // blank is meaningful: it selects the `never` cadence, not an error
  if (!/^\d+$/.test(t)) return `Enter a whole number of ${INTERVAL_MIN} or more. Clear the field to never gate.`;
  const n = Number(t);
  if (n < INTERVAL_MIN) return `Enter a whole number of ${INTERVAL_MIN} or more. Clear the field to never gate.`;
  if (n > INTERVAL_MAX) return `The most Loom accepts is ${INTERVAL_MAX} ungated merges between gates.`;
  return null;
}

/** The raw field as a stored interval: a valid integer, or null for blank/invalid (caller blocks on the error). */
export function parseInterval(raw: string): number | null {
  const t = raw.trim();
  if (t === "" || intervalError(t)) return null;
  return Number(t);
}

// ── Config ⇄ cadence ─────────────────────────────────────────────────────────────────────────────────
// The STORED shape stays backward-compatible (`mergeGate: "on" | "off"` plus an optional
// `mergeGateInterval`), but every CONTROL and every word of copy is three-valued — README UX problem 1:
// a project set to "off, interval 5" runs the gate regularly, so calling that state "off" in the UI
// would be false about the project's actual behaviour.

/**
 * The cadence a stored override expresses, via shared's `resolveMergeGateCadence` — the ONE derivation, so
 * the control can never disagree with the daemon about what a stored config means. An override with no
 * `mergeGate` key inherits the `on` default ⇒ `every`.
 */
export function cadenceOf(override: Partial<OrchestrationConfig> | undefined): MergeGateCadence {
  return resolveMergeGateCadence({
    mergeGate: override?.mergeGate ?? "on",
    mergeGateInterval: override?.mergeGateInterval,
  }).cadence;
}

/** The stored interval, or "" when the override carries none — the Settings field's initial value. */
export function intervalFieldOf(override: Partial<OrchestrationConfig> | undefined): string {
  return typeof override?.mergeGateInterval === "number" ? String(override.mergeGateInterval) : "";
}

/**
 * The config write a cadence choice implies, as the two things Settings' buildOverride needs: the keys to
 * SET, and the dot-paths to UNSET. Returning both (rather than mutating) keeps this testable and keeps the
 * `every` case honest — it CLEARS both keys rather than storing `mergeGate: "on"`, matching how the
 * existing checkbox already behaved (an override key is removed, not written back as the default).
 */
export function cadenceConfigWrite(cadence: MergeGateCadence, intervalRaw: string): {
  set: { mergeGate?: "off"; mergeGateInterval?: number };
  unset: string[];
} {
  if (cadence === "every") return { set: {}, unset: ["orchestration.mergeGate", "orchestration.mergeGateInterval"] };
  if (cadence === "never") return { set: { mergeGate: "off" }, unset: ["orchestration.mergeGateInterval"] };
  const n = parseInterval(intervalRaw);
  // A caller must block Save on intervalError first; if it somehow reaches here blank, that IS `never`.
  if (n === null) return { set: { mergeGate: "off" }, unset: ["orchestration.mergeGateInterval"] };
  return { set: { mergeGate: "off", mergeGateInterval: n }, unset: [] };
}

// ── State vocabulary ─────────────────────────────────────────────────────────────────────────────────
// The shared tones + words from the mockup README's state table. Every tone is an existing Loom signal
// tone; nothing here introduces a colour.

export type MergeGateStateKey = "every" | "counting" | "due" | "never" | "failed";

export interface MergeGateRead {
  state: MergeGateStateKey;
  tone: Tone;
  /** Whether the badge carries a CRT glow — reserved for the real verdict (a failed gate), never a setting. */
  glow: boolean;
  /** The badge word, e.g. "Every 5th merge". */
  badge: string;
  /** The plain sentence that says what happens next. The strip is the only surface with room for it. */
  sentence: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Classify a status into the strip's five states.
 *
 * `failed` outranks everything: a failed periodic gate suspends the interval, so the fraction stops being
 * the number that matters (README UX problem 2). It requires BOTH flags — see `isEscalatedFailure`.
 */
export function readMergeGate(s: MergeGateStatus): MergeGateRead {
  const unverified = Math.max(0, s.ungatedSinceLastPass);
  const behind = `${unverified} ${plural(unverified, "merge", "merges")}`;

  if (isEscalatedFailure(s)) {
    return {
      state: "failed", tone: "red", glow: true, badge: "Gate failed",
      sentence: `Every merge is gated until one passes. ${behind} landed unverified behind it.`,
    };
  }
  if (s.cadence === "every") {
    return {
      state: "every", tone: "phosphor", glow: false, badge: "Every merge",
      sentence: "Every merge runs the gate command before it lands.",
    };
  }
  if (s.cadence === "never") {
    return {
      state: "never", tone: "red", glow: false, badge: "Never gated",
      sentence: `${behind} ${plural(unverified, "has", "have")} landed unverified. Nothing on the default branch is being checked.`,
    };
  }
  const n = s.interval ?? 0;
  if (s.nextLandingGated) {
    return {
      state: "due", tone: "cyan", glow: false, badge: badgeForInterval(n),
      sentence: "The next merge runs the gate. A pass resets the counter to 0; a fail keeps every merge gated.",
    };
  }
  const left = Math.max(0, n - unverified);
  return {
    state: "counting", tone: "amber", glow: false, badge: badgeForInterval(n),
    sentence: left > 0
      ? `${left} more ${plural(left, "merge lands", "merges land")} ungated, then the gate runs.`
      : "The next merge runs the gate.",
  };
}

/**
 * The escalated "gate failed" state: `gateOwed && lastFailure`, and deliberately NOT `lastFailure` alone.
 *
 * A gate that fails under cadence=`every` lands in `recent`/`lastFailure` but does NOT set `gateOwed` —
 * every merge was already being gated, so nothing is owed and nothing escalated. Keying on the presence of
 * `lastFailure` would therefore paint a healthy fully-gated project red for the rest of its life after one
 * red gate. `gateOwed` alone is not sufficient either: the "gate the next merge" button sets it with no
 * failure at all, which is a `due`, not a failure.
 */
export function isEscalatedFailure(s: MergeGateStatus): boolean {
  return s.gateOwed && s.lastFailure != null;
}

/** "Every 5th merge" — the ordinal is N+1 because N is the count of ungated landings ALLOWED. */
export function badgeForInterval(n: number): string {
  if (n <= 0) return "Every Nth merge";
  return `Every ${ordinal(n + 1)} merge`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * The tick track degrades to the kit's `Meter` above this many ticks — a track you have to count is not
 * glanceable, and beyond ~12 seven-pixel dots stop reading as a quantity at all.
 */
export const TICK_TRACK_MAX = 12;

// NOT a React hook despite living next to the components that call it — named `showsTicks` deliberately
// so it can be called conditionally (which TickTrack does, after an early return) without reading as a
// hooks-rule violation to the next person editing that component.
/** Whether an interval is small enough to render as countable dots rather than a meter. */
export function showsTicks(interval: number | null): boolean {
  return interval !== null && interval > 0 && interval <= TICK_TRACK_MAX;
}

// ── Age formatting ───────────────────────────────────────────────────────────────────────────────────

/** "2h 14m ago" / "14m ago" / "3d 4h ago" — compact, mono-friendly, no em-dashes. */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const ms = now - +new Date(iso);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

/** A sha as the 7-char short form the rest of the UI uses; passes through a null/blank. */
export function shortSha(sha: string | null | undefined): string | null {
  const t = (sha ?? "").trim();
  return t ? t.slice(0, 7) : null;
}

/**
 * The bisect range a failed periodic gate leaves behind — README UX problem 4: five merges are already on
 * main when the sixth's gate fails, so the recovery path is "bisect these" and the range is what makes
 * that actionable.
 *
 * `fromSha` is legitimately null when the project has never had a passing gate, so there is no anchor for
 * the low end of the range. That is NOT a missing value to hide — the unverified span genuinely reaches
 * back to the start of tracking, which is a worse situation than a bounded range, not an unknown one.
 * `null` only when there is no `toSha` either, i.e. the daemon recorded no range at all.
 */
export function bisectLabel(f: { fromSha?: string | null; toSha?: string | null } | null | undefined): string | null {
  const to = shortSha(f?.toSha);
  if (!to) return null;
  const from = shortSha(f?.fromSha);
  return from ? `${from}..${to}` : "since tracking began";
}

/**
 * What landed under a failed gate: the rejected candidate's branch tip (solo), or the batch's candidate
 * count. A batch carries no single branch by design, so these are mutually exclusive in practice and both
 * are optional on the wire. `null` when the daemon reported neither.
 */
export function landingLabel(f: { branchTip?: string | null; branch?: string | null; candidates?: number } | null | undefined): { label: string; value: string } | null {
  if (typeof f?.candidates === "number" && f.candidates > 0) {
    return { label: "batch", value: `${f.candidates} ${plural(f.candidates, "branch", "branches")}` };
  }
  // The NAME reads better than a sha and is what a person would actually go looking for, so prefer it
  // whenever the daemon knows it; the tip sha is the FALLBACK, not the other way round. Both optional.
  const name = (f?.branch ?? "").trim();
  if (name) return { label: "branch", value: name };
  const tip = shortSha(f?.branchTip);
  return tip ? { label: "branch", value: tip } : null;
}

/**
 * One mark in the verdict strip. Three-way, NOT a boolean: a `cleared` entry rendered by a pass/fail
 * branch would read as a failed gate, asserting a red run that never happened.
 *
 * The neutral glyph is deliberately not the cyan "next pending" dot either — cyan is Loom's
 * verification-imminent tone, and a dropped obligation is the opposite of imminent.
 */
export function verdictMark(v: Pick<MergeGateVerdict, "result" | "reason" | "at"> & { fromSha?: string | null; toSha?: string | null; branch?: string | null; branchTip?: string | null }, now: number = Date.now()): {
  kind: "pass" | "fail" | "cleared";
  glyph: string;
  tone: Tone;
  title: string;
} {
  if (v.result === "cleared") {
    // An UNKNOWN reason must not be labelled "a settings change" — that would state a cause we were never
    // told. Name the raw reason instead, so a new one surfaces rather than being quietly mislabelled.
    const known = (v.reason ?? "") === "cadence-changed";
    const why = known ? "owed gate cleared by a settings change" : `owed gate cleared (${v.reason || "reason not given"})`;
    return { kind: "cleared", glyph: "○", tone: "muted", title: `${why} ${ago(v.at, now)}` };
  }
  const pass = v.result === "pass";
  const range = bisectLabel(v);
  const landing = landingLabel(v);
  return {
    kind: pass ? "pass" : "fail",
    glyph: pass ? "✓" : "✗",
    tone: pass ? "phosphor" : "red",
    title: [`${pass ? "passed" : "failed"} ${ago(v.at, now)}`, landing ? `${landing.label} ${landing.value}` : null, range]
      .filter(Boolean).join(" · "),
  };
}

/**
 * The weakening note a non-default cadence carries — the same shape Settings already uses for a
 * rotation-guard weakening. Amber for `every Nth` (the bisect cost, README UX problem 4); red for `never`.
 * `null` at `every`, which weakens nothing. Lives here, not in the component, so the copy is covered by the
 * same hermetic test as every other string this feature renders.
 */
export function weakeningNote(cadence: MergeGateCadence, interval: number | null): { tone: "amber" | "red"; text: string } | null {
  if (cadence === "every") return null;
  if (cadence === "never") {
    return {
      tone: "red",
      text: "No merge will run the gate command. Merges are still refused on a conflict or a dirty tree, but nothing on the default branch is verified. No agent can make this change, and turning the gate back on is a fresh decision, not an undo.",
    };
  }
  // No N yet (blank, mid-typing, or invalid) ⇒ NO note. Quoting a cost derived from an unusable value
  // renders "up to 0 merges reach the default branch" directly beneath the error saying 0 is not allowed —
  // a confident claim that contradicts the message right above it. The inline error is the copy that
  // matters at that moment; the cost note returns as soon as there is a real number to state it about.
  if (interval === null || interval <= 0) return null;
  const n = interval;
  const merges = `${n} ${plural(n, "merge", "merges")}`;
  return {
    tone: "amber",
    text: `At this cadence up to ${merges} reach the default branch without ever running the gate command. When the next one fails, those ${n} are already landed, so the gate tells you something broke, not which merge broke it.`,
  };
}

/**
 * The Attention-row escalation on a failed periodic gate (direction B's borrowing, chosen alongside A).
 * Returns the row's text, or `null` when there is nothing to escalate — so Overview can append it to its
 * Attention list without duplicating the classification. Deliberately NOT routed through lib/attention's
 * `useAttention`: that hook is GLOBAL (it feeds the shell bell across every project) and derives purely
 * from sessions + manager events, whereas this is project-scoped and read from the merge-gate endpoint.
 */
export function gateFailureAttentionText(s: MergeGateStatus, now: number = Date.now()): string | null {
  if (!isEscalatedFailure(s) || !s.lastFailure) return null;
  const unverified = Math.max(0, s.ungatedSinceLastPass);
  const range = bisectLabel(s.lastFailure);
  const landing = landingLabel(s.lastFailure);
  const on = landing ? ` on ${landing.value}` : "";
  const behind = `${unverified} ${plural(unverified, "merge", "merges")} landed ungated before it`;
  return `Periodic gate failed${on} ${ago(s.lastFailure.at, now)}. Every merge stays gated until one passes. ${behind}${range ? ` (${range})` : ""}.`;
}
