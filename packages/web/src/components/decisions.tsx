import type { QuestionInboxItem } from "@loom/shared";
import { StatusPill } from "./ui";
import { questionStateChip } from "../lib/questions";

// The shared lifecycle STATE CHIP for a manager→human Request (card 8701bdbb → generalized 695ebab0).
// Kept here as the one small primitive the fleet attention row still renders directly; the full Requests
// Inbox (rows, type filter, detail modal, history) lives in components/requests.tsx. Native to the
// terminal-cockpit kit — reuses Dot + the `theme` tones.

// ── DecisionStateChip ───────────────────────────────────────────────────────────
// pending (cyan · waiting on you) → answered (muted · waiting on the manager's pickup) → consumed
// (muted ✓ · terminal) → notice (muted · "FYI", card 59fa6403), with the watchdog re-escalating an
// ignored `answered` to amber "Waiting on mgr". The kit's status capsule, tone-driven via the single
// questionStateChip source of truth.
export function DecisionStateChip({ q, now }: { q: Pick<QuestionInboxItem, "state" | "answeredAt"> & Partial<Pick<QuestionInboxItem, "type" | "permissionAction">>; now: number }) {
  const spec = questionStateChip(q, now);
  return <StatusPill tone={spec.tone} label={spec.label} style={{ flexShrink: 0 }} />;
}
