import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs R4a — per-key CAPS enforcement + the per-key KILL-SWITCH + the HUMAN run REST (the R4b
// Runs UI's data source). HERMETIC + CLAUDE-FREE + NETWORK-FREE, in the style of agent-runs-rest.mjs:
// the REAL buildServer driven by app.inject, with sessions.startRun / cancelRun STUBBED (no pty/claude
// boots; the startRun stub inserts the `running` run row a real start would, so the in-flight counter
// and the human REST see it; the cancelRun stub flips a run terminal like the real teardown).
//
// Covers the card's DoD:
//   • CONCURRENCY cap — under the cap → 202; AT the cap → 429 + NO run started; freeing a slot re-opens
//     it; an UNCAPPED key is unaffected; an idempotency REPLAY is NOT capped (caps run AFTER the replay).
//   • DAILY TOKEN cap (best-effort, over the R2 usage snapshot) — at/over the trailing-24h sum → 429;
//     under → 202; usage OUTSIDE the 24h window does not count; an uncapped key is unaffected.
//   • KILL-SWITCH — cancels ALL the key's in-flight runs, PAUSES the key, and thereafter BLOCKS new runs
//     (paused → 403); idempotent re-kill; 404 on an unknown key.
//   • HUMAN run REST — GET list (project-scoped, full rows, newest first, runs across MULTIPLE keys),
//     GET one (full shape; wrong project → 404), POST cancel (reuses cancelRun) — all UNAUTHED (NOT
//     key-gated, unlike the R3 GET /api/runs/:id which 401s without a Bearer).
//
// NOTE (reported up): the run AUDIT TRAIL (#5) is NOT covered here — orchestration_events is manager-tree
// shaped (manager_session_id NOT NULL, no key/run column, readers keyed on manager/worker session; a
// cap-rejected event has no session at all), so run lifecycle events don't fit it cleanly. Per the card
// that's a report-up → audit is a thin follow-up, not bespoke tables. Likewise a USD SPEND cap is out of
// R4a (Loom has no cost model; the token cap above is the coarse best-effort the existing usage supports).
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-caps.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-acaps-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45393";
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
  const db = new Db(path.join(tmpHome, "caps.db"));
  db.insertProject({ id: "pMain", name: "Main", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pOther", name: "Other", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });

  const mk = (caps) => db.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: ["aEndpoint"], caps });
  const CAP2 = mk({ maxConcurrentRuns: 2, dailyTokenCap: null, dailySpendCap: null });   // concurrency cap = 2
  const UNCAPPED = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null });
  const TOK = mk({ maxConcurrentRuns: null, dailyTokenCap: 100, dailySpendCap: null });   // daily token cap = 100
  const KILL = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null });

  // Stub sessions: startRun INSERTS the `running` run row a real start would (so the in-flight counter +
  // human REST see it); cancelRun flips a non-terminal run → cancelled (like the real teardown).
  const startCalls = [];
  const cancelCalls = [];
  let runSeq = 0;
  const fakeSessions = {
    startRun: async (opts) => {
      startCalls.push(opts);
      const id = `run-${++runSeq}`;
      db.insertRun({
        id, projectId: "pMain", agentId: opts.agentId, sessionId: `sess-${runSeq}`, keyId: opts.keyId ?? null,
        status: "running", input: opts.input, schema: opts.schema ?? null, result: null, usage: null,
        transcriptRef: null, error: null, webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
        createdAt: new Date().toISOString(), startedAt: now, endedAt: null,
      });
      return { run: db.getRun(id), session: { id: `sess-${runSeq}` } };
    },
    cancelRun: (runId) => {
      cancelCalls.push(runId);
      const r = db.getRun(runId);
      if (["completed", "failed", "timed_out", "cancelled"].includes(r.status)) return { status: r.status };
      db.failRun(runId, "cancelled by caller", "cancelled");
      return { status: "cancelled" };
    },
  };
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const postRun = (token, payload) => app.inject({ method: "POST", url: "/api/runs", headers: token ? bearer(token) : {}, payload });
  const body = { agent: "aEndpoint", input: {} };

  // =====================================================================================================
  // 1) CONCURRENCY cap — must-have, deterministic count of in-flight runs for the key
  // =====================================================================================================
  const c1 = await postRun(CAP2.plaintext, body);
  const c2 = await postRun(CAP2.plaintext, body);
  check("1 under the cap → 202 (run 1 of 2)", c1.statusCode === 202);
  check("1 under the cap → 202 (run 2 of 2)", c2.statusCode === 202);
  check("1 two in-flight runs counted for the capped key", db.countInFlightRunsForKey(CAP2.key.id) === 2);
  const startsBefore = startCalls.length;
  const c3 = await postRun(CAP2.plaintext, body);
  check("1 AT the cap → 429 { concurrency cap reached }", c3.statusCode === 429 && c3.json().error === "concurrency cap reached");
  check("1 the rejected run started NOTHING (startRun NOT called)", startCalls.length === startsBefore);
  // free a slot (cancel run 1) → the next POST is admitted again.
  db.failRun(c1.json().runId, "freed", "cancelled");
  check("1 freeing a slot drops the in-flight count to 1", db.countInFlightRunsForKey(CAP2.key.id) === 1);
  const c4 = await postRun(CAP2.plaintext, body);
  check("1 a freed slot re-opens the cap → 202", c4.statusCode === 202);

  // an UNCAPPED key is unaffected — many simultaneous runs all admitted.
  let uncappedOk = true;
  for (let i = 0; i < 5; i++) { const r = await postRun(UNCAPPED.plaintext, body); if (r.statusCode !== 202) uncappedOk = false; }
  check("1 an UNCAPPED key admits well past any limit (5/5 → 202)", uncappedOk && db.countInFlightRunsForKey(UNCAPPED.key.id) === 5);

  // an idempotency REPLAY is NOT capped: fill the cap, then replay an EXISTING (key,idempotencyKey) → 202.
  const idemKey = mk({ maxConcurrentRuns: 1, dailyTokenCap: null, dailySpendCap: null });
  const idem1 = await postRun(idemKey.plaintext, { ...body, idempotencyKey: "rep-1" });
  check("1b idempotent run started (key now at its cap of 1)", idem1.statusCode === 202 && db.countInFlightRunsForKey(idemKey.key.id) === 1);
  const idemNew = await postRun(idemKey.plaintext, { ...body, idempotencyKey: "rep-2" });
  check("1b a DIFFERENT idempotencyKey at the cap → 429 (would start a new run)", idemNew.statusCode === 429);
  const idemReplay = await postRun(idemKey.plaintext, { ...body, idempotencyKey: "rep-1" });
  check("1b a REPLAY of the existing run → 202 + SAME runId (caps run AFTER the idempotency replay)",
    idemReplay.statusCode === 202 && idemReplay.json().runId === idem1.json().runId);

  // =====================================================================================================
  // 2) DAILY TOKEN cap — best-effort sum of the run-usage `inputTokens` snapshot over the trailing 24h
  // =====================================================================================================
  // Seed two COMPLETED runs for TOK with usage totalling 120 (> the cap of 100), both within 24h.
  const seedUsage = (id, keyId, inputTokens, createdAt) => db.insertRun({
    id, projectId: "pMain", agentId: "aEndpoint", sessionId: null, keyId, status: "completed",
    input: null, schema: null, result: { ok: true }, usage: { inputTokens, turns: 1, model: "claude-opus-4-8" },
    transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null, createdAt, startedAt: createdAt, endedAt: createdAt,
  });
  seedUsage("tok-a", TOK.key.id, 60, isoAgo(1 * 60 * 60 * 1000));
  seedUsage("tok-b", TOK.key.id, 60, isoAgo(2 * 60 * 60 * 1000));
  check("2 sumKeyTokensSince sums the in-window usage (120)", db.sumKeyTokensSince(TOK.key.id, isoAgo(DAY)) === 120);
  const tokOver = await postRun(TOK.plaintext, body);
  check("2 at/over the daily token cap → 429 { daily token cap reached }", tokOver.statusCode === 429 && tokOver.json().error === "daily token cap reached");

  // usage OUTSIDE the 24h window does not count: a key whose 120 tokens are 2 DAYS old is UNDER the cap.
  const TOKOLD = mk({ maxConcurrentRuns: null, dailyTokenCap: 100, dailySpendCap: null });
  seedUsage("old-a", TOKOLD.key.id, 120, isoAgo(2 * DAY));
  check("2 stale usage (2 days old) is excluded from the 24h window (sum = 0)", db.sumKeyTokensSince(TOKOLD.key.id, isoAgo(DAY)) === 0);
  const tokUnder = await postRun(TOKOLD.plaintext, body);
  check("2 under the daily token cap (stale usage excluded) → 202", tokUnder.statusCode === 202);

  // =====================================================================================================
  // 3) KILL-SWITCH — cancel ALL in-flight runs for the key, pause it, then block new runs
  // =====================================================================================================
  const k1 = await postRun(KILL.plaintext, body);
  const k2 = await postRun(KILL.plaintext, body);
  check("3 two runs in flight for the kill-target key", db.countInFlightRunsForKey(KILL.key.id) === 2 && k1.statusCode === 202 && k2.statusCode === 202);
  cancelCalls.length = 0;
  const killed = await app.inject({ method: "POST", url: `/api/keys/${KILL.key.id}/kill` });
  check("3 kill → 200 { cancelled: 2 }", killed.statusCode === 200 && killed.json().cancelled === 2);
  check("3 cancelRun invoked for BOTH in-flight runs", cancelCalls.includes(k1.json().runId) && cancelCalls.includes(k2.json().runId));
  check("3 the key is now PAUSED", db.getApiKey(KILL.key.id).status === "paused");
  check("3 no run remains in flight for the key", db.countInFlightRunsForKey(KILL.key.id) === 0);
  const afterKill = await postRun(KILL.plaintext, body);
  check("3 a paused (killed) key BLOCKS new runs → 403", afterKill.statusCode === 403);
  const reKill = await app.inject({ method: "POST", url: `/api/keys/${KILL.key.id}/kill` });
  check("3 re-kill is idempotent → 200 { cancelled: 0 }, still paused", reKill.statusCode === 200 && reKill.json().cancelled === 0 && db.getApiKey(KILL.key.id).status === "paused");
  const killUnknown = await app.inject({ method: "POST", url: `/api/keys/does-not-exist/kill` });
  check("3 kill on an unknown key → 404", killUnknown.statusCode === 404);

  // =====================================================================================================
  // 4) HUMAN run REST — UNAUTHED loopback, project-scoped, full rows; NOT key-gated
  // =====================================================================================================
  // The human list is PROJECT-scoped (across every key), unlike the key-authed own-run GET.
  const list = await app.inject({ method: "GET", url: `/api/projects/pMain/runs` }); // NO Authorization header
  check("4 GET /api/projects/:id/runs → 200 WITHOUT a Bearer (NOT key-gated)", list.statusCode === 200 && Array.isArray(list.json()));
  const rows = list.json();
  const keyIdsSeen = new Set(rows.map((r) => r.keyId));
  check("4 the list spans MULTIPLE keys (project-scoped, not key-scoped)", keyIdsSeen.size >= 3);
  check("4 newest-first ordering", rows.length >= 2 && rows[0].createdAt >= rows[rows.length - 1].createdAt);
  const full = rows.find((r) => r.id === "tok-a");
  check("4 each run is the FULL human view (id/agentId/keyId/status/input/result/usage/timestamps)",
    !!full && full.agentId === "aEndpoint" && full.keyId === TOK.key.id && full.status === "completed" &&
    full.usage?.inputTokens === 60 && full.result?.ok === true && typeof full.createdAt === "string");

  // contrast: the R3 key-authed GET /api/runs/:id 401s WITHOUT a Bearer — proving the human route is a
  // DISTINCT, unauthed surface (not the key-authed path).
  const keyAuthedNoBearer = await app.inject({ method: "GET", url: `/api/runs/tok-a` });
  check("4 the key-authed GET /api/runs/:id still 401s without a Bearer (distinct surfaces)", keyAuthedNoBearer.statusCode === 401);

  // GET one — full row; wrong project → 404; unknown → 404.
  const getOne = await app.inject({ method: "GET", url: `/api/projects/pMain/runs/tok-a` });
  check("4 GET one run (own project) → 200 full row", getOne.statusCode === 200 && getOne.json().id === "tok-a" && getOne.json().keyId === TOK.key.id);
  const getWrongProject = await app.inject({ method: "GET", url: `/api/projects/pOther/runs/tok-a` });
  check("4 GET a run via the WRONG project → 404", getWrongProject.statusCode === 404);
  const getUnknownRun = await app.inject({ method: "GET", url: `/api/projects/pMain/runs/nope` });
  check("4 GET an unknown run → 404", getUnknownRun.statusCode === 404);
  const listMissingProject = await app.inject({ method: "GET", url: `/api/projects/nope/runs` });
  check("4 GET runs for an unknown project → 404", listMissingProject.statusCode === 404);

  // POST cancel — reuses cancelRun; wrong project → 404.
  const liveForCancel = await postRun(UNCAPPED.plaintext, body); // a fresh in-flight run
  const liveId = liveForCancel.json().runId;
  cancelCalls.length = 0;
  const humanCancel = await app.inject({ method: "POST", url: `/api/projects/pMain/runs/${liveId}/cancel` });
  check("4 human cancel → 200 cancelled + cancelRun invoked", humanCancel.statusCode === 200 && humanCancel.json().status === "cancelled" && cancelCalls.includes(liveId));
  const cancelWrongProject = await app.inject({ method: "POST", url: `/api/projects/pOther/runs/${liveId}/cancel` });
  check("4 human cancel via the WRONG project → 404", cancelWrongProject.statusCode === 404);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs R4a: per-key concurrency cap (429 at limit, replay-exempt, uncapped-unaffected) + best-effort daily token cap (24h usage-snapshot sum) + the kill-switch (cancel-all-in-flight + pause + block-new) + the human run REST (unauthed loopback, project-scoped full rows, NOT key-gated) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
