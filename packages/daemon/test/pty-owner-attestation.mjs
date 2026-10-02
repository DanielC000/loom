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
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-owner-attest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 2521bf51: scenario 11 below needs the backstop expiry, shrunk so it doesn't burn real seconds.
const HUMAN_SUBMIT_HOLD_MS = 120;
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = String(HUMAN_SUBMIT_HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
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

  // ===== 11. NEGATIVE (security-critical): a raw draft is captured, but a Loom-originated submit() races in EVENTUALLY =====
  // UPDATED (card 2521bf51 code review Major 1): post-fix, a system-originated enqueueStdin call arriving
  // right after a human's Enter can no longer take the IMMEDIATE-submit path while the human's own submit
  // is awaiting engine confirmation — it correctly QUEUES instead (that hold is this card's whole point;
  // an instant race here is no longer reachable at all — see pty-human-submit-race.mjs for that mechanism
  // and its own repro). This scenario's REAL protected property is narrower and independent of that
  // timing: submit() ALWAYS clears pendingRawOwnerSubmit before writing its own text (host.ts, the
  // "SECURITY INVARIANT" comment right at the top of submit()), so a Loom-originated turn can never
  // inherit a human's raw draft NO MATTER WHEN it actually runs. Exercised here via the bounded backstop
  // expiry (no confirming hook ever arrives for the human's own turn) — the only way left for a
  // system-originated submit() to still genuinely run while pendingRawOwnerSubmit is still set.
  {
    const sid = newSession("K"); SIDS.push(sid);
    host.writeStdin(sid, "some human draft\r"); // frees the box, sets pendingRawOwnerSubmit — session still idle
    const r = host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    check("11: post-fix, the racing system turn is HELD, not submitted immediately (card 2521bf51)", r.delivered === false);
    // No confirming hook EVER arrives for the human's own turn — only the bounded backstop lets the held
    // system message actually drain and genuinely call submit().
    await sleep(HUMAN_SUBMIT_HOLD_MS + 100);
    host.reconcile(); // backstop expired — THIS is what actually calls submit() for the system message
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // the system turn's OWN confirming hook
    check("11: even once the racing submit() genuinely runs (post-backstop), it already cleared the pending raw draft — the system turn attests NULL, exclusively its own attribution", host.getActiveTurnOwnerText(sid) === null);
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

  // ===== 14. REVERSE-order race (card fca6af6d, follow-up to b4b9b707): a Loom submit() clears
  // pendingRawOwnerSubmit and goes outstanding FIRST; a raw-terminal Enter races in DURING the gap
  // before that submit's own UserPromptSubmit hook fires, re-populating the field with a genuine human
  // line. The hook that then fires is confirming the SUBMIT's Enter (enqueueStdin drained it
  // synchronously — enterConfirmed is false the instant writeStdin races in), not the human's raced-in
  // line — so it must NOT attribute that human text to this agent-originated turn. This is the mirror
  // image of test 11 (raw-then-submit, already correct): here the SUBMIT lands first, and a raw line
  // races in AFTER it but BEFORE its confirming hook.
  {
    const sid = newSession("N"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent"); // submit() outstanding — enterConfirmed now false
    host.writeStdin(sid, "raced human line\r"); // races in BEFORE the submit's own hook fires — sets pendingRawOwnerSubmit
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms the SUBMIT's Enter, not the raced raw line
    check("14: a raw line raced in behind an outstanding submit() is NOT attributed to that submit-originated turn", host.getActiveTurnOwnerText(sid) === null);
  }

  // ===== 15. Discriminator regression guard: a genuine raw-terminal Enter with NO submit() outstanding
  // still attests correctly (enterConfirmed was already true before the hook fires — the forward case
  // the fix must not break) =====
  {
    const sid = newSession("O"); SIDS.push(sid);
    const line = "confirmed via raw terminal";
    host.writeStdin(sid, `${line}\r`); // no submit() in flight — enterConfirmed is already true
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // this hook confirms the raw Enter's OWN turn
    check("15: a genuine raw-terminal Enter (no submit outstanding) still attests correctly", host.getActiveTurnOwnerText(sid) === line);
  }

  // ===== 16. Card d326c3c2: the SAME reverse-order race as test 14 also sets the race-discard marker
  // (timestamp/gen only) — this is the new signal question_resolve's fallback consults so it can refuse
  // instead of quoting a STALE, earlier owner turn as if it answered the raced-away one =====
  {
    const sid = newSession("P"); SIDS.push(sid);
    check("16: no marker before any race", host.hasRaceDiscardedOwnerSubmit(sid) === false);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent"); // submit() outstanding
    host.writeStdin(sid, "raced human line\r"); // races in before the submit's own confirming hook
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms the SUBMIT, discards the raced line
    check("16: getActiveTurnOwnerText is null (unchanged from test 14)", host.getActiveTurnOwnerText(sid) === null);
    check("16: the race-discard marker is now set", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 17. The marker CLEARS the instant a genuine owner turn is actually attributed — a later owner
  // reply (e.g. the SAME owner repeating themselves once nothing else is in flight) resolves normally,
  // never permanently wedging question_resolve's fallback for this session =====
  {
    const sid = newSession("Q"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    host.writeStdin(sid, "raced human line\r");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("17: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // ends the submit-originated turn the race landed on
    const repeated = "office@ works, switch it";
    host.writeStdin(sid, `${repeated}\r`); // the owner repeats themselves — no competing outstanding submit now
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("17: a genuine later owner turn attests normally", host.getActiveTurnOwnerText(sid) === repeated);
    check("17: attributing it CLEARED the race-discard marker", host.hasRaceDiscardedOwnerSubmit(sid) === false);
  }

  // ===== 18. Code Review correction (card d326c3c2): the marker must SURVIVE an unrelated submit() —
  // clearing it on bare generation-advance reopens the exact stale-quote bug this card fixes. Walk:
  // race at gen N -> turn N's Stop drains ANOTHER queued message as gen N+1 (a worker report, a
  // rate-limit replay, a kickoff guarantee — none of them are the owner) -> if the marker cleared here,
  // a LATER question_resolve would silently fall back to the stale PRIOR owner turn again. It must stay
  // set until a GENUINE owner turn is actually attributed, however many unrelated turns pass first. =====
  {
    const sid = newSession("R"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    host.writeStdin(sid, "raced human line\r");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("18: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // ends that turn
    host.enqueueStdin(sid, "[loom:reminder] unrelated follow-up #1", "system", undefined, undefined, "agent"); // a NEW, unrelated submit() — gen advances, no owner attribution
    check("18: an unrelated submit() does NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid);
    host.enqueueStdin(sid, "[loom:reminder] unrelated follow-up #2", "system", undefined, undefined, "agent"); // a SECOND unrelated submit() — still no owner attribution
    check("18: the marker SURVIVES multiple unrelated submits, not just one", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid);
    const repeated = "office@ works, switch it";
    host.writeStdin(sid, `${repeated}\r`); // the owner FINALLY repeats themselves
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("18: a genuine owner turn still attests correctly after surviving those unrelated submits", host.getActiveTurnOwnerText(sid) === repeated);
    check("18: ONLY that genuine attribution clears the marker", host.hasRaceDiscardedOwnerSubmit(sid) === false);
  }

  // ===== 19. Card 2400d0bc: a RATE-LIMIT REPLAY of the PRE-race owner turn must NOT clear the marker.
  // Walk (the exact path from the card): owner turn X submitted (Enter outstanding) -> a raw line R races
  // in and is discarded (marker set, AFTER X's own attribution already happened) -> X dies to a rate limit
  // and parks -> resumeAfterRateLimit replays X via lastPromptOwnerText. X's replay re-attributes the SAME
  // (older) owner text the marker already postdates — it must not look "newer" just because the replay
  // happens to run after the race. =====
  {
    const sid = newSession("S"); SIDS.push(sid);
    const ownerBody = "approve the deploy";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody); // X: owner turn, Enter outstanding
    check("19: X attests before the race", host.getActiveTurnOwnerText(sid) === ownerBody);
    host.writeStdin(sid, "raced human line\r"); // R races in before X's own confirming hook
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms X's Enter, discards R, sets the marker
    check("19: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    check("19: X's own attribution is untouched by the discard", host.getActiveTurnOwnerText(sid) === ownerBody);
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // X dies to a rate limit and parks
    check("19: parked — active cleared, marker survives", host.getActiveTurnOwnerText(sid) === null);
    check("19: marker still set while parked", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    const resumed = host.resumeAfterRateLimit(sid); // replays X
    check("19: resume succeeded", resumed === true);
    check("19: the replay re-attests X", host.getActiveTurnOwnerText(sid) === ownerBody);
    check("19: the replay of the PRE-race turn must NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // end the replayed turn
    check("19: after Stop, active clears again and the marker is STILL set — question_resolve's fallback must refuse, not quote X", host.getActiveTurnOwnerText(sid) === null && host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 20. Card 2400d0bc, the MILDER queued-composer variant: an owner composer entry Y enqueued
  // (held, because the session is busy) BEFORE R races in, but DRAINED (as its own turn) AFTER the race
  // sets the marker. Y predates the race just as much as X did in test 19 — draining it late must not
  // clear the marker either. =====
  {
    const sid = newSession("T"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent"); // X: non-owner turn, Enter outstanding (arms busy)
    const ownerBody = "ship it";
    const r1 = host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody); // Y: queued WHILE busy, captured BEFORE the race
    check("20: Y is held (queued) while X is outstanding", r1.delivered === false);
    check("20: no attestation yet — X hasn't ended, Y hasn't drained", host.getActiveTurnOwnerText(sid) === null);
    host.writeStdin(sid, "raced human line\r"); // R races in before X's own confirming hook — AFTER Y was already queued
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms X's Enter, discards R, sets the marker
    check("20: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // ends X's turn -> drains Y as its own turn
    check("20: Y drains and attests", host.getActiveTurnOwnerText(sid) === ownerBody);
    check("20: Y predates the race (queued before R arrived) — draining it late must NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 21. POSITIVE CONTROL for card 2400d0bc: a genuinely NEWER owner attribution, via the origin-array
  // path (not the raw-terminal default-seq path tests 17/18 already cover), still clears the marker — the
  // ordering check is not a blanket "never clear again" regression. =====
  {
    const sid = newSession("U"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    host.writeStdin(sid, "raced human line\r");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    check("21: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // ends that turn
    const fresh = "go ahead, ship it";
    host.enqueueStdin(sid, fresh, "system", undefined, IN_APP, "agent", undefined, fresh); // a genuinely NEW owner turn, submitted (not replayed) AFTER the race — immediate path, origin-array attribution
    check("21: the fresh owner turn attests", host.getActiveTurnOwnerText(sid) === fresh);
    check("21: a genuinely NEWER owner attribution (origin-array path) still clears the marker", host.hasRaceDiscardedOwnerSubmit(sid) === false);
  }

  // ===== 22. Card 270b963c (test gap, item 2): resumeAfterRateLimit's BLOCKED branch (stopping||
  // drainHeld -> enqueueStdin with { ownerTextSeq }, host.ts) must carry the PRE-race rank through a
  // HELD requeue too — test 19 only covers the direct submit() branch. Walk: owner turn X attested ->
  // race discards R (marker set, postdating X) -> X parks on a rate limit -> a companion-upgrade-style
  // holdDrain window opens WHILE parked -> resumeAfterRateLimit fires INTO that hold (the blocked
  // branch: enqueueStdin, never submit()) -> releaseDrain -> the held replay finally drains as its own
  // turn on the next Stop. RED if the tail's `ownerTextSeq` override is dropped there — enqueueStdin
  // would mint a FRESH rank (newer than the marker, since the mint happens after the race) that outranks
  // and wrongly clears the marker the instant the held replay actually drains. =====
  {
    const sid = newSession("V"); SIDS.push(sid);
    const ownerBody = "approve the deploy";
    host.enqueueStdin(sid, ownerBody, "system", undefined, IN_APP, "agent", undefined, ownerBody); // X: owner turn, Enter outstanding
    host.writeStdin(sid, "raced human line\r"); // R races in before X's own confirming hook
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms X's Enter, discards R, sets the marker
    check("22: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // X dies to a rate limit and parks
    check("22: parked — marker survives", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    host.holdDrain(sid); // companion-upgrade-style hold window opens WHILE parked (stopping stays false)
    const resumed = host.resumeAfterRateLimit(sid); // BLOCKED branch: drainHeld is set -> enqueueStdin, not a direct submit()
    check("22: resume still reports success while blocked", resumed === true);
    check("22: the replay did NOT submit directly — still held, not yet attested", host.getActiveTurnOwnerText(sid) === null);
    host.releaseDrain(sid); // lift the hold — does NOT itself trigger a drain
    check("22: still not attested right after releaseDrain (nothing auto-drains)", host.getActiveTurnOwnerText(sid) === null);
    stop(sid); // the held replay FINALLY drains as its own turn
    check("22: the held replay re-attests X once it drains", host.getActiveTurnOwnerText(sid) === ownerBody);
    check("22: the held replay of the PRE-race turn must NOT clear the marker (the blocked-branch tail carried ownerTextSeq)", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 23. Code Review correction (card 270b963c, manager review): an attribution with an UNKNOWN
  // rank (owner text present, but the entry being requeued carries NO recorded ownerTextSeq at all) must
  // NEVER clear the race-discard marker. requeueQueuedMessage must FAIL CLOSED — carry an explicit
  // "unknown" (null) sentinel rather than leaving the field undefined, because an `undefined` override
  // reads to enqueueStdin as "no override supplied — this is an ordinary fresh capture, mint a rank now",
  // which would mint a FRESH (and therefore outranking) seq for exactly the entry this whole mechanism
  // exists to protect. Simulates the shape a future/unaudited requeue caller could hand in: a
  // QueuedMessage-like object with `ownerText` set but no `ownerTextSeq` field at all. =====
  {
    const sid = newSession("X"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent");
    host.writeStdin(sid, "raced human line\r");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // sets the marker
    check("23: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // end that turn — session is now idle/ready, nothing queued
    const unknownRankMsg = { id: "fake-unknown-rank", text: "ship it", source: "system", kind: "agent", ownerText: "ship it", logicalId: "fake-unknown-rank" };
    check("23: the fixture genuinely has no recorded ownerTextSeq", unknownRankMsg.ownerTextSeq === undefined);
    host.requeueQueuedMessage(sid, unknownRankMsg); // idle+ready -> takes the IMMEDIATE path, attests synchronously
    check("23: the unknown-rank requeue still attests its own owner text", host.getActiveTurnOwnerText(sid) === "ship it");
    check("23: an attribution with an UNKNOWN rank must NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 24. Round 2 (card 270b963c, test gap item 2a): an UNKNOWN-rank entry that QUEUES on a BUSY
  // session (not the idle/immediate path test 23 exercises) and later drains through submit()'s own
  // origin-array attribution loop (card 438973ce) must also never clear the marker. Mirrors test 20's
  // "queued, drains late" shape, but with an unknown rank instead of a real one. =====
  {
    const sid = newSession("Y"); SIDS.push(sid);
    host.enqueueStdin(sid, "[loom:worker-report] done", "system", undefined, undefined, "agent"); // X: non-owner turn, arms busy
    const unknownRankMsg = { id: "fake-unknown-rank-queued", text: "approve it", source: "system", kind: "agent", ownerText: "approve it", logicalId: "fake-unknown-rank-queued" };
    check("24: the fixture genuinely has no recorded ownerTextSeq", unknownRankMsg.ownerTextSeq === undefined);
    const r = host.requeueQueuedMessage(sid, unknownRankMsg); // busy -> HELD branch, stores ownerTextSeq: null on the entry
    check("24: Y is held (queued) while X is outstanding", r.delivered === false);
    host.writeStdin(sid, "raced human line\r"); // R races in before X's own confirming hook — AFTER Y was already queued
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms X's Enter, discards R, sets the marker
    check("24: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    stop(sid); // ends X's turn -> drains Y as its own turn, via submit()'s origin-array attribution loop
    check("24: Y drains and attests despite its unknown rank", host.getActiveTurnOwnerText(sid) === "approve it");
    check("24: a QUEUED unknown-rank entry draining late must NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  // ===== 25. Round 2 (card 270b963c, test gap item 2b): a turn whose OWN attribution rank is UNKNOWN
  // (null) that then dies to a RATE LIMIT and is replayed via resumeAfterRateLimit must also never clear
  // the marker — mirrors test 19's shape (a real rank replayed) but with a null one, proving `null`
  // survives this SECOND hop (requeue -> rate-limit park -> replay), not just the first. =====
  {
    const sid = newSession("Z"); SIDS.push(sid);
    const unknownRankMsg = { id: "fake-unknown-rank-replay", text: "approve the deploy", source: "system", kind: "agent", ownerText: "approve the deploy", logicalId: "fake-unknown-rank-replay" };
    check("25: the fixture genuinely has no recorded ownerTextSeq", unknownRankMsg.ownerTextSeq === undefined);
    host.requeueQueuedMessage(sid, unknownRankMsg); // idle+ready -> IMMEDIATE path -> X attests with seq=null
    check("25: X attests with an unknown rank before the race", host.getActiveTurnOwnerText(sid) === "approve the deploy");
    host.writeStdin(sid, "raced human line\r"); // R races in before X's own confirming hook
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // confirms X's Enter, discards R, sets the marker
    check("25: marker set after the race", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    host.deliverHook(sid, { hook_event_name: "StopFailure", error: "rate_limit" }); // X dies to a rate limit and parks
    check("25: parked — marker survives", host.hasRaceDiscardedOwnerSubmit(sid) === true);
    const resumed = host.resumeAfterRateLimit(sid); // replays X — live.lastPromptOwnerTextSeq is null, must pass through verbatim
    check("25: resume succeeded", resumed === true);
    check("25: the replay re-attests X", host.getActiveTurnOwnerText(sid) === "approve the deploy");
    check("25: the null-rank replay of the PRE-race turn must NOT clear the marker", host.hasRaceDiscardedOwnerSubmit(sid) === true);
  }

  await sleep(200); // let async paste-ends/Enters flush before teardown
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getActiveTurnOwnerText attests the literal owner bytes of an owner-authored turn, stays null for a proactive/system turn, and is cleared at turn end (never inherited by a later turn); getRecentOwnerTurns (card 2b26035c widening) retains a bounded, most-recent-first window of the SAME server-attested owner bytes that survives Stop, never admits a non-owner-authored turn, and evicts an old-enough entry once the window fills. Card b4b9b707: a raw-terminal (/ws/term) Enter-submit ALSO attests ownerText via the SAME writer, a Loom-originated submit() racing in before the correlating hook ALWAYS wins (never fabricates), a consumed attestation never leaks to a later turn, and a stale never-consumed draft is TTL-discarded rather than misattributed. Card fca6af6d (the REVERSE-order race): a raw line that races in BEHIND an already-outstanding submit() — before that submit's own confirming hook fires — is likewise never attributed to the submit-originated turn, while a genuine raw-terminal Enter with no submit outstanding still attests correctly (the enterConfirmed-captured-before-hook discriminator). Card d326c3c2: that SAME race ALSO sets a timestamp/gen-only race-discard marker (hasRaceDiscardedOwnerSubmit) — the signal question_resolve's fallback needs to refuse instead of quoting a stale earlier owner turn — which SURVIVES any number of unrelated submit()s (Code Review correction: an earlier gen-advance clear reopened the exact bug this card fixes) and clears ONLY the instant a genuine owner turn is actually attributed. Card 2400d0bc: neither a rate-limit REPLAY of the pre-race owner turn nor a queued composer entry that was enqueued before the race but DRAINS after it may clear the marker either — both carry their true (older) rank via a monotonic per-session sequence, never wall-clock time, while a genuinely newer owner attribution (via the same origin-array path) still clears it correctly. Card 270b963c: the SAME rate-limit replay rank-carry also holds on resumeAfterRateLimit's BLOCKED (stopping/drainHeld) branch, which requeues via enqueueStdin rather than a direct submit() — a held replay that later drains must not clear the marker either; and separately, requeueQueuedMessage FAILS CLOSED on an UNKNOWN rank (a requeued entry with no recorded ownerTextSeq at all) by carrying an explicit null sentinel rather than letting enqueueStdin mint a fresh, outranking one — attributeOwnerText treats that null as never able to clear the marker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
