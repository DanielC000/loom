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
// Run after build: node test/vault-raw.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vault-raw-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45331";
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
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// cleanup (retry for the WAL handle + any junction on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — /vault/raw serves binaries byte-exact with the right Content-Type + nosniff, streams under a 50 MB cap (413 over), and rejects ../ / absolute / symlink-escape with 404."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
