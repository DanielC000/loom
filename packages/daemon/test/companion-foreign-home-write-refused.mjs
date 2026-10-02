import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — card 5ba1c39f (from the c7d7b43a delta security review, reviewer 053c4f19).
//
// c7d7b43a closed the in-app cross-session DELIVERY leak: `companionRouteBlockReason` now refuses a
// cross-session in-app route with `route-foreign-session`. But `validateHomeTarget` (gateway/server.ts) —
// the ONE guard shared by PUT /api/companion/home and the config route's own `home` field
// (applyHomeIfPresent) — only ever mapped `route-flagged-non-private` / `route-unbound` to a 400; a
// `route-foreign-session` blockReason fell through to `return null` (valid). So a WRITE naming a foreign
// in-app chatId was silently ACCEPTED and stored — delivery still refuses it (nothing leaks), but the
// owner got a 200 for a dead home, boot-time reconcile never flags it (warnStaleStoredHomes reused the
// SAME "no live binding — pair or bind this chat first" message for every refused reason, including this
// one, which is actively misleading: there's nothing to pair/bind, it's an ownership mismatch), and the
// code comment + docs/decisions/c7d7b43a-*.md's own claim that this caller guards it was false as shipped.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL buildServer (app.inject) + the REAL
// resolveAllCompanionConfigs (store.ts) boot resolver. NO network, NO real claude, NO daemon.
//
// Covers the DoD:
//   1. PUT /api/companion/home with a foreign in-app chatId → 400, and the durable home is left UNSET (not
//      silently written). Positive control: the SAME session's OWN in-app chatId → 200, home written.
//   2. The config route's own `home` field (applyHomeIfPresent) is routed through the SAME guard: a CREATE
//      naming a foreign in-app home → 400, no config row written at all; an UPDATE (tokenless) naming a
//      foreign in-app home on an ALREADY-live config → 400, the previously-stored home is left untouched.
//   3. warnStaleStoredHomes (store.ts, the boot-time backstop) branches its message on the ACTUAL reason —
//      a foreign-session in-app home gets a disclosure-safe "owned by another session" message, never the
//      "no live binding — pair or bind this chat first" text (there's nothing to pair/bind here). Negative
//      control: a genuinely unbound (non-in-app) home still gets the ORIGINAL "no live binding" message —
//      this card narrows the branch, it does not touch the pre-existing unbound-message path.
// Run: 1) build (turbo builds shared first), 2) node test/companion-foreign-home-write-refused.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-foreign-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { resolveAllCompanionConfigs } = await import("../dist/companion/store.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

const dbFile = (name) => path.join(tmpHome, name);
const stubApp = async (db) => {
  const stub = {};
  return buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {} });
};

try {
  // ============ 1 — PUT /api/companion/home refuses a foreign in-app chatId (400) =====================
  {
    const db = new Db(dbFile("p1.db"));
    const app = await stubApp(db);

    const bad = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-B" } });
    check("1: PUT home with a foreign in-app chatId → 400", bad.statusCode === 400);
    check("1: error names 'owned by another session'", String(JSON.parse(bad.payload).error).includes("owned by another session"));
    check("1: no home was written for the refused attempt", db.getCompanionHome("sess-A") === null);

    // Positive control: the SAME session naming its OWN in-app chatId succeeds.
    const good = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: "sess-A", channel: IN_APP_CHANNEL, chatId: "sess-A" } });
    check("1 (control): PUT home with the session's OWN in-app chatId → 200", good.statusCode === 200);
    check("1 (control): home was actually written", JSON.stringify(db.getCompanionHome("sess-A")) === JSON.stringify({ channel: IN_APP_CHANNEL, chatId: "sess-A" }));

    await app.close();
    db.close();
  }

  // ============ 2 — the config route's own `home` field (applyHomeIfPresent) shares the SAME guard =====
  {
    const db = new Db(dbFile("p2.db"));
    const app = await stubApp(db);
    const now = new Date().toISOString();
    db.insertProject({ id: "p2-proj", name: "Foreign Home", repoPath: "p2-proj", vaultPath: "p2-proj", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "p2-agent", projectId: "p2-proj", name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    db.insertSession({ id: "sess-C", projectId: "p2-proj", agentId: "p2-agent", engineSessionId: "eng-sess-C", title: null, cwd: "p2-proj", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant" });

    // CREATE with a foreign in-app `home` → 400, no row written at all.
    const createBad = await app.inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-C", botToken: "1111111111:AAAtoken-fixture-zzz1234", allowedChatId: "700700700", chatScope: "dm",
      home: { channel: IN_APP_CHANNEL, chatId: "sess-D" },
    } });
    check("2a: config CREATE with a foreign in-app home → 400", createBad.statusCode === 400);
    check("2a: error names 'owned by another session'", String(JSON.parse(createBad.payload).error).includes("owned by another session"));
    check("2a: no config row was written for the refused create", db.getCompanionConfig("sess-C") === undefined);

    // Now actually create it (own in-app home), then prove an UPDATE naming a foreign home is ALSO refused
    // and leaves the already-stored home untouched.
    const createGood = await app.inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-C", botToken: "1111111111:AAAtoken-fixture-zzz1234", allowedChatId: "700700700", chatScope: "dm",
      home: { channel: IN_APP_CHANNEL, chatId: "sess-C" },
    } });
    check("2 (control): config CREATE with the session's OWN in-app home → 201", createGood.statusCode === 201);
    check("2 (control): home stored as the session's own route", JSON.stringify(db.getCompanionHome("sess-C")) === JSON.stringify({ channel: IN_APP_CHANNEL, chatId: "sess-C" }));

    const updBad = await app.inject({ method: "POST", url: "/api/companion/config", payload: {
      sessionId: "sess-C", home: { channel: IN_APP_CHANNEL, chatId: "sess-D" },
    } });
    check("2b: config UPDATE (tokenless) with a foreign in-app home → 400", updBad.statusCode === 400);
    check("2b: the PREVIOUSLY-stored own-route home is untouched by the refused update", JSON.stringify(db.getCompanionHome("sess-C")) === JSON.stringify({ channel: IN_APP_CHANNEL, chatId: "sess-C" }));

    await app.close();
    db.close();
  }

  // ============ 3 — warnStaleStoredHomes branches its message on the ACTUAL reason =====================
  {
    const db = new Db(dbFile("p3.db"));
    // A foreign-session in-app home written DIRECTLY (bypassing validateHomeTarget — simulates
    // already-corrupt stored state, or a row written before this card's REST fix shipped).
    db.upsertCompanionConfig({ sessionId: "sess-E", botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: "sess-E", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db.setCompanionHome("sess-E", { channel: IN_APP_CHANNEL, chatId: "sess-F" });
    // Negative control, SAME boot pass: a genuinely unbound (non-in-app) home on a DIFFERENT session —
    // must keep getting the ORIGINAL "no live binding" message, proving this card narrowed the branch
    // rather than replacing the pre-existing unbound-message path.
    db.upsertCompanionConfig({ sessionId: "sess-G", botTokenBlob: "", channel: "telegram", allowedChatId: "600600600", chatScope: "dm", heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true });
    db.setCompanionHome("sess-G", { channel: "telegram", chatId: "600600600" });

    const errors = [];
    const origError = console.error;
    console.error = (...args) => { errors.push(args.join(" ")); };
    try {
      resolveAllCompanionConfigs(db, {}); // no LOOM_COMPANION_* in this explicit env — runs warnStaleStoredHomes only
    } finally {
      console.error = origError;
    }

    const foreignLine = errors.find((e) => e.includes("sess-E"));
    check("3a: a SETUP line was logged for the foreign-session home", !!foreignLine);
    check("3a: it names 'owned by another session', not the unbound-route message", !!foreignLine && foreignLine.includes("owned by another session") && !foreignLine.includes("no live binding"));
    check("3a: disclosure-safe — never the foreign chatId itself", !!foreignLine && !foreignLine.includes("sess-F"));

    const unboundLine = errors.find((e) => e.includes("sess-G"));
    check("3b (control): the genuinely-unbound home still gets the ORIGINAL message", !!unboundLine && unboundLine.includes("no live binding") && !unboundLine.includes("owned by another session"));

    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — validateHomeTarget (shared by PUT /api/companion/home and the config route's own `home` field) now refuses a foreign-session in-app home at write time (400, disclosure-safe 'owned by another session' message, no row/home written), and warnStaleStoredHomes (the boot-time backstop) branches its log message on the actual blockReason instead of reusing the unbound-route message for every refused reason."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
