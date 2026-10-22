import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af165ec7, Code Review f643b83a MAJOR: `SessionService.resolveWakeDeliveryTarget` had ZERO test
// coverage. This file drives it DIRECTLY (scenarios A-D below) and then exercises at least one REAL
// `fire()` call site per source — EventTriggerService, PollService, and the real webhook ingress route
// (via buildServer + app.inject) — each wired to the REAL `SessionService.resolveWakeDeliveryTarget`,
// proving the redirect (and the `wake_target_redirected` event it files) through the real integration
// path, not just a hand-rolled stub of the predicate.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService against a fake pty (the shared
// createPty()/stop() seam), mirroring resume-halted-partner-exemption.mjs's own harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-wake-redirect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rwr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors resume-halted-partner-exemption.mjs) —
// needed for scenario (D)'s halted-pair setup.
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "40";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { isSanctionedHaltedPartner } = await import("../dist/orchestration/crash-orphaned-workers.js");
const { EventTriggerService } = await import("../dist/orchestration/event-triggers.js");
const { PollService } = await import("../dist/orchestration/poll.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createWebhookEndpoint } = await import("../dist/webhooks/store.js");

const repo = path.join(os.tmpdir(), `loom-rwr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# resume-wake-redirect test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rwr@loom -c user.name=rwr");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
  let sessions;
  host.events.onExit = (id, code, info) => {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  };
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently, so recycleManager halts — mirrors
 *  resume-halted-partner-exemption.mjs's own stub. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (resume-wake-redirect test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** Start a manager, deliver its SessionStart hook + a fake transcript so it is genuinely resumable. */
function startLiveManager(sessions, host, agentId, tag) {
  const m = sessions.startManager(agentId);
  host.deliverHook(m.id, { hook_event_name: "SessionStart", session_id: `eng-${tag}` });
  writeFakeTranscript(m.cwd, `eng-${tag}`);
  return m;
}

try {
  // ==================== (A) resolveWakeDeliveryTarget: stale manager target, live DIFFERENT holder (an
  // ORDINARY fresh start, never a recycle) — redirects, never resumes the stale target ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-a";
    seedProject(db, P);
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-a");
    host.handles.get(m1.id).kill();
    check("(A pre) M1 is not alive", host.isAlive(m1.id) === false);
    const m2 = startLiveManager(sessions, host, `${P}-mgr`, "m2-a"); // fresh start — allowed, M1 isn't live
    check("(A pre) M2 is alive, a fresh start for the SAME agent as the now-dead M1", host.isAlive(m2.id) === true);

    const result = sessions.resolveWakeDeliveryTarget(m1.id);
    check("(A) redirects to M2, naming M1 as redirectedFrom", result.sessionId === m2.id && result.redirectedFrom === m1.id);
    check("(A) M1 was NEVER resumed by the redirect itself", host.isAlive(m1.id) === false);
  }

  // ==================== (B) resolveWakeDeliveryTarget: NO holder — falls through to resume(), behavior
  // byte-identical to the pre-af165ec7 bare isAlive+resume check ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-b";
    seedProject(db, P);
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-b");
    host.handles.get(m1.id).kill();
    check("(B pre) M1 is not alive, and nothing else is live for its agent", host.isAlive(m1.id) === false);

    const result = sessions.resolveWakeDeliveryTarget(m1.id);
    check("(B) no redirect — resolves to the target's own id", result.sessionId === m1.id && result.redirectedFrom === undefined);
    check("(B) the target was actually RESUMED (genuinely live again)", host.isAlive(m1.id) === true);
  }

  // ==================== (C) resolveWakeDeliveryTarget: a NON-MANAGER target is never redirected, even
  // when a live manager exists under the same agentId ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-c";
    seedProject(db, P);
    const m2 = startLiveManager(sessions, host, `${P}-mgr`, "m2-c"); // a live manager under the SAME agentId
    void m2;

    const now = new Date().toISOString();
    db.insertSession({
      id: "worker-c", projectId: P, agentId: `${P}-mgr`, engineSessionId: "eng-worker-c", title: null, cwd: repo,
      processState: "exited", resumability: "resumable", busy: false,
      createdAt: now, lastActivity: now, lastError: null, role: "worker",
    });
    writeFakeTranscript(repo, "eng-worker-c");
    check("(C pre) the worker target is not alive; M2 (same agentId) IS alive", host.isAlive("worker-c") === false && host.isAlive(m2.id) === true);

    const result = sessions.resolveWakeDeliveryTarget("worker-c");
    check("(C) a non-manager target is NEVER redirected to the live manager", result.sessionId === "worker-c" && result.redirectedFrom === undefined);
    check("(C) it was resumed directly instead", host.isAlive("worker-c") === true);
  }

  // ==================== (D) resolveWakeDeliveryTarget: the target's own sanctioned halted-recycle
  // partner is LIVE but must NEVER be redirected to — resume() of the target itself is what's actually
  // allowed (its own exemption), so the redirect must fall through to resume(), not divert content to
  // the wrong half of the still-unresolved pair (Code Review f643b83a MINOR, round 2 fix) ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-d";
    seedProject(db, P);
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-d");

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt for the redirect test");
    unstub();
    check("(D pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-d" });
    writeFakeTranscript(m2.cwd, "eng-m2-d");
    check("(D pre) M1 and M2 are BOTH alive — the sanctioned coexistence window", host.isAlive(m1.id) === true && host.isAlive(m2.id) === true);

    const m1Row = db.getSession(m1.id), m2Row = db.getSession(m2.id);
    check("(D pre) M2 is M1's sanctioned (still-unresolved) halted partner", isSanctionedHaltedPartner(db, m1Row, m2Row) === true);

    host.handles.get(m1.id).kill(); // simulate M1 crashed — a wake-mode fire would now see it not-alive
    check("(D pre) M1 is now not alive; M2 remains live", host.isAlive(m1.id) === false && host.isAlive(m2.id) === true);

    // RED PROOF: ignoring the halted-partner exemption, the real live-manager scan finds M2 — proving
    // this is a genuine redirect CANDIDATE the fix must actively suppress, not a scenario where there was
    // never anything to redirect to in the first place.
    const holderIgnoringHaltedCheck = sessions.findLiveManagerForAgent(m1Row.agentId, [m1Row.id]);
    check("(D) RED PROOF: ignoring the halted-partner check, the scan finds M2 as a live holder", holderIgnoringHaltedCheck?.id === m2.id);

    const result = sessions.resolveWakeDeliveryTarget(m1.id);
    check("(D) FIX: NO redirect to the sanctioned halted partner — falls through to resume() instead", result.sessionId === m1.id && result.redirectedFrom === undefined);
    check("(D) FIX: M1 (the target) is genuinely live again — its OWN resume() succeeded via its own exemption", host.isAlive(m1.id) === true);
  }

  // ==================== (E) REAL fire() site — EventTriggerService, wake mode — redirects through the
  // REAL SessionService.resolveWakeDeliveryTarget, never resumes the stale target, and files
  // wake_target_redirected{source:"event-trigger", originalTargetId} under the holder ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-e";
    seedProject(db, P);
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-e");
    host.handles.get(m1.id).kill();
    const m2 = startLiveManager(sessions, host, `${P}-mgr`, "m2-e"); // ordinary fresh start supersedes M1
    check("(E pre) M1 dead, M2 live, same agent", host.isAlive(m1.id) === false && host.isAlive(m2.id) === true);

    const resumeCalls = [];
    const realResume = sessions.resume.bind(sessions);
    const enqueued = [];
    const svc = new EventTriggerService({
      db, control: new OrchestrationControl(),
      pty: {
        isAlive: (id) => host.isAlive(id),
        enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ sessionId: id, text, kind }); return { delivered: true }; },
      },
      resume: (id) => { resumeCalls.push(id); return realResume(id); },
      resolveWakeTarget: (id) => sessions.resolveWakeDeliveryTarget(id),
      spawn: async () => { throw new Error("spawn must not be called — this trigger is wake mode"); },
    });
    db.insertEventTrigger({
      id: "trig-rwr-e", eventKind: "worker_report", projectId: null, mode: "wake",
      targetSessionId: m1.id, agentId: null, enabled: true, lastSeq: 0, lastFiredAt: null,
      createdAt: new Date().toISOString(),
    });
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: m1.id, kind: "worker_report", detail: { status: "blocked" } });

    await svc.tick(new Date());
    check("(E) the nudge landed on M2 (the redirect target), not M1", enqueued.length === 1 && enqueued[0].sessionId === m2.id);
    check("(E) resume() was NEVER called for the stale M1 — the redirect replaced it", resumeCalls.length === 0);
    check("(E) wake_target_redirected filed under M2 with source:'event-trigger' and originalTargetId:M1",
      db.listEventsForSession(m2.id).some((ev) => ev.kind === "wake_target_redirected" && ev.detail.source === "event-trigger" && ev.detail.originalTargetId === m1.id));
  }

  // ==================== (F) REAL fire() site — PollService, wake mode — same redirect, through the SAME
  // real SessionService method, source:"poll" ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-f";
    seedProject(db, P);
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-f");
    host.handles.get(m1.id).kill();
    const m2 = startLiveManager(sessions, host, `${P}-mgr`, "m2-f");
    check("(F pre) M1 dead, M2 live, same agent", host.isAlive(m1.id) === false && host.isAlive(m2.id) === true);

    const conn = db.createConnection({ name: "rwr-f-conn", host: "api.example.com", authScheme: "bearer", secretBlob: "irrelevant-ciphertext" });
    db.insertPollJob({
      id: "job-rwr-f", connectionId: conn.id, path: "/notifications", method: "GET", intervalMs: 60_000,
      nextPollAt: new Date(Date.now() - 60_000).toISOString(), lastPolledAt: null,
      itemsPath: "items", idPath: "id", cursorJson: null,
      mode: "wake", sessionId: m1.id, agentId: null,
      enabled: true, consecutiveFailures: 0, lastError: null, createdAt: new Date().toISOString(),
    });

    const resumeCalls = [];
    const realResume = sessions.resume.bind(sessions);
    const durableCalls = [];
    let responses = [{ ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [{ id: "n1" }] }) }]; // baseline
    const poll = new PollService({
      db, control: new OrchestrationControl(),
      pty: { isAlive: (id) => host.isAlive(id), enqueueStdin: () => ({ delivered: true }) },
      resume: (id) => { resumeCalls.push(id); return realResume(id); },
      resolveWakeTarget: (id) => sessions.resolveWakeDeliveryTarget(id),
      enqueueDurable: (id, text, ctx) => { durableCalls.push({ id, text, ctx }); return { delivered: true }; },
      spawn: async () => { throw new Error("spawn must not be called — this job is wake mode"); },
      request: async () => { const next = responses.shift(); return next ?? { ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [] }) }; },
    });

    await poll.tick(new Date()); // baseline poll — seeds the cursor, fires nothing
    check("(F pre) baseline poll fired nothing", durableCalls.length === 0);
    responses = [{ ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [{ id: "n1" }, { id: "n2" }] }) }]; // n2 is new
    db.claimPollJob("job-rwr-f", new Date(Date.now() - 1000).toISOString()); // make due again
    await poll.tick(new Date());

    check("(F) the nudge landed on M2 (the redirect target), not M1", durableCalls.length === 1 && durableCalls[0].id === m2.id);
    check("(F) resume() was NEVER called for the stale M1 — the redirect replaced it", resumeCalls.length === 0);
    check("(F) wake_target_redirected filed under M2 with source:'poll' and originalTargetId:M1",
      db.listEventsForSession(m2.id).some((ev) => ev.kind === "wake_target_redirected" && ev.detail.source === "poll" && ev.detail.originalTargetId === m1.id));
  }

  // ==================== (G) REAL fire() site — the webhook ingress route, through the REAL buildServer
  // (app.inject), wired via gateway/server.ts's typeof-guarded resolveWakeTarget, source:"webhook" ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rwr-g";
    seedProject(db, P);
    const m1 = startLiveManager(sessions, host, `${P}-mgr`, "m1-g");
    host.handles.get(m1.id).kill();
    const m2 = startLiveManager(sessions, host, `${P}-mgr`, "m2-g");
    check("(G pre) M1 dead, M2 live, same agent", host.isAlive(m1.id) === false && host.isAlive(m2.id) === true);

    const durableCalls = [];
    const realEnqueueDurableNudge = sessions.enqueueDurableNudge.bind(sessions);
    sessions.enqueueDurableNudge = (...args) => { durableCalls.push(args); return realEnqueueDurableNudge(...args); };

    // deps.pty is a SEPARATE dep from sessions' own internal host — forced through the SAME host so this
    // test's kill() above is actually visible to the route's isAlive precheck.
    const pty = { isAlive: (id) => host.isAlive(id) };
    const stub = {};
    const app = await buildServer({
      db, pty, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
    });

    const endpoint = createWebhookEndpoint(db, {
      name: "rwr-g target", sourceType: "generic", secret: "rwr-g-secret", mode: "wake",
      targetSessionId: m1.id, agentId: null,
    });
    const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
    const rawBodyStr = '{"i":1}';
    const deliveryId = "rwr-g-delivery-1";
    const tsSec = Math.floor(Date.now() / 1000);
    const signedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${tsSec}.`, "utf8"), Buffer.from(rawBodyStr, "utf8")]);
    const sig = "sha256=" + hexHmac("rwr-g-secret", signedContent);
    const r = await app.inject({
      method: "POST", url: `/hooks/${endpoint.path}`, payload: rawBodyStr,
      headers: { "content-type": "application/json", "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId },
    });
    check("(G) wake delivery through the REAL buildServer -> 200", r.statusCode === 200);
    await new Promise((res) => setImmediate(res));

    check("(G) the REAL registerWebhookIngress wiring redirected to M2, not M1",
      durableCalls.length === 1 && durableCalls[0][0] === m2.id);
    check("(G) wake_target_redirected filed under M2 with source:'webhook' and originalTargetId:M1",
      db.listEventsForSession(m2.id).some((ev) => ev.kind === "wake_target_redirected" && ev.detail.source === "webhook" && ev.detail.originalTargetId === m1.id));

    await app.close();
  }
} finally {
  // Nothing to clean up beyond the OS temp dirs — each harness closes its own Db implicitly on process exit.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — SessionService.resolveWakeDeliveryTarget redirects a stale manager target to a DIFFERENT live manager (ordinary fresh start), falls through to resume() when no holder exists or the target isn't a manager, and never redirects to the target's own sanctioned halted-recycle partner (resume()'s own exemption covers that pairing instead) — and all three real wake-mode fire() sites (EventTriggerService, PollService, the webhook ingress route) exercise the SAME real method end-to-end, each filing wake_target_redirected with its own source."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
