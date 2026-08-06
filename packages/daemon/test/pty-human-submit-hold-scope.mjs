// Claude-free regression guard for card 3ff89cbc — "the human-submit hold's hook-clear is not
// generation-scoped" (pty/host.ts).
//
// THE BUG (Code Reviewer question on card 2521bf51, filed as its own card so it wouldn't evaporate):
// `Live.humanSubmitHeldUntil` (2521bf51) is armed by writeStdin whenever a genuine human Enter-submit
// frees the composer — REGARDLESS of whether an unrelated agent turn is already `busy` in flight. Before
// this fix, BOTH the UserPromptSubmit AND Stop/StopFailure hook handlers cleared the hold UNCONDITIONALLY
// on ANY confirming hook — including one belonging to that unrelated, ALREADY-in-flight turn, not the
// human's own not-yet-started one. Concrete sequence: (1) an agent turn is busy; (2) the human types into
// the raw terminal and hits Enter, arming the hold; (3) the AGENT's own Stop arrives (for the turn from
// step 1) and WRONGLY clears the hold, letting Loom drain a queued programmatic turn into the composer
// while the CLI is still holding the human's own queued line and about to start it — exactly the race
// 2521bf51 exists to prevent, reopened for this one narrow window.
//
// PRE-EXISTING, NOT A REGRESSION: before 2521bf51, that same unrelated Stop drained too — there was no
// hold at all to mis-clear. 2521bf51 did not introduce this window; it simply didn't cover it.
//
// THE FIX: a new `Live.humanSubmitHeldArmedDuringTurn` latch, snapshotted from `live.busy` at ARM time
// (writeStdin). UserPromptSubmit's own clear is left UNCONDITIONAL (a turn fires it at most once, so the
// very next one after arming can only be a genuinely NEW turn — the human's own). The Stop/StopFailure
// clear instead CONSUMES the latch on the first Stop it sees while the latch is true (that Stop can only
// be the pre-existing turn's own — claude runs one turn at a time) rather than clearing the hold; a LATER
// Stop for the same hold (the belt-and-suspenders path for a lost UserPromptSubmit hook) then finds the
// latch already consumed and clears normally. `submitGeneration` itself was investigated and found NOT to
// work as a scoping key here (see the card): it is never bumped between the hold being armed and the
// unrelated turn's own Stop (a raw human write never calls submit(), and neither hook handler bumps it),
// so a naive "record armedAtGen, clear on match" gate cannot discriminate the pre-existing turn's Stop
// from the human's own eventual confirmation — both read the identical generation.
//
// Exercises the real PtyHost state machine against a FAKE pty (createPty seam) — no real claude, no
// daemon, no network. Run: node test/pty-human-submit-hold-scope.mjs (after `pnpm build` from packages/daemon).
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-humansubmit-scope-"));
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Long enough that only a CORRECT clear (not the timeout backstop) could resolve the hold within this test.
const LONG_HOLD_MS = 5_000;
process.env.LOOM_HUMAN_SUBMIT_CONFIRM_HOLD_MS = String(LONG_HOLD_MS);

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

const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

function freshSession(id) {
  host.spawn({ sessionId: id, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // startupModeCycles:0 -> marks ready synchronously
  return fakes[fakes.length - 1];
}

try {
  // ===== (A) THE RACE: an unrelated, already-in-flight turn's own Stop must NOT clear a hold armed =====
  // ===== WHILE it was busy — and the hold must still resolve once the human's own turn is confirmed. ====
  {
    const SID = "sess-armed-during-turn";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");

    // An unrelated agent turn is already in flight (busy === true) BEFORE the human types anything.
    const r0 = host.enqueueStdin(SID, "AGENT_TURN_1");
    check("(A) setup: AGENT_TURN_1 delivers immediately (nothing dirty, nothing held yet)", r0.delivered === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "AGENT_TURN_1" }); // busy -> true

    // The human types into the raw terminal and hits Enter WHILE that agent turn is still busy.
    host.writeStdin(SID, "human typed line");
    host.writeStdin(SID, "\r"); // genuine submit -> arms live.humanSubmitHeldUntil, latches armedDuringTurn=true

    // A second Loom-originated message arrives mid-race — must be HELD.
    const r1 = host.enqueueStdin(SID, "AGENT_TURN_2");
    check("(A) AGENT_TURN_2 is HELD while the human's own submit is unconfirmed", r1.delivered === false && host.getPending(SID).length === 1);

    // THE FIX: the FIRST agent turn's own Stop arrives — unrelated to the human's not-yet-started turn.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) THE FIX: the unrelated turn's own Stop does NOT clear the hold — AGENT_TURN_2 stays queued",
      host.getPending(SID).length === 1 && !written().includes("AGENT_TURN_2"));

    // EVENTUAL RESOLUTION: the human's OWN turn now genuinely starts and completes — this must STILL
    // clear the hold and drain AGENT_TURN_2. Proves the fix delays delivery, it does not wedge it.
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "human typed line" });
    check("(A) the human's OWN UserPromptSubmit does not yet drain (busy is now true again)",
      host.getPending(SID).length === 1 && !written().includes("AGENT_TURN_2"));
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) EVENTUAL RESOLUTION: once the human's OWN turn confirms and stops, AGENT_TURN_2 drains",
      host.getPending(SID).length === 0 && written().includes("AGENT_TURN_2"));

    host.stop(SID, "hard");
  }

  // ===== (B) BELT-AND-SUSPENDERS: the human's own turn's UserPromptSubmit hook is LOST outright — its =====
  // ===== Stop alone must still clear the hold, once the pre-existing unrelated Stop has already passed. ==
  {
    const SID = "sess-lost-hook-after-unrelated";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");

    const r0 = host.enqueueStdin(SID, "AGENT_TURN_A");
    check("(B) setup: AGENT_TURN_A delivers immediately", r0.delivered === true);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "AGENT_TURN_A" }); // busy -> true

    host.writeStdin(SID, "another human line");
    host.writeStdin(SID, "\r"); // arms hold, armedDuringTurn=true

    const r1 = host.enqueueStdin(SID, "AGENT_TURN_B");
    check("(B) AGENT_TURN_B is HELD", r1.delivered === false);

    host.deliverHook(SID, { hook_event_name: "Stop" }); // the PRE-EXISTING turn's own Stop — consumes the latch, does not clear
    check("(B) the pre-existing turn's Stop does not clear the hold",
      host.getPending(SID).length === 1 && !written().includes("AGENT_TURN_B"));

    // The human's own turn's UserPromptSubmit hook is LOST — its Stop arrives directly instead. The
    // latch was already consumed above, so this Stop must now be trusted as the human's own confirmation.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(B) BELT-AND-SUSPENDERS: a SECOND Stop (lost UserPromptSubmit) now clears the hold and drains",
      host.getPending(SID).length === 0 && written().includes("AGENT_TURN_B"));

    host.stop(SID, "hard");
  }

  // ===== (C) POSITIVE CONTROL: arming with NOTHING already in flight is byte-identical to before this ===
  // ===== card — an ordinary Stop (no pre-existing turn) still clears the hold on the FIRST Stop. =========
  {
    const SID = "sess-armed-while-idle";
    const fake = freshSession(SID);
    const written = () => fake.writes.join("");

    host.writeStdin(SID, "idle-typed line");
    host.writeStdin(SID, "\r"); // arms hold; live.busy was false at arm time -> armedDuringTurn=false
    const r1 = host.enqueueStdin(SID, "AGENT_TURN_C");
    check("(C) AGENT_TURN_C is HELD while unconfirmed", r1.delivered === false);

    host.deliverHook(SID, { hook_event_name: "Stop" }); // this IS the human's own turn's confirmation — nothing pre-existing
    check("(C) POSITIVE CONTROL: the FIRST Stop clears the hold and drains when nothing was pre-existing",
      host.getPending(SID).length === 0 && written().includes("AGENT_TURN_C"));

    host.stop(SID, "hard");
  }
} finally {
  for (const id of ["sess-armed-during-turn", "sess-lost-hook-after-unrelated", "sess-armed-while-idle"]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 3ff89cbc: the human-submit hold's Stop-clear is now scoped to whether an " +
    "unrelated turn was already in flight when the hold was armed. An unrelated, pre-existing turn's own " +
    "Stop no longer wrongly clears the hold; the hold still resolves promptly once the human's own turn " +
    "is genuinely confirmed (via UserPromptSubmit, or via a second Stop in the lost-hook case); arming " +
    "with nothing pre-existing is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
