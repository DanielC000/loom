// Hermetic regression test for card 5d068eec — GIVE-UP RECOVERY's third, hook-independent corroboration
// signal (pty/host.ts `transcriptGrowthShowsTurnStarted`, consulted from `fireEnterAndVerify`'s give-up
// commit point, right after `awaitGiveUpConfirmSettle` reports `confirmed:false`).
//
// WHY A THIRD SIGNAL, DISTINCT FROM THE EXISTING OUTPUT DISCRIMINATOR: hook-relay.mjs posts the
// UserPromptSubmit/Stop hooks fire-and-forget, with NO retry — a dropped hook can leave a genuinely
// started turn with no confirming hook ever arriving at all, and no pty output either (a quiet model
// turn with no spinner/repaint chatter). Measured against a REAL claude engine (card 5d068eec's own
// record has the numbers + methodology): on a quiet host the session transcript gains the user's own
// turn record ~0.9-1.0s after this generation's first Enter write — comfortably inside the commit
// point's own ~3.9s distance from that same write — so checking the transcript catches a lost-hook case
// in time. Under real contention the transcript can grow too late (one real specimen: 6.3s) — a PARTIAL
// gain on that axis, with no wait of its own. CR round 2 Minor 1 correction: the pre-existing output
// discriminator does NOT itself terminally suppress (it falls through to the same hook recheck) — this
// check is the FIRST and ONLY path that terminally suppresses with no hook ever confirming anything, and
// it carries an accepted content-only-match residual (see the decision record's Accepted residual).
//
// NONE of these scenarios ever call `fake.emitOutput()` or deliver a confirming hook (except (l), which
// delivers a REAL Stop deliberately, AFTER suppression, to prove normal finalization still works) — so
// whatever happens elsewhere here is attributable to the transcript check alone.
//
// (a)-(k) below are a HERMETIC fake-pty suite (no real spawns): each scenario pre-creates a fake
// transcript JSONL at the EXACT path production code computes (`engineTranscriptPath`), waits for the
// OBSERVED first Enter write (never a guessed deadline — see `waitForCount`, shared with the sibling
// false-negative suite), then mutates (or doesn't) that file before the give-up chain's remaining
// attempts play out naturally. (e) also drives `host.reconcile()` to exercise `healIfStuck`.
//
// RED-before-GREEN (per this card's own DoD): verified by hand — temporarily reverting the new check's
// call site in host.ts and re-running this file sends scenario (a) RED on a real FAILED assertion
// (busy ends up false, not a timeout), not merely slower; the others stay GREEN throughout since they
// assert the UNCHANGED today's-behaviour outcome. (e) and (f) are additionally verified RED specifically
// against commit b23aa186 (this card's round-1 landing, before the CR round-2 Minor 2/3 fixes) — see the
// worker report for that run's output.
//
// RUN (no daemon needed): node test/pty-giveup-transcript-corroboration.mjs
//   Requires the daemon built first (reads ../dist/...): from packages/daemon, run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spin-wait (observe, don't guess — same discipline as pty-giveup-false-negative.mjs's own helper)
 *  until `getCount()` reaches `target`. */
async function waitForCount(getCount, target, timeoutMs = 5000) {
  const t0 = Date.now();
  while (getCount() < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForCount: timed out waiting for count to reach ${target} (stuck at ${getCount()})`);
    await sleep(2);
  }
}

// Isolation: redirect HOME/USERPROFILE too, not just LOOM_HOME — this test's own scenarios write a FAKE
// transcript at the real engineTranscriptPath() computation, and that must never land under the real
// ~/.claude on whatever host runs this suite.
const tmpHome = path.join(os.tmpdir(), `loom-giveuptranscript-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

const ENTER_DELAY = 50;
const VERIFY_TIMEOUT = 300;
const MAX_ATTEMPTS = 3;
const SETTLE_POLL = 10;
const SETTLE_MAX_POLLS = 5;
const CONFIRM_SETTLE_POLL = 10;
const CONFIRM_SETTLE_MAX_POLLS = 5;
const HOLD_MS = 10;
const BUSY_STALE_MS = 80; // small so scenario (e)/(l)'s reconcile()-driven heal is fast to test
const FIRST_TURN_STALE_MS = 80;
process.env.LOOM_FIRST_TURN_STALE_MS = String(FIRST_TURN_STALE_MS);
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_REASSERT_SETTLE_POLL_MS = String(SETTLE_POLL);
process.env.LOOM_REASSERT_SETTLE_MAX_POLLS = String(SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_POLL_MS = String(CONFIRM_SETTLE_POLL);
process.env.LOOM_GIVE_UP_CONFIRM_SETTLE_MAX_POLLS = String(CONFIRM_SETTLE_MAX_POLLS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => writes.push(d), writes };
    fakes.push(fake);
    return fake;
  }
}

const busyLog = {};
const submitLog = [];
const busyReasonLog = [];
const origConsoleLog = console.log.bind(console);
console.log = (...args) => {
  origConsoleLog(...args);
  const line = args.map(String).join(" ");
  if (line.startsWith("[submit]")) submitLog.push(line);
  if (line.startsWith("[busy]")) busyReasonLog.push(line);
};
const origConsoleError = console.error.bind(console);
console.error = (...args) => { origConsoleError(...args); const line = args.map(String).join(" "); if (line.startsWith("[submit]")) submitLog.push(line); };

const events = {
  onEngineSessionId() {}, onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
  onContextStats() {}, onRateLimited() {}, onExit() {},
};
const host = new TestPtyHost(events, { busyStaleMs: BUSY_STALE_MS });

function spawnReady(sessionId, cwd, engineSessionId) {
  fs.mkdirSync(cwd, { recursive: true });
  host.spawn({
    sessionId, cwd,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart", session_id: engineSessionId });
  const fake = fakes[fakes.length - 1];
  return { fake, entryCount: () => fake.writes.join("").split("\r").length - 1 };
}

function userTurnLine(text) {
  return JSON.stringify({ type: "user", message: { content: text } }) + "\n";
}
function userTurnLineArrayContent(text) {
  return JSON.stringify({ type: "user", message: { content: [{ type: "text", text } ] } }) + "\n";
}
function userTurnLineWrapped(text) {
  const wrapped = `\n\n<pasted_content id="fix123">\n${text}\n</pasted_content id="fix123">\n`;
  return JSON.stringify({ type: "user", message: { content: wrapped } }) + "\n";
}
function toolResultOnlyLine() {
  return JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }) + "\n";
}

try {
  // ===================== (a) grows with a MATCHING user record, no hook ever arrives ⇒ SUPPRESSED ========
  {
    const SID = "sess-xcript-match";
    const CWD = path.join(tmpHome, "cwd-a");
    const ENGINE_ID = "eng-a";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_A";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n"); // pre-existing content → a real baseline

    const r = host.enqueueStdin(SID, TEXT);
    check("(a) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitForCount(entryCount, 1); // observed: attempt 1's Enter write → baseline just captured
    fs.appendFileSync(file, userTurnLine(TEXT)); // grows AFTER the baseline, with the MATCHING text

    // Observe the ACTUAL commit-point outcome (either SUPPRESSED, matching this scenario's expectation, or
    // the plain GIVE-UP RECOVERY a pre-fix tree would still take) — not a guessed deadline. Tolerating the
    // RECOVERY outcome here (rather than letting its own timeout throw and crash the process) is what lets
    // a pre-fix revert of this check fail LOUD, via the assertions below, instead of an uncaught timeout.
    try {
      await sharedWaitUntil(
        () => busyLog[SID].at(-1) === false || submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP SUPPRESSED") && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* neither outcome observed within budget — the checks below report this as a real FAIL */ }
    check("(a) GIVE-UP SUPPRESSED by transcript corroboration: busy is STILL true", busyLog[SID].at(-1) === true);
    check("(a) the distinct corroboration log line fired", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")));
    check("(a) no plain (non-corroborated) GIVE-UP RECOVERY fired for this session", !submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after")));
  }

  // ===================== (b) grows with a NON-matching record (another lineage) ⇒ recovery fires =========
  {
    const SID = "sess-xcript-mismatch";
    const CWD = path.join(tmpHome, "cwd-b");
    const ENGINE_ID = "eng-b";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_B";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(b) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, userTurnLine("SOME_OTHER_LINEAGES_TEXT_ENTIRELY")); // grows, but does NOT match

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
    check("(b) GIVE-UP RECOVERY still fires: a non-matching grown record does not corroborate", busyLog[SID].at(-1) === false);
    check("(b) the recovery notice named the declined transcript check", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after") && l.includes("no-matching-user-record")));
  }

  // ===================== (c) no growth at all ⇒ recovery fires exactly as today ===========================
  {
    const SID = "sess-xcript-nogrowth";
    const CWD = path.join(tmpHome, "cwd-c");
    const ENGINE_ID = "eng-c";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_C";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(c) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitForCount(entryCount, 1); // baseline captured; file is NEVER touched again

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
    check("(c) GIVE-UP RECOVERY still fires: no growth at all", busyLog[SID].at(-1) === false);
    check("(c) the recovery notice named no-growth", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after") && l.includes("no-growth")));
  }

  // ===================== (d) a stat error at the commit-point check ⇒ fails closed, recovery fires ========
  {
    const SID = "sess-xcript-staterr";
    const CWD = path.join(tmpHome, "cwd-d");
    const ENGINE_ID = "eng-d";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_D";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(d) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);

    await waitForCount(entryCount, 1); // baseline captured successfully BEFORE the stat is sabotaged
    fs.appendFileSync(file, userTurnLine(TEXT)); // a real, MATCHING grown record — would otherwise suppress
    const origStatSync = fs.statSync;
    fs.statSync = (p, ...rest) => {
      if (p === file) throw new Error("ENOENT: simulated stat failure (card 5d068eec test scenario d)");
      return origStatSync(p, ...rest);
    };
    try {
      await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
      check("(d) GIVE-UP RECOVERY still fires: a stat error at the commit-point check fails closed (never suppresses on an error)", busyLog[SID].at(-1) === false);
      check("(d) the recovery notice named the stat failure", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after") && l.includes("stat-threw")));
    } finally {
      fs.statSync = origStatSync;
    }
  }
  // ===================== (e) CR round 2 Minor 2 — suppressed by transcript, then Stop ALSO lost: heals ====
  // via healIfStuck's "heal-if-stuck-stale" branch (clears busy, requeues NOTHING) — never the OTHER branch
  // (mark-dirty + restore), which would wrongly re-deliver a turn that already genuinely started.
  {
    const SID = "sess-xcript-heal-no-requeue";
    const CWD = path.join(tmpHome, "cwd-e");
    const ENGINE_ID = "eng-e";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_E";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(e) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, userTurnLine(TEXT));

    try {
      await sharedWaitUntil(
        () => submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* checked below */ }
    check("(e) suppressed by transcript corroboration (busy still true)", busyLog[SID].at(-1) === true);

    // Stop is ALSO lost (never delivered) — let staleness accrue past BUSY_STALE_MS/FIRST_TURN_STALE_MS,
    // then drive the heal backstop exactly like pty-healifstuck-clear.mjs does.
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — this sleep waits for the KNOWN, test-controlled
    // BUSY_STALE_MS/FIRST_TURN_STALE_MS hold (not an unobservable real-world event); the checks below run
    // SYNCHRONOUSLY right after host.reconcile(), with no further await in between — healIfStuck's own
    // branch decision (and its setBusy/onBusy callback) is made synchronously inside that one call, same
    // shape as pty-healifstuck-clear.mjs's own identically-reasoned sites.
    await sleep(Math.max(BUSY_STALE_MS, FIRST_TURN_STALE_MS) + 150);
    host.reconcile();
    check("(e) THE FIX: healIfStuck clears busy via its STALE branch (not mark-dirty+restore)", busyLog[SID].at(-1) === false);
    check("(e) heal reason is heal-if-stuck-stale, never heal-if-stuck-clear", busyReasonLog.some((l) => l.includes(`[busy] ${SID} `) && l.includes("heal-if-stuck-stale")));
    check("(e) nothing requeued — the turn had genuinely already started", host.getPending(SID).length === 0);
  }

  // ===================== (f) CR round 2 Minor 3 — matching record followed by >64KB of unrelated growth ===
  // still suppresses: the match is found reading the HEAD of the grown region (right at the baseline),
  // never the tail, so a large amount of following output can never push it out of the read window.
  {
    const SID = "sess-xcript-head-not-tail";
    const CWD = path.join(tmpHome, "cwd-f");
    const ENGINE_ID = "eng-f";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_F";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(f) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    const filler = "x".repeat(70_000); // > the 65_536-byte default read cap
    fs.appendFileSync(file, userTurnLine(TEXT) + userTurnLine(filler));

    try {
      await sharedWaitUntil(
        () => submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* checked below */ }
    check("(f) still SUPPRESSED despite >64KB of growth following the matching record", busyLog[SID].at(-1) === true);
  }

  // ===================== (g) the <pasted_content>-wrapped form MATCHES ====================================
  {
    const SID = "sess-xcript-wrapped";
    const CWD = path.join(tmpHome, "cwd-g");
    const ENGINE_ID = "eng-g";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_G";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(g) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, userTurnLineWrapped(TEXT));

    try {
      await sharedWaitUntil(
        () => submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* checked below */ }
    check("(g) a <pasted_content>-wrapped matching record SUPPRESSES (isRecognizedPastedContentWrap reused)", busyLog[SID].at(-1) === true);
  }

  // ===================== (h) an array-content user record MATCHES =========================================
  {
    const SID = "sess-xcript-arraycontent";
    const CWD = path.join(tmpHome, "cwd-h");
    const ENGINE_ID = "eng-h";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_H";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(h) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, userTurnLineArrayContent(TEXT));

    try {
      await sharedWaitUntil(
        () => submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* checked below */ }
    check("(h) an array-content (text block) matching record SUPPRESSES", busyLog[SID].at(-1) === true);
  }

  // ===================== (i) a tool_result-only record must NOT match ⇒ recovery fires ====================
  {
    const SID = "sess-xcript-toolresultonly";
    const CWD = path.join(tmpHome, "cwd-i");
    const ENGINE_ID = "eng-i";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_I";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(i) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, toolResultOnlyLine()); // grows, but the only new "user" line is tool_result-only

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
    check("(i) a tool_result-only record never corroborates: recovery fires", busyLog[SID].at(-1) === false);
    check("(i) the recovery notice named no-matching-user-record", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after") && l.includes("no-matching-user-record")));
  }

  // ===================== (j) CR round 2 Minor 5(i) — matching record BEFORE baseline, non-matching AFTER ===
  // ⇒ recovery: a pre-existing matching line (written before this generation's own Enter) must never count.
  {
    const SID = "sess-xcript-prebaseline";
    const CWD = path.join(tmpHome, "cwd-j");
    const ENGINE_ID = "eng-j";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_J";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The MATCHING line already exists BEFORE this generation's own baseline is even captured.
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n" + userTurnLine(TEXT));

    const r = host.enqueueStdin(SID, TEXT);
    check("(j) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1); // baseline now includes the pre-existing matching line
    fs.appendFileSync(file, userTurnLine("SOME_OTHER_LINEAGES_TEXT_ENTIRELY")); // only NON-matching growth after

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
    check("(j) a pre-baseline matching record is never consulted: recovery fires", busyLog[SID].at(-1) === false);
  }

  // ===================== (k) CR round 2 Minor 5(iii) — file missing at attempt 1 ⇒ recovery, even if the ===
  // ===================== file is created LATER with genuinely matching text (no baseline ⇒ never checked) ==
  {
    const SID = "sess-xcript-latecreate";
    const CWD = path.join(tmpHome, "cwd-k");
    const ENGINE_ID = "eng-k";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_K";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    // Deliberately NOT created yet — baseline capture at attempt 1 will find nothing to stat.

    const r = host.enqueueStdin(SID, TEXT);
    check("(k) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1); // baseline capture ran and found no file ⇒ stays null

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n" + userTurnLine(TEXT)); // created LATE, with matching text

    await sharedWaitUntil(() => busyLog[SID].at(-1) === false, { timeoutMs: 5000, intervalMs: 5 });
    check("(k) a late-created file with matching text still recovers: no baseline ⇒ never checked", busyLog[SID].at(-1) === false);
    check("(k) the recovery notice named no-baseline", submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("GIVE-UP RECOVERY after") && l.includes("no-baseline")));
  }

  // ===================== (l) CR round 2 Minor 5(iv) — after suppression, a REAL Stop still finalizes =======
  // cleanly: busy false, nothing requeued, no corruption from having been suppressed.
  {
    const SID = "sess-xcript-cleanstop";
    const CWD = path.join(tmpHome, "cwd-l");
    const ENGINE_ID = "eng-l";
    const TEXT = "TRANSCRIPT_CORROBORATED_TURN_L";
    const { entryCount } = spawnReady(SID, CWD, ENGINE_ID);
    const file = engineTranscriptPath(CWD, ENGINE_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");

    const r = host.enqueueStdin(SID, TEXT);
    check("(l) setup: immediate idle-submit delivered, busy armed", r.delivered === true && busyLog[SID].at(-1) === true);
    await waitForCount(entryCount, 1);
    fs.appendFileSync(file, userTurnLine(TEXT));

    try {
      await sharedWaitUntil(
        () => submitLog.some((l) => l.includes(`[submit] ${SID} `) && l.includes("transcript corroboration")),
        { timeoutMs: 5000, intervalMs: 5 },
      );
    } catch { /* checked below */ }
    check("(l) suppressed by transcript corroboration (busy still true)", busyLog[SID].at(-1) === true);

    // The real Stop eventually arrives, late but genuine — finalizes normally.
    host.deliverHook(SID, { hook_event_name: "Stop" });
    check("(l) a real, later Stop finalizes cleanly after a transcript-corroborated suppression", busyLog[SID].at(-1) === false && host.getPending(SID).length === 0);
  }
} finally {
  for (const sid of [
    "sess-xcript-match", "sess-xcript-mismatch", "sess-xcript-nogrowth", "sess-xcript-staterr",
    "sess-xcript-heal-no-requeue", "sess-xcript-head-not-tail", "sess-xcript-wrapped", "sess-xcript-arraycontent",
    "sess-xcript-toolresultonly", "sess-xcript-prebaseline", "sess-xcript-latecreate", "sess-xcript-cleanstop",
  ]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  console.log = origConsoleLog;
  console.error = origConsoleError;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GIVE-UP RECOVERY's transcript-growth corroboration suppresses only when the session transcript genuinely grew (reading HEAD-first from the baseline, surviving >64KB of following growth) with a user record matching this generation's own intended text (plain string, pasted_content-wrapped, or array-content), and falls through to today's unchanged recovery on a non-matching record, a tool_result-only record, a pre-baseline-only match, no growth at all, a missing-then-late-created file, or a stat error — never on an assumption. A transcript-corroborated suppression also leaves the generation in the SAME state a real hook would (enterConfirmed/firstTurnStarted), so a later lost Stop heals via the stale branch with no requeue, and a later REAL Stop still finalizes cleanly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
