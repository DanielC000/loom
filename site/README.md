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

Not deployed. GitHub-Pages-ready: relative asset paths only, so pointing Pages at `/site` (or copying
its contents to the Pages root) would publish it as-is. Publishing remains the owner's call.

## Files

- `index.html` — the page (semantic landmarks, single page).
- `styles.css` — tokens mirrored from `packages/web/src/styles/global.css` so it reads as the same product.
- `favicon.svg` — the woven Loom mark (from `packages/web/src/components/Logo.tsx`).

## Placeholders / notes

- The hero shows a **CSS-rendered mock** of Loom's orchestration view with **synthetic data only**
  (fake branch names, fake diff counts). There are **no live screenshots of real project data**, per
  the task. The owner can later swap it for a real, scrubbed screenshot if desired.
- Fonts load from Google Fonts (same CDN the app uses); system fallbacks keep the layout intact
  offline.
