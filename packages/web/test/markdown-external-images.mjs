// Card 86ea3ea6 — the shared Markdown renderer blocks off-host images BY DEFAULT (an `<img src>` to an
// arbitrary host is a read beacon, and vault notes are agent-written too), behind a click-to-load
// placeholder; `allowExternalImages` is the only way to load them on render. Renders the REAL shipped
// component through react-dom/server (via _tsxLoaderHook.mjs). The click itself is exercised in the
// e2e (packages/web/e2e/vault-external-images.spec.ts) — SSR has no events.
//
// Run standalone: node --experimental-strip-types packages/web/test/markdown-external-images.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./_tsxLoaderHook.mjs", import.meta.url);

const { default: Markdown } = await import("../src/components/Markdown.tsx");

const URL_ = "https://beacon.example.test/pixel.png";
const SRC = `# Note\n\n![remote beacon](${URL_})\n\n[bad](javascript:alert(1))\n\n<img src="${URL_}" onerror="x()">\n\n![local](pic.png)\n`;

function AssetImage({ path, alt }) { return React.createElement("img", { "data-asset": path, alt }); }
const render = (extra = {}) => renderToStaticMarkup(
  React.createElement(Markdown, { source: SRC, files: ["pic.png"], onOpen: () => {}, AssetImage, ...extra }),
).replace(/<style>[\s\S]*?<\/style>/, ""); // the renderer's own CSS names every class; assert on the body

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("default: no <img> points at the external host; a labelled placeholder with a Load button renders", () => {
  const html = render();
  assert.doesNotMatch(html, /<img[^>]*src="https:\/\/beacon/);
  assert.match(html, /class="md-ext-img"/);
  assert.match(html, /image not loaded · remote beacon/);
  assert.match(html, new RegExp(`title="External image not loaded: ${URL_.replace(/[.]/g, "\\.")}"`));
  assert.match(html, /<button type="button" class="md-ext-img-load"[^>]*>Load<\/button>/);
  assert.match(html, /aria-label="Load external image &quot;remote beacon&quot; from https:\/\/beacon/);
});

check("explicit allowExternalImages opt-in renders the external <img> and no placeholder", () => {
  const html = render({ allowExternalImages: true });
  assert.match(html, /<img class="md-img" src="https:\/\/beacon\.example\.test\/pixel\.png" alt="remote beacon"/);
  assert.doesNotMatch(html, /md-ext-img/);
});

check("the other inert protections hold under BOTH settings (raw HTML, javascript: links)", () => {
  for (const html of [render(), render({ allowExternalImages: true })]) {
    assert.doesNotMatch(html, /<[a-z]+[^>]*\sonerror=/i); // raw HTML stays escaped text, never an element
    assert.doesNotMatch(html, /href="javascript:/i);
  }
});

check("an in-vault relative image still resolves through AssetImage (not treated as external)", () => {
  assert.match(render(), /<img data-asset="pic\.png" alt="local"\/>/);
});

console.log(`\n${pass} checks passed`);
