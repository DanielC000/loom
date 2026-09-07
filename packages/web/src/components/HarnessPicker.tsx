import type { CSSProperties, ReactNode } from "react";
import { color, font, radius, tone as toneVar } from "../theme";
import {
  CODEX_DROPPED_FIELDS, CODEX_FAIL_OPEN_FIELDS, SEVERITY_META,
  harnessDrop, type DroppedFieldKey, type Harness,
} from "../lib/harnessFields";

// The harness picker on the Profiles editor (card fa2277b6, on an explicit owner directive): which vendor
// CLI a session under this rig spawns as. Follows RolePicker's selectable-signal-card idiom (top accent
// bar, header band, body copy) but deliberately LIGHTER — the role picker is the primary identity choice
// on this page and this must not compete with it for weight.
//
// Human surface only. `harness` is on the daemon's AGENT_FORBIDDEN_PROFILE_KEYS, so no agent MCP tool can
// set it; this editor + the loopback REST it drives are the whole grant path, which is exactly why the
// field needed a control here at all.
const HARNESS_OPTIONS: ReadonlyArray<{
  value: Harness; label: string; tone: "phosphor" | "amber"; summary: string; implications: string[];
}> = [
  {
    value: "claude",
    label: "Claude Code",
    tone: "phosphor",
    summary: "Loom's native harness. Every profile setting on this page applies.",
    implications: [
      "Spawns the claude binary with Loom's full spawn recipe",
      "Runs on your Anthropic subscription",
    ],
  },
  {
    value: "codex",
    label: "Codex CLI",
    tone: "amber",
    summary: "A different vendor CLI, with a coarser permission model and a narrower Loom integration.",
    implications: [
      "Spawns the codex binary on this host, not claude",
      "Runs -a never -s workspace-write — approvals disabled, codex's own workspace sandbox",
      "Bills your ChatGPT subscription, not your Anthropic one",
    ],
  },
];

export function HarnessPicker({ value, onChange }: { value: Harness; onChange: (h: Harness) => void }) {
  return (
    <div role="radiogroup" aria-label="Harness — which vendor CLI this rig spawns" data-testid="harness-picker"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
      {HARNESS_OPTIONS.map((o) => {
        const selected = o.value === value;
        const cardStyle = {
          "--tone": toneVar[o.tone],
          display: "flex", flexDirection: "column", textAlign: "left", padding: 0, overflow: "hidden",
          borderRadius: radius.base, cursor: "pointer",
          background: selected ? color.panel : color.panel2,
          border: `1px solid ${selected ? color.phosphor : color.borderStrong}`,
          ...(selected ? { boxShadow: `inset 0 0 0 1px ${color.phosphorDim}` } : null),
        } as CSSProperties;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={selected} onClick={() => onChange(o.value)}
            title={`Spawn sessions under this rig with ${o.label}`}
            data-testid={`harness-card-${o.value}`} data-selected={selected} style={cardStyle}>
            <span aria-hidden style={{ height: 3, background: "var(--tone)" }} />
            <span style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px",
              background: selected ? "color-mix(in oklab, var(--tone) 8%, transparent)" : "transparent" }}>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontFamily: font.head, fontSize: 13, fontWeight: 600, color: color.text }}>{o.label}</span>
                <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, marginTop: 2 }}>{o.value}</span>
              </span>
              <span aria-hidden style={{ flex: "none", fontSize: 13, color: selected ? color.phosphor : "transparent" }}>✓</span>
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1, padding: "9px 11px 11px" }}>
              <span style={{ fontFamily: font.mono, fontSize: 11.5, lineHeight: 1.5, color: color.textDim }}>{o.summary}</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {o.implications.map((t, i) => (
                  <span key={i} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontFamily: font.mono,
                    fontSize: 11, lineHeight: 1.45, color: color.textMuted }}>
                    <span aria-hidden style={{ flex: "none", marginTop: 1, fontSize: 9, color: "var(--tone)" }}>▹</span>
                    {t}
                  </span>
                ))}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── The false-green guard ───────────────────────────────────────────────────────────────────────────
//
// Rendered once under the picker whenever codex is selected: names how many settings BELOW stop applying
// and leads with the fail-OPEN one, because a safety toggle that reads ON while restricting nothing is a
// different and worse defect than a capability that is merely absent. The per-field HarnessFieldDrop
// annotations carry the detail; this is the summary that makes the reader go looking for them.
export function HarnessDropSummary({ harness }: { harness: Harness }) {
  if (harness !== "codex") return null;
  const n = Object.keys(CODEX_DROPPED_FIELDS).length;
  const accent = CODEX_FAIL_OPEN_FIELDS.length > 0 ? color.red : color.amber;
  return (
    <div data-testid="harness-drop-summary" role="status"
      style={{ border: `1px solid ${accent}`, borderRadius: radius.base, padding: "8px 10px",
        background: color.panel2, display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: accent, lineHeight: 1.5 }}>
        {n} settings below are not read by the codex spawn path.
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, lineHeight: 1.5 }}>
        They stay stored and become live again if you switch this rig back to Claude Code, so each one is
        shown disabled rather than cleared. Restricted tools is the one that matters most: on codex it
        restricts nothing, so treat this rig as unrestricted no matter what that checkbox reads.
      </span>
    </div>
  );
}

/**
 * The per-field annotation. Renders NOTHING on a harness that reads the field, so a call site can drop it
 * in unconditionally next to the control it describes and never branch.
 */
export function HarnessFieldDrop({ harness, field }: { harness: Harness; field: DroppedFieldKey }) {
  const drop = harnessDrop(harness, field);
  if (!drop) return null;
  const meta = SEVERITY_META[drop.severity];
  const accent = toneVar[meta.tone];
  return (
    <span data-testid={`harness-drop-${field}`} data-severity={drop.severity}
      style={{ display: "flex", flexDirection: "column", gap: 3, borderLeft: `2px solid ${accent}`,
        paddingLeft: 8, marginTop: 2 }}>
      <span style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: accent }}>
        {meta.tag} on codex
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 11, lineHeight: 1.5, color: color.textMuted }}>{drop.note}</span>
    </span>
  );
}

/** Dims the control a {@link HarnessFieldDrop} annotates, so the disabled state reads at a glance. */
export function dropStyle(harness: Harness, field: DroppedFieldKey): CSSProperties | undefined {
  return harnessDrop(harness, field) ? { opacity: 0.55 } : undefined;
}

/** A `codex` marker for the profile list + editor header. Claude is the default, so it is never badged. */
export function HarnessTag({ harness, title }: { harness: Harness; title?: string }): ReactNode {
  if (harness !== "codex") return null;
  return (
    <span data-testid="harness-tag" title={title ?? "Spawns the codex CLI, not claude"}
      style={{ fontFamily: font.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
        padding: "1px 6px", border: `1px solid ${color.amber}`, borderRadius: radius.sm, color: color.amber,
        flexShrink: 0, lineHeight: 1.5 }}>
      codex
    </span>
  );
}
