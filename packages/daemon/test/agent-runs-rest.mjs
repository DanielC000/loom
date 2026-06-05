import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs R3 — the PUBLIC key-authed run REST + job lifecycle (POST /api/runs, GET /api/runs/:id,
// POST /api/runs/:id/cancel, + terminal-state webhooks + idempotency). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, in the style of agent-runs-keys.mjs + agent-runs-primitive.mjs:
//   • PART A — the REST routes via the REAL buildServer driven by app.inject, with sessions.startRun /
//     cancelRun STUBBED (no pty/claude boots; the stub inserts the run row a real start would). Proves
//     the auth/authorize/idempotency/own-run-scope contract exactly.
//   • PART B — the run WEBHOOK + cancel teardown via a REAL SessionService against a FAKE pty (the
//     createPty seam) + a real temp git repo, with the webhook poster INJECTED (network-free). Proves a
//     terminal transition fires the bounded webhook and a refused/hung endpoint can't throw/wedge.
//   • PART C — the runs migration is ADDITIVE + IDEMPOTENT (a pre-R3 `runs` table backfills the new
//     columns on open; 3× re-open round-trips; the per-key idempotency unique index enforces).
//
// Covers the card's DoD: no key → 401; malformed/unknown/bad-secret → 401; paused/revoked → 403;
// agent-not-allowlisted → 403; happy path → 202 + runId + startRun called with {agentId,input,schema,
// keyId,webhook}; idempotency replay → SAME runId + startRun called ONCE; GET own → status/result; GET
// another key's run → 404; cancel non-terminal → cancelled + teardown; cancel terminal → no-op; webhook
// fires on a terminal transition to a local stub with a bounded timeout (refused doesn't wedge).
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-arrest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45392";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();

// A real temp git repo with a committed HEAD, so the REAL startRun in PART B can createRunSnapshot.
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs-rest test\n");
execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: repo });

try {
  // =====================================================================================================
  // PART A — the REST routes (auth / authorize / idempotency / own-run-scope) with startRun STUBBED
  // =====================================================================================================
  const dbA = new Db(path.join(tmpHome, "a.db"));
  dbA.insertProject({ id: "pMain", name: "Main", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbA.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
  dbA.insertAgent({ id: "aOther", projectId: "pMain", name: "Other Endpoint", startupPrompt: "x", position: 1, profileId: null, endpoint: true, ioSchema: null });
  dbA.insertAgent({ id: "aPlain", projectId: "pMain", name: "Build Agent", startupPrompt: "", position: 2, profileId: null });
  // keyA allowlists ONLY aEndpoint (not aOther). keyB is a DIFFERENT key (cross-key 404 scope).
  const mk = (allow) => dbA.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: allow, caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  const A = mk(["aEndpoint"]);
  const B = mk(["aEndpoint"]);
  const tokenA = A.plaintext, keyAId = A.key.id;
  const tokenB = B.plaintext, keyBId = B.key.id;

  // Stub sessions: startRun INSERTS the run row a real start would (so GET/idempotency see it) + records opts.
  const startCalls = [];
  const cancelCalls = [];
  let runSeq = 0;
  const fakeSessions = {
    startRun: async (opts) => {
      startCalls.push(opts);
      const id = `run-${++runSeq}`;
      dbA.insertRun({
        id, projectId: "pMain", agentId: opts.agentId, sessionId: `sess-${runSeq}`, keyId: opts.keyId ?? null,
        status: "running", input: opts.input, schema: opts.schema ?? null, result: null, usage: null,
        transcriptRef: null, error: null, webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
        createdAt: now, startedAt: now, endedAt: null,
      });
      return { run: dbA.getRun(id), session: { id: `sess-${runSeq}` } };
    },
    cancelRun: (runId) => {
      cancelCalls.push(runId);
      const r = dbA.getRun(runId);
      if (["completed", "failed", "timed_out", "cancelled"].includes(r.status)) return { status: r.status };
      dbA.failRun(runId, "cancelled by caller", "cancelled");
      return { status: "cancelled" };
    },
  };
  const stub = {};
  const app = await buildServer({ db: dbA, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const postRun = (token, payload) => app.inject({ method: "POST", url: "/api/runs", headers: token ? bearer(token) : {}, payload });

  // ---- auth: FAIL CLOSED (no key / malformed / unknown / bad-secret → 401; never starting a run) ----
  const noKey = await postRun(null, { agent: "aEndpoint", input: {} });
  check("A1 no key → 401 (and NO run started)", noKey.statusCode === 401 && startCalls.length === 0);
  const malformed = await postRun("not-a-loom-key", { agent: "aEndpoint", input: {} });
  check("A1 malformed token → 401", malformed.statusCode === 401);
  const unknown = await postRun(`lrk_${"x".repeat(36)}.deadbeef`, { agent: "aEndpoint", input: {} });
  check("A1 unknown key id → 401", unknown.statusCode === 401);
  const badSecret = await postRun(tokenA + "x", { agent: "aEndpoint", input: {} });
  check("A1 bad secret → 401", badSecret.statusCode === 401);
  // the three 401s must NOT leak WHICH failure (same opaque body).
  check("A1 401s do not distinguish malformed/unknown/bad-secret (same body)",
    malformed.body === unknown.body && unknown.body === badSecret.body);
  check("A1 still NO run started across every rejected auth", startCalls.length === 0);

  // ---- auth: paused / revoked → 403 (a valid secret on a deactivated key) ----
  dbA.updateApiKey(keyAId, { status: "paused" });
  const paused = await postRun(tokenA, { agent: "aEndpoint", input: {} });
  check("A2 paused key → 403", paused.statusCode === 403);
  dbA.updateApiKey(keyAId, { status: "revoked" });
  const revoked = await postRun(tokenA, { agent: "aEndpoint", input: {} });
  check("A2 revoked key → 403", revoked.statusCode === 403);
  dbA.updateApiKey(keyAId, { status: "active" });
  check("A2 paused/revoked started NO run", startCalls.length === 0);

  // ---- authorize: the agent must be on THIS key's allowlist (else 403) ----
  const notAllowed = await postRun(tokenA, { agent: "aOther", input: {} }); // endpoint, but not on keyA's allowlist
  check("A3 endpoint agent NOT on this key's allowlist → 403", notAllowed.statusCode === 403);
  const plainAgent = await postRun(tokenA, { agent: "aPlain", input: {} }); // non-endpoint → also not allowlisted
  check("A3 non-endpoint agent → 403", plainAgent.statusCode === 403);
  const unknownAgent = await postRun(tokenA, { agent: "nope", input: {} });
  check("A3 unknown agent id → 403", unknownAgent.statusCode === 403);
  const missingAgent = await postRun(tokenA, { input: {} });
  check("A3 missing agent → 400", missingAgent.statusCode === 400);
  check("A3 every authorize-rejection started NO run", startCalls.length === 0);

  // ---- happy path: 202 + runId; startRun called with the right {agentId,input,schema,keyId,webhook} ----
  const happy = await postRun(tokenA, { agent: "aEndpoint", input: { q: "hi" }, schema: { type: "object" }, webhook: "http://localhost:9/hook" });
  check("A4 happy path → 202 + { runId }", happy.statusCode === 202 && typeof happy.json().runId === "string");
  check("A4 startRun called EXACTLY once", startCalls.length === 1);
  const c = startCalls[0];
  check("A4 startRun got {agentId,input,schema,keyId,webhook}",
    c.agentId === "aEndpoint" && c.input?.q === "hi" && c.schema?.type === "object" && c.keyId === keyAId && c.webhook === "http://localhost:9/hook");
  const happyRunId = happy.json().runId;

  // ---- idempotency: a replay returns the SAME runId and starts NO second run ----
  const idemPayload = { agent: "aEndpoint", input: { n: 1 }, idempotencyKey: "abc-123" };
  const i1 = await postRun(tokenA, idemPayload);
  check("A5 first idempotent POST → 202", i1.statusCode === 202);
  const startCountAfterFirst = startCalls.length;
  const i2 = await postRun(tokenA, idemPayload);
  check("A5 replay → 202 + the SAME runId", i2.statusCode === 202 && i2.json().runId === i1.json().runId);
  check("A5 replay started NO second run (startRun NOT called again)", startCalls.length === startCountAfterFirst);
  // a DIFFERENT key with the SAME idempotencyKey is a distinct dispatch (per-key scope) → a new run.
  const i3 = await postRun(tokenB, idemPayload);
  check("A5 same idempotencyKey on a DIFFERENT key → a NEW run (per-key scope)",
    i3.statusCode === 202 && i3.json().runId !== i1.json().runId);

  // ---- GET own run → status/result; another key's run → 404; unknown → 404 ----
  dbA.recordRunResult(happyRunId, { answer: 42 }); // complete it so GET surfaces a result
  const getOwn = await app.inject({ method: "GET", url: `/api/runs/${happyRunId}`, headers: bearer(tokenA) });
  check("A6 GET own run → 200 with status + result", getOwn.statusCode === 200 && getOwn.json().status === "completed" && getOwn.json().result?.answer === 42);
  const getOther = await app.inject({ method: "GET", url: `/api/runs/${happyRunId}`, headers: bearer(tokenB) });
  check("A6 GET another key's run → 404 (own-run-scoped; existence not revealed)", getOther.statusCode === 404);
  const getNoAuth = await app.inject({ method: "GET", url: `/api/runs/${happyRunId}` });
  check("A6 GET with no key → 401", getNoAuth.statusCode === 401);
  const getUnknown = await app.inject({ method: "GET", url: `/api/runs/does-not-exist`, headers: bearer(tokenA) });
  check("A6 GET unknown run id → 404", getUnknown.statusCode === 404);

  // ---- cancel non-terminal → cancelled + teardown(cancelRun) invoked; terminal → no-op; cross-key → 404 ----
  const live = await postRun(tokenA, { agent: "aEndpoint", input: {} });
  const liveRunId = live.json().runId;
  const cancel1 = await app.inject({ method: "POST", url: `/api/runs/${liveRunId}/cancel`, headers: bearer(tokenA) });
  check("A7 cancel a non-terminal run → cancelled + cancelRun invoked",
    cancel1.statusCode === 200 && cancel1.json().status === "cancelled" && cancelCalls.includes(liveRunId));
  const cancel2 = await app.inject({ method: "POST", url: `/api/runs/${liveRunId}/cancel`, headers: bearer(tokenA) });
  check("A7 cancel an already-terminal run → idempotent no-op (still cancelled)", cancel2.statusCode === 200 && cancel2.json().status === "cancelled");
  const cancelOther = await app.inject({ method: "POST", url: `/api/runs/${liveRunId}/cancel`, headers: bearer(tokenB) });
  check("A7 cancel another key's run → 404", cancelOther.statusCode === 404);

  await app.close();
  dbA.close();

  // =====================================================================================================
  // PART B — the run WEBHOOK + cancel teardown via a REAL SessionService + FAKE pty (poster INJECTED)
  // =====================================================================================================
  const dbB = new Db(path.join(tmpHome, "b.db"));
  dbB.insertProject({ id: "pRun", name: "RunProj", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbB.insertAgent({ id: "agentEndpoint", projectId: "pRun", name: "Analyst", startupPrompt: "DOCTRINE", position: 0, profileId: null, endpoint: true, ioSchema: null });

  // fake pty (createPty seam) — capture spawn opts, record graceful stops, deliver exits on demand.
  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; this.exitCbs = new Map(); this.stops = []; }
    createPty(opts) {
      this.capture.push(opts);
      const self = this;
      return {
        pid: 4242, write() {},
        onData() { return { dispose() {} }; },
        onExit(cb) { self.exitCbs.set(opts.sessionId, cb); return { dispose() {} }; },
        kill() { const cb = self.exitCbs.get(opts.sessionId); if (cb) cb({ exitCode: 0 }); },
        resize() {},
      };
    }
    stop(sessionId, mode) { this.stops.push({ sessionId, mode }); super.stop(sessionId, mode); }
    fireExit(sessionId, code = 0) { const cb = this.exitCbs.get(sessionId); if (cb) cb({ exitCode: code }); }
  }
  // events sink wired like index.ts: onExit OWNS live→exited AND finalizes a run session (→ fires webhook).
  let svcB;
  const events = {
    onEngineSessionId(id, eng) { dbB.setEngineSessionId(id, eng); },
    onBusy(id, busy) { dbB.setBusy(id, busy); },
    onContextStats(id, s) { dbB.setContextCounters(id, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns, model: s.model }); },
    onRateLimited() {},
    onExit(id) { dbB.setProcessState(id, "exited"); dbB.setBusy(id, false); const s = dbB.getSession(id); if (s?.role === "run") svcB.onRunSessionExit(id); },
  };
  const host = new SeamHost(events);
  // Injected webhook poster: record every delivery; a pinned timeout proves the bound is plumbed.
  const posted = [];
  let posterMode = "ok"; // "ok" | "reject"
  const poster = async (url, body, timeoutMs) => {
    posted.push({ url, body, timeoutMs });
    if (posterMode === "reject") throw new Error("connection refused");
  };
  svcB = new SessionService(dbB, host, new OrchestrationControl(), { runWebhookPost: poster, runWebhookTimeoutMs: 1234 });

  // (B1) a COMPLETED run fires the webhook with {runId,status:completed,result,error:null} + the bound.
  const r1 = await svcB.startRun({ agentId: "agentEndpoint", input: { q: 1 }, schema: null, keyId: "kB", webhook: "http://127.0.0.1:9/hook" });
  check("B1 startRun persisted the webhook url on the run row", dbB.getRun(r1.run.id).webhookUrl === "http://127.0.0.1:9/hook");
  svcB.submitRunResult(r1.session.id, { ok: true, value: 7 });
  host.fireExit(r1.session.id); // deliver the pty exit → onExit → onRunSessionExit → fireRunWebhook
  await sleep(20); // let the (already-resolved) delivery promise settle
  check("B1 a terminal transition fired EXACTLY one webhook", posted.length === 1);
  check("B1 webhook payload = { runId, status:'completed', result, error:null }",
    posted[0].body.runId === r1.run.id && posted[0].body.status === "completed" && posted[0].body.result?.value === 7 && posted[0].body.error === null);
  check("B1 the delivery is BOUNDED (the injected per-POST timeout is plumbed through)", posted[0].timeoutMs === 1234);

  // (B2) a run with NO webhook fires NOTHING (no-op).
  posted.length = 0;
  const r2 = await svcB.startRun({ agentId: "agentEndpoint", input: {}, schema: null, keyId: "kB" });
  svcB.submitRunResult(r2.session.id, { done: true });
  host.fireExit(r2.session.id);
  await sleep(20);
  check("B2 a run with NO webhookUrl fires no webhook", posted.length === 0);

  // (B3) a REFUSED webhook (poster rejects) does NOT throw/wedge teardown — the run still finalizes.
  posted.length = 0;
  posterMode = "reject";
  const r3 = await svcB.startRun({ agentId: "agentEndpoint", input: {}, schema: null, keyId: "kB", webhook: "http://127.0.0.1:9/down" });
  let threw = false;
  try { host.fireExit(r3.session.id); } catch { threw = true; } // exit BEFORE submit → run FAILED, webhook refused
  await sleep(20);
  check("B3 a refused webhook does NOT throw into the teardown path", threw === false);
  check("B3 the run still finalized terminally despite the refused webhook", dbB.getRun(r3.run.id).status === "failed");
  check("B3 the refused delivery WAS attempted (then swallowed)", posted.length >= 1 && posted.every((p) => p.body.status === "failed"));
  posterMode = "ok";

  // (B4) cancelRun on a LIVE run → cancelled + the R2 teardown (graceful stop) is invoked; the exit then
  //      fires the webhook with status=cancelled.
  posted.length = 0;
  const r4 = await svcB.startRun({ agentId: "agentEndpoint", input: {}, schema: null, keyId: "kB", webhook: "http://127.0.0.1:9/cancel" });
  host.stops.length = 0;
  const cancelled = svcB.cancelRun(r4.run.id);
  check("B4 cancelRun on a live run → status cancelled (terminal)", cancelled.status === "cancelled" && dbB.getRun(r4.run.id).status === "cancelled");
  check("B4 cancel tore down the run session via the graceful-stop path", host.stops.some((s) => s.sessionId === r4.session.id && s.mode === "graceful"));
  host.fireExit(r4.session.id); // the graceful stop's eventual pty exit
  await sleep(20);
  check("B4 the cancel webhook fired with status=cancelled", posted.length === 1 && posted[0].body.status === "cancelled" && posted[0].body.runId === r4.run.id);
  // (B5) cancelRun on an already-terminal run → idempotent no-op (no extra teardown).
  const cancelAgain = svcB.cancelRun(r4.run.id);
  check("B5 cancelRun on a terminal run → idempotent no-op (returns its state)", cancelAgain.status === "cancelled");

  dbB.close();

  // =====================================================================================================
  // PART C — the runs migration is ADDITIVE + IDEMPOTENT; the idempotency unique index enforces
  // =====================================================================================================
  // Hand-craft a PRE-R3 `runs` table (the R2 shape, WITHOUT webhook_url/idempotency_key) with a row.
  const legacyFile = path.join(tmpHome, "legacy.db");
  {
    const raw = new Database(legacyFile);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, profile_id TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        session_id TEXT, key_id TEXT, status TEXT NOT NULL DEFAULT 'queued', input_json TEXT NOT NULL DEFAULT 'null',
        schema_json TEXT, result_json TEXT, usage_json TEXT, transcript_ref TEXT, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
    `);
    raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,created_at) VALUES (?,?,?,?,?)").run("pL", "L", repo, repo, now);
    raw.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,?)").run("aL", "pL", "A", "hi", 0);
    raw.prepare("INSERT INTO runs (id,project_id,agent_id,status,input_json,created_at) VALUES (?,?,?,?,?,?)").run("rLegacy", "pL", "aL", "completed", '{"q":1}', now);
    raw.close();
  }
  let dbL = new Db(legacyFile);
  const mr = dbL.getRun("rLegacy");
  check("C migrateRuns backfills webhook_url → null on a legacy run", mr.webhookUrl === null);
  check("C migrateRuns backfills idempotency_key → null on a legacy run", mr.idempotencyKey === null);
  check("C the rest of the legacy run row is preserved (status/input intact)", mr.status === "completed" && mr.input?.q === 1);
  dbL.close();
  // Re-open TWICE more → migration is a no-op (no throw), data intact.
  dbL = new Db(legacyFile); dbL.close();
  dbL = new Db(legacyFile);
  check("C re-opening the migrated DB 3× does not throw or lose the run", dbL.getRun("rLegacy")?.status === "completed");
  // EXACTLY one of each new column after repeated opens (no duplicate ADD COLUMN).
  {
    const raw = new Database(legacyFile, { readonly: true });
    const cols = raw.prepare("PRAGMA table_info(runs)").all().map((r) => r.name);
    const idx = raw.prepare("PRAGMA index_list(runs)").all().map((r) => r.name);
    raw.close();
    check("C idempotent: exactly one `webhook_url` + one `idempotency_key` column",
      cols.filter((x) => x === "webhook_url").length === 1 && cols.filter((x) => x === "idempotency_key").length === 1);
    check("C the per-key idempotency unique index exists", idx.includes("idx_runs_idempotency"));
  }
  // The unique index ENFORCES per-key idempotency: a second insert of the SAME (key_id, idempotency_key) throws…
  const insertRow = (id, keyId, idem) => dbL.insertRun({
    id, projectId: "pL", agentId: "aL", sessionId: null, keyId, status: "running", input: null, schema: null,
    result: null, usage: null, transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: idem,
    createdAt: now, startedAt: now, endedAt: null,
  });
  insertRow("r-k1-a", "k1", "dup");
  let dupThrew = false;
  try { insertRow("r-k1-a2", "k1", "dup"); } catch { dupThrew = true; }
  check("C unique index BLOCKS a duplicate (key_id, idempotency_key) insert", dupThrew);
  // …but the SAME idempotency_key under a DIFFERENT key is allowed (per-key scope), as are NULL keys.
  let distinctOk = true;
  try { insertRow("r-k2-a", "k2", "dup"); insertRow("r-null-1", null, null); insertRow("r-null-2", null, null); } catch { distinctOk = false; }
  check("C distinct key / NULL idempotency rows are allowed (partial per-key index)", distinctOk);
  check("C lookup returns the right run for (key_id, idempotency_key)", dbL.getRunByIdempotency("k1", "dup")?.id === "r-k1-a");
  dbL.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs R3: key-authed POST/GET/cancel (fail-closed 401/403, own-run-scope 404), idempotent no-double-spend, bounded best-effort webhooks (refused can't wedge), and an additive+idempotent runs migration with a per-key idempotency unique index — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
