// Card dc92f4b6 — four real specimens (sessions d0c329c1/b17653a2/413a268b/5d3e32ed, 2026-10-03), ALL
// large (~61-72k char) first kickoffs, each producing a FALSE `[loom:prompt-mismatch-unmatched]`
// "possible LOSS" push to the manager even though the content fully arrived.
//
// THE MECHANISM (three of the four specimens, root-caused from daemon-output.log, not inferred): Loom
// writes a real kickoff (generation 1). The engine's own confirmation lags past Loom's give-up window,
// so Loom re-mints the SAME content wrapped in a `[loom:possible-duplicate root:...]` tag as generation
// 2. The engine's LATE confirmation for the ORIGINAL generation 1 write then finally lands — but by then
// it is compared against generation 2's own `intended`, not generation 1's. The engine echoes
// generation 1's content wrapped in its OWN paste-composer framing
// (`\n\n<pasted_content id="X">\n...\n</pasted_content id="X">\n` — the SAME framing
// `isRecognizedPastedContentWrap` already recognizes, but ONLY against the CURRENT generation's own
// `intended`, never an earlier ring entry). Against generation 2's dup-tag-wrapped `intended`, the two
// wrappers are textually unrelated, so every existing "confirmed" shape declines and the detector falls
// to `fallback-unrecognized` — even though `findRecognizedSubstring` independently proves generation 1's
// FULL content is present (that recognition is enrichment-only and never suppresses, per card d005f55b).
//
// THE FIX (`findRecognizedPastedContentWrapOfPriorWrite`, pty/host.ts): recognizes a pasted-content-wrap
// whose inner content is EXACTLY (never a substring) an EARLIER ring entry's own recorded write, AND
// requires the CURRENT generation's own `intended` (possible-duplicate tag stripped) to ALSO exactly
// equal that SAME entry, paired per-entry — proving CONTENT identity, never lineage (it does NOT prove
// the current generation was literally minted as that entry's own re-send, only that the content
// matches). (Code Review CRITICAL round 1, card dc92f4b6: matching the wrap alone against ANY prior
// entry, with no check against the CURRENT generation at all, let an UNRELATED current generation's own
// real loss confirm silently with no trace — reproduced as scenario 4. Code Review MAJOR round 2: the
// pairing itself was untested — a mutant that decouples "inner matches entry X" from "current matches
// entry X" (checking the CURRENT side against ANY entry, not the SAME one) passed every scenario that
// existed at the time — reproduced, and proven RED under that exact mutant, as scenario 6.) Wired in at
// the same precedence tier as `confirmedWrapperAwareFusion`, as a new `confirmed-pasted-content-wrap-
// replay` arm — this is what stops the manager push (gated on `mismatchArm === "fallback-unrecognized"`
// only). Marks BOTH the matched prior generation (a real effect) AND the current generation (pure state
// hygiene, no observable effect — no follow-up timer is ever reachable for it on this branch) resolved.
//
// Full root-cause narrative + "Do not" list: docs/decisions/dc92f4b6-pasted-content-wrap-can-replay-an-earlier-generation.md
//
// POSITIVE CONTROL, PER THIS REPO'S STANDING VERIFICATION POSTURE:
//   1. The real shape: generation 1 writes a kickoff; generation 2 is a `framePossibleDuplicate`-wrapped
//      re-send of the SAME content; the engine reports back generation 1's own recorded write wrapped in
//      pasted-content framing. Must confirm (`arm=confirmed-pasted-content-wrap-replay`), must NOT push to
//      the manager, must mark BOTH gen=1 and gen=2 resolved, and the session notice must state CONTENT
//      identity (never lineage) and name generation 2's own pending tagged write as the duplicate risk.
//   2. NEGATIVE CONTROL — the wrapped content is genuinely different from what the current generation's
//      own (tag-stripped) intended text is — must NOT confirm, and the manager push must STILL
//      fire (a genuine loss must stay loud).
//   3. NEGATIVE CONTROL — the wrapped content is a prior entry's own text PLUS extra, unrelated chars (a
//      SUPERSET, not an exact match) — must NOT confirm at this tier (exact whole-inner equality only,
//      never a substring/partial match); falls through to the weaker, non-suppressing
//      `[prompt-mismatch-unmatched-remainder]` path instead, and the manager push STILL fires.
//   4. NEGATIVE CONTROL — Code Review round-1 CRITICAL counter-specimen: generation 2 is an UNRELATED new
//      message (no possible-duplicate tag at all), and the engine happens to echo back a stale,
//      unconfirmed generation 1 wrapped in paste framing. Must NOT confirm (generation 2 carries no tag
//      to strip) — the manager push must STILL fire for generation 2's own, genuine loss.
//   5. POSITIVE CONTROL — the engine's own trailing-whitespace trim on the WRAP side (mirrors
//      `isRecognizedPastedContentWrap`'s own `trimEnd()` allowance): the wrap's inner is the matched
//      entry's text with trailing whitespace trimmed, while the current generation's own (untrimmed)
//      re-send matches the entry exactly — both sides independently satisfy the `trimEnd()` allowance.
//   6. NEGATIVE CONTROL — Code Review round-2 MAJOR counter-specimen: generation 1=A (unconfirmed),
//      generation 2=B (an ORDINARY, UNRELATED new message, no tag), generation 3=a tagged re-send of B
//      SPECIFICALLY (never A) — current. Engine echoes `wrap(A)`. The decoupled-pairing mutant above
//      wrongly confirms (inner matches gen 1 via the loop; `strippedCurrent` separately matches gen 2
//      elsewhere in the window); the real check must NOT confirm, and the manager push must STILL fire
//      for generation 3's own, genuine (unrelated-to-A) loss.
//
// Mirrors pty-prompt-mismatch-wrapper-aware-fusion.mjs's own harness: the REAL PtyHost state machine + a
// FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-pasted-content-wrap-replay.mjs (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pasted-content-wrap-replay-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost, framePossibleDuplicate } = await import("../dist/pty/host.js");
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-pasted-content-wrap-replay: predicate" });
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

// Builds the engine's own paste-composer wrap exactly as `PASTED_CONTENT_WRAP_RE` requires it
// (host.ts): `\n\n<pasted_content id="ID">\n<inner>\n</pasted_content id="ID">\n`.
const pastedContentWrap = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

const ROOT_MSG_ID = "dc92f4b6-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // an 8-hex-prefixed id, mirrors the real give-up re-mint's own root

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL — the real shape: generation 1 writes a kickoff; Loom gives up and re-mints
  // the SAME content as generation 2 (framePossibleDuplicate-wrapped); the engine's LATE confirmation for
  // generation 1 lands wrapped in the engine's own paste-composer framing. =====
  {
    const sid = newSession("PastedContentWrapReplay"); SIDS.push(sid);
    const kickoffText = "K".repeat(500); // stands in for the real ~67-72k char kickoff
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID); // generation 2's own `intended`

    // Generation 1: the real kickoff write — never confirmed (no UserPromptSubmit hook for it; mirrors
    // the real specimens, where Loom gave up before any engine confirmation arrived). The Stop below
    // ends gen=1's turn WITHOUT confirming it (card sha:c433346f: Stop needs no preceding
    // UserPromptSubmit), clearing busy so the give-up re-mint below can write as its own, new generation.
    host.enqueueStdin(sid, kickoffText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: the give-up re-mint, now written and CURRENT (`live.submitGeneration === 2`). The
    // engine's hook reports back generation 1's own recorded write, late, wrapped in pasted-content
    // framing — never generation 2's own (dup-tag-wrapped) text.
    host.enqueueStdin(sid, remint); // gen=2
    const reported = pastedContentWrap("pcwr", kickoffText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const replayLines = lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("1: POSITIVE CONTROL — [prompt-mismatch-pasted-content-wrap-replay] fires", replayLines.length === 1);
    check("1: it names the recognized generation (gen=1) and the exact matched length (500)",
      /recognizedGen=1\b/.test(replayLines[0] ?? "") && /matchedLen=500\b/.test(replayLines[0] ?? ""));

    // Manager review condition (d): the arm log itself names the new arm explicitly.
    const armLines = lines.filter((l) => l.startsWith("[prompt-mismatch-arm] "));
    check("1: the [prompt-mismatch-arm] log names arm=confirmed-pasted-content-wrap-replay",
      armLines.length === 1 && /\barm=confirmed-pasted-content-wrap-replay\b/.test(armLines[0] ?? ""));

    // THE RED->GREEN PIVOT: before this fix, this exact specimen fell to `isUnmatchableMismatch` (the
    // real, measured production shape — arm=fallback-unrecognized, pushed to the manager).
    check("1: RED-PROOF — NO LONGER classified as unmatchable (getLastMismatchUnmatched stays null, not gen=2)",
      host.getLastMismatchUnmatched(sid) === null);
    check("1: the plain partial-recognition fallback does NOT also fire for the same mismatch",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")).length === 0);
    check("1: no plain exact-replay or fusion also claims this mismatch",
      host.getLastMismatchReplay(sid) === null && host.getLastMismatchFusion(sid) === null);

    // Manager review fix: the re-mint-identity check justifies marking BOTH generations resolved — the
    // current generation's own (re-mint-tag-stripped) intended text IS, by construction, gen=1's content.
    const live = host.live.get(sid);
    check("1: generation 1 (the matched prior write) IS marked resolved", live.mismatchResolvedGens.has(1));
    check("1: generation 2 (the current re-mint, now justified) IS ALSO marked resolved", live.mismatchResolvedGens.has(2));

    // THE CARD'S OWN root symptom: the manager-facing "possible LOSS" push must NOT fire for this arm.
    check("1: REQUIRED — [prompt-mismatch-unmatched-pushed] does NOT fire (the false manager escalation this card exists to stop)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);

    // The session-facing notice itself.
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("1: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // This notice is long enough to span multiple PTY_WRITE_CHUNK_UNITS-sized `writeChunked` chunks,
    // paced asynchronously — wait for the message's own LITERAL TAIL to land before reading it whole, or
    // a premature read truncates mid-notice (the exact trap that slipped through earlier in review).
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("acting on it twice."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("1: REQUIRED — the notice explicitly says NOT A LOSS OF CONTENT", /NOT A LOSS OF CONTENT/.test(noticeText));
    check("1: it does NOT use the generic \"possible LOSS\" framing", !/possible LOSS/.test(noticeText));
    check("1: it states CONTENT identity against generation 1's write (never lineage/\"re-mint of\" wording)",
      /CONTENT-IDENTICAL to generation 1/.test(noticeText) && !/re-mint of generation/i.test(noticeText));
    // Manager review condition (b)/(c): names generation 2's OWN pending tagged write as the duplicate
    // risk — not "generation 1's own turn" — and states it is NOT itself independently confirmed yet.
    check("1: it names generation 2's own tagged write as NOT independently confirmed / may surface later",
      /[Gg]eneration 2's OWN tagged write has NOT itself been independently confirmed/.test(noticeText));
    check("1: the action line watches for generation 2's own later copy, not generation 1's own turn",
      /watch for a LATER.*generation 2's own tagged write/.test(noticeText) && !/generation 1's own turn already ran/.test(noticeText));
    check("1: disclosure-safe — no raw content leaks (the repeated kickoff character never appears bare)",
      !noticeText.includes(kickoffText));
  }

  // ===== 2. NEGATIVE CONTROL — the wrapped content is genuinely different from what the current
  // generation's own (re-mint-tag-stripped) intended text actually is. A real loss must stay loud — the
  // manager push must STILL fire. =====
  {
    const sid = newSession("WrappedContentGenuinelyDifferent"); SIDS.push(sid);
    const kickoffText = "L".repeat(500);
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID);

    host.enqueueStdin(sid, kickoffText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    // The wrapped body is UNRELATED content, not generation 1's own recorded write at all (and not what
    // generation 2's own stripped intended text is, either).
    const unrelatedContent = "Z".repeat(500);
    host.enqueueStdin(sid, remint); // gen=2, now written and current
    const reported = pastedContentWrap("pcwr", unrelatedContent);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("2: NEGATIVE CONTROL — [prompt-mismatch-pasted-content-wrap-replay] does NOT fire on unrelated content",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    check("2: still classified as unmatchable (arm=fallback-unrecognized), exactly as before this fix",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("2: REQUIRED — the manager push STILL fires for a genuine, unrecognized divergence",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
  }

  // ===== 3. NEGATIVE CONTROL — the wrapped body is a prior entry's own text PLUS extra, unrelated
  // trailing content — a SUPERSET, not an exact whole-inner match. Must NOT confirm at this tier; must
  // fall through to the weaker, non-suppressing `unmatchedRecognized` substring path instead (asserted
  // directly, per manager review — a vacuous "nothing ELSE claims this" check alone would also pass on the
  // pre-fix RED tree and proves nothing), and the manager push must STILL fire. =====
  {
    const sid = newSession("SupersetNotExact"); SIDS.push(sid);
    const kickoffText = "M".repeat(500);
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID);

    host.enqueueStdin(sid, kickoffText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    // The wrapped body is generation 1's own recorded text PLUS real extra content appended — a
    // superset, deliberately NOT equal to the recorded entry.
    const supersetContent = `${kickoffText}EXTRA-UNRELATED-TAIL-CONTENT`;
    host.enqueueStdin(sid, remint); // gen=2, now written and current
    const reported = pastedContentWrap("pcwr", supersetContent);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("3: NEGATIVE CONTROL — a SUPERSET (prior write + extra content) does NOT confirm at this tier",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    // Positive assertion of WHERE it actually lands (not a vacuous "nothing else claims this" check):
    // generation 1's own recorded text is still found as a SUBSTRING inside the wrap, at the weaker,
    // non-suppressing tier.
    check("3: falls through to [prompt-mismatch-unmatched-remainder] (recognizes gen=1 as a substring, does not confirm)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ") && /recognizedGen=1\b/.test(l)).length === 1);
    check("3: REQUIRED — the manager push STILL fires (a superset is not an exact reconciliation)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
  }

  // ===== 4. NEGATIVE CONTROL — Code Review CRITICAL counter-specimen (card dc92f4b6): generation 2 is an
  // UNRELATED new message (no re-mint tag at all — never even addresses generation 1), and the engine
  // happens to echo back a stale, unconfirmed generation 1 wrapped in paste framing. The original cut of
  // this fix matched the wrap against ANY prior entry and confirmed here, silently dropping generation 2's
  // own real loss with no trace anywhere. Must NOT confirm — generation 2 is not a re-mint of anything, so
  // its own loss must stay loud. =====
  {
    const sid = newSession("UnrelatedCurrentGenCounterSpecimen"); SIDS.push(sid);
    const genOneText = "A".repeat(500); // gen=1, never confirmed
    host.enqueueStdin(sid, genOneText);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // clears busy without confirming gen=1

    // Generation 2: an ORDINARY, UNRELATED new message — no `framePossibleDuplicate` tag, no relation to
    // generation 1 whatsoever (a fresh manager direction, a fresh human composer turn, etc.).
    const unrelatedNewMessage = "B".repeat(500);
    host.enqueueStdin(sid, unrelatedNewMessage); // gen=2, now written and current
    check("SETUP: generation 2's own intended text carries no re-mint tag at all",
      unrelatedNewMessage === "B".repeat(500));

    // The engine's hook reports back generation 1's own recorded write, late, wrapped in pasted-content
    // framing — exactly the same wrap shape as scenario 1's positive control, but this time attached to
    // an UNRELATED current generation.
    const reported = pastedContentWrap("pcwr", genOneText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("4: NEGATIVE CONTROL (Code Review counter-specimen) — the new arm does NOT fire for an unrelated current generation",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    check("4: generation 2's own, genuine loss is STILL classified as unmatchable",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("4: REQUIRED — the manager push STILL fires for generation 2's own loss (no silent, traceless drop)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
    // Generation 2 must NOT be marked resolved by an echo that carries none of its own content.
    const live = host.live.get(sid);
    check("4: generation 2 is NOT marked resolved by an echo that has nothing to do with it", !live.mismatchResolvedGens.has(2));
  }

  // ===== 5. POSITIVE CONTROL — the `trimEnd()` allowance, exercised independently on BOTH sides: the
  // engine's own echo trims trailing whitespace off the WRAP's inner content (mirrors
  // `isRecognizedPastedContentWrap`'s own allowance), while the current generation's own re-mint (never
  // trimmed by Loom) matches the recorded entry exactly. =====
  {
    const sid = newSession("TrimEndAllowanceBothSides"); SIDS.push(sid);
    const kickoffText = `${"N".repeat(500)}  `; // trailing whitespace, mirrors a real trailing-newline/space kickoff
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID); // Loom's own re-mint is NEVER trimmed

    host.enqueueStdin(sid, kickoffText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, remint); // gen=2, now written and current — strippedCurrent === kickoffText EXACTLY
    // The engine's own echo trims the wrap's inner trailing whitespace — matches entry.text.trimEnd(), not entry.text.
    const reported = pastedContentWrap("pcwr", kickoffText.trimEnd());
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const replayLines = lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("5: POSITIVE CONTROL — fires even though the WRAP side used trimEnd() while the CURRENT side matched exactly",
      replayLines.length === 1);
    check("5: matchedLen is the ORIGINAL (untrimmed) recorded entry length", /matchedLen=502\b/.test(replayLines[0] ?? ""));
    const live = host.live.get(sid);
    check("5: both generations resolved, exactly as scenario 1", live.mismatchResolvedGens.has(1) && live.mismatchResolvedGens.has(2));
    check("5: no manager push for this confirmed shape",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
  }

  // ===== 6. NEGATIVE CONTROL — Code Review MAJOR (round 2, confirmed): the "SAME entry" half of the
  // identity check was UNTESTED. The reviewer's own probe: gen1=A (unconfirmed), gen2=B (an ORDINARY,
  // UNRELATED new message, no tag), gen3=framePossibleDuplicate(B) (so gen3 IS a re-mint of B, NOT A),
  // and the engine echoes wrap(A). A mutant that decouples the pairing — checks the wrap's inner against
  // ANY window entry, and `strippedCurrent` against ANY window entry, independently, rather than the SAME
  // one — would wrongly confirm here (inner matches gen1=A via the loop; `strippedCurrent` separately
  // matches gen2=B elsewhere in the window), misattributing gen3 to gen1's content when gen3 is actually
  // gen2's own re-mint. Must NOT confirm; gen3's real loss must still push. =====
  {
    const sid = newSession("SameEntryPairingCounterSpecimen"); SIDS.push(sid);
    const genOneText = "A".repeat(500);
    const genTwoText = "B".repeat(500);

    host.enqueueStdin(sid, genOneText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, genTwoText); // gen=2 — an ORDINARY, UNRELATED new message, no tag
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=3: the give-up re-mint of gen=2 SPECIFICALLY (not gen=1) — now written and current.
    const remintOfB = framePossibleDuplicate(genTwoText, ROOT_MSG_ID);
    host.enqueueStdin(sid, remintOfB); // gen=3, now written and current
    check("SETUP: gen=3 is the re-mint of gen=2 (B), not gen=1 (A)", remintOfB.includes(genTwoText) && !remintOfB.includes(genOneText));

    // The engine's hook reports back generation 1's own recorded write, late, wrapped in pasted-content
    // framing — NOT generation 2's, even though generation 2 is the one generation 3 actually re-mints.
    const reported = pastedContentWrap("pcwr", genOneText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("6: NEGATIVE CONTROL (Code Review round-2 counter-specimen) — the arm does NOT fire (wrong entry pairing)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    check("6: generation 3's own, genuine loss is STILL classified as unmatchable",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 3);
    check("6: REQUIRED — the manager push STILL fires for generation 3's own loss",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 1);
    const live = host.live.get(sid);
    check("6: generation 3 is NOT marked resolved by an echo that matches the WRONG entry",
      !live.mismatchResolvedGens.has(3));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dc92f4b6's own gap is closed: a late engine echo wrapping an EARLIER generation's own recorded write in pasted-content paste-composer framing is now fully confirmed ONLY when the wrap's inner content AND the current generation's own (tag-stripped) intended text both match the SAME prior entry (paired per-entry, never decoupled — the round-2 Code Review counter-specimen, scenario 6, proves this; and a wrap-only match against any stale entry regardless of the current generation, the round-1 counter-specimen, scenario 4, stays refused too), no longer falsely classified as unmatchable for the real shape, no longer pushes a false `[loom:prompt-mismatch-unmatched]` \"possible LOSS\" alarm to the manager for it, marks BOTH the matched prior generation (a real effect) and the current generation (state hygiene, no observable effect) resolved, and its session-facing notice states CONTENT identity plainly (never lineage) while naming the current generation's own pending tagged write — not the already-confirmed one — as the duplicate-check risk; a genuinely different wrapped body, a superset match, an unrelated current generation, and the decoupled-pairing counter-specimen all still push the manager alarm exactly as before, and the trimEnd() allowance holds independently on the wrap side and the current-generation side."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
