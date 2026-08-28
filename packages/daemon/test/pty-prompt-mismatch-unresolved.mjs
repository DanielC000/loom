// Card f9b1ea00 — THE BOUNDED-WINDOW FOLLOW-UP for an unresolved `[loom:prompt-mismatch]` "recognized
// replay". HERMETIC — no daemon, no real claude. Mirrors pty-prompt-mismatch.mjs's own harness (the REAL
// PtyHost state machine + a FAKE pty via the createPty seam) and reuses that file's own scenario 7/7g
// recipes (a single-entry replay; a replay later recovered by a CONFIRMED composer-accumulation fusion).
//
// THE GAP: the `replayedEntry !== undefined` branch of the mismatch detector's own session-facing notice
// (pty/host.ts) tells its reader "wait one generation and re-check before treating this as a confirmed
// loss ... if that happens you will see a SEPARATE, later notice saying plainly that nothing was lost".
// Until this card, only the SUCCESS half of that promise had a mechanism behind it (a later CONFIRMED
// fusion's own notice) — the FAILURE half emitted nothing at all, ever, so "no second notice arrived" was
// structurally indistinguishable from "not yet, still waiting". This suite proves BOTH halves now hold:
// PART 1 is the RED-PROOF (a mismatch that never resolves now fails loud, where it used to emit nothing);
// PART 2 is the mandatory positive control in the OTHER direction (a mismatch that DOES resolve must stay
// silent — a check that fires on both is a false-alarm regression, the exact trap card 854d1632 v3 caught,
// named explicitly in this card's own DoD-3).
//
// PART 3 is a Code Review HIGH regression (confirmed on this card's own diff): a resume/recycle/restart
// that respawns the SAME sessionId while an earlier mismatch's follow-up timer is still pending must not
// let that stale timer survive into the new incarnation.
//
// PART 4 is the regression proof for a Code Review CRITICAL (confirmed): the follow-up used to arm on the
// BROADER `replayedEntry !== undefined` condition alone, which ALSO covers two benign shapes
// (`confirmedWrapperDeficit`/`confirmedAnsiStripDeficit`) whose own notice text says the OPPOSITE ("NOT A
// LOSS ... every byte did arrive") — and whose gens can NEVER be marked resolved (only a CONFIRMED fusion
// does that, and a fusion structurally requires `replayedEntry === undefined`). Left unfixed, 100% of that
// population would arm a timer that could never resolve, and fail loud 10 minutes after Loom said nothing
// was lost.
//
// PART 5 is the regression proof for the Code Review MAJOR (confirmed): a deliberate stop/crash (not a
// respawn) must ALSO clear pending follow-up timers — a claude session's own Live entry is never deleted
// on exit (only `alive:false`), so a stale timer would otherwise fire later against that dead-but-present
// entry and fail loud with a "please resend" nudge for a session that no longer exists.
//
// RUN (no daemon needed): node test/pty-prompt-mismatch-unresolved.mjs (build first: from packages/daemon
// `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-unresolved-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card f9b1ea00: shrink the resolve window so this suite runs in real milliseconds, not real minutes — the
// constant is read ONCE, at module load (`Number(process.env.LOOM_PROMPT_MISMATCH_RESOLVE_WINDOW_MS) ||
// default`), so this MUST be set before ../dist/pty/host.js is ever imported. Small enough that PART 1's
// own wait is fast, but well above the real wall-clock cost of a handful of sequential deliverHook calls
// (the pipeline this suite's own scenarios drive) — same sizing discipline as pty-giveup-hold-until-
// confirmed.mjs's own HOLD_MS.
const WINDOW_MS = 200;
process.env.LOOM_PROMPT_MISMATCH_RESOLVE_WINDOW_MS = String(WINDOW_MS);

const { PtyHost, framePossibleDuplicate, PROMPT_MISMATCH_EXCERPT_MAX_LEN } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const waitUntil = async (predicate, timeoutMs = 3000, stepMs = 10) => {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-unresolved: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};

const fakesById = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakesById.set(opts.sessionId, fake);
    return fake;
  }
}

// The event under test — PtyHostEvents.onPromptMismatchUnresolved. Collected with the originating
// sessionId so each scenario below can filter to its own session without interference from siblings.
const unresolvedEvents = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onPromptMismatchUnresolved(sessionId, info) { unresolvedEvents.push({ sessionId, info }); },
};
const host = new TestPtyHost(events);

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Mirrors pty-prompt-mismatch.mjs's own BRACKET_PASTE_END_MARKER wait — the hedge notice this suite drains
// in PART 2 is written in paced chunks (writeChunked, host.ts); wait for the closing bracketed-paste escape
// to actually land before trusting the joined text is complete.
const BRACKET_PASTE_END_MARKER = "\x1b[201~";
const waitForChunkedWriteDone = (writesArr, fromIndex) => waitUntil(() => writesArr.slice(fromIndex).join("").includes(BRACKET_PASTE_END_MARKER));

const SIDS = [];

try {
  // ===== PART 1 — RED-PROOF / POSITIVE: a recognized-replay mismatch that NEVER resolves (no later
  // generation's own submission ever fuses it back in) fires onPromptMismatchUnresolved exactly once, once
  // the (shrunk) window elapses, naming the ORIGINAL detection's own facts. Reproduces
  // pty-prompt-mismatch.mjs's own scenario 7 setup (a byte-for-byte replay of the immediately preceding
  // generation), then simply lets it sit unresolved instead of ever advancing the session again. =====
  {
    const sid = newSession("Unresolved"); SIDS.push(sid);
    const gen1Text = "[loom:worker-report] worker AAAA — generation 1's own real report";
    const gen2Text = "[loom:worker-report] worker BBBB — generation 2's own real report, never actually delivered";

    // Generation 1: ordinary, cleanly-confirmed — establishes the entry generation 2's replay will match.
    host.enqueueStdin(sid, gen1Text);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: Loom writes gen2Text, but the engine reports back gen1Text verbatim — the recognized-
    // replay shape whose own notice promises a follow-up either way.
    host.enqueueStdin(sid, gen2Text); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // byteIdentical=false, pure replay of gen=1
    check("1: sanity — this is the recognized-replay shape (getLastMismatchReplay fires for gen=2)",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1);
    // Code Review MINOR (confirmed): this check is NOT independently RED-provable — it passes identically
    // on code with no follow-up mechanism at all, since nothing can fire synchronously in the same tick as
    // its own scheduling regardless of whether the mechanism exists or is even correctly gated. Check 3
    // below (which actually WAITS for the event) is the real RED-proof for "the follow-up used to never
    // exist at all" — this is only a same-tick sanity check that detection alone doesn't ALSO synchronously
    // fire the notification.
    check("2: sanity (not independently RED-provable — see the comment above) — nothing has fired synchronously, in the same tick as detection",
      unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);

    // Never resolve gen=2 — no later fusion, no further activity on this session at all. Poll for the REAL
    // positive event (the scheduled follow-up actually firing), rather than guessing a duration.
    const fired = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid));
    check("3: onPromptMismatchUnresolved fires once the window elapses with nothing to resolve it", fired);
    const evs = unresolvedEvents.filter((e) => e.sessionId === sid);
    check("4: fires EXACTLY once (one detection -> one scheduled check -> one event, no duplicate firing)", evs.length === 1);
    check("5: names the ORIGINAL gen (2) — not whatever generation happens to be current by the time the timer actually fires",
      evs[0]?.info.gen === 2);
    check("6: carries the original detection's own written/reported hashes and intended length",
      typeof evs[0]?.info.writtenHash === "string" && evs[0].info.writtenHash.length > 0
      && typeof evs[0]?.info.reportedHash === "string" && evs[0].info.reportedHash.length > 0
      && evs[0]?.info.intendedLen === gen2Text.length);
    // Card c23e2869 DoD-2 (non-content half): the durable event also carries WHICH earlier generation
    // this mismatch replayed (`recognizedGen`) and how much of it matched (`matchedLen`) — data already
    // computed at detection time (`replayedEntry`) but, until now, never threaded past the console log.
    // `replayedEntry` is a WHOLE-string match by construction (`reported === entry.text` exactly — see its
    // own `.findLast` definition), so there is never anything left unaccounted for on this branch: both
    // remainder lengths are always 0 here.
    check("6b: carries WHICH earlier generation this mismatch replayed (recognizedGen=1) and how much of it matched (matchedLen=gen1Text.length)",
      evs[0]?.info.recognizedGen === 1 && evs[0]?.info.matchedLen === gen1Text.length);
    check("6c: a whole-string replay leaves no remainder — both lengths are 0",
      evs[0]?.info.leadingRemainderLen === 0 && evs[0]?.info.trailingRemainderLen === 0);
    // Card a419a7e6: PtyHost always passes messageExcerpt RAW/unconditionally through this event (the
    // LOOM_LOG_MESSAGE_CONTENT gate lives downstream, in SessionService — see that method's own doc) —
    // a bounded HEAD slice of THIS generation's own intended text (gen2Text), never the replayed gen1Text.
    check("6d: carries a bounded head-slice of the ORIGINAL intended text (gen2Text), not the replayed gen1Text",
      evs[0]?.info.messageExcerpt === gen2Text.slice(0, PROMPT_MISMATCH_EXCERPT_MAX_LEN));
  }

  // ===== PART 2 — THE MANDATORY OTHER DIRECTION (DoD-3): a recognized-replay mismatch that DOES resolve —
  // a LATER generation's own submission fuses its content back in whole, CONFIRMED — must produce NO
  // follow-up signal at all. A check that fires on BOTH directions is a false-alarm regression (the exact
  // trap card 854d1632 v3 caught, named explicitly in this card's own DoD-3). Reproduces
  // pty-prompt-mismatch.mjs's own scenario 7g sequence in full (replay -> hedge notice drained as its own
  // turn -> a final generation whose reported text is the full 4-generation concatenation). =====
  {
    const sid = newSession("ResolvedViaFusion"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const gen1Text = "[loom:worker-report] worker JJJJ — generation 1's own real report";
    const gen2Text = "[loom:worker-report] worker KKKK — generation 2's own real report, the one that goes missing";
    const finalText = "[loom:merge-done] worker LLLL merged — the final generation's own short content";

    host.enqueueStdin(sid, gen1Text);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // gen=1, clean
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, gen2Text); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // replay — schedules the follow-up check for gen=2
    check("7: sanity — the recognized-replay shape fired for gen=2", host.getLastMismatchReplay(sid)?.gen === 2);

    // Drain gen=2's own hedge notice as its own new turn (mirrors scenario 7g).
    const writesBeforeNotice = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitForChunkedWriteDone(fake.writes, writesBeforeNotice);
    const gen2NoticeJoined = fake.writes.slice(writesBeforeNotice).join("");
    const gen2NoticeEndIdx = gen2NoticeJoined.indexOf(BRACKET_PASTE_END_MARKER);
    const gen2NoticeText = gen2NoticeJoined.slice(6, gen2NoticeEndIdx);
    check("8: setup — the hedge notice text was actually recovered whole", gen2NoticeEndIdx > 6 && gen2NoticeText.length > 0);

    // Confirm the notice's own turn (gen=3) cleanly, so the final generation below is genuinely fresh.
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen2NoticeText }); // gen=3, byteIdentical=true
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Final generation (gen=4): the engine reports the FULL concatenation of every generation written so
    // far — the composer never actually cleared, so gen=2's own content is recovered whole. This is where
    // resolution actually happens, SYNCHRONOUSLY inside this one deliverHook call.
    host.enqueueStdin(sid, finalText); // gen=4
    const fusedReported = gen1Text + gen2Text + gen2NoticeText + finalText;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: fusedReported }); // CONFIRMED fusion, resolves gen=2
    const fusion = host.getLastMismatchFusion(sid);
    check("9: sanity — the fusion CONFIRMS and names gen=2 among its recovered generations (spanGens includes 2)",
      fusion !== null && fusion.spanGens.includes(2));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // TIMING-GUARD-SAFE: fully-awaited-completion — the precondition this check rests on (gen=2 is marked
    // resolved) was already OBSERVED, synchronously, by check 9 immediately above: `confirmedFusion`'s own
    // spanGens loop (host.ts) adds every span member to `live.mismatchResolvedGens` in the SAME synchronous
    // block that sets `lastMismatchFusion` — there is no async gap between "fusion.spanGens includes 2" and
    // "live.mismatchResolvedGens.has(2) is true". Whenever gen=2's scheduled `checkPromptMismatchUnresolved`
    // timer actually fires — already past, or still pending — it reads that already-true membership and
    // returns silently by construction; nothing about the outcome depends on how long this sleep runs. This
    // is margin on an already-settled state, not a race against a still-undetermined event.
    await new Promise((r) => setTimeout(r, WINDOW_MS + 300));
    check("10: POSITIVE CONTROL, the other direction (DoD-3) — a mismatch that DID resolve produces NO follow-up signal at all (no false-alarm regression)",
      unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
  }

  // ===== PART 3 — Code Review regression (HIGH, confirmed on this card's own diff): a resume/recycle/
  // `daemon_restart` that respawns the SAME sessionId while an earlier mismatch's follow-up timer is still
  // pending must not let that STALE timer survive into the new incarnation. `checkPromptMismatchUnresolved`
  // re-looks-up its Live by sessionId at fire time — mirrors `readyFallbackTimer`'s own established fix
  // (card c469d54e, `spawn()`'s own "Clear it before the overwrite" comment) for the IDENTICAL race class.
  // Without the fix: a later, unrelated generation on the NEW incarnation could legitimately reach the SAME
  // gen NUMBER (a fresh session's own counter restarts at 0) and get marked resolved for its OWN reasons —
  // and the stale timer, firing later and re-fetching the NEW Live, would read THAT unrelated resolution
  // and silently swallow the alert for the OLD, genuinely-still-lost mismatch. PROVEN WHITE-BOX (via the
  // exposed `live` map), not only by absence-of-event: the observable symptom of BOTH the bug (coincidental
  // false satisfaction) and the fix (clean cancellation) is "no event fires for the old mismatch" — for
  // different internal reasons that only inspecting the stale timer handle's own survival can tell apart. =====
  {
    const sid = newSession("StaleAcrossRespawn"); SIDS.push(sid);
    const gen1Text = "[loom:worker-report] worker MMMM — the pre-respawn generation 1's own real report";
    const gen2Text = "[loom:worker-report] worker NNNN — the pre-respawn generation 2's own real report, never actually delivered";

    host.enqueueStdin(sid, gen1Text);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // gen=1, clean
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, gen2Text); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // replay -> schedules a follow-up timer for gen=2
    check("11: sanity — the pre-respawn replay fired and scheduled a follow-up", host.getLastMismatchReplay(sid)?.gen === 2);

    const oldLive = host.live.get(sid);
    check("12: sanity — the scheduled timer's handle is recorded on the (soon-to-be-outgoing) Live object",
      oldLive.pendingMismatchUnresolvedTimers.size === 1);

    // Simulate a resume/recycle/daemon_restart: spawn() again for the SAME sessionId, well within the
    // (shrunk) resolve window — the exact map-entry overwrite this card's own fix (mirroring c469d54e)
    // guards against.
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
    host.deliverHook(sid, { hook_event_name: "SessionStart" });

    check("13: RED-PROOF — the OUTGOING Live's own pending-timer set is cleared by the overwrite (mirrors readyFallbackTimer's own established clear-before-overwrite fix, card c469d54e)",
      oldLive.pendingMismatchUnresolvedTimers.size === 0);
    const newLive = host.live.get(sid);
    check("14: sanity — the map now holds a genuinely DIFFERENT Live instance for the same sessionId", newLive !== oldLive);

    // Reproduce the reviewer's exact false-satisfaction shape: the NEW epoch reaches gen=2 again (its own
    // counter restarted at 0) and that gen gets marked resolved via a legitimate, INDEPENDENT fusion —
    // exactly the coincidence that would have silently swallowed the OLD, still-genuinely-unresolved
    // mismatch's alert had the stale timer survived to consult it.
    const newGen1 = "[loom:idle] post-respawn generation 1 — an entirely unrelated, ordinary turn";
    const newGen2 = "[loom:idle] post-respawn generation 2 — also unrelated, whose own composer never cleared";
    host.enqueueStdin(sid, newGen1);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: newGen1 }); // gen=1 (new epoch), clean
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, newGen2); // gen=2 (new epoch) — coincidentally the SAME gen number as the old mismatch
    const fusedReported = newGen1 + newGen2;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: fusedReported }); // CONFIRMED fusion — legitimately marks the NEW epoch's own gen=2 resolved
    check("15: sanity — the NEW epoch's own gen=2 is legitimately marked resolved, independent of the old mismatch",
      newLive.mismatchResolvedGens.has(2));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // TIMING-GUARD-SAFE: fully-awaited-completion — the precondition this check rests on (the stale timer
    // was already CLEARED) was already OBSERVED, synchronously, by check 13 above: `clearTimeout` on a
    // handle is a Node.js guarantee that callback can never fire afterward, no matter how long this sleep
    // runs — this is the outward confirmation of an outcome already settled, not a race against a still-
    // undetermined event.
    //
    // NAMED LIMIT (measured, not assumed): this check does NOT independently discriminate the bug from the
    // fix — verified empirically while building this file (temporarily disabling the clear-on-overwrite
    // fix here still left this check PASSING, because the new epoch's own gen=2 fusion above resolves in
    // well under a millisecond of real time, always beating even an UNCLEARED stale timer's own
    // (shrunk-for-this-suite) window to the same coincidental "resolved" answer check 15 already proves —
    // the exact ambiguity this scenario's own header comment names). Check 13 is the actual RED-PROOF; this
    // is only a downstream sanity confirmation that nothing else about the post-respawn sequence spuriously
    // emits for this sid.
    await new Promise((r) => setTimeout(r, WINDOW_MS + 300));
    check("16: sanity (not independently RED-provable — see the comment above) — no follow-up event arrives for this sid post-respawn",
      unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
  }

  // ===== PART 4a — Code Review CRITICAL regression (confirmed on this card's own diff): a WRAPPER-DEFICIT
  // mismatch (card 854d1632) must NEVER arm a follow-up timer. It IS, by construction, a `replayedEntry !==
  // undefined` case (see `detectPossibleDuplicateWrapperDeficit`'s own doc: "a benign wrapper deficit IS,
  // essentially by construction, a recognized replay") — so arming on `replayedEntry !== undefined` ALONE
  // (this card's own original cut) armed a timer for this shape too, even though its own notice text says
  // the OPPOSITE ("NOT A LOSS ... every byte did arrive"). And its gen can NEVER be marked resolved:
  // `Live.mismatchResolvedGens` is populated only by `confirmedFusion`, which REQUIRES `replayedEntry ===
  // undefined` — mutually exclusive with this shape. Reproduces the exact byte-pattern
  // `detectPossibleDuplicateWrapperDeficit` fires on: an earlier generation's own BARE write, then a LATER
  // generation whose own `intended` text is that SAME content wrapped in a `[loom:possible-duplicate
  // root:…]` tag, with the engine's report matching the earlier BARE write byte-for-byte (both the
  // wrapper-deficit AND the replayedEntry match, simultaneously, by construction — see the detector's own
  // doc for why). =====
  {
    const sid = newSession("WrapperDeficitNeverArms"); SIDS.push(sid);
    const bareText = "[loom:worker-report] worker PPPP — the earlier BARE write this stale confirmation will match";

    // Generation 1: the earlier BARE write, cleanly confirmed — this is what the wrapped generation's own
    // stale confirmation will match against.
    host.enqueueStdin(sid, bareText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: bareText }); // gen=1
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: Loom writes a WRAPPED re-mint of the SAME content (a real possible-duplicate frame,
    // built with the actual production helper — not a hand-rolled lookalike string), but the engine reports
    // back the earlier BARE write verbatim — the exact wrapper-deficit shape.
    const wrappedText = framePossibleDuplicate(bareText, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    host.enqueueStdin(sid, wrappedText); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: bareText }); // byteIdentical=false
    // Code Review (second pass): reworded to name only the half this assertion actually proves — the
    // replay half (getLastMismatchReplay). The wrapper-deficit half is what check 18 below demonstrates
    // (a timer that WOULD have armed on the replay condition alone stays unarmed).
    check("17: sanity — the recognized-replay shape fired (gen=1's own bare write matched)",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1);
    // Card d0952a73 DoD-4, positive polarity: this specimen is BOTH a recognized replay AND a confirmed
    // wrapper-deficit (by construction — see this scenario's own header comment) — `lastMismatchReplay`
    // must now carry `explainedBenign:"wrapper-deficit"`, threading the SAME classification the
    // session-facing notice below already gets right, instead of discarding it as before this card.
    check("17b: card d0952a73 — a confirmed wrapper-deficit replay reports explainedBenign:\"wrapper-deficit\"",
      host.getLastMismatchReplay(sid)?.explainedBenign === "wrapper-deficit");

    // RED-PROOF: no timer was armed for this mismatch at all — checked SYNCHRONOUSLY, immediately, no wait
    // needed (this is what actually distinguishes the pre-fix vs post-fix code: pre-fix this set would hold
    // exactly 1 handle here, since arming happened unconditionally on `replayedEntry !== undefined`).
    const live17 = host.live.get(sid);
    check("18: RED-PROOF — a wrapper-deficit mismatch arms NO follow-up timer at all (its own notice says NOT A LOSS, and its gen can never resolve)",
      live17.pendingMismatchUnresolvedTimers.size === 0);

    // TIMING-GUARD-SAFE: fully-awaited-completion — check 18 above already, synchronously, proves ZERO
    // timers exist for this session; there is nothing pending that could fire later no matter how long this
    // sleep runs. Outward confirmation only, not an independent race.
    await new Promise((r) => setTimeout(r, WINDOW_MS + 300));
    check("19: outward confirmation — no follow-up event ever arrives for this sid", unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
  }

  // ===== PART 4b — same Code Review CRITICAL, the ANSI-STRIP-DEFICIT sibling shape (card a640c110): the
  // engine's own echo strips ANSI/CSI escape sequences out of an otherwise-correct submission. Same
  // construction as 4a — an earlier BARE write, then a later generation whose `intended` is that SAME
  // content with ANSI/CSI codes inserted, reported back with those codes stripped (byte-for-byte matching
  // both the earlier bare write AND `detectAnsiEscapeStripDeficit`'s own exact-strip condition). =====
  {
    const sid = newSession("AnsiStripDeficitNeverArms"); SIDS.push(sid);
    const bareText = "[loom:worker-report] worker OOOO — the earlier BARE write this ANSI-stripped echo will match";

    host.enqueueStdin(sid, bareText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: bareText }); // gen=1
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: Loom's own intended text carries real ANSI/CSI styling around a slice of the SAME
    // content; the engine reports it back with the styling stripped — exactly the earlier bare write.
    const ansiWrapped = `${bareText.slice(0, 20)}\x1b[31m${bareText.slice(20, 40)}\x1b[0m${bareText.slice(40)}`;
    host.enqueueStdin(sid, ansiWrapped); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: bareText }); // byteIdentical=false
    // Code Review (second pass): reworded to name only the half this assertion actually proves — the
    // replay half. The ANSI-strip-deficit half is what check 21 below demonstrates.
    check("20: sanity — the recognized-replay shape fired (gen=1's own bare write matched)",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1);

    const live20 = host.live.get(sid);
    check("21: RED-PROOF — an ANSI-strip-deficit mismatch arms NO follow-up timer at all (its own notice says NOT A LOSS, and its gen can never resolve)",
      live20.pendingMismatchUnresolvedTimers.size === 0);

    // TIMING-GUARD-SAFE: fully-awaited-completion — same reasoning as check 19: check 21 above already,
    // synchronously, proves ZERO timers exist for this session.
    await new Promise((r) => setTimeout(r, WINDOW_MS + 300));
    check("22: outward confirmation — no follow-up event ever arrives for this sid", unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
  }

  // ===== PART 5 — regression proof for the Code Review MAJOR (confirmed): a deliberate stop/crash — not a
  // respawn — must ALSO clear pending follow-up timers, mirroring readyFallbackTimer's own belt-and-
  // suspenders `onExit` clear (card c469d54e). A claude session's own Live entry is NEVER deleted from
  // `this.live` on exit (`this.live.delete()` has only two call sites in host.ts, `spawnShell`'s own
  // `onExit` and `dropCanned`, neither reachable for `kind:"claude"`) — it survives with `alive:false`
  // instead. Without this clear, a still-pending timer would fire later against that SAME dead-but-present
  // Live, find its gen never resolved (nothing can resolve it post-exit — no more turns will ever run), and
  // fail loud with a "please resend" nudge for a session that no longer exists to be nudged. =====
  {
    const sid = newSession("ClearedOnExit"); SIDS.push(sid);
    const gen1Text = "[loom:worker-report] worker SSSS — the pre-exit generation 1's own real report";
    const gen2Text = "[loom:worker-report] worker TTTT — the pre-exit generation 2's own real report, never actually delivered";

    host.enqueueStdin(sid, gen1Text);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // gen=1, clean
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, gen2Text); // gen=2
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // replay -> arms a follow-up timer for gen=2
    // Code Review (second pass): reworded to name only the half this assertion actually proves — that the
    // replay fired. Check 24 below is what proves it was actually ARMED (the timer handle exists).
    check("23: sanity — the pre-exit replay fired", host.getLastMismatchReplay(sid)?.gen === 2);
    const live23 = host.live.get(sid);
    check("24: sanity — the timer's handle is recorded before exit", live23.pendingMismatchUnresolvedTimers.size === 1);

    // A deliberate stop (mirrors a real Ctrl-C / crash / worker_stop): the fake pty's kill() synchronously
    // invokes its tracked onExit callback (see _seam-host-fixture.mjs's own doc) — the SAME callback
    // host.ts's real spawn() registers.
    host.stop(sid, "hard");
    const liveAfterExit = host.live.get(sid);
    check("25: sanity — the session is dead but its OWN Live entry PERSISTS in the map (never deleted for kind:\"claude\")",
      liveAfterExit !== undefined && liveAfterExit.alive === false);
    check("26: RED-PROOF — onExit clears the pending-timer set even though the Live entry itself survives",
      live23.pendingMismatchUnresolvedTimers.size === 0);

    // TIMING-GUARD-SAFE: fully-awaited-completion — check 26 above already, synchronously, proves ZERO
    // timers exist for this session; nothing pending could fire later no matter how long this sleep runs.
    await new Promise((r) => setTimeout(r, WINDOW_MS + 300));
    check("27: outward confirmation — no follow-up event (a 'please resend' nudge to a session that no longer exists) ever arrives",
      unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
  }
  // ===== PART 6 — card 340b9dbe: a detector RE-ENTRY for the SAME (gen, writtenHash, reportedHash) must
  // produce AT MOST ONE `onPromptMismatchUnresolved` event, even if it manages to arm a SECOND follow-up
  // timer for that gen (`checkPromptMismatchUnresolved` had no per-gen fired-once dedup of its own — only
  // `mismatchResolvedGens`, which a re-entry's gen can never join unless a real fusion resolves it).
  //
  // ⚠️ DoD-2's own REACHABILITY QUESTION, ANSWERED (not merely declined): CAN a real detector re-entry for
  // an unchanged gen be DRIVEN through the public deliverHook/submit surface (not by calling the private
  // arming/check methods by hand)? Traced structurally, not guessed:
  //   - The whole mismatch-detection block (including the arming site) runs ONLY inside
  //     `if (submitWasOutstanding) { ... if (typeof hook.prompt === "string") { ... } }` (this file,
  //     UserPromptSubmit case), where `submitWasOutstanding = !live.enterConfirmed`, READ then
  //     UNCONDITIONALLY set `live.enterConfirmed = true` in the very next line, every single
  //     UserPromptSubmit hook delivery, regardless of source (internal or a genuine duplicate hook call
  //     from the real CLI) — so a SECOND hook delivery for a generation already confirmed by a FIRST one
  //     always finds `submitWasOutstanding === false` and skips the entire block, never reaching arming.
  //   - The ONLY code in this whole file that ever writes `live.enterConfirmed = false` again (this file,
  //     `submit()`) does so in the SAME synchronous call as `const gen = ++live.submitGeneration` — the two
  //     are written atomically together, with no `await` between them. So the ONLY way
  //     `submitWasOutstanding` can ever read `true` a second time is via a NEW, higher `submitGeneration` —
  //     never the SAME `gen` the first arm already captured.
  //   ⇒ Through `deliverHook`/`submit` alone (the real state machine this session's harness drives, and the
  //   only surface a genuine engine-originated re-entry could ever reach this code through), two arms for
  //   the IDENTICAL gen are NOT merely unobserved (as card c0323f8a's own comment states) — they are
  //   CODE-UNREACHABLE given the current coupling of `enterConfirmed` and `submitGeneration`. This is
  //   STRONGER than "no observed instance": it is a structural proof, not an absence of a specimen.
  //   OUTCOME (ii) FOLLOWS, per the card's own DoD-2: below is a HAND-ARMED test of the DEDUP itself —
  //   calling the PRIVATE `checkPromptMismatchUnresolved` (TypeScript `private` is compile-time-only; this
  //   is plain JS at runtime, same as `host.live` being read directly elsewhere in this suite) twice with
  //   an IDENTICAL synthetic gen, exactly as two independently-armed timers for the same gen would each do
  //   when they fire — this proves the DEDUP guard works, NOT that a real re-entry is reachable. Do not
  //   read it as reachability evidence; the reachability analysis above is what answers that question, and
  //   it answers NO for the current code (the arming site's own asymmetry vs. `isExactRepeatNotice` — the
  //   Direction (a) this card also offered — remains real and is worth closing per DoD-1's own reasoning
  //   even though it cannot currently be reached: the (b) fix shipped here also protects any FUTURE second
  //   arming path this file might grow, which Direction (a) alone would not). =====
  {
    const sid = newSession("HandArmedDedup340b9dbe"); SIDS.push(sid);
    const live = host.live.get(sid);
    check("28: sanity — no onPromptMismatchUnresolved has fired yet for this fresh session", unresolvedEvents.filter((e) => e.sessionId === sid).length === 0);
    check("28b: sanity — this gen has not been marked resolved (a real fusion never ran on this session)", !live.mismatchResolvedGens.has(99));

    // Simulate what TWO independently-armed follow-up timers for the SAME (gen, writtenHash, reportedHash)
    // would each do when they fire: call the method they'd each call, with IDENTICAL args, back to back —
    // exactly the shape the card's own asymmetry (arming before isExactRepeatNotice) can produce if it
    // arms twice for one gen.
    const args = [sid, /* gen */ 99, "deadbeef", "cafef00d", 123, /* recognizedGen */ 1, 45, "hand-armed dedup specimen"];
    host.checkPromptMismatchUnresolved(...args);
    host.checkPromptMismatchUnresolved(...args);

    const evs28 = unresolvedEvents.filter((e) => e.sessionId === sid);
    check("29: RED-PROOF (card 340b9dbe) — two independently-armed follow-ups for the SAME gen fire the durable event AT MOST ONCE, not twice",
      evs28.length === 1);
    check("30: the ONE event that did fire carries the original gen/hashes, unaffected by the dedup", evs28[0]?.info.gen === 99 && evs28[0]?.info.writtenHash === "deadbeef" && evs28[0]?.info.reportedHash === "cafef00d");
    check("31: sanity — a genuinely DIFFERENT gen is NOT swallowed by this gen's own dedup entry (the guard is per-gen, not global)",
      (() => {
        const before = unresolvedEvents.filter((e) => e.sessionId === sid).length;
        host.checkPromptMismatchUnresolved(sid, 100, "aaaa", "bbbb", 1, 1, 1, "different gen");
        return unresolvedEvents.filter((e) => e.sessionId === sid).length === before + 1;
      })());
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card f9b1ea00's own gap is closed: a recognized-replay `[loom:prompt-mismatch]` that never resolves within the (env-configurable) PROMPT_MISMATCH_RESOLVE_WINDOW_MS now fires PtyHostEvents.onPromptMismatchUnresolved exactly once, naming the original detection's own gen/hashes/length (PART 1 — previously this emitted nothing at all, ever); a mismatch that DOES resolve via a later CONFIRMED composer-accumulation fusion produces NO follow-up signal (PART 2, the mandatory other-direction positive control per DoD-3 — a check firing on both is the exact false-alarm regression card 854d1632 v3 caught); a stale follow-up timer left over from a PREVIOUS spawn of the same sessionId is CLEARED before a resume/recycle/restart overwrites the map entry, so it can never fire against — or be coincidentally satisfied by — an unrelated later incarnation's own state (PART 3, Code Review HIGH, mirroring readyFallbackTimer's own established fix, card c469d54e); and a wrapper-deficit or ANSI-strip-deficit mismatch — both benign, both `replayedEntry !== undefined` by construction, both structurally UNRESOLVABLE since only a CONFIRMED fusion (which requires `replayedEntry === undefined`) can mark a gen resolved — now arms NO follow-up timer at all, where the original cut would have armed one that could never resolve and failed loud 10 minutes after Loom said nothing was lost (PART 4, Code Review CRITICAL, the arming condition moved to match exactly the notice text's own `lossClause` replay branch); and a deliberate stop/crash also clears pending timers even though a claude session's own Live entry survives its own exit with alive:false rather than being deleted, so a stale timer can never fire a false 'please resend' nudge at a session that no longer exists (PART 5, Code Review MAJOR, mirroring readyFallbackTimer's own onExit clear)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
