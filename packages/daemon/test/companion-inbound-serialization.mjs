import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — per-route inbound serialization (card 986bdddd). Fully hermetic: a FAKE ChannelAdapter +
// a FAKE CompanionTranscriber (with a MANUALLY-CONTROLLED deferred, never a real timer) drive the gateway;
// NO live network, NO real claude, NO daemon, NO python/venv, NO fixed waits. Proves:
//   1. SAME route, out-of-order completion (slow voice note vs fast text) → submitTurn still sees them in
//      ARRIVAL order, not completion order (the race this card fixes).
//   2. DIFFERENT routes are NEVER serialized against each other — a slow call on route A must not delay a
//      fast call on route B.
//   3. A GROUP chat's two different senders are also correctly ordered relative to each other (same route,
//      different senderId — no coalescing expected, but ordering must still hold).
//   4. The wait on a stuck predecessor is BOUNDED (test-overridden to a small value) — a successor on the
//      same route proceeds once the bound elapses, even though the predecessor never settles.
//   5. ERROR ISOLATION — a predecessor that THROWS (a rejecting auth check) never poisons the chain for the
//      next queued message on that route.
// Run: 1) build (turbo builds shared first), 2) node test/companion-inbound-serialization.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import {
  acquireSttSlot,
  releaseSttSlot,
  createFasterWhisperTranscriber,
  __setSttConcurrencyForTest,
  __resetSttConcurrencyGateForTest,
  __setSttPythonBinForTest,
  __setTranscribeRunnerForTest,
} from "../dist/companion/stt.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// 20 positional ctor args today (submitTurn, bindings, auth, pairing, originResolver, voicePrefs,
// transcribe, synthesize, historyReset, recorder, reinjectPersona, livePush, historyExport,
// proactiveResolver, closeTrustWindow, onReplyDelivered, flagNonPrivateBinding, reconcileBindingChange,
// onUnboundRouteRefused, inboundQueueMaxWaitMs) — a named-options wrapper keeps the test cases readable.
function makeGateway({ submit, bindings, auth, transcribe, inboundQueueMaxWaitMs } = {}) {
  return new ChatGateway(
    submit, bindings ?? [], auth, undefined, undefined, undefined, transcribe,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, inboundQueueMaxWaitMs,
  );
}

function makeAdapter() {
  const sent = [];
  return {
    sent,
    adapter: {
      name: "telegram",
      maxMessageLength: 4096,
      start() {},
      async stop() {},
      async send(chatId, text) { sent.push({ chatId, text }); },
      // Must be present (and succeed) for an audio inbound to ever reach transcribe() — chat-gateway.ts's
      // downloadAttachment() returns null (⇒ transcribe-unavailable, transcribe() never called) when the
      // adapter has no downloadAttachment at all.
      async downloadAttachment() { return { filePath: "/tmp/voice.ogg", cleanup: async () => {} }; },
    },
  };
}

/** A transcriber whose transcribe() never resolves on its own — the test resolves it explicitly, so the
 *  race is deterministic (no setTimeout-based flakiness). */
function makeHeldTranscriber() {
  let resolve;
  const held = new Promise((r) => { resolve = r; });
  return { transcriber: { isReady: () => true, transcribe: async () => held }, resolve: (text) => resolve(text) };
}

const audioMsg = (chatId, sender) => ({ channel: "telegram", chatId, body: "", sender, attachments: [{ type: "audio", fileId: "f1" }], chatIsDirect: true });
const textMsg = (chatId, body, sender) => ({ channel: "telegram", chatId, body, sender, chatIsDirect: true });

/** Flush pending microtasks so a fired-but-not-awaited handleInbound() call progresses as far as it can
 *  (through the download + up to the held transcribe promise) before the test fires the next message. */
async function flushMicrotasks(n = 5) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

try {
  // ============ 1 — SAME route: a slow voice note followed by a fast text still submits in ARRIVAL order ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push(text); return { delivered: true }; };
    const tg = makeAdapter();
    const tr = makeHeldTranscriber();
    const gw = makeGateway({ submit, bindings: [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], transcribe: tr.transcriber });
    gw.registerAdapter(tg.adapter);

    const p1 = gw.handleInbound(audioMsg("111", { id: "owner" })); // starts, parks on the held transcribe
    await flushMicrotasks();
    const p2 = gw.handleInbound(textMsg("111", "later text", { id: "owner" })); // SAME route, fired second
    // p2 is QUEUED behind p1 on this route — it cannot even START processing until p1 settles (the whole
    // point of a serial queue, not just a submit-order fixup), so it must NOT be awaited directly here (on
    // unpatched/un-serialized code it would resolve immediately; on the fix it would hang until p1 settles).
    await flushMicrotasks();
    check("1: text has NOT submitted yet — it is queued behind the still-held voice note", submitted.length === 0);
    tr.resolve("voice transcript");
    const [r1, r2] = await Promise.all([p1, p2]);
    check("1: both accepted", r1.accepted === true && r2.accepted === true);
    check("1: submitted in ARRIVAL order, not completion order", submitted.length === 2 && submitted[0] === "voice transcript" && submitted[1] === "later text");
  }

  // ============ 2 — DIFFERENT routes are never serialized against each other ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const tg = makeAdapter();
    const trA = makeHeldTranscriber();
    const gw = makeGateway({
      submit,
      bindings: [
        { sessionId: "sess-A", channel: "telegram", chatId: "AAA", scope: "dm" },
        { sessionId: "sess-B", channel: "telegram", chatId: "BBB", scope: "dm" },
      ],
      transcribe: trA.transcriber,
    });
    gw.registerAdapter(tg.adapter);

    const pA = gw.handleInbound(audioMsg("AAA", { id: "owner" })); // route A: held indefinitely
    await flushMicrotasks();
    const pB = gw.handleInbound(textMsg("BBB", "hello from B", { id: "owner" })); // DIFFERENT route
    const rB = await pB; // must resolve WITHOUT waiting on route A's held call
    check("2: a different route's fast message is NOT blocked by route A's slow one", rB.accepted === true);
    check("2: route B's turn already submitted while route A is still held", submitted.length === 1 && submitted[0].sid === "sess-B");
    trA.resolve("voice transcript A");
    const rA = await pA;
    check("2: route A eventually completes too", rA.accepted === true);
    check("2: final submit order — B then A (B never waited)", submitted.length === 2 && submitted[0].sid === "sess-B" && submitted[1].sid === "sess-A");
  }

  // ============ 3 — GROUP chat, two different senders, ordering still holds (no coalescing expected) ============
  {
    const submitted = [];
    const submit = (sid, text, route, ownerText, senderId) => { submitted.push({ text, senderId }); return { delivered: true }; };
    const tg = makeAdapter();
    const tr = makeHeldTranscriber();
    const auth = { isSenderAuthorized: () => true }; // any sender id authorized — isolates ordering from authz
    const gw = makeGateway({ submit, auth, bindings: [{ sessionId: "sess-A", channel: "telegram", chatId: "grp-1", scope: "group" }], transcribe: tr.transcriber });
    gw.registerAdapter(tg.adapter);

    const p1 = gw.handleInbound(audioMsg("grp-1", { id: "member-A" })); // slow voice note from member A
    await flushMicrotasks();
    const p2 = gw.handleInbound(textMsg("grp-1", "quick reply", { id: "member-B" })); // fast text from member B, same route
    // Same-route queueing applies regardless of sender — p2 cannot start until p1 settles.
    await flushMicrotasks();
    check("3: member B's text did not yet submit while member A's voice note is held", submitted.length === 0);
    tr.resolve("what member A said");
    await Promise.all([p1, p2]);
    check("3: group ordering preserved across different senders", submitted.length === 2 && submitted[0].text === "what member A said" && submitted[0].senderId === "member-A" && submitted[1].text === "quick reply" && submitted[1].senderId === "member-B");
  }

  // ============ 4 — bounded wait: a stuck predecessor can delay, never permanently wedge, the route ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push(text); return { delivered: true }; };
    const tg = makeAdapter();
    const tr = makeHeldTranscriber(); // deliberately NEVER resolved in this case
    const gw = makeGateway({ submit, bindings: [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }], transcribe: tr.transcriber, inboundQueueMaxWaitMs: 20 });
    gw.registerAdapter(tg.adapter);

    const p1 = gw.handleInbound(audioMsg("111", { id: "owner" })); // parks forever (never resolved)
    await flushMicrotasks();
    const p2 = gw.handleInbound(textMsg("111", "should not wait forever", { id: "owner" }));
    const r2 = await p2; // must resolve once the 20ms bound elapses, NOT hang on p1
    check("4: the successor proceeds once the bound elapses despite a never-settling predecessor", r2.accepted === true);
    check("4: the successor's text was submitted", submitted.includes("should not wait forever"));
    // p1 is still pending (by design — nothing cancels the stuck predecessor); avoid an unhandled-rejection
    // warning on process exit by giving it a harmless resolution now that the assertions are done.
    tr.resolve("late transcript, arrives after the bound already let the successor through");
    await p1;
  }

  // ============ 5 — error isolation: a throwing predecessor never poisons the chain ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push(text); return { delivered: true }; };
    const tg = makeAdapter();
    let callNum = 0;
    const auth = { isSenderAuthorized: () => { callNum++; if (callNum === 1) throw new Error("boom — simulated predecessor failure"); return true; } };
    const gw = makeGateway({ submit, auth, bindings: [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }] });
    gw.registerAdapter(tg.adapter);

    let p1Rejected = false;
    const p1 = gw.handleInbound(textMsg("111", "first — will throw", { id: "owner" })).catch(() => { p1Rejected = true; });
    await p1;
    check("5: the throwing predecessor's own call rejected (confirms the injected throw actually fired)", p1Rejected === true);
    const r2 = await gw.handleInbound(textMsg("111", "second — must still process normally", { id: "owner" }));
    check("5: the NEXT message on the same route still processes normally (chain not poisoned)", r2.accepted === true);
    check("5: the second message's turn was submitted", submitted.includes("second — must still process normally"));
  }

  // ============ 6 — DERIVED bound: STT contention delaying a voice note's ACQUIRE still keeps a later text
  //                  behind it (card 986bdddd round 2, Major). Round 1's flat bound only accounted for
  //                  download+transcribe and silently omitted the STT acquire wait — so a voice note merely
  //                  QUEUED behind another chat's in-flight decode (not stuck, just slow) could still lose
  //                  its place to a later text message. Uses the REAL global STT slot (acquireSttSlot/
  //                  releaseSttSlot) to simulate that contention, and small test-overridden constants that
  //                  preserve the SAME derivation relationship (download + acquire-wait + subprocess +
  //                  margin) the real INBOUND_QUEUE_MAX_WAIT_MS formula uses, just scaled down. ============
  {
    __resetSttConcurrencyGateForTest();
    const smallDownload = 50;
    const smallAcquireWait = 2_000;
    const smallSubprocess = 50;
    const margin = 100;
    const derivedQueueBound = smallDownload + smallAcquireWait + smallSubprocess + margin;
    __setSttConcurrencyForTest({ maxConcurrent: 1, acquireMaxWaitMs: smallAcquireWait });
    __setSttPythonBinForTest("fake-python-bin");
    __setTranscribeRunnerForTest(async () => "voice transcript");

    // Occupy the ONE global slot with an unrelated call, held LONGER than a real decode should take but
    // well SHORTER than smallAcquireWait — so the voice note's own acquire eventually SUCCEEDS (not a
    // timeout), just slowly, mirroring real cross-chat STT contention rather than a stuck call.
    const busyHoldMs = 150;
    const held = await acquireSttSlot();
    check("6 setup: the busy global STT slot is actually held", held === true);
    setTimeout(() => releaseSttSlot(), busyHoldMs);

    const submitted = [];
    const submit = (sid, text) => { submitted.push(text); return { delivered: true }; };
    const tg = makeAdapter();
    const transcriber = createFasterWhisperTranscriber();
    const gw = makeGateway({
      submit,
      bindings: [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }],
      transcribe: transcriber,
      inboundQueueMaxWaitMs: derivedQueueBound,
    });
    gw.registerAdapter(tg.adapter);

    const p1 = gw.handleInbound(audioMsg("111", { id: "owner" }));
    await flushMicrotasks();
    const p2 = gw.handleInbound(textMsg("111", "later text", { id: "owner" }));
    const [r1, r2] = await Promise.all([p1, p2]);
    check("6: both accepted", r1.accepted === true && r2.accepted === true);
    check(
      "6: a slow-but-legitimate STT acquire (busy global slot) still keeps the text BEHIND the voice note",
      submitted.length === 2 && submitted[0] === "voice transcript" && submitted[1] === "later text",
    );

    __setTranscribeRunnerForTest();
    __setSttPythonBinForTest(undefined);
    __resetSttConcurrencyGateForTest();
    __setSttConcurrencyForTest();
  }

  // ============ 7 — a SYNCHRONOUS throw inside handleInbound's own body rejects, never throws synchronously
  //                  (card 986bdddd round 2, Nitpick 4 — handleInbound is not `async`, so an unguarded
  //                  synchronous throw would otherwise propagate straight to the caller instead of
  //                  rejecting the returned promise) ============
  {
    const gw = makeGateway({ submit: () => ({ delivered: true }) });
    gw.registerAdapter(makeAdapter().adapter);
    let threwSynchronously = false;
    let rejected = false;
    try {
      // `null` makes the method's own `msg.channel` access throw a TypeError synchronously, before any
      // promise is ever created.
      const p = gw.handleInbound(null);
      await p.catch(() => { rejected = true; });
    } catch {
      threwSynchronously = true;
    }
    check(
      "7: a synchronous throw inside handleInbound rejects the returned promise rather than throwing",
      threwSynchronously === false && rejected === true,
    );
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("UNCAUGHT:", err);
  process.exit(1);
}
