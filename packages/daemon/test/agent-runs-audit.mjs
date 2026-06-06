import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs follow-up #1 — the run AUDIT TRAIL (run_events store + reader + the 429 cap-reject wiring).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE, in the style of agent-runs-caps.mjs / agent-runs-rest.mjs: the
// REAL buildServer driven by app.inject, with sessions.startRun STUBBED (no pty/claude; the stub inserts
// the `running` run row a real start would, so the in-flight counter sees it and the next POST hits the cap).
//
// The gap this closes: a 429 cap-rejection at POST /api/runs creates NO run row, so a throttled key is
// otherwise completely invisible. This proves the cap-reject is captured as a `cap_rejected` run_event.
//
// Covers the card's DoD:
//   (a) the 429 is STILL returned (the audit is purely additive — caps/response unchanged);
//   (b) a run_events row is recorded with the right kind/detail (cap, limit, observed, agentId, keyId, runId null);
//   (c) db.listRunEvents AND GET /api/projects/:id/run-events return it (newest-first, bounded);
//   (d) project-scoped — another project sees NONE; an unknown project → 404;
//   (e) an audit-write FAILURE does NOT break the 429 path (the insertRunEvent fault is swallowed).
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-audit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-aaudit-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45394";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

try {
  const db = new Db(path.join(tmpHome, "audit.db"));
  db.insertProject({ id: "pMain", name: "Main", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });

  const mk = (caps) => db.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: ["aEndpoint"], caps });
  const CAP1 = mk({ maxConcurrentRuns: 1, dailyTokenCap: null, dailySpendCap: null });   // concurrency cap = 1
  const TOK = mk({ maxConcurrentRuns: null, dailyTokenCap: 100, dailySpendCap: null });   // daily token cap = 100
  const UNCAPPED = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null });

  // Stub sessions: startRun INSERTS the `running` run row a real start would (so the in-flight counter sees it).
  let runSeq = 0;
  const fakeSessions = {
    startRun: async (opts) => {
      const id = `run-${++runSeq}`;
      db.insertRun({
        id, projectId: "pMain", agentId: opts.agentId, sessionId: `sess-${runSeq}`, keyId: opts.keyId ?? null,
        status: "running", input: opts.input, schema: opts.schema ?? null, result: null, usage: null,
        transcriptRef: null, error: null, webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
        createdAt: new Date().toISOString(), startedAt: now, endedAt: null,
      });
      return { run: db.getRun(id), session: { id: `sess-${runSeq}` } };
    },
    cancelRun: (runId) => ({ status: db.getRun(runId)?.status ?? "cancelled" }),
  };
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const postRun = (token, payload) => app.inject({ method: "POST", url: "/api/runs", headers: token ? bearer(token) : {}, payload });
  const body = { agent: "aEndpoint", input: {} };

  // =====================================================================================================
  // (a)+(b) CONCURRENCY cap → 429 STILL returned AND a `cap_rejected` run_event recorded with right fields
  // =====================================================================================================
  const ok1 = await postRun(CAP1.plaintext, body);
  check("under the cap → 202 (fills the cap of 1; records NO event)", ok1.statusCode === 202);
  check("a successful run records NO run_event", db.listRunEvents("pMain").length === 0);

  const rej = await postRun(CAP1.plaintext, body);
  check("(a) AT the concurrency cap → 429 STILL returned", rej.statusCode === 429 && rej.json().error === "concurrency cap reached");
  const evs1 = db.listRunEvents("pMain");
  check("(b) exactly one cap_rejected run_event recorded", evs1.length === 1 && evs1[0].kind === "cap_rejected");
  const e1 = evs1[0];
  check("(b) the event is key-scoped, runId NULL (no run row was created)", e1.keyId === CAP1.key.id && e1.runId === null && e1.projectId === "pMain");
  check("(b) detail = { cap:'concurrency', limit:1, observed:1, agentId:'aEndpoint' }",
    e1.detail?.cap === "concurrency" && e1.detail?.limit === 1 && e1.detail?.observed === 1 && e1.detail?.agentId === "aEndpoint");
  check("(b) the event carries a created_at timestamp", typeof e1.createdAt === "string" && e1.createdAt.length > 0);

  // =====================================================================================================
  // DAILY TOKEN cap → 429 + a cap_rejected event with cap:'daily_token' (observed = the 24h usage sum)
  // =====================================================================================================
  const seedUsage = (id, keyId, inputTokens, createdAt) => db.insertRun({
    id, projectId: "pMain", agentId: "aEndpoint", sessionId: null, keyId, status: "completed",
    input: null, schema: null, result: { ok: true }, usage: { inputTokens, turns: 1, model: "claude-opus-4-8" },
    transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null, createdAt, startedAt: createdAt, endedAt: createdAt,
  });
  seedUsage("tok-a", TOK.key.id, 70, isoAgo(1 * 60 * 60 * 1000));
  seedUsage("tok-b", TOK.key.id, 50, isoAgo(2 * 60 * 60 * 1000)); // 120 total > cap 100
  const rejTok = await postRun(TOK.plaintext, body);
  check("daily token cap → 429 STILL returned", rejTok.statusCode === 429 && rejTok.json().error === "daily token cap reached");
  const tokEv = db.listRunEvents("pMain").find((e) => e.keyId === TOK.key.id);
  check("a cap_rejected event recorded for the token-throttled key", !!tokEv && tokEv.kind === "cap_rejected" && tokEv.runId === null);
  check("token-cap detail = { cap:'daily_token', limit:100, observed:120, agentId:'aEndpoint' }",
    tokEv?.detail?.cap === "daily_token" && tokEv?.detail?.limit === 100 && tokEv?.detail?.observed === 120 && tokEv?.detail?.agentId === "aEndpoint");

  // =====================================================================================================
  // (c) the REST reader returns the events (newest-first, bounded); unauthed loopback (no Bearer)
  // =====================================================================================================
  const list = await app.inject({ method: "GET", url: `/api/projects/pMain/run-events` }); // NO Authorization
  check("(c) GET /api/projects/:id/run-events → 200 WITHOUT a Bearer (human/loopback, NOT key-gated)",
    list.statusCode === 200 && Array.isArray(list.json()));
  const lr = list.json();
  check("(c) the reader returns BOTH recorded cap-rejections", lr.length === 2 && lr.every((e) => e.kind === "cap_rejected"));
  check("(c) newest-first ordering", lr[0].createdAt >= lr[lr.length - 1].createdAt);
  const bounded = await app.inject({ method: "GET", url: `/api/projects/pMain/run-events?limit=1` });
  check("(c) ?limit bounds the result set", bounded.statusCode === 200 && bounded.json().length === 1);

  // =====================================================================================================
  // (d) project-scoped — another project sees NONE; an unknown project → 404
  // =====================================================================================================
  const other = await app.inject({ method: "GET", url: `/api/projects/pOther/run-events` });
  check("(d) another project's run-events are EMPTY (project-scoped)", other.statusCode === 200 && other.json().length === 0);
  check("(d) listRunEvents is project-scoped at the db layer too", db.listRunEvents("pOther").length === 0);
  const unknown = await app.inject({ method: "GET", url: `/api/projects/nope/run-events` });
  check("(d) GET run-events for an unknown project → 404", unknown.statusCode === 404);

  // =====================================================================================================
  // (e) an audit-write FAILURE does NOT break the 429 path — the insertRunEvent fault is swallowed
  // =====================================================================================================
  const before = db.listRunEvents("pMain").length;
  const orig = db.insertRunEvent.bind(db);
  db.insertRunEvent = () => { throw new Error("simulated audit-store fault"); };
  let threw = false;
  let stillRej;
  try { stillRej = await postRun(CAP1.plaintext, body); } catch { threw = true; } // CAP1 still at its cap → 429 path
  check("(e) a throwing insertRunEvent does NOT propagate into the request", threw === false);
  check("(e) the 429 is STILL returned despite the audit-write failure", stillRej?.statusCode === 429 && stillRej.json().error === "concurrency cap reached");
  check("(e) no extra event was recorded (the failed write was swallowed, not retried)", db.listRunEvents("pMain").length === before);
  db.insertRunEvent = orig; // restore

  // An UNCAPPED key under no cap still records NOTHING new — the audit fires ONLY on a cap-reject.
  const afterRestore = db.listRunEvents("pMain").length;
  const okUncapped = await postRun(UNCAPPED.plaintext, body);
  check("an uncapped run → 202 and records NO new run_event", okUncapped.statusCode === 202 && db.listRunEvents("pMain").length === afterRestore);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs audit trail: a 429 cap-rejection (concurrency + daily-token) STILL returns 429 AND records a project-scoped `cap_rejected` run_event ({cap,limit,observed,agentId}, keyId set, runId null); the db + REST readers return it newest-first/bounded; it is project-scoped (another project sees none, unknown → 404); and an audit-write failure is swallowed without breaking the 429 path — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
