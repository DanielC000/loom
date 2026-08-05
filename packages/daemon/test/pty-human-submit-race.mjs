// Claude-free regression guard for card 2521bf51 — "a human Enter never arms busy, so the drain races
// the turn it just started" (pty/host.ts).
//
// THE BUG (owner-reported live, reproduced on demand — see the card for the full verified chain): a
// human writing directly into the terminal, mid-way through a QUEUED programmatic turn, would hit Enter
// and have Loom's held turn land INSIDE the composer's box-free transition. The root cause: the human's
// raw bytes never go through submit() (writeStdin, not submit()), so nothing ever arms `live.busy` for
// a human-typed turn. `drainPending`'s ONLY timing gate is `live.busy`. writeStdin's own dirty→clean
// transition used to call `drainPending` SYNCHRONOUSLY the instant its LOCAL byte-counter (`composerLen`)
// saw the draft go to zero — a heuristic that only proves Loom stopped seeing dirty bytes, NOT that
// claude has actually PROCESSED the Enter and cleared its own composer. The pty's FIFO byte order (human
// bytes strictly before Loom's paste) holds, but byte order is not state-transition order — a comment in
// the old code asserted the outcome that fails; see the corrected comment at its call site.
//
// §DIRECTION (the card's own, load-bearing correction): the mechanism predicts a collision regardless of
// which side (Loom's queued payload vs. the human's own draft) is longer — direction is a function of
// relative size, not a signature of the bug. This suite exercises BOTH size regimes (DoD-2) so a reader
// can never mistake "we only tested one direction" for "the fix only closes one direction".
//
// THE FIX (this test locks it down): `nextRawDraftState`'s `draft.submitted` already distinguishes a
// genuine SUBMIT (Enter freeing a non-empty draft) from a CLEAR (Ctrl-C/kill-line/Esc/backspace-to-empty)
// — a CLEAR still drains PROMPTLY (unaffected: there's no engine-side turn to race). A SUBMIT instead arms
// a new, bounded `Live.humanSubmitHeldUntil` hold — closing BOTH the synchronous race (the direct
// writeStdin→drainPending call) AND the periodic reconcile-tick race (an unlucky ~10s tick landing in the
// same unconfirmed gap would otherwise drain just as unsafely) — self-clearing the instant claude's own
// UserPromptSubmit/Stop hook actually confirms the turn, with the bound itself only a backstop for the
// rare case both hooks are lost, so a queued turn is DELAYED, never LOST (DoD-5).
//
// Exercises the real PtyHost state machine against a FAKE pty (createPty seam) — no real claude, no
// daemon, no network. Run: node test/pty-human-submit-race.mjs (after `pnpm build` from packages/daemon).
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-humansubmit-"));
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Shrink the backstop bound so scenario (E) (no confirming hook ever arrives) doesn't burn real seconds.
const SHORT_HOLD_MS = 120;
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = String(SHORT_HOLD_MS);

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

const busyLog = {};
const events = { onEngineSessionId() {}, onBusy(id, b) { (busyLog[id] ??= []).push(b); }, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** writeChunked paces a LARGE payload across multiple setTimeout-scheduled writes (see its own doc) — a
 *  long queued turn's body can still be mid-flight several chunks after drainPending/submit() returns.
 *  Poll the ACTUAL observable (the joined write log) rather than guessing a fixed delay. */
async function waitUntil(predicate, timeoutMs = 5_000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(5);
  }
}

function freshSession(id) {
  host.spawn({ sessionId: id, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // startupModeCycles:0 → marks ready synchronously
  return fakes[fakes.length - 1];
}

const PASTE_START = "\x1b[200~";
const LONG = "Q".repeat(2000);   // a long queued programmatic payload
const SHORT = "q";               // a short one
const LONG_DRAFT = "D".repeat(2000); // a long human draft
const SHORT_DRAFT = "d";             // a short one

try {
  // ===== (A)/(B) THE RACE, BOTH SIZE REGIMES (§DIRECTION, DoD-2) =============================
  // Regime 1: LONG queued payload + SHORT human draft. Regime 2: SHORT queued payload + LONG draft.
  for (const [label, draftText, queuedText] of [
    ["regime1 (long queued, short draft)", SHORT_DRAFT, LONG],
    ["regime2 (short queued, long draft)", LONG_DRAFT, SHORT],
  ]) {
    const SID = `sess-race-${label.slice(0, 7)}`;
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");

    host.writeStdin(SID, draftText);                 // human types a draft → composer dirty
    const r = host.enqueueStdin(SID, queuedText);     // a programmatic turn arrives mid-draft
    check(`(${label}) queued turn is HELD while the draft is dirty`, r.delivered === false);

    // THE RACE: a genuine Enter-submit (non-empty draft) frees the box.
    host.writeStdin(SID, "\r");
    // (A) Checked IMMEDIATELY, synchronously, in the SAME tick as the Enter — no hook has been
    // delivered, no time has passed. Pre-fix, drainPending fired right here and the queued payload was
    // already written to the pty, adjacent to the human's own Enter, with zero engine confirmation.
    check(`(${label}) (A) THE RACE, FORCED: immediately after Enter, the queued turn is NOT drained — ` +
      "no engine confirmation has arrived yet, so nothing may deliver into the still-unconfirmed composer",
      host.getPending(SID).length === 1 && !written().includes(queuedText));

    // (B) An UNLUCKY reconcile tick landing in the same unconfirmed gap (no hook yet) must ALSO not
    // drain — proving the fix closes the periodic-tick race, not just the direct synchronous call.
    host.reconcile();
    check(`(${label}) (B) an unconfirmed reconcile tick does NOT drain either`,
      host.getPending(SID).length === 1 && !written().includes(queuedText));

    // (C) Once the engine genuinely confirms the turn (UserPromptSubmit then Stop, the real hook
    // sequence for a completed turn), the held queued turn delivers — DELAYED, not lost.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: draftText });
    check(`(${label}) (C) confirmed: UserPromptSubmit alone does not yet drain (busy is now true)`,
      host.getPending(SID).length === 1 && !written().includes(queuedText));
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check(`(${label}) (C) confirmed: after Stop, the queued turn is drained from the pending queue`,
      host.getPending(SID).length === 0);
    // A LONG queued body is chunked across several paced writeChunked() calls (see its own doc) — poll
    // for the full body to actually land rather than asserting synchronously right after Stop.
    await waitUntil(() => written().includes(queuedText));
    check(`(${label}) (C) confirmed: the queued turn's full body was written`, written().includes(queuedText));
    check(`(${label}) (C) FIFO order preserved: the human's own Enter is still written before the queued paste`,
      written().indexOf("\r") < written().lastIndexOf(PASTE_START));

    host.stop(SID, "hard");
  }

  // ===== (D) POSITIVE CONTROL, ARM 1 — a CLEAR (not a submit) still drains PROMPTLY (unaffected) =====
  {
    const SID = "sess-clear-ctrlc";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "half-typed");
    const r = host.enqueueStdin(SID, "QUEUED");
    check("(D/ctrl-c) queued turn HELD while dirty", r.delivered === false);
    host.writeStdin(SID, "\x03"); // Ctrl-C — a CLEAR, not a submit (draft.submitted === null)
    check("(D/ctrl-c) a CLEAR still drains IMMEDIATELY, no hook needed — this path is untouched by the fix",
      host.getPending(SID).length === 0 && written().includes("QUEUED"));
    host.stop(SID, "hard");
  }
  {
    const SID = "sess-clear-backspace";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "x");
    host.enqueueStdin(SID, "QUEUED2");
    host.writeStdin(SID, "\x7f"); // backspace-to-empty — also a CLEAR
    check("(D/backspace) backspace-to-empty still drains IMMEDIATELY",
      host.getPending(SID).length === 0 && written().includes("QUEUED2"));
    host.stop(SID, "hard");
  }

  // ===== (D) POSITIVE CONTROL, ARM 2 — a genuine SUBMIT does NOT drain promptly (the bug this fixes) ===
  // Re-stated as an explicit control so the rig demonstrably tells the two arms apart, not just asserted
  // once above: identical setup to (A), but checked for the NEGATIVE (must NOT have drained).
  {
    const SID = "sess-submit-negctrl";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "a real line");
    host.enqueueStdin(SID, "QUEUED3");
    host.writeStdin(SID, "\r"); // genuine submit
    check("(D/submit) NEGATIVE CONTROL: a genuine submit must NOT drain promptly (discriminates from D/ctrl-c and D/backspace above)",
      host.getPending(SID).length === 1 && !written().includes("QUEUED3"));
    host.stop(SID, "hard");
  }

  // ===== (E) BACKSTOP — if NO confirming hook EVER arrives, the hold EXPIRES and the queued turn still ===
  // ===== drains via the reconcile tick — DELAYED, never LOST (DoD-5) =====================================
  {
    const SID = "sess-backstop";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");
    host.writeStdin(SID, "orphaned line");
    host.enqueueStdin(SID, "QUEUED4");
    host.writeStdin(SID, "\r"); // genuine submit — arms the bounded hold, no hook ever follows
    check("(E) held immediately after the submit, no hook delivered", host.getPending(SID).length === 1 && !written().includes("QUEUED4"));
    host.reconcile();
    check("(E) still held before the bound expires", host.getPending(SID).length === 1 && !written().includes("QUEUED4"));
    await sleep(SHORT_HOLD_MS + 100);
    host.reconcile(); // the bound has now expired — this reconcile tick is the backstop delivering it
    check("(E) BACKSTOP: after the bound expires, the reconcile tick delivers the orphaned queued turn — a delayed but successful drain",
      host.getPending(SID).length === 0 && written().includes("QUEUED4"));
    host.stop(SID, "hard");
  }
} finally {
  // Card review nitpick: `waitUntil` (above) THROWS on timeout, before the two regime blocks' own
  // inline `host.stop(SID, "hard")` calls run — leaking a live fake pty + log fd on that path, which on
  // Windows can make the `fs.rmSync(tmpHome)` below fail. Every session this file spawns is listed here
  // too so a thrown timeout still cleans up.
  for (const id of ["sess-race-regime1", "sess-race-regime2", "sess-clear-ctrlc", "sess-clear-backspace", "sess-submit-negctrl", "sess-backstop"]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 2521bf51: a genuine human Enter-submit no longer drains a queued programmatic " +
    "turn until the engine actually confirms the turn (UserPromptSubmit/Stop), closing both the " +
    "synchronous race and the periodic reconcile-tick race; a CLEAR (Ctrl-C/backspace-to-empty) is " +
    "unaffected and still drains promptly; an orphaned hold (no hook ever arrives) still drains via the " +
    "bounded backstop — delayed, never lost. Both size regimes collide identically (§DIRECTION)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
