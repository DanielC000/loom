// Usage-limit EPISODE durability test (card 33d5aef1). The park itself was already durable
// (session_rate_limited, index.ts's onRateLimited — see pty-rate-limit-park-drain.mjs /
// usage-limit-weekly-sentinel.mjs, both now also assert the `detector` attribution this card added).
// This file covers everything AFTER the park that previously left no trace once the transient columns
// (rate_limited_until / rate_limit_deadline) and the global latch file cleared:
//
//   PART 1 (hermetic RateLimitWatcher, no daemon/claude — mirrors usage-limit-resume.mjs's makeEnv/seed):
//     resume → rate_limit_resumed + usage_latch_cleared{actor:"watcher"}; succeed → rate_limit_recovered
//     {actor:"watcher"}; bail (parked-past-deadline AND recovering-past-deadline) → rate_limit_bailed
//     {deadline} — the "most invisible and most consequential" outcome the card names.
//   PART 2 (real Fastify gateway in-process via buildServer, against a temp Db + stub pty — mirrors
//     rate-limit-cascade.mjs): the per-session manual clear route (POST /api/sessions/:id/rate-limit/
//     clear) records rate_limit_recovered + usage_latch_cleared{actor:"manual_session_clear"} — AND, as
//     an explicit POSITIVE CONTROL (DoD item 5), a clear against an ALREADY-UNPARKED session emits ZERO
//     new events rather than fabricating an episode that never happened.
//   PART 3: the same zero-events positive control for the GLOBAL clear-hold route
//     (POST /api/usage/clear-hold) when nothing was armed/parked. (The SUCCESS path for clear-hold —
//     latch armed, a manager genuinely parked — is already covered end-to-end by
//     usage-limit-spawn-wake.mjs's part (2), which asserts rate_limit_recovered{actor:"manual_global_
//     clear"} + usage_latch_cleared{actor:"manual_clear_hold"} AFTER the cascade has nulled both
//     transient columns and removed the latch file.)
//
// Every assertion below reads the event trail AFTER the transient state it describes has already been
// erased (rateLimitedUntil/rateLimitDeadline nulled, latch file removed) — reading it while still live
// would prove nothing about the bug this card fixes.
//
// RUN (no live daemon needed): node test/usage-limit-events.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================ PART 1 — RateLimitWatcher (hermetic) ============================
{
  const { Db } = await import("../dist/db.js");
  const { RateLimitWatcher } = await import("../dist/orchestration/rate-limit-watcher.js");

  function makeEnv() {
    const dbFile = path.join(os.tmpdir(), `loom-rlevents-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const db = new Db(dbFile);
    const now = new Date().toISOString();
    db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
    const alive = new Set();
    const pty = { isAlive: (id) => alive.has(id), resumeAfterRateLimit: () => true };
    return { dbFile, db, alive, watcher: new RateLimitWatcher({ db, pty }) };
  }
  function cleanupEnv(e) {
    try { e.db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
  function seed(e, id, o = {}) {
    const { state = "live", until = null, deadline = null, busy = false } = o;
    const now = new Date().toISOString();
    e.db.insertSession({
      id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: state, resumability: "unknown", busy, createdAt: now, lastActivity: now, lastError: null,
    });
    if (until !== null) e.db.setRateLimitedUntil(id, until, null);
    if (deadline !== null) e.db.armRateLimitDeadline(id, deadline);
    if (state === "live") e.alive.add(id);
  }
  const eventsFor = (e, id, kind) => e.db.listOrchestrationEventsBounded({ kind: [kind], sessionId: id, limit: 10, offset: 0 });

  // T1 — RESUME: reset passed → rate_limit_resumed + usage_latch_cleared{actor:"watcher"}, read AFTER
  // rate_limited_until has already gone back to null.
  {
    const e = makeEnv();
    const now = new Date();
    const deadline = new Date(now.getTime() + 60 * 60_000).toISOString();
    seed(e, "due", { until: new Date(now.getTime() - 1000).toISOString(), deadline });
    e.watcher.tick(now);
    check("T1 resume: park actually cleared before we read the trail", e.db.getSession("due").rateLimitedUntil === null);
    const resumed = eventsFor(e, "due", "rate_limit_resumed");
    check("T1 resume: rate_limit_resumed recorded exactly once", resumed.total === 1);
    const latch = eventsFor(e, "due", "usage_latch_cleared");
    check("T1 resume: usage_latch_cleared recorded, attributed to the watcher", latch.total === 1 && latch.items[0]?.detail?.actor === "watcher");
    cleanupEnv(e);
  }

  // T2 — SUCCEED: recovering & idle → rate_limit_recovered{actor:"watcher"}, read AFTER
  // rate_limit_deadline has already gone back to null (the episode-resolved column).
  {
    const e = makeEnv();
    const now = new Date();
    seed(e, "recovered", { until: null, deadline: new Date(now.getTime() + 60 * 60_000).toISOString(), busy: false });
    e.watcher.tick(now);
    check("T2 succeed: episode deadline actually cleared before we read the trail", e.db.getSession("recovered").rateLimitDeadline === null);
    const recovered = eventsFor(e, "recovered", "rate_limit_recovered");
    check("T2 succeed: rate_limit_recovered recorded exactly once, attributed to the watcher",
      recovered.total === 1 && recovered.items[0]?.detail?.actor === "watcher");
    cleanupEnv(e);
  }

  // T3 — BAIL while still parked (never resumed) → rate_limit_bailed{deadline}, the "most invisible and
  // most consequential" outcome named on the card. Read AFTER both transient columns are nulled.
  {
    const e = makeEnv();
    const now = new Date();
    const deadline = new Date(now.getTime() - 1000).toISOString();
    seed(e, "bail", { until: new Date(now.getTime() - 1000).toISOString(), deadline });
    e.watcher.tick(now);
    const s = e.db.getSession("bail");
    check("T3 bail: park + deadline actually cleared before we read the trail", s.rateLimitedUntil === null && s.rateLimitDeadline === null);
    const bailed = eventsFor(e, "bail", "rate_limit_bailed");
    check("T3 bail: rate_limit_bailed recorded exactly once", bailed.total === 1);
    check("T3 bail: detail carries the exceeded deadline", bailed.items[0]?.detail?.deadline === deadline);
    cleanupEnv(e);
  }

  // T4 — BAIL while recovering (a hung resume, past the deadline) → rate_limit_bailed too, same shape.
  {
    const e = makeEnv();
    const now = new Date();
    const deadline = new Date(now.getTime() - 1000).toISOString();
    seed(e, "hung", { until: null, deadline, busy: true });
    e.watcher.tick(now);
    const bailed = eventsFor(e, "hung", "rate_limit_bailed");
    check("T4 hung-bail: rate_limit_bailed recorded exactly once, after the deadline column cleared",
      e.db.getSession("hung").rateLimitDeadline === null && bailed.total === 1 && bailed.items[0]?.detail?.deadline === deadline);
    cleanupEnv(e);
  }
}

// ============================ PART 2 — per-session manual clear route ============================
{
  process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rlevents-gw-${Date.now()}`);
  fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
  const { requireHermeticEnv } = await import("./_guard.mjs");
  requireHermeticEnv();

  const { Db } = await import("../dist/db.js");
  const { buildServer } = await import("../dist/gateway/server.js");
  const { recordClaudeRateLimit, readClaudeUsageState } = await import("../dist/orchestration/usage-awareness.js");

  const dbFile = path.join(process.env.LOOM_HOME, "loom.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

  const alive = new Set();
  const pty = { isAlive: (id) => alive.has(id), resumeAfterRateLimit: (id) => alive.has(id) };
  const stub = {};
  const app = await buildServer({ db, pty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

  try {
    // T5 — a genuinely parked session (the common case: THIS session's own cap is what armed the global
    // latch) → the clear records BOTH events, attributed to the manual actor.
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const deadline = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    db.insertSession({ id: "parked1", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
    db.setRateLimitedUntil("parked1", future, `usage limit — resumes ${future}`);
    db.armRateLimitDeadline("parked1", deadline);
    recordClaudeRateLimit(); // this session's own cap armed the global latch too
    alive.add("parked1");

    const r5 = await app.inject({ method: "POST", url: "/api/sessions/parked1/rate-limit/clear" });
    check("T5: 200 OK", r5.statusCode === 200);
    const s5 = db.getSession("parked1");
    check("T5: park columns actually cleared before we read the trail", s5.rateLimitedUntil === null && s5.rateLimitDeadline === null);
    const recovered5 = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], sessionId: "parked1", limit: 10, offset: 0 });
    check("T5: rate_limit_recovered recorded, attributed to manual_session_clear",
      recovered5.total === 1 && recovered5.items[0]?.detail?.actor === "manual_session_clear");
    const latch5 = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], sessionId: "parked1", limit: 10, offset: 0 });
    check("T5: usage_latch_cleared recorded, attributed to manual_session_clear",
      latch5.total === 1 && latch5.items[0]?.detail?.actor === "manual_session_clear");

    // T6 — POSITIVE CONTROL (DoD item 5): a session that was NEVER parked → the SAME route must emit
    // ZERO events, not fabricate an episode. Prove the check can distinguish the two cases, not just
    // return zero unconditionally — T5 (above) is the known-positive proving the check CAN see events.
    db.insertSession({ id: "neverparked", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
    alive.add("neverparked");
    check("T6 setup: the control session was never parked", db.getSession("neverparked").rateLimitedUntil === null);

    const r6 = await app.inject({ method: "POST", url: "/api/sessions/neverparked/rate-limit/clear" });
    check("T6: clearing an already-unparked session is still 200 OK (no-op-safe)", r6.statusCode === 200);
    const recovered6 = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], sessionId: "neverparked", limit: 10, offset: 0 });
    check("T6 POSITIVE CONTROL: rate_limit_recovered is ZERO for a session that was never parked (no fabricated episode)", recovered6.total === 0);
    const latch6 = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], sessionId: "neverparked", limit: 10, offset: 0 });
    check("T6 POSITIVE CONTROL: usage_latch_cleared is ZERO for a session that was never parked", latch6.total === 0);

    // T6b — mgr #82 review finding: `wasParked` (this session) and the GLOBAL latch's own armed state are
    // INDEPENDENT — clearClaudeRateLimit() drops the latch unconditionally regardless of whether THIS
    // session was parked. A human clearing an unparked session while some OTHER session's cap armed the
    // latch still genuinely clears it, and that must be recorded. Neither T6 nor T7 can see this: T6 has
    // no latch armed, T7 has no session to clear — this is the ONE case where the two gates disagree.
    db.insertSession({ id: "unparked-armed-latch", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
    alive.add("unparked-armed-latch");
    check("T6b setup: the session itself is NOT parked", db.getSession("unparked-armed-latch").rateLimitedUntil === null);
    recordClaudeRateLimit(); // arm the GLOBAL latch — from some OTHER session's cap, unrelated to this one
    check("T6b setup: the global latch IS armed (the same signal the route's hadLatch gate reads)",
      readClaudeUsageState().lastRateLimitAt != null);

    const r6b = await app.inject({ method: "POST", url: "/api/sessions/unparked-armed-latch/rate-limit/clear" });
    check("T6b: 200 OK", r6b.statusCode === 200);
    const recovered6b = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], sessionId: "unparked-armed-latch", limit: 10, offset: 0 });
    check("T6b: rate_limit_recovered is ZERO (this session itself was never parked)", recovered6b.total === 0);
    const latch6b = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], sessionId: "unparked-armed-latch", limit: 10, offset: 0 });
    check("T6b: usage_latch_cleared recorded EXACTLY ONCE (the latch really was armed and really was dropped)",
      latch6b.total === 1 && latch6b.items[0]?.detail?.actor === "manual_session_clear");

    // T7 — POSITIVE CONTROL for the GLOBAL route: nothing armed, nothing parked → clear-hold must also
    // emit ZERO episode/latch events (the SUCCESS path — a genuinely parked manager — is already proven
    // end-to-end by usage-limit-spawn-wake.mjs's part (2), including reading the trail after teardown).
    check("T7 setup: nothing left parked before the no-op clear-hold", db.listRateLimited().length === 0);
    check("T7 setup: the global latch is NOT armed either (T6b's own clear already dropped it)", readClaudeUsageState().lastRateLimitAt == null);
    const beforeGlobalLatch = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], limit: 50, offset: 0 }).total;
    const beforeGlobalRecovered = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], limit: 50, offset: 0 }).total;
    const r7 = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
    check("T7: 200 OK with resumed:0", r7.statusCode === 200 && r7.json().resumed === 0);
    const afterGlobalLatch = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], limit: 50, offset: 0 }).total;
    const afterGlobalRecovered = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], limit: 50, offset: 0 }).total;
    check("T7 POSITIVE CONTROL: a no-op clear-hold adds ZERO usage_latch_cleared events", afterGlobalLatch === beforeGlobalLatch);
    check("T7 POSITIVE CONTROL: a no-op clear-hold adds ZERO rate_limit_recovered events", afterGlobalRecovered === beforeGlobalRecovered);

    // T8 — mgr #82 review (round 2): the GLOBAL route must mean the SAME thing by usage_latch_cleared as
    // the per-session route does — "the latch was armed and is now cleared," never "some row was also
    // parked." A row parked with NO latch armed (the latch already cleared some other way, or this row
    // was parked directly) must still get its own rate_limit_recovered (the row WAS genuinely parked),
    // but must NOT also fabricate a latch-cleared event that never happened.
    db.insertSession({ id: "parked-no-latch", projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
    const future8 = new Date(Date.now() + 60 * 60_000).toISOString();
    db.setRateLimitedUntil("parked-no-latch", future8, `usage limit — resumes ${future8}`);
    db.armRateLimitDeadline("parked-no-latch", new Date(Date.now() + 6 * 60 * 60_000).toISOString());
    alive.add("parked-no-latch");
    check("T8 setup: the row IS parked", db.listRateLimited().some((s) => s.id === "parked-no-latch"));
    check("T8 setup: the global latch is NOT armed", readClaudeUsageState().lastRateLimitAt == null);

    const r8 = await app.inject({ method: "POST", url: "/api/usage/clear-hold" });
    check("T8: 200 OK, resumed the parked row", r8.statusCode === 200 && r8.json().resumed === 1);
    const recovered8 = db.listOrchestrationEventsBounded({ kind: ["rate_limit_recovered"], sessionId: "parked-no-latch", limit: 10, offset: 0 });
    check("T8: rate_limit_recovered STILL recorded for the genuinely-parked row", recovered8.total === 1 && recovered8.items[0]?.detail?.actor === "manual_global_clear");
    const latch8 = db.listOrchestrationEventsBounded({ kind: ["usage_latch_cleared"], limit: 50, offset: 0 }).total;
    check("T8: usage_latch_cleared adds ZERO — a parked row is not a latch clear (the two routes must agree)", latch8 === afterGlobalLatch);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    for (let i = 0; i < 5; i++) { try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); break; } catch { /* retry (WAL handle) */ } }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the usage-limit episode leaves a complete, actor-attributed trail (resume/recovered/bailed, latch armed/cleared) that survives exactly the teardown that erases the transient session columns and the global latch file; a clear against an already-unparked session (or a no-op clear-hold) fabricates ZERO events."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
