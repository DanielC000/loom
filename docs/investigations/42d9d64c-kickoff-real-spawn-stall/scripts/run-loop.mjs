// Card 42d9d64c — local isolated loop for kickoff-real-spawn.mjs, capturing the FULL corpus so it can be
// re-interrogated later (v12's corpus was lost; this must not happen again).
//
// Runs `node packages/daemon/test/kickoff-real-spawn.mjs` N times, unedited, sequentially (one test
// process at a time — "isolated" here means one process, not a quiet host; other Loom worktrees/gates on
// this host are NOT suppressed). For each run it captures:
//   - the full combined stdout+stderr to its own file (docs/investigations/.../runs/run-NN-<pass|fail>.txt)
//   - a structured row appended to runs.ndjson (see ROW SHAPE below)
//
// ROW SHAPE (manager-directed upgrade, mgr correction on 42d9d64c): the flat `waitUntilOutcomeAbsentFor`
// alone can't answer "are the absent sessions exactly the ones stranded downstream of the failure point,
// or independent of it" — that needs the SAME ordering the file itself uses for allSessionIds, so this
// driver reproduces that ordering explicitly (ALL_SESSION_IDS_ORDER below, mirrors
// packages/daemon/test/kickoff-real-spawn.mjs:307,347 exactly — ROLES then large-10000/40000 then
// late-ready) and computes, per run:
//   - failedSessionId / failedIndex: which session's verifyRealDelivery threw (uncaught), and its
//     position in that order. null on a pass or a non-throwing check()-only failure (which does NOT
//     short-circuit the per-role loop, so it does not strand anything downstream).
//   - strandedExpected: allSessionIds strictly AFTER the failed one — these can NEVER be spawned once an
//     uncaught throw exits the per-role loop early, so they are mechanically predicted to hit the
//     onExit-after-hard-stop waitUntil's full budget in the file's own `finally` safety-net sweep.
//   - absentSessions: the sessions the log ACTUALLY reports "never reported onExit within budget" for,
//     ordered per ALL_SESSION_IDS_ORDER (not raw print order, though they should coincide since the sweep
//     itself iterates in that exact order).
//   - strandedSetMatchesAbsent: strict equality of strandedExpected vs (absentSessions minus the failed
//     session itself, which is a genuinely different case — it WAS spawned, so whether IT also times out
//     is a separate question, tracked as failedSessionAlsoAbsent).
//
// Read-only with respect to production code — this is an investigation driver, not a test, and is NOT
// under packages/daemon/test/ (so it does not need the STATIC_GUARD_REPO_PATHS guards run against it).
//
// GAP SPLIT (manager-directed fix, mgr correction on 42d9d64c): a flat maxInterEventGapMs is CONTAMINATED
// on a failing run — the file's own `finally` safety-net sweep burns ~25000ms per stranded session (see
// the ABSENT mechanism above), which lands as a huge "gap" that has nothing to do with the pty/delivery
// stall the metric is meant to characterise. Only the gap UP TO AND INCLUDING the failing check is
// comparable across pass/fail. So every run now emits BOTH:
//   - maxInterEventGapWholeRunMs — the old, single number, cleanup-inclusive (kept for continuity).
//   - maxInterEventGapPreFailureMs — computed only over chunks up to the failure marker (the chunk
//     containing "💥 UNCAUGHT", or the first "FAIL  " line for a non-throwing check() failure). For a
//     PASSING run there is no failure marker, so this trivially equals the whole-run value.
//
// Usage: node scripts/run-loop.mjs <N> [startAt]
//   N       total number of runs to perform in this invocation
//   startAt the run index to start numbering from (default 1) — use this to APPEND to an existing corpus
//           without renumbering/overwriting earlier rows (e.g. `node run-loop.mjs 13 8` appends runs 8-20).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVESTIGATION_DIR = path.join(HERE, "..");
const REPO_ROOT = path.join(INVESTIGATION_DIR, "..", "..", "..");
const RUNS_DIR = path.join(INVESTIGATION_DIR, "runs");
const NDJSON_PATH = path.join(INVESTIGATION_DIR, "runs.ndjson");
const TARGET_SCRIPT = path.join(REPO_ROOT, "packages", "daemon", "test", "kickoff-real-spawn.mjs");

const N = Number(process.argv[2] || 15);
const START_AT = Number(process.argv[3] || 1);

// Mirrors kickoff-real-spawn.mjs:307 (ROLES, unless KICKOFF_TEST_ROLES overrides it — this driver never
// sets that env var, so the default always applies) and :347 (allSessionIds construction) EXACTLY.
const ROLES = ["worker", "manager", "platform", "setup", "assistant", "auditor"];
const ALL_SESSION_IDS_ORDER = [
  ...ROLES.map((role) => `real-${role}`),
  ...[10_000, 40_000].map((n) => `real-large-${n}`),
  "real-late-ready",
];

fs.mkdirSync(RUNS_DIR, { recursive: true });

// Maps a verifyRealDelivery `label` (e.g. "[worker]", "[large 40000]", "[late-ready]") to the sessionId
// that call used — mirrors the three call shapes in kickoff-real-spawn.mjs (the per-role sweep, the
// large-payload section, and the late-ready section).
function labelToSessionId(label) {
  const inner = label.replace(/^\[/, "").replace(/\]$/, "");
  const largeMatch = inner.match(/^large (\d+)$/);
  if (largeMatch) return `real-large-${largeMatch[1]}`;
  if (inner === "late-ready") return "real-late-ready";
  return `real-${inner}`;
}

// Finds which verifyRealDelivery call's wait actually threw (if any), across the three distinct throw
// shapes in the file (see its header/body): the bespoke stall-aware wait's two Error messages, and the
// FIXTURE_READY wait's ordinary _wait.mjs waitUntil timeout. Only meaningful when the run's own combined
// output contains "💥 UNCAUGHT" — these message shapes are only ever printed via that catch's own
// stack-trace dump.
function extractFailureSite(combined) {
  let m = combined.match(/(\[[^\]]+\]) real fixture reports FIXTURE_RECEIVED — STALLED/);
  if (m) return { label: m[1], kind: "stall" };
  m = combined.match(/(\[[^\]]+\]) real fixture reports FIXTURE_RECEIVED — exceeded absolute backstop/);
  if (m) return { label: m[1], kind: "backstop" };
  m = combined.match(/for (\[[^\]]+\]) real fixture process signals FIXTURE_READY/);
  if (m) return { label: m[1], kind: "fixture-ready-timeout" };
  return null;
}

function extractFacts(combined) {
  const facts = {};

  facts.allPassBanner = /✅ ALL PASS/.test(combined);
  facts.uncaught = /💥 UNCAUGHT/.test(combined);

  // Any FAIL-lines from check() itself (a non-throwing failure path, e.g. a byte-mismatch or a missing
  // output file) — these do NOT exit the per-role loop early, so they never strand anything downstream.
  const failLines = [...combined.matchAll(/^FAIL {2}(.+)$/gm)].map((m) => m[1]);
  facts.checkFailLines = failLines;

  const site = extractFailureSite(combined);
  facts.failureKind = facts.uncaught ? (site ? site.kind : "unknown-uncaught") : (failLines.length ? "check-fail-only" : "pass");
  facts.failedLabel = site ? site.label : null;
  facts.failedSessionId = site ? labelToSessionId(site.label) : null;
  facts.failedIndex = facts.failedSessionId ? ALL_SESSION_IDS_ORDER.indexOf(facts.failedSessionId) : -1;

  // GIVE-UP RECOVERY — the daemon's own submit-retry give-up (host.ts fireEnterAndVerify), distinct from
  // this file's own STALLED detection above.
  const giveUpMatches = [...combined.matchAll(/GIVE-UP RECOVERY after (\d+) Enter attempts/g)];
  facts.giveUpRecoveryCount = giveUpMatches.length;
  facts.giveUpFalseNegativeTextPresent = facts.giveUpRecoveryCount > 0 ? /was a false negative/.test(combined) : null;

  // waitUntil-outcome ABSENT for the "onExit after hard stop" wait, and which session id(s) it fired for
  // (the console.warn line in stopAndAwaitExit's catch names the sessionId) — canonicalized to
  // ALL_SESSION_IDS_ORDER rather than trusting raw print order, and de-duplicated.
  const rawAbsent = [...combined.matchAll(/\[kickoff-real-spawn\] (\S+) never reported onExit within budget/g)]
    .map((m) => m[1]);
  const rawAbsentSet = new Set(rawAbsent);
  facts.absentSessions = ALL_SESSION_IDS_ORDER.filter((id) => rawAbsentSet.has(id));
  facts.absentSessionsUnrecognized = rawAbsent.filter((id) => !ALL_SESSION_IDS_ORDER.includes(id)); // should always be empty; flags a mapping bug if not

  // Every [waitUntil-outcome] line verbatim, for the record (ABSENT and ARRIVED LATE both, any wait in
  // the file — not just the onExit one above).
  facts.waitUntilOutcomeLines = [...combined.matchAll(/^\[waitUntil-outcome\].*$/gm)].map((m) => m[0]);

  return facts;
}

function computeMaxInterEventGap(chunks, uptoTMs) {
  let maxGap = 0;
  let prevTMs = null;
  for (const c of chunks) {
    if (uptoTMs != null && c.tMs > uptoTMs) break;
    if (prevTMs != null) {
      const gap = c.tMs - prevTMs;
      if (gap > maxGap) maxGap = gap;
    }
    prevTMs = c.tMs;
  }
  return maxGap;
}

// Locates the elapsed-ms (tMs) of the chunk that first carries the failure marker, so the gap computation
// above can be bounded to "up to and including the failing check" — see the GAP SPLIT doc at file top.
// Returns null for a passing run (no marker to find).
function findFailureMarkerTMs(chunks, facts) {
  if (facts.uncaught) {
    for (const c of chunks) { if (c.text.includes("💥 UNCAUGHT")) return c.tMs; }
  }
  if (facts.checkFailLines.length) {
    for (const c of chunks) { if (/^FAIL {2}/m.test(c.text)) return c.tMs; }
  }
  return null;
}

function runOnce(runIndex) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const t0 = performance.now();
    const child = spawn(process.execPath, [TARGET_SCRIPT], {
      cwd: path.join(REPO_ROOT, "packages", "daemon"),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks = [];
    child.stdout.on("data", (buf) => chunks.push({ stream: "stdout", text: buf.toString("utf8"), tMs: performance.now() - t0 }));
    child.stderr.on("data", (buf) => chunks.push({ stream: "stderr", text: buf.toString("utf8"), tMs: performance.now() - t0 }));

    // Absolute backstop so one wedged run can't hang the whole loop forever. Sized generously: an early
    // per-role failure (e.g. at the FIRST role, "worker") leaves up to 8 other sessions never spawned, and
    // the file's own `finally` safety-net loop calls stopAndAwaitExit on each in turn — each of which, for
    // a never-spawned session, can NEVER observe onExit and so burns its full waitUntil budget (5000ms +
    // grace min(5000*4,120000)=20000ms = 25000ms) before giving up. Worst case ~8*25000=200000ms just in
    // that loop, on top of however long it took to reach the failure — this backstop clears that worst
    // case (this driver has no test-daemon.mjs-style external 120s TEST_TIMEOUT_MS truncating it).
    const HARD_KILL_MS = 420_000;
    const killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* best-effort */ } }, HARD_KILL_MS);

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      const durationMs = Math.round(performance.now() - t0);
      const combined = chunks.map((c) => c.text).join("");
      const facts = extractFacts(combined);
      const failureMarkerTMs = findFailureMarkerTMs(chunks, facts);
      const maxInterEventGapWholeRunMs = Math.round(computeMaxInterEventGap(chunks, null));
      const maxInterEventGapPreFailureMs = failureMarkerTMs != null
        ? Math.round(computeMaxInterEventGap(chunks, failureMarkerTMs))
        : maxInterEventGapWholeRunMs; // pass (or a kill with no marker found): the two coincide by construction
      const killed = signal === "SIGKILL";

      let outcome;
      if (killed) outcome = "fail";
      else if (code === 0 && facts.allPassBanner && !facts.uncaught && facts.checkFailLines.length === 0) outcome = "pass";
      else outcome = "fail";

      const strandedExpected = facts.failedIndex >= 0 ? ALL_SESSION_IDS_ORDER.slice(facts.failedIndex + 1) : [];
      const failedSessionAlsoAbsent = facts.failedSessionId ? facts.absentSessions.includes(facts.failedSessionId) : false;
      const absentMinusFailed = facts.absentSessions.filter((id) => id !== facts.failedSessionId);
      const strandedSetMatchesAbsent = outcome === "pass"
        ? facts.absentSessions.length === 0
        : JSON.stringify(absentMinusFailed) === JSON.stringify(strandedExpected);
      const anyAbsentNotStrandedOrFailed = facts.absentSessions.some(
        (id) => id !== facts.failedSessionId && !strandedExpected.includes(id)
      );

      const row = {
        run: runIndex,
        outcome,
        durationMs,
        exitCode: code,
        killedByLoopBackstop: killed,
        startedAtIso: new Date(startedAt).toISOString(),
        failureKind: facts.failureKind,
        failedLabel: facts.failedLabel,
        failedSessionId: facts.failedSessionId,
        failedSessionIndex: facts.failedIndex >= 0 ? facts.failedIndex : null,
        checkFailLines: facts.checkFailLines,
        strandedExpected,
        absentSessions: facts.absentSessions,
        absentCount: facts.absentSessions.length,
        failedSessionAlsoAbsent,
        strandedSetMatchesAbsent,
        anyAbsentNotStrandedOrFailed, // the falsifier: true would mean an ABSENT session is NOT explained by the stranding mechanism at all
        absentSessionsUnrecognized: facts.absentSessionsUnrecognized,
        giveUpRecoveryCount: facts.giveUpRecoveryCount,
        giveUpFalseNegativeTextPresent: facts.giveUpFalseNegativeTextPresent,
        maxInterEventGapPreFailureMs,
        maxInterEventGapWholeRunMs,
        gapInstrumentVersion: 2, // rows 1-7 of this card's corpus were emitted under version 1 (single flat maxInterEventGapMs) — see README for the reconciliation
      };

      // .txt, not .log — the repo's root .gitignore has a blanket `*.log` rule that would silently
      // exclude this DoD-mandated committed corpus; every prior docs/investigations/** specimen uses
      // .txt for exactly this reason.
      const logName = `run-${String(runIndex).padStart(2, "0")}-${outcome}.txt`;
      const logPath = path.join(RUNS_DIR, logName);
      fs.writeFileSync(logPath, combined, "utf8");

      fs.appendFileSync(NDJSON_PATH, JSON.stringify(row) + "\n", "utf8");

      console.log(`[run-loop] run ${runIndex}: ${outcome.toUpperCase()} in ${durationMs}ms (exit=${code} signal=${signal ?? "none"}) -> ${logName}`);
      if (facts.failedLabel) console.log(`[run-loop]   failedLabel=${facts.failedLabel} (${facts.failedSessionId}, index ${facts.failedIndex}) kind=${facts.failureKind}`);
      if (facts.giveUpRecoveryCount) console.log(`[run-loop]   giveUpRecoveryCount=${facts.giveUpRecoveryCount} falseNegativeTextPresent=${facts.giveUpFalseNegativeTextPresent}`);
      if (facts.absentSessions.length) console.log(`[run-loop]   absentSessions=${JSON.stringify(facts.absentSessions)} strandedSetMatchesAbsent=${strandedSetMatchesAbsent} anyAbsentNotStrandedOrFailed=${anyAbsentNotStrandedOrFailed}`);
      console.log(`[run-loop]   maxInterEventGapPreFailureMs=${maxInterEventGapPreFailureMs} maxInterEventGapWholeRunMs=${maxInterEventGapWholeRunMs}`);

      resolve(row);
    });
  });
}

(async () => {
  console.log(`[run-loop] starting ${N} sequential runs of ${TARGET_SCRIPT}, numbered ${START_AT}..${START_AT + N - 1}`);
  console.log(`[run-loop] ALL_SESSION_IDS_ORDER=${JSON.stringify(ALL_SESSION_IDS_ORDER)}`);
  console.log(`[run-loop] writing per-run logs to ${RUNS_DIR}`);
  console.log(`[run-loop] appending rows to ${NDJSON_PATH}`);
  const results = [];
  for (let i = START_AT; i < START_AT + N; i++) {
    const row = await runOnce(i);
    results.push(row);
  }
  const passCount = results.filter((r) => r.outcome === "pass").length;
  const failCount = results.filter((r) => r.outcome === "fail").length;
  console.log(`\n[run-loop] DONE — ${passCount} pass / ${failCount} fail out of ${N}`);
})();
