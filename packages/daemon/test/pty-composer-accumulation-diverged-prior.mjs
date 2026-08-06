// Card d005f55b — successor to f5f6515a (card c2c750a9's original composer-accumulation detector,
// pty-composer-accumulation.mjs). That detector sums `recentWrittenTurns` (what LOOM WROTE) and can never
// confirm a fusion whose PRIOR generation's own reported echo had ALREADY diverged from what Loom wrote for
// it — the exact shape §THE COMPOUNDING MECHANISM measured, arithmetically exact, on the manager's own live
// session (session eb5bd347, gen=10/gen=11): written 1893/1126, reported 2161/3287, and
// `1126 + 2161 = 3287` exactly (`reported(11) = written(11) + reported(10)`, not `written(11) +
// written(10)`).
//
// This file proves TWO additions, both from card d005f55b's DoD:
//   DoD-2 — `detectComposerAccumulationOverDivergedPrior`: an ADDITIVE candidate (prior generation's own
//           REPORTED signature + current generation's own WRITTEN text), still exact-sum AND exact-hash
//           (via `fnv1a32Continue`, which extends a hash without needing the prior generation's full
//           text). Reported under its OWN verdict tag/notice, never folded into a plain CONFIRMED fusion.
//   DoD-3 — the floor item: when NEITHER an exact replay NOR either confirmed-accumulation shape explains
//           `reported`, test whether it nonetheless CONTAINS a recorded PRIOR write as a substring
//           (`findRecognizedSubstring`) and say so, instead of the old "could not be matched... at all"
//           wording that reads identically to a genuinely uncharacterized mismatch.
//
// POSITIVE CONTROL, BOTH DIRECTIONS (per this repo's standing verification posture):
//   1. The card's own gen=10/gen=11 fixture (1893/2161, 1126/3287) MUST fire
//      [composer-accumulation-diverged-prior] CONFIRMED — AND the ORIGINAL detector
//      (`detectComposerAccumulation`, written-only) MUST NOT confirm the same specimen (the actual gap
//      card d005f55b exists to close — verified directly against the diagnostic log, not assumed).
//   2. A same-length but WRONG-ORDER variant (current-written + prior-reported, instead of
//      prior-reported + current-written) MUST NOT confirm — proving the hash extension is genuinely
//      order-sensitive, not a length-only check wearing a hash's clothes.
//   3. An ordinary clean gen sequence stays SILENT on both new tags.
//   4. The card's own motivating gen=4 specimen shape (a stale paste-collapse placeholder + an EARLIER
//      generation's full written text + the CURRENT generation's own written text) — neither new detector
//      confirms it (by construction: the placeholder is foreign to both rings), but
//      [prompt-mismatch-unmatched-remainder] fires, correctly recognizing the earlier generation's own
//      write as a substring with the placeholder as the LEADING remainder and the current generation's
//      own text as the TRAILING remainder — and the session-facing notice says so instead of the old
//      blanket "could not be matched... at all" wording.
//   5. Manager-supplied LIVE evidence (sessions 494db005/f6eeeb52, 2026-08-06): reported SHORTER than
//      intended by exactly the possible-duplicate tag's own 40-char length, divergesAtChar=0 — CONFIRMS
//      Candidate #3 (a Loom redelivery wrapper) as a real DEFICIT shape (not a fusion — those are always
//      longer). `detectPossibleDuplicateWrapperDeficit` recognizes it precisely, by reusing the EXISTING
//      `stripPossibleDuplicateFrame` (no new matcher), and the notice re-states the duplicate-check
//      warning the missing tag would otherwise have carried.
//
// Mirrors pty-composer-accumulation.mjs's harness: the REAL PtyHost state machine + a FAKE pty (createPty
// seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-composer-accumulation-diverged-prior.mjs  (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-composer-diverged-prior-${Date.now()}-${process.pid}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Card 1addef27 (fixed-wait-negative-guard): a bounded POLL on the actual completion signal (the notice's
// own enqueue), not a fixed clock — mirrors pty-prompt-mismatch.mjs's own waitUntil.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

function newSession(name) {
  const sid = `sess-${name}`;
  host.spawn({ sessionId: sid, cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  host.deliverHook(sid, { hook_event_name: "SessionStart" });
  return sid;
}

// Captures console.log lines matching a given tag prefix for the duration of a block.
function captureTag(tag, fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string" && msg.includes(tag)) lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL: the card's own gen=10/gen=11 fixture — written 1893/1126, reported
  // 2161/3287 — FIRES [composer-accumulation-diverged-prior] CONFIRMED, and the ORIGINAL detector does
  // NOT (proving this is a genuinely new capability, not a restatement). =====
  {
    const sid = newSession("DivergedPrior"); SIDS.push(sid);

    // Gen 1 (stands in for the card's gen=10): Loom writes 1893 chars; the engine reports back something
    // that MISMATCHES (2161 chars, not equal to anything Loom wrote) — but is constructed to be
    // WHITESPACE-EQUIVALENT to what Loom wrote (`\n` written vs `\r\n` reported, in the SAME 268
    // positions — normalizeForMismatchNotice's own \r\n->\n collapse makes the two reconcile exactly),
    // deliberately routing through the EXISTING `isBenignWhitespaceRerender` suppression (card cf2fef73)
    // so gen=1's own mismatch does NOT enqueue its own session-facing notice. This is a test-harness
    // convenience, not a claim about the real specimen's own cause (§THE COMPOUNDING MECHANISM's own
    // bound: that cause is unestablished) — it exists ONLY so gen=1's own notice-and-resubmit cascade
    // (itself consuming a generation, per host.ts's own "SELF-REFERENCE, NOTED AND BOUNDED" doc) doesn't
    // shift generation numbers and shadow the very prior-reported entry gen=2 needs to test against. The
    // diagnostic rings/logs this scenario actually asserts on are UNCONDITIONAL on this suppression (see
    // that same doc comment in host.ts) — only the suppressed notice is skipped, nothing else changes.
    const gen1Written = "\n".repeat(268) + "w".repeat(1625); // 268 + 1625 = 1893
    const gen1Reported = "\r\n".repeat(268) + "w".repeat(1625); // (2*268) + 1625 = 2161
    check("SETUP: gen=1's written/reported pair is whitespace-equivalent (suppresses its own notice) yet has the fixture's exact lengths",
      gen1Written.length === 1893 && gen1Reported.length === 2161 && gen1Reported.replace(/\r\n/g, "\n") === gen1Written);
    host.enqueueStdin(sid, gen1Written);
    const gen1Lines = captureTag("[composer-accumulation", () => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Reported });
    });
    check("1: gen=1's own unmatched mismatch (1893 written, 2161 reported, unrelated content) fires NEITHER new tag yet — nothing to compound from", gen1Lines.length === 0);
    const fake = fakesById.get(sid);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    // The whitespace-equivalence suppression gates the notice's `setTimeout(...)` scheduling itself (see
    // host.ts's own `if (!isBenignWhitespaceRerender && !isStalePlaceholderPrefix)` guard) — when it
    // holds, NOTHING is scheduled at all, so there is no async completion to wait for here; proceeding
    // straight to gen=2 is correct, not a race. The downstream priorGen=1/sumOfLens=3287 checks below are
    // themselves strong evidence this held: had gen=1's own notice fired, it would consume a generation
    // and shadow the very recentReportedTurns entry those checks depend on, and they would fail.

    // Gen 2 (stands in for the card's gen=11): Loom writes 1126 chars; the engine reports back EXACTLY
    // gen=1's own reported text followed by gen=2's own written text — 2161 + 1126 = 3287, the card's own
    // arithmetic, reproduced with real (if synthetic) bytes so the hash extension is genuinely exercised,
    // not just the sum.
    const gen2Written = "x".repeat(1126);
    const gen2Reported = gen1Reported + gen2Written;
    check("SETUP: reproduces the card's own committed regression fixture (1893/2161 and 1126/3287)",
      gen1Written.length === 1893 && gen1Reported.length === 2161 && gen2Written.length === 1126 && gen2Reported.length === 3287);
    host.enqueueStdin(sid, gen2Written);
    const gen2Lines = captureTag("[composer-accumulation", () => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen2Reported });
    });
    // Exact-tag match (line START, not `.includes`) — the diverged-prior tag's own log line legitimately
    // MENTIONS "[composer-accumulation]" in its prose (contrasting itself against a clean fusion), so a
    // bare substring check would false-positive on the wrong tag's own descriptive text.
    const cleanConfirmed = gen2Lines.filter((l) => l.startsWith("[composer-accumulation] ") && l.includes("CONFIRMED"));
    const divergedConfirmed = gen2Lines.filter((l) => l.startsWith("[composer-accumulation-diverged-prior] ") && l.includes("CONFIRMED"));
    check("1: POSITIVE CONTROL — [composer-accumulation-diverged-prior] CONFIRMED fires on the exact gen=10/gen=11 fixture shape",
      divergedConfirmed.length === 1);
    check("1: it names the prior generation (gen=1, standing in for gen=10) and the exact sum (3287)",
      /priorGen=1\b/.test(divergedConfirmed[0] ?? "") && /sumOfLens=3287\b/.test(divergedConfirmed[0] ?? ""));
    check("1: NEGATIVE CONTROL — the ORIGINAL written-only detector does NOT confirm this specimen (the actual gap this card closes: 1893+1126=3019 != 3287)",
      cleanConfirmed.length === 0);

    // The session-facing notice itself: its own verdict kind, never worded as a plain CONFIRMED fusion.
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("1: the notice enqueues for a confirmed diverged-prior accumulation (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("1: REQUIRED — \"possible LOSS\" must never appear in a confirmed diverged-prior notice", !/possible LOSS/.test(noticeText));
    check("1: the notice states its OWN verdict kind, distinct from a clean fusion", /DISTINCT FROM A CLEAN FUSION/.test(noticeText));
    check("1: it names the diverged prior generation and says nothing of THIS turn's own content was lost", /generation 1/.test(noticeText) && /nothing of THIS turn's own content was lost/.test(noticeText));
  }

  // ===== 2. NEGATIVE CONTROL: same total length (2161 + 1126 = 3287) but WRONG ORDER — current-written
  // FIRST, prior-reported SECOND — must NOT confirm. Proves the hash extension is order-sensitive, the
  // same discipline detectComposerAccumulation's own reorder counterexample already established for the
  // written-only detector. =====
  {
    const sid = newSession("WrongOrder"); SIDS.push(sid);
    const gen1Written = "p".repeat(1893);
    const gen1Reported = "q".repeat(2161);
    host.enqueueStdin(sid, gen1Written);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: gen1Reported });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const gen2Written = "s".repeat(1126);
    const wrongOrderReported = gen2Written + gen1Reported; // reversed: current-written + prior-reported
    host.enqueueStdin(sid, gen2Written);
    const lines = captureTag("[composer-accumulation-diverged-prior]", () => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: wrongOrderReported });
    });
    check("2: NEGATIVE CONTROL — same total length (3287), wrong byte order, does NOT confirm (hash refuses)", lines.length === 0);
    host.deliverHook(sid, { hook_event_name: "Stop" });
  }

  // ===== 3. NEGATIVE / CLEAN CONTROL: an ordinary clean gen sequence stays SILENT on the new tag. =====
  {
    const sid = newSession("Clean"); SIDS.push(sid);
    const text1 = "clean turn one, byte-identical";
    const text2 = "clean turn two, byte-identical";
    const lines = captureTag("[composer-accumulation-diverged-prior]", () => {
      host.enqueueStdin(sid, text1);
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text1 });
      host.deliverHook(sid, { hook_event_name: "Stop" });
      host.enqueueStdin(sid, text2);
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: text2 });
      host.deliverHook(sid, { hook_event_name: "Stop" });
    });
    check("3: an ordinary clean gen sequence never fires the diverged-prior tag", lines.length === 0);
  }

  // ===== 4. DoD-3: the card's own motivating gen=4 specimen shape — <26ch stale placeholder> + <an
  // EARLIER generation's full written text> + <the CURRENT generation's own written text>. Neither new
  // detector confirms it (the placeholder breaks BOTH exact-sum candidates, by construction) — this is
  // exactly §THE GAP's own point — but the substring recognizer must still name what it DID recognize,
  // even though the earlier generation's write is SANDWICHED in the middle (not at either edge — the exact
  // shape an edge-only substring check would have missed). =====
  {
    const sid = newSession("Sandwiched"); SIDS.push(sid);
    const earlierGenText = "e".repeat(4819); // stands in for the card's gen=3 (4819 chars)
    const currentGenText = "c".repeat(1123); // stands in for the card's gen=4 (1123 chars)
    const stalePlaceholder = "[Pasted text #7 +12 lines]"; // an arbitrary, non-matching placeholder

    // Gen 1: an ordinary CLEAN turn (byteIdentical) — establishes both recentWrittenTurns AND
    // recentReportedTurns entries for it, so this scenario also proves the diverged-prior candidate
    // correctly REFUSES even when the prior generation's own report was clean (sum still short by the
    // placeholder's own length either way).
    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Gen 2: Loom writes currentGenText, but the engine reports back the placeholder PREPENDED onto the
    // earlier generation's own full text, PREPENDED onto this generation's own text.
    const sandwichedReported = stalePlaceholder + earlierGenText + currentGenText;
    host.enqueueStdin(sid, currentGenText);
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const capturedLines = [];
    const origLog = console.log;
    console.log = (msg) => { if (typeof msg === "string") capturedLines.push(msg); };
    try {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: sandwichedReported });
    } finally {
      console.log = origLog;
    }
    const confirmedAny = capturedLines.filter((l) => l.includes("[composer-accumulation") && l.includes("CONFIRMED"));
    check("4: neither new detector confirms the sandwiched-placeholder shape (both exact-sum candidates are short by the placeholder's own length)", confirmedAny.length === 0);
    const remainderLines = capturedLines.filter((l) => l.includes("[prompt-mismatch-unmatched-remainder]"));
    check("4: [prompt-mismatch-unmatched-remainder] fires — the substring search finds the SANDWICHED prior write, not just edge matches", remainderLines.length === 1);
    check("4: it recognizes the EARLIER generation (gen=1), not the current one", /recognizedGen=1\b/.test(remainderLines[0] ?? ""));
    check("4: it names the matched length (the earlier generation's own 4819 chars)", /matchedLen=4819\b/.test(remainderLines[0] ?? ""));
    check("4: the LEADING remainder is exactly the placeholder's own length", new RegExp(`leadingRemainderLen=${stalePlaceholder.length}\\b`).test(remainderLines[0] ?? ""));
    check("4: the TRAILING remainder is exactly the current generation's own length (1123 chars)", /trailingRemainderLen=1123\b/.test(remainderLines[0] ?? ""));

    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("4: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("4: the notice names what WAS recognized instead of the old blanket \"could not be matched... at all\" wording",
      /DOES contain generation 1's own recorded write as a substring/.test(noticeText));
    check("4: the old un-enriched fallback phrase does NOT appear for this recognized case",
      !/does not match any of this session's own recent writes that Loom still has a record of\. Every measured occurrence/.test(noticeText) &&
      !/does not match any of this session's own recent writes that Loom still has a record of\. There is no earlier write recorded/.test(noticeText));
    check("4: it asserts no new confidence — explicitly says this is not a confirmed replay or accumulation",
      /not a confirmed replay or accumulation/.test(noticeText));
  }

  // ===== 5. Manager-supplied LIVE evidence (sessions 494db005/f6eeeb52, then CORRECTED by card 854d1632's
  // further measurement, 2026-08-06): reported is the engine's report of intended TEXT MINUS a
  // Loom-authored possible-duplicate tag, byte-for-byte — confirms Candidate #3 as a real DEFICIT-shaped
  // byte pattern (reported SHORTER), not a fusion, but the CORRECTED mechanism is a stale/out-of-order
  // confirmation, NOT loss (the wrapper reaches the engine and echoes byte-identically in the ordinary
  // case, per card 854d1632's own measurement) — the notice must say so, never "possible LOSS" or "did
  // not reach you". Uses the REAL `framePossibleDuplicate` (not a hand-rolled string) so this test
  // exercises the actual tag format. =====
  {
    const sid = newSession("WrapperDeficit"); SIDS.push(sid);
    const baseText = "## Where you edit (your isolated git worktree)\nMake ALL edits here.";
    const intended = framePossibleDuplicate(baseText, "5f790fdf-aaaa-bbbb-cccc-dddddddddddd");
    check("SETUP: the real framePossibleDuplicate produces a tag of exactly 40 chars (matches both live specimens' lenDelta=-40)",
      intended.length - baseText.length === 40);
    host.enqueueStdin(sid, intended);
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const capturedLines = [];
    const origLog = console.log;
    console.log = (msg) => { if (typeof msg === "string") capturedLines.push(msg); };
    try {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: baseText }); // the tag stripped, exactly
    } finally {
      console.log = origLog;
    }
    const deficitLines = capturedLines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-deficit] "));
    check("5: POSITIVE CONTROL — [prompt-mismatch-wrapper-deficit] fires on the real tag-stripped specimen", deficitLines.length === 1);
    check("5: it names the exact stripped length (40, matching both live specimens)", /strippedTagLen=40\b/.test(deficitLines[0] ?? ""));
    check("5: neither accumulation detector confirms this shape (it's a DEFICIT, not a fusion — those are always longer)",
      !capturedLines.some((l) => (l.startsWith("[composer-accumulation] ") || l.startsWith("[composer-accumulation-diverged-prior] ")) && l.includes("CONFIRMED")));

    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("5: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("5: REQUIRED — the notice explicitly says this is NOT a loss", /NOT A LOSS/.test(noticeText));
    check("5: it names the corrected mechanism (a stale, out-of-order confirmation of an earlier write)", /STALE, out-of-order confirmation/.test(noticeText));
    check("5: it does NOT claim the tag failed to reach the recipient (the earlier, wrong framing this corrects)",
      !/did not reach you/.test(noticeText) && !/TREAT THIS TURN'S CONTENT AS A POSSIBLE DUPLICATE ANYWAY/.test(noticeText));
    check("5: it does NOT use the generic \"possible LOSS\" framing (measured as a non-loss ordering artifact, card 854d1632)",
      !/possible LOSS/.test(noticeText));

    // NEGATIVE CONTROL: a same-length-delta (40 chars shorter) mismatch that is NOT actually the real tag
    // format must NOT confirm — proving this is an exact, non-heuristic match on the real tag regex, not a
    // bare "starts 40 chars short" heuristic.
    const sid2 = newSession("WrapperDeficitNegative"); SIDS.push(sid2);
    const fakeIntended = "x".repeat(40) + baseText; // same 40-char delta, but NOT the real tag pattern
    host.enqueueStdin(sid2, fakeIntended);
    const negLines = [];
    const orig2 = console.log;
    console.log = (msg) => { if (typeof msg === "string" && msg.startsWith("[prompt-mismatch-wrapper-deficit] ")) negLines.push(msg); };
    try {
      host.deliverHook(sid2, { hook_event_name: "UserPromptSubmit", prompt: baseText });
    } finally {
      console.log = orig2;
    }
    check("5: NEGATIVE CONTROL — a same-length-delta mismatch that is NOT the real tag pattern does NOT confirm (exact regex match, not a bare length heuristic)", negLines.length === 0);
    host.deliverHook(sid2, { hook_event_name: "Stop" });
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card d005f55b's diverged-prior compounding detector (DoD-2) fires its OWN verdict kind [composer-accumulation-diverged-prior] on the card's own committed gen=10/gen=11 regression fixture (1893/2161, 1126/3287) — a specimen the ORIGINAL written-only detector provably cannot confirm (1893+1126=3019 != 3287) — refuses a same-length wrong-order variant (order-sensitivity proof), stays silent on ordinary clean turns, and correctly ALSO refuses the card's own motivating sandwiched-placeholder specimen (both exact-sum candidates are short by the placeholder's length). For that last, otherwise-unmatched case, DoD-3's substring recognizer finds the earlier generation's write even though it is SANDWICHED in the middle (not at either edge — an edge-only check would have missed it), correctly separates the leading (placeholder) and trailing (current turn's own text) remainders, and the session-facing notice names what was recognized instead of reading as a plain \"matched nothing\". Also confirms the manager-supplied LIVE possible-duplicate-tag DEFICIT specimen (sessions 494db005/f6eeeb52, mechanism corrected by card 854d1632): a precise, non-heuristic detector fires its own tag, the notice explicitly says NOT A LOSS and names the corrected stale-confirmation mechanism (never the earlier, wrong 'did not reach you' framing), and a same-length-delta-but-wrong-pattern negative control refuses."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
