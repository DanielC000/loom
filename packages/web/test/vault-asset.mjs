// Hermetic unit test for lib/vaultAsset.ts — the mode + blob-type rules behind card f7525818 (vault raw
// assets authenticate on a remote origin). Imports the SAME source the app ships.
//
// ⚠️ SCOPE, stated up front: this covers the PREDICATES only. That the three consumers actually route
// through them — the image viewer, the markdown inline images, the PDF embed and "Download file" — is
// proved against a real daemon on a real non-loopback origin by packages/web/e2e/vault-remote-assets.spec.ts.
// Neither test substitutes for the other: a pure test cannot see WHICH url a component handed the browser.
//
// Run standalone: node --experimental-strip-types packages/web/test/vault-asset.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// No window stub is needed: lib/vaultAsset.ts deliberately has NO relative imports and reads no globals —
// `remote` is passed in by its one caller. That is what lets this run under bare node.

const V = await import("../src/lib/vaultAsset.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

check("mode: a loopback origin stays DIRECT (reads are ungated there, and the browser streams it)", () => {
  assert.equal(V.vaultAssetMode(false), "direct");
});

check("mode: a remote origin needs the BLOB fetch (the raw URL alone is Bearer-only and would 401)", () => {
  assert.equal(V.vaultAssetMode(true), "blob");
});

check("mode: the ONE caller resolves `remote` through isRemoteOrigin, not a local re-derivation", () => {
  // `vaultAssetMode` takes `remote` explicitly (so this module stays import-free and node-runnable), which
  // moves the "am I remote?" question to its single call site. Pin that the call site asks the SHARED
  // predicate rather than re-implementing a hostname check that could drift from the one the credential
  // layer uses — a drift would make the app fetch blobs while `withGatewayAuth` attached no token, or the
  // reverse. This is a source assertion, not a behavioural one; the behaviour is the e2e spec's job.
  const src = readFileSync(new URL("../src/components/VaultAsset.tsx", import.meta.url), "utf8");
  assert.match(src, /import \{ isRemoteOrigin \} from "\.\.\/lib\/gatewayCredential"/);
  const calls = src.match(/vaultAssetMode\((?:[^()]|\([^()]*\))*\)/g) ?? [];
  assert.ok(calls.length > 0, "expected at least one vaultAssetMode call to assert about");
  for (const c of calls) assert.equal(c, "vaultAssetMode(isRemoteOrigin())", c);
});

check("a DOWNLOAD blob is minted inert — never the response's own type", () => {
  // The daemon's `Content-Security-Policy: sandbox` / `Content-Disposition: attachment` (card 68bef69c) do
  // NOT survive into an object URL, so a blob minted `image/svg+xml` would be a scriptable document on the
  // app's own origin. `download=` names the file regardless of type, so this costs the download nothing.
  assert.equal(V.DOWNLOAD_BLOB_TYPE, "application/octet-stream");
});

check("viewBlobType: a RASTER image keeps its real type (an <img> decodes it and can never script)", () => {
  for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
    assert.equal(V.viewBlobType(t), t, t);
  }
});

// ── The scriptable-image rule: an <img> is safe, but the URL in its `src` is not private to the <img> ──
// An object URL inherits the APP'S OWN ORIGIN. "Open image in new tab" (or dragging the src to the address
// bar) navigates to it as a top-level document, and a navigated `image/svg+xml` document runs its <script>
// with that origin's localStorage — which is where the gateway token lives. The daemon's own defences for
// exactly this (`Content-Security-Policy: sandbox`, `Content-Disposition: attachment`, card 68bef69c) do
// NOT survive into a blob, so the client has to refuse the same-origin URL itself. These assertions are
// the inverse of what this file asserted when the card first shipped; that version was wrong.
check("viewBlobType: a scriptable image type NEVER gets a same-origin blob — image/*+xml is fail-closed", () => {
  for (const t of ["image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", "image/anything+xml"]) {
    assert.equal(V.viewBlobType(t), V.DOWNLOAD_BLOB_TYPE, t);
  }
});

check("isScriptableImageType: image/*+xml only — not a raster image, not a non-image +xml", () => {
  for (const t of ["image/svg+xml", "IMAGE/SVG+XML", "image/svg+xml; charset=utf-8", "image/anything+xml"]) {
    assert.equal(V.isScriptableImageType(t), true, t);
  }
  // A non-image `+xml` is already inert via the fail-closed fallback, and must not be mislabelled an IMAGE
  // — `viewSource` would otherwise hand `<img>` a data: URL of a type it cannot render at all.
  for (const t of ["image/png", "application/xhtml+xml", "text/xml", "application/xml", "text/html",
    "application/pdf", "image-ish/svg+xml", "", null, undefined]) {
    assert.equal(V.isScriptableImageType(t), false, String(t));
  }
});

check("viewSource: a scriptable image is carried as a data: URL (opaque origin), everything else as a blob", () => {
  // data: — no origin to inherit, so a navigation to it cannot reach the app origin's storage (and Chrome
  // blocks a top-level data: navigation outright). The TYPE is preserved so the <img> still renders it.
  assert.deepEqual(V.viewSource("image/svg+xml"), { kind: "data", type: "image/svg+xml" });
  assert.deepEqual(V.viewSource("image/svg+xml; charset=utf-8"), { kind: "data", type: "image/svg+xml" });
  assert.deepEqual(V.viewSource("image/png"), { kind: "blob", type: "image/png" });
  assert.deepEqual(V.viewSource("application/pdf"), { kind: "blob", type: "application/pdf" });
  // The fail-closed tail: anything else is a blob, but an INERT one.
  for (const t of ["text/html", "application/xhtml+xml", "application/javascript", "", null, undefined]) {
    assert.deepEqual(V.viewSource(t), { kind: "blob", type: V.DOWNLOAD_BLOB_TYPE }, String(t));
  }
});

check("viewSource: a same-origin blob is NEVER minted with a type other than the three this module allows — not merely 'not a scriptable image/*+xml', which a regression could satisfy by accident", () => {
  // `isScriptableImageType` recognises exactly ONE scriptable family (image/*+xml). Asserting a same-origin
  // blob's type against ONLY that predicate would pass a regression where `viewBlobType`'s fail-closed
  // fallback returned something else scriptable — e.g. "text/html" — since text/html is not image/*+xml and
  // so reads as "not scriptable" to that narrow check, while a navigated text/html document executes a
  // <script> exactly like a navigated SVG does. Assert the POSITIVE allowlist instead: the only types this
  // module ever mints for a same-origin blob are a non-+xml image/* (viewBlobType), application/pdf
  // (viewBlobType), or DOWNLOAD_BLOB_TYPE (the fail-closed fallback, and the only type a download ever
  // gets) — anything else failing this is itself the bug, however it got minted.
  const isAllowedSameOriginBlobType = (type) =>
    type === V.DOWNLOAD_BLOB_TYPE || type === "application/pdf" ||
    (typeof type === "string" && type.startsWith("image/") && !type.endsWith("+xml"));
  for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml",
    "IMAGE/SVG+XML", "image/svg+xml; charset=utf-8", "image/anything+xml", "application/pdf", "text/html",
    "text/xml", "application/xml", "application/xhtml+xml", "application/javascript", "text/plain",
    "image-ish/svg+xml", "application/octet-stream", "", null, undefined]) {
    const s = V.viewSource(t);
    if (s.kind === "blob") assert.ok(isAllowedSameOriginBlobType(s.type), `same-origin blob minted an unexpected type ${JSON.stringify(s.type)} for input ${String(t)}`);
  }
});

check("viewBlobType: a PDF keeps application/pdf (<object> needs it to reach the native viewer)", () => {
  assert.equal(V.viewBlobType("application/pdf"), "application/pdf");
});

check("viewBlobType: every OTHER type falls back to the inert download type — fail-closed, not an allow-by-default", () => {
  for (const t of ["text/html", "application/xml", "text/xml", "image-ish/svg+xml", "application/xhtml+xml",
    "text/plain", "application/octet-stream", "application/javascript", "", null, undefined]) {
    assert.equal(V.viewBlobType(t), V.DOWNLOAD_BLOB_TYPE, String(t));
  }
});

check("viewBlobType: parameters and case are normalised away before the decision (a charset must not defeat it)", () => {
  assert.equal(V.viewBlobType("IMAGE/PNG"), "image/png");
  assert.equal(V.viewBlobType("  Application/PDF ; q=1 "), "application/pdf");
  // ...and the fail-closed side survives the same normalisation.
  assert.equal(V.viewBlobType("TEXT/HTML; charset=utf-8"), V.DOWNLOAD_BLOB_TYPE);
});

check("assetFileName: the last path segment, and never an empty download name", () => {
  assert.equal(V.assetFileName("Design/Mockups/hero.png"), "hero.png");
  assert.equal(V.assetFileName("report.pdf"), "report.pdf");
  assert.equal(V.assetFileName("a/b/"), "a/b/", "a trailing slash leaves no segment — fall back to the whole path rather than an empty name");
});

console.log(`\n${pass} checks passed`);
