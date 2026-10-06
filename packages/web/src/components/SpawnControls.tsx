import { useState } from "react";
import type { SessionRole } from "@loom/shared";
import { Button } from "./ui";
import { color, font } from "../theme";
import { useDismissable } from "../lib/useDismissable";

// Spawn split-button: the primary action spawns from the agent's profile (no role → the profile's role
// applies server-side); the ▾ menu overrides the role per-spawn. "From profile" = auto, "Manager" =
// explicit manager, "Plain" = force-plain (ignore the profile's role → a role-null session).
//
// Extracted VERBATIM from Workspace's local SpawnControls so Workspace's single-agent Sessions header
// and the Overview Agents section drive the SAME split-button (identical labels, menu, and gating).
// Prop shape unchanged: { profileRole, onSpawn, pending }.
export function SpawnControls({ profileRole, onSpawn, pending }:
  { profileRole: SessionRole | null; onSpawn: (role?: "manager" | "plain") => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const options: { label: string; role?: "manager" | "plain" }[] = [
    { label: "From profile (default)", role: undefined },
    { label: "Manager", role: "manager" },
    { label: "Plain", role: "plain" },
  ];
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <Button variant="primary" disabled={pending} onClick={() => { setOpen(false); onSpawn(undefined); }}
        title={`Spawn from profile — role: ${profileRole ?? "plain"}`}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        Spawn{profileRole ? ` · ${profileRole}` : ""}
      </Button>
      <Button variant="primary" disabled={pending} onClick={() => setOpen((o) => !o)} title="Override the spawn role"
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "none", padding: "4px 6px" }}>▾</Button>
      {open && (
        // ANCHORED LEFT, not right (card 74915cad). The panel is wider than the ~110px split button it
        // hangs off, so a `right: 0` anchor grew it LEFTWARD, out of the card: on Overview's first agent
        // card at 1280px its left edge measured x≈1, under the fixed 60px instrument rail (z-index 40
        // beats this panel's 20), which swallowed the first ~8 characters of every label. Every call site
        // puts this cluster at the LEFT of its row with the card's full width to the right, so growing
        // rightward is the direction that always has room — and it lines the panel's leading edge up with
        // the card's own left alignment grid (role badge, agent name) instead of floating left of it.
        // `nowrap` on the items (below) sizes the panel to its longest label rather than wrapping it, so
        // `minWidth` is now only a floor for the two short labels.
        <div data-testid="spawn-role-menu"
          style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 20, minWidth: 170,
            background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: 4, overflow: "hidden",
            display: "flex", flexDirection: "column" }}>
          {/* Each item states NO `color`: ghost supplies --loom-text-dim at rest and lifts it to
              --loom-text on hover, and an inline colour here shadows that hover rule outright (this used
              to state ghost's own hover value, so every item sat permanently lit and none could hover).
              See the `.loom-btn-*` block in styles/global.css if an item needs a different tone. */}
          {options.map((o) => (
            <button key={o.label} disabled={pending} onClick={() => { setOpen(false); onSpawn(o.role); }}
              className="loom-btn loom-btn-ghost"
              style={{ textAlign: "left", background: "transparent", border: "none", whiteSpace: "nowrap",
                fontFamily: font.mono, fontSize: 12, padding: "6px 10px", cursor: "pointer" }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
