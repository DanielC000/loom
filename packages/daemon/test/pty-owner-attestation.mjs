// Companion injection-guard Primitive A (Companion Capability & Permission-Lever Framework §3, card
// 8e511951) — exercised through the REAL turn-formation path (pty/host.ts), NOT the getter in isolation:
// PtyHost.getActiveTurnOwnerText must return the LITERAL authenticated owner inbound bytes that formed the
// CURRENT turn, stay null for a turn that wasn't owner-authored (a proactive/heartbeat/reminder/system
// inject), and be CLEARED at turn end — unlike getActiveTurnOrigin's route, which simply persists until the
// next submit() overwrites it (see the Live.activeTurnOwnerText doc in pty/host.ts for why).
//
// Mirrors pty-route-coalesce.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty seam) —
// NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-owner-attestation.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-owner-attest-${Date.now()}-${process.pid}`);
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
  // ===== 1. An owner-authored inbound turn attests its LITERAL bytes =====
  {
    const sid = newSession("A"); SIDS.push(sid);
    // This is the companion inbound path's shape (chat-gateway.ts: submitTurn(sessionId, body, route, body))
    // — enqueueStdin's trailing ownerText arg carries the SAME literal text as the turn itself.
    const ownerBody = "please approve the deploy — ship it";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody);
    check("1: getActiveTurnOwnerText returns the LITERAL owner bytes for an owner-authored turn", host.getActiveTurnOwnerText(sid) === ownerBody);
    check("1: getActiveTurnOrigin still resolves the route (sibling primitive, unaffected)", JSON.stringify(host.getActiveTurnOrigin(sid)) === JSON.stringify(IN_APP));
  }

  // ===== 2. A proactive/heartbeat/system turn (no ownerText) attests NULL =====
  {
    const sid = newSession("B"); SIDS.push(sid);
    // Mirrors companion/heartbeat.ts's real call shape: a route IS passed (for reply delivery) but NO
    // ownerText — this is Loom's own proactive nudge, not the owner's words.
    host.enqueueStdin(sid, "[loom:heartbeat] proactive check-in", "system", undefined, IN_APP, "agent");
    check("2: a route-bearing but NON-owner-authored turn still attests NULL", host.getActiveTurnOwnerText(sid) === null);
    check("2: its origin route DOES resolve (route != ownerText — they're independent)", JSON.stringify(host.getActiveTurnOrigin(sid)) === JSON.stringify(IN_APP));
  }

  // ===== 3. Cleared at turn end — unlike the route, it does NOT survive past its own turn =====
  {
    const sid = newSession("C"); SIDS.push(sid);
    const ownerBody = "confirm the release";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody);
    check("3: attested while the turn is in flight", host.getActiveTurnOwnerText(sid) === ownerBody);
    stop(sid); // turn ends
    check("3: CLEARED once the turn ends (Stop hook)", host.getActiveTurnOwnerText(sid) === null);
    check("3: getActiveTurnOrigin (route), by contrast, is NOT cleared by the same Stop — it persists until overwritten", JSON.stringify(host.getActiveTurnOrigin(sid)) === JSON.stringify(IN_APP));
  }

  // ===== 4. A NEXT, non-owner turn never inherits a stale prior owner attestation =====
  {
    const sid = newSession("D"); SIDS.push(sid);
    const ownerBody = "delete the staging branch";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody);
    check("4: first (owner) turn attests", host.getActiveTurnOwnerText(sid) === ownerBody);
    stop(sid); // ends turn 1
    // A queued, NON-owner-authored message (no ownerText) drains as turn 2 on the NEXT Stop-driven idle-submit.
    host.enqueueStdin(sid, "[loom:reminder] proactive follow-up", "system", undefined, undefined, "agent");
    check("4: a later system/reminder turn attests NULL — it never inherits turn 1's owner text", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 5. QUEUED (busy-at-enqueue) owner turn still attests once it drains =====
  {
    const sid = newSession("E"); SIDS.push(sid);
    host.enqueueStdin(sid, "PRIMER"); // turn in flight, busy
    await sleep(150);
    const ownerBody = "yes, merge it";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody); // HELD (busy)
    check("5: held while busy — no attestation yet (still the PRIMER turn)", host.getActiveTurnOwnerText(sid) === null);
    stop(sid); // PRIMER ends → drains the queued owner message as its own turn
    check("5: attested once the queued owner message actually drains as its own turn", host.getActiveTurnOwnerText(sid) === ownerBody);
  }

  // ===== 6. Rate-limit park + resume replays the attestation (lastPromptOwnerText) =====
  {
    const sid = newSession("F"); SIDS.push(sid);
    const ownerBody = "approve budget increase";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody);
    check("6: attested before the park", host.getActiveTurnOwnerText(sid) === ownerBody);
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // PARK — clears active, keeps lastPrompt*
    check("6: cleared while parked (turn ended, even though it'll be replayed)", host.getActiveTurnOwnerText(sid) === null);
    const resumed = host.resumeAfterRateLimit(sid);
    check("6: resume succeeded", resumed === true);
    check("6: the replayed turn re-attests the SAME owner text", host.getActiveTurnOwnerText(sid) === ownerBody);
  }

  await sleep(200); // let async paste-ends/Enters flush before teardown
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getActiveTurnOwnerText attests the literal owner bytes of an owner-authored turn, stays null for a proactive/system turn, and is cleared at turn end (never inherited by a later turn)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
