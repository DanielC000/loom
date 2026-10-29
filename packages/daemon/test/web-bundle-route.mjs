import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e98bf784 — `GET /api/web-bundle`, the cheap single-field read an open tab uses to notice it is
// running a superseded bundle. HERMETIC + CLAUDE-FREE: a REAL Db + a REAL Fastify server via
// `buildServer` (partial stubs, same shape as trust-tier.mjs), driven through `app.inject()` — no listen,
// no port, no daemon boot.
//
// Proves:
//   (1) with LOOM_WEB_DIST pointed at a staged dist holding assets/index-<hash>.js, the route returns
//       EXACTLY {webBundle: "<that filename>"} — the key set is pinned, so an unlisted field addition
//       fails here rather than silently widening a Tier-1 remote-readable surface;
//   (2) THE SAME-SOURCE GUARANTEE: the route and `GET /api/deploy-status` (the `served_status` twin, per
//       card f26339d7) report the SAME webBundle for the same build — compared across two REAL injected
//       HTTP responses, not two calls to one helper;
//   (3) ...and that (2) is not vacuous: restaging the dist under a DIFFERENT hash moves BOTH surfaces
//       together, which is what actually forbids caching either one (card e98bf784). A frozen or
//       cached reader passes (2) trivially and fails here — this is the check with teeth;
//   (4) with no web dist found (LOOM_WEB_DIST at an empty dir), webBundle is null — never a throw, never
//       a 500, mirroring served-status.mjs's own (3).
//
// Run: 1) build (turbo builds shared first), 2) node test/web-bundle-route.mjs
import fs from "node:fs";
import path from "node:path";

import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

// LOOM_HOME must be in force BEFORE the first ../dist import (paths.ts freezes its consts at import).
const TMP_HOME = useOwnLoomHome("loom-webbundle-", { fresh: true });
requireHermeticEnv();

// Stage a fake web dist before importing dist/ as well — resolveWebDistDir() reads LOOM_WEB_DIST at CALL
// time, but set it up front for clarity (same discipline as served-status.mjs).
const fakeDist = path.join(TMP_HOME, "web-dist");
const assetsDir = path.join(fakeDist, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
/** A built index.html, shaped as vite emits one (attributes in vite's own order). */
const indexHtmlNaming = (bundle) =>
  '<!doctype html><html><head><meta charset="utf-8" />'
  + `<script type="module" crossorigin src="/assets/${bundle}"></script>`
  + '<link rel="stylesheet" crossorigin href="/assets/index-STYLE.css"></head>'
  + '<body><div id="root"></div></body></html>';

fs.writeFileSync(path.join(fakeDist, "index.html"), indexHtmlNaming("index-AAAA1111.js"));
fs.writeFileSync(path.join(assetsDir, "index-AAAA1111.js"), "/* fake bundle */");
fs.writeFileSync(path.join(assetsDir, "index-AAAA1111.css"), "/* fake styles — must NOT be picked */");
process.env.LOOM_WEB_DIST = fakeDist;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db(path.join(mkdtempManaged("loom-webbundle-db-"), "loom.db"));
const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});

/** The route's parsed body, via a REAL injected request (no listen, no port). */
async function getWebBundle() {
  const res = await app.inject({ method: "GET", url: "/api/web-bundle" });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

try {
  // ===================== (1) shape + exact value, key set pinned =====================
  const first = await getWebBundle();
  check("(1) GET /api/web-bundle answers 200", first.status === 200);
  check(`(1) returns the staged bundle filename (got ${JSON.stringify(first.body.webBundle)})`,
    first.body.webBundle === "index-AAAA1111.js");
  check(`(1) the response carries EXACTLY the key {webBundle} and nothing else (got ${JSON.stringify(Object.keys(first.body))})`,
    Object.keys(first.body).length === 1 && Object.keys(first.body)[0] === "webBundle");

  // ===================== (2) same-source agreement with the served_status twin =====================
  const deployRes = await app.inject({ method: "GET", url: "/api/deploy-status" });
  const deployBody = JSON.parse(deployRes.body);
  check("(2) GET /api/deploy-status answers 200", deployRes.statusCode === 200);
  check(`(2) the cheap route and served_status's own surface agree on webBundle for the same build ` +
    `(${JSON.stringify(first.body.webBundle)} vs ${JSON.stringify(deployBody.webBundle)})`,
    first.body.webBundle === deployBody.webBundle && typeof first.body.webBundle === "string");

  // ===================== (3) the agreement is LIVE, not two frozen constants =====================
  // Restage under a different hash — exactly what a real rebuild does. If either surface cached, it
  // keeps reporting the old filename and this fails. (2) alone cannot distinguish that case.
  fs.rmSync(path.join(assetsDir, "index-AAAA1111.js"));
  fs.writeFileSync(path.join(assetsDir, "index-BBBB2222.js"), "/* rebuilt bundle */");
  fs.writeFileSync(path.join(fakeDist, "index.html"), indexHtmlNaming("index-BBBB2222.js"));
  const afterRebuild = await getWebBundle();
  const deployAfter = JSON.parse((await app.inject({ method: "GET", url: "/api/deploy-status" })).body);
  check(`(3) a rebuild MOVES the cheap route's answer — it is never cached (got ${JSON.stringify(afterRebuild.body.webBundle)})`,
    afterRebuild.body.webBundle === "index-BBBB2222.js");
  check("(3) ...and the served_status surface moves with it, so the two stay in agreement across a rebuild",
    deployAfter.webBundle === afterRebuild.body.webBundle);
  check("(3-control) the post-rebuild value genuinely DIFFERS from the pre-rebuild one, so the checks above are not vacuous",
    afterRebuild.body.webBundle !== first.body.webBundle);

  // ===================== (5) TWO index-*.js present → the one index.html REFERENCES =====================
  // A readdir's first /^index-.*\.js$/ match is not necessarily the entry a browser runs. Two can
  // coexist (card 61fa0950: a turbo cache restore skipping vite's emptyOutDir; or a future code-split
  // chunk whose source is named index.*). The stale one is named to sort FIRST, so a readdir-order
  // implementation picks it and this leg reds — picking wrong pins every tab to a notice Reload can
  // never clear, because the hash it compares against is not the one it will load.
  fs.rmSync(path.join(assetsDir, "index-BBBB2222.js")); // leave ONLY the two this leg is about
  fs.writeFileSync(path.join(assetsDir, "index-AAAAAAAA.js"), "/* STALE orphan, sorts first */");
  fs.writeFileSync(path.join(assetsDir, "index-ZZZZZZZZ.js"), "/* the real entry */");
  fs.writeFileSync(path.join(fakeDist, "index.html"),
    '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-ZZZZZZZZ.js"></script>'
    + '<link rel="stylesheet" href="/assets/index-ZZZZZZZZ.css"></head><body><div id="root"></div></body></html>');
  const twoEntries = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f)).sort();
  check(`(5-sanity) both bundles really are staged, with the STALE one sorting first (${JSON.stringify(twoEntries)})`,
    twoEntries.length === 2 && twoEntries[0] === "index-AAAAAAAA.js");
  const picked = await getWebBundle();
  const deployPicked = JSON.parse((await app.inject({ method: "GET", url: "/api/deploy-status" })).body);
  check(`(5) the cheap route reports the bundle index.html REFERENCES, not the first on disk (got ${JSON.stringify(picked.body.webBundle)})`,
    picked.body.webBundle === "index-ZZZZZZZZ.js");
  check(`(5) ...and so does the served_status surface (got ${JSON.stringify(deployPicked.webBundle)})`,
    deployPicked.webBundle === "index-ZZZZZZZZ.js");

  // ===================== (6) index.html missing mid-rebuild → null, not a stale guess =====================
  // vite writes index.html last, so a read landing mid-rebuild sees assets but no index.html. That is
  // "unknown", and unknown must never surface as a reload prompt.
  fs.rmSync(path.join(fakeDist, "index.html"));
  const midRebuild = await getWebBundle();
  check(`(6) a dist with assets but NO index.html reports null, never a guess from the assets dir (got ${JSON.stringify(midRebuild.body.webBundle)})`,
    midRebuild.body.webBundle === null);
  check("(6) ...and still answers 200 rather than throwing", midRebuild.status === 200);

  // ===================== (4) no dist found → null, never a throw/500 =====================
  const emptyDist = mkdtempManaged("loom-webbundle-empty-");
  process.env.LOOM_WEB_DIST = emptyDist;
  const none = await getWebBundle();
  check("(4) an unbuilt/missing web dist answers 200 (degrades, never 500s)", none.status === 200);
  check(`(4) ...and reports webBundle: null (got ${JSON.stringify(none.body.webBundle)})`,
    none.body.webBundle === null);
} finally {
  await app.close();
  db.close?.();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await finishAndExit(failures === 0 ? 0 : 1);
