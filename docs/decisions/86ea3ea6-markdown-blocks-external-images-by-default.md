# 86ea3ea6 — Markdown blocks external images by default, Vault included

## Decision

`packages/web/src/components/Markdown.tsx` never fetches an off-host image on render. An external `![alt](https://…)` renders as the `md-ext-img` placeholder ("image not loaded · alt", the URL in its title) with a **Load** button. The only way to load external images on render is the explicit `allowExternalImages` prop, and no caller sets it today.

This replaces the earlier `untrusted = false` prop (card c7f999f4), which made blocking an opt-in that every caller rendering agent bytes had to remember. It gated nothing but external images: raw HTML (never rendered, no `rehype-raw`) and `javascript:`/`data:` links (emptied by `defaultUrlTransform`) were already inert for every caller, and stay that way under both settings.

## Why the Vault is included

The owner chose this (request d51060bb, answer "1B"). Vault notes are written by agents (`vault_write`, research imports, anything dropped in the folder), so an `<img src>` to an arbitrary host in a note is a read beacon: it tells that host when, and from where, the owner opened the note. The Vault viewer is the most-read Markdown surface, so it is the one that most needed the safe default.

## Click-to-load is per image and ephemeral

The Load button loads that one image, for that mount only (component state in `ExternalImage`). Nothing is persisted: no "always allow", no per-host allowlist. Opening another note and coming back, or reloading, blocks it again. A loaded image is requested with `referrerPolicy="no-referrer"`.

## Do not

- Do not flip the default back, or add a caller that passes `allowExternalImages` for agent-written content. A caller that opts in needs a one-line comment saying why its source cannot be agent-written.
- Do not remember a click (localStorage, a per-host allowlist, an "always load" toggle) without a new owner decision. Ephemeral is part of what the owner approved.
- Do not couple a different protection (raw HTML, URL sanitising) to `allowExternalImages`. Those stay unconditionally on.

## Tests

- `packages/web/test/markdown-external-images.mjs`: the default renders the placeholder and no external `<img>`, the opt-in renders the `<img>`, the other protections hold under both.
- `packages/web/e2e/vault.spec.ts` ("blocks an external image in a vault note until Load is clicked…"): counts intercepted requests to the beacon host (zero before the click, one after, none after navigating away and back or reloading).
