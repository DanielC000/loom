// Card e59880fe — a Loom lead observed a RUN of `[loom:prompt-mismatch] … UNRECOGNIZED` notices (gens
// 50/53/54, session 425a4365, 2026-10-16) where `reported` was EXACTLY an earlier generation's own
// recorded write wrapped in the engine's pasted-content tag framing — but, unlike the SIBLING fix in
// pty-prompt-mismatch-pasted-content-wrap-replay.mjs (card dc92f4b6), the CURRENT generation's own
// intended text carried NO possible-duplicate tag at all (an ordinary new message, not a re-mint).
// `findRecognizedPastedContentWrapOfPriorWrite`'s own `strippedCurrent === currentIntendedText`
// short-circuit means it structurally never engages for this shape — these fell through to the loud
// `fallback-unrecognized` path and compounded (the notice itself became a later generation's own write,
// later echoed stale and wrapped in turn).
//
// THE BYTE SHAPE IS ALSO NOT `PASTED_CONTENT_WRAP_RE` (verified against the real specimens:
// `[prompt-mismatch-pasted-content-wrap-excess-declined] reason=regex-no-match` logged for the SAME
// `reported` string, and independently via the measured remainder lengths — 27/28 for a 4-char id,
// exactly 2/1 chars short of that regex's own 29/29 `\n\n…\n`/`…\n` overhead). It is the engine's bare
// tag framing alone: `<pasted_content id="X">\n` … `\n</pasted_content id="X">`, nothing else before/
// after.
//
// THE FIX (`matchPastedContentWrapFramingOfRemainder`, pty/host.ts): reuses `findRecognizedSubstring`'s
// own already-computed `leadingRemainder`/`trailingRemainder` (never a new, independent scan) and tests
// them against two anchored regexes requiring the SAME backreferenced id on both sides — never a
// substring/partial match on either side.
//
// SEVERITY: the SAME Code Review CRITICAL finding from dc92f4b6's own round 1 applies here unchanged —
// a wrap of an unrelated earlier generation does not establish THIS generation's own content arrived.
// So this does NOT classify as `confirmed-*`/benign: `wrappedReplayOfPriorWrite` is wired at the SAME
// severity as a bare `replayedEntry` match (a new arm, `fallback-wrapped-replay-awaiting-resolution`,
// mirroring `fallback-replay-awaiting-resolution` exactly — same exclusion list, same
// `checkPromptMismatchUnresolved` follow-up timer, same `mismatchResolvedGens` marking, NOT in
// `RECORD_ONLY_MISMATCH_ARMS`). Reclassifying away from `fallback-unrecognized` is what stops BOTH the
// `onPromptMismatchUnmatched` per-event escalation push AND the `UNRECOGNIZED_MISMATCH_RATE_THRESHOLD`
// counter for this shape — the card's own "compounds the noise" complaint.
//
// Surfaced via the EXISTING `lastMismatchReplay` pull surface (never a new top-level field) — `wrapped`/
// `wrapIdLen` are the only additions.
//
// Full root-cause narrative + "Do not" list: the "e59880fe" section of
// docs/decisions/dc92f4b6-pasted-content-wrap-can-replay-an-earlier-generation.md
//
// POSITIVE CONTROL, PER THIS REPO'S STANDING VERIFICATION POSTURE:
//   1. The real shape: generation 1 writes ordinary content, never confirmed; generation 2 is an
//      ORDINARY new message (no tag at all); the engine reports back generation 1's own recorded write
//      wrapped in the exact 27/28 (4-char id) bare-tag framing. Must fire the new log line, classify
//      `arm=fallback-wrapped-replay-awaiting-resolution`, mark ONLY generation 1 resolved (never
//      generation 2 — unlike dc92f4b6's own mechanism), populate `lastMismatchReplay` with
//      `wrapped:true, wrapIdLen:4`, must NOT push the manager escalation, and the session notice must
//      use REPLAY/possible-loss wording (never "NOT A LOSS"/"UNRECOGNIZED").
//   2. NEGATIVE CONTROL — a 27/28-length remainder that is NOT the wrap tag shape at all (plain
//      unrelated filler of the same lengths) — must stay UNRECOGNIZED, must still push.
//   3. NEGATIVE CONTROL — the wrap tag shape with MISMATCHED ids front/back — must stay UNRECOGNIZED,
//      must still push.
//   4. NEGATIVE CONTROL — the ORIGINAL `PASTED_CONTENT_WRAP_RE` double-leading-newline/single-trailing-
//      newline shape, on an ordinary (untagged) current generation — must classify EXACTLY as it did
//      before this fix (`fallback-unrecognized`, pushed) — this fix's narrower regex must not touch it.
//   5. POSITIVE CONTROL (wording) — a gap of 2 (not immediately preceding) between the wrapped
//      generation and the current one, exercising the "not the immediately preceding one" notice wording.
//
// Mirrors pty-prompt-mismatch-pasted-content-wrap-replay.mjs's own harness: the REAL PtyHost state
// machine + a FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-wrapped-remainder-replay.mjs (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrapped-remainder-replay-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

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
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-wrapped-remainder-replay: predicate" });
  } catch (err) {
    // _wait.mjs's own doc comment is canonical: discriminate via exhaustedOnThrow, never the message text (card 69547e0e).
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
};
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Captures console.log lines emitted synchronously during fn().
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string") lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

// Card e59880fe's own exact bare-tag shape — single newline after the opening tag, single newline before
// the closing tag, NO outer `\n\n`/trailing `\n` (that would be `PASTED_CONTENT_WRAP_RE`'s own, DIFFERENT
// shape — see pastedContentWrapDoubleNewline below for that one, used only in scenario 4).
const wrapRemainder = (id, inner) => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;
// The ORIGINAL dc92f4b6/`PASTED_CONTENT_WRAP_RE` shape — double leading newline, single trailing newline
// at the absolute start/end of `reported` — used ONLY by scenario 4 to prove this fix doesn't touch it.
const pastedContentWrapDoubleNewline = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL — the real shape: generation 1 writes ordinary content, never confirmed;
  // generation 2 is an ORDINARY new message (no tag at all, unlike dc92f4b6's own re-mint shape); the
  // engine reports back generation 1's own recorded write wrapped in the exact 27/28 (4-char id) bare-tag
  // framing. =====
  {
    const sid = newSession("WrappedRemainderReplay"); SIDS.push(sid);
    const genOneText = "K".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    const ordinaryNewMessage = "Z".repeat(10); // gen=2 — an ORDINARY new message, no tag of any kind
    host.enqueueStdin(sid, ordinaryNewMessage); // gen=2, now written and current
    const reported = wrapRemainder("pcwr", genOneText);
    check("SETUP: the wrap's leading/trailing remainder are exactly 27/28 chars for a 4-char id",
      reported.length - genOneText.length === 27 + 28);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const replayLines = lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] "));
    check("1: POSITIVE CONTROL — [prompt-mismatch-pasted-content-wrap-remainder-replay] fires", replayLines.length === 1);
    check("1: it names the recognized generation (gen=1), matchedLen=500, and wrapIdLen=4",
      /recognizedGen=1\b/.test(replayLines[0] ?? "") && /matchedLen=500\b/.test(replayLines[0] ?? "") && /wrapIdLen=4\b/.test(replayLines[0] ?? ""));

    const armLines = lines.filter((l) => l.startsWith("[prompt-mismatch-arm] "));
    check("1: the [prompt-mismatch-arm] log names arm=fallback-wrapped-replay-awaiting-resolution",
      armLines.length === 1 && /\barm=fallback-wrapped-replay-awaiting-resolution\b/.test(armLines[0] ?? ""));

    // THE RED->GREEN PIVOT: before this fix, this exact specimen fell to `isUnmatchableMismatch`
    // (the real, measured production shape — arm=fallback-unrecognized, pushed to the manager).
    check("1: RED-PROOF — NO LONGER classified as unmatchable (getLastMismatchUnmatched stays null)",
      host.getLastMismatchUnmatched(sid) === null);
    // `[prompt-mismatch-unmatched-remainder]` is logged unconditionally as soon as `unmatchedRecognized`
    // is found (diagnostic-only, before this fix's own check even runs) — this fix REUSES that same
    // result rather than re-querying, so the diagnostic line co-occurring is expected, not a defect.
    check("1: the plain partial-recognition diagnostic ALSO fires (enrichment, reused by this fix, never suppressed)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ") && /recognizedGen=1\b/.test(l)).length === 1);

    // Severity: this is NOT confirmed-benign — populates the SAME `lastMismatchReplay` pull surface a
    // bare replay uses, discriminated only by `wrapped`/`wrapIdLen`.
    const replay = host.getLastMismatchReplay(sid);
    check("1: lastMismatchReplay is set with wrapped:true, wrapIdLen:4, replayedGen:1, explainedBenign:null",
      replay !== null && replay.wrapped === true && replay.wrapIdLen === 4 && replay.replayedGen === 1 && replay.explainedBenign === null);
    check("1: lastMismatchFusion / lastMismatchPastedContentWrapReplay stay null (not that arm, not dc92f4b6's own arm)",
      host.getLastMismatchFusion(sid) === null && host.getLastMismatchPastedContentWrapReplay(sid) === null);

    // Mirrors `replayedEntry`'s own marking exactly: ONLY the matched prior gen is resolved, never the
    // current one (unlike dc92f4b6's own mechanism, which marks both).
    const live = host.live.get(sid);
    check("1: generation 1 (the matched prior write) IS marked resolved", live.mismatchResolvedGens.has(1));
    check("1: generation 2 (the current, ordinary message) is NOT marked resolved", !live.mismatchResolvedGens.has(2));

    // THE CARD'S OWN root symptom: the manager-facing "possible LOSS" push must NOT fire for this arm.
    check("1: REQUIRED — [prompt-mismatch-unmatched-pushed] does NOT fire (the false manager escalation this card exists to stop)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);

    // The session-facing notice itself: REPLAY/possible-loss wording, never "NOT A LOSS"/"UNRECOGNIZED".
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("1: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("your next report up."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("1: REQUIRED — the notice uses REPLAY wording, never \"NOT A LOSS\"", /is a REPLAY of an earlier generation/.test(noticeText) && !/NOT A LOSS/.test(noticeText));
    check("1: REQUIRED — it does NOT use the UNRECOGNIZED third-state wording", !/UNRECOGNIZED, NOT AN ESTABLISHED LOSS/.test(noticeText));
    check("1: it names generation 1 and the wrap-stripping mechanism in the replay note",
      /once the engine's own pasted-content wrap tag framing is stripped.*generation 1/.test(noticeText));
    check("1: disclosure-safe — no raw content leaks (the repeated gen=1 character never appears bare)",
      !noticeText.includes(genOneText));
  }

  // ===== 2. NEGATIVE CONTROL — a 27/28-length remainder that is NOT the wrap tag shape at all (plain
  // unrelated filler of the SAME lengths as scenario 1's real framing) — must stay UNRECOGNIZED. =====
  {
    const sid = newSession("NonFramingSameLengthRemainder"); SIDS.push(sid);
    const genOneText = "L".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const ordinaryNewMessage = "Y".repeat(10);
    host.enqueueStdin(sid, ordinaryNewMessage); // gen=2
    const reported = `${"P".repeat(27)}${genOneText}${"Q".repeat(28)}`;
    check("SETUP: the remainder lengths are the SAME 27/28 as scenario 1's real framing", reported.length - genOneText.length === 27 + 28);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("2: NEGATIVE CONTROL — [prompt-mismatch-pasted-content-wrap-remainder-replay] does NOT fire on non-framing filler",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);
    check("2: still classified as unmatchable (arm=fallback-unrecognized), exactly as before this fix",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("2: REQUIRED — the manager push STILL fires for a genuine, unrecognized divergence",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
  }

  // ===== 3. NEGATIVE CONTROL — the wrap tag shape with MISMATCHED ids front/back — must stay
  // UNRECOGNIZED (the backreference equality check must actually gate something). =====
  {
    const sid = newSession("MismatchedIdsFrontBack"); SIDS.push(sid);
    const genOneText = "M".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const ordinaryNewMessage = "X".repeat(10);
    host.enqueueStdin(sid, ordinaryNewMessage); // gen=2
    const reported = `<pasted_content id="aaaa">\n${genOneText}\n</pasted_content id="bbbb">`;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("3: NEGATIVE CONTROL — mismatched ids front/back do NOT confirm",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);
    check("3: still classified as unmatchable (arm=fallback-unrecognized)",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("3: REQUIRED — the manager push STILL fires",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
  }

  // ===== 4. NEGATIVE CONTROL — the ORIGINAL `PASTED_CONTENT_WRAP_RE` double-leading-newline/single-
  // trailing-newline shape, on an ORDINARY (untagged) current generation. This fix's narrower regex must
  // NOT touch this shape — it must classify EXACTLY as it did before this fix: `fallback-unrecognized`,
  // pushed (dc92f4b6's own scenario 4 proves the SAME shape declines when a re-mint tag IS present; this
  // proves the sibling fix doesn't accidentally widen that boundary either). =====
  {
    const sid = newSession("DoubleNewlineShapeUnchanged"); SIDS.push(sid);
    const genOneText = "N".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const ordinaryNewMessage = "W".repeat(10);
    host.enqueueStdin(sid, ordinaryNewMessage); // gen=2
    const reported = pastedContentWrapDoubleNewline("pcwr", genOneText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("4: this fix's own new log line does NOT fire for the double-newline shape",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);
    // `PASTED_CONTENT_WRAP_RE` itself still matches this shape (it's valid for the CURRENT generation's
    // own wrap check), but declines because the inner (500 chars) isn't within 1-2 chars of the current
    // generation's own 10-char intended — so it logs the EXISTING excess-decline diagnostic, unchanged.
    check("4: the EXISTING wrap-excess decline diagnostic still fires, unaffected by this fix",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-excess-declined] ")).length === 1);
    check("4: still classified as unmatchable (arm=fallback-unrecognized) — UNCHANGED from before this fix",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("4: REQUIRED — the manager push STILL fires — UNCHANGED from before this fix",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
  }

  // ===== 5. POSITIVE CONTROL (wording) — a gap of 2 (not immediately preceding) between the wrapped
  // generation and the current one, matching the REAL specimens' own gaps (2-4) more closely than
  // scenario 1's minimal 2-generation setup, and exercising the "not the immediately preceding one"
  // notice wording branch. =====
  {
    const sid = newSession("NotImmediatelyPrecedingWording"); SIDS.push(sid);
    const genOneText = "R".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "S".repeat(10); // gen=2 — an ordinary message, confirmed cleanly in between
    host.enqueueStdin(sid, genTwoText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genTwoText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genThreeText = "T".repeat(10); // gen=3 — the CURRENT, ordinary new message
    host.enqueueStdin(sid, genThreeText);
    const reported = wrapRemainder("pcwr", genOneText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const replayLines = lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] "));
    check("5: POSITIVE CONTROL — fires across a gap of 2 (gen=1 recognized from gen=3)", replayLines.length === 1 && /recognizedGen=1\b/.test(replayLines[0] ?? ""));
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    await waitUntil(() => hasPendingMismatchNotice(sid));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("your next report up."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("5: the notice wording says NOT the immediately preceding one", /\(not the immediately preceding one\)/.test(noticeText));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card e59880fe's own gap is closed: an UNTAGGED current generation's otherwise-unmatched remainder, when it is EXACTLY the engine's bare pasted-content tag framing (id-backreferenced) around an earlier generation's own recorded write, is now classified as a NAMED, WRAPPED replay (arm=fallback-wrapped-replay-awaiting-resolution) at the SAME severity as a bare replay — never confirmed-benign (dc92f4b6's own Code Review CRITICAL finding still applies) — no longer falsely classified as unmatchable, no longer pushes the manager's false possible-LOSS escalation, and surfaces via the EXISTING lastMismatchReplay pull surface (wrapped:true, wrapIdLen) rather than a new field. A non-framing same-length remainder, a mismatched-id wrap, and the ORIGINAL double-newline PASTED_CONTENT_WRAP_RE shape on an untagged generation all still classify exactly as before this fix."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
