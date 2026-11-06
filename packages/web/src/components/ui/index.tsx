// Loom component kit (Graphite).
//
// The shared presentational primitives, promoted from the inline styling that was
// duplicated across pages. Token-driven (see ../../theme + ../../styles/global.css), so every
// primitive follows the light/dark theme. Interaction states (button hover/press, field focus,
// segmented thumb) live as .loom-* classes in global.css.

import { useRef } from "react";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";
import { NavLink } from "react-router-dom";
import type { StalePromptWarning } from "@loom/shared";
import { color, font, fs, radius, shadow, tone, toneFill, toneSoft, toneText, type Tone } from "../../theme";

// ── Panel ────────────────────────────────────────────────────────────────────
// Tonal surface: one step lighter than the page, no border, radius 12. Its elevation is
// `--loom-panel-shadow` (nothing in dark, a hairline ring plus a short shadow in light). `selected`
// swaps to the selected fill plus an inset accent ring.
// Forwards any other native div prop (data-*, aria-*, id, ...) via `rest` — an
// unrecognized/misspelled prop still fails loudly at compile time (excess-property
// check on the declared members), it's only real DOM attributes that pass through.
//
// ⛔ `background`, `border`, `borderRadius`, `boxShadow` and `padding` are written below as INLINE
// styles, and `style` is spread LAST — so for a `<Panel className="x">`, a stylesheet rule setting
// any of those on `.x` is SILENTLY INERT. No error, no warning, and on a dark theme the render can still
// look close enough to pass a glance: card 699fe92a wrote a card's padding, its muted variant
// surface and its whole 2px leading edge as CSS, shipped a screenshot that looked right, and
// found all three dead only by probing `getComputedStyle`. Set them via the `style` prop (it
// wins), or render a plain <div> with your own class.
//
// @decision 699fe92a — a Panel's padding/background/border come from `style`, never a class.
type PanelProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode;
  selected?: boolean;
  grid?: boolean;
};

export function Panel({
  children, selected, grid, onClick, title, style, className, ...rest
}: PanelProps) {
  const classes = [grid ? "loom-grid" : null, className].filter(Boolean).join(" ");
  return (
    <div
      {...rest}
      onClick={onClick}
      title={title}
      className={classes || undefined}
      style={{
        background: selected ? color.selected : color.surface,
        border: 0,
        borderRadius: radius.lg,
        padding: 16,
        // The selected ring REPLACES the elevation shadow rather than joining it: the shadow token is
        // `none` in dark, and `inset …, none` is not a valid box-shadow list.
        boxShadow: selected ? `inset 0 0 0 1px ${color.accentEdge}` : shadow.panel,
        ...(onClick ? { cursor: "pointer" } : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────
// The variant CHROME (background / border-color / color) deliberately lives in global.css as
// `.loom-btn-<variant>` rules, NOT here as inline style: inline beats class, so setting it here
// shadowed the matching `.loom-btn-<variant>:hover` rules and hover was inert app-wide.
// Only geometry/typography stays inline. `cursor` is disabled-aware for the same reason —
// a flat inline `pointer` shadowed `.loom-btn:disabled { cursor: not-allowed }`.
// @decision db040811 — keep chrome in the class rules.
type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default", style, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; ref?: Ref<HTMLButtonElement> }) {
  // React 19 passes `ref` as a plain prop, so it rides `rest` onto the <button> (a caller that must return
  // focus to a trigger needs it).
  return (
    <button
      {...rest}
      className={`loom-btn loom-btn-${variant}${className ? ` ${className}` : ""}`}
      style={{
        borderRadius: radius.base,
        padding: "4px 12px",
        fontFamily: font.ui,
        fontSize: fs.body,
        fontWeight: 500,
        cursor: rest.disabled ? "not-allowed" : "pointer",
        ...style,
      }}
    />
  );
}

// ── Input / Select ─────────────────────────────────────────────────────────────
// Chrome (field background, strong hairline, radius, focus ring) lives in `.loom-field`, so its
// :hover and :focus rules can win; only geometry and type stay inline. Free text is the sans; a
// field that holds an id, a path or code keeps the monospace face. `mono` says so explicitly; when it
// is not given, a field its caller already marked as not-prose (`spellCheck={false}`, which every
// path / id / command / cron field in the app sets) defaults to mono, so those need no second flag.
type FieldFontProps = { mono?: boolean };

const fieldStyle = (mono: boolean | undefined): CSSProperties => ({
  padding: "4px 8px",
  fontFamily: mono ? font.mono : font.ui,
  fontSize: mono ? fs.mono : fs.body,
});

export function Input({ style, className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & FieldFontProps) {
  return <input {...rest} className={`loom-field${className ? ` ${className}` : ""}`} style={{ ...fieldStyle(mono ?? rest.spellCheck === false), ...style }} />;
}

export function Select({ style, className, mono, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & FieldFontProps) {
  return (
    <select {...rest} className={`loom-field${className ? ` ${className}` : ""}`} style={{ ...fieldStyle(mono), ...style }}>
      {children}
    </select>
  );
}

// ── Status: Dot / StatusPill / Badge ───────────────────────────────────────────
// Status is always a dot plus a word, never colour alone. Graphite has no glow, so `glow` is still
// ACCEPTED (call sites pass it for live/busy states) but draws nothing. All three forward
// unrecognized DOM props (data-*, aria-*, id, ...) to their root span via `rest`, same pattern as Panel.
type DotProps = { tone: Tone; glow?: boolean; title?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "title">;

export function Dot({ tone: t, glow: _glow, title, style, ...rest }: DotProps) {
  return (
    <span
      {...rest}
      title={title}
      style={{ width: 8, height: 8, borderRadius: radius.base, background: toneFill[t], display: "inline-block", flexShrink: 0, ...style }}
    />
  );
}

// A tinted status capsule: the tone's soft fill, a 6px dot and a sentence-case word, e.g. "● Idle".
// The label renders as given (no text-transform), so the casing lives in the label source.
type StatusPillProps = { tone: Tone; label: string; glow?: boolean } & HTMLAttributes<HTMLSpanElement>;

export function StatusPill({ tone: t, label, glow: _glow, style, ...rest }: StatusPillProps) {
  return (
    <span {...rest} style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px 4px 8px", borderRadius: radius.pill,
      background: toneSoft[t], color: toneText[t], fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500, lineHeight: 1,
      whiteSpace: "nowrap", ...style,
    }}>
      <Dot tone={t} style={{ width: 6, height: 6 }} />
      {label}
    </span>
  );
}

// A tinted tag with no border, e.g. "Running" / "Paused": the tone's soft fill under its text.
type BadgeProps = { tone: Tone; children: ReactNode } & HTMLAttributes<HTMLSpanElement>;

export function Badge({ tone: t, children, style, ...rest }: BadgeProps) {
  return (
    <span {...rest} style={{
      fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500,
      padding: "2px 8px", borderRadius: radius.sm, background: toneSoft[t], color: toneText[t], ...style,
    }}>
      {children}
    </span>
  );
}

// ── PresetAccentDots ─────────────────────────────────────────────────────────────
// A small row of colored dots previewing a board preset's per-lane accents, so the preset
// pickers (project-create + reset-to-preset) read as a VISUAL choice, not text alone. One dot
// per column in board order, tinted by that column's accentColor (a preset's accentColor == its
// role color); a column with no accent falls to a neutral hairline-grey dot. aria-hidden — the
// adjacent label/description text already names the lanes, so the dots are pure decoration.
// Forwards unrecognized DOM props (data-*, id, ...) to root; `aria-hidden` is pinned decorative — it's
// applied AFTER `rest` spreads, so it always wins over anything a caller passes in rest.
type PresetAccentDotsProps = { accents: (string | undefined)[]; title?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "title">;

export function PresetAccentDots({ accents, title, style, ...rest }: PresetAccentDotsProps) {
  return (
    <span {...rest} aria-hidden title={title} style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, ...style }}>
      {accents.map((a, i) => (
        <span key={i} style={{ width: 8, height: 8, borderRadius: radius.base, flexShrink: 0, background: a ?? color.line }} />
      ))}
    </span>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────
// Inline metadata, e.g. `branch loom/8f3a`, `ctx 56,200`: a borderless pill on surface-2. The value
// stays mono (it is an id, a count, a branch). Forwards unrecognized DOM props to root.
type ChipProps = { label?: string; value: ReactNode; tone?: Tone } & HTMLAttributes<HTMLSpanElement>;

export function Chip({ label, value, tone: t, style, ...rest }: ChipProps) {
  return (
    <span {...rest} style={{ display: "inline-flex", gap: 4, alignItems: "baseline", fontFamily: font.mono, fontSize: fs.xs, background: color.surface2, borderRadius: radius.pill, padding: "1px 8px", minWidth: 0, maxWidth: "100%", ...style }}>
      {label && <span style={{ color: color.text3, flexShrink: 0 }}>{label}</span>}
      <span style={{ color: t ? tone[t] : color.text, minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </span>
  );
}

// ── SectionLabel ─────────────────────────────────────────────────────────────
// Forwards unrecognized DOM props to root.
type SectionLabelProps = { children: ReactNode } & HTMLAttributes<HTMLDivElement>;

export function SectionLabel({ children, style, ...rest }: SectionLabelProps) {
  return (
    <div {...rest} style={{ fontFamily: font.ui, fontSize: fs.body, fontWeight: 600, color: color.text, margin: "4px 0 8px", ...style }}>
      {children}
    </div>
  );
}

// ── Meter ────────────────────────────────────────────────────────────────────
// Thin fill bar, e.g. context-token usage. The healthy fill is cobalt (`accent`); a warning state
// passes `busy` or `danger`.
export function Meter({ value, max, tone: t = "accent", width = 80 }: { value: number; max: number; tone?: Tone; width?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span style={{ display: "inline-block", width, height: 3, background: color.track, borderRadius: radius.pill, overflow: "hidden", verticalAlign: "middle" }}>
      <span style={{ display: "block", height: "100%", width: `${pct * 100}%`, background: toneFill[t] }} />
    </span>
  );
}

// ── NavTab ───────────────────────────────────────────────────────────────────
// Sentence-case sans nav item; the active tab is semibold with a cobalt underline (.loom-navtab in global.css).
// NavLink renders a single <a> and forwards anchor attributes itself, so `rest` (data-*, aria-*, id,
// style, ...) passes straight to it; `className` is merged with the active-state class, not clobbered.
type NavTabProps = { to: string; end?: boolean; children: ReactNode; className?: string } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "children" | "className"
>;

export function NavTab({ to, end, children, className, ...rest }: NavTabProps) {
  return (
    <NavLink
      {...rest}
      to={to}
      end={end}
      className={({ isActive }) => [`loom-navtab${isActive ? " is-active" : ""}`, className].filter(Boolean).join(" ")}
    >
      {children}
    </NavLink>
  );
}

// ── Segmented ──────────────────────────────────────────────────────────────────
// A compact single-choice toggle — the one primitive for the small "swap which body mounts" switches,
// e.g. Runs' Runs|Keys and Actors' Profiles|Skills. A surface-2 track holds a raised thumb under the
// chosen option; the rest read dim. Keyed generically so any string-union tab set fits. ALL the chrome
// is the `.loom-segmented` / `.loom-segment` classes in global.css (keyed on `aria-checked`), so the
// hover rule and the inset `--loom-ring` `:focus-visible` ring both win; nothing here is inline.
//
// role="radiogroup"/"radio", not "tablist"/"tab" (card 3f28f1c3): every call site uses this purely to
// swap which body mounts underneath — a single-choice toggle, never a genuine ARIA tab (none associates
// a `role="tabpanel"` via `aria-controls`/`id`). A radiogroup is a roving-tabindex widget: ONE segment is
// ever a Tab stop (the active one); arrow keys move AND select among the rest, wrapping at the ends.
type SegmentedProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  items: { key: T; label: string }[];
  ariaLabel?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "role" | "onChange" | "aria-label">;

export function Segmented<T extends string>({
  value, onChange, items, ariaLabel, style, ...rest
}: SegmentedProps<T>) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectIndex = (i: number, moveFocus: boolean) => {
    const it = items[i];
    if (!it) return;
    onChange(it.key);
    if (moveFocus) btnRefs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectIndex(next, true);
  };

  return (
    <div {...rest} role="radiogroup" aria-label={ariaLabel}
      className={["loom-segmented", rest.className].filter(Boolean).join(" ")} style={style}>
      {items.map((it, i) => {
        const active = value === it.key;
        return (
          <button key={it.key} ref={(el) => { btnRefs.current[i] = el; }} className="loom-segment"
            role="radio" aria-checked={active} tabIndex={active ? 0 : -1}
            onClick={() => selectIndex(i, false)} onKeyDown={(e) => onKeyDown(e, i)}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ── StaleStartupPromptWarning ──────────────────────────────────────────────────
// The project rename/repoPath-change stale-prompt lint (card 0597e092) — shared by both the repoPath
// rebind (Settings.tsx) and the name/vaultPath save (Projects.tsx), the two writes that can trigger it.
// WARN-only: names which agents' startupPrompts still reference a value the just-completed save changed
// away from. Nothing is auto-edited — renders nothing when there's nothing to warn about.
export function StaleStartupPromptWarning({ warnings }: { warnings: StalePromptWarning[] | undefined }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div style={{ marginTop: 10, padding: 10, background: color.inset, border: `1px solid ${color.busy}`, borderRadius: radius.sm }}>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text2 }}>
        these agent startup prompts still reference the OLD value — edit them manually if that's a problem:
      </span>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: color.text, fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.6 }}>
        {warnings.map((w) => (
          <li key={w.agentId}>
            <span style={{ color: color.text }}>{w.agentName}</span>
            <span style={{ color: color.text3 }}> · stale {w.staleFields.join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
