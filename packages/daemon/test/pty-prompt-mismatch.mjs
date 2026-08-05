// Card 7114838d — frame-splice detector: LOG-ONLY diagnostic instrumentation, fixes nothing (does not
// close 3ce3fa39). Compares the engine's own report of what was actually submitted (UserPromptSubmit's
// `prompt` field) against `live.lastPrompt` (what the daemon itself intended to write for that turn) —
// the one comparison that can distinguish "written and applied" from "written and dropped/spliced",
// because the two sides come from genuinely independent sources.
//
// POSITIVE-CONTROL (mandatory per the card): a detector never shown going red is not evidence. This file
// proves the detector can FIRE on a synthesized mismatch (and that the log is SELF-CLASSIFYING — a real
// splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a
// matching pair, is GATED on submitWasOutstanding (so a raw human-typed turn against a stale lastPrompt
// never misfires — the known false-positive class), and is SELF-DIAGNOSING when the engine never sends a
// `prompt` field at all.
//
// ⚠️ WHAT THIS SUITE DOES NOT PROVE: every scenario here SYNTHESIZES the hook payload. It proves the
// detector's comparison/gating/logging logic is correct GIVEN that `hook.prompt` exists and reports the
// engine's literal submitted text — it does NOT and cannot prove Claude Code actually sends that field, or
// that it reports the identical string byte-for-byte (no Ink-side trimming/normalization). That premise is
// answered only by the FIRST REAL hook after deploy: either the mismatch/match log fires as expected, or
// the `UNCONFIRMED` self-diagnostic line (scenario 4) fires instead, and only then is the question settled.
//
// Mirrors pty-owner-attestation.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty
// seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch.mjs  (build first: from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-prompt-mismatch-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakesById = new Map(); // sessionId -> fake pty ({ writes, ... }) — card 201d0d95's new scenarios need
// to inspect what actually got submitted to a SPECIFIC session's pty, not just whether a console.log fired.
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakesById.set(opts.sessionId, fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 1addef27 (fixed-wait-negative-guard) / card 201d0d95 manager review: a bounded POLL on the actual
// completion signal, not a fixed clock — mirrors paste-placeholder-tripwire.mjs's own `waitUntil`. The
// guard's own header names this shape as its documented blind spot ("a locally-reimplemented waitUntil/
// poll-loop... usually safe"), because it IS a genuinely different shape from a blind sleep: it retries
// against an observed condition rather than assuming a fixed duration was enough.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};
// Whether ANY pending entry for `sid` is the prompt-mismatch notice — reads PtyHost's own queue state
// directly (host.getPendingEntries), not an indirect symptom like pty writes.
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Captures console.log lines matching the detector's [prompt-mismatch] tag for the duration of a block.
// The detector logs via console.log (stdout) deliberately — same stream as [pty-write]/[submit-write]/
// [stdin-write], so line order in the combined log stays meaningful alongside those records; see the
// comment above the detector in host.ts.
function captureMismatchWarnings(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes("[prompt-mismatch]")) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

// Card 68459420 DoD-3: captures the DISTINCT [prompt-mismatch-unmatched-longer] tag — the uncharacterized
// "gen=12" population (reported LONGER than intended, matching no recent write). Deliberately a SEPARATE
// tag/filter from captureMismatchWarnings above (that filter's exact-substring match "[prompt-mismatch]"
// does not accidentally catch this one — the closing bracket differs), so a test can assert this
// population's own log fired without conflating it with the ordinary diagnostic.
function captureUnmatchedLongerWarnings(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes("[prompt-mismatch-unmatched-longer]")) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL: a synthesized mismatch (reported = stranded + intended) FIRES, and the log
  // names WHERE the divergence starts, not just that one exists =====
  {
    const sid = newSession("A"); SIDS.push(sid);
    const stranded = "leftover text from a prior turn";
    const intended = "the new message the user actually typed";
    host.enqueueStdin(sid, intended); // submit() outstanding -> live.lastPrompt = intended, enterConfirmed=false
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: stranded + intended });
    });
    check("1: a synthesized splice (reported = stranded+intended) FIRES the detector", warnings.length === 1);
    check("1: the log names the divergence POINT (a char offset), not just a bare true/false", /divergesAtChar=\d+/.test(warnings[0] ?? ""));
    check("1: the log shows an excerpt around the divergence on BOTH sides", /reportedAround=/.test(warnings[0] ?? "") && /intendedAround=/.test(warnings[0] ?? ""));
    check("1: divergesAtChar is 0 — the specimens splice from the very start (stranded prefix precedes everything)", /divergesAtChar=0\b/.test(warnings[0] ?? ""));
    // Self-classifying fields (manager review): a real splice has a LARGE tail on both sides at the
    // divergence point (the rest of two genuinely different messages), unlike a trailing/normalization
    // artifact which would diverge near the very end with tiny tails on both sides.
    check("1: lenDelta + both tail lengths are present so the reader can tell a real splice from a benign trailing/normalization artifact without doing arithmetic",
      /lenDelta=-?\d+/.test(warnings[0] ?? "") && /tailReportedLen=\d+/.test(warnings[0] ?? "") && /tailIntendedLen=\d+/.test(warnings[0] ?? ""));
    {
      const tailReported = Number((/tailReportedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      const tailIntended = Number((/tailIntendedLen=(\d+)/.exec(warnings[0] ?? "") ?? [])[1]);
      check("1: this specimen's tails are LARGE on both sides (a real splice shape, not a trailing artifact)",
        Number.isFinite(tailReported) && Number.isFinite(tailIntended) && tailReported > 20 && tailIntended > 20);
    }
  }

  // ===== 2. NEGATIVE: a matching pair (reported === intended) does NOT fire =====
  {
    const sid = newSession("B"); SIDS.push(sid);
    const text = "a perfectly normal message";
    host.enqueueStdin(sid, text);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text });
    });
    check("2: a matching (non-spliced) turn stays SILENT", warnings.length === 0);
  }

  // ===== 3. GATING (known false-positive class): a raw human-typed turn — submitWasOutstanding===false —
  // must NEVER misfire against a stale lastPrompt left over from an earlier Loom-originated turn =====
  {
    const sid = newSession("C"); SIDS.push(sid);
    // Turn 1: a Loom-originated submit sets live.lastPrompt, then completes (Stop) — enterConfirmed=true,
    // no submit outstanding afterward. lastPrompt is left stale (the field is never cleared at Stop).
    host.enqueueStdin(sid, "[loom:reminder] an earlier, unrelated Loom turn");
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // Turn 2: a genuine raw-terminal Enter-submit (writeStdin), completely different text, with NO
    // submit() outstanding — enterConfirmed is already true, so submitWasOutstanding is false.
    const rawLine = "something the human typed directly into the raw terminal";
    host.writeStdin(sid, `${rawLine}\r`);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: rawLine });
    });
    check("3: a raw-terminal turn (submitWasOutstanding=false) never compares against a stale lastPrompt", warnings.length === 0);
  }

  // ===== 4. SELF-DIAGNOSING: the engine never sends a usable 'prompt' field at all — must log this
  // explicitly, once, rather than silently comparing undefined and never firing =====
  {
    const sid = newSession("D"); SIDS.push(sid);
    host.enqueueStdin(sid, "some outstanding turn"); // submit() outstanding
    const warnings1 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" }); // NO prompt field at all
    });
    check("4: an absent prompt field is logged EXPLICITLY (not silently ignored)", warnings1.length === 1);
    check("4: the absent-field log names the premise as unconfirmed", /UNCONFIRMED/.test(warnings1[0] ?? ""));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // A SECOND turn on the same session, still missing the field, must NOT re-log — "once" per session.
    host.enqueueStdin(sid, "a second outstanding turn");
    const warnings2 = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit" });
    });
    check("4: a repeat absence on the SAME session does not re-log (latched once, not once-per-turn)", warnings2.length === 0);
  }

  // ===== 5. A fresh session's own startup-prompt hook never fires the detector (no submit() is
  // outstanding for the CLI-arg startup turn — enterConfirmed is seeded true) =====
  {
    const sid = "sess-E";
    host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, startupPrompt: "kickoff text" });
    SIDS.push(sid);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "SessionStart" });
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: "kickoff text" });
    });
    check("5: the fresh-spawn startup-prompt hook (no submit outstanding) never fires the detector", warnings.length === 0);
  }

  // ===== 6. CONTRAST (manager review): a benign trailing-artifact-shaped mismatch (e.g. a lone trailing
  // character) reads DIFFERENTLY in the log than scenario 1's real-splice shape — small tails on both
  // sides at the divergence point, instead of scenario 1's large tails. This is what would let a reader
  // tell a systematic benign mismatch (framing/normalization) apart from an actual splice at a glance,
  // without the detector itself having to guess which one it is. =====
  {
    const sid = newSession("F"); SIDS.push(sid);
    const intended = "a normal short message";
    host.enqueueStdin(sid, intended);
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: `${intended} ` }); // one trailing char
    });
    check("6: a single trailing-char difference still FIRES (it is a real, if small, mismatch)", warnings.length === 1);
    check("6: divergesAtChar sits at the END of the shorter string (near both lengths), not at 0", new RegExp(`divergesAtChar=${intended.length}\\b`).test(warnings[0] ?? ""));
    check("6: BOTH tails are tiny here (0 and 1) — visibly different from scenario 1's large-tail splice shape", /tailReportedLen=1\b/.test(warnings[0] ?? "") && /tailIntendedLen=0\b/.test(warnings[0] ?? ""));
  }

  // ===== 6b. Card cf2fef73 (owner-reported, false LOSS alarm on benign whitespace re-rendering) — DoD-4(a),
  // the owner's own real specimen: an interior TAB in the intended text, echoed back space-expanded by the
  // terminal, content otherwise identical. The RAW byte-wise scan still diverges here — this reproduces
  // scenario 6's own finding that tail size alone (both tails would read LARGE, same as a real splice —
  // see the corrected comment in host.ts) cannot discriminate this from a real splice. What must change:
  // the SESSION-FACING notice must NOT fire, even though the diagnostic [prompt-mismatch] console.log
  // still does (the corpus must not go blind).
  //
  // RECONCILED (partially) from the actual retained log line for this specimen (daemon-output.log, session
  // 848ff32d…, epoch 1785951952399 — the exact line quoted in the card body): the tab sits at column 32
  // (chars before it: `Again why did "loom/495e24081b59` = 32 chars, matching divergesAtChar=32) and is
  // echoed back as EXACTLY 4 spaces (`reportedAround` shows "...81b59    Bugfix", a 4-space run) — a LOCAL
  // +3 (1 tab char replaced by 4 space chars), consistent with a 4-column tab-stop grid (column 32 is
  // already a multiple of 4; the next stop is 36). The card's own "NOT ESTABLISHED" note flagged that a
  // uniform tab→4-spaces reading would be +3 while the MESSAGE's overall lenDelta is +2 — that gap is now
  // explained, not just repeated: a LOCAL +3 at this tab is real (confirmed above), so the message-level
  // +2 requires a compensating -1 elsewhere in the full ~198-char string, outside the ~60-char window the
  // log retains — still not directly observable (the full text was never retained), but no longer an
  // unexplained arithmetic mismatch. This test reproduces the CONFIRMED LOCAL mechanism (4 spaces), so its
  // own message-level lenDelta reads +3 here (a standalone single-tab specimen, nothing else to
  // compensate), not the owner's message-level +2.
  {
    const sid = newSession("Tab"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const before = "x".repeat(32); // 32 identical chars, matching the owner's own divergesAtChar=32
    const after = "Bugfix - some trailing content after the tab position";
    const intended = `${before}\t${after}`;
    const reported = `${before}    ${after}`; // tab echoed as 4 spaces — the confirmed real shape, see above
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("6b: the raw byte-wise scan still diverges — the diagnostic log still fires (corpus preserved)", warnings.length === 1);
    check("6b: reproduces the owner's own divergence point (divergesAtChar=32) and the confirmed local tab-expansion (lenDelta=+3, 1 tab -> 4 spaces)",
      /divergesAtChar=32\b/.test(warnings[0] ?? "") && /lenDelta=3\b/.test(warnings[0] ?? ""));
    // No barrier needed — mirrors scenario 8's own reasoning: the ONLY way a notice could land is the same
    // setTimeout(fn, 0) the real notice schedules, so one macrotask tick after the hook is a PROVEN-
    // sufficient bound for observing its ABSENCE, not a guess.
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — see scenario 8's own comment for why exactly one tick is
    // provably sufficient; the negative check below runs synchronously immediately after, no further await.
    await new Promise((r) => setTimeout(r, 0));
    check("6b: NEGATIVE CONTROL — despite the raw byte divergence, the session-facing notice does NOT enqueue (benign whitespace re-render, DoD-1/DoD-2)", !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const afterTurn = fake.writes.slice(writesBeforeMismatch).join("");
    check("6b: and nothing resembling the notice ever reached the pty", !afterTurn.includes("[loom:prompt-mismatch]"));
    // Card 68459420 regression: a benign, suppressed mismatch must NOT set the sender-directed signal
    // either — there is no real loss here for a manager to act on.
    check("6b: getLastMismatchReplay stays null for a suppressed benign mismatch", host.getLastMismatchReplay(sid) === null);
  }

  // ===== 6c. Card cf2fef73 (manager review, second population — the LARGEST single benign class measured
  // in the corpus, ~63 specimens at lenDelta exactly 26/27): a STALE PLACEHOLDER PREFIX. The engine echoes
  // back an older, already-collapsed paste-placeholder frame (`[Pasted text #N +M lines]`, Claude Code's
  // own paste-collapse UI — a SEPARATE mechanism from detectPastePlaceholderLengthLoss/eef4883c/0f9268cc,
  // which this card does not touch) PREPENDED onto the otherwise-correctly-submitted intended text,
  // unchanged. Content is fully present; nothing was lost. The raw byte-wise scan still diverges (the
  // diagnostic log must still fire — corpus preserved), and — the measured shape the corrected classifier
  // comment now documents — diverges at char 1, not 0 (both strings start with the same `[` byte), which
  // is why "wholly different strings diverge at 0" was never a safe read on its own. What must change:
  // the SESSION-FACING notice must NOT fire. =====
  {
    const sid = newSession("PlaceholderPrefix"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const placeholder = "[Pasted text #3 +80 lines]"; // 26 chars — the measured shape's exact length
    const intended = "[loom:from-manager] some real, correctly-submitted message content that was never lost";
    const reported = placeholder + intended; // exact prefix, byte-for-byte — the shape the check requires
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("6c: the raw byte-wise scan still diverges — the diagnostic log still fires (corpus preserved)", warnings.length === 1);
    check("6c: divergesAtChar=1 (both start with the same '[' byte) — the measured shape, not the classifier's old 'wholly different strings -> 0' assumption",
      /divergesAtChar=1\b/.test(warnings[0] ?? ""));
    check("6c: lenDelta equals the placeholder's own length (26)", /lenDelta=26\b/.test(warnings[0] ?? ""));
    // No barrier needed — mirrors scenario 8's own reasoning: the ONLY way a notice could land is the same
    // setTimeout(fn, 0) the real notice schedules, so one macrotask tick after the hook is a PROVEN-
    // sufficient bound for observing its ABSENCE, not a guess.
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — see scenario 8's own comment for why exactly one tick is
    // provably sufficient; the negative check below runs synchronously immediately after, no further await.
    await new Promise((r) => setTimeout(r, 0));
    check("6c: NEGATIVE CONTROL — despite the raw byte divergence, the session-facing notice does NOT enqueue (stale placeholder prefix, content fully present)", !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const afterTurn = fake.writes.slice(writesBeforeMismatch).join("");
    check("6c: and nothing resembling the notice ever reached the pty", !afterTurn.includes("[loom:prompt-mismatch]"));
    check("6c: getLastMismatchReplay stays null for a suppressed benign mismatch", host.getLastMismatchReplay(sid) === null);
  }

  // ===== 6d. Card cf2fef73 (manager review CORRECTION — the first placeholder regex given was incomplete
  // and would have shipped a fix that still false-alarms): a SECOND placeholder form with NO line count at
  // all, `[Pasted text #N]` — found from a live gen=14 specimen the manager received while checking the
  // first regex, which missed it entirely (measured: 5 occurrences, 2 of them pure prefixes at exactly
  // lenDelta=16, matching len("[Pasted text #1]")=16). Same benign shape as 6c (content fully present,
  // placeholder merely prepended), just the shorter token. =====
  {
    const sid = newSession("PlaceholderPrefixNoCount"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const placeholder = "[Pasted text #1]"; // 16 chars — matches the manager's own measured lenDelta=16 specimens
    const intended = "[loom:worker-report] some real, correctly-submitted report content that was never lost";
    const reported = placeholder + intended; // exact prefix, byte-for-byte
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("6d: the raw byte-wise scan still diverges — the diagnostic log still fires (corpus preserved)", warnings.length === 1);
    check("6d: lenDelta equals the no-line-count placeholder's own length (16)", /lenDelta=16\b/.test(warnings[0] ?? ""));
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — see scenario 8's own comment for why exactly one tick is
    // provably sufficient; the negative check below runs synchronously immediately after, no further await.
    await new Promise((r) => setTimeout(r, 0));
    check("6d: NEGATIVE CONTROL — the no-line-count placeholder form is ALSO suppressed (the widened regex catches it, unlike the first regex given)", !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const afterTurn = fake.writes.slice(writesBeforeMismatch).join("");
    check("6d: and nothing resembling the notice ever reached the pty", !afterTurn.includes("[loom:prompt-mismatch]"));
    check("6d: getLastMismatchReplay stays null for a suppressed benign mismatch", host.getLastMismatchReplay(sid) === null);
  }

  // ===== 6e. Card cf2fef73 (manager review CORRECTION #2 — a single-shot strip is FAIL-OPEN): placeholders
  // STACK. A real specimen carried THREE concatenated, MIXING both forms — a bare `#11` alongside two
  // `+M lines` ones — the exact shape a form-1-only or form-2-only (even a single-token-of-either-form)
  // strip would fail to fully consume: a single-shot strip leaves the LATER placeholders in the
  // remainder, so `remainder !== intended`, so the identity check would wrongly FAIL and the notice would
  // FIRE on this provably benign case — the dense-multi-paste case where a false alarm costs the most.
  // Uses the real specimen VERBATIM (delta=71=17+27+27, per the manager's own measurement), not an
  // invented fixture. =====
  {
    const sid = newSession("PlaceholderStackMixed"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const placeholderRun = "[Pasted text #11][Pasted text #12 +38 lines][Pasted text #13 +40 lines]"; // 71 chars, the real specimen verbatim
    const intended = "[loom:from-manager] some real, correctly-submitted message content that was never lost";
    const reported = placeholderRun + intended; // exact prefix, byte-for-byte — the whole leading run, then intended unchanged
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("6e: the raw byte-wise scan still diverges — the diagnostic log still fires (corpus preserved)", warnings.length === 1);
    check("6e: lenDelta equals the stacked run's own length (71 = 17+27+27, the real specimen's measured delta)", /lenDelta=71\b/.test(warnings[0] ?? ""));
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — see scenario 8's own comment for why exactly one tick is
    // provably sufficient; the negative check below runs synchronously immediately after, no further await.
    await new Promise((r) => setTimeout(r, 0));
    check("6e: NEGATIVE CONTROL — a stacked, mixed-form placeholder run is ALSO fully suppressed (the global strip consumes all three, unlike a single-shot strip which would leave a remainder and wrongly fire)", !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const afterTurn = fake.writes.slice(writesBeforeMismatch).join("");
    check("6e: and nothing resembling the notice ever reached the pty", !afterTurn.includes("[loom:prompt-mismatch]"));
    check("6e: getLastMismatchReplay stays null for a suppressed benign mismatch", host.getLastMismatchReplay(sid) === null);
  }

  // ===== 7. Card 201d0d95 Q1 — POSITIVE: a mismatch must now SURFACE to the affected session itself, not
  // just to daemon-output.log. Reproduces the real incident's shape (session 363002b9, 2026-08-04): an
  // EARLIER generation's own already-confirmed text reappears, byte-for-byte, as what the engine reports
  // submitting for a LATER, unrelated generation. Must land as the notice's OWN pty submission (never
  // appended to the mismatched turn's own payload), naming BOTH the possible loss (intended text did not
  // reach the engine) and the possible duplicate (the submitted content matches an earlier generation) —
  // and must identify WHICH earlier generation, since `live.recentWrittenTurns` still holds it. =====
  {
    const sid = newSession("G"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const genAText = "[loom:worker-report] worker AAAA — generation A's own real report";
    const genBText = "[loom:worker-report] worker BBBB — generation B's own real report, never actually delivered";

    // Generation A: an ordinary, cleanly-confirmed turn — establishes the entry in recentWrittenTurns that
    // generation B's replay will later match.
    host.enqueueStdin(sid, genAText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genAText }); // byteIdentical=true, gen=1
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes turn A cleanly, queue empty

    // Generation B: Loom writes genBText, but the engine reports back genAText verbatim — the exact-replay
    // shape from the real incident (reportedHash equals a PRIOR generation's writtenHash, not this one's).
    host.enqueueStdin(sid, genBText); // gen=2, live.lastPrompt = genBText
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genAText }); // byteIdentical=false
    // Manager review, card 201d0d95 (fixed-wait-negative-guard caught the ORIGINAL fixed-duration wait
    // here): a BARRIER, not a delay — poll for the REAL positive event the deferred setTimeout(0) produces
    // (the notice actually landing in host.getPendingEntries), rather than waiting a guessed duration and
    // hoping it landed in time. The negative check right below runs the INSTANT that poll observes it.
    const enqueued7 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7);
    check("7: the deferred notice does not write DURING the mismatched turn itself (queued, not appended to it)",
      fake.writes.length === writesBeforeMismatch);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes the mismatched (genA-content) turn, drains the queued notice as its OWN new turn
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7: a mismatch now produces a corrective turn on the pty (previously LOG-ONLY, card 201d0d95 Q1)",
      noticeWrite.includes("[loom:prompt-mismatch]"));
    check("7: the notice names the LOSS half, ESTABLISHED (not merely possible) since this IS a recognized replay",
      /did not reach you/.test(noticeWrite) && /ESTABLISHED/.test(noticeWrite));
    // Card 68459420 DoD-2: the RECIPIENT cannot verify the loss half itself — only the SENDER can. The
    // notice must say so explicitly rather than asking the recipient to check something it structurally
    // cannot check.
    check("7: the notice tells the RECIPIENT it cannot verify this loss itself, and names the SENDER as the party who can",
      /cannot verify that yourself/.test(noticeWrite) && /SENDER/.test(noticeWrite));
    check("7: the notice names the DUPLICATE half AND identifies the specific earlier generation replayed",
      /DUPLICATE/.test(noticeWrite) && /gen=1\b/.test(noticeWrite));
    check("7: the notice reports OBSERVED FIELDS (both hashes present) and asserts no CLI-internal cause",
      /writtenHash=\w+/.test(noticeWrite) && /reportedHash=\w+/.test(noticeWrite) && !/\bthe (cli|CLI) (did|dropped|collapsed)\b/i.test(noticeWrite));
    // Manager correction 2026-08-05: a Platform sweep measured this exact shape 15 times (14 sessions) and
    // found it is ALWAYS a replay of the IMMEDIATELY PRECEDING recorded generation — the notice should now
    // say so (a reader can go straight to "the message just before this one"), stated as an observed
    // REGULARITY, never as a claimed mechanism.
    check("7: since the matched entry IS the immediately preceding generation, the notice says so explicitly",
      /IMMEDIATELY PRECEDING/.test(noticeWrite));
    check("7: the regularity is framed as MEASURED/OBSERVED, never as an asserted cause",
      /measured|shown so far/i.test(noticeWrite) && !/\bbecause\b/i.test(noticeWrite));
    // ===== 7d. Card 68459420 DoD-1/DoD-4 — THE SENDER-DIRECTED ARM: a recognized replay must record a
    // durable, read-only signal (getLastMismatchReplay) that this session's manager/parent — the only
    // party who can actually tell what it meant to send — can discover the NEXT time it looks (e.g. via
    // worker_list/worker_status), rather than depending solely on the session-facing notice text above. =====
    {
      const replay = host.getLastMismatchReplay(sid);
      check("7d: getLastMismatchReplay records the replay (a durable PULL signal, not just the notice text)",
        replay !== null && replay !== undefined);
      check("7d: it names the CURRENT generation (gen=2, genBText's own) and the REPLAYED generation (gen=1, genAText's own)",
        replay?.gen === 2 && replay?.replayedGen === 1);
      check("7d: it records both the reported and intended lengths",
        replay?.reportedLen === genAText.length && replay?.intendedLen === genBText.length);
    }
  }

  // ===== 7b. Card 201d0d95 Q1 — the FALLBACK wording when no exact match is found in recentWrittenTurns
  // (e.g. the replayed content isn't from this session's own recent writes at all, or fell outside the
  // ring's window) still gives the reader the same measured guidance — check the immediately preceding
  // message — rather than a bare "unknown". =====
  {
    const sid = newSession("G2"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const genText = "[loom:worker-report] worker CCCC — this session's own only real report";
    const unrelatedReported = "content that never came from anything this session itself wrote";
    host.enqueueStdin(sid, genText); // gen=1
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: unrelatedReported }); // byteIdentical=false, no ring match
    // Same barrier as scenario 7 above (not flagged by the guard's own 5-line window here, but the SAME
    // shape/risk — fixed for real consistency, not just to satisfy the scanner).
    const enqueued7b = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7b: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7b);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7b: an unmatched replay still fires the notice", noticeWrite.includes("[loom:prompt-mismatch]"));
    check("7b: the fallback still points at the IMMEDIATELY PRECEDING submission as the measured pattern",
      /IMMEDIATELY PRECEDING/.test(noticeWrite) && /could not be matched directly/.test(noticeWrite));
    check("7b: the fallback never asserts a cause either", !/\bbecause\b/i.test(noticeWrite));
    // Card 68459420 DoD-2/DoD-3: an UNMATCHED mismatch is NOT an established replay — the notice must keep
    // the more cautious "possible LOSS" framing (never "ESTABLISHED"), since this specific content could
    // not be matched to any of this session's own recent writes.
    check("7b: an unmatched mismatch keeps the cautious 'possible LOSS' framing, never asserts ESTABLISHED",
      /may not have reached you/.test(noticeWrite) && !/ESTABLISHED/.test(noticeWrite));
    // Card 68459420 DoD-1: the sender-directed signal is SPECIFIC to a recognized replay — an unmatched
    // mismatch must NOT set it (there is no confirmed prior generation to name as replayed).
    check("7b: getLastMismatchReplay stays null for an UNMATCHED mismatch (nothing to attribute the replay to)",
      host.getLastMismatchReplay(sid) === null);
  }

  // ===== 7c. Card 201d0d95 Q1 — manager review: `findLast`, not `find`. Loom's own `warning`-kind nudges
  // re-send byte-identical text by construction, so the SAME text can legitimately appear at more than one
  // generation in `recentWrittenTurns`. Identical text at a NON-ADJACENT earlier generation (gen 1) and the
  // immediately-preceding one (gen 3), then a replay of gen 3's text at gen 4: `find` would return the
  // OLDEST match (gen 1) and wrongly take the "unusual shape" branch; `findLast` must return gen 3 and take
  // the "IMMEDIATELY PRECEDING" branch — the correct, actual replay generation. =====
  {
    const sid = newSession("G3"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const repeated = "[loom:idle] this session appears idle — checking in"; // realistic repeated-nudge shape
    const distinct = "[loom:worker-report] worker DDDD — unrelated distinct content";
    const genFourText = "[loom:worker-report] worker EEEE — generation 4's own real report, never delivered";

    host.enqueueStdin(sid, repeated); // gen=1: repeated text, first occurrence
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, distinct); // gen=2: unrelated, sits between the two repeated occurrences
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: distinct });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, repeated); // gen=3: repeated text AGAIN — this is the true "immediately preceding" occurrence
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, genFourText); // gen=4: Loom writes genFourText, but the engine replays gen=3's text
    const writesBeforeMismatch = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: repeated }); // byteIdentical=false
    // Same barrier as scenario 7 (manager review, card 201d0d95 — fixed-wait-negative-guard caught this
    // site's ORIGINAL fixed-duration wait too): poll for the real enqueue event, don't guess a duration.
    const enqueued7c = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7c: the deferred notice actually enqueues (a real observed event, not assumed)", enqueued7c);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("7c: findLast picks the MOST RECENT match (gen=3), not the oldest (gen=1)", /gen=3\b/.test(noticeWrite));
    check("7c: correctly takes the IMMEDIATELY PRECEDING branch, not the misleading 'unusual shape' one",
      /IMMEDIATELY PRECEDING/.test(noticeWrite) && !/not the immediately preceding one/.test(noticeWrite));
    check("7c: does NOT manufacture false counter-evidence by citing the stale gen=1 match", !/gen=1\b/.test(noticeWrite));
    // Card 68459420 DoD-1: the durable signal must agree with findLast's own correct pick (gen=3), not the
    // stale gen=1 match — proving the sender-directed arm shares the SAME discriminator as the notice text,
    // never a separately (and possibly differently) computed one.
    {
      const replay = host.getLastMismatchReplay(sid);
      check("7c: getLastMismatchReplay also picks the MOST RECENT match (replayedGen=3), not the stale gen=1",
        replay?.replayedGen === 3 && replay?.gen === 4);
    }
  }

  // ===== 8. Card 201d0d95 Q1 — NEGATIVE (positive control's other direction, mandatory per this project's
  // own standing rule): an ORDINARY, byteIdentical=true turn must produce NO notice at all — proving the
  // new surfacing logic doesn't fire on every turn regardless of correctness. This is the half most likely
  // to break while building the first (per the kickoff's own warning), since it's easy to accidentally hang
  // the new code off a broader condition than "mismatch only". =====
  {
    const sid = newSession("H"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const text = "an entirely ordinary, correctly-delivered turn";
    host.enqueueStdin(sid, text);
    const writesBeforeTurn = fake.writes.length;
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text }); // byteIdentical=true — the mismatch-scheduling branch in host.ts is never entered
    // Manager review, card 201d0d95: this is the "coin that lands heads" case flagged by fixed-wait-negative-
    // guard — there is no POSITIVE event to poll for here, since we're proving the ABSENCE of exactly that
    // event, so a `waitUntil` barrier (as used in scenarios 7/7b/7c above) doesn't apply. Instead of guessing
    // a duration, wait for a PROVEN-sufficient, deterministic ordering fact: the ONLY thing that could
    // produce a false positive is the SAME `setTimeout(fn, 0)` the real notice uses (host.ts, scheduled
    // synchronously inside THIS hook's own handling if it were ever wrongly called) — by the time a
    // LATER-registered `setTimeout(_, 0)` resolves, any such callback is GUARANTEED to have already run,
    // since macrotasks execute FIFO. One tick is not a guess; it's the exact bound this mechanism can ever
    // need. The check reads host.getPendingEntries SYNCHRONOUSLY right after, with no further await in
    // between — the same "observe, then assert instantly" shape as the barrier above, just anchored to a
    // proven tick-count instead of an observed flag.
    // TIMING-GUARD-SAFE: sync-probe-no-macrotask — waits only for the KNOWN-required single macrotask tick
    // (see the paragraph above for why exactly one tick is provably sufficient, not assumed); the negative
    // check below runs synchronously immediately after, with no further await in between.
    await new Promise((r) => setTimeout(r, 0));
    check("8: NEGATIVE CONTROL — an ordinary byteIdentical=true turn never enqueues a prompt-mismatch notice",
      !hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" }); // completes the turn and drains — queue already proven empty of any notice
    const afterTurn = fake.writes.slice(writesBeforeTurn).join("");
    check("8: and correspondingly nothing resembling the notice ever reached the pty either",
      !afterTurn.includes("[loom:prompt-mismatch]"));
  }

  // ===== 9. Card cf2fef73 DoD-4(b) — THE SAFETY CASE: a genuine content substitution, matching this same
  // investigation's own real specimen (intendedLen=9709 reportedLen=10332 lenDelta=623 divergesAtChar=6) —
  // recovered as 7 queued messages via inbox_pull, so content really was displaced. This MUST keep
  // surfacing the session-facing notice: a fix that silences it is worse than the bug being fixed here.
  // This is the load-bearing "keep this RED" case — whitespace normalization must NOT reconcile it, since
  // the divergence is genuine differing CONTENT (not whitespace re-rendering). Synthesizes text of the real
  // specimen's exact byte lengths (the literal historical bytes were never captured/retrievable), same
  // convention as pty-composer-accumulation.mjs's own scenario 1. =====
  {
    const sid = newSession("RealSubstitution"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const sharedPrefix = "shared"; // 6 identical chars, matching the specimen's divergesAtChar=6
    const intended = sharedPrefix + "i".repeat(9709 - 6); // intendedLen=9709
    const reported = sharedPrefix + "r".repeat(10332 - 6); // reportedLen=10332, lenDelta=+623
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("9: reproduces the real specimen's exact shape (intendedLen=9709 reportedLen=10332 lenDelta=623 divergesAtChar=6)",
      /intendedLen=9709\b/.test(warnings[0] ?? "") && /reportedLen=10332\b/.test(warnings[0] ?? "") && /lenDelta=623\b/.test(warnings[0] ?? "") && /divergesAtChar=6\b/.test(warnings[0] ?? ""));
    const enqueued9 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("9: THE SAFETY CASE — a genuine content substitution still enqueues the session-facing notice (never suppressed by whitespace normalization)", enqueued9);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("9: the notice actually reached the pty", noticeWrite.includes("[loom:prompt-mismatch]"));
  }

  // ===== 10. Card cf2fef73 (manager review) — THE SAFETY CASE for the placeholder-prefix suppression
  // (scenario 6c): a placeholder that REPLACED real content instead of merely prefixing it — the measured
  // shape (a real specimen with lenDelta=-579, `reported` SHORTER than `intended`, a genuine loss) — must
  // NOT be suppressed. The exact-prefix check is deliberately narrow (`reported === placeholder +
  // intended`, byte-for-byte) precisely so a placeholder that stands ALONE (or is followed by anything
  // other than the exact intended text) still fires loudly — this is the load-bearing "keep this RED"
  // case for the second suppression rule, same role scenario 9 plays for the first. =====
  {
    const sid = newSession("PlaceholderReplacement"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const intended = "a".repeat(700) + " — the real content that got replaced, not merely prefixed by a placeholder";
    const reported = "[Pasted text #7 +12 lines]"; // the placeholder ALONE: reported is SHORTER than intended (same direction as the measured lenDelta=-579 specimen) — a genuine loss, not a benign prefix
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("10: reported is SHORTER than intended (the genuine-loss direction, not the benign-prefix direction)", reported.length < intended.length);
    check("10: reported starts with a placeholder-shaped prefix (the exact-prefix check's candidate match, but the remainder does NOT equal intended)",
      /^\[Pasted text #\d+ \+\d+ lines\]/.test(reported));
    const enqueued10 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("10: THE SAFETY CASE — a placeholder that REPLACED content (not merely prefixed it) still enqueues the session-facing notice", enqueued10);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("10: the notice actually reached the pty", noticeWrite.includes("[loom:prompt-mismatch]"));
  }

  // ===== 11. Card cf2fef73 (manager review CORRECTION) — THE SAFETY CASE for the no-line-count placeholder
  // form (scenario 6d): the manager's own measurement found form-2 ALSO spans both benign and real classes
  // (deltas 16/16/5084/-5224/-4179 — three of five NOT pure prefixes, two NEGATIVE). A `[Pasted text #N]`
  // (no line count) that REPLACED content instead of prefixing it must still fire — same role as scenario
  // 10, for the widened regex. =====
  {
    const sid = newSession("PlaceholderNoCountReplacement"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const intended = "b".repeat(600) + " — real content genuinely replaced by a no-line-count placeholder, not merely prefixed";
    const reported = "[Pasted text #9]"; // the placeholder ALONE, no line count: reported is SHORTER than intended (matches the manager's measured negative-delta direction for form 2) — a genuine loss
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("11: reported is SHORTER than intended (the genuine-loss direction)", reported.length < intended.length);
    check("11: reported matches the no-line-count placeholder shape (the widened regex's candidate match, but the remainder does NOT equal intended)",
      /^\[Pasted text #\d+\]/.test(reported));
    const enqueued11 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("11: THE SAFETY CASE — a no-line-count placeholder that REPLACED content still enqueues the session-facing notice", enqueued11);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("11: the notice actually reached the pty", noticeWrite.includes("[loom:prompt-mismatch]"));
  }

  // ===== 12. Card cf2fef73 (manager review CORRECTION #2) — THE SAFETY CASE for the global stacked-prefix
  // strip (scenario 6e): the SAME mixed-form placeholder run, but the remainder does NOT equal `intended`
  // — a real substitution hiding behind a stacked placeholder run, not merely prefixed by one. The global
  // strip only consumes the LEADING run; whatever remains after it must still equal `intended` exactly,
  // so this must keep firing loudly, same role as 10/11 for the single-placeholder forms. =====
  {
    const sid = newSession("PlaceholderStackReplacement"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const intended = "c".repeat(650) + " — the real content that got replaced, hidden behind a stacked placeholder run";
    // The same three-placeholder run as scenario 6e, but followed by unrelated content instead of the
    // exact intended text — the global strip still consumes the leading run, but the remainder mismatches.
    const reported = "[Pasted text #11][Pasted text #12 +38 lines][Pasted text #13 +40 lines]" + "completely different content, not the intended text at all";
    host.enqueueStdin(sid, intended);
    const writesBeforeMismatch = fake.writes.length;
    const warnings = captureMismatchWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("12: reported starts with the same stacked placeholder run as the benign scenario 6e (the global strip's candidate match)",
      /^\[Pasted text #11\]\[Pasted text #12 \+38 lines\]\[Pasted text #13 \+40 lines\]/.test(reported));
    const enqueued12 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("12: THE SAFETY CASE — a stacked placeholder run whose remainder does NOT match intended still enqueues the session-facing notice", enqueued12);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("12: the notice actually reached the pty", noticeWrite.includes("[loom:prompt-mismatch]"));
  }

  // ===== 13. Card 68459420 DoD-3 — CHARACTERIZE (never suppress) the FOURTH population: reported LONGER
  // than intended AND matching NO recent write of this session (the manager's own gen=12 specimen: wrote
  // 2985, reported 3829). Distinct from every other shape above — not a benign whitespace re-render, not a
  // stale-placeholder prefix (doesn't start with the placeholder token), not a recognized replay (doesn't
  // match anything in recentWrittenTurns). Must: (a) log a DISTINCT, greppable diagnostic tag so this
  // population can be measured going forward, (b) still fire the ordinary session-facing notice with the
  // cautious "possible LOSS" framing (never ESTABLISHED — this is NOT a recognized replay), and (c) NOT set
  // the sender-directed getLastMismatchReplay signal (there's no confirmed prior generation to attribute it
  // to) — proving DoD-3's own constraint that no rule/suppression was invented for this shape. =====
  {
    const sid = newSession("UnmatchedLonger"); SIDS.push(sid);
    const fake = fakesById.get(sid);
    const intended = "[loom:from-manager] some real, correctly-submitted message content";
    const reported = intended + " — plus unexplained trailing content that came from nowhere this session wrote";
    host.enqueueStdin(sid, intended); // gen=1 — the only entry in recentWrittenTurns, and it does NOT equal `reported`
    const writesBeforeMismatch = fake.writes.length;
    const unmatchedWarnings = captureUnmatchedLongerWarnings(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("13: reported is LONGER than intended (the shape this population is defined by)", reported.length > intended.length);
    check("13: the DISTINCT [prompt-mismatch-unmatched-longer] characterization tag fires exactly once", unmatchedWarnings.length === 1);
    check("13: the tag reports the observed fields (lengths + delta) and names it UNCHARACTERIZED",
      /reportedLen=\d+/.test(unmatchedWarnings[0] ?? "") && /intendedLen=\d+/.test(unmatchedWarnings[0] ?? "") &&
      /lenDelta=\d+/.test(unmatchedWarnings[0] ?? "") && /UNCHARACTERIZED/.test(unmatchedWarnings[0] ?? ""));
    const enqueued13 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("13: the ordinary session-facing notice still fires (characterization is additive, not a suppression)", enqueued13);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeWrite = fake.writes.slice(writesBeforeMismatch).join("");
    check("13: the notice keeps the cautious 'possible LOSS' framing — this is NOT a recognized replay",
      /may not have reached you/.test(noticeWrite) && !/ESTABLISHED/.test(noticeWrite));
    check("13: no rule/suppression was invented for this shape — getLastMismatchReplay stays null",
      host.getLastMismatchReplay(sid) === null);
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the frame-splice detector (card 7114838d) FIRES on a synthesized mismatch and names the divergence point (self-classifying via lenDelta + both tail lengths — a real splice's large tails read differently from a benign trailing artifact's tiny ones), stays SILENT on a matching pair, is correctly GATED on submitWasOutstanding (never misfires a raw human-typed turn against a stale lastPrompt), and is SELF-DIAGNOSING when the engine sends no usable prompt field (logs once per session, not once per turn). Card 201d0d95 Q1: a mismatch now SURFACES as its own pty submission to the affected session (previously LOG-ONLY) naming both the possible LOSS and the possible DUPLICATE (identifying the specific earlier generation when `recentWrittenTurns` still holds it) — and, the positive control's other, easier-to-break direction, an ordinary byteIdentical=true turn schedules no such notice at all. Card cf2fef73 (owner-reported false LOSS alarm): tail size alone cannot discriminate a benign whitespace re-render from a real splice (scenario 6b reproduces the owner's own tab-re-render specimen with LARGE-looking tails, same as a real splice) — so the session-facing notice is now gated on TWO precise, non-heuristic suppression checks, each with its own safety case proving it fails closed: whitespace-normalized equality (6b benign / 9 the real-substitution safety case, unchanged) and an exact stale-placeholder-prefix match — the strip is GLOBAL (one-or-more repetitions consumed as a single leading run, not a single-shot match) across BOTH measured placeholder forms and STACKED runs mixing them (6c: `[Pasted text #N +M lines]` / 6d: `[Pasted text #N]` with no line count / 6e: a real three-placeholder mixed-form stacked specimen, delta=71=17+27+27 / 10, 11, 12: the placeholder-that-replaced-content safety case for each shape — a single-shot strip would FAIL OPEN on a stacked run, firing the alarm on provably benign content, exactly the dense-multi-paste case where a false alarm costs the most) — all benign scenarios still log the diagnostic but never surface the session-facing notice, every safety case keeps firing it exactly as before. NOTE: this suite synthesizes every hook payload — it proves the detector's own logic, not that Claude Code actually sends `prompt` or reports it byte-identical; only the first real hook after deploy answers that."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
