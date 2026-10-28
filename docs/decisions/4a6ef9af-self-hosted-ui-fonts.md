# The UI's brand faces are self-hosted VARIABLE woff2, declared by hand, with a `unicode-range` on every block

Card `4a6ef9af`. Anchored from `packages/web/src/styles/fonts.css`. Found by card `4756e252`'s investigation of the atlas-board-dialog flake class.

## What changed

`packages/web/src/styles/global.css:8` used to `@import url("https://fonts.googleapis.com/css2?…&display=swap")`. A loopback-only app therefore made a third-party request to Google on every UI load (leaking the viewer's IP), fell back to system fonts offline, and — because `display=swap` paints the fallback first — re-laid-out when the woff2 finally landed, with NewTask/FilterBar growing 73→75 and 25→27 px at the swap. Card `4756e252` measured the fetch itself, cache-cleared, at **103-179 ms** over 24 fetches.

⚠️ **Do not cite the "gstatic woff2 at 4.2-4.6 s" figure** that card `4a6ef9af`'s original body carried and that this record's own first draft repeated. It is a **completion timestamp, not a latency**: a face is requested only when first *used*, so a slow first render pushes the timestamp out. The real window is tens-to-low-hundreds of ms, widening on a slow network — which is near the e2e settle quantum, and is why this flaked rather than failed outright. The 4.2 s number overstates the cost of the thing this card removed by more than an order of magnitude; the mechanism is what justifies the change, not the size of that number. The `~0.5 s` googleapis-CSS figure from the same reading is dropped rather than repeated here: it was never separately re-measured, and it comes from the same instrument that produced the corrected one.

It is now `@import "./fonts.css"` — four `@font-face` blocks over `@fontsource-variable/{space-grotesk,jetbrains-mono}`, bundled by Vite into `dist/assets` and served from the daemon's own origin.

## Do not

- **Do not swap the VARIABLE packages for `@fontsource/*`'s static per-weight masters.** Google's own css2 response served *variable* files, so the variable packages are the faces the CDN build actually rendered with — measured **0.000000 px** advance delta against the real gstatic binaries at every weight the UI declares (Space Grotesk 400/500/600/700 @17px, JetBrains Mono 400/500/700 @13px), and Space Grotesk's latin file is **byte-identical** to gstatic's (sha256 `0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d`). The static 600 master is a *different* face: it measures ~0.007px wider than the variable instance at 600 on a real node title, which was enough to move the Atlas nodehead cluster's right-aligned box by one rounded pixel (its width and height unchanged) — the static variant was built first and showed exactly that, on 4 of 165 measured boxes. It is also roughly twice the bytes (188,876 vs 96,828 for the same two subsets).
- **Do not replace the hand-written blocks with an import of `@fontsource-variable/*`'s own CSS.** Its blocks name the family `"Space Grotesk Variable"` / `"JetBrains Mono Variable"`, which is not what `--loom-font-head` / `--loom-font-mono` name, and the static packages' CSS additionally lists a legacy `.woff` beside each `.woff2` — a file no browser that reaches this app will ever fetch, but one Vite emits into `dist` regardless, because it is a referenced `url()`.
- **Do not drop the `unicode-range` from any block.** It is the only thing keeping a subset the UI never renders from being downloaded. With it, `latin-ext` costs nothing at runtime (verified: a seeded English UI loads the two `latin` faces and neither `latin-ext` one); without it, both subsets load eagerly on every page view. This is also why bundling `latin-ext` is close to free and worth it — it keeps Central/Eastern European and Turkish names in the real face.
- **Do not read "self-hosted" as full CDN coverage parity.** Only `latin` + `latin-ext` are bundled. JetBrains Mono's `cyrillic`, `cyrillic-ext`, `greek` and `vietnamese`, and Space Grotesk's `vietnamese`, are deliberately **not** shipped; text in those ranges now renders in the fallback font, where the CDN would have fetched the real subset on demand. That is a real, accepted reduction (a local-first app should not reach a third party to render a name), not an oversight — add a subset deliberately if it starts mattering, rather than switching back to the CDN.
- **Do not add `site/`'s fonts to this.** `site/styles.css` already self-hosts, as base64-embedded variable woff2 with no network request at all, and reaches no CDN — it needs nothing here.

## `font-display: swap` is kept, deliberately

The layout shift this card removes was never caused by `swap` as such — it was caused by `swap` over a cross-origin chain whose latency belongs to the viewer's network rather than to us. Same-origin, from local disk, the FOUT window collapses to roughly a disk read; `block` would instead trade that for up to 3 s of invisible text. `swap` also matches what `site/styles.css` already uses.

## Measurements

| | before | after |
|---|---|---|
| third-party font requests | **9** (3 × googleapis CSS, 6 × gstatic woff2) | **0** |
| hosts contacted | `127.0.0.1:*`, `fonts.googleapis.com`, `fonts.gstatic.com` | `127.0.0.1:*` only |
| `@font-face` blocks declared | 30 (Google's full subset matrix) | 4 |
| faces loaded, seeded English UI | 7 (one static instance per weight) | 2 (both `latin`; neither `latin-ext`) |
| `dist/assets` CSS | 46,274 B | 47,605 B (+1,331) |
| `dist/assets` JS | 1,776,101 B | unchanged |
| bundled woff2 | 0 | 96,828 B (4 files) |
| **total `dist` delta** | — | **+98,159 B (+95.9 KiB)** |
| bytes fetched for an ASCII UI | 53,720 B cross-origin, 2 chained hops | 62,692 B same-origin |

The nine third-party requests in the "before" column are the **positive control** for the zero in the "after" column: the absence claim is only worth something because the same logger, on the same code path, demonstrably recorded them one build earlier. A request log that silently matched nothing would read `0` either way.

**No visual change, measured, not eyeballed:** every `[data-testid]` element's rounded box (`w`/`h`/`x`/`y`) was captured on three surfaces (Atlas project node, classic `/overview`, an Atlas session node) at 1440 and 420, with every declared face forced `loaded` first so the "before" numbers are the *post*-swap layout. **165 boxes across the six surface/width pairs, 0 differing**, and the computed `font-family`/`font-size`/`font-weight`/`line-height` on `body` and `h1` identical on all six. PNGs for both phases are under `$LOOM_PROJECT_WORK_DIR/card4a6ef9af/{before,after}/`; they are the eyeball artifact, not the proof — per-run seeded ids and timestamps legitimately differ between the two captures, which is exactly why the geometry snapshot is what the claim rests on.

## Licence

`@fontsource-variable/jetbrains-mono` and `@fontsource-variable/space-grotesk`, both `5.3.0`, both **OFL-1.1** (`license` field, and each package ships its own `LICENSE`: "Copyright 2020 The JetBrains Mono Project Authors" / "Copyright 2020 The Space Grotesk Project Authors", SIL Open Font License v1.1). OFL-1.1 permits redistribution of the font software, bundled and embedded, so shipping these woff2 files inside `packages/web/dist` — and therefore inside the published `loomctl` tarball — is permitted. `site/styles.css` already relies on the same grant for its base64 copies.

## Mechanics worth knowing next time

- Vite resolves a **bare package specifier inside CSS `url()`** (`url("@fontsource-variable/space-grotesk/files/….woff2")`) through `node_modules`, and emits the file into `dist/assets` with a content hash. No `?url` import, no relative `../../node_modules` path (which pnpm's layout would break anyway).
- Each emitted woff2 gets its **own `isAsset` entry** in `dist/.vite/manifest.json`, so `scripts/build-npm-package.mjs`'s orphaned-web-bundle guard sees them as referenced. Verified by running the real `pack:npm` (`--no-build`) green, not by reading the guard.
- The guard that catches a mistake here is `packages/daemon/test/web-build-no-orphans.mjs` plus that pack-time check — there is no font-specific test, and this card added none. What a future change would actually break is one of the three prohibitions above, none of which is mechanically checked; the `@decision` anchor in `fonts.css` is the whole defence.
- Google's css2 response is what tells you whether a family ships variable or static: a request log showing **2** gstatic woff2 fetches behind **7** declared weights is the tell. Check that before picking an `@fontsource` flavour, rather than assuming the package name matching the family is the right one.

## Reusable: how to carry a "no visual change" claim

Worth lifting for the next card that has to prove a rendering change is inert — none of this is font-specific.

- **Screenshots cannot carry the claim.** Two captures of a seeded app legitimately differ in per-run ids and timestamps, so a PNG diff is never clean and you end up arguing about which differences count. Capture them as the eyeball artifact and put the claim on measurements.
- **Snapshot geometry instead:** every `[data-testid]` element's rounded `{w,h,x,y}`, per surface × width, collected from the rendered tree rather than a hand-typed selector list (so a re-homed surface is covered without editing the harness). ⚠️ **Normalise per-run uuids out of the testids before diffing** (`atlas-agent-row-<uuid>` → `atlas-agent-row-<uuid>`): a naive positional diff otherwise reported 22 "differences" here whose `w`/`h`/`x`/`y` numbers were *identical*, purely because the sort order moved — 22 false positives that look exactly like real ones.
- **Settle the thing you are measuring, in BOTH phases.** Every declared face is forced through `document.fonts.load(spec)` and then polled on `document.fonts.check(spec)` before any measurement, so the "before" numbers are the post-swap layout. Skip that and you compare a fallback render against a real one, which produces a large, confident, meaningless diff. Card `4756e252` noted that the font swap reached **every geometry compare in `packages/web/e2e`, not just the board** — so this is the generic remedy for that whole class, not a trick for this card. Self-hosting removes the cause, but a spec that measures geometry should still settle the faces it depends on rather than assume the network is no longer in the picture.
- **An absence claim needs a known-present control, not a negative one.** "Zero requests to `fonts.googleapis.com`" is worth nothing by itself — an empty logger returns zero exactly like a true absence. The same logger on the same code path recorded **9** one build earlier, and that is what makes the zero evidence. The same discipline applies to the repo-wide grep that shows the CDN string is gone: `git --no-pager grep -c "fonts.googleapis" 704848c4 -- packages/web/src/styles/global.css` returns `1`, proving the pattern itself matches.
- **`pnpm --filter @loom/web test:e2e`'s positional args are path regexes**, so the atlas/overview neighbours run in chunks (`"atlas-[a-c]"`, `"atlas-[d-l]"`, …): 42 atlas + 2 overview specs, 239 tests, ~6.5 min total, one fixture daemon per invocation (`loomDaemon` is worker-scoped). ⛔ `--list` cannot be passed through that script — its `node -e` wrapper consumes it (`node: bad option: --list`).
