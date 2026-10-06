import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// HEAD /api/projects/:id/vault/raw must answer with GET's headers and NO file read (card 3c783791,
// docs/decisions/3c783791-vault-raw-head-no-stream.md). Fastify 5.8.5 auto-exposes a HEAD sibling for
// every GET route whose onSend chain `resume()`s (drains) a stream payload before discarding it — so an
// unconditional `reply.send(fs.createReadStream(...))` reads the WHOLE file from disk on every HEAD
// request, up to VAULT_RAW_MAX_BYTES (50 MB), only to throw the bytes away. Since card f7525818 made
// this HEAD remote-reachable (Tier-1, token required), that was a token-gated but still free DoS lever.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: Db + buildServer via app.inject, modeled on vault-raw.mjs.
//   (1) HEAD opens NO read stream — a spy on fs.createReadStream, proven capable of firing (positive
//       control: the SAME spy DOES fire on GET of the same file);
//   (2) HEAD's response headers equal GET's, for several content types incl. the application/pdf
//       CSP carve-out (68bef69c) and the image/svg+xml sandboxed/attachment case;
//   (3) status parity between HEAD and GET on a missing file (404) and an oversized file (413).
// Run after build: node test/vault-raw-head.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-vault-raw-head-");
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

// --- spy on fs.createReadStream. Monkey-patching the `fs` default-export object is observed by every
// importer of "node:fs" (including the already-compiled dist/gateway/server.js), since ESM's default
// import of a CJS module binds the SAME underlying object — verified: a separate re-import sees the
// patched function too. ---
let streamOpens = 0;
const openedPaths = [];
const realCreateReadStream = fs.createReadStream;
fs.createReadStream = (...args) => {
  streamOpens++;
  openedPaths.push(args[0]);
  return realCreateReadStream(...args);
};

const vault = fs.realpathSync(fs.mkdirSync(path.join(TMP, "vault"), { recursive: true }) ?? path.join(TMP, "vault"));
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
fs.writeFileSync(path.join(vault, "pic.png"), PNG_BYTES);
const PDF_BYTES = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\n%%EOF\n", "latin1");
fs.writeFileSync(path.join(vault, "doc.pdf"), PDF_BYTES);
fs.writeFileSync(path.join(vault, "note.md"), "# inside\nhello vault\n");
const EVIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">`
  + `<script>document.title = "PWNED:" + JSON.stringify(localStorage);</script>`
  + `<rect width="40" height="40" fill="#0f0"/></svg>`;
fs.writeFileSync(path.join(vault, "evil.svg"), EVIL_SVG);

// A sparse file just over the 50 MB cap — truncate sets the size without writing 50 MB of data.
const CAP = 50 * 1024 * 1024;
const bigPath = path.join(vault, "huge.png");
fs.writeFileSync(bigPath, "");
fs.truncateSync(bigPath, CAP + 1);

const db = new Db(path.join(TMP, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "pVaultHead", name: "VaultedHead", repoPath: TMP, vaultPath: vault, config: {}, createdAt: now, archivedAt: null, reserved: false });

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const urlFor = (rel) => `/api/projects/pVaultHead/vault/raw?path=${encodeURIComponent(rel)}`;
const head = (rel, headers) => app.inject({ method: "HEAD", url: urlFor(rel), headers });
const get = (rel, headers) => app.inject({ method: "GET", url: urlFor(rel), headers });

// Headers to compare for parity — the ones the raw route actually sets. Fastify's injected response
// always carries a `date` on both sides; `connection`/`content-length` framing quirks aside, these are
// the ones the route itself is responsible for keeping identical.
const HEADER_KEYS = ["content-type", "content-length", "x-content-type-options", "content-security-policy", "content-disposition", "vary"];
const headersOf = (resp) => Object.fromEntries(HEADER_KEYS.map((k) => [k, resp.headers[k]]));

try {
  // --- (1) HEAD opens no read stream, across every content type, incl. the CSP-carve-out and the
  // sandboxed-svg case — proven against a spy shown capable of firing (positive control below) ---
  for (const rel of ["pic.png", "doc.pdf", "note.md", "evil.svg"]) {
    streamOpens = 0;
    openedPaths.length = 0;
    const h = await head(rel);
    check(`(1) HEAD ${rel} → 200`, h.statusCode === 200);
    check(`(1) HEAD ${rel} opened NO read stream (streamOpens=${streamOpens})`, streamOpens === 0);
    check(`(1) HEAD ${rel} body is empty`, h.rawPayload.length === 0);
  }

  // (1-control) the SAME spy DOES fire on a GET of the same file — proves the zero counts above are a
  // real absence, not a spy that silently never fires at all (the control-polarity rule: a broken
  // instrument also reports zero).
  streamOpens = 0;
  openedPaths.length = 0;
  const controlGet = await get("pic.png");
  check("(1-control) GET pic.png → 200", controlGet.statusCode === 200);
  check(`(1-control) GET pic.png DID open a read stream (streamOpens=${streamOpens}) — proves the spy can fire`, streamOpens === 1);
  check("(1-control) the opened path is the real fixture file", openedPaths[0] === path.join(vault, "pic.png"));

  // --- (2) HEAD's headers equal GET's, for several content types ---
  for (const rel of ["pic.png", "doc.pdf", "note.md", "evil.svg"]) {
    const h = await head(rel);
    const g = await get(rel);
    check(`(2) GET ${rel} → 200 (precondition for the header-parity check)`, g.statusCode === 200);
    const hh = headersOf(h);
    const gh = headersOf(g);
    check(`(2) HEAD ${rel} headers equal GET ${rel} headers (HEAD=${JSON.stringify(hh)}, GET=${JSON.stringify(gh)})`,
      JSON.stringify(hh) === JSON.stringify(gh));
  }
  // Pin the two polarities explicitly rather than only trusting the generic equality above:
  const headPdf = await head("doc.pdf");
  check("(2) HEAD doc.pdf → NO Content-Security-Policy (native-viewer carve-out, same as GET)",
    headPdf.headers["content-security-policy"] === undefined);
  check("(2) HEAD doc.pdf → NO Content-Disposition", headPdf.headers["content-disposition"] === undefined);
  const headSvg = await head("evil.svg");
  check("(2) HEAD evil.svg → Content-Security-Policy: sandbox; default-src 'none'",
    headSvg.headers["content-security-policy"] === "sandbox; default-src 'none'");
  check("(2) HEAD evil.svg → Content-Disposition: attachment", headSvg.headers["content-disposition"] === "attachment");
  check("(2) HEAD evil.svg → Content-Length matches the fixture size (same as GET, not 0)",
    String(headSvg.headers["content-length"]) === String(EVIL_SVG.length));

  // --- (2b) HEAD carries the PDF Sec-Fetch-Dest hardening (card f2c5eff2) identically to GET, since
  // both share the same resolveVaultRawHeaders path — a drift here would mean the two routes disagree
  // on whether a HEAD preflight for a top-level PDF navigation gets the same download signal GET would ---
  for (const dest of [undefined, "document", "embed", "iframe"]) {
    const h = await head("doc.pdf", dest ? { "sec-fetch-dest": dest } : undefined);
    const g = await get("doc.pdf", dest ? { "sec-fetch-dest": dest } : undefined);
    check(`(2b) HEAD doc.pdf Sec-Fetch-Dest:${dest ?? "(none)"} → Content-Disposition equals GET's (HEAD=${h.headers["content-disposition"]}, GET=${g.headers["content-disposition"]})`,
      h.headers["content-disposition"] === g.headers["content-disposition"]);
    check(`(2b) HEAD doc.pdf Sec-Fetch-Dest:${dest ?? "(none)"} → Vary equals GET's`,
      h.headers["vary"] === g.headers["vary"]);
  }
  check("(2b) HEAD doc.pdf with Sec-Fetch-Dest: document → Content-Disposition: attachment",
    (await head("doc.pdf", { "sec-fetch-dest": "document" })).headers["content-disposition"] === "attachment");
  check("(2b) HEAD doc.pdf with Sec-Fetch-Dest: embed (the <object> embed's own shape) → NO Content-Disposition",
    (await head("doc.pdf", { "sec-fetch-dest": "embed" })).headers["content-disposition"] === undefined);

  // --- (3) status parity on error paths ---
  streamOpens = 0;
  const missHead = await head("does-not-exist.png");
  const missGet = await get("does-not-exist.png");
  check(`(3) missing file: HEAD status (${missHead.statusCode}) equals GET status (${missGet.statusCode})`,
    missHead.statusCode === missGet.statusCode && missHead.statusCode === 404);
  check("(3) missing-file HEAD opened no read stream either", streamOpens === 0);

  const bigHead = await head("huge.png");
  const bigGet = await get("huge.png");
  check(`(3) oversized file: HEAD status (${bigHead.statusCode}) equals GET status (${bigGet.statusCode})`,
    bigHead.statusCode === bigGet.statusCode && bigHead.statusCode === 413);
  check("(3) oversized-file HEAD opened no read stream (never streamed, and GET's own 413 refusal also never streams it)",
    streamOpens === 0);
} finally {
  fs.createReadStream = realCreateReadStream;
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — HEAD /api/projects/:id/vault/raw never opens a read stream, its headers match GET's exactly (incl. the pdf CSP carve-out and the sandboxed-svg case), and it agrees with GET on 404/413 status."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
