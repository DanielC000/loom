import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 14c756df (from the 363f5c2d delta review) — the human-only REST route (POST /api/tasks/:id,
// gateway/server.ts) never carried 363f5c2d's M6 manual-deferral-release fix: a board-drawer un-defer
// (`{deferred:false}`) left `deferredUntilTaskId`/`deferredUntilEvent`/`deferredReason`/`deferredAt` all
// stale and never folded the outgoing reason into `body` — reopening the exact stale-blocker footgun M6
// closed, but only on the MCP path. The drawer CAN send `deferred:false` (packages/web/src/pages/Board.tsx's
// deferred switch, posted via api.ts's updateTask → POST /api/tasks/:id), so this was reachable.
//
// FIX: a new shared helper, `computeDeferralReleasePatch` (mcp/tasks.js), carries the release computation
// (force-clear deferredReason/deferredAt, clear deferredUntilTaskId/deferredUntilEvent unless the SAME
// patch sets them explicitly, fold any outgoing deferredReason into body) — called from BOTH
// `updateProjectTask` (MCP path, unchanged behavior) AND the REST route (new), so the two paths can't
// diverge on this again.
//
// HERMETIC: a REAL fastify app (buildServer) + app.inject for the REST path under test, plus the MCP
// `updateProjectTask` (already-built, already-tested) to set up each deferred starting state — mirrors
// task-human-version-guard.mjs's harness.
//
// Proves:
//   (1) ⭐ RED→GREEN: a route-(a) deferral (deferredUntilTaskId set) released via REST `{deferred:false}`
//       clears deferredUntilTaskId to null (pre-fix: left stale).
//   (2) ⭐ RED→GREEN: a manual deferral (reason + deferredUntilEvent set) released via REST clears
//       deferredReason, deferredAt, AND deferredUntilEvent, and folds the outgoing reason into body
//       (pre-fix: all four left stale/unfolded).
//   (3) an explicit deferredUntilTaskId sent in the SAME REST patch as deferred:false is respected, never
//       force-cleared — same convention as the MCP path.
// Run: 1) build (turbo builds shared first), 2) node test/task-rest-deferral-release.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-rest-deferral-release-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const file = path.join(tmpHome, "task-rest-deferral-release.db");
const db = new Db(file);
process.env.LOOM_PORT = String(hermeticPort());
const app = await buildServer({ db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, runMcp: {}, control: {}, usageStatus: {} });

try {
  db.insertProject({ id: "projR", name: "REST Deferral Release", repoPath: "C:/r", vaultPath: "C:/r", config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ===== (1) ⭐ route-a release via REST clears deferredUntilTaskId =====
  const blocker1 = createProjectTask(db, "projR", { title: "blocker 1 (unmerged)" });
  const c1 = createProjectTask(db, "projR", { title: "route-a deferral to release via REST" });
  const set1 = await updateProjectTask(db, "projR", c1.id, { deferred: true, deferredUntilTaskId: blocker1.id });
  check("(1) setup: route-a deferral set via MCP path", !("error" in set1) && set1.deferredUntilTaskId === blocker1.id);

  const release1 = await app.inject({ method: "POST", url: `/api/tasks/${c1.id}`, payload: { deferred: false } });
  check("(1) REST un-defer succeeds — 200", release1.statusCode === 200);
  const raw1 = db.getTask(c1.id);
  check("(1) ⭐ THE FIX: raw DB row confirms deferredUntilTaskId cleared to null (pre-fix: stayed stale)", raw1.deferredUntilTaskId === null);
  check("(1) raw DB row confirms deferred:false actually persisted", raw1.deferred === false);

  // ===== (2) ⭐ manual-deferral release via REST clears deferredReason/deferredAt/deferredUntilEvent and
  // folds the outgoing reason into body =====
  const c2 = createProjectTask(db, "projR", { title: "manual deferral to release via REST", body: "Original description." });
  const set2 = await updateProjectTask(db, "projR", c2.id, {
    deferred: true,
    deferredReason: "owner-gated: awaiting infra sign-off",
    deferredUntilEvent: { kind: "gate-fail-naming", key: "some-test-file.mjs" },
  });
  check("(2) setup: manual deferral with reason set via MCP path", !("error" in set2) && set2.deferredReason === "owner-gated: awaiting infra sign-off");
  check("(2) setup: deferredUntilEvent set via MCP path", !("error" in set2) && set2.deferredUntilEvent?.key === "some-test-file.mjs");
  check("(2) setup: deferredAt stamped via MCP path", !("error" in set2) && typeof set2.deferredAt === "string" && set2.deferredAt.length > 0);

  const release2 = await app.inject({ method: "POST", url: `/api/tasks/${c2.id}`, payload: { deferred: false } });
  check("(2) REST un-defer succeeds — 200", release2.statusCode === 200);
  const raw2 = db.getTask(c2.id);
  check("(2) ⭐ THE FIX: raw DB row confirms deferredReason cleared to null (pre-fix: stayed stale)", raw2.deferredReason === null);
  check("(2) ⭐ THE FIX: raw DB row confirms deferredAt cleared to null (pre-fix: stayed stale)", raw2.deferredAt === null);
  check("(2) ⭐ THE FIX: raw DB row confirms deferredUntilEvent cleared (pre-fix: stayed stale)", raw2.deferredUntilEvent === null || raw2.deferredUntilEvent === undefined);
  check("(2) ⭐ THE FIX: the outgoing reason is folded into body (pre-fix: body left untouched, reason silently discarded)", raw2.body.includes("owner-gated: awaiting infra sign-off"));
  check("(2) the original body content survives the fold", raw2.body.includes("Original description."));

  // ===== (3) an explicit deferredUntilTaskId sent in the SAME REST patch as deferred:false is respected,
  // never force-cleared — same convention as the MCP path =====
  const blocker3 = createProjectTask(db, "projR", { title: "blocker 3 (unmerged)" });
  const blocker3b = createProjectTask(db, "projR", { title: "blocker 3b (unmerged, the override target)" });
  const c3 = createProjectTask(db, "projR", { title: "explicit override on REST release" });
  await updateProjectTask(db, "projR", c3.id, { deferred: true, deferredUntilTaskId: blocker3.id });
  const release3 = await app.inject({
    method: "POST", url: `/api/tasks/${c3.id}`,
    payload: { deferred: false, deferredUntilTaskId: blocker3b.id },
  });
  check("(3) REST un-defer with an explicit same-patch override succeeds — 200", release3.statusCode === 200);
  const raw3 = db.getTask(c3.id);
  check("(3) the explicit deferredUntilTaskId value is respected, not force-cleared to null", raw3.deferredUntilTaskId === blocker3b.id);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the human-only REST route (POST /api/tasks/:id) now routes a manual deferred:false release through the SAME computeDeferralReleasePatch helper the MCP path uses: deferredUntilTaskId/deferredUntilEvent/deferredReason/deferredAt all clear, the outgoing reason folds into body, and an explicit same-patch override is still respected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
