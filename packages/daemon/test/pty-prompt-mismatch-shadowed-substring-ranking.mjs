// Card fce93534 — `findRecognizedSubstring` (pty/host.ts, ~line 352) used to return the FIRST
// (most recent) ring entry that is a substring of `reported`, never the BEST match. For the
// NON-identical shape — `reported` is NOT exactly the anchored full-string wrap of any one ring
// entry, so `identicalContentPriorEntryBare`/`Full` (card 437daade's own ring-scan fix) cannot fire
// at all — a short, unrelated, MORE RECENT ring entry whose text happens to appear as a trivial
// substring (e.g. literally inside the engine's own static "<pasted_content ...>" tag text) shadows
// an OLDER entry's own much more complete, genuinely-wrapped match.
//
// STEP 1 checkpoint (manager-approved): this is purely an ATTRIBUTION defect. Every downstream
// consumer of `unmatchedRecognized` (its only caller) either (a) only NAMES a gen in a diagnostic
// log / session notice, or (b) gates on `unmatchedRecognized !== null` as a bare boolean, never on
// WHICH gen matched. `unmatchedRecognized.gen` is NEVER added to `live.mismatchResolvedGens`
// anywhere. So the shadowing bug never flips LOUD->silent — it only names the wrong, less useful
// generation. See docs/decisions/fce93534-findrecognizedsubstring-prefers-framing-explained-candidate.md
// for the fix's own full narrative and "Do not" list.
//
// THE FIX: scan every substring-matching candidate (not just the first hit); among them, prefer one
// whose remainder — reconstructed as `leadingRemainder + entry.text + trailingRemainder`, i.e.
// `reported` itself — is a "pure wrap framing" of that entry's OWN text. "Pure framing" reuses the
// EXISTING, UNMODIFIED `isRecognizedBarePastedContentWrapOfCurrent`/`isRecognizedPastedContentWrap`
// recognizers verbatim (no new independent regex) — the ONLY widening is tolerating OUTER trailing
// whitespace after the closing tag. This mirrors (does not duplicate) card 7c1487c8's own
// already-established engine behavior (the composer trims/adds trailing whitespace around
// pasted-content payloads) — card 7c1487c8's own tolerance is for the INNER body, immediately before
// the closing tag; this is the OUTER boundary, immediately after it. Non-whitespace suffix content
// still disqualifies a candidate. When NO candidate is framing-explained, behavior is BYTE-IDENTICAL to
// before this fix (the same newest-first single hit).
//
// ROUND 2 (Code Review BLOCKING, reviewer c8f6528c): the round-1 cut tested a blind `reported.trimEnd()`
// against both recognizers, which silently broke the FULL-framing shape (`PASTED_CONTENT_WRAP_RE`
// requires a mandatory trailing "\n" that trimEnd() removes). Fixed by trying RAW `reported` first, then
// — for the full shape only — trimming and restoring exactly the one mandatory trailing "\n". Scenario
// 1b below is the full-framing twin of scenario 1, RED-proven against commit 2b69ebf3 (the round-1 cut).
// Scenario 4 (tie-break) was also strengthened (m2): the round-1 version passed on the ORIGINAL pre-fix
// code too, since it never placed a genuinely competing non-framing candidate in the mix — it now does.
//
// RED/GREEN PROTOCOL: scenario 1 (and 1b) are run against the CURRENT (possibly pre-fix) dist build and
// their own results are asserted explicitly — run this file once BEFORE a fix lands (expect the RED
// assertions to fail, proving the repro is real) and once AFTER (expect them to pass). No stash/patch
// needed for scenario 1: this file never special-cases its own expectations by git state, it just
// asserts the correct (post-fix) answer; scenario 1b's own RED proof against 2b69ebf3 was captured via a
// temporary revert of `isPureWrapFramingOfEntry` alone (see the round-2 worker_report for the exact
// before/after diff), not re-derivable from this file's own text.
//
// Mirrors pty-prompt-mismatch-wrapped-remainder-replay.mjs's own harness: the REAL PtyHost state
// machine + a FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-shadowed-substring-ranking.mjs (build first:
// from packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-shadowed-substring-ranking-${Date.now()}-${process.pid}`);
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-shadowed-substring-ranking: predicate" });
  } catch (err) {
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

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => { if (typeof msg === "string") lines.push(msg); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

const wrapRemainder = (id, inner) => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;
// The FULL-framing shape (card 7c1487c8's own PASTED_CONTENT_WRAP_RE) — double leading newline, single
// MANDATORY trailing newline, distinct from the bare shape above.
const fullWrapRemainder = (id, inner) => `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;
const recognizedGenOf = (lines) => {
  const m = /recognizedGen=(\d+)/.exec(lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "");
  return m ? Number(m[1]) : null;
};

const SIDS = [];

try {
  // ===== 1. THE REPRO — a short, unrelated, MORE RECENT entry ("content") shadows an older, genuinely
  // wrapped entry (Y, 60 chars) whose wrap carries ONE extra trailing space (disqualifying the
  // already-fixed 437daade whole-match mechanism, so only findRecognizedSubstring can explain anything
  // at all). Must now name gen=1 (the real, nearly-complete wrapped payload), not gen=2 (the trivial
  // "content" hit inside the static tag text). =====
  {
    const sid = newSession("ShadowedByTrivialTagSubstring"); SIDS.push(sid);
    const Y = "K".repeat(60);
    host.enqueueStdin(sid, Y);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=1, never confirmed

    const shortUnrelated = "content"; // occurs naturally inside "<pasted_content ...></pasted_content ...>"
    host.enqueueStdin(sid, shortUnrelated);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=2, never confirmed

    const current = "Z".repeat(10);
    host.enqueueStdin(sid, current); // gen=3, current

    const reported = `${wrapRemainder("pcwr", Y)} `; // one extra trailing space
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("1: SETUP — gen=2's short text IS a literal substring of the static tag framing (the shadowing precondition)",
      reported.includes(shortUnrelated));
    check("1: SETUP — reported is NOT the exact anchored bare-wrap of Y (extra trailing space disqualifies the whole-match mechanism)",
      reported !== wrapRemainder("pcwr", Y));
    check("1: REQUIRED (the fix) — findRecognizedSubstring now names gen=1 (the real, 60-char wrapped payload), not the shadowing gen=2",
      recognizedGenOf(lines) === 1);
    const remainderLine = lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "";
    check("1: matchedLen=60 (the whole payload), not 7 (the trivial shadowing hit)", /matchedLen=60\b/.test(remainderLine));

    // Severity unaffected: still LOUD (fallback-unrecognized + the manager push), not silent — matches
    // the STEP 1 checkpoint's own finding, and must stay true after the fix too.
    const armLines = lines.filter((l) => l.startsWith("[prompt-mismatch-arm] "));
    check("1: arm stays fallback-unrecognized (LOUD, unaffected by the attribution fix)",
      armLines.length === 1 && /\barm=fallback-unrecognized\b/.test(armLines[0] ?? ""));
    const pushedLines = lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-pushed] "));
    check("1: the manager push STILL fires — the fix only changes attribution, never severity",
      pushedLines.length === 1);

    // Attribution-only: the corrected attribution must NOT resolve anything (manager's explicit
    // constraint) — `unmatchedRecognized` never confirms, so gen=1 must stay unresolved.
    const live = host.live.get(sid);
    check("1: REQUIRED — gen=1 is NOT marked resolved by this attribution fix (unmatchedRecognized stays attribution-only, never a confirmation)",
      !live.mismatchResolvedGens.has(1));
    check("1: gen=2 is also not marked resolved", !live.mismatchResolvedGens.has(2));

    // The already-fixed 437daade whole-match mechanism must genuinely NOT be what's firing here —
    // otherwise this specimen wouldn't be testing the residual gap fce93534 closes at all.
    const wholeMatchLines = lines.filter((l) =>
      l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ") ||
      l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] "));
    check("1: SETUP — the 437daade whole-match mechanism does NOT fire for this specimen (confirms this exercises the residual gap, not the already-fixed case)",
      wholeMatchLines.length === 0);

    // The session-facing notice itself must now read the corrected attribution.
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("1: the notice enqueues", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    await waitUntil(() => fake.writes.slice(writesBefore).join("").includes("your next report up."));
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("1: REQUIRED — the session notice now names generation 1 (not 2)", /generation 1's own recorded write/.test(noticeText));
    check("1: the notice no longer misattributes to generation 2", !/generation 2's own recorded write/.test(noticeText));
  }

  // ===== 1b. THE FULL-FRAMING TWIN (Code Review BLOCKING, round 2, reviewer c8f6528c) — the SAME
  // shadowing shape as scenario 1, but using the FULL pasted-content framing (PASTED_CONTENT_WRAP_RE:
  // double leading newline, single MANDATORY trailing newline) instead of the bare shape. The round-1
  // fix's `reported.trimEnd()` ate that full shape's own mandatory trailing "\n", so the full-framing
  // recognizer could never match through `isPureWrapFramingOfEntry` at all — RED-proven against commit
  // 2b69ebf3 (the round-1 cut); must now correctly name gen=1 after the round-2 fix (raw-first, then
  // trim+restore the mandatory trailing newline only for the full shape). =====
  {
    const sid = newSession("ShadowedByTrivialTagSubstringFullFraming"); SIDS.push(sid);
    const Y = "F".repeat(60);
    host.enqueueStdin(sid, Y);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=1, never confirmed

    const shortUnrelated = "content";
    host.enqueueStdin(sid, shortUnrelated);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=2, never confirmed

    const current = "Z".repeat(10);
    host.enqueueStdin(sid, current); // gen=3, current

    const reported = `${fullWrapRemainder("pcwf", Y)} `; // one extra trailing space AFTER the mandatory "\n"
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("1b: SETUP — reported is NOT the exact anchored full-wrap of Y (extra trailing space disqualifies the whole-match mechanism)",
      reported !== fullWrapRemainder("pcwf", Y));
    check("1b: REQUIRED (the round-2 fix) — findRecognizedSubstring now names gen=1 for the FULL-framing shape too, not the shadowing gen=2",
      recognizedGenOf(lines) === 1);
    const remainderLine = lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "";
    check("1b: matchedLen=60 (the whole payload), not 7 (the trivial shadowing hit)", /matchedLen=60\b/.test(remainderLine));

    const wholeMatchLines = lines.filter((l) =>
      l.startsWith("[prompt-mismatch-pasted-content-wrap-remainder-replay] ") ||
      l.startsWith("[prompt-mismatch-full-pasted-content-wrap-remainder-replay] "));
    check("1b: SETUP — the 437daade whole-match mechanism does NOT fire for this specimen (same residual-gap framing as scenario 1)",
      wholeMatchLines.length === 0);

    const live = host.live.get(sid);
    check("1b: gen=1 still NOT marked resolved (attribution-only, unchanged for the full-framing shape too)",
      !live.mismatchResolvedGens.has(1));
  }

  // ===== 2. NO-SHADOW CONTROL — the SAME non-identical shape (extra trailing space), but with no
  // competing short entry. Must be UNCHANGED: already correctly named gen=1 before this fix, and must
  // stay so after it (proves the fix doesn't regress the ordinary, unshadowed case). =====
  {
    const sid = newSession("UnshadowedControlUnchanged"); SIDS.push(sid);
    const Y = "L".repeat(60);
    host.enqueueStdin(sid, Y);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=1, never confirmed

    const current = "W".repeat(10);
    host.enqueueStdin(sid, current); // gen=2, current — no shadowing competitor in between

    const reported = `${wrapRemainder("ctrl", Y)} `;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("2: CONTROL — unshadowed, still correctly names gen=1", recognizedGenOf(lines) === 1);
    const remainderLine = lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "";
    check("2: matchedLen=60 as before", /matchedLen=60\b/.test(remainderLine));
  }

  // ===== 3. NO CANDIDATE IS FRAMING-EXPLAINED — reported is NOT wrap-tag shaped at all (plain garbage
  // prefix/suffix around a prior entry's text), with TWO substring-matching candidates. Must preserve
  // today's exact newest-first fallback — the MORE RECENT entry wins even though it is a strictly
  // worse/less-complete explanation, because neither candidate qualifies as framing-explained. This is
  // the regression this fix must NOT touch (CLAUDE.md's own `pty-composer-accumulation-diverged-prior.mjs`
  // scenario 4 relies on this exact newest-first-fallback shape for a differently-shaped specimen). =====
  {
    const sid = newSession("NoFramingNewestFirstPreserved"); SIDS.push(sid);
    const olderText = "M".repeat(40);
    host.enqueueStdin(sid, olderText);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=1, never confirmed

    const newerText = "garbage"; // a literal substring of the plain (non-wrap) prefix below
    host.enqueueStdin(sid, newerText);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=2, never confirmed

    const current = "N".repeat(10);
    host.enqueueStdin(sid, current); // gen=3, current

    const reported = `PREFIX-garbage-${olderText}-SUFFIX`; // no wrap tags anywhere
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("3: SETUP — neither candidate's remainder is wrap-tag framing (no \"<pasted_content\" anywhere in reported)",
      !reported.includes("pasted_content"));
    check("3: REQUIRED — falls back to today's unchanged newest-first hit (gen=2, the shadowing \"garbage\" match), byte-identical to pre-fix behavior",
      recognizedGenOf(lines) === 2);
    const remainderLine = lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "";
    check("3: matchedLen=7 (\"garbage\"), confirming the OLD newest-first selection, not the framing-ranked one",
      /matchedLen=7\b/.test(remainderLine));
  }

  // ===== 4. TIE-BREAK, MADE DISCRIMINATING (m2, Code Review round 2) — the round-1 version of this
  // scenario passed on PRE-fix code too (its own SETUP check was a literal `true`, and with no competing
  // non-framing candidate, "newest framing-explained" and "newest-any" were the SAME gen either way — it
  // never actually exercised a choice). Fixed shape: gen=1 and gen=2 wrote byte-identical content (both
  // independently framing-explained once wrapped); gen=3, MORE RECENT than both, writes a short,
  // NON-framing substring ("content", same shadowing trick as scenario 1) ahead of them. This makes
  // newest-framing (gen=2) GENUINELY DIFFER from newest-ANY (gen=3) — on the ORIGINAL, pre-fce93534 code
  // (plain newest-first, no framing awareness at all) this would wrongly name gen=3; only a REAL
  // preference for a framing-explained candidate over a more recent non-framing one — the fix's own
  // function — produces gen=2. =====
  {
    const sid = newSession("TieBreakNewestFramingWins"); SIDS.push(sid);
    const duplicated = "DUP".repeat(20);
    host.enqueueStdin(sid, duplicated);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=1, never confirmed, text=duplicated

    host.enqueueStdin(sid, duplicated);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=2, never confirmed, SAME text=duplicated

    const shortUnrelated = "content"; // MORE RECENT than gen=1/gen=2, but NOT framing-explained
    host.enqueueStdin(sid, shortUnrelated);
    host.deliverHook(sid, { hook_event_name: "Stop" }); // gen=3, never confirmed

    const current = "Q".repeat(10);
    host.enqueueStdin(sid, current); // gen=4, current

    const reported = `${wrapRemainder("tie9", duplicated)} `;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    check("4: SETUP — gen=3's short text IS a literal substring of the static tag framing (a real, more-recent, non-framing competitor)",
      reported.includes(shortUnrelated));
    check("4: REQUIRED (discriminating) — newest-FRAMING (gen=2) wins over newest-ANY (gen=3), proving the preference is real, not incidental",
      recognizedGenOf(lines) === 2);
    const remainderLine = lines.find((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")) ?? "";
    check("4: matchedLen=60 (gen=2's full duplicated payload), not 7 (gen=3's trivial \"content\" hit)",
      /matchedLen=60\b/.test(remainderLine));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card fce93534's own residual shadowing gap is closed for BOTH wrap framings (bare and full, round 2): findRecognizedSubstring now prefers a framing-explained candidate (reusing the existing, unmodified wrap-tag recognizers, tolerating only outer trailing whitespace, with the full shape's mandatory trailing newline restored rather than eaten) over a shorter, more-recent, coincidental substring hit — while staying byte-identical to the old newest-first behavior whenever no candidate is framing-explained, and never resolving anything (attribution-only, unchanged)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
