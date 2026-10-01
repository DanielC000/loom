import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { color, font, radius, tone as toneVar } from "../theme";
import {
  CODEX_DROPPED_BUT_STORED_FIELDS, CODEX_DROPPED_FIELDS, CODEX_FAIL_OPEN_FIELDS,
  HARNESS_FIELD_LABELS, SEVERITY_META, codexRejectedFields, harnessDrop, liveHarnesses,
  type CodexRejectInput, type DroppedFieldKey, type Harness, type HarnessMixSession,
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
  // Both counts are DERIVED from the two field sets, never written as literals: the old copy promised all
  // five "stay stored", which was false for the two codex also refuses to store (card 6232fe9d).
  const stored = CODEX_DROPPED_BUT_STORED_FIELDS.length;
  const storedLabels = CODEX_DROPPED_BUT_STORED_FIELDS.map((f) => HARNESS_FIELD_LABELS[f]).join(", ");
  const accent = CODEX_FAIL_OPEN_FIELDS.length > 0 ? color.red : color.amber;
  return (
    <div data-testid="harness-drop-summary" role="status"
      style={{ border: `1px solid ${accent}`, borderRadius: radius.base, padding: "8px 10px",
        background: color.panel2, display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: accent, lineHeight: 1.5 }}>
        {n} settings below are not read by the codex spawn path.
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, lineHeight: 1.5 }}>
        {stored} of them ({storedLabels}) stay stored and become live again if you switch this rig back to
        Claude Code, so they are shown disabled rather than cleared. The rest Codex refuses to store at
        all — if this rig has any of them set, saving removes them, and the panel below says which.
      </span>
    </div>
  );
}

// ── The rejection warning ───────────────────────────────────────────────────────────────────────────
//
// The companion to HarnessDropSummary above, and a DIFFERENT statement: that one says which settings stop
// APPLYING on codex, this one says which values this particular rig will LOSE when it is saved. It renders
// only when there is something to lose, so it reads as a consequence of the rig's own state rather than as
// a permanent scold attached to the harness choice — and it retires itself once the save has cleared them.
//
// @decision 6232fe9d — the removal must be named BEFORE the Save click; never silently send (or silently
// clear) a value the validator rejects.
//
// Amber, not red: this is an announced, consented consequence, and the red slot on this screen belongs to
// the one genuinely dangerous signal (restrictedTools reading ON while enforcing nothing). Two reds here
// would flatten the distinction the severity triage exists to draw.
export function HarnessRejectWarning({ harness, values }: { harness: Harness; values: CodexRejectInput }) {
  if (harness !== "codex") return null;
  const rejected = codexRejectedFields(values);
  if (rejected.length === 0) return null;
  return (
    <div data-testid="harness-reject-warning" role="status"
      style={{ border: `1px solid ${color.amber}`, borderRadius: radius.base, padding: "8px 10px",
        background: color.panel2, display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontFamily: font.mono, fontSize: 12, color: color.amber, lineHeight: 1.5 }}>
        Saving removes {rejected.length === 1 ? "one setting" : `${rejected.length} settings`} Codex cannot
        honour: {rejected.map((f) => HARNESS_FIELD_LABELS[f]).join(", ")}.
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, lineHeight: 1.5 }}>
        Codex has no per-tool disallow lever and mounts only HTTP MCP servers, so Loom refuses to store
        these against a codex rig rather than let them read as active. They are still set until you save —
        switch back to Claude Code now and nothing is lost. To keep them, keep this rig on Claude Code.
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

// ── Mixed-harness views ─────────────────────────────────────────────────────────────────────────────
//
// @decision b8e52cfe — never badge every row unconditionally, and never badge claude in a
// single-harness view: a constant fact costs row width and buys nothing. Badge claude ONLY where a
// second live harness makes an unbadged row genuinely ambiguous.
//
// Default `false`, so a call site with no provider above it (Profiles, a single-session page) renders
// byte-identically to before this existed.
const HarnessMixContext = createContext(false);

/** Whether the surrounding view runs more than one harness. False (codex-only badging) with no provider. */
export function useHarnessMixed(): boolean {
  return useContext(HarnessMixContext);
}

/**
 * Wrap a view that lists sessions, passing the SAME set it renders. Cheap: one pass over a list the page
 * has already filtered, recomputed per render rather than memoised — these arrays are freshly derived on
 * every render anyway, so a memo keyed on their identity would never hit.
 */
export function HarnessMixProvider({ sessions, children }: { sessions: readonly HarnessMixSession[]; children: ReactNode }) {
  return <HarnessMixContext.Provider value={liveHarnesses(sessions).size > 1}>{children}</HarnessMixContext.Provider>;
}

/**
 * The per-row harness marker. Renders for codex always, and for claude ONLY inside a mixed
 * {@link HarnessMixProvider} — see the note above for why the two cases differ.
 */
export function HarnessTag({ harness, title }: { harness: Harness; title?: string }): ReactNode {
  const mixed = useHarnessMixed();
  if (harness !== "codex" && !mixed) return null;
  const accent = harness === "codex" ? color.amber : color.textMuted;
  return (
    <span data-testid="harness-tag" data-harness={harness}
      title={title ?? (harness === "codex" ? "Spawns the codex CLI, not claude" : "Spawns claude, Loom's native harness")}
      style={{ fontFamily: font.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
        padding: "1px 6px", border: `1px solid ${accent}`, borderRadius: radius.sm, color: accent,
        flexShrink: 0, lineHeight: 1.5 }}>
      {harness}
    </span>
  );
}
