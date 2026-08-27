// Card c23e2869 — d005f55b's own Candidate #3 ("a Loom redelivery wrapper"), arithmetically confirmed on
// a real specimen (session `daf64e68`, gen=10): `9,709 + 1,640 = 11,349` (an earlier generation's own
// recorded WRITTEN text plus the CURRENT write's own text with a redelivery wrapper stripped, equals
// `reported`'s length exactly) and, independently, `1,680 − 40 = 1,640` (the current write's own intended
// length minus the fixed 40-char redelivery-tag length). Both exact — the same self-checking regression
// discipline `pty-composer-accumulation-diverged-prior.mjs` used for d005f55b's own `1893/2161`/`1126/3287`
// fixture.
//
// THE GAP THIS CLOSES: `findRecognizedSubstring` (pty/host.ts, card d005f55b DoD-3) already recognizes an
// earlier generation's own written text as a SUBSTRING of `reported`, but reports anything left over as an
// unaccounted remainder — even when that remainder IS itself exactly explainable as the CURRENT
// generation's own intended text with a `[loom:possible-duplicate root:…]` redelivery wrapper stripped.
// `detectPossibleDuplicateWrapperDeficit` (card 854d1632) only tests the WHOLE `reported` string against
// the current write's own stripped text ALONE — it cannot confirm this FUSED shape (an earlier write PLUS
// the current write's own stripped text). Before this card, the specimen above fell all the way to
// `isUnmatchableMismatch` (`getLastMismatchUnmatched` fires, the session-facing notice says "partial
// recognition only ... NOT accounted for") even though every byte of it is genuinely explained.
//
// POSITIVE CONTROL, BOTH DIRECTIONS (per this repo's standing verification posture):
//   1. The card's own exact fixture (9709/1640/40/1680/11349) fires [prompt-mismatch-wrapper-aware-fusion]
//      CONFIRMED, is excluded from `isUnmatchableMismatch` (getLastMismatchUnmatched stays null — this IS
//      the RED-before/GREEN-after pivot: pre-fix, this exact specimen classifies as unmatchable), and the
//      session-facing notice says NOT A LOSS, never "possible LOSS" or "partial recognition only".
//   2. The SAME reconciling numbers but the OPPOSITE concatenation order (current-stripped THEN the
//      earlier entry) also confirms — proving the detector isn't order-anchored to one arrangement.
//   3. NEGATIVE CONTROL — an ordinary unmatched-remainder mismatch with NO redelivery wrapper on the
//      current write must still classify as unmatchable exactly as before (this card's own detector is a
//      no-op on every ordinary, non-redelivered turn) — proves this isn't a general softening of the
//      unmatched-remainder path.
//   4. NEGATIVE CONTROL — a wrapper IS present and the LENGTHS coincidentally sum correctly, but the
//      CONTENT differs from the recorded entry, must NOT confirm — proves this is exact-equality (byte-
//      for-byte, no collision possible), never a length-only/sum-only check.
//
// Mirrors pty-composer-accumulation-diverged-prior.mjs's own harness: the REAL PtyHost state machine + a
// FAKE pty (createPty seam) — NO real claude/daemon/network.
// RUN (no daemon needed): node test/pty-prompt-mismatch-wrapper-aware-fusion.mjs (build first: from
// packages/daemon `pnpm build`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wrapper-aware-fusion-${Date.now()}-${process.pid}`);
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
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "pty-prompt-mismatch-wrapper-aware-fusion: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
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

const ROOT_MSG_ID = "ca3bf8ef-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // an 8-hex-prefixed id, mirrors the real specimen's own root

const SIDS = [];

try {
  // ===== 1. POSITIVE CONTROL — the card's own exact fixture: an earlier generation writes 9709 chars;
  // this generation's own INTENDED write is a real `framePossibleDuplicate`-wrapped 1640-char body (1680
  // chars wrapped); the engine reports back the earlier generation's own 9709 chars immediately followed
  // by this generation's own 1640-char body with the wrapper stripped — 9709 + 1640 = 11349, exact. =====
  {
    const sid = newSession("WrapperAwareFusion"); SIDS.push(sid);
    const earlierGenText = "A".repeat(9709); // stands in for the specimen's gen=9 (9709 chars)
    const currentBody = "B".repeat(1640); // this generation's own real, unwrapped body (1640 chars)
    const intended = framePossibleDuplicate(currentBody, ROOT_MSG_ID);
    check("SETUP: reproduces the card's own committed regression fixture (9709/1640/40/1680/11349)",
      earlierGenText.length === 9709 && currentBody.length === 1640
      && intended.length - currentBody.length === 40 && intended.length === 1680
      && earlierGenText.length + currentBody.length === 11349);

    // Generation 1: an ordinary CLEAN turn — establishes the entry generation 2's fusion will recognize.
    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: Loom writes the wrapped `intended` text, but the engine reports back gen=1's own
    // recorded write immediately followed by this generation's own (unwrapped) body — the exact FUSED
    // shape neither `findRecognizedSubstring` alone nor `detectPossibleDuplicateWrapperDeficit` alone can
    // fully explain.
    const reported = earlierGenText + currentBody;
    host.enqueueStdin(sid, intended); // gen=2
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });

    const fusionLines = lines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-aware-fusion] "));
    check("1: POSITIVE CONTROL — [prompt-mismatch-wrapper-aware-fusion] fires on the exact specimen fixture", fusionLines.length === 1);
    check("1: it names the recognized generation (gen=1) and the exact matched length (9709)",
      /recognizedGen=1\b/.test(fusionLines[0] ?? "") && /matchedLen=9709\b/.test(fusionLines[0] ?? ""));
    check("1: leading remainder is 0 (the earlier write sits at the very start) and trailing remainder is exactly 1640",
      /leadingRemainderLen=0\b/.test(fusionLines[0] ?? "") && /trailingRemainderLen=1640\b/.test(fusionLines[0] ?? ""));

    // THE RED->GREEN PIVOT: before this card, this EXACT specimen fell to `isUnmatchableMismatch` (the
    // remainder was "recognized but unaccounted for", the weakest classification this file has). Now it
    // must be fully explained instead — `getLastMismatchUnmatched` must stay unset (`null`, not the
    // fixture's own gen).
    check("1: RED-PROOF — this specimen is NO LONGER classified as unmatchable (getLastMismatchUnmatched stays null, not gen=2)",
      host.getLastMismatchUnmatched(sid) === null);
    // The plain partial-recognition fallback must NOT ALSO fire for the same mismatch (the stronger,
    // confirmed candidate supersedes it — see `unmatchedRecognized`'s own `!wrapperAwareFusion` gate).
    check("1: [prompt-mismatch-unmatched-remainder] does NOT also fire for the same mismatch (superseded by the stronger, confirmed candidate)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")).length === 0);
    check("1: neither exact-replay nor a plain confirmed fusion also claims this mismatch",
      host.getLastMismatchReplay(sid) === null && host.getLastMismatchFusion(sid) === null);

    // Both generations' content is now established as arrived — `Live.mismatchResolvedGens` (the same
    // ring a confirmed composer-accumulation fusion marks) should carry both.
    const live = host.live.get(sid);
    check("1: both the recognized earlier generation (1) and this generation (2) are marked resolved",
      live.mismatchResolvedGens.has(1) && live.mismatchResolvedGens.has(2));

    // The session-facing notice itself.
    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("1: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("1: REQUIRED — the notice explicitly says this is NOT a loss", /NOT A LOSS/.test(noticeText));
    check("1: it names the recognized generation (1)", /generation 1/.test(noticeText));
    check("1: it does NOT use the generic \"possible LOSS\" framing", !/possible LOSS/.test(noticeText));
    check("1: it does NOT use the weaker \"partial recognition only\" framing this specimen used to get",
      !/partial recognition only/.test(noticeText));
  }

  // ===== 2. POSITIVE CONTROL — the SAME reconciling numbers, OPPOSITE concatenation order: this
  // generation's own (unwrapped) body FIRST, the earlier generation's own recorded write SECOND. Proves
  // the detector isn't anchored to one arrangement. =====
  {
    const sid = newSession("WrapperAwareFusionReversed"); SIDS.push(sid);
    const earlierGenText = "C".repeat(9709);
    const currentBody = "D".repeat(1640);
    const intended = framePossibleDuplicate(currentBody, ROOT_MSG_ID);

    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    const reported = currentBody + earlierGenText; // reversed order
    host.enqueueStdin(sid, intended); // gen=2
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    const fusionLines = lines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-aware-fusion] "));
    check("2: POSITIVE CONTROL — confirms in the OPPOSITE concatenation order too", fusionLines.length === 1);
    check("2: leading remainder is exactly 1640 (the current body sits first) and trailing remainder is 0",
      /leadingRemainderLen=1640\b/.test(fusionLines[0] ?? "") && /trailingRemainderLen=0\b/.test(fusionLines[0] ?? ""));
    check("2: getLastMismatchUnmatched stays null here too", host.getLastMismatchUnmatched(sid) === null);
  }

  // ===== 3. NEGATIVE CONTROL — an ordinary unmatched-remainder mismatch with NO redelivery wrapper on the
  // current write. Must classify exactly as before this card (isUnmatchableMismatch fires) — proving this
  // detector is a no-op on every ordinary, non-redelivered turn, not a general softening. =====
  {
    const sid = newSession("NoWrapperStillUnmatched"); SIDS.push(sid);
    const earlierGenText = "[loom:worker-report] worker AAAA — an earlier, real prior generation's own write";
    const genText = "[loom:from-manager] the real content this generation actually intended to submit";
    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // No wrapper anywhere — plain junk on both sides, mirrors worker-mismatch-generic-signal.mjs's own
    // scenario 1.
    host.enqueueStdin(sid, genText);
    const leadingJunk = "stray leading content Loom never wrote ";
    const trailingJunk = " and stray trailing content Loom never wrote either";
    const reported = leadingJunk + earlierGenText + trailingJunk;
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: reported });
    });
    check("3: NEGATIVE CONTROL — no wrapper present, [prompt-mismatch-wrapper-aware-fusion] does NOT fire",
      lines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-aware-fusion] ")).length === 0);
    check("3: this mismatch is STILL classified as unmatchable, exactly as before this card",
      host.getLastMismatchUnmatched(sid) !== null && host.getLastMismatchUnmatched(sid)?.gen === 2);
    check("3: the plain partial-recognition fallback still fires for this unwrapped shape",
      lines.filter((l) => l.startsWith("[prompt-mismatch-unmatched-remainder] ")).length === 1);
  }

  // ===== 4. NEGATIVE CONTROL — a wrapper IS present and the LENGTHS coincidentally sum to `reported`'s
  // length, but the CONTENT does not match the recorded entry byte-for-byte. Must NOT confirm — proves
  // this is exact-equality, never a length-only/sum-only check (the exact-hash discipline this card's own
  // DoD-1 requires preserved, per d005f55b's standing bound). =====
  {
    const sid = newSession("WrongContentSameLength"); SIDS.push(sid);
    const earlierGenText = "E".repeat(9709);
    const currentBody = "F".repeat(1640);
    const intended = framePossibleDuplicate(currentBody, ROOT_MSG_ID);

    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Same total length (9709 + 1640 = 11349) as scenario 1, but the FIRST 9709 chars are NOT the
    // recorded entry's own text (a different byte, "Z" instead of "E") — same length, wrong content.
    const wrongContentReported = "Z".repeat(9709) + currentBody;
    check("SETUP: same total length as the positive control, deliberately wrong content", wrongContentReported.length === 11349);
    host.enqueueStdin(sid, intended); // gen=2
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: wrongContentReported });
    });
    check("4: NEGATIVE CONTROL — same total length, wrong content, does NOT confirm (exact-equality, not sum-only)",
      lines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-aware-fusion] ")).length === 0);
    check("4: this mismatch falls through to unmatchable instead (nothing recognized at either edge)",
      host.getLastMismatchUnmatched(sid) !== null);
  }

  // ===== 5. NEGATIVE CONTROL — Code Review (manager, card c23e2869): a BARE tag with NO body strips to the
  // EMPTY STRING. Without the `strippedCurrent.length === 0` guard, the loop degenerates:
  // `entry.text.length + 0 !== reported.length` becomes a plain length-equality check, and
  // `reported === entry.text + ""` collapses to `reported === entry.text` — the ORDINARY `replayedEntry`
  // whole-string-match condition — so this generation's OWN write (a bare tag) would falsely present as a
  // confirmed, "NOT A LOSS" fusion of an unrelated earlier generation's content, disarming the follow-up
  // loss timer that specimen actually needs. Must NOT confirm — the specimen must classify exactly as an
  // ordinary unresolved replay: `replayedEntry` fires, the follow-up timer ARMS, and the notice uses the
  // ordinary "wait one generation and re-check" wording, never "NOT A LOSS". =====
  {
    const sid = newSession("BareTagNoBody"); SIDS.push(sid);
    const earlierGenText = "[loom:worker-report] worker QQQQ — the earlier generation a bare-tag write would falsely fuse with";
    const bareTagIntended = framePossibleDuplicate("", ROOT_MSG_ID); // strips to "" — no body at all
    check("SETUP: a bare tag with no body strips to the empty string, and is exactly 40 chars",
      bareTagIntended.length === 40);

    host.enqueueStdin(sid, earlierGenText);
    host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText }); // gen=1, clean
    host.deliverHook(sid, { hook_event_name: "Stop" });

    // Generation 2: Loom writes the bare tag, but the engine reports back gen=1's own recorded write
    // verbatim — an ordinary single-entry replay, NOT a fusion (nothing of THIS generation's own content
    // is in `reported` at all — there is nothing to fuse; the tag alone was never intended to reach anyone).
    host.enqueueStdin(sid, bareTagIntended); // gen=2
    const lines = captureLog(() => {
      host.deliverHook(sid, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    });
    check("5: NEGATIVE CONTROL — [prompt-mismatch-wrapper-aware-fusion] does NOT fire on a bare, bodiless tag",
      lines.filter((l) => l.startsWith("[prompt-mismatch-wrapper-aware-fusion] ")).length === 0);
    check("5: this is recognized as an ORDINARY single-entry replay instead (getLastMismatchReplay fires for gen=2, replayedGen=1)",
      host.getLastMismatchReplay(sid)?.gen === 2 && host.getLastMismatchReplay(sid)?.replayedGen === 1);
    check("5: RED-PROOF — the follow-up 'possible loss' timer ARMS (an unresolved replay must still be tracked, not silently swallowed)",
      host.live.get(sid)?.pendingMismatchUnresolvedTimers.size === 1);

    const fake = fakesById.get(sid);
    const writesBefore = fake.writes.length;
    const enqueued = await waitUntil(() => hasPendingMismatchNotice(sid));
    check("5: the notice enqueues (not suppressed)", enqueued);
    host.deliverHook(sid, { hook_event_name: "Stop" });
    const noticeText = fake.writes.slice(writesBefore).join("");
    check("5: the notice uses the ORDINARY replay wording — 'wait one generation and re-check' — never 'NOT A LOSS'",
      /wait one generation and re-check/.test(noticeText) && !/NOT A LOSS/.test(noticeText));
  }
} finally {
  for (const sid of SIDS) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card c23e2869's own gap is closed: `findRecognizedSubstring`'s partial-recognition remainder, when it is EXACTLY the current generation's own intended text with a `[loom:possible-duplicate root:…]` redelivery wrapper stripped, is now fully confirmed (both concatenation orders) instead of left as an unaccounted remainder — the card's own real specimen (9709/1640/40/1680/11349, arithmetically exact two independent ways) is no longer classified as unmatchable, is excluded from arming a follow-up 'possible loss' timer, marks both the recognized earlier generation and this generation resolved, and its session-facing notice says NOT A LOSS instead of 'partial recognition only'; an ordinary unwrapped unmatched-remainder mismatch is untouched (still classified exactly as before), and a same-length-but-wrong-content specimen does not confirm (exact-equality, not a length-only/sum-only check)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
