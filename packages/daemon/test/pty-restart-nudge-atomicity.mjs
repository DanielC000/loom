import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 78a16dc5 — restart-resume notice assembly must be ATOMIC per message (no interleave with
// kickoff/queued text), and an invalid (not well-formed UTF-16) system nudge must be SANITIZED, never
// dropped — a Code Reviewer catch on this same card found that dropping is itself a stall hazard.
//
// THE BUG (origin finding 5098c845): a worker received a CORRUPTED composite — recognizable fragments
// of the `[loom:daemon-restarted]` restart-resume notice interleaved MID-WORD with fragments of the
// kickoff's project-memory text. Root cause: `scheduleKickoffGuarantee` (pty/host.ts) force-submits the
// original kickoff via a DIRECT `submit()` call gated ONLY on `!live.firstTurnStarted` — unlike every
// other caller of `submit()` (`drainPending` guards `!live.busy`; `enqueueStdin`'s immediate path checks
// `!live.busy`; `resumeAfterRateLimit`, fixed once already for this exact class of bug — card 81f9c887 —
// guards `busy`/`stopping`/`drainHeld` and falls back to `enqueueStdin`). `firstTurnStarted` is set ONLY
// by the `UserPromptSubmit` hook, which CAN be lost (Stop/StopFailure still fires and clears busy
// regardless — see the handler's own comment) — so the grace-timer force-submit can fire WHILE a
// `drainPending`-triggered submit for a genuinely queued nudge is still mid `writeChunked` (which splits
// a large write into paced chunks across MULTIPLE ticks — see PTY_WRITE_CHUNK_BYTES/_DELAY_MS). Two
// concurrent `writeChunked` chains on the SAME pty interleave their staggered `pty.write()` calls,
// splicing two different messages together mid-word.
//
// THE FIX (host.ts):
//   (1) scheduleKickoffGuarantee now defers to `enqueueStdin(..., kind:"agent")` instead of a raw
//       `submit()` whenever a real submit is genuinely outstanding (`submitGeneration > 0 &&
//       !enterConfirmed` — NOT bare `busy`, which is also true from the spawn-time OPTIMISTIC set with
//       nothing actually in flight, the common "truly never started" case this guarantee exists for) or
//       the session is stopping/drainHeld/rateLimited — atomic delivery, guarantee still honored (never
//       dropped, just held FIFO until the next safe boundary).
//   (2) A shape guard in `enqueueStdin`, scoped to `kind:"warning"` only (Loom's own bracket-tagged
//       operational nudges — an `"agent"`-kind entry is legitimately free-form text, no tag convention,
//       and is exempt from BOTH checks below, unmodified and unlogged):
//         - `sanitizeLoneSurrogates` (SANITIZE + log, still delivered): a lone (unpaired) UTF-16
//           surrogate — the actual corruption signature from the finding (bytes split mid multi-byte
//           UTF-8 sequence) — is replaced with U+FFFD and the (now well-formed) text is still enqueued.
//           An EARLIER version of this guard DROPPED here instead — a Code Reviewer catch found that's a
//           real stall hazard: the async run_gate FAILURE nudge (kind:"warning") embeds a raw code-unit
//           slice of captured gate stderr, which CAN legitimately contain a lone surrogate (an emoji split
//           at the slice boundary) — and `clearPendingGateOp` runs immediately before that enqueue, so a
//           dropped nudge there would leave no durable pending-op to recover from, stranding a worker
//           parked on its gate-completion nudge indefinitely. Sanitizing removes the hazard while still
//           fixing the byte-level corruption.
//         - `isUntaggedSystemNudge` (LOG-ONLY, still delivered unmodified): missing the `[loom:` prefix.
//           This was ALSO briefly a drop condition, but that assumed "warning"-kind ⇒ always
//           `[loom:`-tagged is an invariant the codebase holds everywhere — it does NOT (the companion
//           persona-reinject path, plus ~15 pre-existing test fixtures, all legitimately sent untagged
//           "warning"-kind text before this card). So a missing tag is logged as an anomaly but delivered.
//
// HERMETIC, claude-free: PtyHost driven against a FAKE pty (mirrors worker-kickoff-guarantee.mjs /
// pty-busy-drain.mjs) — no real claude, no daemon, no network.
//
// FALSIFICATION (part A): this test's interleave repro FAILS on pre-fix code — reverting ONLY
// scheduleKickoffGuarantee's guard (restoring the bare `this.submit(sessionId, kickoff)`) reproduces the
// interleave and both contiguity assertions below flip to FAIL. Verified by hand against the pre-fix
// source during development of this fix.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-restart-nudge-atomicity.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll for `cond()` instead of a blind fixed sleep, bounded by a generous ceiling so a genuinely broken
// case still fails loudly rather than hanging. See the (A) write-contiguity block below for WHY a fixed
// sleep is wrong here (card 2b9adeed).
const waitUntil = async (cond, ceilingMs = 8000, intervalMs = 20) => {
  const deadline = performance.now() + ceilingMs;
  while (!cond() && performance.now() < deadline) await sleep(intervalMs);
  return cond();
};

// Hermetic LOOM_HOME + tight, test-only timing windows — all read at MODULE IMPORT time (host.ts), so
// they must be set BEFORE importing host.js. PTY_WRITE_CHUNK_BYTES/_DELAY_MS are shrunk/widened (env
// seam added by card 78a16dc5 specifically for this test) so a single writeChunked() chain spans a wide,
// deterministic real-time window instead of relying on production-sized (1024B/8ms) timing.
const tmpHome = path.join(os.tmpdir(), `loom-restart-atomic-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_STARTUP_PROMPT_GRACE_MS = "60";
process.env.LOOM_PTY_WRITE_CHUNK_BYTES = "10";
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "15";
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "120000"; // never fires within this test's window — no Enter/retry noise
process.env.LOOM_READY_FALLBACK_MS = "120000";
process.env.LOOM_FIRST_TURN_STALE_MS = "120000";

const { PtyHost } = await import("../dist/pty/host.js");

const PASTE_START = "\x1b[200~";

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    kill: () => {}, resize: () => {}, writes,
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {} };
const host = new TestPtyHost(events);

const writtenOf = (fake) => fake.writes.join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;

// Capture console.warn (the shape guard's own anomaly log) without silencing PASS/FAIL console.log.
const warnLog = [];
const realWarn = console.warn;
console.warn = (...args) => { warnLog.push(args.join(" ")); };

try {
  // ================= PART A — atomic assembly: no interleave, guarantee still honored =================
  {
    const SID = "restart-atomic-A";
    // Long, distinct bodies so a genuine byte-level interleave breaks EITHER contiguous substring check —
    // and so writeChunked needs many chunks (>1 tick) at the shrunk chunk size, giving the race a wide window.
    const KICKOFF = "orchestrate task tk-A with project-memory: " + "K".repeat(300);
    const NUDGE = "[loom:daemon-restarted] The daemon was rebuilt + restarted and you were resumed: " + "N".repeat(300);

    host.spawn({
      sessionId: SID, cwd: tmpHome, startupPrompt: KICKOFF,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fa = fakes[fakes.length - 1];
    host.deliverHook(SID, { hook_event_name: "SessionStart" }); // ready — arms the grace timer; NEVER fires UserPromptSubmit (simulates the lost hook)

    // Queue the restart-resume nudge while busy (the optimistic startupPrompt busy set) — held FIFO.
    const enq = host.enqueueStdin(SID, NUDGE, "system", undefined, undefined, "warning");
    check("(A) the well-formed [loom:*] nudge is accepted (held, not dropped)", enq.delivered === false && enq.reason === "held");

    // Stop fires WITHOUT a preceding UserPromptSubmit (the lost-hook case) — busy clears, drainPending()
    // finds the queued NUDGE and starts its OWN writeChunked chain (many ticks at the shrunk chunk size).
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) the nudge drain started immediately (one bracketed paste already written)", countIn(fa, PASTE_START) === 1);

    // The grace timer (60ms) elapses WHILE the nudge's writeChunked chain is still mid-flight (33 chunks
    // × 15ms ≈ 480ms) and firstTurnStarted is STILL false (that hook was never fired) — exactly the race.
    await sleep(200);
    check("(A) mid-race: NOT yet a second bracketed paste (kickoff held, not racing the in-flight write)",
      countIn(fa, PASTE_START) === 1);
    check("(A) mid-race: the kickoff-guarantee QUEUED the kickoff instead of writing it now",
      host.getPending(SID).includes(KICKOFF));

    // Let the nudge's writeChunked chain fully finish (no interleave to break it). This chain is 39 real
    // setTimeout ticks (@15ms) — its wall-clock duration is NOT fixed, so wait for the actual condition
    // instead of guessing a duration (card 2b9adeed, was `await sleep(900)`):
    //   - measured on a QUIET host (40 sequential trials, real dist build): mean 644ms, p90 686ms, MAX
    //     779.6ms — already only ~320ms (~29%) under the old 1100ms (200+900) budget.
    //   - this project's own timing-test-constants-vs-scheduling-jitter finding (card 9f3164b8) measured
    //     ~1.6s of real scheduling delay on a loaded gate host — an order of magnitude bigger than that
    //     margin, and enough on its own to blow the old fixed sleep.
    //   - falsified: a scratch harness that fires the second Stop with NO wait (forcing the two chains'
    //     setTimeout chains to genuinely interleave on the SAME fake pty, since neither writeChunked nor
    //     deliverHook's Stop branch gate on a prior chain's completion) reproduced this exact 3-assertion
    //     failure pattern (NUDGE/KICKOFF contiguity + FIFO order all FAIL, "exactly two submits" still
    //     PASSes) byte-for-byte against real dist code. The same harness, gated on `waitUntil` below
    //     instead of firing blind, went green. So polling for the real condition — not a bigger guess —
    //     is what removes the flake.
    //   - WHY waiting for actual completion is also the CORRECT simulation, not just a workaround: in
    //     production a Stop hook can only ever be delivered by the real Claude CLI after it has processed
    //     a turn, which requires Enter to have already landed — and Enter is only sent from writeChunked's
    //     own `done` callback (submit(), host.ts), i.e. strictly AFTER the chain fully completes. A real
    //     Stop can therefore never race an in-flight chain; this test's hand-driven `deliverHook(Stop)`
    //     must mirror that same ordering to stay a faithful simulation, not fire on a wall-clock guess.
    const nudgeSettled = await waitUntil(() => writtenOf(fa).includes(NUDGE));
    check("(A) the NUDGE landed as ONE CONTIGUOUS write — no interleave broke it", nudgeSettled);

    // End the nudge's turn (a Stop for it) — drains the QUEUED kickoff (the guarantee is preserved: it
    // was held, never dropped) as its own, now-unraced, submit. Only fired once the nudge chain is
    // CONFIRMED complete above — see the WHY block above for why this ordering is load-bearing, not
    // cosmetic: firing it early is exactly the forced-failure scenario that was falsified.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(A) the queued kickoff drains as a SECOND, separate bracketed paste", countIn(fa, PASTE_START) === 2);
    check("(A) pending is now empty (the kickoff was delivered, not stranded)", host.getPending(SID).length === 0);

    // Same reasoning as the nudge above: poll for the kickoff's own chain to actually finish (measured
    // quiet-host max 673ms against the old fixed 900ms sleep — only ~227ms/~25% margin) instead of guessing.
    const kickoffSettled = await waitUntil(() => writtenOf(fa).includes(KICKOFF));
    check("(A) the KICKOFF also landed as ONE CONTIGUOUS write — the guarantee delivered it intact",
      kickoffSettled);
    check("(A) FIFO ORDER preserved — the nudge (queued+drained first) precedes the kickoff in the write log",
      writtenOf(fa).indexOf(NUDGE) < writtenOf(fa).indexOf(KICKOFF));
    check("(A) exactly two submits total (nudge + kickoff) — never a third phantom write", countIn(fa, PASTE_START) === 2);
  }

  // ============== PART B — shape guard: invalid UTF-16 sanitized (never dropped), missing tag logged ==============
  {
    const SID = "restart-atomic-B";
    host.spawn({
      sessionId: SID, cwd: tmpHome, // no startupPrompt — idle from the start
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    const fb = fakes[fakes.length - 1];
    host.deliverHook(SID, { hook_event_name: "SessionStart" }); // ready + idle

    // (b1) warning-kind, tagged but containing a LONE (unpaired) surrogate — the string-level signature
    // of bytes spliced mid multi-byte UTF-8 sequence (this card's actual observed corruption class). Must
    // be SANITIZED (U+FFFD in place of the lone surrogate) and STILL DELIVERED, never dropped — the
    // Code-Reviewer-mandated fix (a drop here is a stall hazard for the async run_gate failure nudge,
    // which can legitimately contain a lone surrogate from a slice-boundary-split emoji).
    const warnBefore1 = warnLog.length;
    const malformedUtf16 = "[loom:daemon-restarted] tests (full next-build ga real differ\uD800NEERING STEP";
    const r1 = host.enqueueStdin(SID, malformedUtf16, "system", undefined, undefined, "warning");
    check("(B1) a tagged-but-ill-formed (lone surrogate) nudge is DELIVERED, not dropped", r1.delivered === true);
    check("(B1) the shape guard logged the sanitize anomaly", warnLog.length > warnBefore1);
    await sleep(350); // let its (shrunk-chunk-size) writeChunked chain finish landing on the pty
    const written1 = writtenOf(fb);
    check("(B1) the delivered text is SANITIZED — the lone surrogate is replaced with U+FFFD", written1.includes("differ�NEERING STEP"));
    check("(B1) the REST of the original content survives intact around the sanitized spot", written1.includes("[loom:daemon-restarted] tests (full next-build ga real differ") && written1.includes("NEERING STEP"));
    check("(B1) the raw lone surrogate itself never reaches the pty (it's gone, not just present-plus-replacement)", !written1.includes(malformedUtf16));

    host.deliverHook(SID, { hook_event_name: "Stop" }); // re-idle for the next scenario

    // (b2) warning-kind, missing the [loom:*] tag — NOT corruption, just an unaudited sender: logged as an
    // anomaly but still DELIVERED (idle session → immediate submit), never dropped or held forever.
    const warnBefore2 = warnLog.length;
    const untagged = "restart complete, please continue";
    const r2 = host.enqueueStdin(SID, untagged, "system", undefined, undefined, "warning");
    check("(B2) an untagged warning-kind nudge is DELIVERED, not dropped", r2.delivered === true);
    check("(B2) the shape guard logged the missing-tag anomaly", warnLog.length > warnBefore2);
    await sleep(350);
    check("(B2) it was actually written to the pty, VERBATIM (the missing tag never blocked or altered delivery)", writtenOf(fb).includes(untagged));

    host.deliverHook(SID, { hook_event_name: "Stop" }); // re-idle

    // (b3) regression: a well-formed, correctly-tagged warning still delivers normally — NO new warning logged.
    const warnBefore3 = warnLog.length;
    const goodNudge = "[loom:daemon-restarted] You were resumed.";
    const r3 = host.enqueueStdin(SID, goodNudge, "system", undefined, undefined, "warning");
    check("(B3) a well-formed [loom:*] warning still delivers", r3.delivered === true);
    check("(B3) NO anomaly logged for a well-formed, correctly-tagged warning", warnLog.length === warnBefore3);
    await sleep(350);
    check("(B3) it was actually written to the pty", writtenOf(fb).includes(goodNudge));

    host.deliverHook(SID, { hook_event_name: "Stop" }); // re-idle

    // (b4) FALSE-POSITIVE guard: a VALID non-BMP character (an emoji — a real surrogate PAIR, not a lone
    // surrogate) tagged warning must deliver UNCHANGED, byte-for-byte, with NO anomaly logged — proving the
    // sanitize regex targets only genuinely lone/unpaired surrogates, not every non-BMP character.
    const warnBefore4 = warnLog.length;
    const emojiNudge = "[loom:daemon-restarted] Rebuild complete 🎉 you were resumed.";
    const r4 = host.enqueueStdin(SID, emojiNudge, "system", undefined, undefined, "warning");
    check("(B4) a valid emoji (real surrogate pair) tagged warning delivers", r4.delivered === true);
    check("(B4) NO anomaly logged for a valid surrogate pair (not a false positive)", warnLog.length === warnBefore4);
    await sleep(350);
    check("(B4) the emoji nudge was written VERBATIM, unchanged", writtenOf(fb).includes(emojiNudge));

    host.deliverHook(SID, { hook_event_name: "Stop" }); // re-idle

    // (b5) regression: BOTH checks are scoped to kind:"warning" ONLY — free-form agent-authored text (a
    // worker report, no [loom:*] tag, and even a lone surrogate) must NEVER be caught by either tier, and
    // must be delivered COMPLETELY UNMODIFIED (not sanitized either) with no anomaly logged.
    const warnBefore5 = warnLog.length;
    const workerReportUntagged = "done: fixed the bug, see commit abc123. No [loom: tag here at all.";
    const r5 = host.enqueueStdin(SID, workerReportUntagged, "system", undefined, undefined, "agent");
    check("(B5) an untagged AGENT-kind message is delivered immediately (idle session), unaffected by the warning-only shape guard", r5.delivered === true);
    const workerReportIllFormed = "report: differ\uD800NEERING STEP (agent-kind, ill-formed, still exempt)";
    const r6 = host.enqueueStdin(SID, workerReportIllFormed, "system", undefined, undefined, "agent");
    check("(B5) the ill-formed (lone surrogate) AGENT-kind message QUEUES behind r5's now-busy turn (exempt, not dropped either)", r6.delivered === false && r6.position === 1);
    check("(B5) NO anomaly logged for either agent-kind message (both checks are warning-only)", warnLog.length === warnBefore5);
    await sleep(350); // let r5's OWN writeChunked chain fully finish before ending its turn — else this Stop
                       // would race r6's drain against r5's still-in-flight chunks (a self-inflicted version
                       // of the very interleave Part A tests against, not a guard-under-test concern here).
    host.deliverHook(SID, { hook_event_name: "Stop" }); // drains r6
    await sleep(350);
    check("(B5) the ill-formed agent-kind text was delivered COMPLETELY UNMODIFIED (raw lone surrogate intact, not sanitized)",
      writtenOf(fb).includes(workerReportIllFormed));
  }
} finally {
  console.warn = realWarn;
  for (const id of ["restart-atomic-A", "restart-atomic-B"]) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — restart-resume notice assembly is atomic (scheduleKickoffGuarantee never races an in-flight write; the guarantee still delivers, just queued instead of raced). The shape guard NEVER drops: an invalid (ill-formed-UTF-16, lone-surrogate) warning-kind nudge is SANITIZED (U+FFFD) + logged, still delivered; a merely untagged warning-kind nudge is logged as an anomaly but delivered verbatim; a well-formed tagged warning or a valid non-BMP emoji delivers unchanged with no false-positive log; and any agent-kind message (tagged or not, well-formed or not) is completely unaffected by both checks."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
