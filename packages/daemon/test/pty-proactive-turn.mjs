// Loom Companion — proactive event-line producer (daemon half of card beb61d23) — exercised through the
// REAL turn-formation path (pty/host.ts), NOT the getter in isolation: PtyHost.getActiveTurnIsProactive
// must return true for a turn a caller (a heartbeat/reminder/attention-push watcher) tagged `proactive`,
// false for an ordinary owner-inbound/system turn, persist like getActiveTurnOrigin's route (NOT cleared at
// Stop, simply overwritten by the next submit()), and survive a rate-limit park+resume replay.
//
// Mirrors pty-owner-attestation.mjs's harness exactly: the REAL PtyHost state machine + a FAKE pty
// (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-proactive-turn.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-proactive-turn-${Date.now()}-${process.pid}`);
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

const IN_APP = { channel: "in-app", chatId: "cockpit" };
const stop = (sid) => host.deliverHook(sid, { hook_event_name: "Stop" });

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

const SIDS = [];

try {
  // ===== 1. A heartbeat-tagged submit (proactive:true, mirrors heartbeat.ts's real call shape) attests true =====
  {
    const sid = newSession("A"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:heartbeat] proactive check-in", "system", undefined, IN_APP, "agent", undefined, undefined, true);
    check("1: getActiveTurnIsProactive returns true for a heartbeat-tagged turn", host.getActiveTurnIsProactive(sid) === true);
    check("1: getActiveTurnOrigin still resolves the route (sibling primitive, unaffected)", JSON.stringify(host.getActiveTurnOrigin(sid)) === JSON.stringify(IN_APP));
  }

  // ===== 2. An ordinary owner-inbound turn (route+ownerText, no proactive arg) attests false =====
  {
    const sid = newSession("B"); SIDS.push(sid);
    const ownerBody = "please approve the deploy";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody);
    check("2: an owner-authored turn (proactive omitted) attests false", host.getActiveTurnIsProactive(sid) === false);
    check("2: its owner text still attests (sibling primitive, unaffected)", host.getActiveTurnOwnerText(sid) === ownerBody);
  }

  // ===== 3. A plain system inject (no route, no proactive) also attests false =====
  {
    const sid = newSession("C"); SIDS.push(sid);
    host.enqueueStdin(sid, "a plain nudge");
    check("3: a plain system inject attests false", host.getActiveTurnIsProactive(sid) === false);
  }

  // ===== 4. Persists past Stop (like the route), unlike ownerText — simply overwritten by the next submit =====
  {
    const sid = newSession("D"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:reminder]:r1 daily check-in", "system", undefined, IN_APP, "agent", undefined, undefined, true);
    check("4: attested true while the turn is in flight", host.getActiveTurnIsProactive(sid) === true);
    stop(sid); // turn ends
    check("4: NOT cleared by Stop (unlike ownerText) — persists until the next submit() overwrites it", host.getActiveTurnIsProactive(sid) === true);
    // A queued, NON-proactive message (no proactive arg) drains as turn 2 on the next Stop-driven idle-submit.
    host.enqueueStdin(sid, "an ordinary follow-up", "system", undefined, undefined, "agent");
    check("4: a later ordinary turn overwrites it back to false — never inherits turn 1's proactive tag", host.getActiveTurnIsProactive(sid) === false);
  }

  // ===== 5. QUEUED (busy-at-enqueue) proactive turn still attests true once it drains =====
  {
    const sid = newSession("E"); SIDS.push(sid);
    host.enqueueStdin(sid, "PRIMER"); // turn in flight, busy
    await sleep(150);
    host.enqueueStdin(sid, "[loom:alert] merge rejected — w:abcd1234", "system", undefined, IN_APP, "agent", undefined, undefined, true); // HELD (busy)
    check("5: held while busy — no proactive attestation yet (still the PRIMER turn)", host.getActiveTurnIsProactive(sid) === false);
    stop(sid); // PRIMER ends → drains the queued alert message as its own turn
    check("5: attested true once the queued proactive message actually drains as its own turn", host.getActiveTurnIsProactive(sid) === true);
  }

  // ===== 6. Rate-limit park + resume replays the proactive tag (lastPromptProactive) =====
  {
    const sid = newSession("F"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:heartbeat] proactive check-in", "system", undefined, IN_APP, "agent", undefined, undefined, true);
    check("6: attested true before the park", host.getActiveTurnIsProactive(sid) === true);
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // PARK
    // Unlike ownerText (explicitly cleared at turn end), proactive PERSISTS through the park too — it mirrors
    // the route's semantics, not the owner-text one.
    check("6: still true while parked (mirrors the route, not ownerText)", host.getActiveTurnIsProactive(sid) === true);
    const resumed = host.resumeAfterRateLimit(sid);
    check("6: resume succeeded", resumed === true);
    check("6: the replayed turn re-attests proactive:true", host.getActiveTurnIsProactive(sid) === true);
  }

  await sleep(200); // let async paste-ends/Enters flush before teardown
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getActiveTurnIsProactive returns true for a caller-tagged heartbeat/reminder/attention-push turn, false for an ordinary owner/system turn, persists across Stop (unlike ownerText), and survives a rate-limit park+resume replay."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
