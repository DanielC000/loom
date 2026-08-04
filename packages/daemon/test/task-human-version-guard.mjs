import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0b36702e — closes the two surfaces d0978321 (the AGENT-side baseVersion CAS gate) deliberately
// left open: the human-only REST route (POST /api/tasks/:id) and the companion's board_update.
//
// THE GAP: d0978321 gated tasks_update/project_task_update, but the REST route a board drawer saves
// through wrote title/body blind, with no version concept at all. A drawer left open on a card an agent
// is actively editing would silently clobber that agent's edit on the human's next Save — no error, no
// warning, no diff. This is NOT "gate the human" (the human keeps override authority, same posture as
// the held-clear guard) — it's "stop the human clobbering by ACCIDENT": detect-and-warn, remedy (a).
//
// THE FIX (REST route, gateway/server.ts):
//   - `baseVersion` is now an OPTIONAL field on the POST body. Sent + touching title/body: gated via
//     db.updateTaskChecked, same CAS the agent surfaces use. A stale value 409s with {conflict:true,
//     current} (the fresh task) instead of writing. Omitted: writes BLIND, exactly as before this card —
//     the human's override / the drawer's own "overwrite anyway" escape hatch.
//   - A field-only patch (columnKey+position — kanban drag) is NEVER gated, baseVersion sent or not,
//     mirroring d0978321's own touchesContent invariant (version only ever advances on title/body).
//
// HERMETIC: a REAL fastify app (buildServer) + app.inject, mirroring held-clear-guard.mjs's Part C
// harness — no daemon, no real claude.
//
// Proves the DoD:
//   (1) POSITIVE CONTROL, direction (i): composer loads at version N, something else (simulated agent
//       write) bumps it to N+1, then a save holding the STALE N 409s with {conflict:true, current} naming
//       the CURRENT row — and the stale write never lands.
//   (2) POSITIVE CONTROL, direction (ii): composer loads at version N, NOTHING else writes, a save
//       holding N succeeds normally — no friction on the common, uncontended path.
//   (3) an OMITTED baseVersion on a content write still writes BLIND (the human's override), unlike the
//       agent-side gate, which rejects an omitted base outright — the asymmetry is deliberate.
//   (4) a field-only patch (columnKey — kanban drag) is completely unaffected: no baseVersion needed,
//       and a STALE baseVersion sent alongside a field-only patch is simply ignored (touchesContent gates
//       whether the check runs at all, not whether a version value happens to be present).
//   (5) a 404 on a missing task with baseVersion sent is a plain 404, not a conflict.
// Run: 1) build (turbo builds shared first), 2) node test/task-human-version-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-human-version-guard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const file = path.join(tmpHome, "task-human-version-guard.db");
const db = new Db(file);
process.env.LOOM_PORT = "45421";
const app = await buildServer({ db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, runMcp: {}, control: {}, usageStatus: {} });

try {
  db.insertProject({ id: "projU", name: "Human Version Guard", repoPath: "C:/u", vaultPath: "C:/u", config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ===== (1) POSITIVE CONTROL (i): composer loads at version N, an agent writes in between, the human's
  // stale save is REJECTED and never lands =====
  const card1 = createProjectTask(db, "projU", { title: "race card", body: "original body (v1)" });
  check("(setup) a fresh card starts at version 1", card1.version === 1);
  const loadedVersion1 = card1.version; // the drawer's "composer loaded at version N"

  // Simulate an agent write landing while the drawer sits open (the exact scenario this card fixes).
  const agentWriteResp = await app.inject({
    method: "POST", url: `/api/tasks/${card1.id}`,
    payload: { title: card1.title, body: "an agent's concurrent edit (v2)", baseVersion: loadedVersion1 },
  });
  check("(setup) the agent's own write (holding the correct version) succeeds", agentWriteResp.statusCode === 200);
  check("(setup) version bumped to 2", db.getTask(card1.id).version === 2);

  const staleHumanSave = await app.inject({
    method: "POST", url: `/api/tasks/${card1.id}`,
    payload: { title: "the human's stale rewrite", body: "the human's stale rewrite body", baseVersion: loadedVersion1 },
  });
  check("(1i) THE FIX: a stale-baseVersion human save is REJECTED — 409", staleHumanSave.statusCode === 409);
  const staleBody = JSON.parse(staleHumanSave.body);
  check("(1i) the 409 body carries conflict:true", staleBody.conflict === true);
  check("(1i) the 409 body carries the CURRENT task (the agent's edit), not the human's guess", staleBody.current?.body === "an agent's concurrent edit (v2)");
  check("(1i) the 409 body's current version is 2", staleBody.current?.version === 2);
  check("(1i) the stale human write never persisted", db.getTask(card1.id).body === "an agent's concurrent edit (v2)");
  check("(1i) the stale human write's title never persisted either (whole-write reject)", db.getTask(card1.id).title === card1.title);

  // ===== (2) POSITIVE CONTROL (ii): composer loads at version N, NOTHING else writes, save succeeds with
  // zero friction =====
  const card2 = createProjectTask(db, "projU", { title: "quiet card", body: "quiet body (v1)" });
  const loadedVersion2 = card2.version;
  const quietSave = await app.inject({
    method: "POST", url: `/api/tasks/${card2.id}`,
    payload: { title: "quiet card, edited", body: "quiet body, edited", baseVersion: loadedVersion2 },
  });
  check("(2ii) a save holding the CURRENT version succeeds — 200, no friction", quietSave.statusCode === 200);
  check("(2ii) the edit persisted", db.getTask(card2.id).body === "quiet body, edited");
  check("(2ii) version bumped to 2 on the real content change", db.getTask(card2.id).version === 2);

  // ===== (3) an OMITTED baseVersion on a content write still writes BLIND (the human's override) —
  // asymmetric with the agent-side gate, which rejects omission outright =====
  const card3 = createProjectTask(db, "projU", { title: "override card", body: "override body (v1)" });
  const overrideResp = await app.inject({
    method: "POST", url: `/api/tasks/${card3.id}`,
    payload: { title: "overwritten with no baseVersion at all", body: "overwritten body" },
  });
  check("(3) an omitted baseVersion on a content write is NOT rejected — 200 (human keeps override)", overrideResp.statusCode === 200);
  check("(3) the blind write persisted", db.getTask(card3.id).body === "overwritten body");
  check("(3) version still bumped (db.updateTask's own bump-on-content rule, untouched by this gate)", db.getTask(card3.id).version === 2);

  // ===== (4) field-only writes (kanban drag) are completely unaffected — no baseVersion needed, and a
  // STALE baseVersion sent alongside is simply ignored since it never touches title/body =====
  const card4 = createProjectTask(db, "projU", { title: "drag card", body: "drag body" });
  const dragNoVersion = await app.inject({ method: "POST", url: `/api/tasks/${card4.id}`, payload: { columnKey: "backlog" } });
  check("(4) a field-only move with NO baseVersion succeeds", dragNoVersion.statusCode === 200);
  const dragStaleVersion = await app.inject({
    method: "POST", url: `/api/tasks/${card4.id}`,
    payload: { columnKey: "backlog", position: 42, baseVersion: 999 }, // 999 is wildly stale/bogus
  });
  check("(4) a field-only move with a BOGUS baseVersion still succeeds — the gate only ever applies to title/body", dragStaleVersion.statusCode === 200);
  check("(4) version never advanced across either field-only move", db.getTask(card4.id).version === 1);

  // ===== (5) a 404 on a missing task, baseVersion sent, is a plain 404 — never a conflict shape =====
  const missing = await app.inject({
    method: "POST", url: `/api/tasks/does-not-exist`,
    payload: { title: "x", body: "y", baseVersion: 1 },
  });
  check("(5) a missing task 404s (existence is checked before the version gate even runs)", missing.statusCode === 404);
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the human-only REST route (POST /api/tasks/:id) now optionally CAS-gates a title/body write on `baseVersion`: a stale value 409s with the current task instead of silently clobbering it, a matching value writes through with no friction, an OMITTED value still writes blind (the human's deliberate override, unlike the agent-side gate's reject-on-omission), and a field-only patch (kanban drag) is never gated regardless of what baseVersion carries."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
