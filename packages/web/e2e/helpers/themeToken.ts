// Resolve a colour token to the exact string the browser computes for it (Graphite epic e25fa8a9).
//
// ⛔ Never pin a colour in a spec as a literal (`"rgb(46, 230, 110)"`). The tokens differ per theme and
// are written in OKLCH, which Chromium keeps as `oklch(…)` in computed style, so a literal pins ONE
// theme in ONE notation and goes stale the next time a value moves. Ask the page instead.
//
// How: a hidden probe element takes the CSS value as its `color`, and the probe's computed `color` is
// read back. That is the same resolution the real element goes through (var() substitution, color-mix,
// the theme in force), so it compares equal to `toHaveCSS("color" | "background-color" | …)` on the
// element under test, in whatever notation the browser happens to use.
import type { Page } from "../fixtures/daemon";

/**
 * The computed colour for any CSS colour value in the page's current theme. Pass a token name
 * (`"--loom-danger"`) or any CSS expression (`"color-mix(in oklab, var(--loom-live) 28%, transparent)"`).
 */
export function cssColor(page: Page, value: string): Promise<string> {
  const css = value.startsWith("--") ? `var(${value})` : value;
  return page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = v;
    document.body.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);
}
