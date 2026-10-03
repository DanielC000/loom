// Claude-free regression guard for card 096231e8 — a same-id respawn (resume/fork/recycle) landing while
// a mode-cycle / post-ready read for the OLD generation is still in flight must leave the NEW generation
// completely untouched. `sessionId` stays stable across a respawn; `spawn()` overwrites the map entry for
// that key with a brand-new `Live`, but an in-flight async chain tied to the old key keeps running
// regardless unless it is bound, by IDENTITY, to the specific `Live` object it started on. Exercises the
// REAL PtyHost state machine (spawn/deliverHook/setPermissionMode) against a FAKE pty, at the createPty()
// seam (mirrors pty-mode-race.mjs). No real claude, no daemon, no network.
//
// ROUND 1 (this card's original fix) covered the BOOT cycle's own `onDone` and runCycleToMode's
// decide/awaitChange/awaitReadable closures, respawning BEFORE the orphaned cycle's first footer read —
// Scenario 1 below.
//
// ROUND 2 (Code Review b607eccf) found three further generation-binding gaps and a test gap:
//   Scenario 2 (finding 1, BLOCKING) — `runCycleToMode`'s `startLive` must be bound at QUEUE time
//     (by `cycleToMode`, which already holds the right `live`), not re-derived when the queued chain link
//     actually RUNS — a link queued behind an in-flight cycle can run AFTER a respawn.
//   Scenario 3 (finding 2) — `cycleToModeWithRetries` must not blindly retry a mode request against a
//     respawned generation; a request bound to one generation never carries over to a respawn (lead
//     ruling), the respawned session boots to its own resolved target instead. `cycleToModeWithRetries`
//     carries TWO identity checks — a TOP `boundLive` check (guards a RETRY call) and an `onDone` check
//     (guards the current attempt) — but THIS SCENARIO DISCRIMINATES THEM ONLY JOINTLY, not
//     independently: its own `tick()` yield lands the respawn only after the single first attempt is
//     already queued, so the `onDone` check is what actually fires and resolves `"unknown"` with no
//     retry; the TOP check only matters on a SECOND call, which this scenario's passing result proves
//     never happens — meaning the TOP check is DEFENSIVE and CANNOT FIRE AS WRITTEN here. A regression
//     that broke the TOP check alone, while the `onDone` check still worked, would NOT be caught by this
//     scenario.
//   Scenario 4 (finding 3) — `logLandedMode`/its `onSettled` → `scheduleKickoffGuarantee` must bind to the
//     Live `markReady` actually ran on, so a respawn during the post-ready footer read can never deliver
//     the OLD generation's captured kickoff text into the NEW one. `logLandedMode` likewise carries TWO
//     identity checks — an ENTRY check (at the top of the function) and `tryRead`'s own check (inside its
//     scheduled poll) — but `markReady` always calls `logLandedMode` SYNCHRONOUSLY, before this scenario's
//     respawn can land, so the ENTRY check never sees a mismatch here; it is `tryRead`'s own check (fired
//     after `LOOM_MODE_LOG_POLL_MS`) that actually discriminates. The ENTRY check is DEFENSIVE and CANNOT
//     FIRE AS WRITTEN by this scenario — a regression that broke only the entry check would not be caught
//     here.
//   Scenario 5 (finding 4, test-gap closure) — a respawn landing AFTER the orphaned cycle's first press
//     (exercising `decide`/`awaitChange`'s own identity guards), not only `awaitReadable`'s. The RED proof
//     for this scenario reverted `decide`'s AND `awaitChange`'s identity checks TOGETHER (one combined
//     sabotage, one rebuild) — so THIS SCENARIO DISCRIMINATES THE PAIR ONLY JOINTLY, not independently; it
//     does not prove that either check alone is necessary, only that the pair together is.
//
// RUN: pnpm build (repo root) then `node test/pty-mode-cycle-respawn-identity.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 0)); // one macrotask yield — lets a queued microtask chain finish its SYNCHRONOUS setup before we act again
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs, label: "pty-mode-cycle-respawn-identity" });
  } catch (err) {
    // _wait.mjs's own doc comment is canonical: discriminate via exhaustedOnThrow, never the message text (card 69547e0e).
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
};

// Hermetic LOOM_HOME + fast footer polling (defaults: 200ms/15 polls ≈ 3s change-wait). MODE_CYCLE_SETTLE_MS
// (700ms, fixed) is NOT env-overridable — every respawn below lands well inside that window. MODE_LOG_POLL_MS
// (500ms default) IS overridden short below for scenario 4's timing.
const tmpHome = path.join(os.tmpdir(), `loom-pmcri-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "5"; // change-wait cap ≈ 200ms — an orphaned cycle gives up fast if it ever gets this far
process.env.LOOM_RESUME_MODE_MAX_PRESSES = "4";
process.env.LOOM_READY_FALLBACK_MS = "9000"; // comfortably longer than this whole test — never the binding constraint
process.env.LOOM_MODE_LOG_POLL_MS = "80"; // logLandedMode's own first-read delay — fast for scenario 4
process.env.LOOM_MODE_OVERRIDE_MAX_ATTEMPTS = "3"; // setPermissionMode's outer retry bound — pinned, not left to the real default

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle)";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle)";

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = {
      ...base, write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      writes,
      feed: (s) => { if (dataCb) dataCb(s); },
    };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;
const writesText = (fake) => fake.writes.filter((w) => typeof w === "string").join("");

// Capture EVERY console.log line — used both for the "[resume-mode] <sid> cycle→<target>: <reason> after N
// press(es)" completion family (a POSITIVE, observable proxy for "this async chain has genuinely reached
// its own terminal point", used instead of a fixed sleep to gate the negative/zero-press assertions below —
// mirrors pty-mode-convergence.mjs's identical technique) AND the new generation-mismatch skip lines this
// card's round-2 fix adds to logLandedMode/scheduleKickoffGuarantee.
const allLogLines = [];
const realLog = console.log;
console.log = (...args) => {
  allLogLines.push(args.join(" "));
  realLog(...args);
};
const waitForCycleDone = (sid, target, timeoutMs) =>
  waitUntil(() => allLogLines.some((l) => l.includes(`[resume-mode] ${sid} cycle→${target}:`)), timeoutMs);
const countCycleDoneLines = (sid, target) =>
  allLogLines.filter((l) => l.includes(`[resume-mode] ${sid} cycle→${target}:`)).length;

const spawnedSessionIds = [];
const spawnGen1 = (sid, { startupModeCycles = 2, role = "worker", startupPrompt } = {}) => {
  spawnedSessionIds.push(sid);
  host.spawn({
    sessionId: sid, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
    ...(startupPrompt !== undefined ? { startupPrompt } : {}),
  });
  return fakes[fakes.length - 1];
};
// Mirrors SessionService.resume's real contract: startupModeCycles pinned to 0, an explicit resumeModeTarget
// (never null) carried through. Every respawn in this file is this shape — none has its own startupPrompt
// (an ordinary resume's continuation rides a different path — see markReady's own doc), so any kickoff text
// landing in a respawned generation's pty is unambiguously a LEAK from the generation it replaced.
const spawnRespawn = (sid, engId, { resumeModeTarget = "acceptEdits", role = "worker" } = {}) => {
  host.spawn({
    sessionId: sid, cwd: tmpHome, resumeId: engId,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget,
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  return fakes[fakes.length - 1];
};

try {
  // ======================================================================================================
  // SCENARIO 1 (round 1 — the original fix): a same-id respawn landing mid-cycle, INSIDE
  // MODE_CYCLE_SETTLE_MS, before the orphaned boot cycle's first footer read — exercises awaitReadable's
  // own identity guard.
  // ======================================================================================================
  const S1 = "sess-respawn-race-1";
  const s1gen1 = spawnGen1(S1);
  const s1gen1Live = host.live.get(S1);
  s1gen1.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(S1, { hook_event_name: "SessionStart", session_id: "eng-1-gen1" });
  check("1: (setup) gen1's boot cycle armed startupCycleInFlight", host.live.get(S1).startupCycleInFlight === true);

  // TIMING-GUARD-SAFE: sync-early-return — this sleep only sizes the RACE WINDOW (how soon the respawn
  // lands relative to gen1's 700ms settle); it does not gate the two check()s immediately below. Both are
  // decided SYNCHRONOUSLY by the `spawnRespawn` call on the very next line — a fresh object identity and
  // `ready`'s freshly-initialized value are fixed the instant that call returns, with no await in between,
  // so they cannot be racing this (or any) sleep's duration. The actual time-sensitive assertions (what the
  // orphaned cycle did or didn't do) are below, gated on the OBSERVABLE waitForCycleDone, not a fixed wait.
  await sleep(50); // well inside the 700ms settle window
  const s1gen2 = spawnRespawn(S1, "eng-1-gen2");
  const s1gen2Live = host.live.get(S1);
  check("1: (setup) the respawn minted a genuinely NEW Live and a NEW fake pty", s1gen2Live !== s1gen1Live && s1gen2 !== s1gen1);
  check("1: (setup) gen2 has NOT run its own cycle yet (never ready)", s1gen2Live.ready === false);

  // Feed GEN2's pty a DEFINITE, readable footer (deliberately NOT gen2's own SessionStart) — so that when
  // gen1's orphaned chain re-derives "the session" via `this.live.get(S1)`, it finds a DEFINITE, actionable
  // mode (not "unknown"), giving the pre-fix bug its best chance to press Shift+Tab into it.
  s1gen2.feed(ACCEPT_EDITS_FOOTER);

  check("1: gen1's orphaned cycle reached its own finish() (never wedges a dangling timer chain)",
    await waitForCycleDone(S1, "auto", 3000));
  check("1: gen1's orphaned cycle pressed NOTHING into gen2's pty — no-op once respawned, never drives " +
    "the new generation's footer",
    countShiftTabs(s1gen2) === 0);
  check("1: gen2 was NOT marked ready by gen1's stale onDone",
    host.live.get(S1) === s1gen2Live && s1gen2Live.ready === false);
  check("1: the orphaned cycle's own completion log names the respawn, not a false convergence/give-up reason",
    allLogLines.some((l) => l.includes(`[resume-mode] ${S1} cycle→auto: respawned`)));

  // ======================================================================================================
  // SCENARIO 2 (finding 1, BLOCKING) — reviewer's own repro: a MANUAL mode override issued right after
  // SessionStart gets QUEUED behind the boot cycle's own in-flight link on the SAME Live's modeCycleChain.
  // A respawn lands before the queued override's own chain link actually RUNS (which only happens once the
  // boot cycle's own link settles). `runCycleToMode`'s `startLive` must be bound at QUEUE time (by
  // `cycleToMode`), not re-derived when the queued link runs — otherwise the override silently rebinds to
  // the NEW generation and presses into it, unserialized against gen2's own real boot cycle.
  // ======================================================================================================
  const S2 = "sess-respawn-race-2";
  const s2gen1 = spawnGen1(S2);
  s2gen1.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(S2, { hook_event_name: "SessionStart", session_id: "eng-2-gen1" });
  // Issue the manual override IMMEDIATELY — before the boot cycle has even taken its first read. cycleToMode
  // captures `live` (gen1) HERE, synchronously, and queues onto gen1's OWN modeCycleChain, behind the boot
  // cycle's own already-queued link.
  const s2overridePromise = host.setPermissionMode(S2, "plan");

  await sleep(50); // well inside the boot cycle's own 700ms settle window — the override link has not run yet
  const s2gen2 = spawnRespawn(S2, "eng-2-gen2");
  s2gen2.feed(ACCEPT_EDITS_FOOTER); // a DEFINITE, actionable footer — best chance for a bug to press into it

  // Awaiting the override's own promise is itself the correct observable anchor: `setPermissionMode` cannot
  // resolve while a retry (or the queued cycle itself) is still in flight, so there is nothing left running
  // once this resolves.
  const s2landed = await s2overridePromise;
  check("2: the queued override resolved 'unknown' — bound to a respawned generation, never silently " +
    "re-targeting gen2's own footer", s2landed === "unknown");
  check("2: NEITHER the boot cycle NOR the queued override pressed anything into gen2's pty — a cycle " +
    "queued behind an in-flight one stays bound to the generation it was QUEUED for, not whatever is " +
    "current when it finally RUNS",
    countShiftTabs(s2gen2) === 0);
  check("2: gen2 was not marked ready by either stale chain link",
    host.live.get(S2)?.ready === false);

  // ======================================================================================================
  // SCENARIO 3 (finding 2) — cycleToModeWithRetries must not retry a mode request onto a respawned
  // generation. Isolated from finding 1: a `tick()` yield lets the single cycleToMode call's own queued
  // chain link finish its synchronous setup (binding to gen1, correctly, regardless of finding 1's fix
  // state, since nothing is queued ahead of it and no respawn has happened yet) BEFORE the respawn lands —
  // so the first underlying attempt always correctly no-ops via the (already round-1-fixed) awaitReadable
  // guard. The only thing left to prove is whether cycleToModeWithRetries itself avoids RETRYING once that
  // correct "respawned" signal comes back, per the lead's ruling: a mode request for gen1 does not carry
  // over to a respawned gen2.
  // ======================================================================================================
  const S3 = "sess-respawn-race-3";
  spawnGen1(S3); // no SessionStart fired — isolates cycleToModeWithRetries from any boot-cycle queueing
  const s3overridePromise = host.setPermissionMode(S3, "plan");
  await tick(); // let the single queued chain link's synchronous setup (capture gen1) complete first
  const s3gen2 = spawnRespawn(S3, "eng-3-gen2");
  s3gen2.feed(ACCEPT_EDITS_FOOTER); // a DEFINITE mode different from "plan" — the exact bait for a blind retry

  const s3landed = await s3overridePromise;
  check("3: the override resolved 'unknown' — a request bound to gen1 does not carry over to a respawn",
    s3landed === "unknown");
  check("3: NO retry ever pressed into gen2's pty", countShiftTabs(s3gen2) === 0);
  check("3: exactly ONE underlying cycleToMode attempt ran — cycleToModeWithRetries did not blindly retry " +
    "a 'respawned' miss the way it retries a genuine dropped-keystroke miss",
    countCycleDoneLines(S3, "plan") === 1);

  // ======================================================================================================
  // SCENARIO 4 (finding 3) — a same-id respawn landing during the POST-READY footer read (logLandedMode)
  // must never deliver gen1's captured kickoff text into gen2, and logLandedMode's own re-derived `live`
  // must likewise never be acted on past the respawn. `startupModeCycles:0` + no resumeModeTarget means
  // SessionStart releases straight to markReady with no boot cycle at all — isolating this scenario to the
  // markReady → logLandedMode → scheduleKickoffGuarantee path. role:"plain" skips scheduleKickoffGuarantee's
  // own `usesOrchestrationMcp` gate, so `proceed()` runs on the very next tick instead of waiting out
  // `waitForMcpSeen`.
  // ======================================================================================================
  const S4 = "sess-respawn-race-4";
  const GEN1_KICKOFF = "GEN1-ONLY-KICKOFF-TEXT-MUST-NOT-LEAK-INTO-GEN2";
  spawnGen1(S4, { startupModeCycles: 0, role: "plain", startupPrompt: GEN1_KICKOFF });
  host.deliverHook(S4, { hook_event_name: "SessionStart", session_id: "eng-4-gen1" });
  // By now (synchronous dispatch): releaseBootModeCycle → markReady → logLandedMode has ALREADY scheduled
  // its own tryRead for LOOM_MODE_LOG_POLL_MS(80ms) from now, bound to gen1.
  const s4gen2 = spawnRespawn(S4, "eng-4-gen2", { role: "plain" });

  check("4: logLandedMode's own tryRead reached its respawned-skip branch (not a normal footer read)",
    await waitUntil(() => allLogLines.some((l) => l.includes(`[resume-mode] ${S4} logLandedMode: tryRead skipped`)), 2000));
  // ANCHOR for the negative assertion below: scheduleKickoffGuarantee's own identity check is the SPECIFIC
  // guard that prevents the write — wait for ITS skip line (not a fixed sleep) before asserting nothing
  // landed in gen2's pty.
  check("4: scheduleKickoffGuarantee's own identity check also fired (the specific guard that stops the write)",
    await waitUntil(() => allLogLines.some((l) => l.includes(`[pty] ${S4} kickoff-guarantee: skipped`)), 2000));
  check("4: gen1's kickoff text never reached gen2's pty", !writesText(s4gen2).includes(GEN1_KICKOFF));
  check("4: gen1's kickoff text is not sitting in gen2's pending queue either",
    !host.getPersistablePendingSnapshot(S4).texts.some((t) => t.includes(GEN1_KICKOFF)));

  // ======================================================================================================
  // SCENARIO 5 (finding 4, test-gap closure) — a same-id respawn landing AFTER the orphaned cycle's FIRST
  // press, exercising decide/awaitChange's own identity guards (round 1, already shipped) rather than only
  // awaitReadable's (the only branch scenario 1 exercises).
  // ======================================================================================================
  const S5 = "sess-respawn-race-5";
  const s5gen1 = spawnGen1(S5);
  s5gen1.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(S5, { hook_event_name: "SessionStart", session_id: "eng-5-gen1" });
  check("5: (setup) gen1's cycle pressed once (acceptEdits → plan attempt) before any respawn",
    await waitUntil(() => countShiftTabs(s5gen1) === 1, 2500)); // > MODE_CYCLE_SETTLE_MS(700)

  // Respawn NOW — gen1's cycle is inside awaitChange's poll loop, waiting for ITS OWN footer to move past
  // "acceptEdits". Feed gen2 a DIFFERENT definite mode so awaitChange's "cur !== prev" branch would (absent
  // the identity guard) treat it as a registered footer change and call decide() against gen2's own footer.
  const s5gen2 = spawnRespawn(S5, "eng-5-gen2");
  const s5gen2Live = host.live.get(S5);
  s5gen2.feed(PLAN_FOOTER);

  check("5: gen1's orphaned cycle reached its own finish()", await waitForCycleDone(S5, "auto", 3000));
  check("5: NO further presses landed in gen2's pty after the respawn — decide/awaitChange's own identity " +
    "guard, not just awaitReadable's",
    countShiftTabs(s5gen2) === 0);
  check("5: gen2 was not marked ready by gen1's stale onDone",
    host.live.get(S5) === s5gen2Live && s5gen2Live.ready === false);
} finally {
  console.log = realLog;
  for (const sid of spawnedSessionIds) { try { host.stop(sid, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-id respawn landing mid-cycle, queued-behind-another-cycle, mid-poll after the "
    + "first press, or during the post-ready footer read all leave the new generation's pty, readiness "
    + "state, and pending queue completely untouched. runCycleToMode's decide/await closures bind to the "
    + "Live the caller QUEUED against (not whatever is current when a queued link finally runs), "
    + "cycleToModeWithRetries never retries a mode request onto a respawned generation, and "
    + "logLandedMode/scheduleKickoffGuarantee bind to the Live markReady actually ran on — so an orphaned "
    + "chain from a dead generation can no longer press Shift+Tab into, call markReady on, or deliver a "
    + "stale kickoff into, a generation it was never driving."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
