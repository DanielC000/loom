import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — a dm-scope Telegram binding whose chatId isn't numeric AT ALL (e.g. "@somechannel") is
// REFUSED, not merely flagged (card 94754bbe, item 1 of the Code Review of card 61e33b99). Unlike a
// negative-integer chatId (a real Telegram group id isLikelyGroupTelegramChatId only FLAGS, since the owner
// may still want it as scope "group"), there is no legitimate private chatId a non-numeric string could
// ever be — the Bot API happily sends to "@somechannel" as a public channel, so leaving it unflagged (the
// pre-fix behavior: Number("@x") is NaN, so the existing negative-integer heuristic never fires) would leak
// heartbeats/reminders/attention-pushes to it with no suppression at all.
//
// Fully hermetic: a REAL Db (proves persistence) + the REAL createCompanionGateway/ChatGateway/pairing
// production wiring + the REAL buildServer (app.inject) — NO live network, NO real claude, NO daemon.
//
// Covers:
//   A. THE WRITE CHOKEPOINT (db.upsertCompanionBinding) — the refusal itself, and its scope boundaries:
//      A1/A2. a dm+telegram bind to "@somechannel" / "123abc" throws InvalidTelegramChatIdError; no row
//          is written (RED on main: both of these silently SUCCEEDED and left the row unflagged).
//      A3. NEGATIVE CONTROL — a negative-INTEGER chatId (a real Telegram group id) is still only FLAGGED,
//          never refused — this predicate must never swallow isLikelyGroupTelegramChatId's own case.
//      A4. NEGATIVE CONTROL — an ordinary positive-chatId dm bind is unaffected.
//      A5. NEGATIVE CONTROL — a GROUP-scope bind to "@somechannel" is NOT refused (a channel/group handle
//          is legitimate Telegram addressing for a group — the refusal is dm-only, per the decision record).
//      A6. NEGATIVE CONTROL — a non-Telegram channel (in-app) with a non-numeric "chatId" is NOT refused
//          (scoped to Telegram's own id scheme only).
//   B. THE REST BIND HANDLER (POST /api/companion/bindings) distinguishes the refusal (400) from the
//      pre-existing UNIQUE-route conflict (409), and a group-scope bind to the same handle still succeeds.
//   C. THE PROVISION ENDPOINT's GUARD 6 pre-spawn check: a non-numeric allowedChatId is rejected 400
//      BEFORE a session is ever spawned (no wasted spawn+rollback); a numeric one still succeeds.
//   D. THE CHEAP GUARD (item 4): TELEGRAM_CHANNEL (telegram.ts) really is "telegram" — the literal
//      isLikelyGroupTelegramChatId/isNonNumericTelegramChatId each duplicate (companion/types.ts) can't
//      silently drift from the real constant without this failing.
//   E. THE EXISTING-ROW BOOT BACKSTOP: a LEGACY row (predates this fix, written via a raw INSERT bypassing
//      upsertCompanionBinding) with a non-numeric chatId is still caught — flagged, not refused, since a
//      past write can't be un-written — at boot, with no inbound needed (RED on main: the boot-time pass
//      only ever checked isLikelyGroupTelegramChatId, so a non-numeric legacy row sailed through unflagged).
//   F. PAIRING-CODE DM-BIND REDEMPTION is STRUCTURALLY UNREACHABLE for this refusal (not merely untested):
//      Telegram's own normalizeTelegramMessage always stringifies a real `message.chat.id` number, so no
//      inbound can ever carry a non-numeric chatId — proved directly off the adapter. And as defense in
//      depth, the redemption transaction's existing try/catch around upsertCompanionBinding already
//      reduces ANY throw (this one included) to the same silent `rejected`, never an uncaught exception.
//   G3. THE ACTUAL GOAL (Code Review widening, round 2): the write-chokepoint refusal above only ever
//      stopped a BINDING from being written — it never stopped a proactive reply from actually being
//      DELIVERED to the same chatId via the turn's pinned origin (what a companion HOME route carries).
//      Proves the real end-to-end suppression on the SAME bootstrap-refused chatId.
//   H. THE OUTBOUND CHOKEPOINT (ChatGateway.mayDeliverTo) COVERS A ROUTE WITH **NO BINDING AT ALL** — the
//      actual bug: companion HOME (heartbeats/reminders/attention-pushes) is an app_meta value, never a
//      `companion_bindings` row, so the OLD `bindingForInbound(...)?.flaggedNonPrivate !== true` check read
//      an unbound route as "may deliver" with zero regard for the chatId's own shape.
//      H1. a non-numeric target ("@chan") BACKED BY A LIVE DM BINDING is refused — RED on the pre-fix
//          mayDeliverTo. Deliberately BOUND (not unbound): an unbound target is already refused by H3's own
//          live-binding check regardless of shape, so leaving these unbound made the shape check's own RED
//          test indistinguishable from H3's — a reviewer could (and did) replace the shape check with
//          `if (false)` and this would still pass, for the wrong reason (Code Review finding, card d3f9b4d2
//          round 2). Binding it live isolates the shape check as the ONLY thing that can block it.
//      H2. a negative-integer target (the 61e33b99 class) BACKED BY A LIVE DM BINDING is ALSO refused, same
//          isolation rationale as H1.
//      H3. card d3f9b4d2: an ordinary positive-chatId UNBOUND target (a normal home with NO live binding —
//          deliberately left unbound, unlike H1/H2 above) is refused — route-unbound, not a chatId-shape
//          block — since an unbound route may never receive outbound regardless of shape.
//      H4. NEGATIVE CONTROL — a non-numeric/negative target backed by an EXPLICIT group-scope binding is
//          NOT refused — the scope exemption holds even for a route mayDeliverTo resolves structurally.
//   I. WRITE-TIME GUARDS (convenience 400s, never the real guarantee — H is): `PUT /api/companion/home`,
//      `POST`/`PUT /api/companion/config`'s `allowedChatId` (dm-scope only; group-scope is unaffected), and
//      the provision endpoint's `home` field all reject a non-numeric Telegram target up front — EXCEPT
//      (card 1b0df437) `PUT /api/companion/home` now accepts a `@handle` once a LIVE GROUP binding backs
//      the exact same route, mirroring ChatGateway.deliveryBlockReason's own group-scope exemption.
//   K. card ddf08614: `PUT /api/companion/home` (K.i) and the provision endpoint's `home` field (K.ii, pre-
//      spawn) both now refuse a home whose chatId HAS a live binding ROW but that `deliveryBlockReason`
//      would still refuse (here: auto-flagged non-private by the write chokepoint, card 61e33b99) — closing
//      the gap where a binding-row-exists check alone (the pre-fix `validateHomeTarget`) missed this.
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-nonnumeric-telegram-chatid-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Spies console.error so a test can assert a specific warning was actually printed (not just that a path
// didn't crash) — real console.log/console.warn are left untouched so PASS/FAIL lines above still print.
function spyConsoleError() {
  const calls = [];
  const real = console.error;
  console.error = (...args) => { calls.push(args.map(String).join(" ")); };
  return { calls, restore: () => { console.error = real; } };
}

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-chatid-refusal-${Date.now()}-${process.pid}`);
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
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { createDbCompanionPairing } = await import("../dist/companion/pairing.js");
const { TELEGRAM_CHANNEL, normalizeTelegramMessage } = await import("../dist/companion/telegram.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { isLikelyGroupTelegramChatId, isNonNumericTelegramChatId, InvalidTelegramChatIdError } = await import("../dist/companion/types.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

function fakeAdapter(name) {
  const sent = [];
  return { name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); }, sent };
}

try {
  // ============ A. THE WRITE CHOKEPOINT (db.upsertCompanionBinding) ========================================
  // A1/A2. REFUSED: a dm+telegram bind to a non-numeric chatId.
  for (const [label, badId] of [["@somechannel (public channel handle)", "@somechannel"], ["123abc (garbage)", "123abc"]]) {
    const sid = `sess-refuse-${randomUUID()}`;
    let threw = null;
    try {
      db.upsertCompanionBinding({ sessionId: sid, channel: TELEGRAM_CHANNEL, chatId: badId, scope: "dm" });
    } catch (e) {
      threw = e;
    }
    check(`(A) dm+telegram bind to "${label}" throws InvalidTelegramChatIdError`, threw instanceof InvalidTelegramChatIdError);
    check(`(A) the refused bind to "${label}" wrote NO row`, db.listCompanionBindings().find((b) => b.sessionId === sid) === undefined);
  }

  // A3. NEGATIVE CONTROL — a negative-INTEGER chatId (isLikelyGroupTelegramChatId's own case) is NOT
  // refused, only flagged — proves the new predicate never swallows the pre-existing one.
  const sessNegInt = "sess-negative-integer";
  const negInt = db.upsertCompanionBinding({ sessionId: sessNegInt, channel: TELEGRAM_CHANNEL, chatId: "-1001234567890", scope: "dm" });
  check("(A3 control) a negative-INTEGER chatId is NOT refused", negInt !== undefined && negInt.chatId === "-1001234567890");
  check("(A3 control) a negative-INTEGER chatId is still FLAGGED (isLikelyGroupTelegramChatId's own job)", negInt.flaggedNonPrivate === true);

  // A4. NEGATIVE CONTROL — an ordinary positive-chatId dm bind is unaffected.
  const sessOrdinary = "sess-ordinary-positive";
  const ord = db.upsertCompanionBinding({ sessionId: sessOrdinary, channel: TELEGRAM_CHANNEL, chatId: "555666777", scope: "dm" });
  check("(A4 control) an ordinary positive-chatId dm bind succeeds, unflagged", ord.flaggedNonPrivate === false);

  // A5. NEGATIVE CONTROL — scope "group" to the SAME handle that was just refused for "dm" is NOT refused
  // (a channel/group handle is legitimate Telegram addressing for a group).
  const sessGroupHandle = "sess-group-handle";
  const grp = db.upsertCompanionBinding({ sessionId: sessGroupHandle, channel: TELEGRAM_CHANNEL, chatId: "@somepublicchannel", scope: "group" });
  check("(A5 control) scope \"group\" to a non-numeric handle is NOT refused — the refusal is dm-only", grp !== undefined && grp.chatId === "@somepublicchannel" && grp.flaggedNonPrivate === false);

  // A6. NEGATIVE CONTROL — a non-Telegram channel with a non-numeric "chatId" is NOT refused (scoped to
  // Telegram's own id scheme only, like isLikelyGroupTelegramChatId).
  const sessInApp = "sess-in-app-nonnumeric";
  const inAppBind = db.upsertCompanionBinding({ sessionId: sessInApp, channel: IN_APP_CHANNEL, chatId: sessInApp, scope: "dm" });
  check("(A6 control) a non-Telegram channel's non-numeric chatId is NOT refused", inAppBind !== undefined && inAppBind.flaggedNonPrivate === false);

  // ============ B. THE REST BIND HANDLER (POST /api/companion/bindings) ====================================
  {
    const bStub = {};
    const bound = [];
    const companion = { bind: (b) => bound.push(b), unbind: () => {}, reconcile: async () => {} };
    const app = await buildServer({ db, pty: bStub, sessions: bStub, mcp: bStub, orchMcp: bStub, platformMcp: bStub, auditMcp: bStub, userAuditMcp: bStub, setupMcp: bStub, runMcp: bStub, control: bStub, usageStatus: bStub, companion });
    const now = new Date().toISOString();
    db.insertProject({ id: "chatid-rest-proj", name: "chatid refusal REST", repoPath: "chatid-rest-proj", vaultPath: "chatid-rest-proj", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "chatid-rest-agent", projectId: "chatid-rest-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    db.insertSession({
      id: "rest-s1", projectId: "chatid-rest-proj", agentId: "chatid-rest-agent", engineSessionId: "eng-rest-s1", title: null, cwd: "chatid-rest-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });

    const badBind = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "rest-s1", channel: "telegram", chatId: "@somechannel", scope: "dm" } });
    check("(B) REST bind: non-numeric dm chatId → 400 (not 409/500)", badBind.statusCode === 400);
    check("(B) REST bind: 400's error names the problem", /numeric/i.test(JSON.parse(badBind.payload).error));
    check("(B) REST bind: the 400 wrote no row", db.listCompanionBindings().find((b) => b.sessionId === "rest-s1") === undefined);
    check("(B) REST bind: the 400 never poked the live gateway map", bound.length === 0);

    const groupBind = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "rest-s1", channel: "telegram", chatId: "@somechannel", scope: "group" } });
    check("(B control) REST bind: the SAME handle with scope \"group\" → 201", groupBind.statusCode === 201);

    const dup = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: "rest-s1", channel: "telegram", chatId: "@somechannel", scope: "group" } });
    const otherSess = "rest-s-conflict";
    db.insertSession({
      id: otherSess, projectId: "chatid-rest-proj", agentId: "chatid-rest-agent", engineSessionId: "eng-rest-s-conflict", title: null, cwd: "chatid-rest-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    const conflict = await app.inject({ method: "POST", url: "/api/companion/bindings", payload: { sessionId: otherSess, channel: "telegram", chatId: "@somechannel", scope: "group" } });
    check("(B) REST bind: a REAL route conflict (2nd session, same route) still → 409, untouched by the new 400 branch", conflict.statusCode === 409);
    void dup;
  }

  // ============ C. THE PROVISION ENDPOINT's GUARD 6 pre-spawn check =========================================
  {
    const now = new Date().toISOString();
    db.insertProject({ id: "chatid-prov-proj", name: "chatid refusal provision", repoPath: "chatid-prov-proj", vaultPath: "chatid-prov-proj", config: {}, createdAt: now, archivedAt: null });
    const profId = "chatid-prov-profile";
    db.insertProfile({ id: profId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
    const agentId = "chatid-prov-agent";
    db.insertAgent({ id: agentId, projectId: "chatid-prov-proj", name: "Companion Rig", startupPrompt: "P", position: 0, profileId: profId });

    let startNewCalls = 0;
    const sessionsStub = { startNew: () => { startNewCalls++; return { id: `fake-session-${startNewCalls}` }; } };
    const otherStub = {};
    const companion = { bind: () => {}, unbind: () => {}, reconcile: async () => {} };
    const app = await buildServer({ db, pty: otherStub, sessions: sessionsStub, mcp: otherStub, orchMcp: otherStub, platformMcp: otherStub, auditMcp: otherStub, userAuditMcp: otherStub, setupMcp: otherStub, runMcp: otherStub, control: otherStub, usageStatus: otherStub, companion });

    const badProvision = await app.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId, botToken: "123456:fake-token-xyz", allowedChatId: "@somechannel" },
    });
    check("(C) provision: non-numeric allowedChatId → 400", badProvision.statusCode === 400);
    check("(C) provision: 400's error names the problem", /numeric/i.test(JSON.parse(badProvision.payload).error));
    check("(C) provision: GUARD 6 rejected BEFORE any session spawn — startNew never called", startNewCalls === 0);
    check("(C) provision: no config row was written", db.listCompanionConfigs().length === 0);

    const goodProvision = await app.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId, botToken: "123456:fake-token-xyz", allowedChatId: "987654321" },
    });
    check("(C control) provision: a NUMERIC allowedChatId still succeeds → 201", goodProvision.statusCode === 201);
    check("(C control) provision: startNew WAS called exactly once for the valid request", startNewCalls === 1);
    check("(C control) provision: a config row now exists", db.listCompanionConfigs().length === 1);
  }

  // ============ D. THE CHEAP GUARD (item 4): TELEGRAM_CHANNEL really is "telegram" =========================
  check("(D) TELEGRAM_CHANNEL === \"telegram\" (the literal isLikelyGroupTelegramChatId/isNonNumericTelegramChatId duplicate)", TELEGRAM_CHANNEL === "telegram");
  check("(D) isLikelyGroupTelegramChatId recognizes the REAL TELEGRAM_CHANNEL constant, not just the string literal", isLikelyGroupTelegramChatId(TELEGRAM_CHANNEL, "-123") === true);
  check("(D) isNonNumericTelegramChatId recognizes the REAL TELEGRAM_CHANNEL constant, not just the string literal", isNonNumericTelegramChatId(TELEGRAM_CHANNEL, "@x") === true);
  check("(D control) neither predicate fires for an unrelated channel string that merely LOOKS like it", isLikelyGroupTelegramChatId("telegram2", "-123") === false && isNonNumericTelegramChatId("telegram2", "@x") === false);

  // ============ E. THE EXISTING-ROW BOOT BACKSTOP (a legacy non-numeric row) ================================
  const sessLegacy = "sess-legacy-nonnumeric";
  const legacyNow = new Date().toISOString();
  {
    const projectId = randomUUID();
    db.insertProject({ id: projectId, name: sessLegacy, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: legacyNow, archivedAt: null });
    const agentId = randomUUID();
    db.insertAgent({ id: agentId, projectId, name: "Companion", startupPrompt: "", position: 0 });
    db.insertSession({
      id: sessLegacy, projectId, agentId, engineSessionId: `eng-${sessLegacy}`, title: null, cwd: projectId,
      processState: "live", resumability: "resumable", busy: false,
      createdAt: legacyNow, lastActivity: legacyNow, lastError: null, role: "assistant", taskId: null,
    });
  }
  // Bypasses upsertCompanionBinding ENTIRELY via a raw INSERT — simulates a row written before this fix.
  db.db.prepare(
    `INSERT INTO companion_bindings (session_id, channel, chat_id, scope, created_at, flagged_non_private)
     VALUES (@sessionId, @channel, @chatId, @scope, @createdAt, 0)`,
  ).run({ sessionId: sessLegacy, channel: TELEGRAM_CHANNEL, chatId: "@legacychannel", scope: "dm", createdAt: legacyNow });
  check("(E setup) the legacy non-numeric row starts UNFLAGGED (simulates a pre-fix write)", db.listCompanionBindings().find((b) => b.sessionId === sessLegacy)?.flaggedNonPrivate === false);

  const cfgLegacy = { botToken: "fake-token", allowedChatId: "@legacychannel", sessionId: sessLegacy, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "@legacychannel", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
  const gwLegacy = createCompanionGateway(cfgLegacy, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessLegacy ? { channel: TELEGRAM_CHANNEL, chatId: "@legacychannel" } : null));
  const tgLegacy = fakeAdapter(TELEGRAM_CHANNEL);
  gwLegacy.registerAdapter(tgLegacy);
  const rLegacy = await gwLegacy.deliverReply(sessLegacy, "must never reach a channel the owner never confirmed as a private chat");
  check("(E) the boot-time backstop catches a LEGACY non-numeric row — no inbound needed", rLegacy.delivered === false && rLegacy.reason === "route-flagged-non-private");
  check("(E) persisted: the legacy row is now flagged", db.listCompanionBindings().find((b) => b.sessionId === sessLegacy)?.flaggedNonPrivate === true);

  // ============ F. PAIRING-CODE DM-BIND REDEMPTION — structurally unreachable, and safe if it ever were ======
  // F1: Telegram's own normalizer always stringifies a real numeric `message.chat.id` — there is no wire
  // shape that produces a non-numeric chatId from a real Telegram update.
  const normalized = normalizeTelegramMessage({ message: { chat: { id: -999888777 }, text: "hello", from: { id: 42 } } });
  check("(F1) normalizeTelegramMessage's chatId is always Number(...)-derived — a non-numeric chatId cannot originate from a real Telegram inbound", normalized?.chatId === "-999888777" && Number.isFinite(Number(normalized.chatId)));

  // F2: defense in depth — if a chatId ever did arrive non-numeric (e.g. a future adapter bug), the
  // redemption transaction's own try/catch around upsertCompanionBinding reduces ANY throw to the same
  // silent `rejected`, never an uncaught exception reaching the gateway/daemon. The REMOTE reply stays
  // silent (no pairing oracle) — but a SERVER-SIDE console.error must still fire, naming the session and
  // the reason, so an admin reading the daemon's own log is never left with zero signal (card 94754bbe,
  // manager-requested: a refusal must never be totally silent).
  const sessPairing = "sess-pairing-defense-in-depth";
  const pairing = createDbCompanionPairing(db, { now: () => Date.now() });
  const minted = db.mintPairingCode({ sessionId: sessPairing, channel: TELEGRAM_CHANNEL, grantType: "dm-bind", ttlMs: 10 * 60_000 }, Date.now());
  const gwPairing = new ChatGateway(() => ({ delivered: true }), [], createDbCompanionAuth(db), pairing, (sid) => (sid === sessPairing ? { channel: TELEGRAM_CHANNEL, chatId: "@injected-nonnumeric" } : null));
  const spyF2 = spyConsoleError();
  const redeemResult = await gwPairing.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "@injected-nonnumeric", body: minted.code, sender: { id: "owner-1" }, chatIsDirect: true });
  spyF2.restore();
  check("(F2) a hypothetical non-numeric pairing-redemption chatId is safely REJECTED (silent, no oracle, same as any failed redemption), never an uncaught throw", redeemResult.accepted === false && redeemResult.reason === "chat-not-allowlisted");
  check("(F2) the code stays UNCONSUMED on this safety refusal (same as the pre-existing UNIQUE-route-collision case)", db.listCompanionBindings().find((b) => b.sessionId === sessPairing) === undefined);
  check("(F2) the REMOTE reply carries NO hint of the real reason (no oracle) — reason is the generic chat-not-allowlisted, not anything chatId-specific", !JSON.stringify(redeemResult).includes("numeric"));
  check("(F2) but a SERVER-SIDE console.error DOES name the session + the refusal, so an admin reading the daemon log sees it", spyF2.calls.some((c) => c.includes(sessPairing.slice(0, 8)) && c.includes(TELEGRAM_CHANNEL) && /numeric/i.test(c)));

  // ============ G. THE ENV/BOOT BOOTSTRAP SEED's REFUSAL IS NEVER SILENT EITHER ===========================
  // The bootstrap-seed call (factory.ts) used to let a thrown InvalidTelegramChatIdError propagate OUT of
  // createCompanionGateway entirely — the ONLY place that error was ever seen was the generic
  // "[companion] hot-lifecycle reconcile failed: <message>" catch in controller.ts's enqueue(), which names
  // neither the session nor that this is a companion SETUP problem specifically. An owner whose
  // LOOM_COMPANION_CHAT_ID (or allowedChatId, if set via the companion config) is "@me" would see their
  // companion simply fail to arm with no further signal. Now: createCompanionGateway catches it itself,
  // logs a SPECIFIC, actionable console.error (which session, why, the remedy), and the gateway still
  // builds (degraded — no Telegram route — rather than not building at all).
  const sessBoot = "sess-boot-bootstrap-nonnumeric";
  const cfgBadBoot = { botToken: "fake-token", allowedChatId: "@me", sessionId: sessBoot, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "@me", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
  const spyG = spyConsoleError();
  let gwBootThrew = null;
  let gwBoot;
  try {
    gwBoot = createCompanionGateway(cfgBadBoot, () => ({ delivered: true }), db, undefined, (sid) => (sid === sessBoot ? { channel: TELEGRAM_CHANNEL, chatId: "@me" } : null));
  } catch (e) {
    gwBootThrew = e;
  }
  spyG.restore();
  check("(G) the env/bootstrap seed's refusal does NOT crash createCompanionGateway — it degrades instead of throwing", gwBootThrew === null && gwBoot !== undefined);
  check("(G) NO Telegram binding was written for the bad bootstrap chatId", db.listCompanionBindings().find((b) => b.sessionId === sessBoot) === undefined);
  check(
    "(G) a SPECIFIC console.error fires naming the session, that it's a SETUP/bootstrap problem, the non-numeric chatId, and the remedy (fix the chat id + restart, or re-bind via REST)",
    spyG.calls.some((c) => c.includes(sessBoot.slice(0, 8)) && /SETUP/.test(c) && /numeric/i.test(c) && /REST/.test(c)),
  );
  check("(G control) that console.error is NOT the generic, unspecific 'hot-lifecycle reconcile failed' catch-all", !spyG.calls.some((c) => /hot-lifecycle reconcile failed/.test(c)));
  // (G3) THE ACTUAL GOAL, NOT JUST A LOUD LOG: the Code Review of this card found the refusal above never
  // stopped real DELIVERY — only the BINDING write was refused, while a heartbeat/reminder/attention-push
  // targeting the SAME chatId via the turn's pinned origin (exactly what a configured HOME route carries)
  // still went through unsuppressed, because mayDeliverTo only ever consulted a BOUND route's flag. Prove
  // the outbound chokepoint itself now refuses it: a REAL ChatGateway, a REAL fake Telegram adapter, and a
  // deliverReply whose target resolves to the SAME non-numeric chatId the binding refused — this is RED on
  // the pre-mayDeliverTo-fix tip (confirmed via the revert/rebuild cycle in the worker report).
  //
  // card d3f9b4d2 round 2, Finding 1: the bootstrap-seed refusal above means gwBoot has ZERO bindings for
  // sessBoot — so, exactly like H1/H2 before their own fix, deliveryBlockReason's live-binding check (step
  // 4) would ALSO refuse this target regardless of the chatId-SHAPE check (step 3), making this RED test
  // indistinguishable from testing live-binding alone. Bind it directly on the gateway's in-memory routing
  // map (bypassing the write chokepoint, which would itself throw for this non-numeric chatId) so the SHAPE
  // check is the only thing that can still block the deliverReply below.
  gwBoot.bind({ sessionId: sessBoot, channel: TELEGRAM_CHANNEL, chatId: "@me", scope: "dm", flaggedNonPrivate: false });
  const tgBoot = fakeAdapter(TELEGRAM_CHANNEL);
  gwBoot.registerAdapter(tgBoot);
  const rBoot = await gwBoot.deliverReply(sessBoot, "must never reach a channel the owner never confirmed as a private chat");
  check("(G3) NO DELIVERY: a proactive reply targeting the refused non-numeric chatId is suppressed by the outbound chokepoint", rBoot.delivered === false);
  check("(G3) the fake adapter recorded NO send at all", tgBoot.sent.length === 0);

  // ============ H. mayDeliverTo COVERS A ROUTE WITH NO BINDING AT ALL (home, generalized) ==================
  // A hand-built ChatGateway, targeting the SAME sessionId with different chatId shapes. H1/H2 are BOUND
  // (a live dm-scope binding for the exact chatId under test) so the live-binding check (step 4 of
  // deliveryBlockReason) can never be the thing that blocks them — isolating the chatId-SHAPE check (step 3)
  // as the only possible cause of a refusal. H3 is deliberately left UNBOUND — it tests the live-binding
  // check itself, not the shape check (see its own comment above).
  for (const [label, chatId, expectDelivered, preBound] of [
    ["(H1) non-numeric target (\"@chan\") backed by a LIVE dm binding", "@chan", false, true],
    ["(H2) negative-integer target (the 61e33b99 class) backed by a LIVE dm binding", "-1005554443332", false, true],
    ["(H3) ordinary positive-chatId UNBOUND target (a normal home, card d3f9b4d2: route-unbound)", "500500500", false, false],
  ]) {
    const initialBindings = preBound ? [{ sessionId: "home-sess", channel: TELEGRAM_CHANNEL, chatId, scope: "dm", flaggedNonPrivate: false }] : [];
    const gwH = new ChatGateway(() => ({ delivered: true }), initialBindings, undefined, undefined, (sid) => (sid === "home-sess" ? { channel: TELEGRAM_CHANNEL, chatId } : null));
    const tgH = fakeAdapter(TELEGRAM_CHANNEL);
    gwH.registerAdapter(tgH);
    const rH = await gwH.deliverReply("home-sess", "proactive turn");
    check(`${label}: delivered === ${expectDelivered}`, rH.delivered === expectDelivered);
    check(`${label}: adapter recorded a send iff delivered`, tgH.sent.length === (expectDelivered ? 1 : 0));
  }
  // H4 control: the SAME non-numeric/negative shapes are NOT refused when an EXPLICIT group-scope binding
  // backs that exact (channel, chatId) — the scope exemption holds even though mayDeliverTo resolves the
  // binding structurally (not through the db chokepoint at all, for this hand-built gateway).
  {
    const groupBinding = { sessionId: "home-sess-group", channel: TELEGRAM_CHANNEL, chatId: "@grouphandle", scope: "group" };
    const gwH4 = new ChatGateway(
      () => ({ delivered: true }), [groupBinding], undefined, undefined,
      (sid) => (sid === "home-sess-group" ? { channel: TELEGRAM_CHANNEL, chatId: "@grouphandle" } : null),
    );
    const tgH4 = fakeAdapter(TELEGRAM_CHANNEL);
    gwH4.registerAdapter(tgH4);
    const rH4 = await gwH4.deliverReply("home-sess-group", "group turn");
    check("(H4 control) a non-numeric target backed by an explicit group-scope binding is NOT refused", rH4.delivered === true && tgH4.sent.length === 1);
  }

  // ============ I. WRITE-TIME GUARDS (convenience 400s — H above is the real guarantee) ====================
  {
    const now = new Date().toISOString();
    db.insertProject({ id: "chatid-write-proj", name: "chatid refusal write-guards", repoPath: "chatid-write-proj", vaultPath: "chatid-write-proj", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "chatid-write-agent", projectId: "chatid-write-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    db.insertSession({
      id: "write-guard-sess", projectId: "chatid-write-proj", agentId: "chatid-write-agent", engineSessionId: "eng-write-guard-sess", title: null, cwd: "chatid-write-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    const profIdI = "chatid-write-profile";
    db.insertProfile({ id: profIdI, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
    const agentIdI = "chatid-write-prov-agent";
    db.insertAgent({ id: agentIdI, projectId: "chatid-write-proj", name: "Companion Rig", startupPrompt: "P", position: 0, profileId: profIdI });
    const companionStub = { bind: () => {}, unbind: () => {}, reconcile: async () => {} };
    const otherStubI = {};
    let startNewCallsI = 0;
    const sessionsStubI = { startNew: () => { startNewCallsI++; return { id: `fake-session-i-${startNewCallsI}` }; } };
    const appI = await buildServer({ db, pty: otherStubI, sessions: sessionsStubI, mcp: otherStubI, orchMcp: otherStubI, platformMcp: otherStubI, auditMcp: otherStubI, userAuditMcp: otherStubI, setupMcp: otherStubI, runMcp: otherStubI, control: otherStubI, usageStatus: otherStubI, companion: companionStub });

    // I1/I2: PUT /api/companion/home.
    const badHome = await appI.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "write-guard-sess", channel: "telegram", chatId: "@chan" } });
    check("(I1) PUT /api/companion/home: a non-numeric telegram chatId → 400", badHome.statusCode === 400);
    check("(I1) 400's error names the problem", /numeric/i.test(JSON.parse(badHome.payload).error));
    check("(I1) no home was written", db.getCompanionHome("write-guard-sess") === null);
    // card d3f9b4d2 Minor 1: PUT /home now also requires a LIVE binding for the target route — bind it
    // first (this control's actual subject is the numeric-shape guard, not the live-binding one).
    db.upsertCompanionBinding({ sessionId: "write-guard-sess", channel: "telegram", chatId: "600700800", scope: "dm" });
    const goodHome = await appI.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "write-guard-sess", channel: "telegram", chatId: "600700800" } });
    check("(I2 control) PUT /api/companion/home: a numeric telegram chatId still succeeds → 200", goodHome.statusCode === 200);

    // I2b/I2c: card 1b0df437 item 6 — a group-"@handle" home IS accepted once a LIVE GROUP binding backs
    // the exact same route (mirrors ChatGateway.deliveryBlockReason's own group-scope exemption), but a
    // "@handle" with NO group binding on that route is still refused exactly like I1.
    const stillBadHandle = await appI.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "write-guard-sess", channel: "telegram", chatId: "@ourgrouphome" } });
    check("(I2b) a group handle with NO live group binding on that route is still refused → 400", stillBadHandle.statusCode === 400);
    db.upsertCompanionBinding({ sessionId: "write-guard-sess", channel: "telegram", chatId: "@ourgrouphome", scope: "group" });
    const groupHomeOk = await appI.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "write-guard-sess", channel: "telegram", chatId: "@ourgrouphome" } });
    check("(I2c) the SAME group handle, now backed by a live GROUP binding, is accepted → 200", groupHomeOk.statusCode === 200);
    check("(I2c) the group-handle home was actually written", JSON.stringify(db.getCompanionHome("write-guard-sess")) === JSON.stringify({ channel: "telegram", chatId: "@ourgrouphome" }));
    // (card 1b0df437 Code Review, nitpick) no "restore the numeric home" call here — nothing in the I3-I5
    // block below reads this session's home, so a bare unasserted PUT call would be exactly the "silently
    // 400s and nobody notices" shape this cleanup is about; dropped rather than asserted on for a value
    // nothing downstream depends on.

    // I3/I4: POST /api/companion/config's allowedChatId (buildCompanionUpsert).
    const badConfig = await appI.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: "write-guard-sess", botToken: "123456:fake-token-config", allowedChatId: "@chan", chatScope: "dm" },
    });
    check("(I3) POST /api/companion/config: a dm-scope non-numeric allowedChatId → 400", badConfig.statusCode === 400);
    check("(I3) 400's error names the problem", /numeric/i.test(JSON.parse(badConfig.payload).error));
    check("(I3) no config row was written", db.getCompanionConfig("write-guard-sess") === undefined);
    const groupConfig = await appI.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: "write-guard-sess", botToken: "123456:fake-token-config", allowedChatId: "@chan", chatScope: "group" },
    });
    check("(I4 control) POST /api/companion/config: a GROUP-scope non-numeric allowedChatId is NOT refused → 201", groupConfig.statusCode === 201);

    // I5: the provision endpoint's `home` field.
    const badProvisionHome = await appI.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId: agentIdI, botToken: "123456:fake-token-xyz-home", allowedChatId: "987654322", home: { channel: "telegram", chatId: "@chan" } },
    });
    check("(I5) provision: a non-numeric home.chatId → 400", badProvisionHome.statusCode === 400);
    check("(I5) 400's error names the problem", /numeric/i.test(JSON.parse(badProvisionHome.payload).error));
    check("(I5) GUARD rejected BEFORE any session spawn — startNew never called", startNewCallsI === 0);

    // ============ J. card 1b0df437 Code Review, item 4 =====================================================
    // J(i) TRUST NEGATIVE: validateHomeTarget's group-scope exemption (I2b/I2c above) reads bindings
    // SCOPED TO THE SESSION whose home is being set — a DIFFERENT session's live group binding on the
    // exact same (channel, chatId) handle must NOT let this session claim that handle as its own home.
    // RED on a buggy implementation that queried bindings globally instead of per-session.
    const sessOwnerB = "write-guard-sess-owner-b";
    db.insertSession({
      id: sessOwnerB, projectId: "chatid-write-proj", agentId: "chatid-write-agent", engineSessionId: `eng-${sessOwnerB}`, title: null, cwd: "chatid-write-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    db.upsertCompanionBinding({ sessionId: sessOwnerB, channel: "telegram", chatId: "@sessionbtrustscope", scope: "group" });
    const sessOwnerA = "write-guard-sess-owner-a";
    db.insertSession({
      id: sessOwnerA, projectId: "chatid-write-proj", agentId: "chatid-write-agent", engineSessionId: `eng-${sessOwnerA}`, title: null, cwd: "chatid-write-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    const crossSessionHome = await appI.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sessOwnerA, channel: "telegram", chatId: "@sessionbtrustscope" },
    });
    check("(Ji TRUST NEGATIVE) session A cannot claim session B's live group-bound handle as its OWN home → 400", crossSessionHome.statusCode === 400);
    // validateHomeTarget's group-scope EXEMPTION (the shape check's own `groupBound` lookup) is ALSO scoped
    // to the session whose home is being set — so for session A (who owns no binding on this handle at
    // all) the exemption never applies, and the SHAPE check refuses it first, before the live-binding check
    // ever runs. Both checks are per-session; this is which one fires first, not a second trust gap.
    check("(Ji) the 400 is the SHAPE guard (groupBound is scoped to session A, which owns no binding here)", /numeric/i.test(JSON.parse(crossSessionHome.payload).error));
    check("(Ji) no home was written for session A", db.getCompanionHome(sessOwnerA) === null);
    // Control: session B itself (the actual owner of the binding) CAN set it as its own home.
    const ownHomeOk = await appI.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sessOwnerB, channel: "telegram", chatId: "@sessionbtrustscope" },
    });
    check("(Ji control) the binding's OWN session can set it as its home → 200", ownHomeOk.statusCode === 200);

    // (Ji isolation) the SAME trust boundary, isolated past the shape guard: a NUMERIC chatId (so the shape
    // check can never be the thing that blocks this) bound live to session B must still refuse session A —
    // this is what actually proves the LIVE-BINDING check itself (not just the shape exemption) is
    // per-session, not a global "does ANY session have this route bound" lookup.
    db.upsertCompanionBinding({ sessionId: sessOwnerB, channel: "telegram", chatId: "600700801", scope: "dm" });
    const crossSessionNumericHome = await appI.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sessOwnerA, channel: "telegram", chatId: "600700801" },
    });
    check("(Ji isolation TRUST NEGATIVE) session A cannot claim session B's live NUMERIC binding as its OWN home → 400", crossSessionNumericHome.statusCode === 400);
    check("(Ji isolation) the 400 is the LIVE-BINDING guard this time (the shape is fine)", /no live binding/i.test(JSON.parse(crossSessionNumericHome.payload).error));
    check("(Ji isolation) no home was written for session A", db.getCompanionHome(sessOwnerA) === null);

    // J(ii): the config route's own `home` field (applyHomeIfPresent, routed through the SAME
    // validateHomeTarget as PUT /home above) also accepts a group-backed @handle — mirrors I2b/I2c, but
    // through POST /api/companion/config's `home` field rather than the dedicated PUT /home route.
    const sessConfigHome = "write-guard-sess-config-home";
    db.insertSession({
      id: sessConfigHome, projectId: "chatid-write-proj", agentId: "chatid-write-agent", engineSessionId: `eng-${sessConfigHome}`, title: null, cwd: "chatid-write-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    const badConfigHomeHandle = await appI.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: sessConfigHome, botToken: "123456:fake-token-config-home", allowedChatId: "121121122", home: { channel: "telegram", chatId: "@configroutegroup" } },
    });
    check("(Jii) config route: a group handle home with NO live group binding on that route is refused → 400", badConfigHomeHandle.statusCode === 400);
    db.upsertCompanionBinding({ sessionId: sessConfigHome, channel: "telegram", chatId: "@configroutegroup", scope: "group" });
    const goodConfigHomeHandle = await appI.inject({
      method: "POST", url: "/api/companion/config",
      payload: { sessionId: sessConfigHome, botToken: "123456:fake-token-config-home", allowedChatId: "121121122", home: { channel: "telegram", chatId: "@configroutegroup" } },
    });
    check("(Jii) config route: the SAME group handle, now backed by a live GROUP binding, is accepted → 201", goodConfigHomeHandle.statusCode === 201);
    check("(Jii) the group-handle home was actually written via the config route", JSON.stringify(db.getCompanionHome(sessConfigHome)) === JSON.stringify({ channel: "telegram", chatId: "@configroutegroup" }));

    // ============ K. card ddf08614 ===========================================================================
    // K(i) THE REAL REPRO: a dm-scope Telegram binding on a negative/group-shaped chatId is auto-flagged
    // non-private by the write chokepoint itself (card 61e33b99) — it is still a LIVE binding ROW, so the
    // pre-fix validateHomeTarget (which only checked a binding row EXISTS) wrongly accepted it as a home.
    // RED on that pre-fix code: PUT /api/companion/home must now refuse it, same as `deliveryBlockReason`
    // would refuse every real delivery to it.
    const sessFlaggedHome = "write-guard-sess-flagged-home";
    db.insertSession({
      id: sessFlaggedHome, projectId: "chatid-write-proj", agentId: "chatid-write-agent", engineSessionId: `eng-${sessFlaggedHome}`, title: null, cwd: "chatid-write-proj",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    db.upsertCompanionBinding({ sessionId: sessFlaggedHome, channel: "telegram", chatId: "-100555", scope: "dm" });
    const flaggedHomeRejected = await appI.inject({
      method: "PUT", url: "/api/companion/home",
      payload: { sessionId: sessFlaggedHome, channel: "telegram", chatId: "-100555" },
    });
    check("(Ki) PUT /api/companion/home: a LIVE but flagged-non-private binding's chatId is now refused → 400", flaggedHomeRejected.statusCode === 400);
    check("(Ki) 400's error names the problem", /flagged non-private/i.test(JSON.parse(flaggedHomeRejected.payload).error));
    check("(Ki) no home was written", db.getCompanionHome(sessFlaggedHome) === null);

    // K(ii) the provision endpoint's `home` field gets the SAME treatment, pre-spawn: a home matching the
    // Telegram dm route THIS call is about to bind (negative/group-shaped chatId ⇒ the write chokepoint
    // would flag it non-private) is refused up front, before any session is spawned.
    let startNewCallsK = 0;
    const sessionsStubK = { startNew: () => { startNewCallsK++; return { id: `fake-session-k-${startNewCallsK}` }; } };
    const appK = await buildServer({ db, pty: otherStubI, sessions: sessionsStubK, mcp: otherStubI, orchMcp: otherStubI, platformMcp: otherStubI, auditMcp: otherStubI, userAuditMcp: otherStubI, setupMcp: otherStubI, runMcp: otherStubI, control: otherStubI, usageStatus: otherStubI, companion: companionStub });
    const badProvisionFlaggedHome = await appK.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId: agentIdI, botToken: "123456:fake-token-xyz-flagged-home", allowedChatId: "-100555", home: { channel: "telegram", chatId: "-100555" } },
    });
    check("(Kii) provision: a home matching the about-to-be-flagged telegram route → 400", badProvisionFlaggedHome.statusCode === 400);
    check("(Kii) 400's error names the problem", /flagged non-private/i.test(JSON.parse(badProvisionFlaggedHome.payload).error));
    check("(Kii) GUARD rejected BEFORE any session spawn — startNew never called", startNewCallsK === 0);
  }
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — db.upsertCompanionBinding refuses (InvalidTelegramChatIdError) a dm-scope Telegram binding whose chatId isn't numeric at all, at the one write chokepoint, so the REST bind handler (400), the provision endpoint (400, pre-spawn), the env bootstrap seed, and pairing-code redemption (structurally unreachable, and safe either way) can never persist one; a negative-integer chatId is still only flagged (never refused); a group-scope or non-Telegram binding is never refused; a legacy pre-fix row is still caught at boot; the duplicated TELEGRAM_CHANNEL literal still matches the real constant; the outbound chokepoint (ChatGateway.mayDeliverTo) now also refuses a non-numeric or negative-integer target with NO binding at all (companion HOME, generalized), the actual leak the Code Review widened this card to close, while a group-scope-backed target is never refused; the write-time guards (PUT /api/companion/home, POST/PUT /api/companion/config's allowedChatId, the provision endpoint's home field) all reject a non-numeric dm-scope target up front; (card 1b0df437) PUT /api/companion/home now accepts a @handle home once a live GROUP binding backs the exact same route, mirroring the outbound chokepoint's own exemption, while one with no such binding is still refused; a DIFFERENT session's live group binding on that exact handle can never be claimed as another session's home (the live-binding check is per-session, not global); and the config route's own `home` field accepts the same group-backed @handle the dedicated PUT /home route does."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
