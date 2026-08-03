// Bare-pasted-text-placeholder tripwire test (card eef4883c originally; card 0f9268cc adds recovery).
// HERMETIC — no daemon, no real claude.
//
// Background: 8a39f544 investigated owner pastes over the Companion silently arriving as a bare
// `[Pasted text #N +M lines]` placeholder and traced it to a transient UPSTREAM claude CLI race
// (v2.1.212, fixed by 2.1.215) — NOT a Loom write-path defect. Card 0f9268cc confirmed a DIFFERENT
// recurrence (2.1.217, past that "fix") and, after ruling out prevention (see host.ts's Stop-hook comment
// for why), added a one-shot automatic RECOVERY on top of detection.
//
// PART 1 (pure): paste-tripwire.ts's detectBarePastePlaceholderTripwire (+ its named helpers), the
// recovery text builder/recognizer, and context.ts's readContextStats.lastUserText extraction (string
// content, array-of-text-blocks content, tool_result-only skip, image-only-no-text no-op).
// PART 2 (PtyHost, fake pty via the createPty() seam — no real claude, no daemon, no network): drives a
// real submit()->Stop cycle and asserts the tripwire's console.warn fires ONLY on a real placeholder
// collapse — via EITHER delivery channel (structured submit() or a raw-terminal writeStdin Enter-submit,
// card 0f9268cc) — never on (a) a normal short turn, (b) a paste that resolved to full text, or (c) a
// short single-line submit that coincidentally reads back placeholder-shaped (the CLI could never have
// collapsed it, so it must not trip). A placeholder EMBEDDED in other typed text now TRIPS (card 0f9268cc
// widened the match from whole-string-only) — see the former negative case, now positive.
// PART 3 (card 0f9268cc): the one-shot RECOVERY — a detected loss re-injects the original content as a
// corrective turn; a CLEAN resolution is a quiet no-op; a SECOND collapse (on the recovery itself)
// escalates instead of chaining a second recovery attempt (the loop-safety proof).
//
// RUN (no daemon needed): node test/paste-placeholder-tripwire.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 1addef27 (fixed-wait-negative-guard): bounded POLL on the actual completion signal, not a fixed
// clock — mirrors dev-server.mjs's own `waitUntil`. Used ONLY where a negative-polarity assertion needs
// to know a write genuinely happened (positive signal) before inspecting its content, so a too-short
// window fails loudly (timeout) instead of passing vacuously on the negative check for the wrong reason.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE any
// dynamic import of a dist/ module — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-ppt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { readContextStats } = await import("../dist/sessions/context.js");
const {
  detectBarePastePlaceholderTripwire, couldCliCollapseToPlaceholder, isBarePastedTextPlaceholder,
  isPasteRecoveryAttempt, buildPasteRecoveryText, PASTE_RECOVERY_TAG,
} = await import("../dist/orchestration/paste-tripwire.js");
const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const USAGE = { input_tokens: 100, output_tokens: 10 };

// ============================ PART 1 — pure (no pty, no daemon) ============================

{
  // --- couldCliCollapseToPlaceholder: short single-line never collapses; multi-line or long single-line could ---
  check("collapse-guard: a short single-line submit could NOT have collapsed", couldCliCollapseToPlaceholder("hi") === false);
  check("collapse-guard: a two-line submit COULD have collapsed", couldCliCollapseToPlaceholder("line one\nline two") === true);
  check("collapse-guard: a long (>=200 char) single-line submit COULD have collapsed",
    couldCliCollapseToPlaceholder("x".repeat(200)) === true);
  check("collapse-guard: a 199-char single-line submit could NOT have collapsed (boundary)",
    couldCliCollapseToPlaceholder("x".repeat(199)) === false);

  // --- isBarePastedTextPlaceholder: whole-string OR embedded (card 0f9268cc widened this) ---
  check("placeholder-match: bare '[Pasted text #3]' matches", isBarePastedTextPlaceholder("[Pasted text #3]") === true);
  check("placeholder-match: bare '[Pasted text #12 +48 lines]' matches", isBarePastedTextPlaceholder("[Pasted text #12 +48 lines]") === true);
  check("placeholder-match: surrounding whitespace is trimmed and still matches", isBarePastedTextPlaceholder("  [Pasted text #1]\n") === true);
  check("placeholder-match: EMBEDDED in other text also matches (card 0f9268cc)",
    isBarePastedTextPlaceholder("Please review this: [Pasted text #4 +20 lines] Thanks!") === true);
  check("placeholder-match: ordinary prose does NOT match", isBarePastedTextPlaceholder("just a normal message") === false);
  check("placeholder-match: full resolved paste text does NOT match", isBarePastedTextPlaceholder("line one\nline two\nline three") === false);

  // --- detectBarePastePlaceholderTripwire: both conditions required ---
  check("tripwire: bare placeholder + long/multi-line submit → TRIPS",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "[Pasted text #2 +3 lines]") === true);
  check("tripwire: bare placeholder BUT submit was short/single-line → does NOT trip (condition 1 guard)",
    detectBarePastePlaceholderTripwire("hi", "[Pasted text #1]") === false);
  check("tripwire: long submit resolved to full text (no placeholder) → does NOT trip",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "a very long pasted block\nwith multiple lines\nof content") === false);
  check("tripwire: long submit, placeholder EMBEDDED in other recorded text → TRIPS (card 0f9268cc)",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "Here: [Pasted text #2 +3 lines] — thanks") === true);
  check("tripwire: missing submitted/recorded text → does NOT trip", detectBarePastePlaceholderTripwire(null, "[Pasted text #1]") === false);
  check("tripwire: missing recorded text → does NOT trip", detectBarePastePlaceholderTripwire("x".repeat(300), undefined) === false);

  // --- false-positive guard (card 0f9268cc, added after real-corpus validation): a placeholder-shaped
  // substring that's ALSO present verbatim in what was actually submitted/typed is authored prose about
  // the bug (e.g. a worker report quoting "[Pasted text #N]"), never a genuine CLI-generated collapse —
  // the token can't be both typed by the human/system AND CLI-generated in the same turn. Must not trip.
  {
    const discussingTheBug =
      "Following up on the paste-loss investigation: a real collapse looks like [Pasted text #7 +15 lines] " +
      "in the transcript, with nothing recoverable.\nSee card eef4883c for background.";
    check("tripwire: recorded placeholder ALSO present in what was actually typed → does NOT trip (false-positive guard)",
      detectBarePastePlaceholderTripwire(discussingTheBug, discussingTheBug) === false);
    check("tripwire: same shape, but recorded text quotes a DIFFERENT placeholder # than any in submittedText → still TRIPS",
      detectBarePastePlaceholderTripwire(discussingTheBug, "Here: [Pasted text #99 +2 lines] — different token, not typed") === true);
  }

  // --- recovery helpers (card 0f9268cc): pure, host-free ---
  check("recovery: buildPasteRecoveryText carries the recovery tag",
    buildPasteRecoveryText("the lost content").startsWith(PASTE_RECOVERY_TAG));
  check("recovery: buildPasteRecoveryText carries the ORIGINAL lost content verbatim",
    buildPasteRecoveryText("the lost content").includes("the lost content"));
  check("recovery: isPasteRecoveryAttempt recognizes a built recovery text",
    isPasteRecoveryAttempt(buildPasteRecoveryText("anything")) === true);
  check("recovery: isPasteRecoveryAttempt does NOT flag an ordinary (non-recovery) submitted turn",
    isPasteRecoveryAttempt("just a normal long paste\nwith multiple lines") === false);

  // --- claim-defect fix (card 4af5aefa): the detector only OBSERVES that the transcript recorded a
  // placeholder — it has no access to engine/recipient visibility, so the notice must not ASSERT
  // visibility as fact. "Lost ... before you could see it" is a categorical claim the evidence can't
  // support (two live false positives: Codescape mgr #19 and Loom mgr #91 both HAD seen and acted on
  // the resent content). The notice must instead state what was observed and hand the recipient a cheap
  // way to self-check, since a notice cannot see what the recipient already did.
  const recoveryTextSample = buildPasteRecoveryText("the lost content");
  check("recovery: does NOT assert the categorical 'before you could see it' claim (card 4af5aefa)",
    !recoveryTextSample.toLowerCase().includes("before you could see it"));
  check("recovery: states what was actually OBSERVED (a placeholder in the transcript), not a visibility claim",
    recoveryTextSample.includes("transcript recorded a placeholder"));
  check("recovery: asks the DISCRIMINATING question — does anything done SINCE assume this content, not merely 'did you already act' (card 2d36337e: a recipient can truthfully answer 'yes I acted' about a LATER message that built on this one, while never having seen this one)",
    /since.*assume|assume.*since/i.test(recoveryTextSample));
  check("recovery: still tells the recipient to check their OWN artifact for that answer (card 4af5aefa, wording sharpened by card 2d36337e)",
    /own artifact/i.test(recoveryTextSample) && /reply you sent|memory write|turn count/i.test(recoveryTextSample));

  // --- readContextStats.lastUserText: raw user-turn text extraction, folded into the single-pass scan ---
  const cwd = path.join(os.tmpdir(), `loom-ppt-txt-${Date.now()}-${process.pid}`);
  const dir = path.dirname(engineTranscriptPath(cwd, "seed"));
  fs.mkdirSync(dir, { recursive: true });
  const writeFixture = (id, lines) =>
    fs.writeFileSync(engineTranscriptPath(cwd, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    writeFixture("string-content", [
      { type: "user", message: { content: "[Pasted text #7 +9 lines]" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    check("lastUserText: plain string content is returned verbatim",
      readContextStats(cwd, "string-content")?.lastUserText === "[Pasted text #7 +9 lines]");

    writeFixture("array-content", [
      { type: "user", message: { content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    check("lastUserText: array-of-text-blocks content is joined",
      readContextStats(cwd, "array-content")?.lastUserText === "part one\npart two");

    writeFixture("toolresult-skip", [
      { type: "user", message: { content: "real submitted text" } },
      { type: "assistant", message: { content: [{ type: "text", text: "calling a tool" }], usage: USAGE } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "tool output here" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }], usage: USAGE } },
    ]);
    check("lastUserText: a tool_result-only user-role line is SKIPPED (last real user text survives)",
      readContextStats(cwd, "toolresult-skip")?.lastUserText === "real submitted text");

    writeFixture("image-only-noop", [
      { type: "user", message: { content: "real submitted text" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
      { type: "user", message: { content: [{ type: "image", source: {} }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok again" }], usage: USAGE } },
    ]);
    check("lastUserText: an image-only user line (no text block) contributes no update — prior text survives",
      readContextStats(cwd, "image-only-noop")?.lastUserText === "real submitted text");

    check("lastUserText: missing transcript → null (whole stats null, unchanged)", readContextStats(cwd, "no-such-id") === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

const events = {
  onEngineSessionId() {},
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-ppt";
const ENGINE_ID = "engine-ppt-1";
const cwd = path.join(os.tmpdir(), `loom-ppt-cwd-${Date.now()}-${process.pid}`);
const transcriptDir = path.dirname(engineTranscriptPath(cwd, ENGINE_ID));
fs.mkdirSync(transcriptDir, { recursive: true });
const writeTranscript = (lines) =>
  fs.writeFileSync(engineTranscriptPath(cwd, ENGINE_ID), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// Capture console.warn without silencing everything else (console.log for PASS/FAIL still shows).
const warnLog = [];
const realWarn = console.warn;
console.warn = (...args) => { warnLog.push(args.join(" ")); };

host.spawn({
  sessionId: SID, cwd,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];

// Low-level, single-turn primitive: submit `submittedText`, write a transcript recording
// `recordedUserText` as the turn's user-role entry, fire a clean Stop, and return how many NEW warnings
// this Stop produced. Does NOT touch any recovery cycle a positive detection schedules — Part 3's
// dedicated recovery tests use this directly for fine-grained control over that cycle.
async function runTurnRaw(submittedText, recordedUserText) {
  const before = warnLog.length;
  // Card 78a16dc5: enqueueStdin's default kind is "warning", which now logs (console.warn) an anomaly for
  // any untagged text — tag it here so that log doesn't pollute this test's own warnLog-delta assertions;
  // the length/line-count `submittedText` shape (what the collapse-guard cares about) is unaffected by a
  // short fixed prefix.
  const rp = host.enqueueStdin(SID, `[loom:test] ${submittedText}`);
  if (!rp.delivered) throw new Error(`test setup: turn did not submit immediately (${JSON.stringify(rp)})`);
  await sleep(120);
  writeTranscript([
    { type: "user", message: { content: recordedUserText } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  return warnLog.length - before;
}

// Card 0f9268cc: a genuine detection now schedules a one-shot recovery re-injection (setTimeout(0), see
// host.ts). Any caller whose Stop tripped (delta > 0) and doesn't itself want to inspect that cycle must
// drain it before moving on, or the still-in-flight recovery leaks into whatever test runs next (the
// exact failure this fixes: a queued recovery blocking the next test's immediate-delivery assumption).
async function drainRecoveryIfAny(delta) {
  if (delta <= 0) return;
  await sleep(250); // let the recovery's setTimeout(0) actually run its submit()
  await sleep(120);
  writeTranscript([
    { type: "user", message: { content: "recovered content resolved cleanly (test helper auto-drain)" } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
}

// None of Parts 1/2's callers ever submit recovery-tagged text, so a positive delta here ALWAYS means a
// recovery got scheduled — auto-drain it. Part 3 below uses `runTurnRaw` directly instead, so this
// auto-drain never interferes with what it wants to observe.
async function runTurn(submittedText, recordedUserText) {
  const delta = await runTurnRaw(submittedText, recordedUserText);
  await drainRecoveryIfAny(delta);
  return delta;
}

try {
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_ID });
  check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

  const longPaste = "line one of a long pasted block\n".repeat(3) + "final line";

  // (a) normal turn — recorded text matches what was submitted (short, ordinary).
  check("NEGATIVE (a) normal short turn: no tripwire warning", await runTurn("please check the build", "please check the build") === 0);

  // (b) a long/multi-line paste that resolved to FULL text (no collapse) — no tripwire.
  check("NEGATIVE (b) long paste resolved to full text: no tripwire warning", await runTurn(longPaste, longPaste) === 0);

  // (c) POSITIVE (card 0f9268cc, flipped from a negative) — a long/multi-line paste whose recorded text
  // EMBEDS a placeholder inside other typed text. A plain-textarea web composer makes this shape common
  // (typed instructions + a paste in the same message), and it loses exactly the same real content as a
  // bare placeholder does — so it must trip too now.
  check("POSITIVE (c) placeholder embedded in other text: trips the tripwire",
    await runTurn(longPaste, `Following up on: [Pasted text #5 +3 lines] — see above`) === 1);

  // (d) a SHORT single-line submit that happens to read back as placeholder-shaped text — the CLI could
  // never have collapsed this, so it must not trip (condition 1 guard).
  check("NEGATIVE (d) short single-line submit reading back placeholder-shaped: no tripwire warning",
    await runTurn("hi", "[Pasted text #9]") === 0);

  // (e) POSITIVE — a long/multi-line paste whose recorded transcript turn is NOTHING BUT the placeholder.
  const trips = await runTurn(longPaste, "[Pasted text #3 +3 lines]");
  check("POSITIVE: bare-placeholder turn trips the tripwire exactly once", trips === 1);
  check("POSITIVE: the warning names the session id and the card", warnLog.some((w) => w.includes(SID) && w.includes("eef4883c")));

  // (f) POSITIVE (card 0f9268cc) — the RAW-TERMINAL channel. Before this fix, a paste typed/pasted
  // directly into the terminal panel (writeStdin, never enqueueStdin/submit()) never touched
  // live.lastPrompt, so the tripwire was structurally blind to it regardless of what the CLI did. Drive
  // writeStdin directly: a bracketed-paste body (matching what xterm's own native paste sends), then an
  // Enter OUTSIDE the paste span to submit — mirroring nextRawDraftState's parsing model.
  {
    const before = warnLog.length;
    host.writeStdin(SID, `\x1b[200~${longPaste}\x1b[201~`); // paste body, still open (no Enter yet)
    host.writeStdin(SID, "\r"); // Enter OUTSIDE the paste span — the actual submit
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "[Pasted text #6 +3 lines]" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    const delta = warnLog.length - before;
    check("POSITIVE (f) raw-terminal paste collapsed to a bare placeholder: trips the tripwire", delta === 1);
    // This block drives writeStdin directly instead of the runTurn helper, so it must drain the scheduled
    // recovery itself — otherwise it leaks into the NEXT test exactly like an undrained runTurn call would.
    await drainRecoveryIfAny(delta);
  }

  // (g) NEGATIVE (card 0f9268cc) — a raw-terminal submit is CONSUMED by its own Stop and must not leak
  // into a LATER, unrelated structured-submit turn's comparison.
  check("NEGATIVE (g) raw-terminal baseline does not leak into the next unrelated turn",
    await runTurn("please check the build", "please check the build") === 0);

  // (h) NEGATIVE (card 0f9268cc, false-positive guard) — a message that literally QUOTES the placeholder
  // phrase while discussing this bug (the exact shape found 18 times, zero exceptions, scanning 18140 real
  // transcript turns) — resolves to FULL text (no actual collapse), so it must not trip even though the
  // recorded text embeds a placeholder-shaped substring.
  const discussingTheBug =
    "Following up on the paste-loss investigation: a real collapse looks like [Pasted text #7 +15 lines] " +
    "in the transcript, with nothing recoverable.\nSee card eef4883c for background.";
  check("NEGATIVE (h) message literally quoting the placeholder phrase, fully resolved: no tripwire warning",
    await runTurn(discussingTheBug, discussingTheBug) === 0);

  // ===================== PART 3 — one-shot RECOVERY (card 0f9268cc) =====================
  // A detected loss is no longer WARN-only: host.ts re-injects the original submitted text as a
  // corrective turn (deferred via setTimeout(0), outside the Stop-hook's M2 synchronous window). Verify
  // the recovery fires with the right content on a genuine loss (d — implicit: (a)/(b)/(h) above already
  // proved a NORMAL turn produces no warning, and no warning means no recovery scheduling is even reached
  // — the same `if` gates both), that a CLEANLY-resolved recovery is a quiet no-op, and that a SECOND
  // collapse (on the recovery itself) escalates instead of chaining a second recovery attempt (no loop).

  // (i) RECOVERY-SUCCESS: an original loss triggers exactly one corrective re-injection carrying the
  // recovery tag + the ORIGINAL lost content; when that recovery resolves cleanly, no further action.
  {
    const writesBefore = fake.writes.length;
    const trips = await runTurnRaw(longPaste, "[Pasted text #11 +3 lines]");
    check("RECOVERY (i): detection still trips on the original loss", trips === 1);
    await sleep(250); // let the setTimeout(0) recovery scheduling actually run its submit()
    const recoveryWrite = fake.writes.slice(writesBefore).join("");
    check("RECOVERY (i): a corrective turn was written to the pty, carrying the recovery tag",
      recoveryWrite.includes("[loom:paste-recovery]"));
    check("RECOVERY (i): the corrective turn carries the ORIGINAL lost content",
      recoveryWrite.includes("line one of a long pasted block"));

    // The recovery turn is now in flight (its own submit() armed busy). Resolve it CLEANLY (full text
    // recorded, no second collapse) — the common case, and it must produce no further warnings/writes.
    const beforeWarn2 = warnLog.length;
    const writesBefore2 = fake.writes.length;
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "the recovered content came through fine this time" } },
      { type: "assistant", message: { content: [{ type: "text", text: "got it" }], usage: USAGE } },
    ]);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("RECOVERY (i): a CLEANLY-resolved recovery produces no further tripwire warning",
      warnLog.length - beforeWarn2 === 0);
    check("RECOVERY (i): a cleanly-resolved recovery schedules no further corrective turn (no new pty writes)",
      fake.writes.length === writesBefore2);
  }

  // (k) RECOVERY-ESCALATE, the loop-safety proof: the RECOVERY re-injection ITSELF collapses. Must NOT
  // chain a second recovery attempt — must escalate instead. This is the one-shot bound: `submittedText`
  // for the recovery turn carries PASTE_RECOVERY_TAG, so `isPasteRecoveryAttempt` recognizes it and the
  // host.ts call site takes the escalate branch rather than scheduling another setTimeout/enqueueStdin.
  {
    const longPaste2 = "second scenario line\n".repeat(4) + "final line two";
    const writesBefore = fake.writes.length;
    const trips = await runTurnRaw(longPaste2, "[Pasted text #22 +5 lines]");
    check("RECOVERY (k): detection trips on the original loss", trips === 1);
    await sleep(250); // let the recovery's own setTimeout(0) submit() run
    const recoveryWrite = fake.writes.slice(writesBefore).join("");
    check("RECOVERY (k): the corrective turn was written, carrying the recovery tag",
      recoveryWrite.includes("[loom:paste-recovery]"));

    // Now the RECOVERY turn itself collapses — record ANOTHER bare placeholder for it.
    const beforeWarn2 = warnLog.length;
    const writesBeforeEscalate = fake.writes.length;
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "[Pasted text #23 +9 lines]" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(250); // give a (wrongly-chained) second recovery every chance to fire if the bound failed
    const newWarnings = warnLog.slice(beforeWarn2);
    check("RECOVERY (k): exactly one new warning fires for the recovery's own collapse", newWarnings.length === 1);
    check("RECOVERY (k): that warning is the ESCALATION, not a normal detection re-log",
      newWarnings[0]?.includes("ALSO collapsed"));
    check("RECOVERY (k): NO third corrective turn is written — the one-shot bound holds (no infinite loop)",
      fake.writes.length === writesBeforeEscalate);
  }
  // (l) card 78e4b3f2 REGRESSION GUARD, RED-FIRST: the recovery re-injection ITSELF can be a genuine
  // physical RE-DELIVERY — an in-session give-up requeue that redrained marks its text
  // `[loom:possible-duplicate root:...]` AHEAD of its own PASTE_RECOVERY_TAG (see framePossibleDuplicate's
  // own doc, pty/host.ts; the give-up-family suite already covers HOW a message gets marked — this isolates
  // the ONE thing in question here: does the Stop-hook's tripwire logic still recognize a MARKED recovery
  // text as a recovery attempt). Before the fix, `isPasteRecoveryAttempt` read `live.lastPrompt` RAW, so the
  // tag sitting in front of PASTE_RECOVERY_TAG defeated the `startsWith` check — this Stop would wrongly
  // treat a marked recovery's own collapse as an ORIGINAL loss and schedule a SECOND corrective
  // re-injection instead of escalating, defeating the one-shot bound.
  {
    const originalLostContent = "line one of a long pasted block\nline two\nfinal line l-scenario";
    const recoveryText = buildPasteRecoveryText(originalLostContent);
    const markedRecoveryText = framePossibleDuplicate(recoveryText, "deadbeef");
    check("(l) setup: the marked text carries the possible-duplicate tag AHEAD of the recovery tag",
      markedRecoveryText.startsWith("[loom:possible-duplicate root:") && !markedRecoveryText.startsWith(PASTE_RECOVERY_TAG));

    const rp = host.enqueueStdin(SID, markedRecoveryText);
    if (!rp.delivered) throw new Error(`test setup: marked recovery turn did not submit immediately (${JSON.stringify(rp)})`);
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "[Pasted text #77 +2 lines]" } }, // THIS recovery attempt ALSO collapsed
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    const beforeWarn = warnLog.length;
    const writesBeforeStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(250); // give a (wrongly-chained) second recovery every chance to fire if this regressed
    const newWarnings = warnLog.slice(beforeWarn);
    check("(l) THE FIX: exactly one new warning fires for this collapse", newWarnings.length === 1);
    check("(l) THE FIX: a MARKED recovery text's own collapse is recognized as a recovery attempt — ESCALATES, never treated as a fresh loss",
      newWarnings[0]?.includes("ALSO collapsed"));
    check("(l) THE FIX: NO further corrective turn is written for a marked recovery's own collapse (one-shot bound holds through the tag)",
      fake.writes.length === writesBeforeStop);
  }

  // (m) STALENESS ANNOTATION (card 4af5aefa): the actual live specimen was minted CORRECTLY (its content
  // genuinely was the most recent inbound at detection time) but delivered ~293s and TWO genuine
  // intervening turns later, by which point a newer message had superseded it — reconstructed from real
  // production log timestamps, not a repro. The fix does not suppress or reorder anything (that would
  // recreate the same "acting on a proxy for engine visibility" defect one level up) — it annotates the
  // delivered text with a fact we DO genuinely observe: how many turns ran since mint.
  {
    // Reproduce the real ordering: the collapsing turn is dispatched (delivered immediately, session goes
    // busy), and a SECOND, unrelated message is enqueued WHILE busy — so it's already sitting in
    // `live.pending` ahead of the recovery mint's own setTimeout(0), exactly like the real specimen's
    // already-queued worker-report that drained ahead of the recovery.
    const longPaste3 = "third scenario line\n".repeat(4) + "final line three";
    const rp = host.enqueueStdin(SID, `[loom:test] ${longPaste3}`);
    if (!rp.delivered) throw new Error("test setup: collapsing turn did not submit immediately");
    const nextRp = host.enqueueStdin(SID, "[loom:test] an unrelated already-queued message");
    check("(m) setup: the next message queues (HELD) while the collapsing turn is in flight",
      nextRp.queued === true && nextRp.delivered === false);

    const beforeWarn = warnLog.length;
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "[Pasted text #33 +7 lines]" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    const writesBeforeStop = fake.writes.length;
    // Trips the tripwire and mints the recovery (setTimeout(0)); THIS Stop's own synchronous drain then
    // dispatches the already-queued unrelated message as the NEXT turn — before the recovery mint's own
    // enqueue ever runs, so the recovery finds the session busy and gets HELD.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(m) detection trips on the collapse", warnLog.length - beforeWarn === 1);

    await sleep(10);
    const drainedUnrelated = fake.writes.slice(writesBeforeStop).join("");
    check("(m) the already-queued unrelated message drains as the NEXT turn, ahead of the recovery mint",
      drainedUnrelated.includes("an unrelated already-queued message"));
    check("(m) the recovery notice is NOT part of that same write (it was minted too late to join it)",
      !drainedUnrelated.includes(PASTE_RECOVERY_TAG));

    await sleep(250); // let the recovery's own setTimeout(0) run — it finds the session busy → HELD onto pending

    // Complete the ONE intervening (unrelated) turn. This Stop's own drain then pops the recovery notice —
    // the only thing left queued — as the NEXT turn, exactly ONE turn (this one) after mint.
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "an unrelated already-queued message" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    const writesBeforeRecoveryDrain = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" });
    await sleep(10);
    const recoveryWrite = fake.writes.slice(writesBeforeRecoveryDrain).join("");

    check("(m) THE FIX: the delivered recovery still carries the recovery tag", recoveryWrite.includes(PASTE_RECOVERY_TAG));
    check("(m) THE FIX: the delivered recovery still carries the ORIGINAL lost content (annotation never drops it)",
      recoveryWrite.includes("third scenario line"));
    check("(m) THE FIX: delivered exactly 1 generation after mint — the text discloses that age, not silence",
      /1 submit generation ago/.test(recoveryWrite));
    check("(m) THE FIX: the age note names an EARLIER message, not the recipient's most recent one",
      /not your most recent/i.test(recoveryWrite));
    check("(m) THE FIX (card 2d36337e), under the REAL Stop-hook detection path (not a hand-fed generation number): the delivered recovery ALSO discloses the absolute original-send time — a relative generation count alone can't tell the recipient whether this predates a SPECIFIC later message they've already read",
      /Originally sent at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(recoveryWrite));

    // That delivered recovery turn is now in flight (busy). Resolve it CLEANLY (not a further collapse)
    // before the next scenario, or the next enqueue below won't deliver immediately.
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "the recovered content came through fine this time" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    host.deliverHook(SID, { hook_event_name: "Stop" });

    // Negative control: an ORDINARY delivery with ZERO intervening turns carries NO age annotation —
    // confirms this isn't just always-on boilerplate.
    const cleanPaste = "clean scenario line\n".repeat(4) + "final clean line";
    const rp2 = host.enqueueStdin(SID, `[loom:test] ${cleanPaste}`);
    if (!rp2.delivered) throw new Error("test setup: clean collapsing turn did not submit immediately");
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "[Pasted text #44 +5 lines]" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    const writesBeforeCleanMint = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" }); // nothing else queued → the recovery mint delivers IMMEDIATELY, zero turns later
    // Wait on the delivery signal itself (the recovery's setTimeout(0) mint actually landing a write),
    // never a fixed clock — a too-short fixed wait would let the negative conjunct below pass for the
    // WRONG reason (not-yet-written, not genuinely absent). The positive conjunct (tag present) still
    // anchors this against a vacuous pass; this poll additionally makes the wait itself sound.
    const cleanRecoveryLanded = await waitUntil(() => fake.writes.length > writesBeforeCleanMint);
    const cleanRecoveryWrite = fake.writes.slice(writesBeforeCleanMint).join("");
    check("(m) NEGATIVE CONTROL setup: the recovery genuinely landed a write before this control inspects it", cleanRecoveryLanded);
    check("(m) NEGATIVE CONTROL: a recovery delivered with ZERO intervening generations carries NO age annotation",
      cleanRecoveryWrite.includes(PASTE_RECOVERY_TAG) && !/generation(s)? ago/.test(cleanRecoveryWrite));
    await drainRecoveryIfAny(1); // this mint was itself a fresh loss — resolve it cleanly so it can't leak into anything after
  }

  // (n) CODE REVIEW FIX, RED-FIRST (card 4af5aefa): a recovery notice that itself GIVES UP once and
  // REDRAINS arrives at `joinSubmittedText` PREFIXED with a possible-duplicate frame
  // (`[loom:possible-duplicate root:…] `) — `annotatePasteRecoveryAge`'s tag check must see PAST that
  // frame, or exactly the notices whose age is largest (a give-up hold adds minutes on top of the
  // ordinary queue wait) get NO disclosure at all, which is this fix failing in its own motivating case.
  // Drives this directly at the pure-function level (Part 1 already established `framePossibleDuplicate`
  // ordering; this isolates the ONE thing in question: does annotation still fire on FRAMED text, and
  // does the original possible-duplicate frame survive verbatim).
  {
    const original = buildPasteRecoveryText("some lost content here");
    const framed = framePossibleDuplicate(original, "cafebabe");
    check("(n) setup: the framed text carries the possible-duplicate tag AHEAD of the recovery tag (mirrors (l))",
      framed.startsWith("[loom:possible-duplicate root:") && !framed.startsWith(PASTE_RECOVERY_TAG));

    // Exercise the SAME internal function the drain path calls, via the exported host module — mirror its
    // signature by round-tripping through a fresh single-element QueuedMessage-shaped drain. Since
    // `annotatePasteRecoveryAge`/`joinSubmittedText` aren't exported (internal to host.ts's drain
    // machinery), drive this through the SAME PtyHost seam Part 2 already uses: enqueue framed text with a
    // real generation gap, and inspect what actually gets written.
    const rp = host.enqueueStdin(SID, `[loom:test] setup for (n)`);
    if (!rp.delivered) throw new Error("test setup: (n) setup turn did not submit immediately");
    // Queue the ALREADY-FRAMED recovery text directly (simulating a give-up-redrained recovery) while busy.
    const heldRp = host.enqueueStdin(SID, framed, "system", undefined, undefined, "agent", undefined, undefined, undefined, undefined, undefined, undefined, randomUUID(), 0);
    check("(n) setup: the framed recovery queues (HELD) behind the in-flight setup turn",
      heldRp.queued === true && heldRp.delivered === false);
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "setup for (n)" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    // Enqueue ONE more unrelated turn (queues behind the framed recovery) so a genuine generation gap
    // exists by the time the framed recovery itself drains.
    const writesBeforeSetupStop = fake.writes.length;
    host.deliverHook(SID, { hook_event_name: "Stop" }); // drains the framed recovery next (mintedAtGen=0, currentGen now > 0)
    await sleep(10);
    const drainedFramed = fake.writes.slice(writesBeforeSetupStop).join("");
    check("(n) THE FIX: a FRAMED recovery still carries its possible-duplicate frame verbatim",
      drainedFramed.includes("[loom:possible-duplicate root:"));
    check("(n) THE FIX: a FRAMED recovery still carries the recovery tag AFTER the frame",
      /\[loom:possible-duplicate root:[0-9a-f]{8}\] \[loom:paste-recovery\]/.test(drainedFramed));
    check("(n) THE FIX: a FRAMED recovery STILL gets the age annotation (this was the bug — it silently did NOT before)",
      /generation(s)? ago/.test(drainedFramed));
    check("(n) THE FIX: a FRAMED recovery still carries the original lost content",
      drainedFramed.includes("some lost content here"));
    // Resolve cleanly so nothing leaks into the finally-block teardown.
    await sleep(120);
    writeTranscript([
      { type: "user", message: { content: "(n) resolved cleanly" } },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
    ]);
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }
} finally {
  console.warn = realWarn;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the bare-pasted-text-placeholder tripwire fires when a long/multi-line submitted turn's recorded transcript text CONTAINS a `[Pasted text #N...]` placeholder (whole-string or embedded), over EITHER delivery channel (structured submit() or a raw-terminal writeStdin Enter-submit), and stays silent on a normal turn, a fully-resolved paste, a short submit that reads back placeholder-shaped, and a stale/consumed raw-terminal baseline leaking into a later unrelated turn. A detected loss now auto-recovers (one-shot corrective re-injection); a clean resolution is a quiet no-op, and a second collapse on the recovery itself escalates instead of looping."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
