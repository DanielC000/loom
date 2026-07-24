// Card 7497562e — follow-up to the Panel prop-drop fix (8d431c2f). The bespoke-prop `components/ui`
// primitives (Dot, StatusPill, Badge, Chip, SectionLabel, NavTab, Segmented, PresetAccentDots) used to
// silently drop any DOM prop they didn't explicitly name — a `data-*`/`aria-*` prop type-checks clean
// (TS doesn't do excess-property checks against a custom component) but never reached the DOM. This
// test renders the REAL shipped components (via tsxLoaderHook.mjs, not a reimplementation) through
// react-dom/server and asserts the forwarded attributes actually land in the markup, and that a
// caller-supplied className/style is merged alongside the component's own, not clobbered by it.
// (`_tsxLoaderHook.mjs`'s leading underscore excludes it from run-all.mjs's own test glob — it's a
// shared helper, not a test.)
//
// Run standalone: node --experimental-strip-types packages/web/test/uiPropForwarding.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

register("./_tsxLoaderHook.mjs", import.meta.url);

const {
  Dot, StatusPill, Badge, Chip, SectionLabel, NavTab, Segmented, PresetAccentDots,
} = await import("../src/components/ui/index.tsx");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("Dot forwards data-* / aria-* / id, and merges style rather than clobbering it", () => {
  const html = renderToStaticMarkup(
    React.createElement(Dot, {
      tone: "phosphor",
      "data-testid": "dot-el",
      "aria-label": "session status",
      id: "dot-1",
      className: "extra",
      style: { marginLeft: 4 },
    }),
  );
  assert.match(html, /data-testid="dot-el"/);
  assert.match(html, /aria-label="session status"/);
  assert.match(html, /id="dot-1"/);
  assert.match(html, /class="extra"/);
  assert.match(html, /margin-left:4px/); // caller style present
  assert.match(html, /width:8px/); // component's own base style not clobbered
});

check("StatusPill forwards data-*/aria-* to its root span", () => {
  const html = renderToStaticMarkup(
    React.createElement(StatusPill, { tone: "cyan", label: "IDLE", "data-testid": "pill-el", "aria-label": "idle" }),
  );
  assert.match(html, /data-testid="pill-el"/);
  assert.match(html, /aria-label="idle"/);
  assert.match(html, />IDLE</);
});

check("Badge forwards data-* and merges caller style with its own", () => {
  const html = renderToStaticMarkup(
    React.createElement(Badge, { tone: "red", "data-testid": "badge-el", style: { marginTop: 2 } }, "RUNNING"),
  );
  assert.match(html, /data-testid="badge-el"/);
  assert.match(html, /margin-top:2px/);
  assert.match(html, /text-transform:uppercase/); // base style preserved
  assert.match(html, />RUNNING</);
});

check("Chip forwards data-*/aria-* to its root span", () => {
  const html = renderToStaticMarkup(
    React.createElement(Chip, { label: "ctx", value: "56,200", "data-testid": "chip-el", "aria-label": "context usage" }),
  );
  assert.match(html, /data-testid="chip-el"/);
  assert.match(html, /aria-label="context usage"/);
});

check("SectionLabel forwards data-* and merges caller style with its own", () => {
  const html = renderToStaticMarkup(
    React.createElement(SectionLabel, { "data-testid": "section-el", style: { margin: 0 } }, "Wave replay"),
  );
  assert.match(html, /data-testid="section-el"/);
  assert.match(html, /margin:0/);
  assert.match(html, /text-transform:uppercase/); // base style preserved despite caller style
});

check("PresetAccentDots forwards data-*/id but keeps its decorative aria-hidden pinned", () => {
  const html = renderToStaticMarkup(
    React.createElement(PresetAccentDots, { accents: ["#fff"], "data-testid": "dots-el", id: "dots-1", "aria-hidden": false }),
  );
  assert.match(html, /data-testid="dots-el"/);
  assert.match(html, /id="dots-1"/);
  assert.match(html, /aria-hidden="true"/); // decorative default wins over a caller override
});

check("Segmented forwards data-* to its root and keeps role/tablist semantics", () => {
  const html = renderToStaticMarkup(
    React.createElement(Segmented, {
      value: "a",
      onChange: () => {},
      items: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      ariaLabel: "choice",
      "data-testid": "segmented-el",
    }),
  );
  assert.match(html, /data-testid="segmented-el"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-label="choice"/);
});

check("NavTab forwards data-*/aria-* and merges className with its active-state class", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(NavTab, { to: "/x", "data-testid": "navtab-el", "aria-label": "go to x", className: "extra" }, "X"),
    ),
  );
  assert.match(html, /data-testid="navtab-el"/);
  assert.match(html, /aria-label="go to x"/);
  assert.match(html, /class="loom-navtab extra"/); // base class kept, caller class appended
});

console.log(`\n${pass} passed`);
