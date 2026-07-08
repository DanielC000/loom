import type { CSSProperties } from "react";
import type { SessionRole } from "@loom/shared";
import { color, font, radius, tone as toneVar } from "../theme";
import { ROLE_DISPLAY, PICKER_ROLES, roleDisplay, type RoleDisplay } from "../lib/roleDisplay";

// The role "capability class" picker on the Profiles editor (card 04fec5be). Direction A (signal cards)
// with C's tone-tinted header band grafted onto the SELECTED card — the owner-approved mockup
// (Projects/Loom/Mockups/2026-07-08 Role Picker). Each conferrable role is a compact selectable card:
// a tinted sigil, display label + enum, one-line description, and a powers footer, with a top accent
// bar in the role's tone. Trust tier is encoded by WEIGHT (elevated = thicker glowing accent + faint
// tinted wash; read-only muted). Everything renders from the ONE role display map (lib/roleDisplay) —
// no hand-duplicated copy — and only offers the roles a profile may legitimately confer: USER roles are
// selectable; DEV-layer roles (platform/auditor) are shown LOCKED, never assignable. The lock is
// intentionally TIGHTER than the human-REST validateProfile (which accepts "platform") — there's no UI
// path to confer a dev-layer rig (those are core-seeded, not UI-created). DISPLAY ONLY — the enum
// identifiers passed up via onChange are unchanged.
export function RolePicker({ value, onChange }: {
  // The profile's role field: "" ⇒ the plain (no-role) session. Mirrors Profiles' `role` state.
  value: SessionRole | "";
  onChange: (role: SessionRole | "") => void;
}) {
  const selectedKey = roleDisplay(value === "" ? null : value).key;
  return (
    <div role="radiogroup" aria-label="Role — capability class" data-testid="role-picker"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
      {PICKER_ROLES.map((key) => {
        const d = ROLE_DISPLAY[key];
        const locked = d.confer === "dev";
        const selected = key === selectedKey;
        return (
          <RoleCard key={key} d={d} selected={selected} locked={locked}
            onSelect={() => onChange(d.role ?? "")} />
        );
      })}
    </div>
  );
}

// Elevated tiers (manager/platform) read heavier + warmer — a thicker, glowing accent and a faint
// tinted body wash — so the card's visual weight tracks the real trust tier.
const ELEVATED: ReadonlySet<RoleDisplay["tier"]> = new Set(["elevated", "admin"]);

function RoleCard({ d, selected, locked, onSelect }: {
  d: RoleDisplay; selected: boolean; locked: boolean; onSelect: () => void;
}) {
  const elevated = ELEVATED.has(d.tier);
  // --tone carries the role's signal color down into the color-mix() tints below.
  const cardStyle: CSSProperties = {
    "--tone": toneVar[d.tone],
    position: "relative",
    display: "flex",
    flexDirection: "column",
    textAlign: "left",
    padding: 0,
    overflow: "hidden",
    borderRadius: radius.base,
    background: selected ? color.panel : color.panel2,
    border: `1px solid ${selected ? color.phosphor : color.borderStrong}`,
    ...(selected ? { boxShadow: `inset 0 0 0 1px ${color.phosphorDim}` } : null),
    ...(d.tier === "readonly" ? { opacity: 0.92 } : null),
    cursor: locked ? "not-allowed" : "pointer",
  } as CSSProperties;

  // C's header band appears on the SELECTED card: a tone-tinted background + hairline under the sigil/
  // label, so the pick reads as a deliberate "this is your class" moment. Unselected = a plain header.
  const bandStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "11px 12px",
    ...(selected
      ? {
          background: "color-mix(in oklab, var(--tone) 12%, var(--loom-panel-2))",
          borderBottom: "1px solid color-mix(in oklab, var(--tone) 28%, var(--loom-border))",
        }
      : null),
  };

  return (
    <button type="button" role="radio" aria-checked={selected} disabled={locked}
      onClick={locked ? undefined : onSelect}
      title={locked ? `${d.label} — dev-layer, not assignable from this editor` : `Select ${d.label}`}
      className={`loom-rolecard${selected ? " is-selected" : ""}${locked ? " is-locked" : ""}`}
      data-testid={`role-card-${d.key}`} data-selected={selected} data-locked={locked}
      style={cardStyle}>
      {/* top accent bar — thicker + glowing for elevated tiers */}
      <span aria-hidden style={{ height: elevated ? 4 : 3, background: "var(--tone)",
        ...(elevated ? { boxShadow: "0 0 10px color-mix(in oklab, var(--tone) 50%, transparent)" } : null) }} />

      {/* header band (sigil + label + enum) — tinted when selected */}
      <span style={bandStyle}>
        <span aria-hidden style={{ width: 30, height: 30, flex: "none", display: "grid", placeItems: "center",
          fontFamily: font.mono, fontSize: 15, borderRadius: radius.base, color: "var(--tone)",
          border: "1px solid color-mix(in oklab, var(--tone) 45%, var(--loom-border-strong))",
          background: "color-mix(in oklab, var(--tone) 9%, transparent)" }}>{d.sigil}</span>
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span style={{ fontFamily: font.head, fontSize: 14, fontWeight: 600, letterSpacing: "0.01em", color: color.text }}>{d.label}</span>
          <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, marginTop: 2 }}>{d.role ?? "— (no role)"}</span>
        </span>
        <span aria-hidden style={{ flex: "none", fontSize: 13, color: selected ? color.phosphor : "transparent" }}>✓</span>
      </span>

      {/* body: description + powers + tier tag; faint tinted wash for elevated tiers */}
      <span style={{ display: "flex", flexDirection: "column", gap: 9, flex: 1, padding: "11px 12px 12px",
        ...(elevated ? { background: "color-mix(in oklab, var(--tone) 5%, transparent)" } : null),
        ...(locked ? { opacity: 0.62 } : null) }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 1.5, color: color.textDim }}>{d.description}</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {d.powers.map((p, i) => (
            <span key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontFamily: font.mono, fontSize: 11.5, lineHeight: 1.45, color: color.textDim }}>
              <span aria-hidden style={{ flex: "none", marginTop: 1, fontSize: 10, color: p.has ? color.phosphor : color.textMuted }}>▹</span>
              {p.text}
            </span>
          ))}
        </span>
        <span style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: font.mono, fontSize: 9.5, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--tone)", whiteSpace: "nowrap" }}>
            Tier · {d.tierLabel}
          </span>
          {locked && (
            <span style={{ marginLeft: "auto", flex: "none", display: "inline-flex", alignItems: "center", gap: 4,
              fontFamily: font.mono, fontSize: 9, letterSpacing: "0.07em", textTransform: "uppercase", color: color.textMuted,
              border: `1px solid ${color.borderStrong}`, borderRadius: 999, padding: "1px 7px" }}>
              ⚿ dev-layer
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
