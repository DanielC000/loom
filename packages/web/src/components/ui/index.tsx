// Loom "Terminal Cockpit" component kit.
//
// The shared presentational primitives, promoted from the inline styling that was
// duplicated across pages. Token-driven (see ../../theme + ../../styles/global.css).
// Interaction states (button hover, field focus) live as .loom-* classes in global.css.

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { NavLink } from "react-router-dom";
import { color, font, radius, tone, type Tone } from "../../theme";

// ── Panel ────────────────────────────────────────────────────────────────────
// Bordered surface. `selected` swaps to a phosphor border + faint inner glow.
export function Panel({
  children, selected, grid, onClick, title, style,
}: {
  children: ReactNode;
  selected?: boolean;
  grid?: boolean;
  onClick?: () => void;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      title={title}
      className={grid ? "loom-grid" : undefined}
      style={{
        background: color.panel,
        border: `1px solid ${selected ? color.phosphor : color.border}`,
        borderRadius: radius.base,
        padding: 12,
        ...(selected ? { boxShadow: `inset 0 0 0 1px ${color.phosphorDim}` } : null),
        ...(onClick ? { cursor: "pointer" } : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────
type ButtonVariant = "default" | "primary" | "danger" | "ghost";
const buttonTone: Record<ButtonVariant, { border: string; color: string }> = {
  default: { border: color.borderStrong, color: color.text },
  primary: { border: color.phosphor, color: color.phosphor },
  danger: { border: color.red, color: color.red },
  ghost: { border: "transparent", color: color.textDim },
};

export function Button({
  variant = "default", style, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const t = buttonTone[variant];
  return (
    <button
      {...rest}
      className={`loom-btn loom-btn-${variant}${className ? ` ${className}` : ""}`}
      style={{
        background: "transparent",
        color: t.color,
        border: `1px solid ${t.border}`,
        borderRadius: radius.base,
        padding: "4px 10px",
        fontFamily: font.mono,
        fontSize: 12,
        cursor: "pointer",
        ...style,
      }}
    />
  );
}

// ── Input / Select ─────────────────────────────────────────────────────────────
const fieldStyle: CSSProperties = {
  background: color.panel2,
  color: color.text,
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.base,
  padding: "4px 8px",
  fontFamily: font.mono,
  fontSize: 13,
};

export function Input({ style, className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`loom-field${className ? ` ${className}` : ""}`} style={{ ...fieldStyle, ...style }} />;
}

export function Select({ style, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`loom-field${className ? ` ${className}` : ""}`} style={{ ...fieldStyle, ...style }}>
      {children}
    </select>
  );
}

// ── Status: Dot / StatusPill / Badge ───────────────────────────────────────────
// `glow` adds a CRT halo — use it for live/busy states.
export function Dot({ tone: t, glow, title }: { tone: Tone; glow?: boolean; title?: string }) {
  const c = tone[t];
  return (
    <span
      title={title}
      style={{
        width: 8, height: 8, borderRadius: 8, background: c, display: "inline-block",
        ...(glow ? { boxShadow: `0 0 6px ${c}` } : null),
      }}
    />
  );
}

// Dot + uppercase mono label, e.g. "● IDLE".
export function StatusPill({ tone: t, label, glow }: { tone: Tone; label: string; glow?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11, color: tone[t], textTransform: "uppercase", letterSpacing: "0.06em" }}>
      <Dot tone={t} glow={glow} />
      {label}
    </span>
  );
}

// Bordered status pill, e.g. RUNNING / PAUSED.
export function Badge({ tone: t, children }: { tone: Tone; children: ReactNode }) {
  const c = tone[t];
  return (
    <span style={{ fontFamily: font.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "2px 8px", border: `1px solid ${c}`, borderRadius: radius.sm, color: c }}>
      {children}
    </span>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────
// Inline metadata, e.g. `branch loom/8f3a`, `ctx 56,200`.
export function Chip({ label, value, tone: t }: { label?: string; value: ReactNode; tone?: Tone }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "baseline", fontFamily: font.mono, fontSize: 11, border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "1px 6px" }}>
      {label && <span style={{ color: color.textMuted }}>{label}</span>}
      <span style={{ color: t ? tone[t] : color.text }}>{value}</span>
    </span>
  );
}

// ── SectionLabel ─────────────────────────────────────────────────────────────
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim, margin: "4px 0 8px", ...style }}>
      {children}
    </div>
  );
}

// ── Meter ────────────────────────────────────────────────────────────────────
// Thin fill bar, e.g. context-token usage.
export function Meter({ value, max, tone: t = "phosphor", width = 80 }: { value: number; max: number; tone?: Tone; width?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span style={{ display: "inline-block", width, height: 3, background: color.border, borderRadius: radius.sm, overflow: "hidden", verticalAlign: "middle" }}>
      <span style={{ display: "block", height: "100%", width: `${pct * 100}%`, background: tone[t] }} />
    </span>
  );
}

// ── NavTab ───────────────────────────────────────────────────────────────────
// Uppercase mono nav item; active tab gets a phosphor underline (.loom-navtab in global.css).
export function NavTab({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `loom-navtab${isActive ? " is-active" : ""}`}>
      {children}
    </NavLink>
  );
}
