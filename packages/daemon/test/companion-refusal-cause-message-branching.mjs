import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — card 7e4db63f, from the ddf08614 delta review (reviewer 030f7f60). Three call sites that
// all branch on `companionRouteBlockReason`'s result were each giving the wrong message for ONE of its
// possible reasons:
//
//   1. The PROVISION endpoint's pre-spawn `home` check (gateway/server.ts) mapped EVERY `route-unbound`
//      reason to "home chatId must be a numeric Telegram chat id" — even a perfectly numeric home that
//      simply doesn't match the one route this call will actually write (its own allowedChatId, or the
//      automatic in-app route). Now branches like `validateHomeTarget` already did: a genuinely bad SHAPE
//      still gets the numeric-chat-id message; a numeric-but-unmatched home gets a DIFFERENT one naming the
//      real problem (it isn't the chat this provision binds).
//   2. `warnStaleStoredHomes` (store.ts, the boot-time backstop) fell through to its badShape ternary for
//      EVERY non-`route-foreign-session` reason — so a LIVE binding flagged non-private at RUNTIME (shape
//      is fine, there IS a row) got the "no live binding... pair or bind first" message, which is false:
//      there's nothing to pair or bind, the binding already exists and is flagged. Now branches on
//      `route-flagged-non-private` explicitly, same shape as the pre-existing `route-foreign-session` branch.
//
// Each of the THREE call sites that consult `companionRouteBlockReason` for a home
// (`warnStaleStoredHomes`/store.ts, `CompanionReplyStatus.homeRouteRefused`/server.ts,
// `validateHomeTarget`/server.ts) is proven against the SAME flag-ONLY binding: a NUMERIC, private-shaped
// chatId flagged non-private purely via the RUNTIME `flagCompanionBindingNonPrivate` call — never via
// shape. The existing "-100555" fixtures elsewhere (companion-reply-status.mjs's (9g),
// companion-nonnumeric-telegram-chatid-refusal.mjs's (K)) trip the flag AND a bad shape TOGETHER (a
// negative/group-shaped chatId is auto-flagged non-private at write time by its own shape), so neither can
// isolate "the flag branch is actually consulted" from "the shape-based badShape ternary happened to also
// read true" — a store.ts implementation that kept branching on `badShape` instead of the real `reason`
// would still pass -100555-shaped assertions for the wrong reason. This file's binding never trips badShape
// at all, so ONLY a correct branch-on-`reason` implementation can produce the right message here.
//
// Fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL buildServer (app.inject) + the REAL
// resolveAllCompanionConfigs (store.ts) boot resolver. NO network, NO real claude, NO daemon.
//
// Run: 1) pnpm build (turbo builds shared first), 2) node test/companion-refusal-cause-message-branching.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-refusal-messages-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
for (const k of Object.keys(process.env)) if (k.startsWith("LOOM_COMPANION_")) delete process.env[k];

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { resolveAllCompanionConfigs } = await import("../dist/companion/store.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);
const stub = {};
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});

const now = new Date().toISOString();
db.insertProject({ id: "rcm-proj", name: "Refusal Cause Messages", repoPath: "rcm-proj", vaultPath: "rcm-proj", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "rcm-agent", projectId: "rcm-proj", name: "Ada", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
const seedSession = (id) => db.insertSession({
  id, projectId: "rcm-proj", agentId: "rcm-agent", engineSessionId: `eng-${id}`, title: null, cwd: "rcm-proj",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
});
const seedCompanion = (sessionId, enabled = true) => {
  seedSession(sessionId);
  db.upsertCompanionConfig({
    sessionId, botTokenBlob: "", channel: "telegram", allowedChatId: "chat-1", chatScope: "dm",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled, name: "Ada",
  });
};

try {
  // ============ 1 — PROVISION: a numeric but UNMATCHED home gets its OWN message, not the numeric-shape one
  {
    db.insertProfile({ id: "rcm-profile", name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null });
    db.insertAgent({ id: "rcm-prov-agent", projectId: "rcm-proj", name: "Companion Rig", startupPrompt: "P", position: 0, profileId: "rcm-profile" });

    let startNewCalls = 0;
    const sessionsStub = { startNew: () => { startNewCalls++; return { id: `rcm-prov-sess-${startNewCalls}` }; } };
    const companionStub = { bind: () => {}, unbind: () => {}, reconcile: async () => {} };
    const provApp = await buildServer({
      db, pty: stub, sessions: sessionsStub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, companion: companionStub,
    });

    // 1a: home ("343343343") is numerically SHAPED fine but does NOT match this call's own allowedChatId
    // ("121121121") — RED on the pre-fix code, which gave the numeric-shape message for every route-unbound
    // reason regardless of whether the shape was actually the problem.
    const mismatched = await provApp.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId: "rcm-prov-agent", botToken: "123456:fake-token-rcm-1", allowedChatId: "121121121", home: { channel: "telegram", chatId: "343343343" } },
    });
    check("(1a) provision: a numeric but unmatched home → 400", mismatched.statusCode === 400);
    const mismatchedErr = String(JSON.parse(mismatched.payload).error);
    check("(1a) error names the real problem (not the chat this provision binds)", mismatchedErr.includes("must be the chat this provision binds"));
    check("(1a) error does NOT reuse the numeric-shape message for this different cause", !mismatchedErr.includes("must be a numeric Telegram chat id"));
    check("(1a) GUARD rejected BEFORE any session spawn — startNew never called", startNewCalls === 0);
    check("(1a) no config row was written for the refused attempt", db.listCompanionConfigs().length === 0);

    // 1b (POSITIVE CONTROL): home == allowedChatId (the ONE legitimate provision home) still provisions
    // 201 with the home kept — so a broken planned-binding match can't silently refuse the one route this
    // call is actually about to bind.
    const matched = await provApp.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId: "rcm-prov-agent", botToken: "123456:fake-token-rcm-2", allowedChatId: "121121121", home: { channel: "telegram", chatId: "121121121" } },
    });
    check("(1b control) provision: home == allowedChatId → 201", matched.statusCode === 201);
    check("(1b control) startNew WAS called exactly once for the valid request", startNewCalls === 1);
    const mintedSessionId = `rcm-prov-sess-${startNewCalls}`;
    check("(1b control) the home was actually kept", JSON.stringify(db.getCompanionHome(mintedSessionId)) === JSON.stringify({ channel: "telegram", chatId: "121121121" }));

    // 1c: a genuinely BAD-SHAPED home ("@notaprivatechat") still gets the numeric-shape message — proves
    // this card's new branch is ADDITIVE, not a replacement of the pre-existing shape-refusal path.
    const badShape = await provApp.inject({
      method: "POST", url: "/api/companion/provision",
      payload: { agentId: "rcm-prov-agent", botToken: "123456:fake-token-rcm-3", allowedChatId: "121121123", home: { channel: "telegram", chatId: "@notaprivatechat" } },
    });
    check("(1c control) provision: a bad-shaped home still → 400", badShape.statusCode === 400);
    check("(1c control) error is still the numeric-shape message for a genuinely bad shape", /must be a numeric Telegram chat id/.test(JSON.parse(badShape.payload).error));

    await provApp.close();
  }

  // ============ 2/3 — THE FLAG-ONLY FIXTURE: a NUMERIC, private-shaped chatId flagged non-private purely
  // via the RUNTIME flagCompanionBindingNonPrivate call (never via shape) — isolates "the flag branch is
  // actually consulted" from "badShape happened to also read true" (what -100555-shaped fixtures elsewhere
  // can't isolate; see this file's header). =========================================================
  const flagOnlySession = "rcm-flag-only";
  seedCompanion(flagOnlySession, true);
  db.upsertCompanionBinding({ sessionId: flagOnlySession, channel: "telegram", chatId: "131131131", scope: "dm" });
  check("(setup) the flag-only binding starts UNFLAGGED (numeric, private-shaped — shape never auto-flags it)", db.getCompanionBindingsForSession(flagOnlySession).find((b) => b.channel === "telegram")?.flaggedNonPrivate === false);
  db.flagCompanionBindingNonPrivate(flagOnlySession, "telegram"); // RUNTIME flag — the ONLY reason this binding is flagged
  check("(setup) the binding is now flagged, by the runtime call alone", db.getCompanionBindingsForSession(flagOnlySession).find((b) => b.channel === "telegram")?.flaggedNonPrivate === true);
  db.setCompanionHome(flagOnlySession, { channel: "telegram", chatId: "131131131" });

  // Negative control, same boot pass: a genuinely UNBOUND numeric home (no binding row at all) on a
  // DIFFERENT session — proves this card's new flagged-non-private branch doesn't swallow the pre-existing
  // route-unbound message.
  const unboundSession = "rcm-genuinely-unbound";
  seedCompanion(unboundSession, true);
  db.setCompanionHome(unboundSession, { channel: "telegram", chatId: "909909909" }); // no matching binding

  // ---- 2: warnStaleStoredHomes (store.ts boot-time backstop) ----
  {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => { errors.push(args.join(" ")); };
    try {
      resolveAllCompanionConfigs(db, {}); // no LOOM_COMPANION_* in this explicit env — runs warnStaleStoredHomes only
    } finally {
      console.error = origError;
    }

    const flaggedLine = errors.find((e) => e.includes(flagOnlySession.slice(0, 8)));
    check("(2a) a SETUP line was logged for the flag-only home", !!flaggedLine);
    check("(2a) it names 'flagged non-private'", !!flaggedLine && flaggedLine.includes("flagged non-private"));
    check("(2a) it does NOT reuse the false 'no live binding... pair or bind first' message — RED on the pre-fix badShape-ternary branch", !!flaggedLine && !flaggedLine.includes("no live binding"));

    const unboundLine = errors.find((e) => e.includes(unboundSession.slice(0, 8)));
    check("(2b control) the genuinely-unbound home still gets the ORIGINAL 'no live binding' message", !!unboundLine && unboundLine.includes("no live binding") && !unboundLine.includes("flagged non-private"));
  }

  // ---- 3a: homeRouteRefused (CompanionReplyStatus, server.ts) ----
  {
    const statusRes = await app.inject({ method: "GET", url: `/api/companion/status/${flagOnlySession}` });
    check("(3a) GET /api/companion/status/:id: flag-only home → 200", statusRes.statusCode === 200);
    check("(3a) homeRouteRefused:true for the flag-only (shape-fine) binding", JSON.parse(statusRes.payload)?.homeRouteRefused === true);
  }

  // ---- 3b: validateHomeTarget (PUT /api/companion/home, server.ts) ----
  {
    // Re-submitting the SAME (channel, chatId, scope) as a home PUT must still be refused — the flag is
    // runtime-set and a same-route re-submission never clears it (card c7d7b43a).
    const putRes = await app.inject({ method: "PUT", url: "/api/companion/home", payload: { sessionId: flagOnlySession, channel: "telegram", chatId: "131131131" } });
    check("(3b) PUT /api/companion/home: flag-only (shape-fine) target → 400", putRes.statusCode === 400);
    const putErr = String(JSON.parse(putRes.payload).error);
    check("(3b) error names 'flagged non-private', not 'no live binding'", putErr.includes("flagged non-private") && !putErr.includes("no live binding"));
  }
} finally {
  await app.close();
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the provision endpoint's pre-spawn home check now gives a numeric-but-unmatched home its own message distinct from a genuinely bad chatId shape (with a positive control proving the one legitimate provision home — home == allowedChatId — still provisions), and warnStaleStoredHomes/homeRouteRefused/validateHomeTarget all correctly identify a LIVE binding flagged non-private purely at runtime (never via shape) as 'flagged non-private', never the false 'no live binding... pair or bind first' message — isolated from the pre-existing -100555-shaped fixtures elsewhere, which trip the flag and a bad shape together and so can't tell a correct branch-on-reason implementation apart from one that merely reused badShape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
