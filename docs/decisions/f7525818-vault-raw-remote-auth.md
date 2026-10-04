# Vault raw assets authenticate by fetching a blob, not by minting a signed URL

Card `f7525818`, out of the full web-viewport review (`edc931d8`). Anchored from `packages/web/src/lib/vaultAsset.ts`, `packages/web/src/components/VaultAsset.tsx` and `packages/daemon/src/gateway/trust-tier.ts`.

## The defect

`GET /api/projects/:id/vault/raw` is Tier-1, and the trust-tier wall makes a Tier-1 route **Authorization-Bearer-only** on a remote request (`?token=` is admitted for the three WS routes only — a browser cannot set a header on a WS upgrade). But the web app handed the bare raw URL straight to the browser: `<img src>` for the image viewer and every inline markdown image, `<object data>` for the PDF embed, and `<a href download>` for "Download file". A browser attaches nothing to any of those.

So behind `tailscale serve` or any trusted reverse proxy, every vault image was a broken box, the PDF embed was blank, and "Download file" cheerfully saved the daemon's `{"error":"unauthorized"}` JSON body under the real file's name. The `HEAD` size probe was worse than broken: `routeTier` keys on the exact `{method, pattern}` pair, so `HEAD /api/projects/:id/vault/raw` was never Tier-1 at all and the binary card's size permanently read "unknown size" remotely.

## What ships: (a) blob fetch, not (b) a signed URL

Both options were on the table. **(a) ships.**

- **(a) fetch the bytes through `guardedFetch` + `withGatewayAuth`, hand the consumer an object URL.** The credential rides the `Authorization` header that already works, on the one chokepoint every other request in `lib/api.ts` already goes through. The server is untouched except for one allowlist line. Nothing new is minted, stored, logged, or expired.
- **(b) a short-lived signed URL.** Rejected. It mints a **new bearer-equivalent credential** — one that, by construction, travels in a URL: into browser history, into the `Referer` of anything the document loads, into proxy and daemon access logs, and into whatever the owner pastes. That is a trust-boundary change to the gateway's auth model, which would need a Code Reviewer, its own threat model, and a key lifecycle. The two concrete things that could have forced it both turned out not to:
  - **a large PDF in `<object>`** — Chromium's native viewer instantiates fine from a `blob:` URL. The real cost is that a blob is buffered whole in the tab instead of range-requested, bounded by the route's own `VAULT_RAW_MAX_BYTES` (50 MB). Paid only on a remote origin.
  - **`<a download>` naming** — the `download=` attribute supplies the file name, so a blob URL saves under the right name without the server's `Content-Disposition` surviving.

Cost (a) does pay, stated rather than hidden: on a remote origin the bytes land in tab memory, and a download is buffered before it is saved (so there is a "Preparing…" state where loopback had an instant native save).

## Do not collapse the two modes into one

`vaultAssetMode()` returns `direct` on loopback and `blob` on a remote origin, and **both branches are load-bearing**. On loopback, reads are ungated and the direct URL is strictly better — the browser streams it, range-requests a big PDF for the native viewer, and writes a download to disk without ever buffering it. Making loopback go through blobs to "have one code path" would regress all three for the overwhelmingly common case, and would also break `packages/web/e2e/vault.spec.ts`'s card-`68bef69c` assertion that the viewer's `<img src>` still points at `vault/raw`.

## Do not mint a same-origin URL for a scriptable image type

An object URL carries the blob's **type and nothing else**, and it **inherits the app's own origin**. The daemon's `Content-Security-Policy: sandbox; default-src 'none'` and `Content-Disposition: attachment` (card `68bef69c`) are response *headers* and do **not** survive into it. So a blob minted `image/svg+xml` is a navigable, scriptable document on the app's own origin — re-opening on the client exactly the hole `68bef69c` closed on the server.

**The first version of this fix got that wrong, and this record argued for the wrong thing.** It kept the real type for all of `image/*` because "an `<img>` never executes an SVG's script" — true, and irrelevant: **the URL in a `src` is not private to the `<img>`.** "Open image in new tab", a drag to the address bar, or any later consumer navigates to it as a top-level document, and the vault's `<script>` then runs with the origin whose `localStorage` holds the gateway token. Demonstrated, not argued: `vault-remote-assets.spec.ts`'s positive control opens a same-origin `blob:` of a hostile vault SVG in a second tab and reads the live token back out.

Three rules keep it unreachable, all in `lib/vaultAsset.ts`:

- a **download** blob is always minted `application/octet-stream` (`DOWNLOAD_BLOB_TYPE`), never the response's own type — `download=` saves regardless of type, so this costs nothing;
- a **view** blob (`viewBlobType`) keeps its real type only for a non-scriptable `image/*` and for `application/pdf` (no DOM/`localStorage` reach, and `<object>` needs the real type for the native viewer); everything else — **including every scriptable image type** — falls back to the inert download type, fail-closed even for a future caller that mints a blob without asking `viewSource`;
- a **scriptable image type** (`isScriptableImageType`: `image/*+xml`, which is how `image/svg+xml` is caught — the same family test `68bef69c` uses server-side) is carried as a **`data:` URL** instead, never an object URL (`viewSource`).

**Why `data:` and not "stop inlining SVGs".** A `data:` URL has no origin to inherit — navigating to one yields an **opaque** origin with no access to the app's storage even if the script runs; **that opaque origin, not any navigation block, is the load-bearing defence.** Chrome blocks only a *renderer-initiated* top-level `data:` navigation (a link click, `window.location`); a *browser-initiated* one (the address bar, `page.goto` in a test) still proceeds. It also keeps the SVG *rendering* — refusing to inline would make a remote origin feature-poorer than loopback. Cost: a scriptable image is base64-inlined at ~1.37× the blob's bytes, no handle to revoke, bounded only by `VAULT_RAW_MAX_BYTES`; no separate web-side cap was added, since an SVG anywhere near that size is pathological.

So a future change that points an `<iframe src>`, a `window.open`, or an `<object>` of an active type at one of these URLs has to revisit this record first.

## Do not put the bare raw URL in the DOM on a remote origin

"Download file" is an `<a href … download>` on loopback and a **`<button>`** on a remote origin — not an `<a>` with its click intercepted. Interception leaves the raw URL live in the DOM, and every route that bypasses the handler still reaches it: a middle-click, a ⌘/Ctrl-click, "Open link in a new tab", or a second click arriving while "Preparing…" (the first version returned early on `busy` *without* `preventDefault`, so the anchor simply navigated). Each loads the URL credential-less — a 401 — and `download=` then saves that JSON error body under the real file's name, which is the original defect this card exists to fix. A `<button>` has no navigable target for any of those to resolve to, which is structurally stronger than any `preventDefault()`. `.loom-btn` already neutralises the UA's light button chrome, so the two branches render identically.

Re-entry is guarded by a **ref, not the `busy` state**: `setBusy(true)` does not take effect until React re-renders, so two clicks in one tick both read `busy === false` and would both fetch (and save) the file. `disabled={busy}` is the visible half; the ref is the one that actually holds.

## Do not widen the HEAD admission

`{ method: "HEAD", pattern: "/api/projects/:id/vault/raw" }` is now in `TIER_1_ROUTES` — **that exact pair and nothing else**. `routeTier` stays an exact `{method, pattern}` lookup: `POST`/`PUT`/`DELETE`/`OPTIONS` on the same path are still Tier-0, and `HEAD` on every *other* Tier-1 GET is still Tier-0. Do not "simplify" this by making `routeTier` fold `HEAD` into `GET` — that would silently promote the auto-registered `HEAD` sibling of every Tier-1 route in one edit, which is a trust-boundary change nobody reviewed.

It is safe for this one route because a `HEAD` returns the headers of a `GET` that is already Tier-1 and no body — strictly less than the admission it rides on.

## How the HEAD gap survived review

`packages/daemon/test/trust-tier.mjs`'s `liveRoutesOf` filters `HEAD`/`OPTIONS`/`TRACE` out of the live route derivation, and its doc comment used to assert "a HEAD probe of a Tier-1 GET is itself intended to be Tier-1" — which was simply **false** about the code it was describing, and is most of why this gap survived. Because the filter removed `HEAD` from the population, the test's own completeness guarantee structurally could not see it. The comment is corrected, check `(1f)` pins the three classification polarities, and check `(3f)` drives the same three as REAL requests through the live wall — which is also what proves the allowlist's pattern *string* is the one Fastify registers, since a typo there would 401 while a pure classification check still passed.
