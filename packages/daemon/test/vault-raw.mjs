import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Raw, binary-safe, content-typed vault file serving — GET /api/projects/:id/vault/raw?path=…
// (card 7efc9658). HERMETIC + CLAUDE-FREE + NETWORK-FREE: Db + buildServer via app.inject against a
// temp vault dir with fixtures. Modeled on web-static-serve.mjs (inject) + vault-browser.mjs (the
// traversal/junction fixtures). Proves the contract the web overhaul points <img>/PDF-embed at:
//   (1) byte-exact RAW serving of a small binary (a real .png is returned bit-for-bit, not utf8'd);
//   (2) Content-Type by extension (png→image/png, pdf→application/pdf, md→text/plain, .bin→octet);
//   (3) X-Content-Type-Options: nosniff + Content-Length on every served file;
//   (4) traversal rejected — `../`, absolute path, and an IN-VAULT symlink pointing OUTSIDE → 404;
//   (5) 404 on a missing file, 400 on a missing ?path, 404 on a non-existent project;
//   (6) the >cap file → 413 (a sparse file just over VAULT_RAW_MAX_BYTES; never streamed).
//   (7) the SANDBOXING headers (card 68bef69c, docs/decisions/68bef69c-vault-raw-csp.md): vault bytes
//       are UNTRUSTED and this is the daemon's OWN origin (where the web app keeps the loopback +
//       gateway tokens in localStorage), so a navigated .svg must never become a scriptable document.
//       `Content-Security-Policy: sandbox; default-src 'none'` on every served type EXCEPT
//       application/pdf (sandbox disables the browser's native PDF viewer → blanks the Vault page's
//       <object> embed), plus `Content-Disposition: attachment` for the active-document family only.
//   (8) PDF hardening (card f2c5eff2): Content-Disposition: attachment for a PDF ONLY when
//       Sec-Fetch-Dest: document (a top-level navigation) — never for Sec-Fetch-Dest: embed (the
//       Vault page's own <object> embed) and never when the header is absent — plus Vary:
//       Sec-Fetch-Dest on the PDF response only, never on a type this gate doesn't touch.
// Run after build: node test/vault-raw.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-vault-raw-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

// --- a temp vault + an OUTSIDE dir (the traversal target) ---
const vault = fs.realpathSync(fs.mkdirSync(path.join(TMP, "vault"), { recursive: true }) ?? path.join(TMP, "vault"));
const outside = fs.realpathSync(fs.mkdirSync(path.join(TMP, "outside"), { recursive: true }) ?? path.join(TMP, "outside"));
fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET — outside the vault\n");

// A real 1x1 transparent PNG — contains non-utf8 bytes (0x00, 0x89, 0xFF…), so a utf8 round-trip
// would corrupt it. This is the byte-exact fixture.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
fs.writeFileSync(path.join(vault, "pic.png"), PNG_BYTES);
const PDF_BYTES = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
fs.writeFileSync(path.join(vault, "doc.pdf"), PDF_BYTES);
fs.writeFileSync(path.join(vault, "note.md"), "# inside\nhello vault\n");
// A HOSTILE SVG — the card's actual attack fixture. Served as image/svg+xml, this script runs if the
// raw URL is NAVIGATED to, with the daemon origin's localStorage in reach.
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">`
  + `<script>document.title = "PWNED:" + JSON.stringify(localStorage);</script>`
  + `<rect width="40" height="40" fill="#0f0"/></svg>`;
fs.writeFileSync(path.join(vault, "evil.svg"), EVIL_SVG);
fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
fs.writeFileSync(path.join(vault, "sub", "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254]));

// A sparse file just over the 50 MB cap — truncate sets the size without writing 50 MB of data.
const CAP = 50 * 1024 * 1024;
const bigPath = path.join(vault, "huge.png");
fs.writeFileSync(bigPath, "");
fs.truncateSync(bigPath, CAP + 1);

// An in-vault junction/symlink that points OUTSIDE the vault (the realpath-guard case).
const linkDir = path.join(vault, "escape");
let linked = false;
try { fs.symlinkSync(outside, linkDir, "junction"); linked = true; }
catch { try { fs.symlinkSync(outside, linkDir, "dir"); linked = true; } catch { /* no privilege */ } }

const db = new Db(path.join(TMP, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "pVault", name: "Vaulted", repoPath: TMP, vaultPath: vault, config: {}, createdAt: now, archivedAt: null, reserved: false });

const app = await buildApp(db);
const raw = (rel) => app.inject({ method: "GET", url: `/api/projects/pVault/vault/raw?path=${encodeURIComponent(rel)}` });
const rawWithHeaders = (rel, headers) =>
  app.inject({ method: "GET", url: `/api/projects/pVault/vault/raw?path=${encodeURIComponent(rel)}`, headers });

try {
  // (1) byte-exact RAW serving of the PNG
  const png = await raw("pic.png");
  check("(1) GET .png → 200", png.statusCode === 200);
  check("(1) PNG body byte-matches the fixture exactly", Buffer.compare(png.rawPayload, PNG_BYTES) === 0);

  // (2) Content-Type by extension
  check("(2) .png → image/png", png.headers["content-type"] === "image/png");
  const pdf = await raw("doc.pdf");
  check("(2) .pdf → application/pdf", pdf.statusCode === 200 && pdf.headers["content-type"] === "application/pdf");
  check("(2) .pdf body byte-matches", Buffer.compare(pdf.rawPayload, PDF_BYTES) === 0);
  const md = await raw("note.md");
  check("(2) .md → text/plain; charset=utf-8", md.statusCode === 200 && md.headers["content-type"] === "text/plain; charset=utf-8");
  const bin = await raw("sub/blob.bin");
  check("(2) unknown ext (.bin) → application/octet-stream", bin.statusCode === 200 && bin.headers["content-type"] === "application/octet-stream");
  check("(2) nested .bin body byte-matches", Buffer.compare(bin.rawPayload, Buffer.from([0, 1, 2, 3, 255, 254])) === 0);

  // (3) security + length headers on a served file
  check("(3) X-Content-Type-Options: nosniff present", png.headers["x-content-type-options"] === "nosniff");
  check("(3) Content-Length matches the fixture size", String(png.headers["content-length"]) === String(PNG_BYTES.length));

  // (4) traversal rejected (lexical + symlink-escape) → 404, never serves outside content
  const dotdot = await raw("../outside/secret.md");
  check("(4) '../' traversal → 404", dotdot.statusCode === 404);
  check("(4) '../' did NOT leak outside content", !String(dotdot.rawPayload).includes("TOP SECRET"));
  const absUrl = `/api/projects/pVault/vault/raw?path=${encodeURIComponent(path.join(outside, "secret.md"))}`;
  const absResp = await app.inject({ method: "GET", url: absUrl });
  check("(4) absolute path → 404", absResp.statusCode === 404);
  if (linked) {
    const esc = await raw("escape/secret.md");
    check("(4) in-vault symlink pointing OUTSIDE → 404", esc.statusCode === 404);
    check("(4) symlink-escape did NOT leak outside content", !String(esc.rawPayload).includes("TOP SECRET"));
  } else {
    console.log("SKIP  (4) symlink-escape case — could not create a link/junction without elevation");
  }

  // (5) missing file / missing param / missing project
  check("(5) missing file → 404", (await raw("does-not-exist.png")).statusCode === 404);
  check("(5) missing ?path → 400", (await app.inject({ method: "GET", url: "/api/projects/pVault/vault/raw" })).statusCode === 400);
  check("(5) unknown project → 404", (await app.inject({ method: "GET", url: "/api/projects/nope/vault/raw?path=pic.png" })).statusCode === 404);
  check("(5) a directory (not a file) → 404", (await raw("sub")).statusCode === 404);

  // (6) over-cap file → 413, never streamed
  const big = await raw("huge.png");
  check("(6) file over the 50 MB cap → 413", big.statusCode === 413);
  check("(6) over-cap response is NOT the file bytes", big.rawPayload.length < 1024);

  // (7) sandboxing headers — the trust boundary (card 68bef69c)
  const CSP = "sandbox; default-src 'none'";
  const svg = await raw("evil.svg");
  check("(7) .svg → 200 image/svg+xml (still served, not blocked)",
    svg.statusCode === 200 && svg.headers["content-type"] === "image/svg+xml");
  check("(7) .svg body is served byte-exact (the guard is headers, not rewriting)",
    svg.rawPayload.toString("utf8") === EVIL_SVG);
  check(`(7) .svg → Content-Security-Policy: ${CSP}`, svg.headers["content-security-policy"] === CSP);
  check("(7) .svg → Content-Disposition: attachment", svg.headers["content-disposition"] === "attachment");
  check("(7) .svg → nosniff", svg.headers["x-content-type-options"] === "nosniff");
  // Every inert type gets the CSP too — the guard is not keyed to an extension allow-list.
  check(`(7) .png → ${CSP}`, png.headers["content-security-policy"] === CSP);
  check(`(7) .md → ${CSP}`, md.headers["content-security-policy"] === CSP);
  check(`(7) .bin (octet-stream) → ${CSP}`, bin.headers["content-security-policy"] === CSP);
  // …but only the ACTIVE-document family is forced to download. An <img>/download consumer ignores
  // Content-Disposition, so adding it to images would be inert — adding it is still not what we mean.
  check("(7) .png → NO Content-Disposition", png.headers["content-disposition"] === undefined);
  check("(7) .md → NO Content-Disposition", md.headers["content-disposition"] === undefined);
  // The application/pdf carve-out: CSP sandbox disables the browser's native PDF viewer, which would
  // blank the Vault page's <object> embed. If this flips, that embed is broken — see the record.
  check("(7) .pdf → NO Content-Security-Policy (native-viewer carve-out)",
    pdf.headers["content-security-policy"] === undefined);
  check("(7) .pdf → NO Content-Disposition", pdf.headers["content-disposition"] === undefined);
  check("(7) .pdf still → nosniff", pdf.headers["x-content-type-options"] === "nosniff");

  // (8) PDF hardening (card f2c5eff2, docs/decisions/68bef69c-vault-raw-csp.md): Content-Disposition:
  // attachment ONLY for a genuine top-level navigation (Sec-Fetch-Dest: document) — never for the
  // Vault page's own <object> embed (Sec-Fetch-Dest: embed), and never for a request with no
  // Sec-Fetch-Dest at all (the pre-existing, unhardened behavior — this can only narrow the window).
  const pdfDocument = await rawWithHeaders("doc.pdf", { "sec-fetch-dest": "document" });
  check("(8) .pdf with Sec-Fetch-Dest: document → Content-Disposition: attachment",
    pdfDocument.headers["content-disposition"] === "attachment");
  check("(8) .pdf with Sec-Fetch-Dest: document → still NO CSP (the carve-out itself is unaffected)",
    pdfDocument.headers["content-security-policy"] === undefined);
  check("(8) .pdf with Sec-Fetch-Dest: document → Vary: Sec-Fetch-Dest",
    pdfDocument.headers["vary"] === "Sec-Fetch-Dest");

  const pdfEmbed = await rawWithHeaders("doc.pdf", { "sec-fetch-dest": "embed" });
  check("(8) .pdf with Sec-Fetch-Dest: embed (the <object> embed's own shape) → NO Content-Disposition",
    pdfEmbed.headers["content-disposition"] === undefined);
  check("(8) .pdf with Sec-Fetch-Dest: embed → Vary: Sec-Fetch-Dest still present",
    pdfEmbed.headers["vary"] === "Sec-Fetch-Dest");

  // (8-control) NEGATIVE: a request with no Sec-Fetch-Dest header at all (older browsers) gets the
  // pre-existing behavior — no Content-Disposition — never a fail-closed-into-breaking-the-viewer surprise.
  check("(8-control) .pdf with NO Sec-Fetch-Dest header → NO Content-Disposition (pre-existing behavior)",
    pdf.headers["content-disposition"] === undefined);
  // (8-control) the Sec-Fetch-Dest gate is specific to "document" — a near-miss value (case-sensitive,
  // and a different real destination) must NOT trip it, proving this isn't a broken-pattern always-match.
  const pdfIframe = await rawWithHeaders("doc.pdf", { "sec-fetch-dest": "iframe" });
  check("(8-control) .pdf with Sec-Fetch-Dest: iframe → NO Content-Disposition",
    pdfIframe.headers["content-disposition"] === undefined);
  const pdfDocumentWrongCase = await rawWithHeaders("doc.pdf", { "sec-fetch-dest": "Document" });
  check("(8-control) .pdf with Sec-Fetch-Dest: Document (wrong case) → NO Content-Disposition",
    pdfDocumentWrongCase.headers["content-disposition"] === undefined);

  // (8) the hardening is PDF-specific: Sec-Fetch-Dest: document on an already-attachment'd active type
  // (svg) changes nothing — it was already forced regardless, and Vary is not added where the header
  // never varies the response.
  const svgDocument = await rawWithHeaders("evil.svg", { "sec-fetch-dest": "document" });
  check("(8) .svg with Sec-Fetch-Dest: document → still Content-Disposition: attachment (unaffected)",
    svgDocument.headers["content-disposition"] === "attachment");
  check("(8) .svg → NO Vary header (Sec-Fetch-Dest never changes an svg response)",
    svgDocument.headers["vary"] === undefined);
  check("(8) .png → NO Vary header either (the gate is pdf-only)",
    (await rawWithHeaders("pic.png", { "sec-fetch-dest": "document" })).headers["vary"] === undefined);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /vault/raw serves binaries byte-exact with the right Content-Type + nosniff, sandboxes every non-PDF response (CSP sandbox; default-src 'none', plus Content-Disposition: attachment for svg/html/xml), streams under a 50 MB cap (413 over), rejects ../ / absolute / symlink-escape with 404, and gates a PDF's Content-Disposition on Sec-Fetch-Dest: document (never for the <object> embed's Sec-Fetch-Dest: embed) with Vary: Sec-Fetch-Dest on that response only."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
