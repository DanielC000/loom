import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 67c43038 — the reorder-only board-column route, PUT /api/projects/:id/columns/order. HERMETIC +
// CLAUDE-FREE + NETWORK-FREE: a throwaway Db, the REAL buildServer driven by app.inject, and the REAL
// SessionService.reorderBoardColumns (bound to that Db; it reads nothing else off the service).
//
// Proves:
//   (A) planColumnReorder (pure): an exact permutation reorders and carries every column field verbatim;
//       a missing key, an extra key and a duplicate key are each refused.
//   (B) the route: 200 reorders the stored board with every card left in place and every field kept;
//       409 on a missing key (the stale-poll case: a column created after the client loaded), an extra key
//       and a duplicate key, each leaving the stored board byte-identical; 400 on a bad body shape; 404 on
//       an unknown project.
//   (C) trust posture: Tier 0 (loopback-only, not on the remote allowlist) and loopback-bearer guarded
//       like every other non-GET /api write (no credential → 401, the loopback secret → 200).
//   (D) a reorder still moves a PRE-EXISTING orphan card (column_key naming no current column) to the
//       landing lane, via applyBoardColumnLayout's backstop sweep; cards on real columns never move.
// Run: 1) build (turbo builds shared first), 2) node test/column-reorder-route.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-col-order-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { planColumnReorder } = await import("../dist/tasks/columns.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");
const { resolveConfig } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();

// A board whose columns each carry a distinct optional field, so "carried verbatim" is checkable.
const BOARD = [
  { key: "inbox", label: "Inbox", role: "intake", accentColor: "#5bc8ff" },
  { key: "backlog", label: "Backlog", role: "defaultLanding" },
  { key: "doing", label: "Doing", role: "active", wipLimit: 3 },
  { key: "parked", label: "Parked", role: "parked", excludeFromIdleWatchdog: true },
  { key: "done", label: "Done", role: "terminal" },
];
const keysOf = (cols) => cols.map((c) => c.key).join(",");

let app, db;
try {
  // ================================ (A) the pure planner ================================
  const perm = planColumnReorder(BOARD, ["doing", "inbox", "backlog", "parked", "done"]);
  check("(A) an exact permutation is accepted", perm.ok === true);
  check("(A) …in the requested order", perm.ok && keysOf(perm.columns) === "doing,inbox,backlog,parked,done");
  check("(A) …with every column object carried verbatim (role/accent/wip/idle flag)",
    perm.ok && BOARD.every((c) => JSON.stringify(perm.columns.find((x) => x.key === c.key)) === JSON.stringify(c)));
  const pMissing = planColumnReorder(BOARD, ["inbox", "backlog", "doing", "done"]);
  check("(A) a MISSING key is refused, naming the omitted column by label", pMissing.ok === false && /'Parked'/.test(pMissing.error));
  const pExtra = planColumnReorder(BOARD, ["inbox", "backlog", "doing", "parked", "done", "ghost"]);
  check("(A) an EXTRA key is refused", pExtra.ok === false && /ghost/.test(pExtra.error));
  const pDup = planColumnReorder(BOARD, ["inbox", "inbox", "backlog", "doing", "parked", "done"]);
  check("(A) a DUPLICATE key is refused", pDup.ok === false && /more than once/.test(pDup.error));

  // ================================ (B) the route ================================
  db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: { kanbanColumns: BOARD }, createdAt: now, archivedAt: null });
  const mkTask = (id, columnKey) => db.insertTask({ id, projectId: "p1", title: id, body: "", columnKey, position: 1, createdAt: now, updatedAt: now });
  mkTask("t-inbox", "inbox"); mkTask("t-doing", "doing"); mkTask("t-parked", "parked"); mkTask("t-done", "done");
  const cardMap = () => JSON.stringify(db.listTasks("p1").map((t) => [t.id, t.columnKey]).sort());
  const cardsBefore = cardMap();
  const stored = () => resolveConfig(db.getProject("p1").config).kanbanColumns;

  const sessions = { reorderBoardColumns: SessionService.prototype.reorderBoardColumns.bind({ db }) };
  const stub = {};
  const SECRET = "loopback-secret-for-col-order-0123456789";
  app = await buildServer({
    db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, loopbackSecret: SECRET,
  });
  const H = { host: `127.0.0.1:${process.env.LOOM_PORT}`, origin: `http://127.0.0.1:${process.env.LOOM_PORT}`, "content-type": "application/json" };
  const AUTH = { ...H, authorization: `Bearer ${SECRET}` };
  const put = (projectId, payload, headers = AUTH) =>
    app.inject({ method: "PUT", url: `/api/projects/${projectId}/columns/order`, headers, payload });

  const ok = await put("p1", { keys: ["doing", "inbox", "backlog", "parked", "done"] });
  check("(B) a permutation → 200", ok.statusCode === 200);
  check("(B) the response carries the reordered columns", ok.statusCode === 200 && keysOf(JSON.parse(ok.body).columns) === "doing,inbox,backlog,parked,done");
  check("(B) the STORED board is reordered", keysOf(stored()) === "doing,inbox,backlog,parked,done");
  check("(B) every stored column kept all of its fields", BOARD.every((c) => JSON.stringify(stored().find((x) => x.key === c.key)) === JSON.stringify(c)));
  check("(B) no card moved", cardMap() === cardsBefore);

  // The stale-poll case: a client loaded the board, then a column was created server-side (an agent's
  // board_column_create appends one). The client's reorder omits it and must be refused, not applied.
  const loadedKeys = stored().map((c) => c.key);
  const withNew = [...stored(), { key: "qa", label: "QA" }];
  db.applyBoardColumnLayout("p1", withNew, [], "backlog");
  mkTask("t-qa", "qa");
  const boardAfterCreate = JSON.stringify(stored());
  const cardsAfterCreate = cardMap();
  const stale = await put("p1", { keys: [...loadedKeys].reverse() });
  check("(B) STALE reorder (omits a newer column) → 409", stale.statusCode === 409);
  check("(B) …the error names the omitted column", /'QA'/.test(JSON.parse(stale.body).error ?? ""));
  check("(B) …the newer column still exists, board untouched", JSON.stringify(stored()) === boardAfterCreate);
  check("(B) …its card is still on it (nothing re-homed)", db.getTask("t-qa").columnKey === "qa" && cardMap() === cardsAfterCreate);

  const current = stored().map((c) => c.key);
  const extra = await put("p1", { keys: [...current, "ghost"] });
  check("(B) an EXTRA key → 409, board untouched", extra.statusCode === 409 && JSON.stringify(stored()) === boardAfterCreate);
  const dup = await put("p1", { keys: [current[0], ...current] });
  check("(B) a DUPLICATE key → 409, board untouched", dup.statusCode === 409 && JSON.stringify(stored()) === boardAfterCreate);

  const shapes = [{}, { keys: [] }, { keys: "inbox" }, { keys: [""] }, { keys: current, extra: 1 }];
  const shapeCodes = [];
  for (const s of shapes) shapeCodes.push((await put("p1", s)).statusCode);
  check(`(B) a bad body shape → 400 (got ${shapeCodes.join(",")})`, shapeCodes.every((c) => c === 400));
  check("(B) …board untouched by every bad shape", JSON.stringify(stored()) === boardAfterCreate);
  const missingProject = await put("nope", { keys: current });
  check("(B) an unknown project → 404", missingProject.statusCode === 404);

  const fresh = await put("p1", { keys: [...current].reverse() });
  check("(B) CONTROL: a reorder from the FRESH key set (incl. the newer column) → 200", fresh.statusCode === 200 && keysOf(stored()) === [...current].reverse().join(","));
  check("(B) CONTROL: still no card moved", cardMap() === cardsAfterCreate);

  // ================================ (C) trust posture ================================
  check("(C) the route is Tier 0 (loopback-only; not on the remote Tier-1 allowlist)", routeTier("PUT", "/api/projects/:id/columns/order") === 0);
  check("(C) CONTROL: routeTier does classify a known Tier-1 route as 1", routeTier("GET", "/api/projects/:id/board") === 1);
  const noCred = await put("p1", { keys: current }, H);
  check("(C) no loopback credential → 401", noCred.statusCode === 401);
  check("(C) …and the 401 wrote nothing", keysOf(stored()) === [...current].reverse().join(","));

  // ================================ (D) the pre-existing-orphan sweep ================================
  // Card 4f6b9988: a reorder re-keys no card, but it persists through applyBoardColumnLayout, whose backstop
  // sweep moves a card that is ALREADY an orphan (its column_key names no current column) to the landing lane.
  mkTask("t-orphan", "ghost-column");
  const cardsBeforeSweep = db.listTasks("p1").filter((t) => t.id !== "t-orphan").map((t) => [t.id, t.columnKey]).sort();
  check("(D) setup: the orphan card sits on a key that names no column", db.getTask("t-orphan").columnKey === "ghost-column"
    && !stored().some((c) => c.key === "ghost-column"));
  const sweepOrder = [...stored().map((c) => c.key)].reverse();
  const sweep = await put("p1", { keys: sweepOrder });
  check("(D) a reorder with a pre-existing orphan on the board → 200", sweep.statusCode === 200 && keysOf(stored()) === sweepOrder.join(","));
  check("(D) …the orphan card is moved to the landing lane (backlog)", db.getTask("t-orphan").columnKey === "backlog");
  check("(D) …every card on a real column stayed put",
    JSON.stringify(db.listTasks("p1").filter((t) => t.id !== "t-orphan").map((t) => [t.id, t.columnKey]).sort()) === JSON.stringify(cardsBeforeSweep));
} finally {
  try { await app?.close(); } catch { /* best-effort */ }
  try { db?.close(); } catch { /* best-effort */ }
}
await finishAndExit(failures);
