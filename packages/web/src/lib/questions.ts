import type { Question, QuestionType } from "@loom/shared";
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
// the threshold. `pending`/`consumed`/`notice` are never watchdog. Drives the amber re-escalation +
// "Nudge mgr". Card 59fa6403 round 2: a `notice` is its OWN terminal state (never "answered" — see
// QuestionState's own doc) precisely so this check (and every other `state === "answered"` reader)
// excludes it BY CONSTRUCTION, with no separate `type` check needed here at all.
export function isDecisionWatchdog(q: Pick<Question, "state" | "answeredAt">, nowMs: number, thresholdMs = DECISION_WATCHDOG_MS): boolean {
  if (q.state !== "answered" || !q.answeredAt) return false;
  const t = Date.parse(q.answeredAt);
  return Number.isFinite(t) && nowMs - t >= thresholdMs;
}

// Read/unread (Phase 2 of card 59fa6403) — ORTHOGONAL to `state`/`acknowledgedUntil`: a still-`pending`
// decision can be read-but-unanswered, a self-terminal `notice` can be answered-but-unread. Never conflate
// this with `isDecisionWatchdog` or a lifecycle chip — see `readAt`'s own doc on `Question`.
export function isUnread(q: Pick<Question, "readAt">): boolean {
  return q.readAt == null;
}

export interface StateChipSpec { tone: Tone; label: string; }

// The lifecycle chip (surface 4): pending (cyan, waiting on you) → answered (muted, waiting on the
// manager's pickup) → consumed (muted ✓, terminal), with the watchdog re-escalating an ignored `answered`
// to amber "WAITING ON MGR". `cancelled` (question_cancel/dismiss) is a FOURTH terminal state reachable
// only from pending — red, never confusable with the muted "resolved with an answer" states. `notice`
// (card 59fa6403) is a FIFTH, self-terminal state reading "FYI" — nobody answered it, so it must never
// read "ANSWERED" nor trigger the watchdog. One source of truth for every surface that renders a request's
// state.
export function questionStateChip(q: Pick<Question, "state" | "answeredAt">, nowMs: number, thresholdMs = DECISION_WATCHDOG_MS): StateChipSpec {
  if (q.state === "pending") return { tone: "cyan", label: "PENDING" };
  if (q.state === "cancelled") return { tone: "red", label: "CANCELLED" };
  if (q.state === "consumed") return { tone: "muted", label: "CONSUMED ✓" };
  if (q.state === "notice") return { tone: "muted", label: "FYI" };
  // answered
  return isDecisionWatchdog(q, nowMs, thresholdMs)
    ? { tone: "amber", label: "WAITING ON MGR" }
    : { tone: "muted", label: "ANSWERED" };
}

// ── Provenance vs routing (card 5b22b262) ───────────────────────────────────────────────────────
// A Request carries TWO session ids that answer DIFFERENT questions, and no human-facing surface may
// conflate them: `filedBySessionId` is the IMMUTABLE seat that FILED the ask; `sessionId` is the MUTABLE
// seat it is currently ROUTED to — `reparentQuestions` rewrites it onto a successor on every recycle, so
// a row filed weeks ago by a long-retired predecessor carries today's successor's id there. Rendering the
// routing id as the asker misattributes the ask after any recycle, on the very screen the human answers
// from. These helpers are the single source of truth for that split so it can't drift across surfaces.
// ⛔ ACTION affordances (the "sends your decision to…" caption, the nudge, the jump-to-live-session
// navigate) deliberately keep reading `sessionId` ALONE — a decision genuinely goes to the seat that
// currently owns the row, and naming the original filer there would point at a RETIRED session.

// The IMMUTABLE filer, short. `null` means "unknown, permanently" — a row created before the column
// existed, whose original filer was already overwritten by a recycle and is UNRECOVERABLE (see
// Question.filedBySessionId). ⛔ NEVER fall back to `sessionId` here: that re-creates the exact
// misattribution this exists to remove, and ⛔ never reconstruct a guess from timestamps.
export function requestFilerLabel(q: Pick<Question, "filedBySessionId">): string {
  return q.filedBySessionId ? `filed by ${q.filedBySessionId.slice(0, 8)}` : "filer unknown";
}

// The CURRENT routing target, short — "who will act on this", framed as a destination, never as the asker.
export function requestRoutedLabel(q: Pick<Question, "sessionId">): string {
  return `now routed to ${q.sessionId.slice(0, 8)}`;
}

// Both, in the owner's own form: "filed by 3f2a · now routed to 9b1c" (his decision on Request 68b06c50).
// ALWAYS both, even when the two ids match — they are separate facts, and a row that renders only one
// cannot reveal a divergence. Used verbatim as the `title` tooltip wherever the visible text ellipsizes.
export function requestProvenanceText(q: Pick<Question, "sessionId" | "filedBySessionId">): string {
  return `${requestFilerLabel(q)} · ${requestRoutedLabel(q)}`;
}

// The attention-queue row text for a pending decision: "routed to mgr <id8> · <project> — <title>". Kept
// terse so it reads at a glance beside the other attention kinds; the full ask lives on the answer page.
// This is a COMPACT surface where the full "filed by X · now routed to Y" does not fit, so it carries the
// CURRENT ROUTING TARGET only — "who will act on this" is the useful thing on an attention row, and it is
// what the human's answer actually reaches. It is FRAMED as a destination ("routed to mgr …") rather than
// as the asker, which is the defect: `mgr <id8>` alone read as provenance while carrying a mutable id.
export function decisionAttentionText(q: Pick<Question, "sessionId" | "title"> & { projectName?: string }): string {
  const mgr = `routed to mgr ${q.sessionId.slice(0, 8)}`;
  const proj = q.projectName ? ` · ${q.projectName}` : "";
  return `${mgr}${proj} — ${q.title}`;
}

// ── Request-type facet (card 695ebab0 — the Requests Inbox) ─────────────────────────────────────
// A durable Request carries a `type` discriminator (decision | input | permission | credential). Each
// type gets ONE signal tone from the EXISTING palette (no new color system) + its own answer affordance.
// These pure, JSX-free helpers are the single source of truth for how a type reads across every surface
// (the inbox rows, the type filter, the detail modal, the history table) so they can never drift; the
// hermetic web test imports them too.

// Type → signal tone. Owner-locked: decision=cyan (actionable question), input=phosphor (open answer),
// permission=red (irreversible/outward), credential=amber (secret). notice=muted — deliberately NOT one
// of the four "actionable" tones (card 59fa6403): nothing here asks for the human's attention the way the
// other four do, so it gets the same quiet tone questionStateChip already uses for a settled row.
export const REQUEST_TYPE_TONE: Record<QuestionType, Tone> = {
  decision: "cyan",
  input: "phosphor",
  permission: "red",
  credential: "amber",
  notice: "muted",
};

// Display order for the type-filter chip row + any per-type enumeration — a stable, deliberate sequence
// (the two everyday asks first, then the two trust-boundary asks, then the no-answer-needed FYI last).
export const REQUEST_TYPE_ORDER: QuestionType[] = ["decision", "input", "permission", "credential", "notice"];

// The pending row's primary action-button label, per type. `notice` never reaches this — it's never
// `pending` (card 59fa6403) — but the switch stays exhaustive so a future caller can't accidentally pass
// one and get a misleading "Answer →".
export function requestActionLabel(type: QuestionType): string {
  switch (type) {
    case "permission": return "Review →";
    case "credential": return "Provide →";
    case "notice": return "View";
    default: return "Answer →"; // decision / input
  }
}

// The global attention-surface label (toast/bell/⌘K + Mission Control queue), per type — a pending
// request is NOT always a "decision" (a credential ask is a secret, not a choice). Single source so the
// label can't drift between surfaces; lib/attention derives every pending-request item's `kind` off this.
// `notice` is never `pending` so this label is never actually shown for one in today's attention queue
// (which only lists pending requests) — kept exhaustive anyway, see requestActionLabel's note above.
export function requestAttentionLabel(type: QuestionType): string {
  switch (type) {
    case "credential": return "SECRET NEEDED";
    case "permission": return "PERMISSION NEEDED";
    case "input": return "INPUT NEEDED";
    case "decision": return "DECISION NEEDED";
    case "notice": return "FYI";
  }
}

// The pending row's short "what's needed" state chip label, per type. See requestActionLabel's note on
// why `notice` is covered even though it never reaches a pending row.
export function requestNeedsChip(type: QuestionType): string {
  switch (type) {
    case "decision": return "needs pick";
    case "input": return "needs answer";
    case "permission": return "needs auth";
    case "credential": return "needs secret";
    case "notice": return "no answer needed";
  }
}

// The detail modal's "how to answer" badge label, per type. A pure-blocker decision (no options) reads
// "note only" — the note IS the answer — matching the pre-generalization decision page.
export function requestAnswerBadge(q: Pick<Question, "type" | "options">): string {
  switch (q.type) {
    case "decision": return q.options && q.options.length > 0 ? "pick one or write a note" : "note only";
    case "input": return "open answer";
    case "permission": return "authorize or deny";
    case "credential": return "write-only secret";
    case "notice": return "FYI — no answer needed";
  }
}

// The type-colored one-line hint shown under a pending row's meta line, per type.
export function requestHint(q: Pick<Question, "type" | "options" | "recommendation" | "permissionAction">): string {
  switch (q.type) {
    case "credential":
      return "secret · stored encrypted, never echoed back";
    case "permission":
      return `irreversible · outward${q.permissionAction ? ` — ${q.permissionAction}` : ""}`;
    case "input":
      return "open answer · free text";
    case "notice":
      return "FYI · no answer needed";
    default: {
      // decision — options + recommendation, or a pure-blocker note-only ask.
      if (q.options && q.options.length > 0) {
        return `${q.options.length} option${q.options.length === 1 ? "" : "s"}${q.recommendation ? ` · rec. ${q.recommendation}` : ""}`;
      }
      return "open decision · note only";
    }
  }
}

// The recorded-outcome text for an answered/consumed/cancelled request (the history table + the answered
// readout). Never surfaces a secret — a credential always reads "provided · encrypted, not shown". A
// cancelled request was NEVER answered — this must be checked BEFORE the per-type switch below, or a
// cancelled decision/input would misleadingly fall through to "—" (indistinguishable from "answered with
// no note") instead of naming what actually happened. A "notice" is never cancellable (never pending) so
// the cancelled branch above never actually reaches it — its own case below is what always applies.
export function requestOutcome(q: Pick<Question, "type" | "chosenOption" | "note" | "state" | "cancelledReason">): string {
  if (q.state === "cancelled") return q.cancelledReason ? `cancelled · ${q.cancelledReason}` : "cancelled";
  switch (q.type) {
    case "credential":
      return "provided · encrypted, not shown";
    case "permission":
      return q.chosenOption === "authorize"
        ? `authorized${q.note ? ` · ${q.note}` : " · this action"}`
        : `denied${q.note ? ` · ${q.note}` : ""}`;
    case "input":
      return q.note ? `“${q.note}”` : "—";
    case "notice":
      return "FYI — no answer needed";
    default: // decision
      return q.chosenOption ? `chose ${q.chosenOption}` : q.note ? `“${q.note}”` : "—";
  }
}
