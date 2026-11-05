import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d5946e05 — a STALE whole-array PUT /api/projects/:id/columns must not delete a column created (or
// re-keyed) since the editor loaded. HERMETIC + CLAUDE-FREE + NETWORK-FREE: a throwaway Db, the REAL
// buildServer driven by app.inject, and the REAL SessionService.updateBoardColumns bound to that Db.
//
// The incident shape: the human opens Settings › Board Columns, an agent creates a column (board_column_create
// → the same updateBoardColumns / applyBoardColumnLayout writer) and cards land on it, then the human Saves
// the stale array. Without `baseKeys` the planner reads every current key absent from the request as
// REMOVED and re-homes its cards (section (A) pins that legacy behaviour so it cannot change silently).
//
// Proves:
//   (A) no baseKeys → today's blind replace (back-compat): the newer column IS deleted, its card re-homed.
//   (B) baseKeys + an ADDED column → 409 {code:"columns_drifted", columns, added, removed}, stored board and
//       every card byte-identical.
//   (C) baseKeys + a REMOVED column (an agent deleted a lane the editor still lists) → 409, nothing written.
//   (D) baseKeys + a RE-KEYED column the human's own staged edit also deletes → 409, no card re-homed.
//   (E) clean save (baseKeys == current key set, in any order) → 200 and applied; a deliberate removal in a
//       clean save still re-homes its cards (the fix does not neuter the legitimate path).
//   (F) the retry shape: re-sending with baseKeys taken from the 409 body's `columns` → 200.
//   (G) an explicit `baseKeys: []` counts as PRESENT (409 on a real board); bad baseKeys shapes → 400.
// Run: 1) build (turbo builds shared first), 2) node test/column-stale-save.mjs
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-col-stale-");
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
const { resolveConfig } = await import("@loom/shared");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const BOARD = [
  { key: "backlog", label: "Backlog", role: "defaultLanding" },
  { key: "doing", label: "Doing", role: "active", wipLimit: 3 },
  { key: "done", label: "Done", role: "terminal" },
];
const keysOf = (cols) => cols.map((c) => c.key).join(",");

let app, db;
try {
  db = new Db(path.join(TMP, "loom.db"));
  const stored = (pid) => resolveConfig(db.getProject(pid).config).kanbanColumns;
  const cardMap = (pid) => JSON.stringify(db.listTasks(pid).map((t) => [t.id, t.columnKey]).sort());
  const mkProject = (id) => db.insertProject({ id, name: id, repoPath: TMP, vaultPath: TMP, config: { kanbanColumns: BOARD }, createdAt: now, archivedAt: null });
  const mkTask = (pid, id, columnKey) => db.insertTask({ id, projectId: pid, title: id, body: "", columnKey, position: 1, createdAt: now, updatedAt: now });
  // What an AGENT does (board_column_create/update): the same writer, outside the HTTP route.
  const agentLayout = (pid, cols, rekeys = []) => db.applyBoardColumnLayout(pid, cols, rekeys, "backlog");

  const sessions = { updateBoardColumns: SessionService.prototype.updateBoardColumns.bind({ db }) };
  const stub = {};
  const SECRET = "loopback-secret-for-col-stale-0123456789";
  app = await buildServer({
    db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, loopbackSecret: SECRET,
  });
  const AUTH = { host: `127.0.0.1:${process.env.LOOM_PORT}`, origin: `http://127.0.0.1:${process.env.LOOM_PORT}`, "content-type": "application/json", authorization: `Bearer ${SECRET}` };
  const put = (pid, payload) => app.inject({ method: "PUT", url: `/api/projects/${pid}/columns`, headers: AUTH, payload });
  // The layout an editor that loaded `cols` would send back unchanged.
  const echo = (cols) => cols.map((c) => ({ key: c.key, label: c.label, ...(c.role ? { role: c.role } : {}), ...(c.wipLimit !== undefined ? { wipLimit: c.wipLimit } : {}) }));

  // ======== (A) back-compat: NO baseKeys = the legacy blind replace, byte-for-byte ========
  mkProject("pA");
  const loadedA = echo(stored("pA"));
  agentLayout("pA", [...stored("pA"), { key: "qa", label: "QA" }]);
  mkTask("pA", "a-qa", "qa");
  const legacy = await put("pA", { columns: loadedA });
  check("(A) no baseKeys → 200 (legacy blind replace still accepted)", legacy.statusCode === 200);
  check("(A) …the newer column IS removed and its card re-homed (the behaviour baseKeys exists to guard)",
    keysOf(stored("pA")) === "backlog,doing,done" && db.getTask("a-qa").columnKey === "backlog");

  // ======== (B) drift by an ADDED column ========
  mkProject("pB");
  const loadedB = stored("pB");
  const baseB = loadedB.map((c) => c.key);
  agentLayout("pB", [...loadedB, { key: "qa", label: "QA" }]);
  mkTask("pB", "b-qa", "qa"); mkTask("pB", "b-doing", "doing");
  const boardB = JSON.stringify(stored("pB")); const cardsB = cardMap("pB");
  const drifted = await put("pB", { columns: echo(loadedB), baseKeys: baseB });
  const dbody = JSON.parse(drifted.body);
  check("(B) stale save (omits a newer column) → 409", drifted.statusCode === 409);
  check("(B) …code columns_drifted", dbody.code === "columns_drifted");
  check("(B) …names the added key", Array.isArray(dbody.added) && dbody.added.join() === "qa" && Array.isArray(dbody.removed) && dbody.removed.length === 0);
  check("(B) …carries the CURRENT layout (incl. the newer column)", Array.isArray(dbody.columns) && keysOf(dbody.columns) === "backlog,doing,done,qa");
  check("(B) …the error names the added column by label", /'QA'/.test(dbody.error));
  check("(B) …stored board byte-identical, newer column still exists", JSON.stringify(stored("pB")) === boardB);
  check("(B) …NO card moved (the QA card is still on qa)", cardMap("pB") === cardsB && db.getTask("b-qa").columnKey === "qa");

  // ======== (F) the retry shape, on the same project: re-base on the 409 body ========
  const retry = await put("pB", { columns: [...echo(loadedB.slice(0, 2)), { key: "qa", label: "QA", prevKey: "qa" }, echo(loadedB)[2]], baseKeys: dbody.columns.map((c) => c.key) });
  check("(F) re-sent against the 409 body's key set → 200", retry.statusCode === 200);
  check("(F) …the newer column survived", keysOf(stored("pB")) === "backlog,doing,qa,done" && db.getTask("b-qa").columnKey === "qa");

  // ======== (C) drift by a REMOVED column ========
  mkProject("pC");
  const loadedC = stored("pC");
  mkTask("pC", "c-doing", "doing");
  agentLayout("pC", [loadedC[0], loadedC[2]], [{ from: "doing", to: "backlog" }]); // an agent deleted "doing"; its card re-homed
  const boardC = JSON.stringify(stored("pC")); const cardsC = cardMap("pC");
  const removedRes = await put("pC", { columns: echo(loadedC), baseKeys: loadedC.map((c) => c.key) });
  const rbody = JSON.parse(removedRes.body);
  check("(C) editor still lists a column an agent deleted → 409 with removed=[doing]", removedRes.statusCode === 409 && rbody.removed?.join() === "doing" && rbody.added?.length === 0);
  check("(C) …board and cards untouched (the deleted column was NOT re-created silently)", JSON.stringify(stored("pC")) === boardC && cardMap("pC") === cardsC);

  // ======== (D) the human's staged removal of a column an agent ALSO re-keyed ========
  mkProject("pD");
  const loadedD = stored("pD");
  mkTask("pD", "d-doing", "doing");
  agentLayout("pD", [loadedD[0], { ...loadedD[1], key: "wip" }, loadedD[2]], [{ from: "doing", to: "wip" }]);
  const boardD = JSON.stringify(stored("pD")); const cardsD = cardMap("pD");
  const stagedRemove = await put("pD", { columns: echo([loadedD[0], loadedD[2]]), baseKeys: loadedD.map((c) => c.key) });
  check("(D) staged delete of a column the agent re-keyed → 409", stagedRemove.statusCode === 409);
  check("(D) …NO card re-homed without a Save after the notice (card still on wip)", db.getTask("d-doing").columnKey === "wip" && cardMap("pD") === cardsD && JSON.stringify(stored("pD")) === boardD);

  // ======== (E) clean saves ========
  mkProject("pE");
  const loadedE = stored("pE");
  mkTask("pE", "e-doing", "doing");
  const baseE = loadedE.map((c) => c.key);
  const clean = await put("pE", { columns: echo(loadedE).map((c) => (c.key === "backlog" ? { ...c, label: "Todo" } : c)), baseKeys: [...baseE].reverse() });
  check("(E) baseKeys == current key set (any order) → 200", clean.statusCode === 200);
  check("(E) …the edit applied", stored("pE")[0].label === "Todo");
  const cleanRemove = await put("pE", { columns: echo([stored("pE")[0], stored("pE")[2]]), baseKeys: stored("pE").map((c) => c.key) });
  check("(E) a deliberate removal in a CLEAN save → 200", cleanRemove.statusCode === 200 && keysOf(stored("pE")) === "backlog,done");
  check("(E) …its card re-homed to the default landing (legitimate path intact)", db.getTask("e-doing").columnKey === "backlog");

  // ======== (G) explicit [] is present; bad shapes → 400 ========
  mkProject("pG");
  const boardG = JSON.stringify(stored("pG"));
  const empty = await put("pG", { columns: echo(stored("pG")), baseKeys: [] });
  check("(G) explicit baseKeys:[] counts as PRESENT → 409 on a real board", empty.statusCode === 409 && JSON.parse(empty.body).added.length === 3);
  const shapes = [{ baseKeys: "backlog" }, { baseKeys: [""] }, { baseKeys: [1] }, { baseKeys: null }];
  const codes = [];
  for (const s of shapes) codes.push((await put("pG", { columns: echo(stored("pG")), ...s })).statusCode);
  check(`(G) bad baseKeys shapes → 400 (got ${codes.join(",")})`, codes.every((c) => c === 400));
  check("(G) …board untouched", JSON.stringify(stored("pG")) === boardG);
  check("(G) unknown project → 404", (await put("nope", { columns: echo(BOARD), baseKeys: [] })).statusCode === 404);
} finally {
  try { await app?.close(); } catch { /* best-effort */ }
  try { db?.close(); } catch { /* best-effort */ }
}
await finishAndExit(failures);
