import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Releases v1 Part 1 — the daemon serves the PREBUILT web viewport (single-process mode). HERMETIC +
// CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject; a TEMP web-dist fixture, no real web
// build needed). Modeled on platform-home-rest.mjs. Proves the SPA static-serve contract:
//   (a) GET /                  → 200 + the fixture index.html (served at the root);
//   (b) GET /assets/<asset>    → 200 + the right content-type (a real built asset);
//   (c) GET /board (unknown    → 200 + index.html FALLBACK (client-side routing deep link);
//       client route)
//   (d) GET /api/<unknown>     → JSON 404, NOT index.html (the fallback must not swallow API 404s);
//   (e) NO dist present        → the daemon STILL boots and the API still responds (dist is optional).
// The dev vite-proxy flow (`pnpm web`, :5317) is untouched — this only ADDS a second way to reach the UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-web-static-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45319";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

// A minimal Vite-shaped build fixture: an index.html shell + a hashed asset under assets/.
const DIST = path.join(TMP, "web-dist");
fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
const INDEX_HTML = '<!doctype html><html><head><title>Loom</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>';
const ASSET_JS = 'export const hello="loom";console.log(hello);';
fs.writeFileSync(path.join(DIST, "index.html"), INDEX_HTML);
fs.writeFileSync(path.join(DIST, "assets", "index-abc123.js"), ASSET_JS);

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

// ===================== (a)–(d): a built web dist IS present → serve it + SPA fallback =====================
{
  process.env.LOOM_WEB_DIST = DIST; // single resolver reads this at buildServer time
  const db = new Db(path.join(TMP, "loom.db"));
  const app = await buildApp(db);
  try {
    // (a) root → the index.html shell
    const root = await app.inject({ method: "GET", url: "/" });
    check("(a) GET / → 200", root.statusCode === 200);
    check("(a) GET / body is the fixture index.html", root.body === INDEX_HTML);
    check("(a) GET / served as HTML", String(root.headers["content-type"] ?? "").includes("text/html"));

    // (b) a real built asset → right content-type + exact bytes
    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    check("(b) GET /assets/index-abc123.js → 200", asset.statusCode === 200);
    check("(b) asset content-type is javascript", String(asset.headers["content-type"] ?? "").includes("javascript"));
    check("(b) asset body is the exact bytes", asset.body === ASSET_JS);

    // (c) unknown CLIENT route → index.html fallback (client-side routing owns it)
    const board = await app.inject({ method: "GET", url: "/board" });
    check("(c) GET /board → 200 (SPA fallback)", board.statusCode === 200);
    check("(c) GET /board returns index.html", board.body === INDEX_HTML);
    // a nested deep link too (e.g. /projects/<id>/sessions) — still the shell
    const deep = await app.inject({ method: "GET", url: "/projects/abc/sessions" });
    check("(c) GET /projects/abc/sessions → index.html (deep link)", deep.statusCode === 200 && deep.body === INDEX_HTML);

    // (d) unknown /api/* → JSON 404, NEVER index.html (the fallback must not swallow API 404s)
    const apiMiss = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    check("(d) GET /api/does-not-exist → 404", apiMiss.statusCode === 404);
    check("(d) /api 404 is NOT the index.html", apiMiss.body !== INDEX_HTML);
    check("(d) /api 404 is JSON (not HTML)", String(apiMiss.headers["content-type"] ?? "").includes("application/json"));
    // a real registered API route still works alongside the static serve (no regression)
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    check("(d) GET /api/projects still 200 (registered route wins over static)", projects.statusCode === 200 && Array.isArray(projects.json()));
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}

// ===================== (e): NO dist present → daemon STILL boots + API responds =====================
{
  process.env.LOOM_WEB_DIST = path.join(TMP, "nonexistent-dist"); // resolver returns it; no index.html → skip static
  const db = new Db(path.join(TMP, "loom-nodist.db"));
  const app = await buildApp(db); // must NOT throw despite the missing dist
  try {
    check("(e) buildServer resolved despite missing dist", !!app);
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    check("(e) GET /api/projects → 200 (API up with no web dist)", projects.statusCode === 200 && Array.isArray(projects.json()));
    // with no static registered, the root is a plain 404 (default handler) — NOT a crash, NOT index.html
    const root = await app.inject({ method: "GET", url: "/" });
    check("(e) GET / → 404 (no static served, daemon still alive)", root.statusCode === 404);
    check("(e) GET / is not index.html", root.body !== INDEX_HTML);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    db.close();
  }
}
delete process.env.LOOM_WEB_DIST;

// cleanup (retry for the WAL handle on Windows)
for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — the daemon serves the prebuilt web viewport at / with an SPA fallback (deep links → index.html), serves built assets with the right content-type, keeps unknown /api/* as JSON 404s (never swallowed by the fallback), and still boots API/WS-only when no web dist is present."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
