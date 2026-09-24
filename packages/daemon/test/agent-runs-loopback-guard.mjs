import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cda454c8 — the key-authed Agent Runs API (POST /api/runs, POST /api/runs/:id/cancel) vs the loopback
// human-only-write guard (card 9ccedbee). Both read `Authorization: Bearer <x>`: the guard wants the
// loopback secret on EVERY non-GET /api/* write from loopback, `authRunKey` wants the run API key. A caller
// can present one Bearer value, so with the guard wired (the real boot path always wires it) an API-keyed
// run start/cancel from loopback 401s at the guard before authRunKey ever runs.
// Driven via buildServer + app.inject (HERMETIC + CLAUDE-FREE + NETWORK-FREE), with `loopbackSecret` WIRED
// (the seam agent-runs-rest.mjs never sets, which is why it stayed green) and startRun/cancelRun stubbed.
//   (R) THE REPRO: an API-keyed POST /api/runs and POST /api/runs/:id/cancel from loopback reach their handler.
//   (N) NEGATIVE CONTROLS — the exemption must not become a bypass:
//       - no credential / bogus key / the LOOPBACK SECRET itself presented on the run routes → 401, nothing started
//       - a VALID run API key presented on any OTHER non-GET /api/* write → 401 (the key opens ONLY the run routes)
//       - the loopback secret still works on the other writes (the guard itself is unchanged).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-runs-loopback-guard-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(46418 + (process.pid % 900));
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer, LOOPBACK_GUARD_KEY_AUTHED_EXEMPT } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const SECRET = "loopback-secret-for-test-0123456789abcdef";
const H = { host: `127.0.0.1:${process.env.LOOM_PORT}`, origin: `http://127.0.0.1:${process.env.LOOM_PORT}`, "content-type": "application/json" };
const bearer = (t) => ({ ...H, authorization: `Bearer ${t}` });

let app, db;
try {
  db = new Db(path.join(TMP, "loom.db"));
  db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aEndpoint", projectId: "p1", name: "Analyst", startupPrompt: "x", position: 0, profileId: null, endpoint: true, ioSchema: null });
  const K = db.createApiKey({ projectId: "p1", name: "k", endpointAgentIds: ["aEndpoint"], caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  const token = K.plaintext;

  const startCalls = [];
  const cancelCalls = [];
  let seq = 0;
  const sessions = {
    startRun: async (opts) => {
      startCalls.push(opts);
      const id = `run-${++seq}`;
      db.insertRun({
        id, projectId: "p1", agentId: opts.agentId, sessionId: `s-${seq}`, keyId: opts.keyId ?? null, status: "running",
        input: opts.input, schema: null, result: null, usage: null, transcriptRef: null, error: null,
        webhookUrl: null, idempotencyKey: null, createdAt: now, startedAt: now, endedAt: null,
      });
      return { run: db.getRun(id), session: { id: `s-${seq}` } };
    },
    cancelRun: (runId) => { cancelCalls.push(runId); db.failRun(runId, "cancelled by caller", "cancelled"); return { status: "cancelled" }; },
  };
  const stub = {};
  app = await buildServer({
    db, pty: stub, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub,
    setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, loopbackSecret: SECRET,
  });
  // .inject() defaults remoteAddress to 127.0.0.1 — a loopback caller.
  const post = (url, headers, payload) => app.inject({ method: "POST", url, headers, payload: payload ?? {} });

  // (S) STRUCTURAL PIN: the exempt set's EXACT contents. Adding a route fails this and forces review
  // (@decision cda454c8: a new entry needs an exact pattern AND authRunKey called first in its handler).
  check("(S) LOOPBACK_GUARD_KEY_AUTHED_EXEMPT is exactly [POST /api/runs, POST /api/runs/:id/cancel] patterns",
    JSON.stringify([...(LOOPBACK_GUARD_KEY_AUTHED_EXEMPT ?? [])].sort()) === JSON.stringify(["/api/runs", "/api/runs/:id/cancel"]));

  // (R) the repro
  const start = await post("/api/runs", bearer(token), { agent: "aEndpoint", input: { q: 1 } });
  check("(R) API-keyed POST /api/runs from loopback → 202 (was 401 from the loopback guard)", start.statusCode === 202);
  const runId = start.statusCode === 202 ? JSON.parse(start.body).runId : null;
  check("(R) the run actually started", startCalls.length === 1);
  const cancel = await post(`/api/runs/${runId ?? "run-1"}/cancel`, bearer(token));
  check("(R) API-keyed POST /api/runs/:id/cancel from loopback → 200 (was 401 from the loopback guard)",
    cancel.statusCode === 200 && cancelCalls.length === 1);
  const poll = await app.inject({ method: "GET", url: `/api/runs/${runId ?? "run-1"}`, headers: bearer(token) });
  check("(R) GET /api/runs/:id with the API key still works (GET is never guarded)", poll.statusCode === 200);

  // (N) negative controls
  const before = startCalls.length;
  const none = await post("/api/runs", H, { agent: "aEndpoint", input: {} });
  check("(N) run start with NO credential → 401", none.statusCode === 401);
  const bogus = await post("/api/runs", bearer(`lrk_${"x".repeat(36)}.deadbeef`), { agent: "aEndpoint", input: {} });
  check("(N) run start with a bogus API key → 401", bogus.statusCode === 401);
  const secretOnRuns = await post("/api/runs", bearer(SECRET), { agent: "aEndpoint", input: {} });
  check("(N) run start presenting the LOOPBACK SECRET (not an API key) → 401", secretOnRuns.statusCode === 401);
  const noneCancel = await post("/api/runs/run-1/cancel", H);
  check("(N) run cancel with NO credential → 401", noneCancel.statusCode === 401);
  check("(N) no run started by any rejected request", startCalls.length === before);

  const keyOnOther = await post("/api/questions/nope/answer", bearer(token), { answer: "x" });
  check("(N) a VALID run API key on another non-GET /api write → 401 (exemption is run-routes-only)", keyOnOther.statusCode === 401);
  const keyOnConfig = await app.inject({ method: "PATCH", url: "/api/platform/config", headers: bearer(token), payload: {} });
  check("(N) a VALID run API key on PATCH /api/platform/config → 401", keyOnConfig.statusCode === 401);
  const keyOnRunsSibling = await post("/api/projects/p1/runs", bearer(token), {});
  check("(N) a VALID run API key on a sibling write path under /api/projects/:id/runs* → 401 (or unmatched), never 2xx",
    keyOnRunsSibling.statusCode === 401 || keyOnRunsSibling.statusCode === 404 || keyOnRunsSibling.statusCode === 405);
  const secretOnOther = await post("/api/questions/nope/answer", bearer(SECRET), { answer: "x" });
  check("(N) the loopback secret still reaches other writes (guard unchanged)", secretOnOther.statusCode !== 401);
} finally {
  try { await app?.close(); } catch { /* best-effort */ }
  try { db?.close(); } catch { /* best-effort */ }
}
await finishAndExit(failures);
