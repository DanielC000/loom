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
// CARD 1c7a5e12 — two follow-ups from 437daade's second Code Review (reviewer a2df1914), both confirmed by
// hermetic probe before any fix: (1) THE DETECTOR ABOVE RECOGNIZED FULL FRAMING ONLY — a BARE-wrapped
// tagged re-mint fell through entirely to 437daade's tag-FREE ring scan (`identicalContentPriorEntryBare`),
// which has no visibility into the CURRENT generation's own possible-duplicate tag (tag-stripping only
// happens here), leaving the CURRENT generation's own unresolved timer armed — a measured FALSE ALARM,
// loud, even though its content fully arrived. FIX: `findRecognizedBarePastedContentWrapOfPriorWrite`, a
// BARE-framing twin sharing the SAME core (parameterized by `wrapRe`), wired at the identical precedence
// tier; `lastMismatchPastedContentWrapReplay` gained a `bare: boolean` field (mirrors `lastMismatchReplay`'s
// own `wrapped`) — severity/recovery semantics are IDENTICAL either way. (2) NO RESOLVED-ENTRY FILTER —
// the original scan returned the first (newest) matching ring entry regardless of whether it was already
// resolved, so an already-resolved, NEWER entry could shadow a genuinely-pending, OLDER one sharing
// identical content, wasting the one chance to clear the older entry's own real unresolved timer — another
// measured false alarm (scenario 8 below). FIX: prefer an UNRESOLVED match (newest-first), falling back to
// a RESOLVED match only when no unresolved one exists (never a hard skip-if-resolved filter like 437daade's
// sibling — that would regress scenario 9's own existing coverage: when EVERY matching entry is already
// resolved, the CURRENT generation must still be confirmed silently). Marking the CURRENT generation
// unconditionally (dc92f4b6's original "resolve both" ruling) is UNCHANGED and stands: the tag ties its
// content identity to whichever entry matched, so there is no 37acd59f/437daade-style two-lineage
// ambiguity to defer here — only the entry-SELECTION step needed the fix.
//   7. POSITIVE CONTROL (card 1c7a5e12, point 1) — the real shape with a BARE-wrapped echo instead of
//      FULL: generation 1 writes a kickoff; generation 2 re-mints it; the engine's late echo is a BARE
//      pasted-content wrap (no outer `\n\n`) of generation 1's own write. Must confirm with `bare=true`,
//      mark BOTH generations resolved, arm NO follow-up timer, and never fire `onPromptMismatchUnresolved`.
//   8. POSITIVE CONTROL (card 1c7a5e12, point 2) — a tagged re-mint echo where TWO prior ring entries
//      share identical content: the OLDER one ("genA") is genuinely unresolved with its own pending
//      unresolved timer already armed (from an earlier, unrelated replay); the NEWER one ("genB") is
//      already resolved (via a real clean echo, `echoConfirmedGens`). The detector must prefer the
//      UNRESOLVED older entry, clearing its real timer so it never fires loud — not the resolved newer one.
//   9. CONTROL, no regression (card 1c7a5e12) — every ring entry sharing the wrapped content is ALREADY
//      resolved (no unresolved candidate exists at all). The detector must still fall back to that
//      resolved match and confirm the current generation silently, exactly as before this card's fix.
//
// CODE REVIEW FOLLOW-UP (reviewer 514cae2a, no Critical/Major findings — three test-only additions):
//   10. POSITIVE CONTROL — a VARIANT of scenario 8 where the already-resolved candidate is resolved via
//       `mismatchResolvedGens` (a real lag-by-one plain replay) instead of `echoConfirmedGens`, so the
//       `resolvedGens.has(...)` half of the shared core's prefer-unresolved predicate is actually
//       exercised (RED-proven by mutating that half out — see the decision record's own verification log).
//   11. NEGATIVE CONTROL, BARE twin of scenario 4 — pins the record's own Do-not #4 (the BARE twin must
//       apply the SAME tag-stripping discipline as FULL, never a looser one).
//   12. NEGATIVE CONTROL, BARE twin of scenario 6 (decoupled pairing) — same Do-not #4.
//
// Full root-cause narrative for card 1c7a5e12: docs/decisions/1c7a5e12-pasted-content-wrap-of-prior-write-bare-framing-and-resolved-entry-preference.md
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
// Card 437daade (round 3, "also do"): scenarios 4/6 below assert the timer FIRES, not merely that it's
// ARMED — needs the same env-shrunk resolve window as pty-prompt-mismatch-unresolved.mjs's own WINDOW_MS,
// set before ../dist/pty/host.js is ever imported (the constant is read ONCE, at module load).
const WINDOW_MS = 200;
process.env.LOOM_PROMPT_MISMATCH_RESOLVE_WINDOW_MS = String(WINDOW_MS);

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
// Card 437daade (round 3): collected the same way pty-prompt-mismatch-unresolved.mjs does, so scenarios
// 4/6 can prove the follow-up timer actually FIRES, not merely that it's armed.
const unresolvedEvents = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onPromptMismatchUnresolved(sessionId, info) { unresolvedEvents.push({ sessionId, info }); },
};
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
// Card 1c7a5e12 — the BARE-framing twin (no outer `\n\n`), exactly `PASTED_CONTENT_BARE_WRAP_RE`'s shape.
const bareContentWrap = (id, inner) => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;

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
  // own real loss with no trace anywhere. Must NOT confirm (dc92f4b6's own `confirmed-pasted-content-wrap-
  // replay` arm, which requires a re-mint tag, correctly declines) — generation 2 is not a re-mint of
  // anything, so its own loss must stay loud.
  //
  // Card 437daade (UPDATE, intentional): this exact shape — an untagged current generation, an earlier
  // entry's own write wrapped in the FULL `\n\n...\n` framing — is now ALSO recognized by the new, tag-free
  // `identicalContentPriorEntryFull` ring scan (which never existed before 437daade). Before that card this fell
  // through to the generic `fallback-unrecognized` bucket (rate-gated manager push); now it is classified
  // MORE PRECISELY as `fallback-full-wrapped-replay-awaiting-resolution` — an individually-armed follow-up
  // timer + an immediate REPLAY-worded session notice, strictly more informative for the SAME underlying
  // fact (generation 1's content did arrive late; generation 2's own content still might not have). This is
  // an improvement, not a regression — the two assertions below were updated to match. =====
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

    check("4: NEGATIVE CONTROL (Code Review counter-specimen) — dc92f4b6's own tagged arm does NOT fire for an unrelated current generation",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    // Card 437daade (UPDATE, intentional): no longer a silent, traceless "unmatchable" drop — the new
    // tag-free detector now NAMES this as a full-wrapped replay of generation 1, loud via its own arm.
    check("4: UPDATED (card 437daade) — generation 2's own, genuine loss is NO LONGER classified as unmatchable; it is now the NAMED full-wrapped-replay arm",
      host.getLastMismatchUnmatched(sid) === null &&
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("4: UPDATED (card 437daade) — the generic manager push no longer fires for THIS shape (replaced by the more precise per-event follow-up timer below, no silent/traceless drop either way)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    // Generation 2 must NOT be marked resolved by an echo that carries none of its own content —
    // UNCHANGED by card 437daade: only generation 1 (the matched entry) is marked resolved.
    const live = host.live.get(sid);
    check("4: generation 1 (the matched entry) IS marked resolved (card 437daade's own unconditional marking)", live.mismatchResolvedGens.has(1));
    check("4: generation 2 is NOT marked resolved by an echo that has nothing to do with it", !live.mismatchResolvedGens.has(2));
    check("4: REQUIRED — the follow-up unresolved-timer IS armed for generation 2 (card 437daade's own loss-possible arm, never silent)",
      host.live.get(sid).pendingMismatchUnresolvedTimers.size === 1);
    // Card 437daade (round 3, "also do"): the prior two assertions only prove the arm (ARMED), not that
    // delivery/firing actually happen — add both, mirroring the CR's own probe.
    const enqueued4 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("4: REQUIRED (round 3 \"also do\") — the session-facing mismatch notice DOES get enqueued (delivered, loud)", enqueued4);
    const fired4 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid));
    check("4: REQUIRED (round 3 \"also do\") — onPromptMismatchUnresolved actually FIRES once the window elapses with nothing to resolve it", fired4);
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
  // gen2's own re-mint. Must NOT confirm (dc92f4b6's own tagged arm correctly declines — this pairing
  // protection is unaffected by card 437daade below).
  //
  // Card 437daade (UPDATE, intentional): same shape as scenario 4's own update — the engine's echo of
  // gen1=A, full-wrapped, is now ALSO recognized by the tag-free `identicalContentPriorEntryFull` ring scan
  // regardless of what gen3 re-mints. Gen3's own loss is no longer a silent `fallback-unrecognized` drop;
  // it is now the NAMED full-wrapped-replay arm — strictly more informative, not a regression. =====
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

    check("6: NEGATIVE CONTROL (Code Review round-2 counter-specimen) — dc92f4b6's own tagged arm does NOT fire (wrong entry pairing)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    // Card 437daade (UPDATE, intentional): see scenario 4's own comment — no longer a silent
    // `fallback-unrecognized` drop; the tag-free detector now names this as a full-wrapped replay of gen1.
    check("6: UPDATED (card 437daade) — generation 3's own, genuine loss is NO LONGER classified as unmatchable; it is now the NAMED full-wrapped-replay arm",
      host.getLastMismatchUnmatched(sid) === null &&
      lines.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-full-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("6: UPDATED (card 437daade) — the generic manager push no longer fires for THIS shape (replaced by the more precise per-event follow-up timer below)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live = host.live.get(sid);
    check("6: generation 1 (the matched entry) IS marked resolved (card 437daade's own unconditional marking)", live.mismatchResolvedGens.has(1));
    check("6: generation 3 is NOT marked resolved by an echo that matches the WRONG entry",
      !live.mismatchResolvedGens.has(3));
    check("6: REQUIRED — the follow-up unresolved-timer IS armed for generation 3 (card 437daade's own loss-possible arm, never silent)",
      host.live.get(sid).pendingMismatchUnresolvedTimers.size === 1);
    // Card 437daade (round 3, "also do"): the prior two assertions only prove the arm (ARMED), not that
    // delivery/firing actually happen — add both, mirroring the CR's own probe.
    const enqueued6 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("6: REQUIRED (round 3 \"also do\") — the session-facing mismatch notice DOES get enqueued (delivered, loud)", enqueued6);
    const fired6 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid));
    check("6: REQUIRED (round 3 \"also do\") — onPromptMismatchUnresolved actually FIRES once the window elapses with nothing to resolve it", fired6);
  }

  // ===== 7. POSITIVE CONTROL (card 1c7a5e12, point 1) — the real shape with a BARE-wrapped echo instead
  // of FULL framing: the detector must recognize this too, never fall through to 437daade's tag-FREE ring
  // scan (which cannot see this generation's own tag and used to leave its timer armed — a measured false
  // alarm, RED on the pre-fix detector). =====
  {
    const sid = newSession("BareTaggedRemint"); SIDS.push(sid);
    const kickoffText = "K".repeat(500);
    const remint = framePossibleDuplicate(kickoffText, ROOT_MSG_ID); // generation 2's own `intended`

    host.enqueueStdin(sid, kickoffText); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, remint); // gen=2, now current
    const reported = bareContentWrap("q7bare", kickoffText);
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const replayLines = lines.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("7: POSITIVE CONTROL — fires for a BARE-wrapped tagged re-mint too (not full-wrap-only)",
      replayLines.length === 1);
    check("7: names recognizedGen=1, matchedLen=500, bare=true",
      /recognizedGen=1\b/.test(replayLines[0] ?? "") && /matchedLen=500\b/.test(replayLines[0] ?? "") && /\bbare=true\b/.test(replayLines[0] ?? ""));

    const armLines = lines.filter((l) => l.startsWith("[prompt-mismatch-arm] "));
    check("7: the [prompt-mismatch-arm] log names arm=confirmed-pasted-content-wrap-replay (never the loud fallback-wrapped-replay-awaiting-resolution arm)",
      armLines.length === 1 && /\barm=confirmed-pasted-content-wrap-replay\b/.test(armLines[0] ?? ""));
    check("7: RED-PROOF — NO LONGER classified as unmatchable", host.getLastMismatchUnmatched(sid) === null);

    const live7 = host.live.get(sid);
    check("7: generation 1 (the matched prior write) IS marked resolved", live7.mismatchResolvedGens.has(1));
    check("7: generation 2 (the current re-mint, content-identical mod tag) IS ALSO marked resolved", live7.mismatchResolvedGens.has(2));
    check("7: REQUIRED — NO follow-up unresolved timer is armed for generation 2 (the point-1 false alarm is closed)",
      live7.pendingMismatchUnresolvedTimers.size === 0);

    const replay7 = host.getLastMismatchPastedContentWrapReplay(sid);
    check("7: REQUIRED — lastMismatchPastedContentWrapReplay carries bare:true", replay7 !== null && replay7.bare === true);
    check("7: REQUIRED — [prompt-mismatch-unmatched-pushed] does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);

    const fired7 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid), WINDOW_MS * 2).catch(() => false);
    check("7: REQUIRED — onPromptMismatchUnresolved never fires for generation 2 (RED on the pre-fix detector, the exact false alarm this card closes)", !fired7);

    const fake7 = fakesById.get(sid);
    const writesBefore7 = fake7.writes.length;
    const enqueued7 = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("7: the notice enqueues (not suppressed)", enqueued7);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake7.writes.slice(writesBefore7).join("").includes("acting on it twice."));
    const noticeText7 = fake7.writes.slice(writesBefore7).join("");
    check("7: REQUIRED — the notice explicitly says NOT A LOSS OF CONTENT", /NOT A LOSS OF CONTENT/.test(noticeText7));
    check("7: disclosure-safe — no raw content leaks", !noticeText7.includes(kickoffText));
  }

  // ===== 8. POSITIVE CONTROL (card 1c7a5e12, point 2) — two prior ring entries share identical content:
  // "genA" (older) is genuinely UNRESOLVED with its own pending unresolved timer already armed (from an
  // earlier, unrelated plain replay); "genB" (newer) is ALREADY RESOLVED via a real clean echo
  // (`echoConfirmedGens`). A tagged re-mint of that shared content, FULL-wrapped, must prefer the
  // UNRESOLVED genA over the already-resolved, newer genB — clearing genA's real timer so it never fires
  // loud, rather than wasting the match on genB (RED on the pre-fix blind-newest-first scan). =====
  {
    const sid = newSession("ShadowedResolvedCandidate"); SIDS.push(sid);
    const sharedContent = "X".repeat(500);

    // gen=1: unrelated content, never confirmed.
    const genZeroText = "W".repeat(300);
    host.enqueueStdin(sid, genZeroText);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=2 ("genA"): intends sharedContent; its own hook plain-replays gen=1's content verbatim (card
    // 201d0d95) — genA's own intended ("X"s) differs from what was replayed ("W"s), so this ARMS genA's
    // OWN unresolved timer (isRecognizedReplayAwaitingResolution) while marking gen=1 resolved. genA's own
    // ring entry (text=sharedContent) now sits in the window, UNRESOLVED, with a real pending timer.
    host.enqueueStdin(sid, sharedContent); // gen=2
    captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genZeroText });
    });
    const liveAfterA = host.live.get(sid);
    check("SETUP 8: gen=1 marked resolved by genA's own plain-replay match", liveAfterA.mismatchResolvedGens.has(1));
    check("SETUP 8: genA (gen=2) itself is unresolved and HAS its own pending timer armed",
      !liveAfterA.mismatchResolvedGens.has(2) && liveAfterA.pendingMismatchUnresolvedTimers.size === 1);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // ends genA's turn WITHOUT confirming it

    // gen=3 ("genB"): ALSO sharedContent (an ordinary coincidental resend). Its own hook is a CLEAN,
    // byte-identical echo (hook.prompt === live.lastPrompt) — resolved via the REAL `echoConfirmedGens`
    // mechanism (card 437daade round 3), never an internal poke.
    host.enqueueStdin(sid, sharedContent); // gen=3
    captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: sharedContent });
    });
    const liveAfterB = host.live.get(sid);
    check("SETUP 8: genB (gen=3) is resolved via a REAL clean echo (echoConfirmedGens), not mismatchResolvedGens",
      liveAfterB.echoConfirmedGens.has(3) && !liveAfterB.mismatchResolvedGens.has(3));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=4: the TAGGED RE-MINT, current — re-mints sharedContent. Engine's late echo is a FULL wrap of it.
    const remint8 = framePossibleDuplicate(sharedContent, ROOT_MSG_ID);
    host.enqueueStdin(sid, remint8); // gen=4, now current
    const reported8 = pastedContentWrap("q8full", sharedContent);
    const lines8 = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported8 });
    });

    const replayLine8 = lines8.find((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("8: dc92f4b6's own detector fires (both inner and strippedCurrent equal sharedContent)", !!replayLine8);
    check("8: REQUIRED — THE FIX: it prefers genA (gen=2, unresolved), never genB (gen=3, already resolved, newer)",
      /recognizedGen=2\b/.test(replayLine8 ?? ""));

    const live8 = host.live.get(sid);
    check("8: genA (gen=2) is NOW marked resolved — its real pending timer will stay silent", live8.mismatchResolvedGens.has(2));
    check("8: generation 4 (the current re-mint) is ALSO marked resolved", live8.mismatchResolvedGens.has(4));

    const fired8 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid && e.info.gen === 2), WINDOW_MS * 2).catch(() => false);
    check("8: REQUIRED — genA's own onPromptMismatchUnresolved does NOT fire (RED on the pre-fix blind scan, the exact false alarm this card closes)", !fired8);
  }

  // ===== 9. CONTROL, NO REGRESSION (card 1c7a5e12) — every ring entry sharing the wrapped content is
  // ALREADY resolved (no unresolved candidate exists at all). The detector must still fall back to that
  // resolved match and confirm the current generation silently — a hard skip-if-resolved filter would
  // wrongly push this into a louder/weaker arm instead. =====
  {
    const sid = newSession("AllCandidatesAlreadyResolved"); SIDS.push(sid);
    const sharedContent9 = "Y".repeat(500);

    // gen=1: sharedContent, resolved via a REAL clean echo immediately.
    host.enqueueStdin(sid, sharedContent9); // gen=1
    captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: sharedContent9 });
    });
    const liveAfter1 = host.live.get(sid);
    check("SETUP 9: gen=1 is resolved via a REAL clean echo before the tagged re-mint ever arrives",
      liveAfter1.echoConfirmedGens.has(1));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=2: the TAGGED RE-MINT, current — the ONLY matching candidate (gen=1) is already resolved.
    const remint9 = framePossibleDuplicate(sharedContent9, ROOT_MSG_ID);
    host.enqueueStdin(sid, remint9); // gen=2, now current
    const reported9 = pastedContentWrap("q9full", sharedContent9);
    const lines9 = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported9 });
    });

    const replayLine9 = lines9.find((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("9: NO REGRESSION — still fires via the RESOLVED fallback (never returns null just because the only candidate is resolved)", !!replayLine9);
    check("9: names recognizedGen=1", /recognizedGen=1\b/.test(replayLine9 ?? ""));

    const armLine9 = lines9.find((l) => l.startsWith("[prompt-mismatch-arm] "));
    check("9: the resulting arm is STILL confirmed-pasted-content-wrap-replay (never a louder fallback arm)",
      !!armLine9 && /\barm=confirmed-pasted-content-wrap-replay\b/.test(armLine9));

    const live9 = host.live.get(sid);
    check("9: generation 2 (the current re-mint) is silently confirmed, exactly as pre-1c7a5e12 behaviour", live9.mismatchResolvedGens.has(2));
    check("9: NO new follow-up unresolved timer is armed", live9.pendingMismatchUnresolvedTimers.size === 0);
  }

  // ===== 10. POSITIVE CONTROL (card 1c7a5e12, Code Review follow-up — reviewer 514cae2a): a VARIANT of
  // scenario 8 where "genB" (the already-resolved, newer candidate) is resolved via `mismatchResolvedGens`
  // (a real lag-by-one PLAIN REPLAY, card 201d0d95) rather than a clean echo — so the
  // `resolvedGens.has(entry.gen)` half of the shared core's prefer-unresolved predicate (host.ts ~661) is
  // actually exercised, not only the `echoConfirmedGens.has(entry.gen)` half scenario 8 covers. =====
  {
    const sid = newSession("ShadowedResolvedCandidateViaMismatchResolvedGens"); SIDS.push(sid);
    const sharedContent10 = "Q".repeat(500);

    // gen=1: unrelated content, never confirmed.
    const genZeroText10 = "V".repeat(300);
    host.enqueueStdin(sid, genZeroText10);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=2 ("genA"): intends sharedContent10; its own hook plain-replays gen=1's content verbatim — ARMS
    // genA's OWN unresolved timer while marking gen=1 resolved (same technique as scenario 8).
    host.enqueueStdin(sid, sharedContent10); // gen=2
    captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: genZeroText10 });
    });
    const liveAfterA10 = host.live.get(sid);
    check("SETUP 10: gen=1 marked resolved by genA's own plain-replay match", liveAfterA10.mismatchResolvedGens.has(1));
    check("SETUP 10: genA (gen=2) itself is unresolved and HAS its own pending timer armed",
      !liveAfterA10.mismatchResolvedGens.has(2) && liveAfterA10.pendingMismatchUnresolvedTimers.size === 1);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // ends genA's turn WITHOUT confirming it

    // gen=3 ("genB"): ALSO sharedContent10 (an ordinary coincidental resend), left UNCONFIRMED for now
    // (no hook delivered for its own turn at all — mirrors gen=1's own setup above).
    host.enqueueStdin(sid, sharedContent10); // gen=3
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=4: a short, UNRELATED write whose own hook plain-replays genB's raw text verbatim.
    // `replayedEntry = recentWrittenTurns.findLast(text === reported)` picks the NEWEST exact match — genB
    // (gen=3), since genA (gen=2) shares the SAME text but is older — so this marks genB resolved via the
    // REAL `mismatchResolvedGens` path (card dc92f4b6's own unconditional `replayedEntry` marking), never
    // `echoConfirmedGens`, and never an internal poke.
    host.enqueueStdin(sid, "R".repeat(10)); // gen=4
    captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: sharedContent10 });
    });
    const liveAfterB10 = host.live.get(sid);
    check("SETUP 10: genB (gen=3) is resolved via mismatchResolvedGens (a real plain replay), NOT echoConfirmedGens",
      liveAfterB10.mismatchResolvedGens.has(3) && !liveAfterB10.echoConfirmedGens.has(3));
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // gen=5: the TAGGED RE-MINT, current — re-mints sharedContent10. Engine's late echo is a FULL wrap.
    const remint10 = framePossibleDuplicate(sharedContent10, ROOT_MSG_ID);
    host.enqueueStdin(sid, remint10); // gen=5, now current
    const reported10 = pastedContentWrap("q10full", sharedContent10);
    const lines10 = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported10 });
    });

    const replayLine10 = lines10.find((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] "));
    check("10: dc92f4b6's own detector fires", !!replayLine10);
    check("10: REQUIRED — prefers genA (gen=2, unresolved), never genB (gen=3, resolved via mismatchResolvedGens)",
      /recognizedGen=2\b/.test(replayLine10 ?? ""));

    const live10 = host.live.get(sid);
    check("10: genA (gen=2) is NOW marked resolved — its real pending timer will stay silent", live10.mismatchResolvedGens.has(2));
    check("10: generation 5 (the current re-mint) is ALSO marked resolved", live10.mismatchResolvedGens.has(5));

    const fired10 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid && e.info.gen === 2), WINDOW_MS * 2).catch(() => false);
    check("10: REQUIRED — genA's own onPromptMismatchUnresolved does NOT fire", !fired10);
  }

  // ===== 11. NEGATIVE CONTROL, BARE twin of scenario 4 (card 1c7a5e12, Code Review follow-up — reviewer
  // 514cae2a, pins the record's own Do-not #4: the BARE twin must apply the SAME tag-stripping discipline,
  // never a looser one): generation 2 is an UNRELATED new message (no re-mint tag at all), and the engine
  // happens to echo back a stale, unconfirmed generation 1 wrapped in BARE pasted-content framing. Must
  // NOT confirm via `findRecognizedBarePastedContentWrapOfPriorWrite` (generation 2 carries no tag to
  // strip) — falls to 437daade's own pre-existing, tag-free `identicalContentPriorEntryBare` ring scan
  // instead, exactly as the FULL twin falls to `identicalContentPriorEntryFull` in scenario 4. =====
  {
    const sid = newSession("BareUnrelatedCurrentGenCounterSpecimen"); SIDS.push(sid);
    const genOneText11 = "A".repeat(500); // gen=1, never confirmed
    host.enqueueStdin(sid, genOneText11);
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const unrelatedNewMessage11 = "B".repeat(500);
    host.enqueueStdin(sid, unrelatedNewMessage11); // gen=2, now written and current, no tag at all

    const reported11 = bareContentWrap("q11bare", genOneText11);
    const lines11 = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported11 });
    });

    check("11: NEGATIVE CONTROL — the BARE tagged detector does NOT fire for an unrelated current generation (no tag to strip)",
      lines11.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    check("11: generation 2's own genuine loss is classified via the PRE-EXISTING bare-wrap-of-prior arm (never unmatchable, never silently confirmed either)",
      host.getLastMismatchUnmatched(sid) === null &&
      lines11.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("11: REQUIRED — the generic manager push does NOT fire for this NAMED shape",
      lines11.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live11 = host.live.get(sid);
    check("11: generation 1 (the matched entry) IS marked resolved", live11.mismatchResolvedGens.has(1));
    check("11: generation 2 is NOT marked resolved by an echo that has nothing to do with it", !live11.mismatchResolvedGens.has(2));
    check("11: REQUIRED — the follow-up unresolved-timer IS armed for generation 2 (never silent)",
      live11.pendingMismatchUnresolvedTimers.size === 1);
    const fired11 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid));
    check("11: REQUIRED — onPromptMismatchUnresolved actually FIRES once the window elapses with nothing to resolve it", fired11);
  }

  // ===== 12. NEGATIVE CONTROL, BARE twin of scenario 6 (card 1c7a5e12, Code Review follow-up — reviewer
  // 514cae2a, pins the record's own Do-not #4): gen1=A (unconfirmed), gen2=B (an ORDINARY, UNRELATED new
  // message, no tag), gen3=a tagged re-send of B SPECIFICALLY (never A) — current. Engine echoes a BARE
  // wrap of A. The decoupled-pairing hazard (inner matches gen1=A, `strippedCurrent` separately matches
  // gen2=B) must NOT confirm via the BARE tagged detector — falls to 437daade's own pre-existing,
  // tag-free `identicalContentPriorEntryBare` ring scan instead, exactly as the FULL twin in scenario 6. =====
  {
    const sid = newSession("BareSameEntryPairingCounterSpecimen"); SIDS.push(sid);
    const genOneText12 = "A".repeat(500);
    const genTwoText12 = "B".repeat(500);

    host.enqueueStdin(sid, genOneText12); // gen=1, never confirmed
    host.deliverHook(sid, { hook_event_name: "Stop" });

    host.enqueueStdin(sid, genTwoText12); // gen=2 — an ORDINARY, UNRELATED new message, no tag
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const remintOfB12 = framePossibleDuplicate(genTwoText12, ROOT_MSG_ID);
    host.enqueueStdin(sid, remintOfB12); // gen=3, now written and current — re-mints gen=2 (B), not gen=1 (A)
    check("SETUP 12: gen=3 is the re-mint of gen=2 (B), not gen=1 (A)", remintOfB12.includes(genTwoText12) && !remintOfB12.includes(genOneText12));

    const reported12 = bareContentWrap("q12bare", genOneText12);
    const lines12 = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported12 });
    });

    check("12: NEGATIVE CONTROL (decoupled-pairing counter-specimen) — the BARE tagged detector does NOT fire (wrong entry pairing)",
      lines12.filter((l) => l.startsWith("[prompt-mismatch-pasted-content-wrap-replay] ")).length === 0);
    check("12: generation 3's own genuine loss is classified via the PRE-EXISTING bare-wrap-of-prior arm",
      host.getLastMismatchUnmatched(sid) === null &&
      lines12.some((l) => l.startsWith("[prompt-mismatch-arm] ") && /\barm=fallback-wrapped-replay-awaiting-resolution\b/.test(l)));
    check("12: REQUIRED — the generic manager push does NOT fire for this NAMED shape",
      lines12.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] ")).length === 0);
    const live12 = host.live.get(sid);
    check("12: generation 1 (the matched entry) IS marked resolved", live12.mismatchResolvedGens.has(1));
    check("12: generation 3 is NOT marked resolved by an echo that matches the WRONG entry", !live12.mismatchResolvedGens.has(3));
    check("12: REQUIRED — the follow-up unresolved-timer IS armed for generation 3 (never silent)",
      live12.pendingMismatchUnresolvedTimers.size === 1);
    const fired12 = await waitUntil(() => unresolvedEvents.some((e) => e.sessionId === sid));
    check("12: REQUIRED — onPromptMismatchUnresolved actually FIRES once the window elapses with nothing to resolve it", fired12);
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card dc92f4b6's own gap is closed: a late engine echo wrapping an EARLIER generation's own recorded write in pasted-content paste-composer framing is now fully confirmed ONLY when the wrap's inner content AND the current generation's own (tag-stripped) intended text both match the SAME prior entry (paired per-entry, never decoupled — the round-2 Code Review counter-specimen, scenario 6, proves this; and a wrap-only match against any stale entry regardless of the current generation, the round-1 counter-specimen, scenario 4, stays refused too), no longer falsely classified as unmatchable for the real shape, no longer pushes a false `[loom:prompt-mismatch-unmatched]` \"possible LOSS\" alarm to the manager for it, marks BOTH the matched prior generation (a real effect) and the current generation (state hygiene, no observable effect) resolved, and its session-facing notice states CONTENT identity plainly (never lineage) while naming the current generation's own pending tagged write — not the already-confirmed one — as the duplicate-check risk; a genuinely different wrapped body and a superset match still push the old generic manager alarm exactly as before, and the trimEnd() allowance holds independently on the wrap side and the current-generation side. UPDATED by card 437daade: the unrelated-current-generation and decoupled-pairing counter-specimens (scenarios 4/6) no longer fall through to the generic alarm — a NEW, tag-free detector now names each as its own full-wrapped-replay arm (loud, an individually-armed follow-up timer, strictly more informative for the same underlying fact), never confirming the wrong generation either way. UPDATED by card 1c7a5e12: a BARE-wrapped tagged re-mint (scenario 7) is now ALSO recognized (bare=true), closing the false alarm where its own unresolved timer used to fire loud despite the content having fully arrived; and when two ring entries share identical content, the detector now PREFERS an unresolved match over an already-resolved one (scenario 8, and its mismatchResolvedGens-variant twin, scenario 10), so an already-resolved, newer entry can no longer shadow a genuinely-pending older one and strand its real timer — while a resolved-only fallback (scenario 9, no unresolved candidate at all) still confirms silently exactly as before, so that existing coverage is preserved, never regressed. Scenarios 11/12 pin the BARE twin's own Do-not #4 — the SAME tag-stripping and entry-pairing discipline as FULL, never a looser one, for the unrelated-current-generation and decoupled-pairing counter-specimens respectively."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
