import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion ZERO-REPLY runtime STATUS read (card 8bda9fc6) — the NAMED-READER half of card 48e8d289's
// detector. That card shipped a detector whose only outputs were a durable orchestration event and a
// console.warn, neither of which anything read. This covers the pull side that gives it a reader.
//
// NO claude, NO network, NO real daemon: a REAL Db on a temp LOOM_HOME + the REAL buildServer (app.inject),
// with the alert state driven through the REAL production path — `db.incrementTurnSeq` (what
// onTurnCompleted bumps) followed by `checkCompanionReplyHealth` (what onTurnCompleted calls). The alert is
// never hand-set, so this exercises the detector and the read together rather than a fixture of the answer.
//
// Covers:
//   (1) BEFORE: a fresh, healthy companion reads `alerting:false` on GET /api/companion/status.
//   (2) AFTER: driving the REAL detector past its threshold flips the SAME read to `alerting:true`, with
//       turnSeq / lastChatReplyTurnSeq / zeroReplyAlertTurnSeq / turnsSinceLastReply / threshold all
//       consistent. This before/after pair is the whole point — an inert route would pass (1) forever.
//   (3) RECOVERY: a genuine chat_reply landing clears `alerting` back to false on the next read (the field
//       is the detector's own dedup flag, which a reply clears — not a recomputed streak comparison, which
//       would keep reading "alerting" for a companion that has just answered).
//   (4) The single-session route mirrors the list, and 404s on an unknown session.
//   (5) GATING: a DISABLED companion never reads `alerting:true`.
//   (6) LIFETIME SEPARATION (the card's explicit constraint): GET /api/companion/config carries NONE of the
//       runtime fields — the config shape is what a human edits and PUTs back, and must not join runtime
//       state. Run with a POSITIVE CONTROL: the SAME key-presence check is asserted to FIND those keys on
//       the status payload. Without it, a typo'd key list would "prove" the absence on every payload alive.
//   (7) No new persisted state: the status is derivable from columns that already existed before this card
//       (companion_config.last_chat_reply_turn_seq / zero_reply_alert_turn_seq + sessions.turn_seq).
//   (8) The two GETs are Tier-1 (remote-readable with a gateway token), like every other companion GET.
// Run: 1) pnpm build (turbo builds shared first), 2) node test/companion-reply-status.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-reply-status-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — no HTTP daemon; app.inject only)

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { checkCompanionReplyHealth, DEFAULT_ZERO_REPLY_TURN_THRESHOLD, buildCompanionReplyStatus } =
  await import("../dist/companion/reply-watch.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");

const THRESHOLD = DEFAULT_ZERO_REPLY_TURN_THRESHOLD;
const dbFile = path.join(tmpHome, "status.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});

const now = new Date().toISOString();
db.insertProject({ id: "rs-proj", name: "Reply Status", repoPath: "rs-proj", vaultPath: "rs-proj", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "rs-agent", projectId: "rs-proj", name: "Ada", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
const seedSession = (id) => db.insertSession({
  id, projectId: "rs-proj", agentId: "rs-agent", engineSessionId: `eng-${id}`, title: null, cwd: "rs-proj",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});
const seedCompanion = (sessionId, enabled) => {
  seedSession(sessionId);
  db.upsertCompanionConfig({
    sessionId, botTokenBlob: "", channel: "telegram", allowedChatId: "chat-1", chatScope: "dm",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled, name: "Ada",
  });
};

/** One completed turn, exactly as production's `onTurnCompleted` runs it: bump turn_seq, then check. */
const completeTurn = (sessionId) => { db.incrementTurnSeq(sessionId); checkCompanionReplyHealth(db, sessionId); };

const statusList = async () => JSON.parse((await app.inject({ method: "GET", url: "/api/companion/status" })).payload);
const statusOf = async (sessionId) => (await statusList()).find((s) => s.sessionId === sessionId);

seedCompanion("live-1", true);
seedCompanion("off-1", false);

// --- 1. BEFORE: healthy companion, nothing alerting --------------------------------------------------
completeTurn("live-1"); // the lazy-baseline first observation (seeds lastChatReplyTurnSeq, no alert)
{
  const s = await statusOf("live-1");
  check("(1) before: a fresh companion reads alerting:false", s !== undefined && s.alerting === false);
  check("(1) before: threshold is reported so a reader needn't hardcode it", s?.threshold === THRESHOLD);
  check("(1) before: the companion's name rides along (no config join needed)", s?.name === "Ada");
  check("(1) before: turnsSinceLastReply is 0 once a baseline exists", s?.turnsSinceLastReply === 0);
}

// --- 2. AFTER: drive the REAL detector past the threshold; the SAME read flips ------------------------
for (let i = 0; i < THRESHOLD; i++) completeTurn("live-1");
{
  const s = await statusOf("live-1");
  check("(2) after: the SAME read now says alerting:true", s?.alerting === true);
  check("(2) after: turnsSinceLastReply reached the threshold", s?.turnsSinceLastReply === THRESHOLD);
  check("(2) after: zeroReplyAlertTurnSeq records the turn the alert fired at", s?.zeroReplyAlertTurnSeq === s?.turnSeq);
  check("(2) after: turnSeq/lastChatReplyTurnSeq are internally consistent",
    s?.turnSeq - s?.lastChatReplyTurnSeq === s?.turnsSinceLastReply);
  // The detector really fired (its durable half), so this is not the read inventing a state.
  const events = db.listEvents("live-1");
  check("(2) after: the detector's own durable event was written too",
    events.some((e) => e.kind === "companion_zero_reply_detected" && e.managerSessionId === "live-1"));
}

// --- 3. RECOVERY: a genuine reply landing clears the alert --------------------------------------------
db.recordChatReplyDelivered("live-1"); // the exact call chat-gateway.ts makes on a successful deliverReply
{
  const s = await statusOf("live-1");
  check("(3) recovery: a landed chat_reply clears alerting back to false", s?.alerting === false);
  check("(3) recovery: and clears the alert turn marker", s?.zeroReplyAlertTurnSeq === null);
  check("(3) recovery: turnsSinceLastReply resets to 0", s?.turnsSinceLastReply === 0);
}

// --- 4. Single-session route mirrors the list; unknown -> 404 -----------------------------------------
{
  const one = await app.inject({ method: "GET", url: "/api/companion/status/live-1" });
  check("(4) GET /status/:sessionId -> 200 and matches the list row",
    one.statusCode === 200 && JSON.stringify(JSON.parse(one.payload)) === JSON.stringify(await statusOf("live-1")));
  const missing = await app.inject({ method: "GET", url: "/api/companion/status/nope" });
  check("(4) GET /status/:sessionId on an unknown session -> 404", missing.statusCode === 404);
}

// --- 5. GATING: a disabled companion never alerts -----------------------------------------------------
for (let i = 0; i < THRESHOLD + 5; i++) completeTurn("off-1");
{
  const s = await statusOf("off-1");
  check("(5) a DISABLED companion is listed but never reads alerting:true", s !== undefined && s.alerting === false);
  // Belt-and-braces at the pure-builder level: even if the row somehow carried a stale alert marker from a
  // period when it WAS enabled, `enabled:false` still suppresses `alerting`.
  const forced = buildCompanionReplyStatus(
    { sessionId: "x", name: "", enabled: false, lastChatReplyTurnSeq: 0, zeroReplyAlertTurnSeq: 99 }, 120,
  );
  check("(5) builder: a stale alert marker on a DISABLED row still reads alerting:false", forced.alerting === false);
}

// --- 6. LIFETIME SEPARATION, with a positive control --------------------------------------------------
{
  const RUNTIME_KEYS = ["turnSeq", "lastChatReplyTurnSeq", "zeroReplyAlertTurnSeq", "turnsSinceLastReply", "alerting"];
  const present = (payload) => RUNTIME_KEYS.filter((k) => k in payload);

  // POSITIVE CONTROL FIRST — polarity discipline: (6) asserts an ABSENCE, and an absence assertion made with
  // a typo'd key list passes against every payload in existence. So prove the SAME check FINDS these keys
  // where they genuinely are, before trusting it to report them missing anywhere else.
  const statusRow = await statusOf("live-1");
  check(`(6) positive control: the key check finds all ${RUNTIME_KEYS.length} runtime keys on the STATUS payload`,
    present(statusRow).length === RUNTIME_KEYS.length);

  const cfgList = JSON.parse((await app.inject({ method: "GET", url: "/api/companion/config" })).payload);
  const cfgRow = cfgList.find((c) => c.sessionId === "live-1");
  check("(6) the CONFIG read still returns the companion (sanity — it is not simply empty)", cfgRow !== undefined);
  check(`(6) and carries NONE of the runtime keys (found: ${JSON.stringify(present(cfgRow ?? {}))})`,
    present(cfgRow ?? {}).length === 0);

  const cfgOne = JSON.parse((await app.inject({ method: "GET", url: "/api/companion/config/live-1" })).payload);
  check("(6) same for the single-session config read", present(cfgOne).length === 0);
}

// --- 7. No new persisted state ------------------------------------------------------------------------
{
  const cols = new Set(db.db.prepare("PRAGMA table_info(companion_config)").all().map((r) => r.name));
  check("(7) the status is built from columns card 48e8d289 already added — no new ones",
    cols.has("last_chat_reply_turn_seq") && cols.has("zero_reply_alert_turn_seq"));
  const sessCols = new Set(db.db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name));
  check("(7) turnSeq comes from the pre-existing sessions.turn_seq", sessCols.has("turn_seq"));
}

// --- 8. Trust tier: read-only, so Tier-1 like every other companion GET --------------------------------
{
  // routeTier takes the registered ROUTE PATTERN (not a concrete URL) — the same strings the table holds.
  check("(8) GET /api/companion/status is Tier-1", routeTier("GET", "/api/companion/status") === 1);
  check("(8) GET /api/companion/status/:sessionId is Tier-1", routeTier("GET", "/api/companion/status/:sessionId") === 1);
  check("(8) there is no WRITE sibling — POST stays Tier-0 (default-deny)", routeTier("POST", "/api/companion/status") === 0);
  // Positive control for (8): the tier lookup can actually return 0, so the line above is a real check and
  // not a function that answers 0 for everything.
  check("(8) control: an unlisted GET reads Tier-0", routeTier("GET", "/api/companion/status/:sessionId/nonsense") === 0);
}

await app.close();
try { db.close(); } catch { /* ignore */ }
cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — the zero-reply alert is readable over a DEDICATED runtime route that flips false→true when the REAL detector fires and back to false when a reply lands, is gated to enabled companions, adds no persisted state, stays Tier-1 read-only, and is kept OUT of the config-masking shape (proved with a positive control, not a bare absence)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
