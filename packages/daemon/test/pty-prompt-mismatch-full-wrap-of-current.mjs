// Card 437daade — the FULL-FRAMING TWIN of card 37acd59f (test/pty-prompt-mismatch-bare-wrap-of-current.mjs):
// tell a FULL `\n\n<pasted_content id="X">\n...\n</pasted_content id="X">\n` wrap of the CURRENT generation
// apart from a REPLAY of an earlier generation with byte-identical text.
//
// THE GAP (found by direct hermetic execution, not merely reading): `isRecognizedPastedContentWrap`
// (host.ts) — the FULL-framing recognizer — had NO ambiguity guard at the call site at all, unlike its
// BARE sibling (37acd59f). When the current generation's own intended text is byte-identical to an earlier
// generation's own recorded write (e.g. "continue" sent twice), and the engine FULL-wraps the echo, the
// unconditional `isPastedContentWrap` match silently skipped the ENTIRE else-if classification block below
// — no `[loom:prompt-mismatch]` notice, no follow-up unresolved timer, and (unlike the pre-37acd59f bare
// bug, which at least double-resolved and left a trace) NEITHER generation was ever marked in
// `mismatchResolvedGens`. If the current generation's own real content never separately arrived, this
// permanently and silently lost the alarm — the exact class the first Code Review on 37acd59f blocked on
// (session a7c072c4, gen=50, where the timer fired live).
//
// A SECOND, COMPOUNDING GAP (Round 1): even with an ambiguity guard added, there was no way to DETECT the
// ambiguity for the full-framing shape at all.
//
// ROUND 2 (card 437daade, Code Review BLOCKING, verified by probe): Round 1's own remainder-regex fix
// (`matchFullPastedContentWrapFramingOfRemainder`, driven off `findRecognizedSubstring`'s single, newest-
// first substring hit) silently missed FOUR more real shapes: a trailing-newline trim eating the framing
// boundary, a trailing-space variant with no substring hit at all, the CLI's own escaped-nested-tag form,
// and a SHADOWED ring entry pre-empting an earlier one's own exact match. THE FIX (replacing Round 1's own
// remainder matcher entirely): `identicalContentPriorEntryFull` (host.ts) scans the ring DIRECTLY with the
// SAME recognizer (`isRecognizedPastedContentWrap`) that accepted `reported` against `intended`, so the
// trimEnd/escape/id-charset tolerances can never drift. `pastedContentWrapOfCurrentAmbiguous =
// isPastedContentWrap && (identicalContentPriorEntryFull !== null || replayedEntry !== undefined)` and
// `confirmedPastedContentWrapOfCurrent = isPastedContentWrap && !pastedContentWrapOfCurrentAmbiguous` —
// mirroring 37acd59f's own `bareWrapOfCurrentAmbiguous`/`confirmedBarePastedContentWrapOfCurrent` exactly,
// same ambiguity rule: one echo resolves at most one lineage (`7a64f16b`). The else-if gate excludes
// `confirmedPastedContentWrapOfCurrent` (never the raw, unguarded `isPastedContentWrap`), and the
// UNAMBIGUOUS case marks the current generation resolved (bookkeeping parity with the bare twin). Minor 2
// (manager ruling): the AMBIGUOUS-AND-IDENTICAL case's session notice now states CONTENT IDENTITY only,
// never a lineage ("is a REPLAY ... did not reach you") claim.
//
// POSITIVE CONTROLS (unambiguous — no generation was actually resolved by this echo):
//   (d) GEN=2's TEXT UNRELATED TO GEN=1 ("hello there" vs "continue"), full-wrapped gen=2's OWN text — no
//       ring match at all, so unambiguous, silent, gen=2 marked resolved (the non-identical control).
//   (f) THE SUBSTRING CONTROL — gen=1 writes "ok", gen=2 (current) writes "ok, continue with the plan"
//       (full-wrapped). "ok" is a substring of the wrap's inner (`unmatchedRecognized` fires), but
//       `identicalContentPriorEntryFull` never fires (gen=1's own text isn't content-identical to anything
//       in the wrap) — nothing was actually resolved by this echo, so this must stay UNAMBIGUOUS.
//   (h) AN ANCHORING NEGATIVE CONTROL — an EXTRA CHARACTER inside the framing (a third leading newline)
//       must NOT match `PASTED_CONTENT_WRAP_RE` at all — proves the recognizer is anchored, never a
//       substring/partial match.
//
// AMBIGUOUS — PROVEN STILL LOUD (an earlier generation WAS actually resolved by this echo):
//   (a) THE CARD'S OWN REPRO — gen=1 writes "continue", never confirmed; gen=2 (current) ALSO writes
//       "continue" (byte-identical), full-wrapped. `identicalContentPriorEntryFull` ALSO matches gen=1 from
//       the SAME echo, so this must classify EXACTLY as `fallback-full-wrapped-replay-awaiting-resolution`
//       (loud, timer armed for gen=2, only gen=1 marked resolved; session notice uses Minor 2's CONTENT-
//       IDENTITY wording). See PART 11 of pty-prompt-mismatch-unresolved.mjs for the companion proof that
//       an armed timer actually fires when never resolved — the same mechanism; this file does not
//       duplicate that wait.
//   (g) THE `replayedEntry` ARM (same shape as the bare twin's own Minor-3 scenario): gen=1's own LITERAL
//       submitted text IS the exact full-wrap string the engine later echoes for gen=2's own (different,
//       shorter) intended text. `replayedEntry` (not `identicalContentPriorEntryFull`) fires here, proving
//       the ambiguity guard defers to BOTH competing markers, not just the ring-scan one.
//   (i)/(j)/(k)/(l)/(m) — ROUND 2's own four tolerance/shadow shapes (trailing-newline trim, trailing-
//       space/no-substring-hit, the CLI's escaped-nested-tag form, that escape combined with a trailing
//       newline, and a SHADOWED ring) — each identical-text, each now correctly AMBIGUOUS where the OLD
//       remainder-regex approach silently missed it.
//   (n) THE RESOLVED-ENTRY FILTER — an entry already resolved by some OTHER mechanism before this echo is
//       NOT a competing, ambiguous claim (lesson-199 DoD).
//
// NEGATIVE CONTROLS:
//   (b) IDENTICAL-LENGTH ONE-BYTE DIVERGENCE — must NOT confirm.
//   (c-1) A WRAP WHOSE INNER MERELY CONTAINS `intended` — must NOT confirm.
//   (c-2) MISMATCHED IDS FRONT/BACK — must NOT confirm.
//   (e) A GENUINELY-UNRELATED FULL-WRAP-OF-PRIOR-WRITE (gen=2's own text differs from the wrapped earlier
//       entry) — must stay LOUD. Unlike the bare twin's own scenario (e) (which reproduces a PRE-EXISTING,
//       e59880fe population), this shape is itself NEW for full framing: before Round 1, nothing
//       recognized a full-wrap of a PRIOR, untagged generation at all, so it fell to plain
//       `fallback-unrecognized` — this closes that second, compounding gap too.
//
// Mirrors pty-prompt-mismatch-bare-wrap-of-current.mjs's own harness exactly: the REAL PtyHost state
// machine + a FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-full-wrap-of-current.mjs (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-full-wrap-of-current-${Date.now()}-${process.pid}`);
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-full-wrap-of-current: predicate" });
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

// The FULL framing shape — PASTED_CONTENT_WRAP_RE's own exact bytes (host.ts), leading `\n\n`, trailing `\n`.
const wrapFull = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

const NEW_TAG = "[prompt-mismatch-full-pasted-content-wrap-of-current] ";

const SIDS = [];

try {
  // ===== (a) AMBIGUOUS — PROVEN STILL LOUD: THE CARD'S OWN REPRO: gen=1 writes "continue", never
  // confirmed; gen=2 (current) ALSO writes "continue" (byte-identical); the engine FULL-wraps the report.
  // An earlier ring entry (gen=1) ALSO matches this echo via `identicalContentPriorEntryFull`, so the new check
  // must NOT confirm-benign here. =====
  {
    const sid = newSession("DuplicateTextFullWrap"); SIDS.push(sid);
    const DUP_TEXT = "continue";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, own intended text IS "continue" too
    const reported = wrapFull("abcd", DUP_TEXT);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("a: the new recognition log fires, naming gen=2's own lengths and ambiguous=true (no content)",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 reportedLen=66 intendedLen=8 ambiguous=true /.test(l)));
    check("a: the log line uses CONTENT-IDENTITY wording only — never a lineage claim (dc92f4b6's own discipline)",
      lines.some((l) => l.startsWith(NEW_TAG) && /content-identical to THIS generation's own intended text/.test(l) && !/NOT A REPLAY/.test(l)));
    check("a: the full-wrap-of-prior-write remainder-replay log ALSO fires (this card's own new detector, pre-existing within this card)",
      lines.some((l) => l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] ") && /recognizedGen=1\b/.test(l)));
    check("a: REQUIRED — [prompt-mismatch-arm] DOES fire, classified EXACTLY as the full-wrapped-replay arm (the new check defers, never gates this case)",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("a: REQUIRED — the manager's possible-LOSS push does NOT fire for this arm",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);

    const live = host.live.get(sid);
    check("a: REQUIRED — gen=2 (current) is NOT marked resolved — the double-resolution bug this card closes", !live.mismatchResolvedGens.has(2));
    check("a: gen=1 (the matched earlier entry) IS marked resolved — unconditional", live.mismatchResolvedGens.has(1));
    check("a: REQUIRED — the unresolved-timer IS armed for gen=2 — identical text must never disarm it", live.pendingMismatchUnresolvedTimers.size === 1);
    check("a: lastMismatchReplay IS populated (wrapped:true, replayedGen:1) — the loud surface",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1 && host.getLastMismatchReplay(sid)?.wrapped === true);

    // The session-facing notice DOES enqueue (loud), with REPLAY wording — never silently skipped.
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("a: REQUIRED — the mismatch notice DOES enqueue (loud, not silenced)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("your next report up.") || fake.writes.slice(writesBefore).join("").includes("check the message sent for that generation."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    // Card 437daade (Round 2, Minor 2, manager ruling): the AMBIGUOUS-AND-IDENTICAL case now states
    // CONTENT IDENTITY, never a lineage ("is a REPLAY ... did not reach you") claim.
    check("a: UPDATED (card 437daade) — the notice uses CONTENT-IDENTITY wording, never \"is a REPLAY\"/\"NOT A LOSS\"",
      /CONTENT-IDENTICAL to an earlier, still-unconfirmed write/.test(noticeText) && !/is a REPLAY of an earlier generation/.test(noticeText) && !/NOT A LOSS/.test(noticeText));
    check("a: the notice names the armed follow-up timer and the generation it was armed for",
      /A follow-up timer is armed for THIS generation \(gen=2\)/.test(noticeText));
  }

  // ===== (g) AMBIGUOUS via the `replayedEntry` ARM: gen=1's own LITERAL submitted text IS the exact
  // full-wrap string the engine later echoes for gen=2's own (different) intended text. `replayedEntry`
  // (NOT `identicalContentPriorEntryFull`) fires here — proving the ambiguity guard defers to BOTH competing
  // markers, not just the full-wrapped one. =====
  {
    const sid = newSession("ReplayedEntryAmbiguousFull"); SIDS.push(sid);
    const payload = "payload-text-g";
    const wrappedLiteral = wrapFull("abcd", payload); // gen=1's own literal text IS the full-wrap string
    host.enqueueStdin(sid, wrappedLiteral); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, payload); // gen=2 — CURRENT, own intended text is just the payload
    const reported = wrapFull("abcd", payload); // engine's full-wrap of gen=2's own echo happens to
                                                 // equal gen=1's literal text byte-for-byte
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("g: the new recognition log fires with ambiguous=true, resolvedPriorGen=1 (via the replayedEntry arm, not full-wrapped)",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=true/.test(l) && /resolvedPriorGen=1/.test(l)));
    check("g: REQUIRED — [prompt-mismatch-arm] fires classified as the BARE replay arm (fallback-replay-awaiting-resolution), never the full-wrapped sibling",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-replay-awaiting-resolution\b/.test(l)));
    check("g: the full-wrapped-replay diagnostic did NOT fire — this echo matched via the WHOLE-STRING `replayedEntry`, never `identicalContentPriorEntryFull`",
      lines.filter((l) => l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] ")).length === 0);

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
    const sid = newSession("OneByteDivergenceFull"); SIDS.push(sid);
    const priorText = "continue"; // gen=1, never confirmed — irrelevant to this control, just ring filler
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const divergedInner = "continuo"; // same length as currentText, last byte differs
    const reported = wrapFull("abcd", divergedInner);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("b: NEGATIVE CONTROL — the new recognition log does NOT fire on a one-byte divergence",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("b: still classified as unmatchable (arm=fallback-unrecognized), exactly as before this fix",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("b: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
    check("b: a single occurrence does not yet cross the rate threshold — no push on this one event alone (expected, unrelated to this fix)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
  }

  // ===== (c-1) NEGATIVE CONTROL — a wrap whose inner merely CONTAINS `intended` (extra bytes inside the
  // same tag framing) — must NOT confirm; the anchored regex's own discipline, never a substring. =====
  {
    const sid = newSession("InnerContainsIntendedFull"); SIDS.push(sid);
    const priorText = "unrelated-filler-AAAAAAAAAA";
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const reported = wrapFull("abcd", `${currentText}-EXTRA`); // inner CONTAINS intended, not equal
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("c-1: NEGATIVE CONTROL — an inner that merely CONTAINS intended does NOT confirm",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("c-1: still classified as unmatchable (arm=fallback-unrecognized)",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("c-1: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
  }

  // ===== (c-2) NEGATIVE CONTROL — MISMATCHED ids front/back on an otherwise-exact full wrap of
  // `intended` — must NOT confirm; the backreference equality check must actually gate something. =====
  {
    const sid = newSession("MismatchedIdsFrontBackFull"); SIDS.push(sid);
    const priorText = "unrelated-filler-BBBBBBBBBB";
    host.enqueueStdin(sid, priorText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const currentText = "continue"; // gen=2 — CURRENT
    host.enqueueStdin(sid, currentText);
    const reported = `\n\n<pasted_content id="aaaa">\n${currentText}\n</pasted_content id="bbbb">\n`;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("c-2: NEGATIVE CONTROL — mismatched ids front/back do NOT confirm",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("c-2: still classified as unmatchable (arm=fallback-unrecognized)",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("c-2: REQUIRED — still recorded as a genuine fallback-unrecognized (record-only, not confirmed-benign)",
      lines.some((l) => l.startsWith("[prompt-mismatch-notice-recorded-only] ") && /\barm=fallback-unrecognized\b/.test(l)));
  }

  // ===== (d) POSITIVE CONTROL / NON-IDENTICAL CONTROL — gen=2's text UNRELATED to gen=1 ("hello there" vs
  // "continue"), full-wrapped gen=2's OWN content. Proves the new check does NOT depend on the ring at all.
  {
    const sid = newSession("UnrelatedToRingFullWrapOfCurrent"); SIDS.push(sid);
    const genOneText = "hello there";
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "continue"; // gen=2 — CURRENT, UNRELATED to gen=1's text
    host.enqueueStdin(sid, genTwoText);
    const reported = wrapFull("abcd", genTwoText); // full-wraps gen=2's OWN content, not gen=1's
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("d: POSITIVE CONTROL — the new recognition log fires for a full wrap of the CURRENT gen's own, ring-unrelated content, with ambiguous=false",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=false/.test(l)));
    check("d: REQUIRED — no [prompt-mismatch-arm] line at all",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("d: REQUIRED — the manager's false possible-LOSS push does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("d: REQUIRED (bookkeeping parity with the bare twin) — gen=2 (current) IS marked resolved", live.mismatchResolvedGens.has(2));
    check("d: gen=1 is NOT marked resolved (never matched, never involved — the ring never even entered the computation)",
      !live.mismatchResolvedGens.has(1));
    check("d: the full-wrap-of-prior-write diagnostic did NOT fire either (nothing claimed this shape)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] ")).length === 0);
  }

  // ===== (f) THE SUBSTRING CONTROL — gen=1 writes "ok", gen=2 (current) writes "ok, continue with the
  // plan" (full-wrapped). "ok" IS a substring of the wrap's inner, but `identicalContentPriorEntryFull` never
  // fires — the remainder around "ok" is NOT exactly the full tag framing (trailing prose before the
  // closing tag), so nothing about gen=1 was actually resolved by this echo. Must stay UNAMBIGUOUS. =====
  {
    const sid = newSession("ShortPriorSubstringUnambiguousFull"); SIDS.push(sid);
    const genOneText = "ok";
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "ok, continue with the plan"; // gen=2 — CURRENT; CONTAINS gen=1's text as a substring
    host.enqueueStdin(sid, genTwoText);
    const reported = wrapFull("abcd", genTwoText); // full-wraps gen=2's OWN content
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("f: the new recognition log fires with ambiguous=false despite gen=1's text being a substring of the wrap's inner",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=false/.test(l)));
    check("f: the unmatchedRecognized diagnostic DOES fire (gen=1's text IS a substring) — but that alone must not make this ambiguous",
      lines.some((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ") && /recognizedGen=1\b/.test(l)));
    check("f: REQUIRED — the full-wrapped-replay diagnostic does NOT fire — the remainder is not exactly the full tag framing",
      lines.filter((l) => l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] ")).length === 0);
    check("f: REQUIRED — no [prompt-mismatch-arm] line at all (fully silent, same as scenario d)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("f: REQUIRED — the manager's false possible-LOSS push does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("f: REQUIRED — gen=2 (current) IS marked resolved", live.mismatchResolvedGens.has(2));
    check("f: gen=1 is NOT marked resolved — this echo never actually resolved it, only brushed past it as a substring", !live.mismatchResolvedGens.has(1));
    check("f: REQUIRED — no unresolved-timer was armed for this hook at all", live.pendingMismatchUnresolvedTimers.size === 0);
  }

  // ===== (h) ANCHORING NEGATIVE CONTROL — an EXTRA CHARACTER inside the remainder (a THIRD leading
  // newline, so the leading remainder is `\n\n\n<pasted_content id="X">\n` instead of the exact
  // double-newline shape) must NOT match `PASTED_CONTENT_WRAP_RE` at all — proves the ring-scan (Round 2:
  // `identicalContentPriorEntryFull`, which reuses that SAME anchored regex via `isRecognizedPastedContent
  // Wrap` against each candidate entry) is exactly as tolerant as `PASTED_CONTENT_WRAP_RE` itself and no
  // more; there is no separate remainder-matching regex left to test since Round 2 removed it. =====
  {
    const sid = newSession("RemainderExtraCharNegative"); SIDS.push(sid);
    const genOneText = "unrelated-filler-for-remainder-negative-control";
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const genTwoText = "an ordinary new message, unrelated to gen=1"; // gen=2 — CURRENT
    host.enqueueStdin(sid, genTwoText);
    // One extra leading `\n` relative to the exact PASTED_CONTENT_WRAP_RE shape — still a substring match
    // on gen=1's own text, but the remainder is no longer pure full framing.
    const reported = `\n\n\n<pasted_content id="abcd">\n${genOneText}\n</pasted_content id="abcd">\n`;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("h: NEGATIVE CONTROL — the full-wrap-of-prior-write remainder-replay log does NOT fire (extra leading newline breaks the anchor)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] ")).length === 0);
    check("h: the plain unmatchedRecognized diagnostic DOES still fire (gen=1's text IS a substring)",
      lines.some((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ") && /recognizedGen=1\b/.test(l)));
    const live = host.live.get(sid);
    check("h: gen=1 is NOT marked resolved — the remainder detector correctly declined", !live.mismatchResolvedGens.has(1));
    check("h: still classified as unmatchable (arm=fallback-unrecognized), falling through exactly as an un-wrapped substring would",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
  }

  // ===== (e) NEGATIVE CONTROL / NEW-SHAPE CLOSURE — a genuinely-UNRELATED full-wrapped replay (current
  // gen's own text differs from the wrapped earlier entry) must be LOUD. Before this card, NOTHING
  // recognized a full-wrap of a PRIOR, untagged generation at all (unlike the bare twin, where e59880fe
  // already covered this) — so this closes the second, compounding gap this card fixes, not merely a
  // "must stay unaffected" regression check. =====
  {
    const sid = newSession("GenuinelyUnrelatedFullWrappedReplay"); SIDS.push(sid);
    const genOneText = "K".repeat(500);
    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const ordinaryNewMessage = "Z".repeat(10); // gen=2 — CURRENT, UNRELATED to gen=1's text
    host.enqueueStdin(sid, ordinaryNewMessage);
    const reported = wrapFull("pcwr", genOneText); // wraps gen=1's content, NOT gen=2's own
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("e: NEGATIVE CONTROL — the new recognition log does NOT fire (gen=2's own text differs from the wrapped content)",
      lines.filter((l) => l.startsWith(NEW_TAG)).length === 0);
    check("e: REQUIRED — this NEW full-wrap-of-prior-write classification fires: arm=fallback-full-wrapped-replay-awaiting-resolution",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("e: REQUIRED — the manager push does NOT fire for this arm",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("e: gen=1 (the matched prior write) IS marked resolved", live.mismatchResolvedGens.has(1));
    check("e: gen=2 (the current, ordinary message) is NOT marked resolved — a real unresolved-timer risk remains, correctly", !live.mismatchResolvedGens.has(2));
    check("e: REQUIRED — the unresolved-timer IS armed for gen=2 (this population must stay loss-possible)", live.pendingMismatchUnresolvedTimers.size === 1);
  }

  // ===== Round 2 (card 437daade, Code Review BLOCKING, verified by probe): FOUR real shapes a remainder-
  // regex ambiguity signal silently missed, now fixed by scanning the ring directly with the SAME
  // recognizer. Each must end AMBIGUOUS (gen=1 resolved, gen=2's own timer armed, fires) — mirrors scenario
  // (a) exactly, just with a tolerance-requiring specimen instead of a byte-identical one. =====
  const checkIdenticalAmbiguousShape = (label, sid, reported) => {
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check(`${label}: the new recognition log fires with ambiguous=true, resolvedPriorGen=1`,
      lines.some((l) => l.startsWith(NEW_TAG) && /ambiguous=true/.test(l) && /resolvedPriorGen=1/.test(l)));
    check(`${label}: REQUIRED — [prompt-mismatch-arm] fires classified as a full-wrapped-replay-awaiting-resolution arm`,
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    const live = host.live.get(sid);
    check(`${label}: REQUIRED — gen=2 (current) is NOT marked resolved`, !live.mismatchResolvedGens.has(2));
    check(`${label}: gen=1 (the matched earlier entry) IS marked resolved`, live.mismatchResolvedGens.has(1));
    check(`${label}: REQUIRED — the unresolved-timer IS armed for gen=2`, live.pendingMismatchUnresolvedTimers.size === 1);
    check(`${label}: lastMismatchReplay IS populated (wrapped:true, replayedGen:1)`,
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1 && host.getLastMismatchReplay(sid)?.wrapped === true);
  };

  // ===== (i) TRAILING-NEWLINE TRIM — gen=1 writes "continue\n"; gen=2 (current) ALSO writes "continue\n"
  // (byte-identical). The engine's own composer trims trailing whitespace before wrapping, so the wrap's
  // inner is "continue" (no newline) — gen=1's own trailing "\n" would have eaten the framing's own
  // trailing "\n" under the OLD remainder-regex approach, declining the match entirely. =====
  {
    const sid = newSession("TrailingNewlineTrim"); SIDS.push(sid);
    const DUP_TEXT = "continue\n";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, byte-identical
    const reported = wrapFull("abcd", "continue"); // the engine's own trim: no trailing \n in the wrap's inner
    checkIdenticalAmbiguousShape("i", sid, reported);
  }

  // ===== (j) TRAILING-SPACE, NO SUBSTRING HIT AT ALL — gen=1 writes "continue " (trailing space); gen=2
  // ALSO writes "continue " (byte-identical). The engine trims the space before wrapping, so gen=1's own
  // RAW text ("continue ") is never even a literal substring of the trimmed echo — `findRecognizedSubstring`
  // would have returned nothing at all under the OLD approach. =====
  {
    const sid = newSession("TrailingSpaceNoSubstringHit"); SIDS.push(sid);
    const DUP_TEXT = "continue ";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, byte-identical
    const reported = wrapFull("abcd", "continue"); // trimmed, no trailing space
    checkIdenticalAmbiguousShape("j", sid, reported);
  }

  // ===== (k) THE CLI'S OWN ESCAPED-NESTED-TAG FORM (card 691d02e1) — gen=1's own text contains literal
  // pasted-content tag syntax; gen=2 ALSO writes the identical text. The CLI escapes the literal occurrence
  // when echoing it back wrapped, so gen=1's own RAW (unescaped) text is never a literal substring of the
  // ESCAPED echo — `findRecognizedSubstring` would have returned nothing under the OLD approach. =====
  {
    const sid = newSession("EscapedNestedTagIdentical"); SIDS.push(sid);
    const DUP_TEXT = 'discussing the wrap: it looks like `<pasted_content id="aa11">...</pasted_content id="aa11">`';
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, byte-identical
    const escapedInner = DUP_TEXT.replace(/<(\/?)pasted_content/g, "<\\$1pasted_content");
    const reported = wrapFull("abcd", escapedInner);
    checkIdenticalAmbiguousShape("k", sid, reported);
  }

  // ===== (l) ESCAPED + TRAILING NEWLINE, COMBINED — both gaps (3) and (1) from the card's own narrative at
  // once, proving the recognizer's `unescaped === intended.trimEnd()` branch is exercised correctly. =====
  {
    const sid = newSession("EscapedAndTrailingNewlineIdentical"); SIDS.push(sid);
    const DUP_TEXT = 'mentions `<pasted_content id="bb22">` in prose\n';
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, byte-identical
    const trimmedEscaped = DUP_TEXT.trimEnd().replace(/<(\/?)pasted_content/g, "<\\$1pasted_content");
    const reported = wrapFull("abcd", trimmedEscaped);
    checkIdenticalAmbiguousShape("l", sid, reported);
  }

  // ===== (m) A SHADOWED RING — gen=1 writes X="continue with the plan" (never confirmed); gen=2 writes
  // "continue" (an ORDINARY, distinct message that happens to be a substring of X); gen=3 (current) ALSO
  // writes X again (byte-identical to gen=1). `findRecognizedSubstring`'s own single, newest-first hit
  // would have returned gen=2 (a non-framing partial hit) and NEVER reached gen=1's own exact match at all
  // — the new ring scan, trying each entry's own exact recognizer match in turn, correctly skips gen=2 and
  // finds gen=1. =====
  {
    const sid = newSession("ShadowedRingFull"); SIDS.push(sid);
    const X = "continue with the plan";
    host.enqueueStdin(sid, X); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, "continue"); // gen=2, an ordinary, distinct message — a substring of X
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=2 either
    host.enqueueStdin(sid, X); // gen=3 — CURRENT, byte-identical to gen=1 (NOT gen=2)
    const reported = wrapFull("abcd", X);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("m: the new recognition log fires with ambiguous=true, resolvedPriorGen=1 (NEVER gen=2, despite being scanned first)",
      lines.some((l) => l.startsWith(NEW_TAG) && /ambiguous=true/.test(l) && /resolvedPriorGen=1\b/.test(l)));
    check("m: REQUIRED — [prompt-mismatch-arm] fires classified as a full-wrapped-replay-awaiting-resolution arm",
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    const live = host.live.get(sid);
    check("m: REQUIRED — gen=3 (current) is NOT marked resolved", !live.mismatchResolvedGens.has(3));
    check("m: gen=1 (the matched earlier entry, the SHADOWING target) IS marked resolved", live.mismatchResolvedGens.has(1));
    check("m: gen=2 (the shadowing, non-matching entry scanned FIRST) is NOT marked resolved — it never actually matched", !live.mismatchResolvedGens.has(2));
    check("m: REQUIRED — the unresolved-timer IS armed for gen=3", live.pendingMismatchUnresolvedTimers.size === 1);
  }

  // ===== (n) RESOLVED-ENTRY FILTER — lesson-199 DoD: an entry already marked resolved (by some OTHER
  // mechanism) must NOT be returned as a competing candidate. gen=1 writes "continue", never confirmed.
  // gen=2 writes something else ("unrelated-filler-n"), but its OWN echo is a PLAIN replay of gen=1's text
  // ("continue") — the classic 201d0d95 shape — which marks gen=1 resolved via `replayedEntry`'s own
  // unconditional marking BEFORE gen=3 ever runs. THEN gen=3 (current) ALSO writes "continue" (byte-
  // identical to the now-ALREADY-RESOLVED gen=1), full-wrapped. Must stay UNAMBIGUOUS: an already-resolved
  // entry is not a competing claim. =====
  {
    const sid = newSession("ResolvedEntryFilterFull"); SIDS.push(sid);
    const DUP_TEXT = "continue";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });
    host.enqueueStdin(sid, "unrelated-filler-n"); // gen=2 — own intended text, distinct from gen=1
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: DUP_TEXT }); // gen=2's own echo IS gen=1's text — a plain replay, resolves gen=1
    const liveN = host.live.get(sid);
    check("n: SETUP — gen=1 is already marked resolved before gen=3's own echo (gen=2's own plain-replay echo resolved it)",
      liveN.mismatchResolvedGens.has(1));
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const timersBeforeGen3 = liveN.pendingMismatchUnresolvedTimers.size; // gen=2's own replay-awaiting timer, if still pending
    host.enqueueStdin(sid, DUP_TEXT); // gen=3 — CURRENT, byte-identical to the now-already-resolved gen=1
    const reported = wrapFull("abcd", DUP_TEXT);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("n: REQUIRED — the new recognition log fires with ambiguous=false (gen=1 is already resolved, not a competing claim)",
      lines.some((l) => l.startsWith(NEW_TAG) && /ambiguous=false/.test(l)));
    check("n: REQUIRED — no [prompt-mismatch-arm] line at all for THIS (gen=3) hook",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("n: gen=3 (current) IS marked resolved — the unambiguous case", liveN.mismatchResolvedGens.has(3));
    check("n: REQUIRED — no NEW unresolved-timer was armed for THIS (gen=3) hook",
      liveN.pendingMismatchUnresolvedTimers.size === timersBeforeGen3);
  }
  // ===== (o) ROUND 3 FIX — a prior generation confirmed by its OWN clean, byte-identical echo is NOT a
  // competing ambiguous claim. gen=1 writes "continue" and is cleanly confirmed (UserPromptSubmit echoes
  // exactly `live.lastPrompt`); gen=2 (current) ALSO writes "continue", full-wrapped. Before round 3, gen=1
  // was never added to `mismatchResolvedGens` (only the MISMATCH branch writes that set), so this echo
  // falsely classified as AMBIGUOUS — a FALSE ALARM for two cleanly-delivered sends. Must now be
  // UNAMBIGUOUS: silent, gen=2 marked resolved, no timer, no notice. =====
  {
    const sid = newSession("CleanConfirmedPriorUnambiguousFull"); SIDS.push(sid);
    const DUP_TEXT = "continue";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: DUP_TEXT }); // CLEAN confirm — byte-identical echo
    const liveO = host.live.get(sid);
    check("o: SETUP — gen=1 is recorded as echo-confirmed by its own clean echo", liveO.echoConfirmedGens.has(1));
    check("o: SETUP — gen=1 is NOT in mismatchResolvedGens (never overloaded into that set)", !liveO.mismatchResolvedGens.has(1));
    host.deliverHook(sid, { hook_event_name: "Stop" }); // turn ends, clears busy

    host.enqueueStdin(sid, DUP_TEXT); // gen=2 — CURRENT, byte-identical to the now-cleanly-confirmed gen=1
    const reported = wrapFull("abcd", DUP_TEXT);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("o: REQUIRED (round 3 fix) — the new recognition log fires with ambiguous=false — a cleanly-confirmed prior is not a competing claim",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=2 /.test(l) && /ambiguous=false/.test(l)));
    check("o: REQUIRED — no [prompt-mismatch-arm] line at all — no false alarm",
      lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("o: REQUIRED — the manager's false possible-LOSS push does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    check("o: REQUIRED — no session-facing mismatch notice is enqueued (silent)", !hasPendingMismatchNotice(sid));
    check("o: REQUIRED — gen=2 (current) IS marked resolved — the unambiguous case", liveO.mismatchResolvedGens.has(2));
    check("o: REQUIRED — no unresolved-timer was armed for gen=2", liveO.pendingMismatchUnresolvedTimers.size === 0);
  }

  // ===== (o2) SAME FIX, prior confirmed TWO generations back — gen=1 writes "continue" and is cleanly
  // confirmed; gen=2 writes an unrelated "filler-o2" (never confirmed, just ring filler); gen=3 (current)
  // ALSO writes "continue", full-wrapped. Proves the exclusion isn't an immediate-prior-only special case. =====
  {
    const sid = newSession("CleanConfirmedPriorTwoBackUnambiguousFull"); SIDS.push(sid);
    const DUP_TEXT = "continue";
    host.enqueueStdin(sid, DUP_TEXT); // gen=1
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: DUP_TEXT }); // CLEAN confirm
    const liveO2 = host.live.get(sid);
    check("o2: SETUP — gen=1 is recorded as echo-confirmed", liveO2.echoConfirmedGens.has(1));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, "filler-o2"); // gen=2 — unrelated, never confirmed, just ring filler
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, DUP_TEXT); // gen=3 — CURRENT, byte-identical to the now-cleanly-confirmed gen=1 (2 back)
    const reported = wrapFull("abcd", DUP_TEXT);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("o2: REQUIRED (round 3 fix) — ambiguous=false even though the confirmed entry is TWO generations back",
      lines.some((l) => l.startsWith(NEW_TAG) && / gen=3 /.test(l) && /ambiguous=false/.test(l)));
    check("o2: REQUIRED — no [prompt-mismatch-arm] line at all", lines.filter((l) => l.startsWith("[prompt-mismatch-arm] ")).length === 0);
    check("o2: REQUIRED — no session-facing mismatch notice is enqueued (silent)", !hasPendingMismatchNotice(sid));
    check("o2: REQUIRED — gen=3 (current) IS marked resolved", liveO2.mismatchResolvedGens.has(3));
    check("o2: REQUIRED — no unresolved-timer was armed for gen=3", liveO2.pendingMismatchUnresolvedTimers.size === 0);
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 437daade (the full-framing twin of 37acd59f): a full wrap of the CURRENT generation's own content, whether genuinely ring-unrelated (d) or merely containing an earlier generation's text as a substring that resolves nothing (f), is recognized as content-identical and goes fully silent, with gen=2 now marked resolved (bookkeeping parity with the bare twin) and no false-alarm unresolved-timer. Ambiguity defers entirely to that pre-existing path: loud, timer armed, only the earlier generation marked resolved — never double-resolving two generations from one echo (7a64f16b). A one-byte divergence, a substring-only match, a mismatched-id wrap, and an extra-character remainder (h) all still decline exactly as designed. A genuinely-unrelated full-wrap-of-prior-write (e) is correctly classified LOUD instead of falling to plain fallback-unrecognized. Card 437daade (Round 2, Code Review BLOCKING, verified by probe): the OLD remainder-regex ambiguity signal silently missed four real shapes — a trailing-newline trim (i), a trailing-space variant with no substring hit at all (j), the CLI's own escaped-nested-tag form (k), that same escape combined with a trailing newline (l), and a SHADOWED ring entry pre-empting an earlier one's own exact match (m) — all now correctly AMBIGUOUS by scanning the ring directly with the SAME recognizer (`isRecognizedPastedContentWrap`) instead of a parallel, looser remainder regex. (n) proves the resolved-entry filter: an entry already resolved by some OTHER mechanism is never a competing, ambiguous claim."
  + " Round 3 (false-alarm fix): a prior generation confirmed by its own clean, byte-identical echo (o, and o2 two generations back) is no longer a competing ambiguous claim — a cleanly-delivered duplicate send no longer falsely arms a follow-up timer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
