import type { QuestionInboxItem } from "@loom/shared";
import { Dot } from "./ui";
import { font, radius, tone } from "../theme";
import { questionStateChip } from "../lib/questions";

// The shared lifecycle STATE CHIP for a manager→human Request (card 8701bdbb → generalized 695ebab0).
// Kept here as the one small primitive the fleet attention row still renders directly; the full Requests
// Inbox (rows, type filter, detail modal, history) lives in components/requests.tsx. Native to the
// terminal-cockpit kit — reuses Dot + the `theme` tones.

// ── DecisionStateChip ───────────────────────────────────────────────────────────
// pending (cyan · waiting on you) → answered (muted · waiting on the manager's pickup) → consumed
// (muted ✓ · terminal), with the watchdog re-escalating an ignored `answered` to amber "WAITING ON MGR".
// A bordered dot-pill, tone-driven via the single questionStateChip source of truth.
export function DecisionStateChip({ q, now }: { q: Pick<QuestionInboxItem, "state" | "answeredAt">; now: number }) {
  const spec = questionStateChip(q, now);
  const c = tone[spec.tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono, fontSize: 11,
      textTransform: "uppercase", letterSpacing: "0.06em", color: c, border: `1px solid ${c}`, borderRadius: radius.sm, padding: "1px 8px" }}>
      <Dot tone={spec.tone} glow={spec.tone === "amber"} />
      {spec.label}
    </span>
  );
}
