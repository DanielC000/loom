import { useState, type ReactNode } from "react";
import { color, font, fs } from "../theme";

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
        <span aria-hidden style={{ color: color.text2, fontFamily: font.mono, fontSize: fs.mono, width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 700, color: color.text2 }}>
          {title}
        </span>
        <span style={{ color: color.text3, fontWeight: 400, fontSize: fs.sm }}>
          {hint}
        </span>
      </button>
      {open && children}
    </section>
  );
}
