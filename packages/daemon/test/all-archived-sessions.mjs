// Cross-project Archive test (Task 526abd46). HERMETIC like session-archive.mjs: no daemon, no real
// claude — drives the built Db against a throwaway SQLite Db + an isolated LOOM_HOME. Covers the new
// db.listAllArchivedSessions() backing GET /api/archived-sessions:
//   A. spans ALL projects (per-project listArchivedSessions sees only its own; the all-variant merges).
//   B. returns ONLY archived rows (archived_at NOT NULL) — live/exited-but-not-archived are excluded.
//   C. newest-archived-FIRST globally (ORDER BY archived_at DESC), interleaving across projects.
//   D. each row is enriched with projectName + agentName (the cross-project grouping needs both).
//
// Follow-up (paginate the archived-sessions endpoints + add a by-id fetch first):
//   E. listArchivedSessionsPage/listAllArchivedSessionsPage return a bounded `rows` page + the TOTAL
//      count, honoring limit/offset, still newest-archived-first.
//   F. getArchivedSessionById resolves a single archived row cross-project (by id, not by project scope)
//      and is undefined for a non-archived/unknown id.
//   G. REST-level (buildServer + app.inject): GET /api/archived-sessions and GET /api/projects/:id/archive
//      return the PAGINATED `{items, total, limit}` shape (not the old bare array), honor ?limit=/?offset=,
//      and GET /api/archived-sessions/:id resolves a session that sits OFF the first page of the bounded
//      list (the constraint this whole card exists for — a by-id consumer must not depend on full-list
//      presence) plus 404s for an unknown/non-archived id.
//
// Code-review follow-up (2nd pass — the clamp must be REAL and OBSERVABLE, not just plausible):
//   E2. Seeds > MAX_ARCHIVED_PAGE (500) real rows and proves an oversized requested limit is actually
//       capped at 500 rows (not just "happens to return everything because the fixture is small") AND
//       that the EFFECTIVE (clamped) limit comes back in the response — the exact gap that let a client's
//       own "grow limit until done" loop dead-end forever while `total` kept claiming more rows existed.
//   G2. The same clamp, observed over REST (?limit= far past the cap still yields `items.length===500`
//       and `limit===500`).
//   H. The actual "Load more" reachability loop (Archive.tsx's useInfiniteQuery accumulation) driven over
//      REAL REST calls against the >500-row fixture — every row, including ones past the old dead-end,
//      comes back exactly once across multiple fetches.
//
// Follow-up (keep archived managers older than the newest 300 reachable in Run Replay, card 9f010283):
//   I. An optional `role=` filter on listAllArchivedSessionsPage/GET /api/archived-sessions scopes the
//      page BEFORE limit/offset apply. Reproduces the bug (an unfiltered same-size page excludes an old
//      archived manager once 300+ fresher non-manager rows exist) AND proves role=manager reaches it —
//      both at the db layer and over REST, the exact path MissionControl's Run Replay picker calls. Also
//      covers an unrecognized `role=` value being ignored (falls back to unfiltered) rather than erroring.
// Run: 1) build the daemon, 2) node test/all-archived-sessions.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-all-archive-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const Database = (await import("better-sqlite3")).default;
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
const now = new Date().toISOString();
const at = (ms) => new Date(Date.parse("2026-06-01T00:00:00.000Z") + ms).toISOString();
const mkSession = (id, projectId, agentId, over = {}) => ({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: "C:/tmp/loom-arch",
  processState: "exited", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, ...over,
});

try {
  const db = new Db(dbFile);
  // Two projects, each with one agent.
  db.insertProject({ id: "pA", name: "Alpha", repoPath: "C:/tmp/a", vaultPath: "C:/tmp/a", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Beta", repoPath: "C:/tmp/b", vaultPath: "C:/tmp/b", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aA", projectId: "pA", name: "agentAlpha", startupPrompt: "", position: 0 });
  db.insertAgent({ id: "aB", projectId: "pB", name: "agentBeta", startupPrompt: "", position: 0 });

  // Rows interleaved across projects, plus a non-archived row that must be excluded.
  db.insertSession(mkSession("a1", "pA", "aA", { role: "manager" }));
  db.insertSession(mkSession("b1", "pB", "aB", { role: "worker" }));
  db.insertSession(mkSession("a2", "pA", "aA", { role: "worker" }));
  db.insertSession(mkSession("live", "pA", "aA")); // stays archived_at NULL → excluded

  // insertSession doesn't write archived_at (it's set by the archive flow), so stamp controlled
  // instants directly to drive the cross-project DESC ordering — b1 newest, then a2, then a1.
  const raw = new Database(dbFile);
  const stamp = raw.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?");
  stamp.run(at(1000), "a1");
  stamp.run(at(3000), "b1");
  stamp.run(at(2000), "a2");
  raw.close();

  const all = db.listAllArchivedSessions();

  // A. spans all projects
  check("A: listAllArchivedSessions spans both projects (3 archived rows)", all.length === 3);
  check("A: includes rows from pA AND pB", all.some((s) => s.projectId === "pA") && all.some((s) => s.projectId === "pB"));
  // per-project variant still scopes to one project (sanity that we didn't break it)
  check("A: per-project listArchivedSessions(pA) sees only pA's 2", db.listArchivedSessions("pA").length === 2);

  // B. only archived rows
  check("B: the non-archived 'live' row is EXCLUDED", all.every((s) => s.id !== "live"));
  check("B: every returned row has archivedAt set", all.every((s) => !!s.archivedAt));

  // C. newest-archived first, globally interleaved across projects
  check("C: ordered archived_at DESC across projects (b1 → a2 → a1)",
    all.map((s) => s.id).join(",") === "b1,a2,a1");

  // D. enriched with project + agent names
  const b1 = all.find((s) => s.id === "b1");
  const a1 = all.find((s) => s.id === "a1");
  check("D: rows carry projectName", b1.projectName === "Beta" && a1.projectName === "Alpha");
  check("D: rows carry agentName", b1.agentName === "agentBeta" && a1.agentName === "agentAlpha");

  // ===================== E. Bounded pages (listArchivedSessionsPage / listAllArchivedSessionsPage) =====================
  // 5 more archived sessions in pA, stamped OLDER than a1/a2/b1 — newest-first page 1 (limit 3) is still
  // {b1, a2, a1}, and every "oldN" row is guaranteed to sit OFF that first page.
  for (let i = 1; i <= 5; i++) db.insertSession(mkSession(`old${i}`, "pA", "aA", { role: "worker" }));
  const raw2 = new Database(dbFile);
  const stamp2 = raw2.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?");
  for (let i = 1; i <= 5; i++) stamp2.run(at(-1000 * i), `old${i}`); // oldest last (old5 is the very oldest)
  raw2.close();

  const page1 = db.listAllArchivedSessionsPage(3, 0);
  check("E: page(limit 3) returns exactly 3 rows", page1.rows.length === 3);
  check("E: page(limit 3) total reflects the FULL archived set (8 rows)", page1.total === 8);
  check("E: page(limit 3) reports its effective limit back (3 — under the cap, unchanged)", page1.limit === 3);
  check("E: page(limit 3) keeps newest-archived-first (b1, a2, a1)", page1.rows.map((s) => s.id).join(",") === "b1,a2,a1");
  const page2 = db.listAllArchivedSessionsPage(3, 3);
  check("E: page(limit 3, offset 3) returns the NEXT 3 (old1, old2, old3)", page2.rows.map((s) => s.id).join(",") === "old1,old2,old3");
  const perProjPage = db.listArchivedSessionsPage("pA", 2, 0);
  check("E: per-project page total scopes to pA only (7 rows)", perProjPage.total === 7);
  check("E: per-project page(limit 2) returns 2 rows", perProjPage.rows.length === 2);
  check("E: per-project page reports its effective limit back (2)", perProjPage.limit === 2);

  // ===================== F. getArchivedSessionById =====================
  const foundOld = db.getArchivedSessionById("old5");
  check("F: getArchivedSessionById resolves an archived row NOT on a bounded first page", !!foundOld && foundOld.id === "old5");
  check("F: getArchivedSessionById enriches with project/agent names too", foundOld?.projectName === "Alpha" && foundOld?.agentName === "agentAlpha");
  check("F: getArchivedSessionById returns undefined for a never-existed id", db.getArchivedSessionById("nope-never") === undefined);
  check("F: getArchivedSessionById returns undefined for a LIVE (non-archived) row", db.getArchivedSessionById("live") === undefined);

  // ===================== G. REST-level: the paginated routes + the new by-id route =====================
  const stub = {};
  const app = await buildServer({
    db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const listRes = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=3" });
    const listBody = listRes.json();
    check("G: GET /api/archived-sessions returns the PAGINATED {items,total,limit} shape", Array.isArray(listBody.items) && typeof listBody.total === "number" && typeof listBody.limit === "number");
    check("G: GET /api/archived-sessions honors ?limit= (3 items)", listBody.items.length === 3);
    check("G: GET /api/archived-sessions total reflects the full set (8)", listBody.total === 8);
    check("G: GET /api/archived-sessions reports the effective limit back (3)", listBody.limit === 3);
    check("G: GET /api/archived-sessions items are snapshot-enriched (snapshotExists present)", "snapshotExists" in listBody.items[0]);
    check("G precondition: old5 is genuinely OFF this bounded first page", !listBody.items.some((s) => s.id === "old5"));

    const offsetRes = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=3&offset=3" });
    const offsetBody = offsetRes.json();
    check("G: ?offset= pages past the first 3 (old1, old2, old3)", offsetBody.items.map((s) => s.id).join(",") === "old1,old2,old3");

    const projRes = await app.inject({ method: "GET", url: "/api/projects/pA/archive?limit=2" });
    const projBody = projRes.json();
    check("G: GET /api/projects/:id/archive returns {items,total} too (total scoped to pA: 7)", Array.isArray(projBody.items) && projBody.total === 7);
    check("G: GET /api/projects/:id/archive honors ?limit=2", projBody.items.length === 2);

    // The by-id route is the point of this whole card: resolve a session that sits OFF the bounded first
    // page above, WITHOUT ever fetching the full list.
    const byIdRes = await app.inject({ method: "GET", url: "/api/archived-sessions/old5" });
    const byIdBody = byIdRes.json();
    check("G: GET /api/archived-sessions/:id resolves a session OFF the first page (200)", byIdRes.statusCode === 200 && byIdBody.id === "old5");
    check("G: GET /api/archived-sessions/:id is snapshot-enriched too", "snapshotExists" in byIdBody);

    const missingRes = await app.inject({ method: "GET", url: "/api/archived-sessions/does-not-exist" });
    check("G: GET /api/archived-sessions/:id 404s for an unknown id", missingRes.statusCode === 404);
    const liveIdRes = await app.inject({ method: "GET", url: "/api/archived-sessions/live" });
    check("G: GET /api/archived-sessions/:id 404s for a LIVE (non-archived) id", liveIdRes.statusCode === 404);

    // ===================== E2/G2. The clamp is REAL — seed PAST MAX_ARCHIVED_PAGE (500) rows =====================
    // A separate project + agent so this bulk seed can't perturb the ID-based ordering assertions above.
    // With only 8 rows total, "an oversized limit returns everything" would pass whether or not the clamp
    // exists at all — this is the actual regression check: it fails if MAX_ARCHIVED_PAGE is ever removed
    // or raised past what the route can safely serve.
    db.insertProject({ id: "pBulk", name: "Bulk", repoPath: "C:/tmp/bulk", vaultPath: "C:/tmp/bulk", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "aBulk", projectId: "pBulk", name: "agentBulk", startupPrompt: "", position: 0 });
    const BULK_COUNT = 505;
    for (let i = 0; i < BULK_COUNT; i++) db.insertSession(mkSession(`bulk${i}`, "pBulk", "aBulk", { role: "worker" }));
    const raw3 = new Database(dbFile);
    const stamp3 = raw3.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?");
    for (let i = 0; i < BULK_COUNT; i++) stamp3.run(at(-100_000 - i), `bulk${i}`); // older than every row above
    raw3.close();
    const grandTotal = 8 + BULK_COUNT; // the 8 rows from A-G above, plus this batch

    const clampedAll = db.listAllArchivedSessionsPage(999_999, 0);
    check("E2: an oversized cross-project limit is REALLY capped at MAX_ARCHIVED_PAGE (500 rows, not 999999)", clampedAll.rows.length === 500);
    check("E2: the clamp reports its EFFECTIVE limit back (500), not the requested 999999", clampedAll.limit === 500);
    check("E2: total still reflects the FULL set beyond the clamp", clampedAll.total === grandTotal);
    const clampedProj = db.listArchivedSessionsPage("pBulk", 999_999, 0);
    check("E2: the per-project page clamps identically (500 rows, limit 500, total scoped to pBulk)",
      clampedProj.rows.length === 500 && clampedProj.limit === 500 && clampedProj.total === BULK_COUNT);

    const clampedRes = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=999999" });
    const clampedBody = clampedRes.json();
    check("G2: REST GET /api/archived-sessions?limit=999999 is capped at 500 items, not 999999", clampedBody.items.length === 500);
    check("G2: REST reports the effective (clamped) limit back — a client can tell it was capped", clampedBody.limit === 500);
    check("G2: REST total still reflects the full set beyond the clamp", clampedBody.total === grandTotal);

    // ===================== H. Exercise the actual "Load more" reachability, not just one page =====================
    // This is the acceptance evidence Blocker 1 exists for: don't just assert the clamp exists in
    // isolation — drive the SAME accumulation loop Archive.tsx's useInfiniteQuery runs (getNextPageParam:
    // next offset = rows loaded so far, keep going while loaded < total) against the real >500-row
    // fixture above, over REAL REST calls, and prove every row — including ones that used to be
    // unreachable past the old grow-limit dead-end at the 500 cap — actually comes back exactly once.
    const seen = new Set();
    let offset = 0;
    let fetches = 0;
    let pageTotal = Infinity;
    while (seen.size < pageTotal && fetches < 20) { // 20 is a generous ceiling — real loop is ~6 fetches
      const res = await app.inject({ method: "GET", url: `/api/archived-sessions?limit=100&offset=${offset}` });
      const body = res.json();
      pageTotal = body.total;
      for (const s of body.items) seen.add(s.id);
      offset += body.items.length;
      fetches++;
      if (body.items.length === 0) break; // exhausted
    }
    check("H: repeated 'Load more' fetches eventually accumulate the FULL set (no dead-end at the 500 cap)",
      seen.size === grandTotal);
    check("H: the very oldest row (bulk504, well past the old 500-row dead-end) IS reachable",
      seen.has("bulk504"));
    check("H: no duplicates across pages (offset-accumulation didn't re-fetch/overlap)",
      seen.size === grandTotal); // Set dedupes by id — a size shortfall here would mean a gap OR overlap
    check("H: reachability took multiple fetches (proves this isn't trivially satisfied by one big page)",
      fetches > 1);

    // ===================== I. `role=` filter (card 9f010283) =====================
    // Reproduce the exact bug: an archived MANAGER older than the newest N archived sessions GLOBALLY
    // must still be reachable via a role-scoped page, even though the mixed (unfiltered) page of the
    // same size excludes it. 300 fresh WORKER rows, all stamped strictly newer than every other row in
    // this test (including the existing manager `a1`), plus one MANAGER (`oldMgr`) stamped older than
    // everything else in the whole fixture (older even than the `bulk*` rows).
    db.insertProject({ id: "pRole", name: "RoleFilter", repoPath: "C:/tmp/role", vaultPath: "C:/tmp/role", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "aRole", projectId: "pRole", name: "agentRole", startupPrompt: "", position: 0 });
    const NEW_WORKERS = 300;
    for (let i = 0; i < NEW_WORKERS; i++) db.insertSession(mkSession(`roleW${i}`, "pRole", "aRole", { role: "worker" }));
    db.insertSession(mkSession("oldMgr", "pRole", "aRole", { role: "manager" }));
    const raw4 = new Database(dbFile);
    const stamp4 = raw4.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?");
    for (let i = 0; i < NEW_WORKERS; i++) stamp4.run(at(100_000 + i), `roleW${i}`); // newer than every prior row
    stamp4.run(at(-50_000_000), "oldMgr"); // older than every prior row, incl. the bulk* rows
    raw4.close();

    // I1: the unfiltered page reproduces the bug — oldMgr falls off a same-size mixed page.
    const mixedPage = db.listAllArchivedSessionsPage(NEW_WORKERS, 0);
    check("I1: unfiltered page(300) is dominated by the 300 fresher workers, excluding oldMgr (the bug)",
      mixedPage.rows.length === NEW_WORKERS && !mixedPage.rows.some((s) => s.id === "oldMgr"));

    // I2: role="manager" spends the WHOLE page budget on managers only — oldMgr is reachable, ordered
    // newest-manager-first (a1 archived at ms 1000, oldMgr archived at ms -50,000,000).
    const mgrPage = db.listAllArchivedSessionsPage(300, 0, "manager");
    check("I2: role=manager page contains ONLY managers (2 total: a1, oldMgr)", mgrPage.rows.length === 2);
    check("I2: role=manager page's total is role-scoped too (2, not the full archived count)", mgrPage.total === 2);
    check("I2: role=manager page reaches oldMgr — the fix", mgrPage.rows.some((s) => s.id === "oldMgr"));
    check("I2: role=manager page stays newest-first among managers (a1, oldMgr)", mgrPage.rows.map((s) => s.id).join(",") === "a1,oldMgr");
    check("I2: role=manager rows never include a non-manager row", mgrPage.rows.every((s) => s.role === "manager"));

    // I3: same fix, over REST — the exact path MissionControl's Run Replay picker calls.
    const restMixed = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=300" });
    const restMixedBody = restMixed.json();
    check("I3: REST unfiltered ?limit=300 reproduces the bug (oldMgr absent)",
      !restMixedBody.items.some((s) => s.id === "oldMgr"));

    const restMgr = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=300&role=manager" });
    const restMgrBody = restMgr.json();
    check("I3: REST ?role=manager reaches oldMgr (the picker fix, end to end)",
      restMgrBody.items.some((s) => s.id === "oldMgr"));
    check("I3: REST ?role=manager returns only managers", restMgrBody.items.every((s) => s.role === "manager"));
    check("I3: REST ?role=manager total is role-scoped (2)", restMgrBody.total === 2);

    // I4: an unrecognized role value is ignored (falls back to unfiltered), not an error — this is a
    // best-effort god-eye read, not a validated write.
    const restBogus = await app.inject({ method: "GET", url: "/api/archived-sessions?limit=300&role=not-a-real-role" });
    check("I4: an unrecognized ?role= is ignored (200, behaves as unfiltered)",
      restBogus.statusCode === 200 && restBogus.json().items.length === NEW_WORKERS);
  } finally {
    await app.close();
  }

  db.close();
} finally {
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — listAllArchivedSessions spans all projects newest-first enriched with names; the new bounded-page db methods + REST routes ({items,total,limit}, ?limit=/?offset=) return the same shape; GET /api/archived-sessions/:id resolves a session sitting off the first page, 404ing for an unknown/non-archived id; a REAL >500-row seed proves the MAX_ARCHIVED_PAGE clamp actually caps rows while reporting its effective limit back; the actual Load-more accumulation loop reaches every row past the old 500-row dead-end, exactly once; and the new ?role= filter reproduces + fixes the archived-manager-falls-off-the-page bug (db layer + REST), ignoring an unrecognized role value rather than erroring."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
