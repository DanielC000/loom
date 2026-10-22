import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The CSRF / DNS-rebind backstop — a single Fastify onRequest hook on the whole gateway instance. The
// daemon binds 127.0.0.1 only, but a loopback bind ALONE lets (a) any cross-origin page the user visits
// fire no-cors side-effect POSTs and (b) a DNS-rebinding page reach the host-RCE POST /api/terminals. The
// hook refuses a PRESENT non-loopback Origin and any non-loopback Host (403), while an ABSENT Origin is the
// fail-safe ALLOW path (CLI / Run-API-key / server-to-server send none).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject). Proves:
//   1. cross-origin Origin → 403 (and the side-effect handler is NOT reached);
//   2. loopback Origin — BOTH http://127.0.0.1:PORT and http://localhost:PORT — → allowed;
//   3. ABSENT Origin → allowed;
//   4. a non-allowlisted Host → 403 (the DNS-rebind control), incl. with the bound port present;
//   5. a Run-API-key-shaped client (no Origin, loopback Host, an Authorization header) still succeeds;
//   6. uniform coverage — the hook guards a real side-effect POST route, not just reads;
//   7. (card b49e7983) the Sec-Fetch-Site backstop for the Origin-absent fail-safe: a cross-site, no-Origin
//      /api/* request is refused — including by matched route PATTERN, not raw path — while same-site/
//      same-origin/none/absent/malformed values, every non-/api/* route, and the real Chromium
//      Origin:"null" shape (caught by the pre-existing Origin check) stay unaffected; and a real
//      GET /api/tasks/:id ship-state backfill write is proven to happen when allowed and NOT happen
//      (row genuinely unchanged) when refused.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TMP = mkdtempManaged("loom-csrf-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45337";
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { taskKey, mergeBranch, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");

// Case (f) hermeticity (card b49e7983 DoD item 2): resolveWebDistDir() is ambient (it checks whatever
// packages/web/dist happens to hold on THIS host) — point LOOM_WEB_DIST at a real temp dir carrying a
// real index.html, BEFORE buildServer runs (it reads this env var once, at call time), so the SPA-fallback
// assertion below never depends on whether a web build has actually happened on this host.
const webDistDir = path.join(TMP, "webdist");
fs.mkdirSync(webDistDir, { recursive: true });
fs.writeFileSync(path.join(webDistDir, "index.html"), "<!doctype html><title>test shell</title>");
process.env.LOOM_WEB_DIST = webDistDir;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Spy `killAllWorkers` so we can prove a CROSS-ORIGIN side-effect POST never reaches the handler (the hook
// short-circuits it) while a loopback one does.
let killCalls = 0;
const stub = {};
const sessions = { killAllWorkers: () => { killCalls++; return 7; } };
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({
  db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {},
});

// A dependency-free, idempotent read route to exercise the Origin/Host matrix without side effects.
const READ = "/api/version";
const get = (headers) => app.inject({ method: "GET", url: READ, headers });

try {
  // (1) cross-origin Origin → 403, on a READ route too (the hook is uniform, not POST-only).
  const ext = await get({ origin: "https://evil.example.com" });
  check("(1) cross-origin Origin (https://evil.example.com) → 403", ext.statusCode === 403);

  // (2) loopback Origin — both forms, with a matching bound-port loopback Host → allowed (200).
  const o1 = await get({ origin: `http://127.0.0.1:${PORT}`, host: `127.0.0.1:${PORT}` });
  check("(2a) loopback Origin http://127.0.0.1:PORT → allowed (200)", o1.statusCode === 200);
  const o2 = await get({ origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` });
  check("(2b) loopback Origin http://localhost:PORT → allowed (200)", o2.statusCode === 200);
  // Dev-proxy reality: the UI runs on a DIFFERENT loopback port (:5317) and forwards here; the browser's
  // Origin stays the UI's, so a loopback origin on another port must also pass.
  const oDev = await get({ origin: "http://localhost:5317", host: `127.0.0.1:${PORT}` });
  check("(2c) dev-proxy loopback Origin http://localhost:5317 → allowed (200)", oDev.statusCode === 200);

  // (3) ABSENT Origin → allowed (fail-safe). inject's default Host is `localhost:80` (loopback) and no Origin.
  const noOrigin = await get({});
  check("(3) ABSENT Origin → allowed (200)", noOrigin.statusCode === 200);

  // (4) non-allowlisted Host → 403, incl. when it carries the bound port (rebind sends the attacker host).
  const badHost = await get({ host: "attacker.example.com" });
  check("(4a) non-loopback Host (attacker.example.com) → 403", badHost.statusCode === 403);
  const badHostPort = await get({ host: `attacker.example.com:${PORT}` });
  check("(4b) non-loopback Host WITH the bound port → 403", badHostPort.statusCode === 403);

  // (5) a Run-API-key-shaped client: no Origin, loopback Host, an Authorization header → still succeeds.
  const runClient = await get({ host: `127.0.0.1:${PORT}`, authorization: "Bearer lk_test_key" });
  check("(5) Run-API-key client (no Origin, loopback Host) → allowed (200)", runClient.statusCode === 200);

  // (6a) a CROSS-ORIGIN side-effect POST is refused BEFORE the handler — killAllWorkers is never called.
  const killCross = await app.inject({
    method: "POST", url: "/api/orchestration/kill", headers: { origin: "https://evil.example.com" },
  });
  check("(6a) cross-origin POST /api/orchestration/kill → 403", killCross.statusCode === 403);
  check("(6a) the side-effect (killAllWorkers) was NOT reached", killCalls === 0);

  // (6b) the SAME POST from a loopback origin runs the handler — proving the hook isn't simply blocking all POSTs.
  const killOk = await app.inject({
    method: "POST", url: "/api/orchestration/kill",
    headers: { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` },
  });
  check("(6b) loopback-origin POST /api/orchestration/kill → 200", killOk.statusCode === 200);
  check("(6b) the handler ran (killAllWorkers called once)", killCalls === 1);

  // --- @decision b49e7983 — the Sec-Fetch-Site backstop for the Origin-absent fail-safe. All of these
  //     requests omit Origin (the case this backstop exists to cover) and keep inject's default loopback
  //     Host, so only the new Sec-Fetch-Site check is under test here. ---

  // (a) absent Origin + Sec-Fetch-Site: cross-site, on /api/* → refused (the proven gap: a no-cors GET or
  //     an opaque-origin sandboxed document's request looks exactly like this).
  const crossSiteNoOrigin = await get({ "sec-fetch-site": "cross-site" });
  check("(a) absent Origin + Sec-Fetch-Site:cross-site on /api/* → 403", crossSiteNoOrigin.statusCode === 403);

  // (b) Sec-Fetch-Site: same-site stays ALLOWED — this file already trusts any loopback port equally.
  const sameSite = await get({ "sec-fetch-site": "same-site" });
  check("(b) absent Origin + Sec-Fetch-Site:same-site on /api/* → allowed (200)", sameSite.statusCode === 200);

  // (c) Sec-Fetch-Site: same-origin — the ordinary case (the web UI's own relative fetches, incl. via the
  //     dev proxy, which never produces anything but same-origin from the browser's own point of view).
  const sameOrigin = await get({ "sec-fetch-site": "same-origin" });
  check("(c) absent Origin + Sec-Fetch-Site:same-origin on /api/* → allowed (200)", sameOrigin.statusCode === 200);

  // (d) Sec-Fetch-Site: none — a top-level navigation with no referring document (a typed URL/bookmark).
  const noneSite = await get({ "sec-fetch-site": "none" });
  check("(d) absent Origin + Sec-Fetch-Site:none on /api/* → allowed (200)", noneSite.statusCode === 200);

  // (e) no Sec-Fetch-Site header at all — the CLI / Run-API-key case this backstop must not touch.
  const noHeaderAtAll = await get({});
  check("(e) absent Origin + no Sec-Fetch-Site header on /api/* → allowed (200)", noHeaderAtAll.statusCode === 200);

  // Malformed/unrecognised value → treated like absent → ALLOWED (the fail-safe direction is explicit,
  // never a guess at what the browser "probably meant").
  const malformedSite = await get({ "sec-fetch-site": "Cross-Site" }); // wrong case — not an exact match
  check("malformed Sec-Fetch-Site value (wrong case) on /api/* → allowed (200)", malformedSite.statusCode === 200);
  const bogusSite = await get({ "sec-fetch-site": "bogus" });
  check("malformed Sec-Fetch-Site value (not a spec value) on /api/* → allowed (200)", bogusSite.statusCode === 200);

  // (f) the identical cross-site + absent-Origin shape on a route OUTSIDE /api/* → unaffected — proves the
  //     check is scoped to /api/* and doesn't overreach. An unmatched path falls through to the SPA
  //     fallback (@fastify/static's `/*` catch-all, isStaticShellRoute) and gets served normally (200).
  //     Hermetic (see LOOM_WEB_DIST setup above, before buildServer): a real temp dir with an index.html,
  //     so this doesn't depend on whether packages/web has actually been built on this host.
  const outsideApi = await app.inject({
    method: "GET", url: "/definitely-not-an-api-route", headers: { "sec-fetch-site": "cross-site" },
  });
  check("(f) cross-site + absent Origin OUTSIDE /api/* (SPA fallback) → unaffected (200, not 403)", outsideApi.statusCode === 200);

  // (f2)/(f3) pattern-vs-raw-path keying: (f) above can't prove this on its own — a plain non-/api path
  //     never resolves to an /api/* pattern at all. A percent-encoded /api/* path does: find-my-way
  //     decodes it and still matches the "/api/version" PATTERN even though the raw request text isn't
  //     "/api/...", so the hook must key off req.routeOptions.url (the matched pattern), never req.url.
  const encodedPrefix = await app.inject({
    method: "GET", url: "/%61pi/version", headers: { "sec-fetch-site": "cross-site" },
  });
  check("(f2) cross-site + absent Origin on /%61pi/version (decodes to /api/version) → 403", encodedPrefix.statusCode === 403);
  const encodedSuffix = await app.inject({
    method: "GET", url: "/api/%76ersion", headers: { "sec-fetch-site": "cross-site" },
  });
  check("(f3) cross-site + absent Origin on /api/%76ersion (decodes to /api/version) → 403", encodedSuffix.statusCode === 403);

  // (g) real repro of the found side-effect route (card b49e7983 DoD item 1): GET /api/tasks/:id lazily
  //     backfills ship-state via a DB write (setTaskMergedInfoNoTouch) on a cache miss. Prove the write
  //     actually happens for an ordinary (same-origin/no-header) request, then prove the cross-site,
  //     no-Origin shape is refused AND the row is left genuinely unchanged — the write never runs because
  //     the onRequest hook refuses before the handler, not merely that the HTTP status is non-200.
  const repoG = path.join(TMP, "repo-g");
  fs.mkdirSync(repoG, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoG });
  fs.writeFileSync(path.join(repoG, "README.md"), "# repo-g\n");
  commitAll(repoG, "init", "-c user.email=g@loom -c user.name=g");
  const nowG = new Date().toISOString();
  db.insertProject({ id: "pG", name: "Project G", repoPath: repoG, vaultPath: repoG, config: {}, createdAt: nowG, archivedAt: null });

  // Seeds a DONE task whose branch carries a REAL squash-merge on repoG's HEAD (a genuine
  // Loom-Worker-Branch trailer commit, via the real mergeBranch) but whose own row still has no cached
  // mergedSha — the exact state that makes GET /api/tasks/:id call setTaskMergedInfoNoTouch on a cache
  // miss (@decision 1eebc46a).
  async function seedMergedTask(id, title) {
    db.insertTask({ id, projectId: "pG", title, body: "", columnKey: "done", position: 1, priority: "p2", repoKey: null, createdAt: nowG, updatedAt: nowG });
    const branch = `loom/${taskKey(id)}`;
    const wt = path.join(TMP, `wt-${taskKey(id)}`);
    execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repoG });
    fs.writeFileSync(path.join(wt, `${taskKey(id)}.txt`), "work\n");
    commitAll(wt, `${branch} work`, "-c user.email=g@loom -c user.name=g");
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repoG });
    const merged = await mergeBranch(repoG, branch, title);
    if (!merged.ok) throw new Error(`seedMergedTask: mergeBranch failed for ${id}: ${merged.reason ?? "unknown"}`);
  }

  const taskWriteAllowed = "a0000000-0000-4000-8000-00000000000a";
  const taskWriteBlocked = "b0000000-0000-4000-8000-00000000000b";
  await seedMergedTask(taskWriteAllowed, "feat(g): write-allowed specimen");
  await seedMergedTask(taskWriteBlocked, "feat(g): write-blocked specimen");

  // (g1)/(g2): a plain same-origin/no-header request → allowed, AND the write actually happens.
  __resetMergedCommitMapCacheForTest();
  check("(g1) precondition: taskWriteAllowed has no cached mergedSha before the request", db.getTask(taskWriteAllowed).mergedSha == null);
  const tasksGetAllowed = await app.inject({ method: "GET", url: `/api/tasks/${taskWriteAllowed}` });
  check("(g2) same-origin/no-header GET /api/tasks/:id → 200", tasksGetAllowed.statusCode === 200);
  check("(g2) the DB write actually happened — mergedSha is now stamped", db.getTask(taskWriteAllowed).mergedSha != null);

  // (g3)/(g4): the cross-site, no-Origin shape is refused AND the row is left genuinely unchanged.
  __resetMergedCommitMapCacheForTest();
  check("(g3) precondition: taskWriteBlocked has no cached mergedSha before the request", db.getTask(taskWriteBlocked).mergedSha == null);
  const tasksGetBlocked = await app.inject({
    method: "GET", url: `/api/tasks/${taskWriteBlocked}`, headers: { "sec-fetch-site": "cross-site" },
  });
  check("(g4) cross-site + absent Origin GET /api/tasks/:id → 403", tasksGetBlocked.statusCode === 403);
  check("(g4) the DB write did NOT happen — mergedSha is still unset (the handler was never reached)", db.getTask(taskWriteBlocked).mergedSha == null);

  // (h) method-agnostic: a cross-site no-cors POST with no Origin to an /api/* route is ALSO refused (some
  //     browsers' simple-content-type cross-site POST/redirect paths omit Origin too) — and, same as (6a),
  //     the side-effect handler itself is never reached.
  const postCrossSite = await app.inject({
    method: "POST", url: "/api/orchestration/kill", headers: { "sec-fetch-site": "cross-site" },
  });
  check("(h) cross-site + absent Origin POST /api/orchestration/kill → 403", postCrossSite.statusCode === 403);
  check("(h) the side-effect (killAllWorkers) was NOT reached", killCalls === 1); // still 1 from (6b), not 2

  // (i)/(j) the REAL shape a sandboxed Chromium no-cors request sends (measured 2026-10-22 via a real
  //     headless Chromium against a bare node:http server, project memory
  //     b49e7983-sec-fetch-headers-measured): a sandboxed no-cors POST/GET sends `Origin: "null"`
  //     (present, the literal string) rather than an absent Origin. This is caught by the PRE-EXISTING
  //     Origin check above (a "null" origin fails to parse → not an allowed origin → 403) before the
  //     Sec-Fetch-Site backstop is ever reached — assert the outcome holds regardless of which check does it.
  const nullOriginPost = await app.inject({
    method: "POST", url: "/api/orchestration/kill",
    headers: { origin: "null", "sec-fetch-site": "cross-site" },
  });
  check("(i) Origin:null + Sec-Fetch-Site:cross-site POST /api/orchestration/kill → 403", nullOriginPost.statusCode === 403);
  check("(i) the side-effect (killAllWorkers) was NOT reached", killCalls === 1); // still 1 from (6b), not 2
  const nullOriginGet = await get({ origin: "null" });
  check("(j) Origin:null GET /api/version → 403", nullOriginGet.statusCode === 403);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the onRequest hook refuses cross-origin Origins + non-loopback Hosts (403), allows loopback origins (incl. the dev cross-port proxy) and absent-Origin clients, short-circuits cross-origin side-effect POSTs before the handler, and (card b49e7983) refuses an absent-Origin Sec-Fetch-Site:cross-site request on /api/* (any method, keyed off the matched route PATTERN not the raw path) while leaving same-site/same-origin/none/absent/malformed values, every non-/api/* route, and the real Chromium Origin:\"null\" shape untouched — and a real GET /api/tasks/:id ship-state backfill write is proven to actually happen when allowed and NOT happen (row genuinely unchanged) when refused."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
