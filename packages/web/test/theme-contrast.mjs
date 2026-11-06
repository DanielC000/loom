// Hermetic contrast check for the Graphite colour tokens (card 593674a7). Run standalone with:
//   node --experimental-strip-types packages/web/test/theme-contrast.mjs
//
// Reads the REAL token values out of src/styles/global.css (both theme blocks), converts each OKLCH
// value to sRGB the same way the browser does, and asserts the WCAG 2.x contrast floors for the main
// pairs in Direction C's contrast table (vault Mockups/2026-11-06 Graphite palette/README.md, card
// d2a44f7b): 4.5:1 for text, 3:1 for UI. Then it checks the xterm themes (lib/xtermTheme.ts) the same
// way, and that the hex copies of token values kept elsewhere (Board's lane-label guard, the terminal
// well) still equal the token they mirror.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { xtermTheme } from "../src/lib/xtermTheme.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── OKLCH → sRGB (CSS Color 4) and WCAG relative luminance ────────────────────────────────────────
function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (x) => { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
  return lin.map((x) => Math.round(enc(x) * 255));
}
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ── Parse the two theme blocks out of global.css ───────────────────────────────────────────────────
const css = read("../src/styles/global.css");
function block(selectorRe) {
  const m = css.match(selectorRe);
  assert.ok(m, `global.css has a block matching ${selectorRe}`);
  const start = m.index + m[0].length;
  return css.slice(start, css.indexOf("}", start));
}
function rawTokens(body) {
  const out = {};
  for (const m of body.matchAll(/--loom-([a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)\s*;/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}
const RAW = {
  dark: rawTokens(block(/:root,\s*:root\[data-theme="dark"\]\s*\{/)),
  light: rawTokens(block(/:root\[data-theme="light"\]\s*\{/)),
};
// `color-mix(in oklab, <a> <pct>%, <b>)`: mix the two tokens' OKLab coordinates, then convert.
function mixOklab(a, pct, b) {
  const lab = ([L, C, H]) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  const p = pct / 100;
  const [L, A, B] = lab(a).map((x, i) => x * p + lab(b)[i] * (1 - p));
  return oklchToRgb(L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI);
}
const THEMES = Object.fromEntries(
  Object.entries(RAW).map(([theme, raw]) => {
    const t = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, oklchToRgb(...v)]));
    // The "needs you" band behind a request row: an 11% attn wash over the panel (wash(color.attn, 11)
    // laid on --loom-surface, as the app renders it).
    t["attn-band"] = mixOklab(raw.attn, 11, raw.surface);
    return [theme, t];
  }),
);

// Direction C's contrast table (vault Mockups/2026-11-06 Graphite palette/README.md, §WCAG contrast),
// by pair: [label, foreground token, background token, floor]. Text needs 4.5:1, UI (dots, edges,
// borders, the focus ring) 3:1. A dot is measured on the panel, where it sits.
const PAIRS = [
  ["Primary text", "text", "bg", 4.5],
  ["Secondary text", "text-2", "bg", 4.5],
  ["Muted text on page", "text-3", "bg", 4.5],
  ["Muted text on panel", "text-3", "surface", 4.5],
  ["Link / accent text", "accent-fg", "bg", 4.5],
  ["Primary button label", "on-accent", "accent", 4.5],
  ["Selected row text", "text", "selected", 4.5],
  ["Live capsule text", "live-text", "live-soft", 4.5],
  ["Working capsule text", "work-text", "work-soft", 4.5],
  ["Needs-you capsule text", "attn-text", "attn-soft", 4.5],
  ["Needs-you text on panel", "attn-text", "surface", 4.5],
  ["Error capsule text", "danger-text", "danger-soft", 4.5],
  ["Error text on panel", "danger-text", "surface", 4.5],
  ["Danger button label", "on-danger", "danger-fill", 4.5],
  ["Solid needs-you label", "on-attn", "attn", 4.5],
  ["Text on a needs-you band", "text", "attn-band", 4.5],
  ["Live dot (UI)", "live", "surface", 3],
  ["Working dot (UI)", "work", "surface", 3],
  ["Needs-you edge (UI)", "attn", "surface", 3],
  ["Error dot (UI)", "danger", "surface", 3],
  ["Input border (UI)", "line-strong", "field-bg", 3],
  ["Focus ring (UI)", "ring", "bg", 3],
  ["Healthy meter fill (UI)", "meter-ok", "track", 3],
];

for (const [theme, t] of Object.entries(THEMES)) {
  check(`${theme}: every token in the contrast table is defined`, () => {
    for (const [, f, b] of PAIRS) {
      assert.ok(t[f], `--loom-${f} is defined in the ${theme} block`);
      assert.ok(t[b], `--loom-${b} is defined in the ${theme} block`);
    }
  });
  for (const [label, f, b, need] of PAIRS) {
    check(`${theme}: ${label} (--loom-${f} on --loom-${b}) clears ${need}:1`, () => {
      const r = ratio(t[f], t[b]);
      assert.ok(r >= need, `${label} in ${theme} is ${r.toFixed(2)}:1, below ${need}:1 (${toHex(t[f])} on ${toHex(t[b])})`);
    });
  }
  // The terminal well must stay dark in both themes.
  check(`${theme}: the terminal well is dark`, () => {
    assert.ok(lum(t["term-bg"]) < 0.05, `--loom-term-bg in ${theme} is ${toHex(t["term-bg"])}, not a dark well`);
  });
}

check("the light theme really is light and the dark theme really is dark", () => {
  assert.ok(lum(THEMES.light.bg) > 0.8, `light --loom-bg is ${toHex(THEMES.light.bg)}`);
  assert.ok(lum(THEMES.dark.bg) < 0.05, `dark --loom-bg is ${toHex(THEMES.dark.bg)}`);
});

// ── Board's lane-label AA guard compares against a hex copy of each theme's panel ───────────────────
check("Board.tsx PANEL_HEX equals --loom-surface in each theme", () => {
  const board = read("../src/pages/Board.tsx");
  const m = board.match(/PANEL_HEX[^=]*=\s*\{\s*dark:\s*"(#[0-9a-f]{6})",\s*light:\s*"(#[0-9a-f]{6})"\s*\}/i);
  assert.ok(m, "Board.tsx declares PANEL_HEX as { dark, light }");
  assert.equal(m[1].toLowerCase(), toHex(THEMES.dark.surface));
  assert.equal(m[2].toLowerCase(), toHex(THEMES.light.surface));
});

// ── xterm: the terminal stays dark in both themes, and its colours are legible on it ───────────────
const TEXT_SLOTS = ["foreground", "white", "brightWhite"];
const COLOUR_SLOTS = [
  "red", "green", "yellow", "blue", "magenta", "cyan", "brightBlack",
  "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan",
];
for (const theme of ["dark", "light"]) {
  const x = xtermTheme(theme);
  check(`xterm ${theme}: background and foreground equal the --loom-term-* tokens`, () => {
    assert.equal(x.background.toLowerCase(), toHex(THEMES[theme]["term-bg"]));
    assert.equal(x.foreground.toLowerCase(), toHex(THEMES[theme]["term-fg"]));
  });
  check(`xterm ${theme}: all 16 ANSI colours, cursor and selection are set`, () => {
    for (const k of [...TEXT_SLOTS, ...COLOUR_SLOTS, "black", "cursor", "cursorAccent", "selectionBackground", "selectionInactiveBackground"]) {
      assert.match(String(x[k]), /^#[0-9a-f]{6}$/i, `${k} is a hex colour`);
    }
  });
  const bg = hexToRgb(x.background);
  for (const k of TEXT_SLOTS) {
    check(`xterm ${theme}: ${k} clears 4.5:1 on the well`, () => {
      const r = ratio(hexToRgb(x[k]), bg);
      assert.ok(r >= 4.5, `${k} is ${r.toFixed(2)}:1`);
    });
  }
  for (const k of COLOUR_SLOTS) {
    check(`xterm ${theme}: ${k} clears 3:1 on the well`, () => {
      const r = ratio(hexToRgb(x[k]), bg);
      assert.ok(r >= 3, `${k} is ${r.toFixed(2)}:1`);
    });
  }
}

console.log(`\n${pass} passed`);
