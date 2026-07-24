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

  // ===== 7. Primitive A widening (card 2b26035c): getRecentOwnerTurns retains a bounded, most-recent-
  //          first window that SURVIVES Stop (unlike getActiveTurnOwnerText, which clears every turn) =====
  {
    const sid = newSession("G"); SIDS.push(sid);
    check("7: empty window before any owner turn", JSON.stringify(host.getRecentOwnerTurns(sid)) === "[]");
    const turn1 = "Creative projects for the new client";
    host.enqueueStdin(sid, turn1, "system", undefined, IN_APP, "agent", undefined, turn1);
    stop(sid);
    check("7: getActiveTurnOwnerText cleared after Stop (unchanged Primitive A behavior)", host.getActiveTurnOwnerText(sid) === null);
    check("7: getRecentOwnerTurns still has turn 1 AFTER Stop — it does not clear like the active field", JSON.stringify(host.getRecentOwnerTurns(sid)) === JSON.stringify([turn1]));
    const turn2 = "no, creating a new project structure";
    host.enqueueStdin(sid, turn2, "system", undefined, IN_APP, "agent", undefined, turn2);
    stop(sid);
    check("7: a SECOND owner turn is prepended (most-recent-first), turn 1 still present", JSON.stringify(host.getRecentOwnerTurns(sid)) === JSON.stringify([turn2, turn1]));
    // A non-owner (proactive) turn must NEVER be pushed into the window — only server-attested owner
    // bytes may ever satisfy Primitive A, even in its widened form.
    host.enqueueStdin(sid, "[loom:heartbeat] proactive check-in", "system", undefined, IN_APP, "agent");
    stop(sid);
    check("7: a proactive/non-owner turn does NOT get pushed into the recent-owner window", JSON.stringify(host.getRecentOwnerTurns(sid)) === JSON.stringify([turn2, turn1]));
  }

  // ===== 8. Bounded window — an old-enough turn falls out once it exceeds the retained window =====
  {
    const sid = newSession("H"); SIDS.push(sid);
    // Push more owner turns than the window retains, and confirm the OLDEST one is evicted while the
    // window stays bounded (never unboundedly growing across a long conversation).
    const turns = ["turn one", "turn two", "turn three", "turn four", "turn five", "turn six", "turn seven"];
    for (const t of turns) {
      host.enqueueStdin(sid, t, "system", undefined, IN_APP, "agent", undefined, t);
      stop(sid);
    }
    const window = host.getRecentOwnerTurns(sid);
    check("8: the recent-owner window is BOUNDED (does not grow past its configured size)", window.length > 0 && window.length < turns.length);
    check("8: the MOST RECENT turn is retained", window[0] === "turn seven");
    check("8: an OLD-ENOUGH turn (the very first one) has fallen out of the window", !window.includes("turn one"));
  }

  // ===== 9. RAW-TERMINAL capture (card b4b9b707): a genuine raw Enter-submit attests ownerText =====
  // /ws/term's stdin path (gateway/server.ts) calls PtyHost.writeStdin directly, bypassing submit() —
  // this is the exact bypass the card closes. writeStdin is exercised here the same way the real
  // websocket handler drives it.
  {
    const sid = newSession("I"); SIDS.push(sid);
    const line = "Go with B General";
    host.writeStdin(sid, `${line}\r`); // typed into the raw terminal, then Enter
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("9: a raw-terminal-typed line attests as ownerText for the turn it started", host.getActiveTurnOwnerText(sid) === line);
    check("9: it also lands in the recent-owner window — same server-attested tier as the composer", host.getRecentOwnerTurns(sid)[0] === line);
    stop(sid);
    check("9: cleared at Stop like any other owner attestation (unchanged Primitive A behavior)", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 10. NEGATIVE (security-critical): a Loom-originated turn, with NO raw-terminal activity, attests NULL =====
  {
    const sid = newSession("J"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:idle] you've been idle a while", "system", undefined, undefined, "warning");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("10: a Loom-originated (system/kickoff/nudge) turn never attests ownerText with no prior raw activity", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 11. NEGATIVE (security-critical): a raw draft is captured, but a Loom-originated submit() races in FIRST =====
  // This is the crux of the fabrication guard: submit() must invalidate the pending raw baseline BEFORE
  // the system turn's own UserPromptSubmit fires, so the system turn's hook never sees it.
  {
    const sid = newSession("K"); SIDS.push(sid);
    host.writeStdin(sid, "some human draft\r"); // frees the box, sets pendingRawOwnerSubmit — session still idle
    // A Loom-originated turn (worker-report-drain shape) submits before the engine's own hook fires.
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("11: a raced-in submit() invalidates the pending raw draft — the system turn attests NULL, never the human's draft", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 12. NEGATIVE (security-critical): consume-once — a LATER, unrelated turn never inherits an already-consumed raw attestation =====
  {
    const sid = newSession("L"); SIDS.push(sid);
    const line = "approved";
    host.writeStdin(sid, `${line}\r`);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // turn 1: consumes + attests
    check("12: turn 1 attests the raw line", host.getActiveTurnOwnerText(sid) === line);
    stop(sid); // turn 1 ends
    // Turn 2 is Loom-originated (no ownerText) — its own UserPromptSubmit must NOT see turn 1's raw
    // attestation, proving pendingRawOwnerSubmit was actually nulled at consumption, not left dangling.
    host.enqueueStdin(sid, "[loom:reminder] follow-up", "system", undefined, undefined, "agent");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("12: a LATER unrelated turn does NOT inherit the already-consumed raw attestation", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 13. TTL bound: a stale, never-consumed raw draft (e.g. a stray non-composer Enter) is discarded, =====
  // ===== not attributed to a later, unrelated turn — see RAW_OWNER_SUBMIT_TTL_MS's doc =====
  {
    const sid = newSession("M"); SIDS.push(sid);
    const line = "y"; // e.g. a bare permission-gate keystroke that never itself started a new top-level turn
    host.writeStdin(sid, `${line}\r`);
    // Simulate time passing well beyond the TTL with nothing consuming/overwriting it in between.
    host.live.get(sid).pendingRawOwnerSubmitAt = Date.now() - 999_999;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // an unrelated LATER real prompt starts
    check("13: a stale (TTL-expired) raw draft is discarded, never attributed to an unrelated later turn", host.getActiveTurnOwnerText(sid) === null);
  }

  await sleep(200); // let async paste-ends/Enters flush before teardown
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getActiveTurnOwnerText attests the literal owner bytes of an owner-authored turn, stays null for a proactive/system turn, and is cleared at turn end (never inherited by a later turn); getRecentOwnerTurns (card 2b26035c widening) retains a bounded, most-recent-first window of the SAME server-attested owner bytes that survives Stop, never admits a non-owner-authored turn, and evicts an old-enough entry once the window fills. Card b4b9b707: a raw-terminal (/ws/term) Enter-submit ALSO attests ownerText via the SAME writer, a Loom-originated submit() racing in before the correlating hook ALWAYS wins (never fabricates), a consumed attestation never leaks to a later turn, and a stale never-consumed draft is TTL-discarded rather than misattributed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
