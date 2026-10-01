/**
 * How a vault raw asset (`/api/projects/:id/vault/raw`) is turned into something a browser can point an
 * `<img>`, an `<object>` or a download at — the JSX-free half, so `test/vault-asset.mjs` runs the SAME
 * predicates the app ships. The React half lives in `components/VaultAsset.tsx`.
 *
 * @decision f7525818 — never hand the bare raw URL to the browser on a REMOTE origin; never mint a
 * SAME-ORIGIN blob URL for a scriptable image type (`image/*+xml`); never render one as a DOCUMENT.
 *
 * WHY THERE ARE TWO MODES. `/vault/raw` is Tier-1 (gateway/trust-tier.ts), which on a remote origin means
 * Authorization-Bearer-only — and a browser cannot attach a header to an `<img src>`, an `<object data>`
 * or an `<a href download>`. So behind `tailscale serve`/a reverse proxy every one of those loads 401s:
 * images break, the PDF embed blanks, and "Download file" saves the JSON error body under the file's own
 * name. On LOOPBACK none of that is true — reads are ungated there — and the direct URL is strictly
 * better: the browser streams it, range-requests a big PDF for the native viewer, and saves a download to
 * disk without ever buffering it in the tab. Hence: direct on loopback, byte-identical to before; fetched
 * into a blob (with the credential `withGatewayAuth` attaches) only where that is the only thing that
 * works.
 */

/** `"direct"` = use the raw URL as-is (loopback: reads are ungated). `"blob"` = fetch the bytes with the
 *  gateway credential and hand the consumer an object URL (remote: the raw URL alone would 401). */
export type VaultAssetMode = "direct" | "blob";

/** `remote` is passed in rather than read from `isRemoteOrigin()` here on purpose: it keeps this module
 *  free of relative imports, which is what lets `test/vault-asset.mjs` run it under bare node. The one
 *  call site that resolves it is `components/VaultAsset.tsx`. */
export function vaultAssetMode(remote: boolean): VaultAssetMode {
  return remote ? "blob" : "direct";
}

/**
 * The type a DOWNLOAD blob is minted with — deliberately NOT the response's own Content-Type.
 *
 * An object URL carries the blob's type and nothing else: the daemon's `Content-Security-Policy: sandbox`
 * and `Content-Disposition: attachment` (card 68bef69c) do NOT survive into it. A blob minted as
 * `image/svg+xml` or `text/html` is therefore a navigable, scriptable document on the app's own origin —
 * exactly the thing 68bef69c closed on the server. `download=` means the browser saves rather than
 * renders regardless of type, so forcing an inert type here costs the download nothing and removes the
 * only way one of these URLs could become a document.
 */
export const DOWNLOAD_BLOB_TYPE = "application/octet-stream";

/** The bare type, with any `; charset=…`/`; q=…` parameters and casing normalised away, so no decision
 *  below can be defeated by a parameter the daemon happens to append. */
function bareType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * An image type whose bytes a browser renders as a scriptable DOCUMENT when one is NAVIGATED to, rather
 * than decoding as a picture. SVG is the one that matters in practice; the `+xml` family test catches the
 * rest without an allowlist to keep current.
 *
 * `<img src>` is safe for these — it decodes, it never scripts — but the URL in that `src` is not
 * private to the `<img>`: "Open image in new tab", dragging it to the address bar, or any later consumer
 * can navigate to it. So the type alone decides nothing; what matters is WHOSE ORIGIN the URL belongs to,
 * which is what `viewSource` below answers.
 */
export function isScriptableImageType(contentType: string | null | undefined): boolean {
  const t = bareType(contentType);
  return t.startsWith("image/") && t.endsWith("+xml");
}

/**
 * The type a VIEW blob is minted with. A PDF keeps `application/pdf` so `<object>` still reaches the
 * browser's native viewer. A non-scriptable `image/*` keeps its real type for `<img>`. Everything else —
 * including every scriptable image type, which must never reach a same-origin object URL (see
 * `viewSource`) — falls back to the inert download type rather than being trusted by default.
 *
 * This is the FAIL-CLOSED half: it is what makes a scriptable type unreachable even for a future caller
 * that mints a blob without going through `viewSource`.
 */
const VIEWABLE_BLOB_TYPES: ReadonlySet<string> = new Set(["application/pdf"]);
export function viewBlobType(contentType: string | null | undefined): string {
  const t = bareType(contentType);
  if (isScriptableImageType(t)) return DOWNLOAD_BLOB_TYPE; // never a same-origin scriptable document
  if (t.startsWith("image/")) return t; // a raster image/* decodes in <img> and can never script
  if (VIEWABLE_BLOB_TYPES.has(t)) return t;
  return DOWNLOAD_BLOB_TYPE;
}

/**
 * How a VIEW should carry its bytes.
 *
 * - `blob` — an object URL. Cheap and streamable, but it inherits the APP'S OWN ORIGIN, so it is only
 *   ever minted with a type `viewBlobType` has already cleared as non-scriptable.
 * - `data` — a `data:` URL, used for exactly the types `blob` must refuse. A `data:` URL has no origin
 *   to inherit: navigating to one yields an OPAQUE origin with no access to the app origin's
 *   `localStorage` (where the gateway token lives), and Chrome blocks top-level `data:` navigation
 *   outright, so both of 68bef69c's server-side defences have a client-side equivalent again.
 */
export type VaultViewSource = { kind: "blob" | "data"; type: string };
export function viewSource(contentType: string | null | undefined): VaultViewSource {
  const t = bareType(contentType);
  if (isScriptableImageType(t)) return { kind: "data", type: t };
  return { kind: "blob", type: viewBlobType(t) };
}

/** The file name a download should be saved under — the vault path's last segment. */
export function assetFileName(path: string): string {
  return path.split("/").pop() || path;
}
