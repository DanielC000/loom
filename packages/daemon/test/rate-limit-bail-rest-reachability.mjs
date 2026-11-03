// Card dfef375f round 3 item 1 — HERMETIC (no live daemon, no real claude): the real Fastify gateway
// in-process (buildServer) against a temp Db + a STUB pty, proving the BLOCKER this item closes:
//
//   A BAILED live session's rate_limited_until is already NULL (bailRateLimitEpisode nulls it), so
//   before this card BOTH human-clear paths silently skipped it: `/api/usage/clear-hold`'s cascade
//   iterated `db.listRateLimited()`, which queried `rate_limited_until IS NOT NULL` alone, and
//   `SessionActions.tsx`'s own button was gated on `rateLimitedUntil` alone too (covered separately by
//   packages/web/test/fleet.mjs's isBailed/fleetRollup/workerBuckets checks).
//
// This file proves the DAEMON half: `db.listRateLimited()` now ALSO matches a bailed-only row, so BOTH
// REST clear routes reach it — `/api/usage/clear-hold`'s cascade (never iterated it before) and the
// per-session `/api/sessions/:id/rate-limit/clear` route (always reachable by id, but previously never
// cleared the new marker, which this test also checks). RED-proven with an API-keeping mutant: narrowing
// `listRateLimited`'s query back to `WHERE rate_limited_until IS NOT NULL` alone (while keeping every
// signature/export the same) makes section B's "the cascade picked it up" checks fail, while everything
// else keeps compiling and running.
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/rate-limit-bail-rest-reachability.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rlbrr-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
requireHermeticEnv();

const LOOM = process.env.LOOM_HOME;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { bailRateLimitEpisode } = await import("../dist/orchestration/rate-limit-bail.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(LOOM, "loom.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

const seedLive = (id) => db.insertSession({
  id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
});

seedLive("bailedA"); // bailed via the shared helper, picked up by the GLOBAL cascade (section B)
seedLive("bailedB"); // bailed via the shared helper, cleared via the PER-SESSION route (section A)

const alive = new Set(["bailedA", "bailedB"]);
const resumed = [];
const pty = {
  isAlive: (id) => alive.has(id),
  enqueueStdin: () => {}, // bailRateLimitEpisode's best-effort owner nudge — no parent, so never actually called
  resumeAfterRateLimit: (id) => { if (!alive.has(id)) return false; resumed.push(id); return true; },
};
const stub = {};
const app = await buildServer({ db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

try {
  bailRateLimitEpisode(db, pty, "bailedA", "e2e: loop breaker bail", { reason: "loop_breaker" });
  bailRateLimitEpisode(db, pty, "bailedB", "e2e: loop breaker bail", { reason: "loop_breaker" });

  // ════════ SETUP: both bailed rows genuinely look "not parked" by the OLD, narrower query shape ════════
  const a0 = db.getSession("bailedA");
  check("setup: bailedA's rate_limited_until is NULL (the bail nulled it)", a0.rateLimitedUntil === null);
  check("setup: bailedA's rate_limit_bailed_at IS set (the durable marker)", typeof a0.rateLimitBailedAt === "string" && a0.rateLimitBailedAt.length > 0);

  // ════════ A. per-session clear reaches a BAILED row — clears the marker too, not just the park cols ════════
  const rA = await app.inject({ method: "POST", url: "/api/sessions/bailedB/rate-limit/clear" });
  check("A: 200 OK", rA.statusCode === 200);
  const bodyA = rA.json();
  check("A: response carries the cleared marker (rateLimitBailedAt null)", bodyA.rateLimitBailedAt === null);
  const bB = db.getSession("bailedB");
  check("A: DB marker cleared", bB.rateLimitBailedAt === null);
  check("A: held turn re-submitted on the bailed LIVE session (pty.resumeAfterRateLimit called)",
    resumed.includes("bailedB"));

  // ════════ B. THE BLOCKER: the GLOBAL clear-hold cascade must pick up a bailed-ONLY row ════════
  // Before card dfef375f round 3 item 1, db.listRateLimited() queried `rate_limited_until IS NOT NULL`
  // alone — bailedA's own rate_limited_until is NULL (the bail nulled it), so this row was silently
  // excluded from the cascade's loop entirely and resumeAfterRateLimit was never called for it.
  const rB = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
  check("B: 200 OK", rB.statusCode === 200);
  const bodyB = rB.json();
  check("B: at least the bailed LIVE session was resumed by the cascade", bodyB.resumed >= 1);
  const aFinal = db.getSession("bailedA");
  check("B: THE BLOCKER IS CLOSED — bailedA's marker is cleared by the cascade", aFinal.rateLimitBailedAt === null);
  check("B: bailedA's park columns are ALSO cleared", aFinal.rateLimitedUntil === null && aFinal.rateLimitDeadline === null);
  check("B: held turn re-submitted on bailedA too (pty.resumeAfterRateLimit called)", resumed.includes("bailedA"));

  // ════════ Positive control: a genuinely never-bailed, never-parked session is untouched by either route ════════
  seedLive("free");
  const rFree = await app.inject({ method: "POST", url: "/api/sessions/free/rate-limit/clear" });
  check("(control) a never-parked session's clear route still 200s (no-op-safe)", rFree.statusCode === 200);
  check("(control) a never-parked session was never added to the resumed list", !resumed.includes("free"));
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(LOOM);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a durably-bailed LIVE session (rate_limited_until already nulled by the bail) is reachable from BOTH human-clear REST routes: the per-session route clears its new marker too, and the global clear-hold cascade — which used to silently skip it — now picks it up via listRateLimited()'s widened OR."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
