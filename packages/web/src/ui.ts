import type { CSSProperties } from "react";
import { color, font, radius } from "./theme";

// Shared style objects, now token-driven (see theme.ts / styles/global.css). Export names
// and shapes are unchanged so every page keeps working as a drop-in; richer primitives
// (Button variants, StatusPill, Chip, …) arrive in the component kit (Phase 1).

export const card: CSSProperties = {
  background: color.panel,
  border: `1px solid ${color.border}`,
  borderRadius: radius.base,
  padding: 12,
  marginBottom: 12,
};

export const btn: CSSProperties = {
  background: "transparent",
  color: color.text,
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.base,
  padding: "4px 10px",
  fontFamily: font.mono,
  fontSize: 12,
  cursor: "pointer",
};

export const input: CSSProperties = {
  background: color.panel2,
  color: color.text,
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.base,
  padding: "4px 8px",
  fontFamily: font.mono,
  fontSize: 13,
  marginRight: 6,
};

export const page: CSSProperties = { padding: 20, color: color.text };
