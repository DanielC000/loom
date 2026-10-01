# `/vault/raw` sandboxes every response, and deliberately exempts PDFs

Card `68bef69c`, raised to p2 out of the full gateway trust-boundary review (`269ea64f`). Anchored from `packages/daemon/src/gateway/server.ts` (the raw route) and `packages/daemon/src/vault/browser.ts` (the content-type table).

## The defect

`GET /api/projects/:id/vault/raw` served `.svg` as `image/svg+xml` on the **daemon's own origin** with no CSP. The web UI only ever points an `<img>`, an `<object>`, or a download link at it — all safe — but nothing stops a human (or a link) from **navigating** to the raw URL in a tab. A navigated SVG is a full scriptable document: its `<script>` runs with the daemon origin's `localStorage`, which is exactly where the web app keeps the **loopback token** (`loom.loopbackToken`) and the gateway token. Vault bytes are untrusted — an agent's `vault_write`, a research import, anything the owner dropped into the folder — so that was a one-click token-exfiltration path from any vault SVG.

The content-type table's own doc comment asserted "Never returns a type the browser would execute inline as a document." That was false for `image/svg+xml`, and the false comment is most of why the gap survived a code-only header review.

## What ships

Every `/vault/raw` response now carries, on top of the pre-existing `X-Content-Type-Options: nosniff`:

- `Content-Security-Policy: sandbox; default-src 'none'` — `sandbox` with **no tokens** is the load-bearing half: it drops the response into an opaque origin with scripting disabled, so a navigated SVG can neither execute nor reach the real origin's storage even if it did. `default-src 'none'` additionally stops the document fetching anything.
- `Content-Disposition: attachment`, for the content types a browser genuinely executes as a document (`text/html`, `text/xml`, `application/xml`, and anything `+xml` — which is how `image/svg+xml` is caught). Defense in depth: the bytes become a download rather than a document, so the CSP is not the only thing standing in the way.

The classifier (`isActiveDocumentContentType`) keys on the **resolved Content-Type**, never the extension, so adding a new active type to `VAULT_CONTENT_TYPES` cannot silently bypass it.

## Do not drop the `application/pdf` carve-out

PDFs get `nosniff` but **no CSP**. This is deliberate, and reverting it to "apply the header uniformly" breaks a shipped feature:

- CSP `sandbox` applies sandbox flags to the resulting document, and a sandboxed document **cannot instantiate the browser's native PDF viewer** — Chrome renders a blank/failed frame. The Vault page embeds PDFs via `<object data={rawUrl} type="application/pdf">`, and `packages/web/src/pages/Vault.tsx` already records the same finding for the iframe `sandbox` attribute, which is why no sandbox was used there in the first place.
- The exfiltration path this record is about does not exist for a PDF: PDF script runs in the viewer's own restricted engine with no DOM and no `localStorage` reach.

So the carve-out costs nothing on the threat model it was written for and buys back a working viewer.

## Do not assume this affects the web UI

CSP applies to **documents**, not to image subresources, and `Content-Disposition` is ignored for `<img>`. Every in-app consumer (`Vault.tsx`'s image view, the markdown `assetSrc` inline images, the PDF `<object>`, the download `<a>`, and the `HEAD` behind the binary card) was verified unchanged in a real browser against an isolated daemon — see the card's verification notes. A future change that starts rendering vault bytes *as a document* in the app would have to revisit this, and should expect to lose scripting.
