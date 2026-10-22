import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b8196f51: since 0368c784/af165ec7, an automated SPAWN-mode delivery (event-trigger/webhook/poll)
// aimed at an agent that already has a live-or-starting manager is REFUSED (SecondLiveManagerError,
// naming holderSessionId) instead of minting a duplicate manager. af165ec7 only closed the WAKE-mode
// doors (resolveWakeDeliveryTarget) — the three fire() sites' SPAWN-mode branch had no redirect
// counterpart, so the refusal used to DROP the payload (webhook: the route's .catch() undoes the dedupe
// row; event-trigger: the watermark already advanced before fire() even ran) or STALL forever (poll: the
// cursor never commits past the fresh item while fire() keeps throwing).
//
// This file drives all three REAL fire() sites — EventTriggerService, PollService, and the real webhook
// ingress route (via buildServer + app.inject) — each wired to a REAL SessionService (real Db, fake pty
// via the shared createPty()/stop() seam, mirroring resume-wake-redirect.mjs's own harness), proving:
//   (1) the refused spawn is redirected to the live holder as a MESSAGE, not dropped/stalled;
//   (2) that message actually lands in the holder's PENDING QUEUE (a real `PtyHost.enqueueStdin` call
//       observed via `getPendingEntries`, with the holder forced busy first — never just a stub recording
//       that a function was called);
//   (3) each caller's own "advance/record normally" consequence: the webhook dedupe row is kept (a
//       replay now reports duplicate:true, not a fresh re-fire), the poll cursor ADVANCES, and the event
//       trigger files its ordinary event_trigger_fired (mode:"spawn") instead of silently dropping the
//       event; plus the audit-only spawn_target_redirected event under the holder, per source.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
//
// Run: 1) build (turbo builds shared first), 2) node test/spawn-redirect.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// `enqueueDurableNudge` gates its dispatch on `waitForMcpSeen` for any orchestration-MCP role (the
// holder here is "manager") — this test never establishes a real MCP handshake, so without shortening
// this bound (same recipe as resume-wake-redirect.mjs) every redirect would wait the real 9s default
// before actually landing in the pending queue. Must be set BEFORE importing dist/pty/host.js (its
// timeout constant is read once, at module-load time).
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { EventTriggerService } = await import("../dist/orchestration/event-triggers.js");
const { PollService } = await import("../dist/orchestration/poll.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createWebhookEndpoint } = await import("../dist/webhooks/store.js");

const repo = path.join(os.tmpdir(), `loom-sr-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# spawn-redirect test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=sr@loom -c user.name=sr");

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

/** A project whose "spawn target" agent is bound to a role:"manager" Profile — required so a role-
 *  omitted `startNew(agentId, {...})` (exactly what every spawn-mode fire() site calls) resolves to
 *  "manager" and so can collide with 0368c784's refuseSecondLiveManager, same as a real manager agent. */
function seedSpawnProject(db, id) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProfile({
    id: `${id}-prof`, name: "Mgr Rig", role: "manager", description: "spawn-mode test rig", allowDelta: [],
    skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: false,
  });
  db.insertAgent({ id: `${id}-agent`, projectId: id, name: "SpawnTarget", startupPrompt: "MGR", position: 0, profileId: `${id}-prof` });
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Start the FIRST (holder) manager via `startNew` — the SAME path every spawn-mode fire() site calls —
 *  then deliver its SessionStart hook + a fake transcript so it is genuinely live AND resumable. */
function startHolder(sessions, host, agentId, tag) {
  const m = sessions.startNew(agentId, {});
  host.deliverHook(m.id, { hook_event_name: "SessionStart", session_id: `eng-${tag}` });
  writeFakeTranscript(m.cwd, `eng-${tag}`);
  return m;
}

try {
  // ==================== (A) REAL fire() site — EventTriggerService, SPAWN mode — a refused spawn is
  // redirected to the live holder as a message, the message lands in the holder's REAL pending queue
  // (forced busy first), the trigger files its ordinary event_trigger_fired (not dropped), and
  // spawn_target_redirected is filed under the holder with source:"event-trigger" ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "sr-a";
    seedSpawnProject(db, P);
    const agentId = `${P}-agent`;
    const holder = startHolder(sessions, host, agentId, "a");
    check("(A pre) holder is alive", host.isAlive(holder.id) === true);

    // Force the holder BUSY so the redirected message is provably queued (not immediately handed off) —
    // a real PtyHost.enqueueStdin call, not a stub recording invocation.
    host.enqueueStdin(holder.id, "occupy the holder's current turn", "system", undefined, undefined, "agent");
    check("(A pre) holder is now busy (occupied by a real enqueueStdin call)", db.getSession(holder.id).busy === true);

    const enqueued = [];
    const svc = new EventTriggerService({
      db, control: new OrchestrationControl(),
      pty: {
        isAlive: (id) => host.isAlive(id),
        enqueueStdin: (id, text, source, onDeliver, route, kind) => { enqueued.push({ sessionId: id, text, kind }); return { delivered: true }; },
      },
      resume: (id) => sessions.resume(id),
      enqueueDurableNudge: (id, role, text, taskId, opts) => sessions.enqueueDurableNudge(id, role, text, taskId, opts),
      spawn: (id, kickoffPrompt) => sessions.startNew(id, { kickoffPrompt }),
    });
    db.insertEventTrigger({
      id: "trig-sr-a", eventKind: "worker_report", projectId: null, mode: "spawn",
      targetSessionId: null, agentId, enabled: true, lastSeq: 0, lastFiredAt: null,
      createdAt: new Date().toISOString(),
    });
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: "system", kind: "worker_report", detail: { status: "blocked" } });

    await svc.tick(new Date());
    // These three facts are already decided SYNCHRONOUSLY by the `tick()` await above — `fire()`'s catch
    // branch calls `enqueueDurableNudge` fire-and-forget (never awaited) and then `appendEvent`
    // immediately, both before `tick()` itself returns — so they are checked BEFORE the fixed wait below,
    // never gated by it (a fixed wait preceding a negative assertion it does not actually gate would be
    // the unfalsifiable-in-one-trial shape CLAUDE.md's standing verification posture warns against).
    check("(A) the event was NOT dropped — event_trigger_fired recorded under the holder, mode:spawn",
      db.listEventsForSession(holder.id).some((ev) => ev.kind === "event_trigger_fired" && ev.detail.mode === "spawn"));
    check("(A) a SECOND manager was never minted for this agent (still exactly one live session)",
      db.listAllSessions().filter((s) => s.agentId === agentId && s.processState === "live").length === 1);
    check("(A) spawn_target_redirected filed under the holder with source:'event-trigger'",
      db.listEventsForSession(holder.id).some((ev) => ev.kind === "spawn_target_redirected" && ev.detail.source === "event-trigger" && ev.detail.agentId === agentId));

    // ONLY the real-delivery check below genuinely depends on the async dispatch settling — `enqueueDurableNudge`
    // is gated on the shortened `waitForMcpSeen` above and neither EventTriggerService nor PollService awaits it
    // (matching production) — poll the actual pending queue instead of guessing how long that takes.
    const pendingHasRedirectA = () => host.getPendingEntries(holder.id).some((e) => typeof e.text === "string" && e.text.includes("worker_report"));
    await waitUntil(pendingHasRedirectA, { label: "(A) redirected message in holder's pending queue" });
    check("(A) REAL DELIVERY: the redirected message actually landed in the holder's pending queue", pendingHasRedirectA());
  }

  // ==================== (B) REAL fire() site — PollService, SPAWN mode — same redirect, cursor
  // ADVANCES past the fresh item instead of stalling forever, source:"poll" ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "sr-b";
    seedSpawnProject(db, P);
    const agentId = `${P}-agent`;
    const holder = startHolder(sessions, host, agentId, "b");

    host.enqueueStdin(holder.id, "occupy the holder's current turn", "system", undefined, undefined, "agent");
    check("(B pre) holder is busy", db.getSession(holder.id).busy === true);

    const conn = db.createConnection({ name: "sr-b-conn", host: "api.example.com", authScheme: "bearer", secretBlob: "irrelevant-ciphertext" });
    db.insertPollJob({
      id: "job-sr-b", connectionId: conn.id, path: "/notifications", method: "GET", intervalMs: 60_000,
      nextPollAt: new Date(Date.now() - 60_000).toISOString(), lastPolledAt: null,
      itemsPath: "items", idPath: "id", cursorJson: null,
      mode: "spawn", sessionId: null, agentId,
      enabled: true, consecutiveFailures: 0, lastError: null, createdAt: new Date().toISOString(),
    });

    let responses = [{ ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [{ id: "n1" }] }) }]; // baseline
    const poll = new PollService({
      db, control: new OrchestrationControl(),
      pty: { isAlive: (id) => host.isAlive(id), enqueueStdin: () => ({ delivered: true }) },
      resume: (id) => sessions.resume(id),
      enqueueDurable: (id, text, ctx) => host.enqueueStdin(id, text, "system", undefined, undefined, ctx.kind),
      enqueueDurableNudge: (id, role, text, taskId, opts) => sessions.enqueueDurableNudge(id, role, text, taskId, opts),
      spawn: (id, kickoffPrompt) => sessions.startNew(id, { kickoffPrompt }),
      request: async () => { const next = responses.shift(); return next ?? { ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [] }) }; },
    });

    await poll.tick(new Date()); // baseline — seeds the cursor, fires nothing
    check("(B pre) baseline poll fired nothing (no redirect events yet)", !hasEvent(db, holder.id, "spawn_target_redirected"));
    responses = [{ ok: true, status: 200, headers: {}, body: JSON.stringify({ items: [{ id: "n1" }, { id: "n2" }] }) }]; // n2 is new
    db.claimPollJob("job-sr-b", new Date(Date.now() - 1000).toISOString()); // make due again
    const cursorBefore = db.getPollJob("job-sr-b").cursorJson;

    await poll.tick(new Date());
    // Same reasoning as (A): these facts are already decided synchronously by the `tick()` await above
    // (fire()'s catch branch dispatches fire-and-forget, then commits the cursor before returning) —
    // checked BEFORE the fixed wait below, never gated by it.
    const jobAfter = db.getPollJob("job-sr-b");
    check("(B) the CURSOR ADVANCED past the fresh item (not stalled/retrying)", jobAfter.cursorJson !== cursorBefore && JSON.parse(jobAfter.cursorJson).includes("n2"));
    check("(B) consecutiveFailures stayed 0 — fire() did not throw", jobAfter.consecutiveFailures === 0);
    check("(B) spawn_target_redirected filed under the holder with source:'poll'",
      db.listEventsForSession(holder.id).some((ev) => ev.kind === "spawn_target_redirected" && ev.detail.source === "poll" && ev.detail.agentId === agentId));

    // see (A)'s comment on enqueueDurableNudge's fire-and-forget dispatch — poll the real pending queue.
    const pendingHasRedirectB = () => host.getPendingEntries(holder.id).some((e) => typeof e.text === "string" && e.text.includes("[loom:poll]"));
    await waitUntil(pendingHasRedirectB, { label: "(B) redirected message in holder's pending queue" });
    check("(B) REAL DELIVERY: the redirected message actually landed in the holder's pending queue", pendingHasRedirectB());
  }

  // ==================== (C) REAL fire() site — the webhook ingress route, through the REAL buildServer
  // (app.inject) — a refused spawn is redirected instead of dropped, the dedupe row is KEPT (a replay now
  // reports duplicate:true, proving the delivery counted as success), source:"webhook" ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "sr-c";
    seedSpawnProject(db, P);
    const agentId = `${P}-agent`;
    const holder = startHolder(sessions, host, agentId, "c");

    host.enqueueStdin(holder.id, "occupy the holder's current turn", "system", undefined, undefined, "agent");
    check("(C pre) holder is busy", db.getSession(holder.id).busy === true);

    const pty = { isAlive: (id) => host.isAlive(id) };
    const stub = {};
    const app = await buildServer({
      db, pty, sessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
    });

    const endpoint = createWebhookEndpoint(db, {
      name: "sr-c target", sourceType: "generic", secret: "sr-c-secret", mode: "spawn",
      targetSessionId: null, agentId,
    });
    const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
    const rawBodyStr = '{"i":1}';
    const deliveryId = "sr-c-delivery-1";
    const tsSec = Math.floor(Date.now() / 1000);
    const signedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${tsSec}.`, "utf8"), Buffer.from(rawBodyStr, "utf8")]);
    const sig = "sha256=" + hexHmac("sr-c-secret", signedContent);
    const r = await app.inject({
      method: "POST", url: `/hooks/${endpoint.path}`, payload: rawBodyStr,
      headers: { "content-type": "application/json", "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId },
    });
    check("(C) spawn delivery through the REAL buildServer -> 200", r.statusCode === 200);
    // Already decided synchronously: `startNew` throws (and is caught) synchronously the instant
    // `fireWebhookTarget` starts running, well before its first real await — checked BEFORE the fixed
    // wait below, never gated by it.
    check("(C) a SECOND manager was never minted for this agent (still exactly one live session)",
      db.listAllSessions().filter((s) => s.agentId === agentId && s.processState === "live").length === 1);

    // UNLIKE (A)/(B), the webhook branch genuinely AWAITS enqueueDurableNudge's onOutcome inside
    // fireWebhookTarget before filing spawn_target_redirected (mirroring the wake-mode branch's own
    // a21f5c9e contract) — the route's own fire() call is still fire-and-forget from the HTTP response's
    // perspective (ACK sent before the fire — see ingress.ts's own doc), so these two checks genuinely
    // need to wait for that internal await to settle (gated on the shortened `waitForMcpSeen` above) —
    // poll the real durable event instead of guessing how long that takes.
    const redirectEventFiled = () => db.listEventsForSession(holder.id).some((ev) => ev.kind === "spawn_target_redirected" && ev.detail.source === "webhook" && ev.detail.agentId === agentId);
    await waitUntil(redirectEventFiled, { label: "(C) spawn_target_redirected filed under the holder" });
    check("(C) spawn_target_redirected filed under the holder with source:'webhook'", redirectEventFiled());
    check("(C) REAL DELIVERY: the redirected message actually landed in the holder's pending queue",
      host.getPendingEntries(holder.id).some((e) => typeof e.text === "string" && e.text.includes("i")));

    // (C-2) REPLAY: the SAME delivery id, resent — if the dedupe row had been undone (the pre-fix
    // "dropped" behavior), this would re-fire a SECOND redirect; the fix keeps the row, so it is a
    // plain, harmless duplicate ACK and nothing fires again.
    const r2 = await app.inject({
      method: "POST", url: `/hooks/${endpoint.path}`, payload: rawBodyStr,
      headers: { "content-type": "application/json", "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId },
    });
    check("(C-2) a replay of the SAME delivery id is ACK'd as a plain duplicate — the dedupe row was KEPT, not undone",
      r2.statusCode === 200 && JSON.parse(r2.body).duplicate === true);
    const redirectedEventsAfterReplay = db.listEventsForSession(holder.id).filter((ev) => ev.kind === "spawn_target_redirected");
    check("(C-2) the replay did NOT file a second spawn_target_redirected (no re-fire)", redirectedEventsAfterReplay.length === 1);

    await app.close();
  }
} finally {
  // Nothing to clean up beyond the OS temp dirs — each harness closes its own Db implicitly on process exit.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a SPAWN-mode delivery (event-trigger/webhook/poll) refused for an agent that already has a live manager (SecondLiveManagerError) is redirected to that live holder as a message — through each caller's own real enqueueDurableNudge/enqueueStdin path, provably landing in the holder's real pending queue — instead of being dropped (webhook/event-trigger) or stalling the cursor forever (poll), and each caller files spawn_target_redirected under the holder."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
