import { useState, type ReactNode } from "react";
import { color, font } from "../theme";

// A history section that's collapsed by default — the Lead/Auditor run logs get long, so tuck them
// away until the human asks. Reuses the AgentPromptEditor disclosure idiom (▾/▸ chevron, phosphor when
// open) fused with SectionLabel's header typography, so the affordance reads identically to the rest of
// the cockpit. Session-only state (a reload re-collapses — acceptable; persistence is optional here).
//
// Hoisted out of DeveloperPlatformView into shared UI (card 8adccd37) so the unified PlatformView shell's
// history sections (dev collapsed) route through the SAME disclosure — no per-view copy of it.
export function CollapsibleHistory({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? `Collapse ${title}` : `Expand ${title}`}
        style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
          padding: 0, margin: "4px 0 8px", cursor: "pointer", textAlign: "left", width: "100%" }}>
        <span aria-hidden style={{ color: open ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 12, width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
          {title}
        </span>
        <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
          {hint}
        </span>
      </button>
      {open && children}
    </section>
  );
}
