import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card df9d1c71: a wake-mode event_triggers/poll_jobs/webhook_endpoints row stores a FIXED
// target_session_id (event_triggers/webhook_endpoints) or session_id (poll_jobs — same column, older
// name). Nothing re-pointed it on a recycle — db.ts had reparentWakes/reparentQuestions but no
// trigger/poll/webhook equivalent — so once the targeted session recycled, every fire called
// resume(predecessor), which resume() refuses once a successor exists (hasSuccessor), and the trigger/
// poll/webhook was dead for good while still reading enabled.
//
// MECHANISM CHOSEN: (a) reparent target_session_id/session_id alongside reparentWakes on EVERY recycle
// path — mirrors reparentWakes/reparentQuestions exactly (an unconditional row move at recycle time, not
// a lineage-walk at fire time). New db.ts methods: reparentEventTriggerTargets, reparentPollJobTargets
// (poll_jobs.session_id, NOT target_session_id — see that method's own doc), reparentWebhookTargets.
//
// EVERY RECYCLE PATH, grep-verified against `reparentWakes`/`reparentQuestions` call sites in the real
// tree (not trusted from the kickoff's own line-number hypotheses):
//   sessions/service.ts:
//     - recycleWorker (forward: workerSessionId -> fresh.id)               -- Scenario (W)
//     - recycleManager (forward: oldManagerId -> fresh.id)                 -- Scenario (M)
//     - recyclePlatformLead (forward: oldLeadId -> fresh.id)               -- Scenario (P)
//     - recoverFleetAfterFailedRecycleSuccessor (back: freshId -> oldId)   -- Scenario (F)
//     - finishReconcilingRecycleSettles's deferred loop (back: freshId -> predecessorId) -- Scenario (D')
//       (Code Review, df9d1c71: this bullet used to claim resume-refuses-retired-recycle-successor.mjs
//       already covered this site — it does NOT: that file has zero wake/question assertions, and its own
//       trigger is seeded AFTER the boot sequence runs, so it never observes a reparent. Scenario (D')
//       below is the only test that actually pins all five kinds — wakes/questions/triggers/polls/
//       webhooks — at this exact branch.)
//   sessions/recycle-settle-reconcile.ts:
//     - reconcileStrandedRecycleSettlesEarly (back: freshId -> predecessorId) -- Scenario (E)
//
// RED->GREEN, THROUGH THE REAL SERVICE: Scenario (M) drives a REAL EventTriggerService.fire (and a REAL
// PollService.tick) against a REAL SessionService.resume — never a direct resume() call, never a stub for
// the thing under test. Run this file once against a REVERTED (pre-fix) db.ts/service.ts to see it go
// RED with the exact "session was recycled" refusal, then again against the real fix to see it go GREEN
// (see this card's worker_report for the exact revert/rebuild/restore commands used).
//
// Webhook (webhooks/ingress.ts's fireWebhookTarget) is NOT exported and not driven live here — its
// wake-mode branch is read-verified to be BYTE-IDENTICAL in shape to EventTriggerService.fire/
// PollService.fire (`if (!deps.pty.isAlive(sessionId)) await deps.sessions.resume(sessionId)`), so the
// SAME resume()-refusal bug and the SAME db-row fix apply; this file proves webhook_endpoints.target_
// session_id itself is reparented at every path (DB-level, Scenarios M/W/P/F/D'/E all assert it).
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: a REAL Db + SessionService + PtyHost driven against a FAKE
// low-level pty (the shared createPty() seam, _seam-host-fixture.mjs) — mirrors recycle-manager-fleet-
// recovery.mjs's own harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/recycle-carries-wake-targets.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rcwt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every recycle-settle bound BEFORE importing dist/** (mirrors recycle-manager-fleet-
// recovery.mjs) so the Scenario (F) settle loop resolves fast instead of the real ~55s+9s defaults.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "40";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { EventTriggerService } = await import("../dist/orchestration/event-triggers.js");
const { PollService } = await import("../dist/orchestration/poll.js");
const { reconcileStrandedRecycleSettlesEarly } = await import("../dist/sessions/recycle-settle-reconcile.js");
const { runBootRecoveryPrefix } = await import("../dist/sessions/boot-backstop.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}

let harnessSeq = 0;
const nextDbPath = () => path.join(tmpHome, `db-${harnessSeq++}.db`);
// `dbPath` is optional and returned — Scenario (D') needs it to reopen the SAME file for its "restart"
// (a second Db() against a file this harness already opened), mirroring recycle-settle-lost-to-
// restart.mjs's own restart-simulation contract.
function makeHarness(dbPath = nextDbPath()) {
  // Db's default `file` param is a FIXED path (LOOM_HOME/loom.db) — every scenario needs its OWN db file,
  // or EventTriggerService.tick()/PollService.tick() (which scan the WHOLE table) pick up prior
  // scenarios' still-present trigger/poll rows too, contaminating resumeCalls/enqueued assertions.
  const db = new Db(dbPath);
  let sessions;
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id, code, info) {
      db.setProcessState(id, "exited");
      db.setBusy(id, false);
      const exited = db.getSession(id);
      if (exited) sessions.archiveOnExit(exited);
      if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
    },
  };
  const host = new SeamHost(events);
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions, dbPath };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  const repo = path.join(tmpHome, `repo-${id}`);
  fs.mkdirSync(repo, { recursive: true });
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
  return { repo, now };
}

/** Seeds a wake-mode event_trigger + poll_job + webhook_endpoint, all targeting `targetSessionId`. */
function seedWakeTargets(db, tag, projectId, targetSessionId) {
  const now = new Date().toISOString();
  db.insertEventTrigger({
    id: `${tag}-trig`, eventKind: "worker_report", projectId: null, mode: "wake",
    targetSessionId, agentId: null, enabled: true, lastSeq: db.getMaxEventSeq(), lastFiredAt: null, createdAt: now,
  });
  const conn = db.createConnection({ name: `${tag}-conn`, host: "api.example.com", authScheme: "bearer", secretBlob: "irrelevant-ciphertext" });
  db.insertPollJob({
    id: `${tag}-poll`, connectionId: conn.id, path: "/items", method: "GET", intervalMs: 60_000,
    nextPollAt: new Date(Date.now() - 1000).toISOString(), lastPolledAt: null, itemsPath: "items", idPath: "id",
    // Pre-baselined (never null) so a tick against it FIRES on a fresh item instead of the first-poll
    // baseline-seed-and-fire-nothing path (mirrors poll.mjs's own "already polled once" fixtures).
    cursorJson: "[]", mode: "wake", sessionId: targetSessionId, agentId: null, enabled: true,
    consecutiveFailures: 0, lastError: null, createdAt: now,
  });
  const webhook = db.createWebhookEndpoint({
    path: `${tag}-hook-${randomUUID().slice(0, 8)}`, name: `${tag}-hook`, sourceType: "generic",
    secretBlob: "irrelevant-ciphertext", mode: "wake", targetSessionId, agentId: null,
  });
  return { triggerId: `${tag}-trig`, pollId: `${tag}-poll`, webhookId: webhook.id };
}
const emitMatchingEvent = (db, managerSessionId) =>
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId, workerSessionId: null, taskId: null, kind: "worker_report", detail: { status: "blocked" } });

try {
  // ==================== (M) recycleManager — FORWARD reparent, RED->GREEN through the real service ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rcwt-m";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const targets = seedWakeTargets(db, "m", P, m1.id);
    check("(M pre) all three wake targets point at the PREDECESSOR", db.getEventTrigger(targets.triggerId).targetSessionId === m1.id
      && db.getPollJob(targets.pollId).sessionId === m1.id && db.getWebhookEndpoint(targets.webhookId).targetSessionId === m1.id);

    const m2 = await sessions.recycleManager(m1.id, "handoff — carry the wake targets");
    check("(M) recycleManager minted a NEW session id", m2.id !== m1.id);

    check("(M) FIX: the event-trigger target moved onto the SUCCESSOR (not copied — the old id is gone)",
      db.getEventTrigger(targets.triggerId).targetSessionId === m2.id);
    check("(M) FIX: the poll-job target moved onto the SUCCESSOR (poll_jobs.session_id, not target_session_id)",
      db.getPollJob(targets.pollId).sessionId === m2.id);
    check("(M) FIX: the webhook-endpoint target moved onto the SUCCESSOR", db.getWebhookEndpoint(targets.webhookId).targetSessionId === m2.id);

    // Simulate the predecessor's real end-state: settleRecycleHandoff always eventually stops M1 once M2
    // proves itself (or recovers the fleet if M2 dies — Scenario F below). Kill its fake pty directly here
    // (mirrors Scenario F's own m2Pty.kill()) for determinism rather than waiting on the real settle
    // timing/hook choreography (that machinery is covered by recycle-manager-fleet-recovery.mjs; this
    // test's own concern is the wake-target reparent) — host.stop()'s default "clean" mode writes a
    // graceful Ctrl-C sequence instead of killing synchronously, which would leave M1 looking alive here.
    host.handles.get(m1.id).kill();
    check("(M setup) predecessor is no longer alive (its normal end state)", host.isAlive(m1.id) === false);
    check("(M setup) the successor IS alive", host.isAlive(m2.id) === true);

    // ---- REAL EventTriggerService.fire, driving REAL SessionService.resume ----
    {
      const capture = { lastError: undefined };
      const resumeCalls = [];
      const resume = (id) => { resumeCalls.push(id); try { return sessions.resume(id); } catch (e) { capture.lastError = e; throw e; } };
      const enqueued = [];
      const pty = { isAlive: (id) => host.isAlive(id), enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ id, kind }); return { delivered: true }; } };
      const svc = new EventTriggerService({ db, pty, control: new OrchestrationControl(), resume, spawn: () => { throw new Error("not used"); } });
      emitMatchingEvent(db, m2.id); // filed under a still-existing session so project scoping resolves
      await svc.tick(new Date());
      // M2 stays alive throughout (never stopped in this scenario) -> no resume() call is even needed to
      // deliver; the load-bearing assertion is that resume is NEVER attempted against the dead M1 (the
      // pre-fix bug: the target still pointed at M1, so this always fired, and always threw).
      check("(M) FIX: resume was NEVER attempted against the retired predecessor", !resumeCalls.includes(m1.id));
      check("(M) FIX: no refusal was thrown (the pre-fix bug: resume(predecessor) -> hasSuccessor refusal)", capture.lastError === undefined);
      check("(M) FIX: the turn actually reached the successor", enqueued.some((e) => e.id === m2.id));
      check("(M) FIX: nothing was ever enqueued to the retired predecessor", enqueued.every((e) => e.id !== m1.id));
    }

    // ---- REAL PollService.tick, driving REAL SessionService.resume ----
    {
      const capture = { lastError: undefined };
      const resumeCalls = [];
      const resume = (id) => { resumeCalls.push(id); try { return sessions.resume(id); } catch (e) { capture.lastError = e; throw e; } };
      const enqueued = [];
      const pty = { isAlive: (id) => host.isAlive(id), enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ id, kind }); return { delivered: true }; } };
      const request = async () => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [{ id: "item-1" }] }) });
      const enqueueDurable = (id, text, ctx) => pty.enqueueStdin(id, text, "system", undefined, undefined, ctx.kind);
      const svc = new PollService({ db, pty, control: new OrchestrationControl(), resume, spawn: () => { throw new Error("not used"); }, request, enqueueDurable, isUsageLimited: () => false });
      await svc.tick(new Date());
      check("(M) poll FIX: resume was NEVER attempted against the retired predecessor", !resumeCalls.includes(m1.id));
      check("(M) poll FIX: no refusal was thrown", capture.lastError === undefined);
      check("(M) poll FIX: the turn actually reached the successor", enqueued.some((e) => e.id === m2.id));
    }
  }

  // ==================== (W) recycleWorker — FORWARD reparent, worker as a valid wake target ====================
  // @decision df9d1c71 — a wake-mode target has NO role restriction at REST create time (gateway/server.ts's
  // validateEventTriggerTarget only checks the session exists), so a worker is a structurally valid target
  // exactly like a manager/platform session — this path must carry the reparent too.
  {
    const { db, host, sessions } = makeHarness();
    const P = "rcwt-w";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const now = new Date().toISOString();
    const wkr = "rcwt-w-worker";
    db.insertTask({ id: "rcwt-w-task", projectId: P, title: "t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({
      id: wkr, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-w", title: null, cwd: db.getProject(P).repoPath,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "worker", parentSessionId: m1.id, taskId: "rcwt-w-task", worktreePath: db.getProject(P).repoPath, branch: "loom/rcwt-w",
    });
    host.handles.set(wkr, host.createPty({ sessionId: wkr })); // give the DB-seeded worker a live fake pty too
    const targets = seedWakeTargets(db, "w", P, wkr);

    const w2 = await sessions.recycleWorker(m1.id, wkr, "handoff — carry the wake targets");
    check("(W) recycleWorker minted a NEW session id", w2.id !== wkr);
    check("(W) FIX: the event-trigger target moved onto the worker's SUCCESSOR", db.getEventTrigger(targets.triggerId).targetSessionId === w2.id);
    check("(W) FIX: the poll-job target moved onto the worker's SUCCESSOR", db.getPollJob(targets.pollId).sessionId === w2.id);
    check("(W) FIX: the webhook target moved onto the worker's SUCCESSOR", db.getWebhookEndpoint(targets.webhookId).targetSessionId === w2.id);
  }

  // ==================== (P) recyclePlatformLead — FORWARD reparent ====================
  {
    const { db, sessions } = makeHarness();
    const P = "rcwt-p";
    seedProject(db, P);
    const l1 = sessions.startPlatformLead(`${P}-mgr`);
    const targets = seedWakeTargets(db, "p", P, l1.id);

    const l2 = await sessions.recyclePlatformLead(l1.id, "handoff — carry the wake targets");
    check("(P) recyclePlatformLead minted a NEW session id", l2.id !== l1.id);
    check("(P) FIX: the event-trigger target moved onto the Lead's SUCCESSOR", db.getEventTrigger(targets.triggerId).targetSessionId === l2.id);
    check("(P) FIX: the poll-job target moved onto the Lead's SUCCESSOR", db.getPollJob(targets.pollId).sessionId === l2.id);
    check("(P) FIX: the webhook target moved onto the Lead's SUCCESSOR", db.getWebhookEndpoint(targets.webhookId).targetSessionId === l2.id);
  }

  // ==================== (F) recoverFleetAfterFailedRecycleSuccessor — BACK reparent (successor dies before ready) ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rcwt-f";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    check("(F pre) M1 is alive", host.isAlive(m1.id));

    const m2 = await sessions.recycleManager(m1.id, "handoff — the successor dies before SessionStart");
    const targets = seedWakeTargets(db, "f", P, m2.id); // seeded onto M2 AFTER the recycle (mirrors recycle-manager-fleet-recovery.mjs's own cap-queue seeding rationale — isolates the REVERSE reparent under test from the pre-existing forward one)
    check("(F setup) wake targets sit on M2 pre-death", db.getEventTrigger(targets.triggerId).targetSessionId === m2.id);

    const m2Pty = host.handles.get(m2.id);
    m2Pty.kill(); // the trigger: M2 dies with no SessionStart, no ready marker

    const hasEvent = (kind) => db.listEventsForSession(m1.id).some((e) => e.kind === kind);
    const settled = await waitUntil(() => hasEvent("recycle_fleet_recovered") || hasEvent("recycle_fleet_unresolved"));
    check("(F) settle loop reached a terminal outcome", settled);
    check("(F) FIX: the recovered branch actually ran", hasEvent("recycle_fleet_recovered"));
    check("(F) FIX: the event-trigger target moved BACK onto the recovered predecessor M1", db.getEventTrigger(targets.triggerId).targetSessionId === m1.id);
    check("(F) FIX: the poll-job target moved BACK onto M1", db.getPollJob(targets.pollId).sessionId === m1.id);
    check("(F) FIX: the webhook target moved BACK onto M1", db.getWebhookEndpoint(targets.webhookId).targetSessionId === m1.id);
    check("(F) M1 was never stopped (still alive, still the legitimate owner)", host.isAlive(m1.id) === true);
  }

  // ==================== (D') finishReconcilingRecycleSettles's DEFERRED-FALLBACK — BACK reparent ====================
  // Code Review (df9d1c71): the ONLY prior test reaching this exact branch (service.ts's
  // finishReconcilingRecycleSettles, the early.deferred loop's NEVER-RESURRECT fallback) is recycle-
  // settle-lost-to-restart.mjs's own scenario (H) — and it asserts only the worker reparent
  // (reparentAllChildren) there, never wakes/questions/triggers/polls/webhooks. This scenario mirrors
  // (H)'s setup exactly — M2 durably reaches ready (reachedReadyAt set, so the EARLY phase classifies it
  // `deferred`, lineage left untouched), but its transcript is gone by boot time, so the LATER phase's
  // real resume(freshId) attempt fails and falls through to the SAME NEVER-RESURRECT recovery — and pins
  // all five kinds at this exact site: the two this card adds, plus wakes/questions as a sanity check that
  // this branch's pre-existing reparentWakes/reparentQuestions calls are genuinely exercised here too
  // (they never were, by any test, before this scenario).
  {
    const dbPath = nextDbPath();
    const { db: db1, host: host1, sessions: sessions1 } = makeHarness(dbPath);
    const P = "rcwt-dprime";
    seedProject(db1, P);
    db1.setProjectConfig(P, { permission: { startupModeCycles: 0 } }); // markReady runs SYNCHRONOUSLY off the hook below
    const m1 = sessions1.startManager(`${P}-mgr`);
    host1.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-dprime" });
    const engineDir1 = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(m1.cwd)));
    fs.mkdirSync(engineDir1, { recursive: true });
    fs.writeFileSync(path.join(engineDir1, "eng-m1-dprime.jsonl"), "");

    const m2 = await sessions1.recycleManager(m1.id, "handoff — the successor reaches ready but its transcript is gone by boot time");
    host1.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-dprime" });
    // Deliberately NO fake transcript for M2 (mirrors recycle-settle-lost-to-restart.mjs's own scenario
    // H): reachedReadyAt IS durably set, but the LATER phase's real resume(freshId) is the only thing
    // that can catch a transcript missing by boot time.
    check("(D' pre) M2 durably reached ready", db1.getSession(m2.id)?.reachedReadyAt != null);

    const targets = seedWakeTargets(db1, "dprime", P, m2.id); // seeded onto M2 AFTER the recycle
    const now = new Date().toISOString();
    db1.insertWake({ id: "dprime-wake", sessionId: m2.id, wakeAt: new Date(Date.now() + 3_600_000).toISOString(), note: "t", createdAt: now, route: null });
    db1.insertQuestion({ id: "dprime-q", sessionId: m2.id, projectId: P, title: "q", body: "b", state: "pending", createdAt: now });
    check("(D' setup) all five kinds sit on M2 pre-restart", db1.getEventTrigger(targets.triggerId).targetSessionId === m2.id
      && db1.getPollJob(targets.pollId).sessionId === m2.id && db1.getWebhookEndpoint(targets.webhookId).targetSessionId === m2.id
      && db1.listWakesForSession(m2.id).length === 1 && db1.listQuestionsForSession(m2.id).length === 1);

    db1.close();
    // "Restart": a fresh {Db, PtyHost} pair against the SAME db file (mirrors recycle-settle-lost-to-
    // restart.mjs's own restart simulation) — every in-process timer from boot 1 is gone, committed DB
    // state survives. NO SessionService constructed yet, matching index.ts's real boot order: it's built
    // only AFTER runBootRecoveryPrefix's derivation steps, never before.
    const db2 = new Db(dbPath);
    const host2 = new SeamHost({
      onEngineSessionId(id, eng) { db2.setEngineSessionId(id, eng); },
      onReady(id) { db2.setReachedReady(id); },
      onBusy(id, busy) { db2.setBusy(id, busy); },
      onContextStats() {}, onRateLimited() {},
    });
    const { early } = runBootRecoveryPrefix(db2);
    const sessions2 = new SessionService(db2, host2, new OrchestrationControl());
    const finish = sessions2.finishReconcilingRecycleSettles(early);

    check("(D') FIX: the deferred fallback recovered M1", finish.recoveredPredecessors.includes(m1.id));
    check("(D') FIX: the event-trigger target moved BACK onto the recovered predecessor M1", db2.getEventTrigger(targets.triggerId).targetSessionId === m1.id);
    check("(D') FIX: the poll-job target moved BACK onto M1", db2.getPollJob(targets.pollId).sessionId === m1.id);
    check("(D') FIX: the webhook target moved BACK onto M1", db2.getWebhookEndpoint(targets.webhookId).targetSessionId === m1.id);
    check("(D') sanity: the wake (pre-existing reparentWakes) moved BACK onto M1 — never independently pinned at this branch before", db2.listWakesForSession(m1.id).some((w) => w.id === "dprime-wake"));
    check("(D') sanity: the question (pre-existing reparentQuestions) moved BACK onto M1 — never independently pinned at this branch before", db2.listQuestionsForSession(m1.id).some((q) => q.id === "dprime-q"));
    db2.close();
  }

  // ==================== (E) reconcileStrandedRecycleSettlesEarly — BACK reparent, the boot-only DB-only pass ====================
  {
    const db = new Db(nextDbPath());
    const now = new Date().toISOString();
    const P = "rcwt-e";
    const repo = path.join(tmpHome, `repo-${P}`);
    fs.mkdirSync(repo, { recursive: true });
    db.insertProject({ id: P, name: P, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: `${P}-mgr`, projectId: P, name: "Mgr", startupPrompt: "MGR", position: 0 });

    const predId = "rcwt-e-pred", freshId = "rcwt-e-fresh";
    // Predecessor is DURABLY RESUMABLE (isDurablyResumable: engineSessionId set + a real transcript file +
    // an existing cwd) — mirrors resume-refuses-retired-recycle-successor.mjs's own fixture exactly.
    const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(repo)));
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, "eng-pred.jsonl"), "");
    db.insertSession({
      id: predId, projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-pred", title: null, cwd: repo,
      processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager",
    });
    // Successor NEVER reached ready (reachedReadyAt stays null) -> the early phase's "recovered" bucket.
    // insertRecycleSuccessor does its OWN insertSession (atomically, alongside stamping the durable
    // settle-pending marker on the predecessor) — do not pre-insert freshId, or this double-inserts it.
    db.insertRecycleSuccessor({
      id: freshId, projectId: P, agentId: `${P}-mgr`, engineSessionId: null, title: null, cwd: repo,
      processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager", recycledFrom: predId,
    }, predId);

    const targets = seedWakeTargets(db, "e", P, freshId);
    check("(E setup) wake targets sit on the never-started successor", db.getEventTrigger(targets.triggerId).targetSessionId === freshId);

    const result = reconcileStrandedRecycleSettlesEarly(db);
    check("(E) the row was classified 'recovered'", result.recovered.some((r) => r.predecessorId === predId && r.freshId === freshId));
    check("(E) FIX: the event-trigger target moved BACK onto the predecessor", db.getEventTrigger(targets.triggerId).targetSessionId === predId);
    check("(E) FIX: the poll-job target moved BACK onto the predecessor", db.getPollJob(targets.pollId).sessionId === predId);
    check("(E) FIX: the webhook target moved BACK onto the predecessor", db.getWebhookEndpoint(targets.webhookId).targetSessionId === predId);
    db.close();
  }

  // ==================== (N) NON-RECYCLED session: byte-identical behaviour ====================
  // A target aimed at a session that never recycles must fire exactly as before — the fix must not touch
  // this path at all (no reparent runs; nothing new gates or changes the ordinary fire).
  {
    const { db, host, sessions } = makeHarness();
    const P = "rcwt-n";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    const targets = seedWakeTargets(db, "n", P, m1.id);

    const resumeCalls = [];
    const enqueued = [];
    const pty = { isAlive: (id) => host.isAlive(id), enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ id, kind }); return { delivered: true }; } };
    const svc = new EventTriggerService({ db, pty, control: new OrchestrationControl(), resume: (id) => { resumeCalls.push(id); return sessions.resume(id); }, spawn: () => { throw new Error("not used"); } });
    emitMatchingEvent(db, m1.id);
    await svc.tick(new Date());
    check("(N) a non-recycled target: no resume needed (already alive)", resumeCalls.length === 0);
    check("(N) a non-recycled target: fires normally", enqueued.some((e) => e.id === m1.id));
    check("(N) a non-recycled target: the row's target is untouched", db.getEventTrigger(targets.triggerId).targetSessionId === m1.id);
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
} finally {
  console.log(failures === 0
    ? "\n✅ ALL PASS — a wake-mode event-trigger/poll-job/webhook-endpoint target is carried across a manager (M), worker (W), and platform-lead (P) recycle onto the successor's new session id (mirrors reparentWakes/reparentQuestions exactly), carried BACK onto the predecessor when a successor dies before taking over (F, the live recoverFleetAfterFailedRecycleSuccessor path; D', finishReconcilingRecycleSettles's deferred-loop NEVER-RESURRECT fallback — the one branch no other test pinned; and E, the boot-only reconcileStrandedRecycleSettlesEarly DB pass), proven through a REAL EventTriggerService.fire and a REAL PollService.tick driving the REAL SessionService.resume (M) — never a direct resume() call — and a target aimed at a session that never recycles fires byte-identically to before (N)."
    : `\n❌ ${failures} FAILURE(S).`);
  process.exit(failures === 0 ? 0 : 1);
}
