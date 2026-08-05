#!/usr/bin/env node
// Parse a FROZEN daemon-output.log snapshot for card c469d54e's causal claim: that under the
// 2026-08-01 11-session mass restart, every READY_FALLBACK_MS firing occurred with SessionStart having
// ALREADY arrived (contradicting the log's own "no SessionStart in Nms" wording, which just checks
// `!ready`), leaving cycleToMode's own sized budget (~13-14s worst case) eroded to a residual far below
// its own worst case by the time the fallback fired — and that a footer-read corruption signature
// ("footer-unchanged"/"footer-unreadable" with mode=unknown) follows within a short window after.
// NEVER point this at the live log — copy it first (mirrors 04de8bbf's parse-log-events.mjs convention).
//
// Usage: node analyze-fallback-race.mjs <path-to-frozen-daemon-output.log>
import fs from "fs";
import readline from "readline";

const FALLBACK_RE = /^\[pty\] (\S+) readiness fallback \(no SessionStart in (\d+)ms\) — marking ready (\d+)$/;
const SESSION_START_RE = /^\[hook\] (\S+) SessionStart session_id=\S+ (\d+)$/;
const CYCLE_DONE_RE = /^\[resume-mode\] (\S+) cycle→(\S+): (\S+) after (\d+) press\(es\) \(mode=(\S+)\) (\d+)$/;

function positiveControl() {
  const knownNonMatches = [
    "[pty] abc some other pty line 1785618442495",
    "[hook] abc UserPromptSubmit session_id=xyz 1785618442495", // wrong hook event — must NOT match SessionStart
    "[resume-mode] abc kind=fresh mode=auto matched=automodeon footer=\"...\" 1785618442495", // not a cycle-completion line
  ];
  let ok = true;
  for (const l of knownNonMatches) {
    if (FALLBACK_RE.test(l) || SESSION_START_RE.test(l) || CYCLE_DONE_RE.test(l)) {
      ok = false; console.error(`POSITIVE CONTROL FAILED: matched a line it should not have: "${l}"`);
    }
  }
  const knownFallback = "[pty] 708f86a9-bd2e-4713-a3aa-9dd2b2ccc957 readiness fallback (no SessionStart in 20000ms) — marking ready 1785618442498";
  const fm = FALLBACK_RE.exec(knownFallback);
  if (!fm || fm[1] !== "708f86a9-bd2e-4713-a3aa-9dd2b2ccc957" || Number(fm[3]) !== 1785618442498) {
    ok = false; console.error("POSITIVE CONTROL FAILED: known-good fallback line did not parse correctly");
  }
  const knownSessionStart = "[hook] 708f86a9-bd2e-4713-a3aa-9dd2b2ccc957 SessionStart session_id=63fd7adf-bef8-47fd-91f2-6adb4941617b 1785618430936";
  const sm = SESSION_START_RE.exec(knownSessionStart);
  if (!sm || Number(sm[2]) !== 1785618430936) {
    ok = false; console.error("POSITIVE CONTROL FAILED: known-good SessionStart line did not parse correctly");
  }
  const knownCycleDone = "[resume-mode] 708f86a9-bd2e-4713-a3aa-9dd2b2ccc957 cycle→auto: footer-unchanged after 2 press(es) (mode=unknown) 1785618466991";
  const cm = CYCLE_DONE_RE.exec(knownCycleDone);
  if (!cm || cm[3] !== "footer-unchanged" || cm[5] !== "unknown" || Number(cm[6]) !== 1785618466991) {
    ok = false; console.error("POSITIVE CONTROL FAILED: known-good cycle-completion line did not parse correctly");
  }
  if (ok) console.error("positive control: OK (3 known-non-matches correctly rejected, 3 known-good lines correctly parsed)");
  return ok;
}

async function parseLog(logPath) {
  const fallbacks = [], sessionStarts = [], cycleDones = [];
  const rl = readline.createInterface({ input: fs.createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    let m;
    if ((m = FALLBACK_RE.exec(line))) fallbacks.push({ sessionId: m[1], budgetMs: Number(m[2]), ts: Number(m[3]) });
    if ((m = SESSION_START_RE.exec(line))) sessionStarts.push({ sessionId: m[1], ts: Number(m[2]) });
    if ((m = CYCLE_DONE_RE.exec(line))) cycleDones.push({ sessionId: m[1], target: m[2], reason: m[3], presses: Number(m[4]), mode: m[5], ts: Number(m[6]) });
  }
  return { fallbacks, sessionStarts, cycleDones };
}

// How the corruption signature is defined for this analysis: the NEXT cycle-completion line for the SAME
// session AFTER the fallback fired (unbounded — see note below on why a short window undercounts), whose
// reason is a give-up variant (footer-unchanged/footer-unreadable — NOT "reached"/"press-cap", which are
// non-corrupted outcomes) AND whose mode is literally "unknown" (the footer was genuinely unparseable for
// the whole poll budget, not merely landed on the wrong-but-readable mode).
//
// UNBOUNDED BY DESIGN, not a fixed window: an EARLIER attempt at this script used a 5000ms window and
// found 0/9 "corrupted" — WRONG. The premature fallback's own logLandedMode read can trigger a HEAL
// cycleToMode, which is QUEUED (modeCycleChain) BEHIND the SessionStart-driven cycle already in flight —
// so the heal doesn't even START until that original cycle finishes its own (possibly contention-
// stretched) give-up sequence. The observed corruption signature for the 3 sessions manually traced while
// building this investigation (708f86a9, 70605175, 3542681e) landed 19.7s-24.5s AFTER their own fallback
// firing — see the table below. A fixed short window silently undercounts this population; report the
// actual latency instead of assuming one.
function analyze({ fallbacks, sessionStarts, cycleDones }) {
  const rows = [];
  for (const fb of fallbacks) {
    // Nearest PRECEDING SessionStart for this session (the most recent one at/before the fallback fired).
    const priorStarts = sessionStarts.filter((s) => s.sessionId === fb.sessionId && s.ts <= fb.ts);
    const sessionStart = priorStarts.length ? priorStarts.reduce((a, b) => (b.ts > a.ts ? b : a)) : null;
    const gapMs = sessionStart ? fb.ts - sessionStart.ts : null;
    // The NEXT cycle-completion line for this session strictly after the fallback fired (unbounded).
    const nextDones = cycleDones.filter((c) => c.sessionId === fb.sessionId && c.ts >= fb.ts).sort((a, b) => a.ts - b.ts);
    const nextDone = nextDones[0] ?? null;
    const corrupted = !!nextDone && (nextDone.reason === "footer-unchanged" || nextDone.reason === "footer-unreadable") && nextDone.mode === "unknown";
    rows.push({
      sessionId: fb.sessionId, fallbackTs: fb.ts, sessionStartTs: sessionStart?.ts ?? null, gapMs,
      nextDoneTs: nextDone?.ts ?? null, nextDoneReason: nextDone?.reason ?? null, nextDoneMode: nextDone?.mode ?? null,
      corruptionLatencyMs: nextDone ? nextDone.ts - fb.ts : null, corrupted,
    });
  }
  return rows;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  if (!positiveControl()) process.exit(1);
  const [logPath] = process.argv.slice(2);
  if (!logPath) { console.error("usage: node analyze-fallback-race.mjs <frozen-daemon-output.log>"); process.exit(1); }
  const parsed = await parseLog(logPath);
  const rows = analyze(parsed);
  console.log(`${rows.length} readiness-fallback firing(s) found`);
  console.log("sessionId,fallbackTs,sessionStartTs,gapMs,sessionStartAlreadyArrived,nextCycleDoneReason,nextCycleDoneMode,corruptionLatencyMs,corrupted");
  for (const r of rows) {
    console.log(`${r.sessionId},${r.fallbackTs},${r.sessionStartTs},${r.gapMs},${r.sessionStartTs !== null},${r.nextDoneReason},${r.nextDoneMode},${r.corruptionLatencyMs},${r.corrupted}`);
  }
  const arrived = rows.filter((r) => r.sessionStartTs !== null);
  const corrupted = rows.filter((r) => r.corrupted);
  console.log(`\nSessionStart already arrived before the fallback fired: ${arrived.length}/${rows.length}`);
  if (arrived.length) {
    const gaps = arrived.map((r) => r.gapMs);
    console.log(`  gap range: ${Math.min(...gaps)}ms - ${Math.max(...gaps)}ms`);
  }
  console.log(`Corrupted (NEXT cycle-completion for the session is footer-unchanged/footer-unreadable AND mode=unknown): ${corrupted.length}/${rows.length}`);
  console.log(`  corrupted session ids: ${corrupted.map((r) => r.sessionId).join(", ") || "(none)"}`);
  const notCorrupted = rows.filter((r) => !r.corrupted);
  console.log(`  NOT corrupted by this definition: ${notCorrupted.map((r) => `${r.sessionId.slice(0, 8)}(${r.nextDoneReason ?? "no-next-cycle-line-found"})`).join(", ") || "(none)"}`);
}
