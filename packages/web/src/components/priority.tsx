import type { Task, TaskPriority } from "@loom/shared";
import { color, font, tone, type Tone } from "../theme";

// Priority metadata: low number = higher priority. Each maps to a theme tone for its card chip.
// p2 (Normal) is the DEFAULT and stays understated; p0/p1 pop (filled chip) to draw the eye.
// Shared so the board card/drawer and the /terminals session task card render the SAME priority
// styling from one source (don't fork the priority look across pages).
export const PRIORITY_META: Record<TaskPriority, { tone: Tone; label: string; short: string }> = {
  p0: { tone: "red", label: "Critical", short: "P0" },
  p1: { tone: "amber", label: "High", short: "P1" },
  p2: { tone: "cyan", label: "Normal", short: "P2" },
  p3: { tone: "muted", label: "Low", short: "P3" },
};

// Defensive read: a task served by a not-yet-restarted daemon (staggered deploy — web ships via HMR
// before the daemon goes live) carries no `priority` field; treat it as the p2 default. Takes only the
// `priority` field (not the full Task) so a BoardTask — the board LIST route's body-optional projection,
// card 4fa2c146 — satisfies it too, same as Task.
export const prio = (t: Pick<Task, "priority">): TaskPriority => t.priority ?? "p2";

// Small colored priority chip shown on a card face. p0/p1 are filled (pop); p2/p3 are outlined
// and understated so a board full of Normal cards stays calm.
export function PriorityChip({ priority }: { priority: TaskPriority }) {
  const m = PRIORITY_META[priority];
  const c = tone[m.tone];
  const pop = priority === "p0" || priority === "p1";
  return (
    <span title={`Priority: ${m.label}`} style={{
      flexShrink: 0, fontFamily: font.head, fontSize: 9, fontWeight: pop ? 700 : 500,
      letterSpacing: "0.06em", lineHeight: "13px", padding: "0 4px", borderRadius: 3,
      color: pop ? color.bg : c, background: pop ? c : "transparent", border: `1px solid ${c}`,
      opacity: priority === "p2" ? 0.75 : 1,
    }}>{m.short}</span>
  );
}
