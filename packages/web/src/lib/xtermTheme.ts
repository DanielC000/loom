import type { ITheme } from "@xterm/xterm";
import type { ResolvedTheme } from "./themePref";

// The terminal's colours, per app theme (Graphite epic e25fa8a9, card 593674a7).
//
// ⛔ The terminal stays DARK in both themes. The real `claude` TUI emits ANSI colours tuned for a dark
// background, and its own theme setting is outside Loom's control, so a light xterm would make its
// output unreadable. On the light page it reads as a deliberate dark well instead.
//
// Values are hex because xterm parses theme colours itself and hex is what it reliably accepts. Each
// one is an OKLCH value converted once to sRGB, noted beside it, so a retune starts from the OKLCH.
// The two themes differ only in the well (background, foreground, cursor, selection): oklch L 0.145 on
// the dark page, a slightly lifted 0.2 on the light page so the well reads as intentional against white.
// The 16 ANSI colours are shared and clear 4.5:1 (white, brightWhite) or 3:1 (the colour slots and
// brightBlack) on BOTH wells; test/theme-contrast.mjs checks every one. `black` is exempt: it is the
// slot programs paint backgrounds with, so it is meant to sit close to the well.
const ANSI = {
  black: "#24272a", // oklch(0.27 0.007 260)
  red: "#f17070", // oklch(0.70 0.16 22)
  green: "#4bc680", // oklch(0.74 0.15 155)
  yellow: "#ebbd57", // oklch(0.82 0.13 85)
  blue: "#5f99ed", // oklch(0.68 0.14 258)
  magenta: "#ce83de", // oklch(0.72 0.15 320)
  cyan: "#62c8df", // oklch(0.78 0.10 215)
  white: "#cfd1d4", // oklch(0.86 0.005 260)
  brightBlack: "#83868c", // oklch(0.62 0.01 260)
  brightRed: "#ff918e", // oklch(0.78 0.14 22)
  brightGreen: "#74e29f", // oklch(0.83 0.14 155)
  brightYellow: "#fad779", // oklch(0.89 0.12 90)
  brightBlue: "#87bafd", // oklch(0.78 0.11 255)
  brightMagenta: "#e3a7f1", // oklch(0.81 0.12 320)
  brightCyan: "#86e2f2", // oklch(0.86 0.09 210)
  brightWhite: "#f4f5f7", // oklch(0.97 0.003 260)
} as const satisfies ITheme;

const DARK: ITheme = {
  ...ANSI,
  background: "#090a0c", // oklch(0.145 0.005 260) = --loom-term-bg (dark)
  foreground: "#e3e5e8", // oklch(0.92 0.005 260) = --loom-term-fg (dark)
  cursor: "#e3e5e8",
  cursorAccent: "#090a0c",
  selectionBackground: "#1c3861", // oklch(0.34 0.08 258)
  selectionInactiveBackground: "#1d2735", // oklch(0.27 0.03 258)
};

const LIGHT: ITheme = {
  ...ANSI,
  background: "#14161a", // oklch(0.2 0.008 260) = --loom-term-bg (light)
  foreground: "#e6e8ea", // oklch(0.93 0.004 260) = --loom-term-fg (light)
  cursor: "#e6e8ea",
  cursorAccent: "#14161a",
  selectionBackground: "#26426c", // oklch(0.38 0.08 258)
  selectionInactiveBackground: "#273140", // oklch(0.31 0.03 258)
};

export function xtermTheme(t: ResolvedTheme): ITheme {
  return t === "light" ? LIGHT : DARK;
}
