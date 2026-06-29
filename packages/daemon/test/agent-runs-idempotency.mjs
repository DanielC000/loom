import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs #4 — IDEMPOTENCY-ON-FAILURE. A run for a (key_id, idempotency_key) pair that ended in a
// terminal FAILURE (failed | timed_out | cancelled) must NOT block a same-key retry: the replay lookup
// ignores it AND the unique partial index frees the pair (SQLite re-evaluates a partial index's
// predicate on UPDATE, so a run leaving running→failed drops out of the index). Successes + in-flight
// runs still replay (true Stripe-style idempotency preserved). HERMETIC + CLAUDE-FREE + NETWORK-FREE.
//   • PART A — POST /api/runs replay semantics via the REAL buildServer + app.inject, sessions.startRun
//     STUBBED (inserts the run row a real start would): completed→replays; running→replays;
//     failed/timed_out/cancelled→FRESH (and the insert is NOT rejected by the index); diff key→fresh.
//   • PART B — the DB-level invariant directly: a terminal-failure UPDATE frees the pair for re-insert,
//     while a non-failed (queued/starting/running/completed) run still holds it; and the migration
//     CONVERTS an existing DB carrying the OLD key-only index in place (drop-then-create).
//   • PART C — CONVERT-ONCE: migrate must not re-index on every boot. Spying on better-sqlite3 `exec`:
//     fresh→create; already-current→no DROP+CREATE (no-op); old→convert once, then next boot is a no-op.
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-idempotency.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ a sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-aridem-${Date.now()}-${process.pid}`);
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

// A real temp git repo with a committed HEAD (parity with the other agent-runs tests; unused by the stub).
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-runs-idempotency test\n");
execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: repo });

try {
  // =====================================================================================================
  // PART A — POST /api/runs replay semantics across terminal states (startRun STUBBED)
  // =====================================================================================================
  const dbA = new Db(path.join(tmpHome, "a.db"));
  dbA.insertProject({ id: "pMain", name: "Main", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbA.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
  const A = dbA.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: ["aEndpoint"], caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  const tokenA = A.plaintext, keyAId = A.key.id;

  // Stub sessions: startRun INSERTS the run row a real start would (status=running) so the unique index
  // is actually exercised on insert — and records each call so we can assert "started fresh" vs "replayed".
  const startCalls = [];
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
    cancelRun: (runId) => ({ status: dbA.getRun(runId)?.status }),
  };
  const stub = {};
  const app = await buildServer({ db: dbA, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const postRun = (idem) => app.inject({ method: "POST", url: "/api/runs", headers: { authorization: `Bearer ${tokenA}` }, payload: { agent: "aEndpoint", input: { n: 1 }, idempotencyKey: idem } });

  // ---- (a) a COMPLETED run for (key, idem) → a second POST REPLAYS the same runId, starts NO new run ----
  const c1 = await postRun("idem-complete");
  check("A(a) first POST → 202 + runId", c1.statusCode === 202 && typeof c1.json().runId === "string");
  dbA.recordRunResult(c1.json().runId, { ok: true }); // → status=completed
  const startsAfterC1 = startCalls.length;
  const c2 = await postRun("idem-complete");
  check("A(a) completed run → replays the SAME runId", c2.statusCode === 202 && c2.json().runId === c1.json().runId);
  check("A(a) completed-run replay started NO new run", startCalls.length === startsAfterC1);

  // ---- (b) an in-flight RUNNING run for (key, idem) → a second POST also REPLAYS (no double-start) ----
  const r1 = await postRun("idem-running"); // the stub leaves it status=running
  check("A(b) first POST → 202 + runId", r1.statusCode === 202);
  const startsAfterR1 = startCalls.length;
  const r2 = await postRun("idem-running");
  check("A(b) running run → replays the SAME runId", r2.statusCode === 202 && r2.json().runId === r1.json().runId);
  check("A(b) running-run replay started NO new run", startCalls.length === startsAfterR1);

  // ---- (c) FAILED / TIMED_OUT / CANCELLED → a second POST starts a FRESH run (index does NOT reject) ----
  for (const [status, idem] of [["failed", "idem-failed"], ["timed_out", "idem-timeout"], ["cancelled", "idem-cancelled"]]) {
    const f1 = await postRun(idem);
    const firstId = f1.json().runId;
    // Drive the run terminal via the SAME path production uses (so the partial-index UPDATE re-eval is exercised).
    if (status === "timed_out" || status === "cancelled") dbA.failRun(firstId, `${status} by test`, status);
    else dbA.failRun(firstId, "failed by test"); // default status = "failed"
    check(`A(c) run driven to ${status}`, dbA.getRun(firstId).status === status);
    const startsBefore = startCalls.length;
    const f2 = await postRun(idem); // same (key, idem) — must NOT replay the failed run, must NOT be index-rejected
    check(`A(c) ${status} run → a FRESH run starts (new runId)`, f2.statusCode === 202 && f2.json().runId !== firstId);
    check(`A(c) ${status} run → startRun WAS called again (insert not rejected by the unique index)`, startCalls.length === startsBefore + 1);
  }

  // ---- (d) a DIFFERENT idempotency key always starts fresh ----
  const startsBeforeD = startCalls.length;
  const d1 = await postRun("idem-distinct-A");
  const d2 = await postRun("idem-distinct-B");
  check("A(d) different idem keys → two distinct fresh runs", d1.json().runId !== d2.json().runId && startCalls.length === startsBeforeD + 2);

  await app.close();
  dbA.close();

  // =====================================================================================================
  // PART B — the DB-level invariant + in-place migration of an existing DB carrying the OLD index
  // =====================================================================================================
  // Build a DB the way a PRE-#4 daemon left it: the OLD key-only partial index (no status predicate).
  const legacyFile = path.join(tmpHome, "legacy.db");
  {
    const raw = new Database(legacyFile);
    // The full R2 `runs` shape (so the real Db's other migrations are happy) WITH the post-R2 idempotency
    // columns already present, plus the OLD key-only partial index (no status predicate) a pre-#4 daemon left.
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'p', agent_id TEXT NOT NULL DEFAULT 'a',
        session_id TEXT, key_id TEXT, status TEXT NOT NULL DEFAULT 'queued', input_json TEXT NOT NULL DEFAULT 'null',
        schema_json TEXT, result_json TEXT, usage_json TEXT, transcript_ref TEXT, error TEXT,
        webhook_url TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT '', started_at TEXT, ended_at TEXT);
      CREATE UNIQUE INDEX idx_runs_idempotency ON runs(key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    // Under the OLD index, even a FAILED run would block a re-insert of the pair — seed one to prove conversion.
    raw.prepare("INSERT INTO runs (id,key_id,idempotency_key,status) VALUES (?,?,?,?)").run("rOldFailed", "k1", "idem", "failed");
    let blockedByOld = false;
    try { raw.prepare("INSERT INTO runs (id,key_id,idempotency_key,status) VALUES (?,?,?,?)").run("rOldRetry", "k1", "idem", "running"); }
    catch { blockedByOld = true; }
    check("B old key-only index BLOCKS a retry even after the run failed (the bug being fixed)", blockedByOld);
    raw.close();
  }
  // Opening with the migrated Db must DROP-then-CREATE the index with the new status predicate, converting in place.
  const dbL = new Db(legacyFile);
  {
    const raw = new Database(legacyFile, { readonly: true });
    const idxSql = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_idempotency'").get().sql;
    raw.close();
    check("B migration converted the index in place to include the status predicate",
      /status NOT IN \('failed','timed_out','cancelled'\)/.test(idxSql));
  }
  // The failed run no longer occupies the index → the retry insert now SUCCEEDS (the bug is fixed in the converted DB).
  const insertRow = (id, keyId, idem, status) => dbL.insertRun({
    id, projectId: "p", agentId: "a", sessionId: null, keyId, status, input: null, schema: null,
    result: null, usage: null, transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: idem,
    createdAt: now, startedAt: null, endedAt: null,
  });
  let retryOk = true;
  try { insertRow("rNewRetry", "k1", "idem", "running"); } catch { retryOk = false; }
  check("B after conversion a retry inserts cleanly past the FAILED run", retryOk);
  // …but TWO non-failed (running/completed) runs for the same pair still collide (uniqueness preserved for live/success).
  let liveCollides = false;
  try { insertRow("rNewRetry2", "k1", "idem", "running"); } catch { liveCollides = true; }
  check("B a SECOND live run for the same pair still collides (idempotency preserved for in-flight/success)", liveCollides);
  // getRunByIdempotency returns the LIVE run (skips the failed one) for the pair.
  check("B getRunByIdempotency skips the failed run, returns the live one", dbL.getRunByIdempotency("k1", "idem")?.id === "rNewRetry");
  // Now drive the live run terminal-failed → the pair frees again AND the lookup returns undefined.
  dbL.failRun("rNewRetry", "boom");
  check("B once the live run fails too, getRunByIdempotency → undefined (pair fully free)", dbL.getRunByIdempotency("k1", "idem") === undefined);
  let reInsertOk = true;
  try { insertRow("rNewRetry3", "k1", "idem", "running"); } catch { reInsertOk = false; }
  check("B a fresh run inserts again after all prior runs failed", reInsertOk);
  dbL.close();
  // Re-open round-trips: drop-then-create stays idempotent (no throw, index still converted).
  let dbR = new Db(legacyFile); dbR.close();
  dbR = new Db(legacyFile);
  check("B re-opening the converted DB does not throw and keeps the live run", dbR.getRun("rNewRetry3")?.status === "running");
  dbR.close();

  // =====================================================================================================
  // PART C — CONVERT-ONCE: migrate must not DROP+CREATE the idempotency index on EVERY boot. It rebuilt
  // the whole runs table on every daemon start; the fix reads the stored definition from sqlite_master and
  // only DROP+CREATEs when it differs (old predicate) or is absent (fresh). Spy on better-sqlite3 `exec`
  // to observe whether a given Db construction rebuilt the index.
  // =====================================================================================================
  const realExec = Database.prototype.exec;
  let execLog = [];
  Database.prototype.exec = function (sql) { execLog.push(String(sql)); return realExec.call(this, sql); };
  const droppedIdx = () => execLog.some((s) => /DROP INDEX IF EXISTS idx_runs_idempotency/.test(s));
  const createdIdx = () => execLog.some((s) => /CREATE UNIQUE INDEX idx_runs_idempotency/.test(s));
  const idxSqlOf = (file) => {
    const raw = new Database(file, { readonly: true });
    const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_idempotency'").get();
    raw.close();
    return row?.sql;
  };
  try {
    // ---- (1) FRESH DB → the index is CREATEd (no prior index to drop, but DROP IF EXISTS is harmless) ----
    const freshFile = path.join(tmpHome, "fresh.db");
    execLog = [];
    const dbF = new Db(freshFile);
    check("C(1) fresh DB → idempotency index created", createdIdx());
    check("C(1) fresh DB → index has the current status predicate",
      /status NOT IN \('failed','timed_out','cancelled'\)/.test(idxSqlOf(freshFile) ?? ""));
    dbF.close();

    // ---- (2) RE-OPEN an already-current DB → migrate does NOT DROP+CREATE (the convert-once no-op) ----
    execLog = [];
    const dbF2 = new Db(freshFile);
    check("C(2) already-current DB → NOT dropped on boot (no re-index)", !droppedIdx());
    check("C(2) already-current DB → NOT recreated on boot (no re-index)", !createdIdx());
    dbF2.close();

    // ---- (3) OLD key-only index → converts ONCE (DROP+CREATE); the next boot is a no-op ----
    const oldFile = path.join(tmpHome, "old-once.db");
    {
      const raw = new Database(oldFile);
      raw.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
          vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
        CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'p', agent_id TEXT NOT NULL DEFAULT 'a',
          session_id TEXT, key_id TEXT, status TEXT NOT NULL DEFAULT 'queued', input_json TEXT NOT NULL DEFAULT 'null',
          schema_json TEXT, result_json TEXT, usage_json TEXT, transcript_ref TEXT, error TEXT,
          webhook_url TEXT, idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT '', started_at TEXT, ended_at TEXT);
        CREATE UNIQUE INDEX idx_runs_idempotency ON runs(key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
      raw.close();
    }
    execLog = [];
    const dbO = new Db(oldFile);
    check("C(3) old index DB → converted once (DROP+CREATE)", droppedIdx() && createdIdx());
    check("C(3) converted index now carries the status predicate",
      /status NOT IN \('failed','timed_out','cancelled'\)/.test(idxSqlOf(oldFile) ?? ""));
    dbO.close();
    execLog = [];
    const dbO2 = new Db(oldFile);
    check("C(3) converted DB next boot → NOT rebuilt again (convert-once)", !droppedIdx() && !createdIdx());
    dbO2.close();
  } finally {
    Database.prototype.exec = realExec;
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs #4 idempotency-on-failure: a failed/timed_out/cancelled run neither replays nor blocks a same-key retry (lookup + partial index both status-conditioned), while completed/in-flight runs still replay; the OLD key-only index converts in place — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
