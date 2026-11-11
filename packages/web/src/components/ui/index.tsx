// Loom component kit (Graphite).
//
// The shared presentational primitives, promoted from the inline styling that was
// duplicated across pages. Token-driven (see ../../theme + ../../styles/global.css), so every
// primitive follows the light/dark theme. Interaction states (button hover/press, field focus,
// segmented thumb) live as .loom-* classes in global.css.

import { useId, useLayoutEffect, useRef, useState } from "react";
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

// `classPadding`: the caller's className owns the padding, so the kit sets none inline. For a button
// that collapses to a square icon at a breakpoint: inline beats class, so the kit's own padding would
// shadow the media rule's `padding: 0` and squeeze the icon (8px of a 16px glyph, card d3a17f31). The
// caller's class must then also set the wide padding itself. Every other Button is unchanged.
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; classPadding?: boolean; ref?: Ref<HTMLButtonElement>;
};

export function Button({
  variant = "default", classPadding = false, style, className, ...rest
}: ButtonProps) {
  // React 19 passes `ref` as a plain prop, so it rides `rest` onto the <button> (a caller that must return
  // focus to a trigger needs it).
  return (
    <button
      {...rest}
      className={`loom-btn loom-btn-${variant}${className ? ` ${className}` : ""}`}
      style={{
        borderRadius: radius.base,
        ...(classPadding ? null : { padding: "4px 12px" }),
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

// The right padding is set LAST, after the caller's style, because it is the room `select.loom-field`'s
// chevron sits in: a caller's `padding` shorthand may size the rest of the box, never cover the chevron.
export function Select({ style, className, mono, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & FieldFontProps) {
  return (
    <select {...rest} className={`loom-field${className ? ` ${className}` : ""}`} style={{ ...fieldStyle(mono), ...style, paddingRight: 26 }}>
      {children}
    </select>
  );
}

// ── Status: Dot / StatusPill / Badge ───────────────────────────────────────────
// Status is always a dot plus a word, never colour alone. There is no glow, so `glow` is still
// ACCEPTED (call sites pass it for live/working states) but draws nothing. Motion is reserved for
// one meaning: a `work` dot breathes slowly (.loom-dot-work in global.css, off under reduced motion).
// All three forward unrecognized DOM props (data-*, aria-*, id, ...) to their root span via `rest`.
type DotProps = { tone: Tone; glow?: boolean; title?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "title">;

export function Dot({ tone: t, glow: _glow, title, style, className, ...rest }: DotProps) {
  const cls = [t === "work" ? "loom-dot-work" : null, className].filter(Boolean).join(" ");
  return (
    <span
      {...rest}
      className={cls || undefined}
      title={title}
      style={{ width: 8, height: 8, borderRadius: radius.base, background: toneFill[t], display: "inline-block", flexShrink: 0, ...style }}
    />
  );
}

// A SOLID capsule: the signal's own fill under its on-colour. Only the two states that must stop the
// eye get one: "needs you" (attn: a worker waiting on you, P1) and danger.
const SOLID: Partial<Record<Tone, { bg: string; fg: string }>> = {
  attn: { bg: color.attn, fg: color.onAttn },
  danger: { bg: color.dangerFill, fg: color.onDanger },
};
const capsuleColors = (t: Tone, solid?: boolean): { background: string; color: string } => {
  const s = solid ? SOLID[t] : undefined;
  return s ? { background: s.bg, color: s.fg } : { background: toneSoft[t], color: toneText[t] };
};

// A tinted status capsule: the tone's soft fill, a 6px dot and a sentence-case word, e.g. "● Idle".
// The label renders as given (no text-transform), so the casing lives in the label source. `solid`
// (attn / danger only) fills the capsule with the signal itself.
type StatusPillProps = { tone: Tone; label: string; glow?: boolean; solid?: boolean } & HTMLAttributes<HTMLSpanElement>;

export function StatusPill({ tone: t, label, glow: _glow, solid, style, ...rest }: StatusPillProps) {
  const c = capsuleColors(t, solid);
  return (
    <span {...rest} style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px 4px 8px", borderRadius: radius.pill,
      ...c, fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500, lineHeight: 1,
      whiteSpace: "nowrap", ...style,
    }}>
      <Dot tone={t} style={{ width: 6, height: 6, ...(solid && SOLID[t] ? { background: c.color } : null) }} />
      {label}
    </span>
  );
}

// A tinted tag with no border, e.g. "Running" / "Paused": the tone's soft fill under its text.
type BadgeProps = { tone: Tone; children: ReactNode; solid?: boolean } & HTMLAttributes<HTMLSpanElement>;

export function Badge({ tone: t, children, solid, style, ...rest }: BadgeProps) {
  return (
    <span {...rest} style={{
      fontFamily: font.ui, fontSize: fs.sm, fontWeight: 500,
      padding: "2px 8px", borderRadius: radius.sm, ...capsuleColors(t, solid), ...style,
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
// Thin fill bar, e.g. context-token usage. The healthy fill is the brand cobalt (`accent`); a threshold state
// passes `attn` or `danger`.
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

// ── Explainer ──────────────────────────────────────────────────────────────────
// A tab's lead-in paragraph, folded to ONE line with a "More" toggle, so the working UI below it is
// not pushed down by four to six lines of prose on every visit (audit A-39). Expanded, it wraps at a
// 75ch measure. The whole text is always in the DOM (only clipped), so a reader can search the page
// for it and nothing below reflows when it opens. The toggle only renders while the folded line is
// actually cut off: when the text fits, there is nothing more to show. Props other than `style` land
// on the <p> (a test id, an aria hook), and `style` lands on the wrapper, which is what a caller's
// flex placement needs.
export function Explainer({ children, style, className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    // Folded, the <p> is a one-line clamp, so anything past that line is hidden BELOW it.
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <div className={`loom-explainer${open ? " is-open" : ""}${className ? ` ${className}` : ""}`} style={style}>
      <p {...rest} id={rest.id ?? id} ref={textRef} className="loom-explainer-text">{children}</p>
      {(clipped || open) && (
        <button type="button" className="loom-explainer-more" aria-expanded={open} aria-controls={rest.id ?? id}
          onClick={() => setOpen((o) => !o)}>{open ? "Less" : "More"}</button>
      )}
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
    <div style={{ marginTop: 10, padding: 10, background: color.inset, border: `1px solid ${color.attn}`, borderRadius: radius.sm }}>
      <span style={{ fontSize: fs.sm, color: color.text2 }}>
        these agent startup prompts still reference the OLD value — edit them manually if that's a problem:
      </span>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: color.text, fontSize: fs.sm, lineHeight: 1.6 }}>
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
