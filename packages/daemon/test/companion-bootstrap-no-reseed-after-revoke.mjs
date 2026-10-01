import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — card a8480338 (from the d3f9b4d2 review): `factory.ts`'s `createCompanionGateway`
// bootstrap-seed used to re-create a Telegram binding from `companion_config.allowed_chat_id` on EVERY
// gateway build whenever a token companion's session had ZERO bindings — not just on genuine FIRST
// provisioning. An owner who DELETEs every binding (revoking the chat) leaves `companion_config` untouched
// (the cascade is one-way: deleting a config cleans its bindings, never the reverse), so the NEXT gateway
// build (a daemon restart) silently re-seeded the exact binding the owner just revoked — see
// docs/decisions/a8480338-bootstrap-seed-must-not-reseed-a-revoked-binding.md.
//
// Fully hermetic: a REAL Db (fresh + a simulated pre-migration legacy DB) + the REAL
// createCompanionGateway/resolveAllCompanionConfigs production wiring. NO network, NO real claude, NO daemon.
//
// Covers:
//   A. THE BUG, end to end through the REAL boot resolver (resolveAllCompanionConfigs) + the REAL factory:
//      boot #1 bootstrap-seeds the binding and marks the config row `bindingsSeeded`; an owner revoke then
//      empties the bindings; a SIMULATED RESTART (resolveAllCompanionConfigs + createCompanionGateway again)
//      must NOT re-seed it. (RED on the pre-fix code — see the worker report for the revert/rebuild proof.)
//   B. PRESERVE-ON-OMIT: the env-bootstrap re-upsert that runs on EVERY boot never resets bindingsSeeded
//      back to false (it's omitted from that call by design).
//   C. NEGATIVE CONTROL: a genuinely brand-new session (never seeded before) still bootstrap-seeds on its
//      very first gateway build — this fix must not break first-time provisioning.
//   D. MIGRATION BACKFILL: a pre-existing (pre-this-fix) companion_config row gains the new column via the
//      idempotent ADD COLUMN migration and backfills to bindingsSeeded:TRUE (not false) — so an UPGRADED
//      install whose owner had already revoked every binding is ALSO never re-seeded after the upgrade.
//   D2. MIGRATION BACKFILL PRECISION (Code Review MAJOR 1a, fix round): the blanket backfill above is wrong
//      for a row whose seed was REFUSED (94754bbe InvalidTelegramChatIdError — dm scope + non-numeric chat
//      id) — it never wrote a binding, so it was never genuinely seeded. Two legacy rows in the SAME
//      pre-migration DB copy: a VALID chat id still backfills TRUE; an INVALID (refused) one backfills
//      FALSE — and, once backfilled FALSE, the owner fixing the chat id and restarting genuinely re-seeds
//      it (proving the narrowing actually unblocks recovery, not just flips a flag in isolation).
//   E. A REFUSED SEED (non-numeric chat id, a FRESH non-migrated row) leaves bindingsSeeded FALSE — never
//      marked on a refusal — and after the owner fixes the chat id, the next gateway build genuinely seeds.
//   F. NEVER SILENT (Code Review MAJOR 1b): a token companion with zero bindings AND bindingsSeeded:true
//      logs ONE disclosure-safe SETUP line (session id only — no chat id, no content) at gateway build.
// Run: 1) build (turbo builds shared first), 2) node test/companion-bootstrap-no-reseed-after-revoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Spies console.warn so a test can assert a specific SETUP line was actually printed, and that it stays
// disclosure-safe (no chat id) — real console.log is left untouched so PASS/FAIL lines above still print.
function spyConsoleWarn() {
  const calls = [];
  const real = console.warn;
  console.warn = (...args) => { calls.push(args.map(String).join(" ")); };
  return { calls, restore: () => { console.warn = real; } };
}

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-bindings-seeded-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { resolveAllCompanionConfigs } = await import("../dist/companion/store.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const now0 = new Date().toISOString();
function seedSession(targetDb, id) {
  const projectId = randomUUID();
  targetDb.insertProject({ id: projectId, name: id, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: now0, archivedAt: null });
  const agentId = randomUUID();
  targetDb.insertAgent({ id: agentId, projectId, name: "Companion", startupPrompt: "", position: 0 });
  targetDb.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now0, lastActivity: now0, lastError: null, role: "assistant", taskId: null,
  });
}

try {
  // ============ A/B. THE BUG, end to end through the REAL boot resolver + factory ============
  const SID = "sess-revoke-reseed";
  seedSession(db, SID);
  process.env.LOOM_COMPANION_BOT_TOKEN = "8222222222:AAguard-bootstrap-token";
  process.env.LOOM_COMPANION_CHAT_ID = "700700700";
  process.env.LOOM_COMPANION_SESSION_ID = SID;

  const cfgs1 = resolveAllCompanionConfigs(db, process.env);
  check("(setup) boot #1 resolves exactly one effective config for the env-pinned session", cfgs1.length === 1 && cfgs1[0].sessionId === SID);
  check("(setup) a brand-new config row starts bindingsSeeded:false", cfgs1[0].bindingsSeeded === false);

  const gw1 = createCompanionGateway(cfgs1[0], () => ({ delivered: true }), db);
  check("(A) boot #1 bootstrap-seeds the Telegram binding from allowedChatId", db.listCompanionBindings().some((b) => b.sessionId === SID && b.channel === TELEGRAM_CHANNEL && b.chatId === "700700700"));
  check("(A) the config row is marked bindingsSeeded after the genuine first seed", db.getCompanionConfig(SID)?.bindingsSeeded === true);

  // Owner revokes: delete EVERY binding for this session (mirrors DELETE /api/companion/bindings/:sessionId
  // with no `channel` query param — db.deleteCompanionBinding's full-unbind shape).
  db.deleteCompanionBinding(SID);
  check("(revoke) zero bindings remain for this session after the owner's revoke", db.listCompanionBindings().filter((b) => b.sessionId === SID).length === 0);

  // Simulate the NEXT daemon boot (a restart): re-resolve (re-upserts the config row — env is still set) and
  // rebuild the gateway, exactly like index.ts's boot sequence.
  const cfgs2 = resolveAllCompanionConfigs(db, process.env);
  check("(B) the env-bootstrap re-upsert on a later boot does NOT reset bindingsSeeded back to false", cfgs2[0].bindingsSeeded === true);
  const gw2 = createCompanionGateway(cfgs2[0], () => ({ delivered: true }), db);
  check("(A) THE FIX: a gateway rebuild after a revoke does NOT re-seed the binding", db.listCompanionBindings().filter((b) => b.sessionId === SID).length === 0);

  // ============ C. NEGATIVE CONTROL — a genuinely brand-new session still gets seeded ============
  const SID2 = "sess-genuine-first-boot";
  seedSession(db, SID2);
  const cfg2 = {
    botToken: "fake-token-genuine-2", allowedChatId: "800800800", sessionId: SID2, chatScope: "dm",
    homeChannel: TELEGRAM_CHANNEL, homeChatId: "800800800", heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
  };
  createCompanionGateway(cfg2, () => ({ delivered: true }), db);
  check("(C control) a genuinely brand-new session still bootstrap-seeds on its very first gateway build", db.listCompanionBindings().some((b) => b.sessionId === SID2 && b.chatId === "800800800"));

  // ============ D. MIGRATION BACKFILL — a pre-existing (pre-fix) companion_config row ============
  const legacyPath = path.join(tmpHome, "legacy-bindings-seeded.db");
  const raw = new Database(legacyPath);
  raw.exec(`
    CREATE TABLE companion_config (
      session_id TEXT PRIMARY KEY,
      bot_token_blob TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'telegram',
      allowed_chat_id TEXT NOT NULL,
      chat_scope TEXT NOT NULL DEFAULT 'dm',
      heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 0,
      heartbeat_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      provisioned INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
  `);
  raw.prepare(
    "INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope, heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at) VALUES (?, '', 'telegram', '900900900', 'dm', 0, NULL, 1, 0, '', ?, ?)",
  ).run("sess-legacy-upgrade", now0, now0);
  raw.close();

  const legacyDb = new Db(legacyPath); // opening runs the idempotent additive migration

  const rawCheck = new Database(legacyPath, { readonly: true });
  const legacyCols = rawCheck.prepare("PRAGMA table_info(companion_config)").all().map((c) => c.name);
  rawCheck.close();
  check("(D) the additive migration adds the bindings_seeded column to a pre-existing DB", legacyCols.includes("bindings_seeded"));

  const legacyRow = legacyDb.getCompanionConfig("sess-legacy-upgrade");
  check("(D) a pre-existing (pre-fix) config row backfills bindingsSeeded:TRUE, not false", legacyRow?.bindingsSeeded === true);
  check("(D) the legacy row's OTHER fields survive the migration untouched", legacyRow?.allowedChatId === "900900900" && legacyRow?.provisioned === false);

  // That upgraded install currently holds ZERO bindings for this session (simulates an owner who revoked
  // before/at the time of upgrade) — building its cfg from the backfilled row and rebuilding its gateway
  // must NOT re-seed, exactly like the live-upgrade case in Part A/B.
  seedSession(legacyDb, "sess-legacy-upgrade");
  const legacyCfg = {
    botToken: "legacy-fake-token", allowedChatId: legacyRow.allowedChatId, sessionId: "sess-legacy-upgrade",
    chatScope: legacyRow.chatScope, homeChannel: TELEGRAM_CHANNEL, homeChatId: legacyRow.allowedChatId,
    heartbeatIntervalMinutes: 0, heartbeatPrompt: "", bindingsSeeded: legacyRow.bindingsSeeded,
  };
  createCompanionGateway(legacyCfg, () => ({ delivered: true }), legacyDb);
  check("(D) an upgraded install with zero CURRENT bindings is NOT re-seeded (the backfill treats it as already-seeded)", legacyDb.listCompanionBindings().filter((b) => b.sessionId === "sess-legacy-upgrade").length === 0);

  legacyDb.close();

  // ============ D2. MIGRATION BACKFILL PRECISION — a REFUSED seed backfills to FALSE, not true ============
  // Card a8480338 fix round (Code Review MAJOR 1a): a legacy row whose allowed_chat_id would be REFUSED by
  // the SAME validator factory.ts's bootstrap-seed uses (isNonNumericTelegramChatId, dm scope) never wrote
  // a binding — it was never genuinely seeded — so the blanket backfill-to-TRUE is wrong for it. One pre-
  // migration DB copy, two rows: a VALID chat id (control, mirrors Part D above) and an INVALID one.
  const legacyPath2 = path.join(tmpHome, "legacy-bindings-seeded-refused.db");
  const raw2 = new Database(legacyPath2);
  raw2.exec(`
    CREATE TABLE companion_config (
      session_id TEXT PRIMARY KEY,
      bot_token_blob TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'telegram',
      allowed_chat_id TEXT NOT NULL,
      chat_scope TEXT NOT NULL DEFAULT 'dm',
      heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 0,
      heartbeat_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      provisioned INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
  `);
  raw2.prepare(
    "INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope, heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at) VALUES (?, '', 'telegram', '901901901', 'dm', 0, NULL, 1, 0, '', ?, ?)",
  ).run("sess-legacy-valid-chatid", now0, now0);
  raw2.prepare(
    "INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope, heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at) VALUES (?, '', 'telegram', '@not-a-number', 'dm', 0, NULL, 1, 0, '', ?, ?)",
  ).run("sess-legacy-refused-chatid", now0, now0);
  raw2.close();

  const legacyDb2 = new Db(legacyPath2); // opening runs the idempotent additive migration + precise narrowing
  check("(D2 control) a legacy row with a VALID (numeric, dm) chat id still backfills bindingsSeeded:TRUE", legacyDb2.getCompanionConfig("sess-legacy-valid-chatid")?.bindingsSeeded === true);
  check("(D2) THE FIX: a legacy row with a REFUSED (non-numeric, dm) chat id backfills bindingsSeeded:FALSE, not true — it was never genuinely seeded", legacyDb2.getCompanionConfig("sess-legacy-refused-chatid")?.bindingsSeeded === false);
  legacyDb2.close();

  // ============ E. A REFUSED SEED (fresh row) leaves bindingsSeeded FALSE; fixing the chat id then seeds ====
  // Card a8480338 fix round, MINOR 3: independent of migration — a FRESH (CREATE TABLE, bindings_seeded
  // defaults 0) token companion whose chat id is non-numeric must never be marked bindingsSeeded after its
  // seed is refused, and once the owner corrects the chat id, the NEXT gateway build must genuinely seed.
  const SID3 = "sess-refused-seed-then-fixed";
  seedSession(db, SID3);
  db.upsertCompanionConfig({
    sessionId: SID3, botTokenBlob: "", channel: TELEGRAM_CHANNEL, allowedChatId: "@not-a-number",
    chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
  });
  check("(E setup) a fresh config row starts bindingsSeeded:false", db.getCompanionConfig(SID3)?.bindingsSeeded === false);

  const cfg3a = {
    botToken: "fake-token-refused", allowedChatId: "@not-a-number", sessionId: SID3, chatScope: "dm",
    homeChannel: TELEGRAM_CHANNEL, homeChatId: "@not-a-number", heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
    bindingsSeeded: db.getCompanionConfig(SID3)?.bindingsSeeded,
  };
  createCompanionGateway(cfg3a, () => ({ delivered: true }), db);
  check("(E) a refused seed (non-numeric chat id) writes NO binding", db.listCompanionBindings().filter((b) => b.sessionId === SID3).length === 0);
  check("(E) a refused seed leaves bindingsSeeded FALSE (never marked on a refusal)", db.getCompanionConfig(SID3)?.bindingsSeeded === false);

  // Owner fixes the chat id (mirrors a REST config update) and the daemon restarts.
  db.upsertCompanionConfig({
    sessionId: SID3, botTokenBlob: "", channel: TELEGRAM_CHANNEL, allowedChatId: "911911911",
    chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
  });
  const cfg3b = {
    botToken: "fake-token-refused", allowedChatId: "911911911", sessionId: SID3, chatScope: "dm",
    homeChannel: TELEGRAM_CHANNEL, homeChatId: "911911911", heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
    bindingsSeeded: db.getCompanionConfig(SID3)?.bindingsSeeded,
  };
  createCompanionGateway(cfg3b, () => ({ delivered: true }), db);
  check("(E) THE FIX: after fixing the chat id, the NEXT gateway build genuinely seeds the binding", db.listCompanionBindings().some((b) => b.sessionId === SID3 && b.chatId === "911911911"));
  check("(E) bindingsSeeded flips TRUE after the genuine seed", db.getCompanionConfig(SID3)?.bindingsSeeded === true);

  // ============ F. NEVER SILENT — a stranded (zero-bindings, bindingsSeeded:true) companion logs a SETUP line
  // Card a8480338 fix round, MAJOR 1b: whether stranded by a deliberate revoke OR a refused-then-backfilled
  // row, factory.ts must log SOMETHING at gateway build — disclosure-safe (no chat id, no content). Reuses
  // SID (Part A/B's revoked session: zero bindings, bindingsSeeded:true at this point in the run).
  {
    const spy = spyConsoleWarn();
    const cfgStranded = {
      botToken: "fake-token-stranded", allowedChatId: "700700700", sessionId: SID, chatScope: "dm",
      homeChannel: TELEGRAM_CHANNEL, homeChatId: "700700700", heartbeatIntervalMinutes: 0, heartbeatPrompt: "",
      bindingsSeeded: true,
    };
    createCompanionGateway(cfgStranded, () => ({ delivered: true }), db);
    spy.restore();
    check("(F) a stranded (zero-bindings, bindingsSeeded:true) companion logs a SETUP line naming the session", spy.calls.some((c) => c.includes("SETUP") && c.includes(SID.slice(0, 8))));
    check("(F) the SETUP line is disclosure-safe — it never names the (real or stale) allowedChatId", !spy.calls.some((c) => c.includes("700700700")));
    check("(F) the SETUP line still writes NO binding (never re-seeds just because it logged)", db.listCompanionBindings().filter((b) => b.sessionId === SID).length === 0);
  }
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — factory.ts's bootstrap-seed fires only on genuine first provisioning (cfg.bindingsSeeded false): a brand-new session still gets seeded on its first gateway build, but once seeded (fresh OR a migrated legacy row) an owner's full binding revoke is never undone by a later gateway build (restart), the env-bootstrap re-upsert that runs on every boot never resets the flag back to false, the migration's precise backfill correctly narrows a REFUSED (non-numeric chat id) legacy row to bindingsSeeded:false rather than true (so fixing the chat id genuinely re-seeds it, whether via migration or on a fresh row), and a stranded companion (zero bindings, bindingsSeeded:true) always logs a disclosure-safe SETUP line rather than staying silent."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
