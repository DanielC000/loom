// Pre-save confirm for a human grant onto a GLOBAL Profile (card 3c4e0df6): before a save that ADDS a
// human-only capability lands, name what is being granted and which agents — in which projects — are
// already bound to this rig and will pick it up.
//
// Restrained by design, in the page's own inline-confirm language (the Delete / Revert-to-bundled rows
// above it), not a new modal system: an amber hairline panel in the normal flow, one line of consequence,
// a bounded Project / Agent list, and the two real choices. No new colour system, no overlay.
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { color, font } from "../theme";
import { grantKeyList, GRANT_REACH_UNKNOWN, type GrantSavePlan } from "../lib/profileGrantReach";

/** How many agent rows render before collapsing into a "+N more" tail. The daemon caps its own audit
 *  payload separately (GRANT_REACH_AGENTS_CAP) — this is purely about not flooding the editor. */
const VISIBLE_AGENTS = 12;

export function GrantReachConfirm({ plan, saving, onConfirm, onCancel }: {
  plan: Extract<GrantSavePlan, { kind: "confirm" } | { kind: "confirm-unknown" }>;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const unknown = plan.kind === "confirm-unknown";
  const shown = unknown ? [] : plan.agents.slice(0, VISIBLE_AGENTS);
  const hidden = unknown ? 0 : plan.agentCount - shown.length;

  return (
    <Panel data-testid="grant-reach-confirm" role="alertdialog" aria-label="Confirm capability grant"
      style={{ borderColor: color.amber, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone="amber">grant</Badge>
        <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12, color: color.text }}>
          This save widens what agents can do
        </strong>
      </div>

      <p style={{ margin: 0, fontFamily: font.mono, fontSize: 12, lineHeight: 1.6, color: color.text }}>
        You are granting <strong style={{ color: color.amber }}>{grantKeyList(plan.addedKeys)}</strong> on this profile.
        {" "}
        {unknown ? GRANT_REACH_UNKNOWN : (
          <>
            Profiles are shared across every project, so{" "}
            <strong style={{ color: color.amber }} data-testid="grant-reach-count">
              {plan.agentCount} agent{plan.agentCount === 1 ? "" : "s"}
            </strong>{" "}
            already bound to it {plan.agentCount === 1 ? "picks" : "pick"} this up on their next session.
          </>
        )}
      </p>

      {!unknown && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel>Already bound</SectionLabel>
          <ul data-testid="grant-reach-agents"
            style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
            {shown.map((a) => (
              <li key={a.id} style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>
                <span style={{ color: color.textDim }}>{a.projectName}</span>
                <span style={{ color: color.textMuted }}> / </span>
                {a.name}
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>+{hidden} more</span>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button variant="primary" data-testid="grant-reach-save" disabled={saving} onClick={onConfirm}>
          {saving ? "Saving…" : "Grant & save"}
        </Button>
        <Button data-testid="grant-reach-cancel" onClick={onCancel}>Cancel</Button>
      </div>
    </Panel>
  );
}
