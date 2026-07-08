import type { Question } from "@loom/shared";
import type { Tone } from "../theme";

// Pure (JSX-free) helpers for the manager→human DECISION INBOX web surfaces (card 8701bdbb, child B):
// the state-chip tone/label, the watchdog derivation, the attention-row text, and a relative-age
// formatter. JSX-free so the hermetic web test can import it and so lib/attention (the attention
// derivation) can build DECISION-NEEDED items without pulling in a component.

// Client-side watchdog threshold. An `answered` question the manager never picked up re-escalates to
// amber ("WAITING ON MGR") after this long. The REAL server-side watchdog TRIGGER is a separate
// follow-up card; until it lands, this age heuristic drives the amber state off `answeredAt`. Kept as a
// single named constant so the eventual server signal has one clean place to override it.
export const DECISION_WATCHDOG_MS = 30 * 60_000; // 30 min

// A relative "4m ago" / "2h ago" / "3d ago" / "now" label from an ISO instant. `nowMs` is injected so the
// formatter stays pure/testable (no ambient clock). Returns "" for a null/unparseable instant.
export function relativeAge(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, nowMs - t);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The watchdog case (surface 4): an `answered` question whose asking manager never pulled it, older than
// the threshold. `pending`/`consumed` are never watchdog. Drives the amber re-escalation + "Nudge mgr".
export function isDecisionWatchdog(q: Pick<Question, "state" | "answeredAt">, nowMs: number, thresholdMs = DECISION_WATCHDOG_MS): boolean {
  if (q.state !== "answered" || !q.answeredAt) return false;
  const t = Date.parse(q.answeredAt);
  return Number.isFinite(t) && nowMs - t >= thresholdMs;
}

export interface StateChipSpec { tone: Tone; label: string; }

// The lifecycle chip (surface 4): pending (cyan, waiting on you) → answered (muted, waiting on the
// manager's pickup) → consumed (muted ✓, terminal), with the watchdog re-escalating an ignored `answered`
// to amber "WAITING ON MGR". One source of truth for every surface that renders a decision's state.
export function questionStateChip(q: Pick<Question, "state" | "answeredAt">, nowMs: number, thresholdMs = DECISION_WATCHDOG_MS): StateChipSpec {
  if (q.state === "pending") return { tone: "cyan", label: "PENDING" };
  if (q.state === "consumed") return { tone: "muted", label: "CONSUMED ✓" };
  // answered
  return isDecisionWatchdog(q, nowMs, thresholdMs)
    ? { tone: "amber", label: "WAITING ON MGR" }
    : { tone: "muted", label: "ANSWERED" };
}

// The attention-queue row text for a pending decision: "mgr <id8> · <project> — <title>". Kept terse so it
// reads at a glance beside the other attention kinds; the full ask lives on the answer page.
export function decisionAttentionText(q: Pick<Question, "sessionId" | "title"> & { projectName?: string }): string {
  const mgr = `mgr ${q.sessionId.slice(0, 8)}`;
  const proj = q.projectName ? ` · ${q.projectName}` : "";
  return `${mgr}${proj} — ${q.title}`;
}
