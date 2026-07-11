# Loom landing site

A self-contained, single-page static landing site for Loom. Hand-authored HTML + CSS — **no build
step, no dependencies**. It sits outside the pnpm/turbo workspace (`packages/*`), so it never
affects `pnpm build`.

## Open it locally

Just open the file — all asset paths are relative, so it works from `file://` or any static host:

```sh
# macOS / Linux
open site/index.html
# Windows
start site/index.html
```

Or serve it (closer to how GitHub Pages behaves):

```sh
npx serve site
# then visit the printed http://localhost:3000
```

## Deploying

`.github/workflows/pages.yml` publishes this folder to GitHub Pages **verbatim** (no build step) on a
merge to `main` that touches `site/**`. Merging such a change therefore **publishes the site live**, so
the merge is owner-gated.

## Files

- `index.html` — the landing page (semantic landmarks, single page) with a small block of inline,
  self-contained JS for reveal-on-scroll and the quickstart copy buttons (both progressive enhancement;
  the page is fully usable with JS disabled).
- `remote-access.html` — a docs subpage covering how to reach the daemon from another device
  (Tailscale Serve / SSH as the recommended primary; a direct authenticated bind with a gateway token +
  TLS as the co-equal alternative). Reuses `styles.css` and the same inline reveal/copy JS; linked from
  the header nav. Its `.doc-*` / `.opt-*` / `.callout` styles are additive, so `index.html` is unaffected.
- `styles.css` — tokens mirrored from `packages/web/src/styles/global.css` so it reads as the same
  product. The brand type (Space Grotesk + JetBrains Mono, both OFL-1.1) is embedded as base64 `woff2`
  `@font-face` rules at the top of the file.
- `favicon.svg` — the woven Loom mark (from `packages/web/src/components/Logo.tsx`).

## Placeholders / notes

- The hero shows a **CSS/SVG-rendered mock** of Loom's orchestration weave with **synthetic data only**
  (fake branch names, fake diff counts). There are **no live screenshots of real project data**, per
  the task. The owner can later swap it for a real, scrubbed screenshot if desired.
- **Zero network requests:** fonts are embedded offline as base64 `woff2`, images are inline SVG, and
  the JS is inline. Nothing is fetched from a CDN, so the page renders fully offline from this folder
  with relative paths. Do not reintroduce a remote font/script/image link.
- Motion (the animated weave shuttle, reveal-on-scroll) is disabled under
  `prefers-reduced-motion: reduce`, which leaves a clean static composition.
