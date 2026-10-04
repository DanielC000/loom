import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a21f5c9e — two follow-ups from the Code Review of 72c58b1c (reviewer 1c76bbca):
//
// PART 1 — webhook wake mode converges onto the SAME MCP-seen-gated durable `SessionService
// .enqueueDurableNudge` path `EventTriggerService.fire` already uses (card 90b9e904), instead of a raw
// `pty.enqueueStdin` call with no gate. `enqueueDurableNudge` is void, so the "dropped -> reject -> undo
// the dedupe row" signal (72c58b1c) is re-derived via its new optional `opts.onOutcome` callback.
//
// PART 2 — undo-replay amplification: a target whose fire fails EVERY time used to let one captured
// delivery replay indefinitely (bounded only by the 10/min per-endpoint spawn-rate cap), each replay
// undoing the dedupe row and re-firing. A new `replayCooldownLimiter` gate (REPLAY_COOLDOWN_MS, checked
// BEFORE the dedupe row is recorded, same shape as the existing rate-limit check) bounds this to at most
// one fire ATTEMPT per (endpoint, deliveryId) per cooldown window. Round 2 (lead ruling): a cooldown-
// blocked replay answers 429 + Retry-After + {replayCooldown:true}, never 200 {duplicate:true}.
//
// All scenarios here drive `registerWebhookIngress` directly on a bare Fastify instance with STUBBED
// `sessions`/`pty` deps (mirrors webhook-ingress.mjs's own (14)/(15)/(16) scenario blocks) — a REAL `Db`
// backs `WebhookIngressDb` throughout (it now needs `getSession` too). HERMETIC, no real claude, no network.
//
// PART 1 (d) below is a REGRESSION GUARD, not a fallback test — Round 2 (item 4) DELETED the raw
// pty.enqueueStdin fallback (`enqueueDurableNudge` is now a required dependency); see
// webhook-enqueue-durable-nudge-wiring.mjs for the separate production-wiring assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Fastify from "fastify";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-webhook-edn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createWebhookEndpoint } = await import("../dist/webhooks/store.js");
const { registerWebhookIngress, REPLAY_COOLDOWN_MS } = await import("../dist/webhooks/ingress.js");

const dbFile = (name) => path.join(tmpHome, name);
const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
const settle = () => new Promise((r) => setImmediate(r));

// Sign a "generic" (current, v1-prefixed) request — mirrors webhook-ingress.mjs's own signGeneric.
function signGeneric(secret, rawBodyStr, deliveryId, nowMs = Date.now()) {
  const rawBody = Buffer.from(rawBodyStr, "utf8");
  const tsSec = Math.floor(nowMs / 1000);
  const signedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${tsSec}.`, "utf8"), rawBody]);
  const sig = "sha256=" + hexHmac(secret, signedContent);
  return {
    payload: rawBodyStr,
    headers: { "content-type": "application/json", "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId },
  };
}

function makeDb(name, { role } = {}) {
  const db = new Db(dbFile(name));
  const now = new Date().toISOString();
  db.insertProject({ id: "edn-proj", name: "edn", repoPath: "edn-proj", vaultPath: "edn-proj", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "edn-agent", projectId: "edn-proj", name: "spawn-target", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "edn-wake-sess", projectId: "edn-proj", agentId: "edn-agent", engineSessionId: "eng-1", title: null,
    cwd: "edn-proj", processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: role ?? null,
  });
  return db;
}

try {
  // ===================== PART 1 (a) — convergence: enqueueDurableNudge is called, not raw enqueueStdin,
  // and carries the target's role + kind:"agent" =====================
  {
    const db = makeDb("p1a.db", { role: "manager" });
    const endpoint = createWebhookEndpoint(db, {
      name: "Converge target", sourceType: "generic", secret: "p1a-secret", mode: "wake",
      targetSessionId: "edn-wake-sess", agentId: null,
    });
    const durableCalls = [];
    const rawEnqueueCalls = [];
    const app = Fastify();
    registerWebhookIngress(app, {
      db, pty: {
        isAlive: () => true,
        // Must NEVER be reached once enqueueDurableNudge is wired — a call here is itself a FAIL signal.
        enqueueStdin: (...args) => { rawEnqueueCalls.push(args); return { delivered: true, deliveryState: "handed-off" }; },
      },
      sessions: {
        startNew: () => { throw new Error("should not be called (wake mode)"); },
        resume: () => { throw new Error("should not be called (already alive)"); },
        enqueueDurableNudge: (id, role, text, taskId, opts) => {
          durableCalls.push({ id, role, text, taskId, opts });
          opts.onOutcome({ dispatched: true, result: { delivered: true, deliveryState: "handed-off", msgId: "m-p1a" } });
        },
      },
    });
    await app.ready();
    const { payload, headers } = signGeneric("p1a-secret", '{"i":1}', "p1a-delivery-1");
    const r = await app.inject({ method: "POST", url: `/hooks/${endpoint.path}`, payload, headers });
    check("(P1a) wake delivery -> 200", r.statusCode === 200);
    await settle();
    check("(P1a) fires via enqueueDurableNudge, not raw pty.enqueueStdin", durableCalls.length === 1 && rawEnqueueCalls.length === 0);
    check("(P1a) carries the target's REAL role", durableCalls[0].id === "edn-wake-sess" && durableCalls[0].role === "manager");
    check("(P1a) kind:'agent', taskId null (own turn, never coalesced)", durableCalls[0].opts.kind === "agent" && durableCalls[0].taskId === null);
    check("(P1a) a handed-off dispatch keeps the dedupe row", db.hasWebhookDelivery(endpoint.id, "generic:p1a-delivery-1") === true);
    await app.close();
    db.close();
  }

  // ===================== PART 1 (b) — dispatched:false (the MCP-seen wait itself failed) is the ONE case
  // that undoes the dedupe row — RED on main: main never calls enqueueDurableNudge at all, so main would
  // reach the raw pty.enqueueStdin fallback below instead, which is wired to THROW to make that divergence
  // loud rather than silently passing for the wrong reason =====================
  {
    const db = makeDb("p1b.db", { role: "manager" });
    const endpoint = createWebhookEndpoint(db, {
      name: "Never-dispatched target", sourceType: "generic", secret: "p1b-secret", mode: "wake",
      targetSessionId: "edn-wake-sess", agentId: null,
    });
    const app = Fastify();
    registerWebhookIngress(app, {
      db, pty: {
        isAlive: () => true,
        enqueueStdin: () => { throw new Error("MUST NOT be reached — pre-a21f5c9e code takes this path, post-a21f5c9e code must not"); },
      },
      sessions: {
        startNew: () => { throw new Error("should not be called (wake mode)"); },
        resume: () => { throw new Error("should not be called (already alive)"); },
        enqueueDurableNudge: (id, role, text, taskId, opts) => {
          // Simulates waitForMcpSeen rejecting — enqueueDurableMessage never ran, nothing was recorded.
          opts.onOutcome({ dispatched: false, error: new Error("waitForMcpSeen timed out (simulated)") });
        },
      },
    });
    await app.ready();
    const { payload, headers } = signGeneric("p1b-secret", '{"i":1}', "p1b-delivery-1");
    const r = await app.inject({ method: "POST", url: `/hooks/${endpoint.path}`, payload, headers });
    check("(P1b) wake delivery -> 200 (ACK sent before the fire)", r.statusCode === 200);
    await settle();
    check("(P1b) dispatched:false -> dedupe row UNDONE (nothing was ever recorded)", db.hasWebhookDelivery(endpoint.id, "generic:p1b-delivery-1") === false);
    await app.close();
    db.close();
  }

  // ===================== PART 1 (c) — the DISCLOSED behavior change: dispatched:true with a "dropped"
  // deliveryState underneath now KEEPS the row (enqueueDurableMessage already durably recorded it; it
  // redrives on the recipient's next resume) — RED on main, which would have undone it =====================
  {
    const db = makeDb("p1c.db", { role: "manager" });
    const endpoint = createWebhookEndpoint(db, {
      name: "Dropped-but-dispatched target", sourceType: "generic", secret: "p1c-secret", mode: "wake",
      targetSessionId: "edn-wake-sess", agentId: null,
    });
    const app = Fastify();
    registerWebhookIngress(app, {
      db, pty: {
        isAlive: () => true,
        // Pre-a21f5c9e code would call this, see deliveryState:"dropped", and undo. Post-a21f5c9e code
        // with enqueueDurableNudge wired never reaches this at all.
        enqueueStdin: () => ({ delivered: false, deliveryState: "dropped", reason: "session-dead" }),
      },
      sessions: {
        startNew: () => { throw new Error("should not be called (wake mode)"); },
        resume: () => { throw new Error("should not be called (already alive)"); },
        enqueueDurableNudge: (id, role, text, taskId, opts) => {
          // enqueueDurableMessage ran and durably recorded a session_message_queued event even though the
          // underlying enqueueStdin reported "dropped" — see sessions/service.ts's `if (!r.delivered)`.
          opts.onOutcome({ dispatched: true, result: { delivered: false, deliveryState: "dropped", reason: "session-dead", msgId: "m-p1c" } });
        },
      },
    });
    await app.ready();
    const { payload, headers } = signGeneric("p1c-secret", '{"i":1}', "p1c-delivery-1");
    const r = await app.inject({ method: "POST", url: `/hooks/${endpoint.path}`, payload, headers });
    check("(P1c) wake delivery -> 200", r.statusCode === 200);
    await settle();
    check("(P1c) dispatched:true (even with a 'dropped' deliveryState) -> dedupe row KEPT (durably recorded, redrives on resume)",
      db.hasWebhookDelivery(endpoint.id, "generic:p1c-delivery-1") === true);
    await app.close();
    db.close();
  }

  // ===================== PART 1 (d) — REGRESSION GUARD, a21f5c9e Round 2 (item 4): the raw
  // pty.enqueueStdin fallback was DELETED — a bare sessions stub with NO enqueueDurableNudge now fails the
  // fire loudly (the dedupe row is undone, same as any other fire failure), never silently falls back to
  // a production-unreachable path =====================
  {
    const db = makeDb("p1d.db", { role: "manager" });
    const endpoint = createWebhookEndpoint(db, {
      name: "No-fallback target", sourceType: "generic", secret: "p1d-secret", mode: "wake",
      targetSessionId: "edn-wake-sess", agentId: null,
    });
    const app = Fastify();
    const originalError = console.error;
    const errorLines = [];
    console.error = (...args) => { errorLines.push(args.join(" ")); };
    try {
      registerWebhookIngress(app, {
        db, pty: { isAlive: () => true },
        sessions: { startNew: () => { throw new Error("should not be called"); }, resume: () => { throw new Error("should not be called"); } }, // NO enqueueDurableNudge
      });
      await app.ready();
      const { payload, headers } = signGeneric("p1d-secret", '{"i":1}', "p1d-delivery-1");
      const r = await app.inject({ method: "POST", url: `/hooks/${endpoint.path}`, payload, headers });
      check("(P1d) wake delivery -> 200 (ACK sent before the fire)", r.statusCode === 200);
      await settle();
      check("(P1d) no enqueueDurableNudge dep -> the fire fails loudly (logged), never a silent fallback", errorLines.some((l) => l.includes("fire failed")));
      check("(P1d) ...and the dedupe row was undone (a missing dependency is NOT a silent success)",
        db.hasWebhookDelivery(endpoint.id, "generic:p1d-delivery-1") === false);
    } finally {
      console.error = originalError;
      await app.close();
      db.close();
    }
  }

  // ===================== PART 2 — undo-replay amplification is bounded by REPLAY_COOLDOWN_MS: a target
  // whose fire fails EVERY time, replayed rapidly, fires at most ONCE per cooldown window instead of once
  // per replay — RED on main, which would fire on every single replay =====================
  {
    const db = makeDb("p2.db");
    const endpoint = createWebhookEndpoint(db, {
      name: "Always-broken target", sourceType: "generic", secret: "p2-secret", mode: "spawn",
      targetSessionId: null, agentId: "edn-agent",
    });
    const spawnCalls = [];
    let nowMs = 1_700_000_000_000; // arbitrary fixed instant; advanced manually below
    const app = Fastify();
    registerWebhookIngress(app, {
      db,
      pty: { isAlive: () => false, enqueueStdin: () => ({ delivered: true, deliveryState: "handed-off" }) },
      sessions: {
        startNew: (agentId, opts) => { spawnCalls.push({ agentId, opts }); throw new Error("simulated: target always broken"); },
        resume: () => ({}),
      },
      now: () => nowMs,
      replayCooldownMs: 1000, // short, deterministic window for the test
    });
    await app.ready();
    const url = `/hooks/${endpoint.path}`;
    const { payload, headers } = signGeneric("p2-secret", '{"i":1}', "p2-delivery-1", nowMs);

    // Three rapid replays at the SAME instant (well within the 1000ms cooldown).
    const r1 = await app.inject({ method: "POST", url, payload, headers });
    await settle();
    check("(P2) replay 1 -> 200, fire attempted (fails) -> undone -> row absent", r1.statusCode === 200 && spawnCalls.length === 1 && db.hasWebhookDelivery(endpoint.id, "generic:p2-delivery-1") === false);

    // Even though replay 1's fire failed and its dedupe row was ALREADY undone (so the dedupe check alone
    // would let a fresh attempt through), the REPLAY-COOLDOWN gate blocks every further replay at the SAME
    // instant BEFORE a dedupe row is even recorded — "at most one fire ATTEMPT per window" is enforced by
    // elapsed time since the LAST attempt, independent of whether that attempt succeeded, failed, or was
    // undone.
    // @decision a21f5c9e — Round 2 lead ruling: a cooldown-blocked replay is 429 + Retry-After +
    // {replayCooldown:true}, NEVER 200 {duplicate:true} (that would be false every time it fires — only a
    // failed-and-undone delivery ever reaches this gate).
    const r2 = await app.inject({ method: "POST", url, payload, headers });
    await settle();
    check("(P2) replay 2 (same instant) -> blocked by the cooldown BEFORE any new fire attempt (bounded!)",
      r2.statusCode === 429 && JSON.parse(r2.payload).replayCooldown === true && spawnCalls.length === 1);
    check("(P2) ...never flagged 'duplicate' (that would be false — only a failed-and-undone delivery reaches this gate)",
      JSON.parse(r2.payload).duplicate === undefined);
    check("(P2) ...carries a Retry-After header naming the remaining cooldown in whole seconds",
      Number(r2.headers["retry-after"]) >= 1 && Number(r2.headers["retry-after"]) <= 1);
    check("(P2) ...and no dedupe row was recorded for the blocked replay (a later genuine redelivery still gets a chance)",
      db.hasWebhookDelivery(endpoint.id, "generic:p2-delivery-1") === false);

    const r3 = await app.inject({ method: "POST", url, payload, headers });
    await settle();
    check("(P2) replay 3 (same instant) -> still blocked (not a one-shot gate)", r3.statusCode === 429 && JSON.parse(r3.payload).replayCooldown === true && spawnCalls.length === 1);

    // Advance past the cooldown window: a further replay gets a fresh attempt again — the gate never gets
    // permanently stuck either way.
    nowMs += 1001;
    const r4 = await app.inject({ method: "POST", url, payload, headers });
    await settle();
    check("(P2) replay 4 (AFTER the cooldown elapses) -> a fresh attempt (not stuck forever)", r4.statusCode === 200 && spawnCalls.length === 2);
    check("(P2) ...fails -> undone again -> row absent (a real fix + redelivery would still succeed)", db.hasWebhookDelivery(endpoint.id, "generic:p2-delivery-1") === false);

    check("(P2) exported REPLAY_COOLDOWN_MS default is 60s", REPLAY_COOLDOWN_MS === 60_000);
    await app.close();
    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — webhook wake mode converges onto SessionService.enqueueDurableNudge (card a21f5c9e): the dropped/deliveryState signal is re-derived via enqueueDurableNudge's new onOutcome callback (dispatched:false undoes the dedupe row; dispatched:true keeps it, even for an underlying 'dropped' deliveryState, since enqueueDurableMessage already durably recorded it), a bare test stub with no enqueueDurableNudge now fails the fire loudly instead of silently falling back to the deleted raw-pty.enqueueStdin path, a target whose fire fails every time is bounded by REPLAY_COOLDOWN_MS to at most one fire attempt per (endpoint, deliveryId) per window instead of refiring on every single replay, and a cooldown-blocked replay is 429 + Retry-After + {replayCooldown:true}, never a misleading 200 {duplicate:true}."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
