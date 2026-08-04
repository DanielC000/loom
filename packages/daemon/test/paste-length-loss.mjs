// Card b68d1f5b DoD-1 — the gen-aware, calibrated paste-length-loss detector. HERMETIC — no daemon, no
// real claude.
//
// Background: card b68d1f5b's existing `detectBarePastePlaceholderTripwire` (paste-tripwire.mjs's own
// suite) can only fire when Loom itself knows `submittedText` (what it wrote) — structurally blind to a
// human paste typed directly, which never touches Loom's own write path at all. This file's detector,
// `detectPastePlaceholderLengthLoss`, closes that gap by working from the RECORDED/delivered side alone:
// a `[Pasted text #N +M lines]` token surviving into the recorded transcript text always means those M
// lines never reached the engine, regardless of who wrote them.
//
// The hard constraint (card abeac33a, folded into b68d1f5b 2026-08-04): a naive version of this check
// FIRES ON A CORRECT SEND, because a placeholder token can be a CLI-side rendering GHOST — an earlier,
// already-delivered gen's own placeholder re-rendering into a later, unrelated, correctly-delivered turn.
// `findExplainingWrittenGen` (internal — exercised here only via the public detector) is the `gen`
// discriminator: it searches `Live.recentWrittenLineCounts` (any gen, current or older, within
// `PASTE_LOSS_EXPLAIN_WINDOW`) for an entry whose own line count matches the placeholder's stated M — a
// match means EXPLAINED (silence); only a placeholder matching NO known Loom write, or one whose
// explaining write has AGED OUT of the window, is genuinely UNEXPLAINED and gets reported.
//
// Card b68d1f5b Code Review: this history is its OWN dedicated, integer-only ring — NOT card c2c750a9's
// `Live.recentWrittenTurns` (bounded at 8, sized for that detector's own full-text sum+hash job). Part 3
// below proves the bound is real: a placeholder whose explaining write has rotated out of
// `PASTE_LOSS_EXPLAIN_WINDOW` DOES fire — the residual this design explicitly documents rather than hides.
//
// PART 1 (pure): detectPastePlaceholderLengthLoss + its calibration constant.
// PART 2 (PtyHost, fake pty via the createPty() seam — no real claude, no daemon, no network): drives the
// real Stop-hook chokepoint and asserts `onPasteLengthLoss` fires ONLY on a genuinely unexplained
// placeholder, proving new coverage the OLD submittedText-gated detector cannot provide, and staying
// silent on both the current-gen-explained and stale-older-gen-explained shapes.
// PART 3 (PtyHost): the rotated-out case — an explaining write still WITHIN the window keeps a stale
// token silent; the SAME write pushed just OUTSIDE the window (by `PASTE_LOSS_EXPLAIN_WINDOW` more
// Loom-authored submissions) lets that same stale token fire.
//
// RUN (no daemon needed): node test/paste-length-loss.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-pll-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const {
  detectPastePlaceholderLengthLoss, PASTE_LOSS_CALIBRATED_BYTES_PER_LINE, PASTE_LOSS_EXPLAIN_WINDOW,
  computeWrittenLineCounts,
} = await import("../dist/orchestration/paste-tripwire.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// ============================ PART 1 — pure (no pty, no daemon) ============================

{
  check("calibration constant is the abeac33a-established median (128.4-132.3 B/line)",
    PASTE_LOSS_CALIBRATED_BYTES_PER_LINE >= 128 && PASTE_LOSS_CALIBRATED_BYTES_PER_LINE <= 133);
  check("explain window is meaningfully wider than card c2c750a9's own 8-entry COMPOSER_ACCUM_WINDOW",
    PASTE_LOSS_EXPLAIN_WINDOW >= 8 * 4);

  // Ring entries are now { gen, lineCounts } — computeWrittenLineCounts(text) is the SAME function host.ts
  // calls at write time, so a test-built entry has an identical shape to a real Live.recentWrittenLineCounts one.
  const entry = (gen, text) => ({ gen, lineCounts: computeWrittenLineCounts(text) });

  check("computeWrittenLineCounts: 2 newlines -> candidates [2, 3]",
    JSON.stringify(computeWrittenLineCounts("line1\nline2\nline3")) === JSON.stringify([2, 3]));

  // --- A: UNEXPLAINED, empty history (the pure human/raw-terminal-paste case — no Loom write exists at
  // ANY gen that could explain the placeholder) → fires with the calibrated estimate. ---
  {
    const out = detectPastePlaceholderLengthLoss("[Pasted text #12 +21 lines]", null, []);
    check("A: unexplained placeholder (empty history) → exactly one candidate", out.length === 1);
    check("A: candidate carries the exact token", out[0]?.token === "[Pasted text #12 +21 lines]");
    check("A: candidate carries the placeholder number", out[0]?.placeholderNum === 12);
    check("A: candidate carries the stated line count", out[0]?.statedLines === 21);
    check("A: candidate's estimatedBytesLost uses the calibrated rate (21 * 130)",
      out[0]?.estimatedBytesLost === 21 * PASTE_LOSS_CALIBRATED_BYTES_PER_LINE);
  }

  // --- B: EXPLAINED by the CURRENT gen's own entry — this is a real fresh collapse, but it's the
  // EXISTING detectBarePastePlaceholderTripwire's own case (full-text compare, already gen-safe, already
  // recovered) — this NEW check must stay silent to avoid a duplicate alarm. ---
  {
    const history = [entry(5, "line1\nline2\nline3")]; // 2 newlines -> candidate line counts [2, 3]
    const out = detectPastePlaceholderLengthLoss("[Pasted text #7 +3 lines]", null, history);
    check("B: placeholder explained by the CURRENT gen's own written text → no candidate (owned elsewhere)", out.length === 0);
  }

  // --- C: EXPLAINED by an OLDER gen's entry — the abeac33a stale-token-ghost shape (a CLI-side re-render
  // of an already-delivered EARLIER turn's own placeholder into a later, unrelated, correctly-delivered
  // turn). Constructed to mirror the real +342 specimen's own numbers. ---
  {
    const kickoffText = Array.from({ length: 342 }, (_, i) => `line ${i}`).join("\n"); // 341 newlines -> candidates [341, 342]
    const history = [entry(1, kickoffText)];
    const out = detectPastePlaceholderLengthLoss("[Pasted text #1 +342 lines]", null, history);
    check("C: placeholder explained by an OLDER gen's already-delivered text (abeac33a shape) → no candidate", out.length === 0);
  }

  // --- D: genuinely UNEXPLAINED even with a non-empty history — it has entries, but none of them has
  // a line count matching the placeholder's stated M. ---
  {
    const history = [entry(1, "a\nb")]; // 1 newline -> candidates [1, 2]
    const out = detectPastePlaceholderLengthLoss("[Pasted text #9 +50 lines]", null, history);
    check("D: placeholder NOT matching any history entry's line count → fires (unexplained)", out.length === 1 && out[0]?.statedLines === 50);
  }

  // --- E: a placeholder with NO stated count ("[Pasted text #3]" alone) can't be calibrated — skipped,
  // never reported (mirrors isBarePastedTextPlaceholder's own bare-token acceptance, but this NEW check
  // has nothing to compare a byte estimate against). ---
  {
    const out = detectPastePlaceholderLengthLoss("[Pasted text #3]", null, []);
    check("E: placeholder with no stated line count → no candidate (uncalibratable)", out.length === 0);
  }

  // --- F: false-positive guard — the placeholder-shaped substring is ALSO present verbatim in what was
  // actually typed/submitted (discussing the bug, quoting the phrase) — must not fire even though the
  // history doesn't explain it (mirrors detectBarePastePlaceholderTripwire's own established guard). ---
  {
    const text = "quoting: [Pasted text #4 +5 lines] end";
    const out = detectPastePlaceholderLengthLoss(text, text, []);
    check("F: token also present verbatim in submittedText (typed, not collapsed) → no candidate", out.length === 0);
  }

  // --- G: multiple placeholders in one recorded text — one explained, one not — only the unexplained one
  // is reported. ---
  {
    const history = [entry(2, "x\ny")]; // 1 newline -> candidates [1, 2]
    const recorded = "[Pasted text #1 +2 lines] and also [Pasted text #2 +99 lines]";
    const out = detectPastePlaceholderLengthLoss(recorded, null, history);
    check("G: mixed explained/unexplained placeholders → exactly the unexplained one reported", out.length === 1 && out[0]?.placeholderNum === 2 && out[0]?.statedLines === 99);
  }

  // --- J: THE ROTATED-OUT CASE, at the pure-function level — an explaining entry that is simply ABSENT
  // from the array passed in (mirroring what host.ts's bounded history looks like once eviction has
  // happened) reads as unexplained, same as D. Part 3 below proves this is what REAL eviction at
  // PASTE_LOSS_EXPLAIN_WINDOW actually produces, end-to-end through PtyHost. ---
  {
    const history = [entry(1, "x\ny\nz")]; // 2 newlines -> candidates [2, 3]; does NOT explain 42
    const out = detectPastePlaceholderLengthLoss("[Pasted text #1 +42 lines]", null, history);
    check("J: an explaining entry's ABSENCE from the history (what eviction produces) → fires, not silent", out.length === 1 && out[0]?.statedLines === 42);
  }

  // --- H/I: no placeholder at all, or no recorded text — no candidates. ---
  check("H: ordinary prose, no placeholder → no candidate", detectPastePlaceholderLengthLoss("just a normal message", null, []).length === 0);
  check("I: missing recorded text → no candidate", detectPastePlaceholderLengthLoss(null, null, []).length === 0);
  check("I: missing recorded text (undefined) → no candidate", detectPastePlaceholderLengthLoss(undefined, null, []).length === 0);
}

// ===================== PART 2 — PtyHost (fake pty, no real claude, no daemon) =====================

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, pid: 4321, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}

const lossEvents = [];
const events = {
  onEngineSessionId() {},
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
  onPasteLengthLoss(sessionId, candidate) { lossEvents.push({ sessionId, candidate }); },
};

const host = new TestPtyHost(events);
const SID = "sess-pll";
const ENGINE_ID = "engine-pll-1";
const cwd = path.join(os.tmpdir(), `loom-pll-cwd-${Date.now()}-${process.pid}`);
const transcriptDir = path.dirname(engineTranscriptPath(cwd, ENGINE_ID));
fs.mkdirSync(transcriptDir, { recursive: true });
const writeTranscript = (lines) =>
  fs.writeFileSync(engineTranscriptPath(cwd, ENGINE_ID), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const errLog = [];
const realError = console.error;
console.error = (...args) => { errLog.push(args.join(" ")); };

const USAGE = { input_tokens: 100, output_tokens: 10 };

host.spawn({
  sessionId: SID, cwd,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];

async function submitAndStop(submittedText, recordedUserText) {
  const before = lossEvents.length;
  const rp = host.enqueueStdin(SID, submittedText);
  if (!rp.delivered) throw new Error(`test setup: turn did not submit immediately (${JSON.stringify(rp)})`);
  await sleep(120);
  writeTranscript([
    { type: "user", message: { content: recordedUserText } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  return lossEvents.length - before;
}

// Scenario (2) deliberately trips the EXISTING detectBarePastePlaceholderTripwire too (that's the point
// — proving the NEW detector doesn't duplicate its alarm), which schedules a one-shot recovery
// re-injection via setTimeout(0) (see host.ts). That recovery is still in flight (busy) when this
// function returns — mirrors paste-placeholder-tripwire.mjs's own drainRecoveryIfAny — so it must be
// resolved cleanly before any LATER scenario's enqueueStdin, or that later call queues instead of
// delivering immediately (a session-busy false failure unrelated to what that scenario means to test).
async function drainRecovery() {
  await sleep(250); // let the recovery's own setTimeout(0) actually run its submit()
  await sleep(120);
  writeTranscript([
    { type: "user", message: { content: "recovered content resolved cleanly (test helper auto-drain)" } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
}

try {
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_ID });
  check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

  // (1) POSITIVE — NEW coverage the OLD detector cannot provide: a SHORT single-line submit (the OLD
  // tripwire's own collapse-plausibility gate rejects this outright — see paste-placeholder-tripwire.mjs
  // scenario (d)) whose recorded turn nonetheless carries a CALIBRATED placeholder (`+M lines`, unlike
  // scenario (d)'s bare one) that no ring entry can explain. Loom wrote "hi" this turn (0 newlines,
  // candidates [0,1]) — nowhere near the stated 21 lines.
  {
    const delta = await submitAndStop("hi", "[Pasted text #9 +21 lines]");
    check("(1) POSITIVE: unexplained calibrated placeholder on a short submit fires onPasteLengthLoss exactly once", delta === 1);
    const last = lossEvents[lossEvents.length - 1];
    check("(1) the event carries the right session id and stated line count", last?.sessionId === SID && last?.candidate?.statedLines === 21);
    check("(1) a LOUD [paste-length-loss] line was logged (console.error, not just console.warn)",
      errLog.some((l) => l.includes("[paste-length-loss]") && l.includes(SID) && l.includes("UNEXPLAINED")));
  }

  // (2) NEGATIVE — explained by the CURRENT gen: a real long/multi-line paste collapses to a placeholder
  // stating exactly ITS OWN line count. This is the EXISTING detectBarePastePlaceholderTripwire's own
  // case (submittedText is long/multiline, so its gate passes) — the NEW detector must not ALSO fire a
  // duplicate alarm for the same event.
  {
    const longPaste = "line one\nline two\nline three"; // 2 newlines -> candidates [2, 3]
    const delta = await submitAndStop(longPaste, "[Pasted text #5 +3 lines]");
    check("(2) NEGATIVE: placeholder explained by the CURRENT gen's own submission → onPasteLengthLoss does NOT fire", delta === 0);
    await drainRecovery(); // this scenario deliberately tripped the OLD tripwire too — drain its recovery before scenario (3)
  }

  // (3) NEGATIVE — explained by an OLDER gen (abeac33a stale-token-ghost shape): turn A delivers a real
  // multi-line paste CLEANLY (recorded text is the full content, no placeholder — nothing to detect on
  // its own turn). Turn B, later, is a short unrelated submit whose recorded text carries a STALE
  // placeholder token claiming turn A's own line count — a CLI-side re-render ghost, not a fresh loss.
  {
    const turnAText = "alpha\nbeta\ngamma\ndelta"; // 3 newlines -> candidates [3, 4]
    const cleanDelta = await submitAndStop(turnAText, turnAText); // resolves cleanly, no placeholder at all
    check("(3) setup: turn A resolves cleanly with no placeholder (nothing for either detector to catch)", cleanDelta === 0);

    const staleDelta = await submitAndStop("next thing", "[Pasted text #1 +4 lines]");
    check("(3) NEGATIVE: stale placeholder matching an OLDER gen's already-delivered content → onPasteLengthLoss does NOT fire", staleDelta === 0);
  }

  // (4) NEGATIVE control, restated end-to-end: an ordinary short turn with a bare (uncalibratable)
  // placeholder readback (mirrors paste-placeholder-tripwire.mjs's own scenario (d)) — neither detector
  // fires. Confirms this suite's own instrument can still read a TRUE zero, not just a vacuous one.
  {
    const delta = await submitAndStop("hi again", "[Pasted text #10]");
    check("(4) NEGATIVE CONTROL: bare placeholder with no stated count → onPasteLengthLoss does NOT fire", delta === 0);
  }

  // ===================== PART 3 — THE ROTATED-OUT CASE (Code Review, card b68d1f5b) =====================
  // Manager's own gap: silence above is guaranteed ONLY for an explaining write still WITHIN
  // PASTE_LOSS_EXPLAIN_WINDOW. This scenario proves BOTH sides of that bound, on a FRESH session (its own
  // Live, its own empty history — no interference from scenarios 1-4's leftover ring entries above): a
  // stale token explained by a write still inside the window stays SILENT (same shape as scenario 3), and
  // the SAME stale token, once its explaining write has been pushed PASTE_LOSS_EXPLAIN_WINDOW submissions
  // into the past, FIRES — the documented residual, not a regression.
  {
    const SID2 = "sess-pll-evict";
    const ENGINE_ID2 = "engine-pll-evict-1";
    const cwd2 = path.join(os.tmpdir(), `loom-pll-evict-cwd-${randomUUID()}`);
    const transcriptDir2 = path.dirname(engineTranscriptPath(cwd2, ENGINE_ID2));
    fs.mkdirSync(transcriptDir2, { recursive: true });
    const writeTranscript2 = (lines) =>
      fs.writeFileSync(engineTranscriptPath(cwd2, ENGINE_ID2), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    host.spawn({
      sessionId: SID2, cwd: cwd2,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
    host.deliverHook(SID2, { hook_event_name: "SessionStart", session_id: ENGINE_ID2 });

    async function submitAndStop2(submittedText, recordedUserText) {
      const before = lossEvents.length;
      const rp = host.enqueueStdin(SID2, submittedText);
      if (!rp.delivered) throw new Error(`test setup: turn did not submit immediately (${JSON.stringify(rp)})`);
      await sleep(60);
      writeTranscript2([
        { type: "user", message: { content: recordedUserText } },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
      ]);
      host.deliverHook(SID2, { hook_event_name: "Stop" });
      return lossEvents.length - before;
    }

    // Fast, sleep-free filler turn (mirrors pty-composer-accumulation.mjs's own no-sleep `cleanTurn`
    // helper — hook delivery is synchronous, so no real wait is needed to keep the fake-pty harness
    // deterministic): resolves CLEANLY (recorded text === submitted text, no placeholder), so it can never
    // itself trip either detector — purely here to advance `gen` and push a harmless entry into the ring.
    function fastCleanTurn(text) {
      const rp = host.enqueueStdin(SID2, text);
      if (!rp.delivered) throw new Error(`fastCleanTurn: did not deliver immediately (${JSON.stringify(rp)})`);
      writeTranscript2([
        { type: "user", message: { content: text } },
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
      ]);
      host.deliverHook(SID2, { hook_event_name: "Stop" });
    }

    const explainText = Array.from({ length: 11 }, (_, i) => `explain line ${i}`).join("\n"); // 10 newlines -> candidates [10, 11]
    const cleanDelta = await submitAndStop2(explainText, explainText); // gen=1: the explaining write, resolved cleanly
    check("(5) setup: the explaining write resolves cleanly (gen=1, candidates [10,11])", cleanDelta === 0);

    const withinWindowDelta = await submitAndStop2("filler check A", "[Pasted text #1 +11 lines]"); // gen=2
    check("(5) WITHIN WINDOW: a stale +11 token, explaining write only 1 gen old → onPasteLengthLoss stays SILENT", withinWindowDelta === 0);

    // Push PASTE_LOSS_EXPLAIN_WINDOW more Loom-authored submissions — gen=1 (and gen=2) are now more than
    // PASTE_LOSS_EXPLAIN_WINDOW generations in the past, so the ring (capped at that window) no longer
    // holds either of them.
    for (let i = 0; i < PASTE_LOSS_EXPLAIN_WINDOW; i++) fastCleanTurn(`filler ${i}`);

    const rotatedOutDelta = await submitAndStop2("filler check B", "[Pasted text #1 +11 lines]");
    check(`(5) ROTATED OUT (the manager's own gap): the SAME stale +11 token, explaining write now ${PASTE_LOSS_EXPLAIN_WINDOW + 1} gens old → onPasteLengthLoss FIRES — the documented residual, not silence`,
      rotatedOutDelta === 1);
    const lastEvict = lossEvents[lossEvents.length - 1];
    check("(5) the rotated-out event still carries the correct stated line count", lastEvict?.sessionId === SID2 && lastEvict?.candidate?.statedLines === 11);

    try { host.stop(SID2, "hard"); } catch { /* ignore */ }
    try { fs.rmSync(transcriptDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(cwd2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
} finally {
  console.error = realError;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — detectPastePlaceholderLengthLoss (card b68d1f5b DoD-1) fires ONLY on a placeholder no known Loom write explains, calibrated at ~130 B/line, and stays silent when the history explains it at either the CURRENT gen (owned by the existing tripwire) or an OLDER gen within PASTE_LOSS_EXPLAIN_WINDOW (a stale CLI-side re-render, card abeac33a) — proving coverage the submittedText-gated detector structurally cannot provide, without duplicating its alarms. Part 3 proves the window's own documented bound is real: the SAME stale token stays silent while its explaining write is inside the window and FIRES once it rotates out — the honestly-stated residual, not a hidden gap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
