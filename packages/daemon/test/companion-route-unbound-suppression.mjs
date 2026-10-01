import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — OUTBOUND REFUSAL when a route has NO LIVE BINDING (card d3f9b4d2, DoD-2): the chat-
// gateway chokepoint (sendVia, via ChatGateway.mayDeliverTo/deliveryBlockReason) now refuses a destination
// with no live binding — never bound, or revoked since the turn carrying that route was formed. This is
// the exact bug: unbind (gateway/server.ts) didn't clear the proactive home / a reminder's own pinned
// route, and this chokepoint had no check of its own either, so a revoked or lost chat kept receiving
// heartbeat/reminder/alert content (project names, decision titles) regardless.
//
// Fully hermetic: pure in-memory ChatGateway construction with fake channel adapters — NO db, NO network,
// NO real claude, NO daemon. (The REST-level "unbind clears the home / reroutes a reminder" half of the
// DoD is covered separately in companion-unbind-reconcile.mjs.)
//
// Covers the DoD:
//   1. A route with NO live binding refuses delivery — deliverReply (1), deliverMedia + sendToChannel (6),
//      and sendVia's own per-chunk MID-FLIGHT recheck (5) — every real outbound producer this chokepoint
//      gates, reason "route-unbound" (never conflated with the pre-existing "route-flagged-non-private").
//   2. POSITIVE CONTROL: a route backed by a real live binding still delivers normally (2) — the check
//      targets absence of a binding, not the channel generally.
//   3. THE EXACT BUG, reproduced directly: a binding that EXISTED (so delivery worked), then got revoked
//      (unbind), now refuses on the SAME route (3) — proving the fix closes the reported gap, not just a
//      synthetic never-bound case.
//   4. EXEMPTION: the in-app channel is ALWAYS considered live (it has no "unbound" state to fall into,
//      per in-app.ts's own doc) — deliverReply to an in-app route succeeds even with ZERO bindings
//      registered (4).
//   5. The zero-reply detector's onReplyDelivered still fires on a route-unbound refusal — it is a genuine
//      attempt, not agent silence, mirroring the existing route-flagged-non-private hardening (card
//      7578dea2) so the SAME cause can never trip both alarms.
// Run: 1) build (turbo builds shared first), 2) node test/companion-route-unbound-suppression.mjs

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

// A conformant fake ChannelAdapter recording sends (no network).
function fakeAdapter(name) {
  const sent = [];
  return {
    name, maxMessageLength: name === "telegram" ? 4096 : undefined,
    start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); },
    async sendMedia(chatId, filePath) { sent.push({ chatId, filePath }); },
    sent,
  };
}

try {
  // ============ 1 — deliverReply refuses a route with NO live binding, reason "route-unbound" ==========
  {
    const sess = "sess-never-bound";
    const delivered = [];
    const gw = new ChatGateway(
      () => ({ delivered: true }), [], undefined, undefined,
      (sid) => (sid === sess ? { channel: "telegram", chatId: "100100100" } : null), // originResolver
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (sid) => delivered.push(sid), // onReplyDelivered
    );
    const tg = fakeAdapter("telegram");
    gw.registerAdapter(tg);
    const r = await gw.deliverReply(sess, "should never land, the chat was never (or no longer) bound");
    check("1: deliverReply refuses with route-unbound", r.delivered === false && r.reason === "route-unbound");
    check("1: nothing actually reached the transport", tg.sent.length === 0);
    check("1: onReplyDelivered STILL fires (a genuine attempt, not agent silence — mirrors card 7578dea2)", delivered.length === 1 && delivered[0] === sess);
  }

  // ============ 2 — POSITIVE CONTROL: the SAME shape of route, backed by a real binding, delivers =========
  {
    const sess = "sess-really-bound";
    const binding = { sessionId: sess, channel: "telegram", chatId: "200200200", scope: "dm" };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [binding], undefined, undefined,
      (sid) => (sid === sess ? { channel: "telegram", chatId: "200200200" } : null),
    );
    const tg = fakeAdapter("telegram");
    gw.registerAdapter(tg);
    const r = await gw.deliverReply(sess, "this one has a real binding");
    check("2 (control): a live-bound route delivers normally", r.delivered === true && tg.sent.length === 1 && tg.sent[0].text === "this one has a real binding");
  }

  // ============ 3 — THE EXACT BUG: a binding that EXISTED, then got revoked, now refuses ================
  {
    const sess = "sess-revoked";
    const binding = { sessionId: sess, channel: "telegram", chatId: "300300300", scope: "dm" };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [binding], undefined, undefined,
      (sid) => (sid === sess ? { channel: "telegram", chatId: "300300300" } : null),
    );
    const tg = fakeAdapter("telegram");
    gw.registerAdapter(tg);

    const before = await gw.deliverReply(sess, "while still bound");
    check("3 setup: delivered while the binding is live", before.delivered === true && tg.sent.length === 1);

    gw.unbind(sess, "telegram"); // mirrors the REST unbind route's live-sync poke (gateway/server.ts)
    const after = await gw.deliverReply(sess, "a revoked or lost chat must NOT keep receiving this");
    check("3: the SAME route refuses once its binding is revoked (the exact card d3f9b4d2 bug)", after.delivered === false && after.reason === "route-unbound" && tg.sent.length === 1);
  }

  // ============ 4 — EXEMPTION: in-app is ALWAYS live, even with ZERO bindings registered ================
  {
    const sess = "sess-in-app-only";
    const gw = new ChatGateway(
      () => ({ delivered: true }), [], undefined, undefined,
      (sid) => (sid === sess ? { channel: IN_APP_CHANNEL, chatId: sess } : null),
    );
    const inApp = fakeAdapter(IN_APP_CHANNEL);
    gw.registerAdapter(inApp);
    const r = await gw.deliverReply(sess, "in-app has no unbound state to fall into");
    check("4 (exemption): in-app delivers with ZERO bindings registered", r.delivered === true && inApp.sent.length === 1);
  }

  // ============ 5 — sendVia's per-chunk MID-FLIGHT recheck catches an unbind BETWEEN chunks ==============
  {
    const sess = "sess-midflight-unbind";
    const binding = { sessionId: sess, channel: "telegram", chatId: "400400400", scope: "dm" };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [binding], undefined, undefined,
      (sid) => (sid === sess ? { channel: "telegram", chatId: "400400400" } : null),
    );
    const chunkSent = [];
    // maxMessageLength:10 forces a multi-chunk split; the SAME object reference `gw`'s routing map holds
    // is mutated by `unbind` right after the first chunk lands, so the NEXT per-chunk recheck sees it.
    const chunkyAdapter = {
      name: "telegram", maxMessageLength: 10, start() {}, async stop() {},
      async send(chatId, text) {
        chunkSent.push({ chatId, text });
        if (chunkSent.length === 1) gw.unbind(sess, "telegram"); // a concurrent unbind lands mid-stream
      },
    };
    gw.registerAdapter(chunkyAdapter);
    const r = await gw.deliverReply(sess, "one two three four five six");
    check("5: mid-flight unbind stops sendVia after the chunk already in flight", r.delivered === false && r.reason === "route-unbound");
    check("5: exactly ONE chunk reached the adapter — the rest were stopped by the per-chunk recheck", chunkSent.length === 1);
  }

  // ============ 6 — deliverMedia and sendToChannel ALSO refuse a route with no live binding =============
  {
    const sess = "sess-media-unbound";
    const gw = new ChatGateway(
      () => ({ delivered: true }), [], undefined, undefined,
      (sid) => (sid === sess ? { channel: "telegram", chatId: "500500500" } : null),
    );
    const tg = fakeAdapter("telegram");
    gw.registerAdapter(tg);

    const r = await gw.deliverMedia(sess, "/tmp/whatever.png");
    check("6a: deliverMedia refuses a route with no live binding", r.delivered === false && r.reason === "route-unbound" && tg.sent.length === 0);

    const r2 = await gw.sendToChannel("telegram", "600600600", "mirrored turn");
    check("6b: sendToChannel refuses a route with no live binding", r2.delivered === false && r2.reason === "route-unbound" && tg.sent.length === 0);
  }
} finally {
  // no db/tmp dir in this file — pure in-memory ChatGateway construction only.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sendVia's chokepoint refuses a destination with no live binding (deliverReply/deliverMedia/sendToChannel + the per-chunk mid-flight recheck), a route whose binding existed then got revoked stops receiving IMMEDIATELY, a genuinely live-bound route is unaffected, and the in-app channel (which has no 'unbound' state) is exempt."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
