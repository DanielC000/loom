import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 49d43ef9: `findConversationIdForSpawn`'s freshness filter compares a candidate rollout file's
// filesystem-reported `mtimeMs` against `sinceMs` (a `Date.now()` wall-clock reading captured BEFORE the
// spawn). Those two clocks are not guaranteed to agree — measured on the reporting host, n=3000, no
// induced load: a just-written file's `mtimeMs` read BELOW `sinceMs` in 4.37% of writes (min observed
// -1.97ms). A strict `mtimeMs < sinceMs` therefore PERMANENTLY rejects a valid, just-written rollout
// file a few percent of the time — permanently, because a file's mtime never changes between retries, so
// every attempt in the production retry ladder rejects the identical file the identical way.
//
// This test is hermetic and deterministic: rather than depending on catching a real ~4% flake (unrunnable
// as a gate test — see the card's own DoD-1), it controls each fixture file's mtime directly via
// fs.utimesSync to simulate the skew, and asserts BOTH polarities per the card's own DoD-2:
//   1. a file whose mtime lands a few ms BEHIND sinceMs (the measured skew shape) must still be matched
//      (RED on the pre-fix strict `<`, GREEN with the tolerance).
//   2. a file that is GENUINELY stale — an earlier, unrelated session, well outside any sane skew
//      tolerance — must still be rejected. A fix that accepts everything would let a codex session adopt
//      a PREVIOUS session's conversation id: a correctness failure with a much longer tail than the
//      missed capture this fixes.
//
// ⚠️ Isolation: sets CODEX_HOME to a temp dir BEFORE importing the dist module (mirrors
// codex-transcript-parse.mjs's own isolation note) — resolveTranscriptFile/findConversationIdForSpawn
// resolve their lookup root fresh on every call via codex-doctrine.ts's CODEX_HOME-aware realCodexHome(),
// never a module-load-time-cached os.homedir() call, so this test never touches the real ~/.codex.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-transcript-mtime-skew.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function writeRolloutFile(dayDir, name, sessionId, cwd, mtimeMs) {
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, name);
  const line = JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd, originator: "codex-tui" } });
  fs.writeFileSync(file, line + "\n");
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds); // controls the file's REPORTED mtime directly — no dependency on real timing
  return file;
}

const tmpHome = mkdtempManaged("loom-codex-mtime-skew-");
process.env.CODEX_HOME = tmpHome;

const { findConversationIdForSpawn, MTIME_SKEW_TOLERANCE_MS } = await import("../dist/pty/codex-transcript.js");

const CWD = "/fake/mtime-skew-test";
const dayDir = path.join(tmpHome, "sessions", "2026", "09", "08");

// --- Case 1: small clock/mtime skew (the actual measured defect) ---------------------------------
const sinceMs = Date.now();
const skewedMtimeMs = sinceMs - 50; // 50ms behind sinceMs — well past the measured max skew (-1.97ms),
                                     // still tiny relative to the "minutes or hours old" shape of a
                                     // genuinely earlier session, and well within the default tolerance.
writeRolloutFile(dayDir, "rollout-skewed.jsonl", "skewed-session-id", CWD, skewedMtimeMs);

const foundSkewed = findConversationIdForSpawn(CWD, sinceMs);
check(
  "a rollout file whose reported mtime lands 50ms BEHIND sinceMs (clock/mtime skew) is still matched " +
  "— RED on the pre-fix strict `mtimeMs < sinceMs` filter, GREEN with the skew tolerance",
  foundSkewed === "skewed-session-id"
);

// --- Case 2: a genuinely stale rollout file must still be rejected (both-polarities requirement) --
const staleHome = mkdtempManaged("loom-codex-mtime-skew-stale-");
process.env.CODEX_HOME = staleHome;
const staleDayDir = path.join(staleHome, "sessions", "2026", "09", "01");
const sinceMs2 = Date.now();
const staleMtimeMs = sinceMs2 - 10 * 60 * 1000; // 10 minutes earlier — an earlier, unrelated session
writeRolloutFile(staleDayDir, "rollout-stale.jsonl", "stale-session-id", CWD, staleMtimeMs);

const foundStale = findConversationIdForSpawn(CWD, sinceMs2);
check(
  "a genuinely stale rollout file (10 minutes older — an earlier unrelated session) is still rejected " +
  "— the skew tolerance must not swallow real staleness (positive control proving the tolerance has a bound)",
  foundStale === null
);

// --- Case 3: a fresh, unambiguous candidate is unaffected by the tolerance change ------------------
process.env.CODEX_HOME = tmpHome;
const freshMtimeMs = sinceMs + 50;
writeRolloutFile(dayDir, "rollout-fresh.jsonl", "fresh-session-id", CWD, freshMtimeMs);
// Two candidates now qualify in tmpHome (the skewed one from Case 1 and this fresh one) — the existing
// newest-mtime tiebreak must still pick the strictly-newer file, proving the tolerance change didn't
// disturb the tiebreak logic.
const foundFresh = findConversationIdForSpawn(CWD, sinceMs);
check(
  "when both a skew-tolerated candidate and a genuinely-fresher one qualify, the newer (fresh) one wins " +
  "— the existing mtime tiebreak is unaffected by the tolerance change",
  foundFresh === "fresh-session-id"
);

// --- Case 4: negative control — a mismatched cwd is never matched regardless of mtime --------------
const otherCwdHome = mkdtempManaged("loom-codex-mtime-skew-othercwd-");
process.env.CODEX_HOME = otherCwdHome;
const otherCwdDayDir = path.join(otherCwdHome, "sessions", "2026", "09", "08");
const sinceMs4 = Date.now();
writeRolloutFile(otherCwdDayDir, "rollout-othercwd.jsonl", "othercwd-session-id", "/fake/a-different-cwd", sinceMs4);
const foundOtherCwd = findConversationIdForSpawn(CWD, sinceMs4);
check(
  "a fresh rollout file for a DIFFERENT cwd is never matched (negative control proving the CWD match " +
  "still gates the tolerance, and that findConversationIdForSpawn on an empty-for-CWD tree returns null)",
  foundOtherCwd === null
);

// --- Case 5: the actual boundary — exactly at the tolerance edge, and one ms past it ---------------
// Manager review (post-first-cut, MTIME_SKEW_TOLERANCE_MS lowered 2000ms -> 100ms): the earlier both-
// polarities test (Case 2) only proved a bound EXISTS (10 minutes is nowhere near the edge); it could not
// have caught a hole at the 1-2 second scale a wider tolerance would have opened. This asserts the exact
// boundary the running code actually uses, off the exported constant (never a re-typed literal) so this
// test can't silently drift from the real default.
check("MTIME_SKEW_TOLERANCE_MS is the small, deliberately-chosen value (not the first draft's 2000ms) — see its own doc for why", MTIME_SKEW_TOLERANCE_MS === 100);

const boundaryHome = mkdtempManaged("loom-codex-mtime-skew-boundary-");
process.env.CODEX_HOME = boundaryHome;
const boundaryDayDir = path.join(boundaryHome, "sessions", "2026", "09", "08");

const sinceMs5 = Date.now();
const atBoundaryMtimeMs = sinceMs5 - MTIME_SKEW_TOLERANCE_MS; // exactly on the edge: NOT `<` the cutoff
writeRolloutFile(boundaryDayDir, "rollout-at-boundary.jsonl", "at-boundary-session-id", CWD, atBoundaryMtimeMs);
check(
  "a file whose mtime lands EXACTLY on the tolerance boundary (sinceMs - MTIME_SKEW_TOLERANCE_MS) is matched (not `<`, so the edge itself is inside the tolerated range)",
  findConversationIdForSpawn(CWD, sinceMs5) === "at-boundary-session-id"
);

const pastBoundaryHome = mkdtempManaged("loom-codex-mtime-skew-past-boundary-");
process.env.CODEX_HOME = pastBoundaryHome;
const pastBoundaryDayDir = path.join(pastBoundaryHome, "sessions", "2026", "09", "08");
const sinceMs6 = Date.now();
const pastBoundaryMtimeMs = sinceMs6 - MTIME_SKEW_TOLERANCE_MS - 1; // 1ms past the edge
writeRolloutFile(pastBoundaryDayDir, "rollout-past-boundary.jsonl", "past-boundary-session-id", CWD, pastBoundaryMtimeMs);
check(
  "a file whose mtime lands 1ms PAST the tolerance boundary is rejected (the tolerance has a real, exact edge, not a fuzzy one)",
  findConversationIdForSpawn(CWD, sinceMs6) === null
);

// --- Case 6: recycle-shaped scenario — the reachability concern the manager raised -----------------
// `sessions/service.ts`'s recycleWorker hard-stops a worker and spawns its successor into the SAME cwd
// with NO --resume, so the predecessor's own rollout file (matching cwd) can still be sitting in the
// scan tree when the successor's own scan runs. Model that directly: a "predecessor" file recently
// written (simulating its last activity right before being hard-stopped) that is now STALE relative to
// this "successor" spawn by slightly MORE than the tolerance — proving the shrunk tolerance rejects a
// same-cwd leftover that the original 2000ms draft would have wrongly adopted (2000ms > this gap).
const recycleHome = mkdtempManaged("loom-codex-mtime-skew-recycle-");
process.env.CODEX_HOME = recycleHome;
const recycleDayDir = path.join(recycleHome, "sessions", "2026", "09", "08");
const successorSinceMs = Date.now();
// The predecessor's last rollout write, ~500ms before the successor's own spawn — a plausible recycle
// gap (hard-stop + up-to-~5s pty-death wait + sibling sweep + session-row setup in sessions/service.ts's
// recycleWorker), comfortably inside the REJECTED first draft's 2000ms tolerance but well outside the
// current 100ms one.
const predecessorMtimeMs = successorSinceMs - 500;
writeRolloutFile(recycleDayDir, "rollout-predecessor.jsonl", "predecessor-session-id", CWD, predecessorMtimeMs);
check(
  "a same-cwd leftover file from an immediately-prior (predecessor) session, ~500ms stale relative to a " +
  "fresh spawn's sinceMs, is REJECTED under the current 100ms tolerance — this same fixture would have " +
  "been WRONGLY adopted under the first draft's 2000ms tolerance (500ms < 2000ms), which is exactly the " +
  "identity-adoption risk the manager's review caught",
  findConversationIdForSpawn(CWD, successorSinceMs) === null
);
// And once the successor's OWN rollout file lands (as it normally would by the time the ready-marker-
// gated first scan actually fires — see MTIME_SKEW_TOLERANCE_MS's own doc), the newest-mtime tiebreak
// (proven generically in Case 3) picks it over the predecessor's leftover regardless of tolerance size —
// the SECOND layer of protection against this exact scenario, verified here in the recycle-shaped case
// specifically rather than only the generic Case 3 fixture.
const successorMtimeMs = successorSinceMs + 10;
writeRolloutFile(recycleDayDir, "rollout-successor.jsonl", "successor-session-id", CWD, successorMtimeMs);
check(
  "once the successor's own (strictly fresher) rollout file exists alongside the predecessor's leftover, " +
  "it is the one matched — the tiebreak protects this scenario even if the tolerance window is widened later",
  findConversationIdForSpawn(CWD, successorSinceMs) === "successor-session-id"
);

await finishAndExit(failures === 0 ? 0 : 1);
