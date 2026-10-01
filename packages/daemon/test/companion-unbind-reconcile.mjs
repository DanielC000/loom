import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — UNBIND RECONCILIATION (card d3f9b4d2, DoD-1): DELETE /api/companion/bindings/:sessionId
// used to drop the durable binding + live-sync the routing map, but left the proactive HOME (app_meta) and
// any RECURRING reminder's own pinned route pointing at the now-revoked chat untouched — so a heartbeat/
// reminder tick kept targeting a chat the owner had just revoked (the chat-gateway chokepoint fixed in
// companion-route-unbound-suppression.mjs would then correctly refuse delivery, but the owner never finds
// out WHY their proactive companion went silent, and the stale route lingers forever).
//
// Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer (app.inject) for the DELETE route —
// NO network, NO real claude, NO daemon, NO live companion runtime (deps.companion omitted on purpose for
// most of this file — DoD-1 must hold even when no live companion controller is wired, since it reconciles
// against the DURABLE db state the controller's own in-memory cache only mirrors; one `deps.companion`
// stub at the end proves reconcile() is ALSO invoked when a live runtime IS wired).
//
// Covers the DoD:
//   1. unbind clears the home when the home names the JUST-REVOKED route, and fires a durable
//      `companion_home_cleared` event (never a silent reroute to a different chat).
//   2. unbind clears (reroutes) a RECURRING reminder's own pinned route the same way, firing a durable
//      `companion_reminder_rerouted` event.
//   3. NEGATIVE CONTROL: a home/reminder route still backed by a LIVE binding (a different channel than
//      the one being unbound) is left completely untouched — no event, no clear.
//   4. EXEMPTION: a home/reminder route on the in-app channel is NEVER cleared/rerouted by ANY unbind
//      (full or per-channel) — in-app has no "unbound" state (mirrors ChatGateway.hasLiveBinding).
//   5. A reminder with no captured route (null) is skipped entirely — no event, no crash.
//   6. When a live companion controller IS wired, reconcile(sessionId) is invoked after a home-clear (so
//      the controller's own cached cfgs.home never goes stale) — mirrors the PUT/DELETE home routes' own
//      existing comment.
//   7. Minor 1 (the shared helper, companion/reconcile.ts, is called after EVERY binding mutation — not
//      just DELETE): a RE-BIND (POST, ON CONFLICT replaces the chat_id) to a NEW chat for the same channel
//      clears a home naming the now-orphaned OLD chat, same as an unbind.
//   8. Minor 1: PUT /api/companion/home onto a route with NO live binding is REFUSED (400) up front, rather
//      than writing a home the very next reconcile would immediately clear — the same live-binding
//      predicate the outbound chokepoint shares. in-app is exempt (control).
//   9. card d3f9b4d2 round 2, Finding 2: POST/PUT /api/companion/config's own `home` field is routed
//      through the SAME validateHomeTarget guard as PUT /api/companion/home (server.ts) — it used to only
//      check the numeric SHAPE and skip the live-binding half entirely, so a config write could set a home
//      the very next reconcile would immediately clear with no error ever surfaced to the caller.
//  10. card d3f9b4d2 round 2, Finding 3: a dm-bind pairing redemption whose reconcileBindingChange hook
//      THROWS still reaches "paired-dm" and still sends the PAIRED ack — the call site
//      (chat-gateway.ts's handleInbound) wraps it in try/catch, mirroring flagNonPrivateBinding's own call
//      site, so a reconcile failure can never drop the ack a real owner is waiting on.
// Run: 1) build (turbo builds shared first), 2) node test/companion-unbind-reconcile.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-unbind-reconcile-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { createDbCompanionPairing } = await import("../dist/companion/pairing.js");

// Spies console.error (card d3f9b4d2 round 2, case 9 below) — real console.log/console.warn untouched.
function spyConsoleError() {
  const calls = [];
  const real = console.error;
  console.error = (...args) => { calls.push(args.map(String).join(" ")); };
  return { calls, restore: () => { console.error = real; } };
}

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// A minimal real project/agent/session per companion, so the FK chain is satisfiable (mirrors
// companion-cross-channel-messages.mjs's own makeCompanionSession).
const now0 = new Date().toISOString();
function makeCompanionSession(label) {
  const projectId = randomUUID();
  db.insertProject({ id: projectId, name: label, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: now0, archivedAt: null });
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId, name: "Companion", startupPrompt: "", position: 0, profileId: null, endpoint: false, ioSchema: null });
  const sessionId = randomUUID();
  db.insertSession({
    id: sessionId, projectId, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now0, lastActivity: now0, lastError: null, role: "assistant", taskId: null,
  });
  return sessionId;
}

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const homeClearedEvents = (sessionId) => db.listEvents(sessionId).filter((e) => e.kind === "companion_home_cleared");
const reminderReroutedEvents = (sessionId) => db.listEvents(sessionId).filter((e) => e.kind === "companion_reminder_rerouted");

try {
  // ============ 1+2 — per-channel unbind clears the home AND reroutes a reminder naming that same route ===
  {
    const sess = makeCompanionSession("unbind-home-and-reminder");
    db.upsertCompanionBinding({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" });
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "700700700", scope: "dm" });
    db.setCompanionHome(sess, { channel: TELEGRAM_CHANNEL, chatId: "700700700" });
    const reminderId = randomUUID();
    db.insertCompanionReminder({
      id: reminderId, sessionId: sess, cron: "0 9 * * *", prompt: "good morning", label: null,
      route: { channel: TELEGRAM_CHANNEL, chatId: "700700700" }, enabled: true, createdAt: now0,
    });

    const res = await app.inject({ method: "DELETE", url: `/api/companion/bindings/${sess}?channel=${TELEGRAM_CHANNEL}` });
    check("1 setup: unbind REST call succeeds", res.statusCode === 200);

    check("1: the home naming the revoked route is CLEARED (owner sees 'no home', never a silent reroute)", db.getCompanionHome(sess) === null);
    check("1: a durable companion_home_cleared event was filed, naming the cleared route", (() => {
      const evs = homeClearedEvents(sess);
      return evs.length === 1 && evs[0].detail?.channel === TELEGRAM_CHANNEL && evs[0].detail?.chatId === "700700700";
    })());

    check("2: the reminder's own pinned route naming the revoked chat is CLEARED (falls back to in-app on next fire)", db.getCompanionReminder(reminderId)?.route === null);
    check("2: a durable companion_reminder_rerouted event was filed, naming the cleared route", (() => {
      const evs = reminderReroutedEvents(sess);
      return evs.length === 1 && evs[0].detail?.reminderId === reminderId && evs[0].detail?.channel === TELEGRAM_CHANNEL && evs[0].detail?.chatId === "700700700";
    })());

    // The surviving in-app binding is untouched — this is a PER-CHANNEL unbind, not delete-ALL.
    check("setup sanity: the in-app binding survived the per-channel unbind", db.getCompanionBindingsForSession(sess).some((b) => b.channel === IN_APP_CHANNEL));
  }

  // ============ 3 — NEGATIVE CONTROL: a home/reminder route STILL backed by a live binding is untouched ===
  {
    const sess = makeCompanionSession("negative-control-still-live");
    db.upsertCompanionBinding({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" });
    // Two DISTINCT telegram-shaped bindings aren't possible (one binding per session per channel), so prove
    // the control via a DIFFERENT channel entirely: home/reminder stay on in-app, telegram never existed —
    // unbinding a channel that was never bound must be a safe no-op that touches NEITHER record.
    db.setCompanionHome(sess, { channel: IN_APP_CHANNEL, chatId: sess });
    const reminderId = randomUUID();
    db.insertCompanionReminder({
      id: reminderId, sessionId: sess, cron: "0 9 * * *", prompt: "still here", label: null,
      route: { channel: IN_APP_CHANNEL, chatId: sess }, enabled: true, createdAt: now0,
    });

    const res = await app.inject({ method: "DELETE", url: `/api/companion/bindings/${sess}?channel=${TELEGRAM_CHANNEL}` }); // never bound
    check("3 setup: unbinding a never-bound channel is a safe no-op REST call", res.statusCode === 200);

    check("3: home on a route STILL backed by a live binding is left untouched", (() => {
      const h = db.getCompanionHome(sess);
      return h?.channel === IN_APP_CHANNEL && h?.chatId === sess;
    })());
    check("3: no companion_home_cleared event was filed for an untouched home", homeClearedEvents(sess).length === 0);
    check("3: the reminder's route is left untouched", db.getCompanionReminder(reminderId)?.route?.channel === IN_APP_CHANNEL);
    check("3: no companion_reminder_rerouted event was filed for an untouched reminder", reminderReroutedEvents(sess).length === 0);
  }

  // ============ 4 — EXEMPTION: in-app home/reminder routes survive even a FULL (delete-ALL) unbind ========
  {
    const sess = makeCompanionSession("in-app-exempt-full-unbind");
    db.upsertCompanionBinding({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" });
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "800800800", scope: "dm" });
    db.setCompanionHome(sess, { channel: IN_APP_CHANNEL, chatId: sess });
    const reminderId = randomUUID();
    db.insertCompanionReminder({
      id: reminderId, sessionId: sess, cron: "0 9 * * *", prompt: "exempt", label: null,
      route: { channel: IN_APP_CHANNEL, chatId: sess }, enabled: true, createdAt: now0,
    });

    // Full unbind: channel OMITTED, removes every binding for this session (including in-app itself).
    const res = await app.inject({ method: "DELETE", url: `/api/companion/bindings/${sess}` });
    check("4 setup: full unbind REST call succeeds", res.statusCode === 200);
    check("4 setup: every binding (including in-app) is actually gone", db.getCompanionBindingsForSession(sess).length === 0);

    check("4 (exemption): the in-app home survives even a FULL unbind — in-app has no unbound state", (() => {
      const h = db.getCompanionHome(sess);
      return h?.channel === IN_APP_CHANNEL && h?.chatId === sess;
    })());
    check("4: no companion_home_cleared event was filed for the exempt in-app home", homeClearedEvents(sess).length === 0);
    check("4 (exemption): the in-app reminder route ALSO survives the full unbind", db.getCompanionReminder(reminderId)?.route?.channel === IN_APP_CHANNEL);
    check("4: no companion_reminder_rerouted event was filed for the exempt in-app reminder", reminderReroutedEvents(sess).length === 0);
  }

  // ============ 5 — a reminder with NO captured route (null) is skipped entirely =============================
  {
    const sess = makeCompanionSession("routeless-reminder");
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "900900900", scope: "dm" });
    const reminderId = randomUUID();
    db.insertCompanionReminder({
      id: reminderId, sessionId: sess, cron: "0 9 * * *", prompt: "no route captured", label: null,
      route: null, enabled: true, createdAt: now0,
    });

    const res = await app.inject({ method: "DELETE", url: `/api/companion/bindings/${sess}?channel=${TELEGRAM_CHANNEL}` });
    check("5 setup: unbind REST call succeeds", res.statusCode === 200);
    check("5: a route-less reminder is skipped (stays null, not touched/crashed)", db.getCompanionReminder(reminderId)?.route === null);
    check("5: no companion_reminder_rerouted event was filed for a reminder that never had a route", reminderReroutedEvents(sess).length === 0);
  }

  // ============ 6 — a LIVE companion controller IS wired: reconcile(sessionId) runs on a home-clear =======
  {
    const sess = makeCompanionSession("reconcile-called");
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "910910910", scope: "dm" });
    db.setCompanionHome(sess, { channel: TELEGRAM_CHANNEL, chatId: "910910910" });

    const reconciled = [];
    const companionStub = {
      unbind() {},
      async reconcile(sessionId) { reconciled.push(sessionId); },
    };
    const appWithCompanion = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: companionStub });

    const res = await appWithCompanion.inject({ method: "DELETE", url: `/api/companion/bindings/${sess}?channel=${TELEGRAM_CHANNEL}` });
    check("6 setup: unbind REST call succeeds with a live companion controller wired", res.statusCode === 200);
    check("6: the home was cleared", db.getCompanionHome(sess) === null);
    check("6: reconcile(sessionId) was invoked for THIS session (keeps the controller's cached cfgs.home in sync)", reconciled.includes(sess));
    await appWithCompanion.close();
  }

  // ============ 7 — card d3f9b4d2 Minor 1: a RE-BIND (POST, ON CONFLICT) to a NEW chat for the SAME ========
  // ============     channel clears the home that named the OLD chat (same shape as an unbind) ==============
  {
    const sess = makeCompanionSession("rebind-clears-old-home");
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "111222333", scope: "dm" });
    db.setCompanionHome(sess, { channel: TELEGRAM_CHANNEL, chatId: "111222333" });

    const res = await app.inject({
      method: "POST", url: "/api/companion/bindings",
      payload: { sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "444555666", scope: "dm" },
    });
    check("7 setup: the re-bind REST call succeeds", res.statusCode === 201);
    check("7: the binding now points at the NEW chat", db.getCompanionBindingsForSession(sess).find((b) => b.channel === TELEGRAM_CHANNEL)?.chatId === "444555666");
    check("7: the home naming the OLD (now-orphaned) chat is CLEARED, never silently left pointing at a chat nothing routes to", db.getCompanionHome(sess) === null);
    check("7: a durable companion_home_cleared event was filed, naming the OLD route", (() => {
      const evs = homeClearedEvents(sess);
      return evs.length === 1 && evs[0].detail?.channel === TELEGRAM_CHANNEL && evs[0].detail?.chatId === "111222333";
    })());
  }

  // ============ 8 — card d3f9b4d2 Minor 1: PUT /api/companion/home onto a route with NO live binding =======
  // ============     is REFUSED (400), never silently written to go immediately dead =========================
  {
    const sess = makeCompanionSession("put-home-unbound-refused");
    // No binding for this session/channel at all — the target route has nothing routing it.
    const res = await app.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "777888999" },
    });
    check("8: PUT home onto an unbound route → 400", res.statusCode === 400);
    check("8: the 400's error names the problem", /no live binding/i.test(JSON.parse(res.payload).error));
    check("8: no home was written", db.getCompanionHome(sess) === null);

    // Control: the SAME PUT succeeds once the route actually has a live binding.
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "777888999", scope: "dm" });
    const ok = await app.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "777888999" },
    });
    check("8 (control): the SAME PUT succeeds once the route is bound → 200", ok.statusCode === 200);
    check("8 (control): the home is now set", db.getCompanionHome(sess)?.chatId === "777888999");

    // Control: in-app is exempt from this guard (it has no "unbound" state), even with ZERO bindings.
    const inAppOk = await app.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess },
    });
    check("8 (in-app control): PUT home to in-app succeeds with no binding at all → 200", inAppOk.statusCode === 200);
  }

  // ============ 9 — card d3f9b4d2 round 2, Finding 2: POST/PUT /api/companion/config's `home` field is ====
  // ============     routed through the SAME live-binding guard PUT /api/companion/home uses ================
  {
    const now = new Date().toISOString();
    db.insertProject({ id: "config-home-proj", name: "config-home-guard", repoPath: "config-home-proj", vaultPath: "config-home-proj", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "config-home-agent", projectId: "config-home-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    const sess = "config-home-sess";
    db.insertSession({
      id: sess, projectId: "config-home-proj", agentId: "config-home-agent", engineSessionId: `eng-${sess}`, title: null, cwd: "config-home-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });

    // CREATE naming a `home` with NO live binding for that route — pre-fix this only ever checked the
    // numeric SHAPE of the chatId, never whether the route was actually bound, so it would silently write a
    // home the very next reconcile call would immediately clear.
    const badCreate = await app.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: sess, botToken: "123456:fake-token-home-guard", allowedChatId: "121121121", home: { channel: TELEGRAM_CHANNEL, chatId: "343343343" } },
    });
    check("9: POST /api/companion/config with an UNBOUND home → 400", badCreate.statusCode === 400);
    check("9: the 400 names the live-binding problem (same guard PUT /home uses)", /no live binding/i.test(JSON.parse(badCreate.payload).error));
    check("9: no config row was written — the home guard fires before the upsert", db.getCompanionConfig(sess) === undefined);
    check("9: no home was written either", db.getCompanionHome(sess) === null);

    // Control: the SAME home succeeds once its own route is actually bound.
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "343343343", scope: "dm" });
    const goodCreate = await app.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: sess, botToken: "123456:fake-token-home-guard", allowedChatId: "121121121", home: { channel: TELEGRAM_CHANNEL, chatId: "343343343" } },
    });
    check("9 (control): the SAME POST succeeds once the home route is bound → 201", goodCreate.statusCode === 201);
    check("9 (control): the home is now set", db.getCompanionHome(sess)?.chatId === "343343343");

    // A later edit (PUT) naming a DIFFERENT, still-unbound home is refused the same way, leaving the
    // existing home untouched.
    const badUpdate = await app.inject({
      method: "PUT", url: `/api/companion/config/${sess}`,
      payload: { home: { channel: TELEGRAM_CHANNEL, chatId: "999999999" } },
    });
    check("9: PUT /api/companion/config/:sessionId with an UNBOUND home → 400", badUpdate.statusCode === 400);
    check("9: the home from the prior successful create is left untouched", db.getCompanionHome(sess)?.chatId === "343343343");
  }

  // ============ 10 — card d3f9b4d2 round 2, Finding 3: a reconcile FAILURE during dm-bind pairing =========
  // ============      redemption must never drop the PAIRED ack ==============================================
  {
    const sess = makeCompanionSession("pairing-reconcile-failure-does-not-drop-ack");
    const pairing = createDbCompanionPairing(db, { now: () => Date.now() });
    const minted = db.mintPairingCode({ sessionId: sess, channel: TELEGRAM_CHANNEL, grantType: "dm-bind", ttlMs: 10 * 60_000 }, Date.now());
    const sent = [];
    const tgAdapter = { name: TELEGRAM_CHANNEL, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } };
    const failingReconcile = async () => { throw new Error("injected reconcile failure"); };
    // Positional constructor — reconcileBindingChange is the 18th param; every param between `pairing` (4th)
    // and it is left at its default (undefined), matching every other hand-built ChatGateway in this suite.
    const gw = new ChatGateway(
      () => ({ delivered: true }), [], createDbCompanionAuth(db), pairing,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, failingReconcile,
    );
    gw.registerAdapter(tgAdapter);
    const spy = spyConsoleError();
    const r = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "920920920", body: minted.code, sender: { id: "owner-pair" }, chatIsDirect: true });
    spy.restore();
    check("10: dm-bind pairing still reaches paired-dm even when reconcileBindingChange throws", r.accepted === false && r.reason === "paired-dm");
    check("10: the PAIRED ack was still sent despite the reconcile failure", r.acked === true && sent.length === 1 && /paired/i.test(sent[0].text));
    check("10: the binding was still durably written", db.listCompanionBindings().some((b) => b.sessionId === sess && b.chatId === "920920920"));
    check("10: the reconcile failure was logged, not swallowed silently", spy.calls.some((c) => /reconcile failed/i.test(c)));
  }
} finally {
  await app.close();
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unbinding a channel clears the proactive home and reroutes a recurring reminder when (and ONLY when) that specific route no longer has a live binding, each left as a durable event (companion_home_cleared / companion_reminder_rerouted) rather than a silent reroute to a different chat; a route still backed by a live binding is untouched; the in-app channel is exempt even from a full unbind; a route-less reminder is skipped cleanly; reconcile() runs when a live companion controller is wired; a re-bind (POST) to a new chat clears a home naming the now-orphaned old chat the same way an unbind does; PUT /api/companion/home onto an unbound route is refused (400) up front, in-app exempt; POST/PUT /api/companion/config's own `home` field is now refused the same way (the same validateHomeTarget guard, not a second divergent copy); and a dm-bind pairing redemption whose reconcile hook throws still reaches paired-dm and still sends the PAIRED ack."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
