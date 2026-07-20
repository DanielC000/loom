// Bare-pasted-text-placeholder tripwire test (card eef4883c). HERMETIC — no daemon, no real claude.
//
// Background: 8a39f544 investigated owner pastes over the Companion silently arriving as a bare
// `[Pasted text #N +M lines]` placeholder and traced it to a transient UPSTREAM claude CLI race
// (v2.1.212, fixed by 2.1.215) — NOT a Loom write-path defect. No write-mechanics fix was warranted;
// this card is DETECTION ONLY, so a future recurrence of the same class is LOGGED instead of silent.
//
// PART 1 (pure): paste-tripwire.ts's detectBarePastePlaceholderTripwire (+ its two named helpers) and
// context.ts's readContextStats.lastUserText extraction (string content, array-of-text-blocks content,
// tool_result-only skip, image-only-no-text no-op).
// PART 2 (PtyHost, fake pty via the createPty() seam — no real claude, no daemon, no network): drives a
// real submit()->Stop cycle and asserts the tripwire's console.warn fires ONLY on the bare-placeholder
// case, never on (a) a normal short turn, (b) a paste that resolved to full text, (c) a placeholder
// embedded in other text, or (d) a short single-line submit that coincidentally reads back placeholder-
// shaped (the CLI could never have collapsed it, so it must not trip).
//
// RUN (no daemon needed): node test/paste-placeholder-tripwire.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE any
// dynamic import of a dist/ module — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-ppt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { readContextStats } = await import("../dist/sessions/context.js");
const {
  detectBarePastePlaceholderTripwire, couldCliCollapseToPlaceholder, isBarePastedTextPlaceholder,
} = await import("../dist/orchestration/paste-tripwire.js");
const { PtyHost } = await import("../dist/pty/host.js");

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

  // --- isBarePastedTextPlaceholder: whole-string match only ---
  check("placeholder-match: bare '[Pasted text #3]' matches", isBarePastedTextPlaceholder("[Pasted text #3]") === true);
  check("placeholder-match: bare '[Pasted text #12 +48 lines]' matches", isBarePastedTextPlaceholder("[Pasted text #12 +48 lines]") === true);
  check("placeholder-match: surrounding whitespace is trimmed and still matches", isBarePastedTextPlaceholder("  [Pasted text #1]\n") === true);
  check("placeholder-match: EMBEDDED in other text does NOT match (whole-string only)",
    isBarePastedTextPlaceholder("Please review this: [Pasted text #4 +20 lines] Thanks!") === false);
  check("placeholder-match: ordinary prose does NOT match", isBarePastedTextPlaceholder("just a normal message") === false);
  check("placeholder-match: full resolved paste text does NOT match", isBarePastedTextPlaceholder("line one\nline two\nline three") === false);

  // --- detectBarePastePlaceholderTripwire: both conditions required ---
  check("tripwire: bare placeholder + long/multi-line submit → TRIPS",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "[Pasted text #2 +3 lines]") === true);
  check("tripwire: bare placeholder BUT submit was short/single-line → does NOT trip (condition 1 guard)",
    detectBarePastePlaceholderTripwire("hi", "[Pasted text #1]") === false);
  check("tripwire: long submit resolved to full text (no placeholder) → does NOT trip",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "a very long pasted block\nwith multiple lines\nof content") === false);
  check("tripwire: long submit, placeholder EMBEDDED in other recorded text → does NOT trip",
    detectBarePastePlaceholderTripwire("a very long pasted block\nwith multiple lines\nof content", "Here: [Pasted text #2 +3 lines] — thanks") === false);
  check("tripwire: missing submitted/recorded text → does NOT trip", detectBarePastePlaceholderTripwire(null, "[Pasted text #1]") === false);
  check("tripwire: missing recorded text → does NOT trip", detectBarePastePlaceholderTripwire("x".repeat(300), undefined) === false);

  // --- readContextStats.lastUserText: raw user-turn text extraction, folded into the single-pass scan ---
  const cwd = path.join(os.tmpdir(), `loom-ppt-txt-${Date.now()}`);
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
function makeFakePty() {
  const writes = [];
  const fake = {
    pid: 4321,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
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
const cwd = path.join(os.tmpdir(), `loom-ppt-cwd-${Date.now()}`);
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

// One helper per scenario: submit `submittedText`, write a transcript recording `recordedUserText` as
// the turn's user-role entry, fire a clean Stop, and return how many NEW warnings this Stop produced.
async function runTurn(submittedText, recordedUserText) {
  const before = warnLog.length;
  const rp = host.enqueueStdin(SID, submittedText);
  if (!rp.delivered) throw new Error(`test setup: turn did not submit immediately (${JSON.stringify(rp)})`);
  await sleep(120);
  writeTranscript([
    { type: "user", message: { content: recordedUserText } },
    { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  return warnLog.length - before;
}

try {
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_ID });
  check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

  const longPaste = "line one of a long pasted block\n".repeat(3) + "final line";

  // (a) normal turn — recorded text matches what was submitted (short, ordinary).
  check("NEGATIVE (a) normal short turn: no tripwire warning", await runTurn("please check the build", "please check the build") === 0);

  // (b) a long/multi-line paste that resolved to FULL text (no collapse) — no tripwire.
  check("NEGATIVE (b) long paste resolved to full text: no tripwire warning", await runTurn(longPaste, longPaste) === 0);

  // (c) a long/multi-line paste whose recorded text EMBEDS a placeholder inside other typed text — no tripwire.
  check("NEGATIVE (c) placeholder embedded in other text: no tripwire warning",
    await runTurn(longPaste, `Following up on: [Pasted text #5 +3 lines] — see above`) === 0);

  // (d) a SHORT single-line submit that happens to read back as placeholder-shaped text — the CLI could
  // never have collapsed this, so it must not trip (condition 1 guard).
  check("NEGATIVE (d) short single-line submit reading back placeholder-shaped: no tripwire warning",
    await runTurn("hi", "[Pasted text #9]") === 0);

  // (e) POSITIVE — a long/multi-line paste whose recorded transcript turn is NOTHING BUT the placeholder.
  const trips = await runTurn(longPaste, "[Pasted text #3 +3 lines]");
  check("POSITIVE: bare-placeholder turn trips the tripwire exactly once", trips === 1);
  check("POSITIVE: the warning names the session id and the card", warnLog.some((w) => w.includes(SID) && w.includes("eef4883c")));
} finally {
  console.warn = realWarn;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the bare-pasted-text-placeholder tripwire fires ONLY when a long/multi-line submitted turn's recorded transcript text is NOTHING BUT a `[Pasted text #N...]` placeholder, and stays silent on a normal turn, a fully-resolved paste, an embedded placeholder, and a short submit that reads back placeholder-shaped."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
