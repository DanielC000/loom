// Card 37acd59f — tell a WRAP OF THE CURRENT GENERATION apart from a REPLAY of an earlier generation with
// byte-identical text.
//
// THE GAP: when the current generation's own intended text is byte-identical to an earlier generation's
// own recorded write (e.g. "continue" sent twice), and the engine bare-wraps the CURRENT generation in the
// narrow 27/28 (4-char id) paste framing, `findRecognizedSubstring` (host.ts) matches the EARLIER entry —
// it is the most recent entry in `live.recentWrittenTurns` whose text is a substring of `reported`, and it
// never compares against the CURRENT generation's own intended text at all. `matchPastedContentWrapFraming
// OfRemainder` (card e59880fe) then confirms the bare-tag framing around that match, producing
// `wrappedReplayOfPriorWrite` attributed to the EARLIER generation. The session is told it received a
// REPLAY of the earlier generation and that its OWN text may not have arrived — when it did — and the
// current generation's own `checkPromptMismatchUnresolved` follow-up timer gets armed (keyed to the
// current generation, which this path never marks resolved), a false-alarm precondition.
//
// THE FIX: `isRecognizedBarePastedContentWrapOfCurrent` (host.ts) — the bare-tag-framing TWIN of
// `isRecognizedPastedContentWrap` (the full-framing, dc92f4b6/7c1487c8 case). It proves, or doesn't, that
// `reported` (this exact bare-tag shape stripped) is byte-for-byte what THIS generation itself intended —
// but that fact ALONE does not establish which generation's content this is: see ROUND 2 below.
//
// ROUND 2 (Code Review BLOCKING, a real lag-by-one-chain specimen, session a7c072c4, 2026-10-18): the
// first cut of this fix marked the current generation resolved and fully silenced the notice whenever
// `isRecognizedBarePastedContentWrapOfCurrent` matched, UNCONDITIONALLY. That is unsound exactly when an
// EARLIER ring entry's own recorded write is ALSO identical to `intended` (the card's own "continue sent
// twice" shape, scenario (a) below) — `wrappedReplayOfPriorWrite` ALSO matches that same entry from the
// SAME echo, and the pre-existing code already marks THAT generation resolved unconditionally. Resolving
// BOTH generations from one echo is the exact double-resolution bug `7a64f16b` already warns against (one
// echo resolves at most one lineage) — if the current generation's own real content never separately
// arrives, this silenced its own genuine loss forever.
//
// ROUND 3 (Code Review BLOCKING, the CR's own probe): Round 2's ambiguity signal (`unmatchedRecognized !==
// null`) was too broad — `findRecognizedSubstring` fires on ANY earlier ring entry that is merely a
// substring of `reported`, with no minimum length and no requirement that it actually resolves anything.
// Scenario (f) below is the CR's own probe: gen=1 writes "ok", gen=2 intended "ok, continue with the plan"
// (bare-wrapped) — "ok" IS a substring of the wrap's inner, so Round 2's signal called this ambiguous, but
// `wrappedReplayOfPriorWrite` never fires for it (the remainder around "ok" is NOT exactly the tag framing
// — see host.ts's `PASTED_CONTENT_WRAP_REMAINDER_SUFFIX_RE`, anchored both ends), so nothing about gen=1
// was actually resolved by this echo and there is no genuine double-resolution risk. THE RULING (manager):
// ambiguity means "this echo ACTUALLY resolved another generation" — `bareWrapOfCurrentAmbiguous = isBare
// && (wrappedReplayOfPriorWrite !== null || replayedEntry !== undefined)`. A mere substring match that
// resolves nothing is not a competing claim.
//
// POSITIVE CONTROLS (unambiguous — no generation was actually resolved by this echo):
//   (d) GEN=2's TEXT UNRELATED TO GEN=1, bare-wrapped gen=2's OWN (unrelated) text — NO ring match at all,
//       so unambiguous. Proves the new check does NOT depend on the ring: before this fix this shape fell
//       to `fallback-unrecognized` (nothing else in this file recognized "a bare wrap of the current
//       generation's own, otherwise-unrelated-to-the-ring content" at all).
//   (f) ROUND 3's OWN PROBE — gen=1 writes "ok", gen=2 (current) writes "ok, continue with the plan"
//       (bare-wrapped). "ok" is a substring of the wrap's inner, but `wrappedReplayOfPriorWrite` never
//       fires (the remainder isn't exactly the tag framing) — nothing was actually resolved by this echo,
//       so this must stay unambiguous: fully silent, gen=2 resolved, no notice, no timer.
//
// AMBIGUOUS — PROVEN STILL LOUD (an earlier generation WAS actually resolved by this echo):
//   (a) THE CARD'S OWN REPRO — gen=1 writes "continue", never confirmed; gen=2 (current) ALSO writes
//       "continue" (byte-identical). An earlier ring entry (gen=1) ALSO matches this echo via
//       `wrappedReplayOfPriorWrite`, so per the ruling above this must classify EXACTLY as
//       `fallback-wrapped-replay-awaiting-resolution` (loud, timer armed for gen=2, only gen=1 marked
//       resolved) — the new check fires its own diagnostic log (ambiguous=true) but confirms nothing. See
//       PART 10 of pty-prompt-mismatch-unresolved.mjs for the companion proof that the timer this scenario
//       arms actually FIRES when never resolved.
//   (g) THE `replayedEntry` ARM (Round 3's Minor 3, the OTHER competing marker): gen=1's own LITERAL
//       submitted text IS the exact bare-wrap string the engine later echoes for gen=2's own (different,
//       shorter) intended text — a contrived but constructible shape (nothing sanitizes what Loom itself
//       submits). `replayedEntry` (not `wrappedReplayOfPriorWrite`) fires here, marking gen=1 resolved via
//       the PRE-EXISTING, unconditional `replayedEntry` marking (host.ts ~:9333) — the new check must
//       defer to THIS marker too, not just the wrapped one, closing the double-resolution risk on BOTH
//       competing markers.
//
// NEGATIVE CONTROLS:
//   (b) IDENTICAL-LENGTH ONE-BYTE DIVERGENCE — the wrap's inner differs from `intended` by exactly one
//       byte (same length) — must NOT confirm; classifies exactly as it did before this fix.
//   (c-1) A WRAP WHOSE INNER MERELY CONTAINS `intended` (extra bytes inside the same tag framing) — must
//       NOT confirm — the anchored regex's own discipline, never a substring match.
//   (c-2) MISMATCHED IDS FRONT/BACK on an otherwise-exact bare wrap of `intended` — must NOT confirm —
//       the backreference equality check must actually gate something.
//   (e) card e59880fe's OWN population (the genuinely-unrelated wrapped replay, PART 9 of
//       pty-prompt-mismatch-unresolved.mjs) is reproduced HERE too and must stay LOUD — this fix must
//       never widen to cover a wrap of an earlier generation whose content is NOT identical to the
//       current generation's own intended text.
//
// Mirrors pty-prompt-mismatch-wrapped-remainder-replay.mjs's own harness: the REAL PtyHost state machine +
// a FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-bare-wrap-of-current.mjs (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-bare-wrap-of-current-${Date.now()}-${process.pid}`);
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-bare-wrap-of-current: predicate" });
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

const wrapRemainder = (id, inner) => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;

const NEW_TAG = "[prompt-mismatch-bare-pasted-content-wrap-of-current] ";

const SIDS = [];

try {
  // ===== (a) AMBIGUOUS — PROVEN STILL LOUD (Round 2, Code Review BLOCKING): THE CARD'S OWN REPRO: gen=1
  // writes "continue", never confirmed; gen=2 (current) ALSO writes "continue" (byte-identical); the
  // engine bare-wraps the report. An earlier ring entry (gen=1) ALSO matches this echo via
  // `wrappedReplayOfPriorWrite`, so the new check must NOT confirm-benign here — see PART 10 of
  // pty-prompt-mismatch-unresolved.mjs for the companion proof that the armed timer actually fires. =====
  {
    const sid = newSession("DuplicateTextBareWrap"); SIDS.push(sid);
    const DUP_TEXT = "continue";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, own intended text IS "continue" too
    const reported = wrapRemainder("abcd", DUP_TEXT);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("a: the new recognition log fires, naming gen=2's own lengths and ambiguous=true (no content)",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 reportedLen=63 intendedLen=8 ambiguous=true /.test(l)));
    check("a: the log line uses CONTENT-IDENTITY wording only — never a lineage claim (dc92f4b6's own discipline)",
      lines.some((l) => l.startsWith(NEW_TAG) && /content-identical to THIS generation's own intended text/.test(l) && !/NOT A REPLAY/.test(l)));
    check("a: the OLD wrapped-replay-of-prior-write log ALSO still fires (diagnostic, pre-existing, unsuppressed)",
      lines.some((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ") && /recognizedGen=1\b/.test(l)));
    check("a: REQUIRED — [prompt-mismatch-arm] DOES fire, classified EXACTLY as the pre-existing wrapped-replay arm (the new check defers, never gates this case)",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("a: REQUIRED — the manager's possible-LOSS push does NOT fire for this arm (unchanged from e59880fe's own fix, not this card's concern)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);

    const live = host.live.get(sid);
    check("a: REQUIRED (Round 2 fix) — gen=2 (current) is NOT marked resolved — the double-resolution bug this round closes", !live.mismatchResolvedGens.has(2));
    check("a: gen=1 (the matched earlier entry) IS marked resolved — unaffected, unconditional, as before this card ever existed", live.mismatchResolvedGens.has(1));
    check("a: REQUIRED (Round 2 fix) — the unresolved-timer IS armed for gen=2 — identical text must never disarm it", live.pendingMismatchUnresolvedTimers.size === 1);
    check("a: lastMismatchReplay IS populated (wrapped:true, replayedGen:1) — the pre-existing loud surface, unaffected",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1 && host.getLastMismatchReplay(sid)?.wrapped === true);

    // The session-facing notice DOES enqueue (loud), with REPLAY wording — unlike the old, wrongly-silent
    // first cut of this fix.
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("a: REQUIRED (Round 2 fix) — the mismatch notice DOES enqueue (loud, not silenced)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("your next report up.") || fake.writes.slice(writesBefore).join("").includes("check the message sent for that generation."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("a: the notice uses REPLAY wording, never \"NOT A LOSS\"", /is a REPLAY of an earlier generation/.test(noticeText) && !/NOT A LOSS/.test(noticeText));
  }

  // ===== (g) AMBIGUOUS via the `replayedEntry` ARM (Round 3, Minor 3): gen=1's own LITERAL submitted
  // text IS the exact bare-wrap string the engine later echoes for gen=2's own (different) intended text.
  // `replayedEntry` (the whole-string-match marker, NOT `wrappedReplayOfPriorWrite`) fires here — proving
  // the ambiguity guard must defer to BOTH competing markers, not just the wrapped one. =====
  {
    const sid = newSession("ReplayedEntryAmbiguous"); SIDS.push(sid);
    const payload = "payload-text-g";
    const wrappedLiteral = wrapRemainder("abcd", payload); // gen=1's own literal text IS the wrap string
    host.enqueueStdin(sid, wrappedLiteral); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, payload); // gen=2 — CURRENT, own intended text is just the payload
    const reported = wrapRemainder("abcd", payload); // engine's bare-wrap of gen=2's own echo happens to
                                                       // equal gen=1's literal text byte-for-byte
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("g: the new recognition log fires with ambiguous=true, resolvedPriorGen=1 (via the replayedEntry arm, not wrapped)",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=true/.test(l) && /resolvedPriorGen=1/.test(l)));
    check("g: REQUIRED — [prompt-mismatch-arm] fires classified as the BARE replay arm (fallback-replay-awaiting-resolution), never the wrapped sibling",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-replay-awaiting-resolution\b/.test(l)));
    check("g: the wrapped-replay diagnostic did NOT fire — this echo matched via the WHOLE-STRING `replayedEntry`, never `wrappedReplayOfPriorWrite`",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);

    const live = host.live.get(sid);
    check("g: REQUIRED — gen=2 (current) is NOT marked resolved — the new check must defer to the replayedEntry marker too", !live.mismatchResolvedGens.has(2));
    check("g: gen=1 (the matched earlier entry, via replayedEntry) IS marked resolved — unconditional, pre-existing", live.mismatchResolvedGens.has(1));
    check("g: REQUIRED — the unresolved-timer IS armed for gen=2", live.pendingMismatchUnresolvedTimers.size === 1);
    check("g: lastMismatchReplay IS populated (wrapped:false, replayedGen:1) — the bare replay surface, not the wrapped one",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1 && host.getLastMismatchReplay(sid)?.wrapped === false);
  }

  // ===== (b) NEGATIVE CONTROL — identical-length ONE-BYTE divergence: the wrap's inner differs from
  // `intended` by exactly one byte (same length) — must NOT confirm. =====
  {
    const sid = newSession("OneByteDivergence"); SIDS.push(sid);
    const priorText = "continue"; // gen=1, never confirmed — irrelevant to this control, just ring filler
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const divergedInner = "continuo"; // same length as currentText, last byte differs
    const reported = wrapRemainder("abcd", divergedInner);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("b: NEGATIVE CONTROL — the new recognition log does NOT fire on a one-byte divergence",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    // Neither does the OLD prior-write-replay path (the diverged inner doesn't match gen=1's own text
    // either) — this specimen simply falls to the genuinely-unrecognized fallback, unaffected by this fix.
    check("b: still classified as unmatchable (arm=fallback-unrecognized), exactly as before this fix",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    // card d1ac9fed's own small-bucket split routes this exact overhead magnitude (lenDelta=55, within
    // its 96-char bound) to the RATE-GATED record-only path, not the immediate single-event push — a
    // single occurrence below UNRECOGNIZED_MISMATCH_RATE_THRESHOLD (3) correctly does NOT push yet; the
    // REQUIRED invariant is that it is still recorded as genuinely unrecognized, never silently confirmed.
    check("b: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
    check("b: a single occurrence does not yet cross the rate threshold — no push on this one event alone (expected, unrelated to this fix)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
  }

  // ===== (c-1) NEGATIVE CONTROL — a wrap whose inner merely CONTAINS `intended` (extra bytes inside the
  // same tag framing) — must NOT confirm; the anchored regex's own discipline, never a substring. =====
  {
    const sid = newSession("InnerContainsIntended"); SIDS.push(sid);
    const priorText = "unrelated-filler-AAAAAAAAAA";
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const reported = wrapRemainder("abcd", `${currentText}-EXTRA`); // inner CONTAINS intended, not equal
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("c-1: NEGATIVE CONTROL — an inner that merely CONTAINS intended does NOT confirm",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("c-1: still classified as unmatchable (arm=fallback-unrecognized)",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    // Same small-overhead-magnitude routing as scenario (b) above — record-only, not an immediate push;
    // see that scenario's own comment for why a single occurrence correctly doesn't push yet.
    check("c-1: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
  }

  // ===== (c-2) NEGATIVE CONTROL — MISMATCHED ids front/back on an otherwise-exact bare wrap of
  // `intended` — must NOT confirm; the backreference equality check must actually gate something. =====
  {
    const sid = newSession("MismatchedIdsFrontBack"); SIDS.push(sid);
    const priorText = "unrelated-filler-BBBBBBBBBB";
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const reported = `<pasted_content id="aaaa">\n${currentText}\n</pasted_content id="bbbb">`;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("c-2: NEGATIVE CONTROL — mismatched ids front/back do NOT confirm",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("c-2: still classified as unmatchable (arm=fallback-unrecognized)",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    // Same small-overhead-magnitude routing as scenario (b) above — record-only, not an immediate push;
    // see that scenario's own comment for why a single occurrence correctly doesn't push yet.
    check("c-2: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
  }

  // ===== (d) POSITIVE CONTROL — gen=2's text UNRELATED to gen=1, bare-wrapped gen=2's OWN content. Proves
  // the new check does NOT depend on the ring at all — a STRICT SUPERSET of the card's own duplicate-text
  // repro, and a shape NOTHING previously recognized (before this fix: fallback-unrecognized, pushed). =====
  {
    const sid = newSession("UnrelatedToRingBareWrapOfCurrent"); SIDS.push(sid);
    const genOneText = "foo-gen-one-unrelated";
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "bar-gen-two-own-text"; // gen=2 — CURRENT, UNRELATED to gen=1's text
    host.enqueueStdin(sid, genTwoText);
    const reported = wrapRemainder("abcd", genTwoText); // bare-wraps gen=2's OWN content, not gen=1's
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("d: POSITIVE CONTROL — the new recognition log fires for a bare wrap of the CURRENT gen's own, ring-unrelated content, with ambiguous=false",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=false/.test(l)));
    check("d: REQUIRED — no [prompt-mismatch-arm] line at all",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("d: REQUIRED — the manager's false possible-LOSS push does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("d: gen=2 (current) IS marked resolved", live.mismatchResolvedGens.has(2));
    check("d: gen=1 is NOT marked resolved (never matched, never involved — the ring never even entered the computation)",
      !live.mismatchResolvedGens.has(1));
    // Confirm the OLD wrapped-replay-of-prior-write path genuinely never claimed this shape — gen=1's own
    // recorded text ("foo-gen-one-unrelated") is not a substring of `reported` at all, so
    // `findRecognizedSubstring` itself never matches here; this is a shape no PRE-EXISTING mechanism named.
    check("d: the OLD wrapped-replay-of-prior-write diagnostic did NOT fire either (nothing claimed this shape before this fix)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);
  }

  // ===== (f) POSITIVE CONTROL — Round 3's own probe: gen=1 writes "ok", gen=2 (current) writes "ok,
  // continue with the plan" (bare-wrapped). "ok" IS a substring of the wrap's inner (Round 2's own
  // `unmatchedRecognized !== null` signal would have called this ambiguous), but `wrappedReplayOfPriorWrite`
  // never fires — the remainder around "ok" is NOT exactly the tag framing (there's trailing prose before
  // the closing tag), so nothing about gen=1 was actually resolved by this echo. Must stay UNAMBIGUOUS. =====
  {
    const sid = newSession("ShortPriorSubstringUnambiguous"); SIDS.push(sid);
    const genOneText = "ok";
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "ok, continue with the plan"; // gen=2 — CURRENT; CONTAINS gen=1's text as a substring
    host.enqueueStdin(sid, genTwoText);
    const reported = wrapRemainder("abcd", genTwoText); // bare-wraps gen=2's OWN content
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("f: POSITIVE CONTROL — the new recognition log fires with ambiguous=false despite gen=1's text being a substring of the wrap's inner",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=false/.test(l)));
    check("f: the unmatchedRecognized diagnostic DOES fire (gen=1's text IS a substring) — but that alone must not make this ambiguous",
      lines.some((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ") && /recognizedGen=1\b/.test(l)));
    check("f: REQUIRED — the wrapped-replay diagnostic does NOT fire — the remainder is not exactly the tag framing",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ")).length === 0);
    check("f: REQUIRED — no [prompt-mismatch-arm] line at all (fully silent, same as scenario d)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("f: REQUIRED — the manager's false possible-LOSS push does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("f: REQUIRED — gen=2 (current) IS marked resolved", live.mismatchResolvedGens.has(2));
    check("f: gen=1 is NOT marked resolved — this echo never actually resolved it, only brushed past it as a substring", !live.mismatchResolvedGens.has(1));
    check("f: REQUIRED — no unresolved-timer was armed for this hook at all", live.pendingMismatchUnresolvedTimers.size === 0);
  }

  // ===== (e) NEGATIVE CONTROL — card e59880fe's OWN population reproduced here: a genuinely-UNRELATED
  // wrapped replay (current gen's own text differs from the wrapped earlier entry) must stay LOUD. =====
  {
    const sid = newSession("GenuinelyUnrelatedWrappedReplay"); SIDS.push(sid);
    const genOneText = "K".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const ordinaryNewMessage = "Z".repeat(10); // gen=2 — CURRENT, UNRELATED to gen=1's text
    host.enqueueStdin(sid, ordinaryNewMessage);
    const reported = wrapRemainder("pcwr", genOneText); // wraps gen=1's content, NOT gen=2's own
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("e: NEGATIVE CONTROL — the new recognition log does NOT fire (gen=2's own text differs from the wrapped content)",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("e: REQUIRED — e59880fe's own loud classification is UNCHANGED: arm=fallback-wrapped-replay-awaiting-resolution",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("e: REQUIRED — the manager push does NOT fire for this arm (unchanged from e59880fe's own fix)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("e: gen=1 (the matched prior write) IS marked resolved", live.mismatchResolvedGens.has(1));
    check("e: gen=2 (the current, ordinary message) is NOT marked resolved — a real unresolved-timer risk remains, correctly", !live.mismatchResolvedGens.has(2));
    check("e: REQUIRED — the unresolved-timer IS armed for gen=2 (this population must stay loss-possible)", live.pendingMismatchUnresolvedTimers.size === 1);
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 37acd59f's own gap is closed for the UNAMBIGUOUS case (scenarios d and f): a bare wrap of the CURRENT generation's own content, whether genuinely ring-unrelated (d) or merely containing an earlier generation's text as a substring that resolves nothing (f, Round 3's own probe), is recognized as content-identical and goes fully silent, with no false-alarm unresolved-timer. Round 3 (Code Review BLOCKING): ambiguity means this echo ACTUALLY resolved another generation — via EITHER the wrapped marker (scenario a, the card's own 'continue sent twice' repro) OR the bare whole-string replayedEntry marker (scenario g, Minor 3) — in both cases the fix defers entirely to that pre-existing path: loud, timer armed, only the earlier generation marked resolved — never double-resolving two generations from one echo (7a64f16b). A one-byte divergence, a substring-only match, and a mismatched-id wrap all still decline exactly as before. card e59880fe's own genuinely-unrelated wrapped-replay population stays loud, unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
