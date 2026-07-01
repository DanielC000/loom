// Deterministic ROUTE-KEYED coalescing test for PtyHost (Loom Companion multi-channel reply routing).
//
// The reply for a companion turn must be pinned to the EXACT originating (channel, chatId) OF THAT TURN, so
// an interleaved cross-route inbound can never redirect an in-flight turn's reply (cross-delivery leak). The
// mechanism (pty/host.ts): a per-turn `route` threaded through enqueueStdin → the in-flight `activeTurnRoute`
// (read by getActiveTurnOrigin when chat_reply fires), and drainPending coalescing ONLY the leading run of
// pending messages that share the SAME route key — so every turn has EXACTLY ONE originating route.
//
// Pins, against the REAL PtyHost state machine + a FAKE pty (createPty seam — NO real claude/daemon/network):
//   A. cross-route queued messages do NOT coalesce — [inapp-A, tg-B, inapp-C] drains as THREE turns, each a
//      single route (getActiveTurnOrigin follows each), order preserved;
//   B. same-route queued messages DO coalesce into ONE turn (one submit), carrying that route;
//   C. NO-route messages (the manager→worker / non-companion path) ALL coalesce into ONE turn — BYTE-IDENTICAL
//      to before this change (the load-bearing worker-path invariant), with a null active route;
//   D. INTERLEAVE / NO-SWAP: a cross-route inbound QUEUED while a turn is in flight does NOT change the
//      in-flight turn's origin — it only takes effect when it later drains as its own turn;
//   E. rate-limit PARK replays the killed turn WITH its original route (lastPromptRoute survives the park).
//
// Sibling to pty-coalesce-drain.mjs (the no-route coalesce this specializes) and pty-rate-limit-park-drain.mjs.
// RUN (no daemon needed): node test/pty-route-coalesce.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmpHome = path.join(os.tmpdir(), `loom-route-coalesce-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = { pid: 4242, write: (d) => { writes.push(d); }, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const PASTE_START = "\x1b[200~";
const IN_APP = { channel: "in-app", chatId: "cockpit" };
const TG = { channel: "telegram", chatId: "tg-1" };

// Spawn a fresh session on its own fake pty + mark it ready (SessionStart, startupModeCycles:0 ⇒ sync ready).
function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  const fake = fakes[fakes.length - 1];
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return { sid, fake };
}
const pasteCount = (fake) => fake.writes.join("").split(PASTE_START).length - 1;
const stop = (sid) => host.deliverHook(sid, { hook_event_name: "Stop" });

try {
  // ===== A. Cross-route queued messages do NOT coalesce — three routes → three single-route turns =====
  {
    const { sid, fake } = newSession("A");
    host.enqueueStdin(sid, "PRIMER"); // a turn in flight, so the next enqueues are HELD
    await sleep(150);
    host.enqueueStdin(sid, "A-inapp", "system", undefined, IN_APP);
    host.enqueueStdin(sid, "B-tg", "system", undefined, TG);
    host.enqueueStdin(sid, "C-inapp", "system", undefined, IN_APP);
    check("A: three cross-route messages queued behind busy", eq(host.getPending(sid), ["A-inapp", "B-tg", "C-inapp"]));

    let p = pasteCount(fake);
    stop(sid); // PRIMER ends → drain the LEADING same-route run only ([A-inapp]; B-tg breaks it)
    check("A: only the leading in-app message drained (B-tg breaks the run)", eq(host.getPending(sid), ["B-tg", "C-inapp"]));
    check("A: exactly ONE submit for that run", pasteCount(fake) - p === 1);
    check("A: the in-flight turn's origin is the in-app route", eq(host.getActiveTurnOrigin(sid), IN_APP));

    p = pasteCount(fake);
    stop(sid); // drain [B-tg]
    check("A: next run is the telegram message alone", eq(host.getPending(sid), ["C-inapp"]) && pasteCount(fake) - p === 1);
    check("A: the in-flight turn's origin FLIPPED to the telegram route", eq(host.getActiveTurnOrigin(sid), TG));

    p = pasteCount(fake);
    stop(sid); // drain [C-inapp]
    check("A: last run drained, queue empty", host.getPending(sid).length === 0 && pasteCount(fake) - p === 1);
    check("A: origin back to in-app for the final turn", eq(host.getActiveTurnOrigin(sid), IN_APP));
  }

  // ===== B. Same-route queued messages DO coalesce into ONE turn carrying that route =====
  {
    const { sid, fake } = newSession("B");
    host.enqueueStdin(sid, "PRIMER");
    await sleep(150);
    host.enqueueStdin(sid, "one", "system", undefined, IN_APP);
    host.enqueueStdin(sid, "two", "system", undefined, IN_APP);
    const p = pasteCount(fake);
    stop(sid);
    check("B: BOTH same-route messages drained in ONE turn (queue empty)", host.getPending(sid).length === 0);
    check("B: exactly ONE submit (coalesced, not two)", pasteCount(fake) - p === 1);
    check("B: the coalesced turn carries the shared in-app route", eq(host.getActiveTurnOrigin(sid), IN_APP));
    const turn = fake.writes.join("");
    check("B: both bodies present, FIFO order kept", turn.indexOf("one") >= 0 && turn.indexOf("one") < turn.indexOf("two"));
  }

  // ===== C. NO-route messages ALL coalesce into ONE turn — BYTE-IDENTICAL worker path, null active route =====
  {
    const { sid, fake } = newSession("C");
    host.enqueueStdin(sid, "PRIMER");
    await sleep(150);
    host.enqueueStdin(sid, "[loom:from-manager]\nONE", "system"); // no route (5th arg omitted)
    host.enqueueStdin(sid, "[loom:from-manager]\nTWO", "system");
    host.enqueueStdin(sid, "[loom:from-manager]\nTHREE", "system");
    const p = pasteCount(fake);
    stop(sid);
    check("C: ALL three no-route messages coalesce in ONE turn (queue empty) — worker path unchanged", host.getPending(sid).length === 0);
    check("C: exactly ONE submit (all-together, byte-identical to the old splice-all)", pasteCount(fake) - p === 1);
    check("C: a no-route turn has NO active origin (null)", host.getActiveTurnOrigin(sid) === null);
    const turn = fake.writes.join("");
    check("C: FIFO order preserved across the three", turn.indexOf("ONE") < turn.indexOf("TWO") && turn.indexOf("TWO") < turn.indexOf("THREE"));
  }

  // ===== D. INTERLEAVE / NO-SWAP: a queued cross-route inbound can't redirect the in-flight turn's reply =====
  {
    const { sid } = newSession("D");
    host.enqueueStdin(sid, "turn-from-inapp", "system", undefined, IN_APP); // idle → submitted immediately
    check("D: the in-flight turn's origin is in-app (the message that started it)", eq(host.getActiveTurnOrigin(sid), IN_APP));
    host.enqueueStdin(sid, "later-from-telegram", "system", undefined, TG); // arrives WHILE busy → queued
    check("D: a telegram inbound arriving mid-turn is QUEUED, not submitted", eq(host.getPending(sid), ["later-from-telegram"]));
    check("D: NO-SWAP — the in-flight (in-app) turn's origin is UNCHANGED by the queued telegram inbound", eq(host.getActiveTurnOrigin(sid), IN_APP));
    stop(sid); // in-app turn ends → the telegram message becomes its OWN turn
    check("D: only now does the origin become telegram (its own turn)", eq(host.getActiveTurnOrigin(sid), TG) && host.getPending(sid).length === 0);
  }

  // ===== E. rate-limit PARK replays the killed turn WITH its original route =====
  {
    const { sid } = newSession("E");
    host.enqueueStdin(sid, "turn-from-telegram", "system", undefined, TG); // idle → submitted, active route TG
    check("E: origin is the telegram route before the park", eq(host.getActiveTurnOrigin(sid), TG));
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // PARK (busy falls, not drained)
    const ok = host.resumeAfterRateLimit(sid); // replays lastPrompt WITH lastPromptRoute
    check("E: resume succeeded", ok === true);
    check("E: the replayed turn kept its telegram route (route survived the park)", eq(host.getActiveTurnOrigin(sid), TG));
  }

  await sleep(200); // let async paste-ends/Enters flush before teardown
} finally {
  for (const sid of ["sess-A", "sess-B", "sess-C", "sess-D", "sess-E"]) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — drainPending coalesces ONLY same-route runs (cross-route ⇒ distinct single-route turns), no-route messages still all-coalesce byte-identically (worker path), a queued cross-route inbound never redirects the in-flight turn's reply (no-swap), and a rate-limit park replays the killed turn with its original route."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
