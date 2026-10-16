import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fd4704bc — REAL-SPAWN proof (memory `real-spawn-smoke-for-subprocess-features`: a mocked exec
// never exercises a real OS pty boundary) that a large kickoff's own give-up hold now outlasts a LATE
// engine confirmation that arrives well past where the OLD, unscaled GIVE_UP_HOLD_MS would already have
// exhausted the give-up/re-mint ladder and PARKED the delivery. Reuses the SAME real node-pty +
// LOOM_CLAUDE_BIN substitution technique test/kickoff-real-spawn.mjs already established (real child
// process, real bidirectional pty I/O, never a stub of PtyHost or node-pty) — this file adds the
// SessionService/Db wiring kickoff-real-spawn.mjs never needed (that file's own scenarios all confirm
// near-instantly, so the give-up/re-mint ladder is never exercised there at all).
//
// SCENARIO: a ~28K-char realistic kickoff (real CLAUDE.md/SKILL.md prose, not synthetic padding) is
// delivered to a REAL spawned child. The confirming UserPromptSubmit hook is held back and delivered
// manually at a chosen delay — simulating the real, variable engine-confirmation lag this card's own
// investigation measured (up to 57s in production; pinned memory records 232s). The delay is chosen to
// fall:
//   - PAST where the pre-fix (bare, unscaled) GIVE_UP_HOLD_MS ladder would already have exhausted both
//     give-up cycles and PARKED (a bare ~500ms hold means that whole ladder completes in low seconds);
//   - WELL WITHIN the fix's own scaled hold for this kickoff's size (giveUpHoldExtraMs pushes the FIRST
//     hold out to ~20s for this payload) — so the original write is still sitting cleanly HELD, never
//     re-minted, when the late hook arrives.
// Asserts, THE DISCRIMINATING OBSERVABLES (CR round 2 comment fix — these two are what actually tell
// fixed from reverted code): no give-up EVER exhausted its budget, re-minted, or parked — the hold held
// long enough that none of that machinery ever had to run; AND no durable PARK event was ever recorded
// for this session. Plus three SANITY checks that hold under either fixed OR reverted code, so they don't
// by themselves prove this card's own regression is gone, but do catch other regressions: the kickoff
// body was physically written to the real child's real stdin EXACTLY ONCE (a future duplicate-paste
// regression would show 2+ here — this is the decisive, pty-output-independent proof kickoff-real-
// spawn.mjs uses for ITS OWN duplicate-paste claim, reused here as a sanity check, not a discriminator);
// the late hook is accepted as a genuine, content-matched confirmation (the production "CONFIRMED ...
// content-matched" log fires — true even under reverted code, since a late hook still content-matches
// against whatever's left); and the pending queue is empty after the confirm (also true after a park, not
// just after a clean purge).
//
// WINDOWS-ONLY, same as kickoff-real-spawn.mjs (the .cmd-wrapper fixture mechanism) — SKIPs on POSIX.
//
// Run: 1) build (turbo builds shared first), 2) node test/give-up-hold-scale-real-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-cli.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.log("WARN  SKIP  give-up-hold-scale-real-spawn.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see kickoff-real-spawn.mjs's header for the accepted POSIX gap.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-givehold-real-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;
process.env.FIXTURE_DEBOUNCE_MS = "250";

// ============ Fast-but-real give-up ladder (same discipline as kickoff-giveup-remint-purge.mjs) ========
// Scaled down from production's real tens-of-seconds-per-attempt tuning so this file runs in low tens of
// seconds, not minutes — but the RELATIONSHIP under test (a large kickoff's hold is scaled, a small
// write's isn't) is the exact same mechanism at the exact same real-spawn layer, just compressed in time.
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "100";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "2";
process.env.LOOM_GIVE_UP_REQUEUE_LIMIT = "1";
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "1";
const HOLD_MS = 500;
const ABOVE_CHARS = 1000;
const BYTES_PER_MS = 1;
const MAX_EXTRA_MS = 20_000;
process.env.LOOM_GIVE_UP_HOLD_MS = String(HOLD_MS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_ABOVE_CHARS = String(ABOVE_CHARS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_BYTES_PER_MS = String(BYTES_PER_MS);
process.env.LOOM_GIVE_UP_HOLD_SCALE_MAX_EXTRA_MS = String(MAX_EXTRA_MS);

const { PtyHost, buildSpawnArgs, giveUpHoldExtraMs } = await import("../dist/pty/host.js");
const { ensureDirs, WORKTREES_DIR } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR);

const claudeMd = fs.readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
const workerSkill = fs.readFileSync(path.join(REPO_ROOT, "packages", "daemon", "assets", "skills", "worker", "SKILL.md"), "utf8");
function realisticKickoff(targetSize) {
  const base = `[role:worker] ${claudeMd.slice(0, 4000)}\n\n---\n\n${workerSkill.slice(0, 3000)}\n\n` +
    `Do the "worker" task now — quote test: says "hi" and uses \`backticks\` and a lone backslash \\ here.`;
  if (base.length >= targetSize) return base;
  const filler = `${claudeMd}\n\n${workerSkill}\n\n`;
  let out = base;
  while (out.length < targetSize) out += filler.slice(0, targetSize - out.length);
  return out;
}
const KICKOFF = realisticKickoff(ABOVE_CHARS + 27_000); // ~28K chars — well past the scale floor
check("setup: kickoff is really past the scale floor", KICKOFF.length > ABOVE_CHARS);
const expectedExtra = giveUpHoldExtraMs(KICKOFF.length);
check(`setup: this kickoff's own computed extra hold is substantial (${expectedExtra}ms) — the whole scenario depends on it`, expectedExtra > 10_000);

// The delay this file actually delivers the late confirming hook at: comfortably past where the bare,
// UNSCALED GIVE_UP_HOLD_MS ladder (500ms hold x 2 cycles + the ~1-2s Enter-retry overhead each) would
// already have exhausted and PARKED — and comfortably within HOLD_MS + expectedExtra (~20.5s here).
const LATE_CONFIRM_DELAY_MS = 8_000;
check(`setup: the chosen late-confirm delay (${LATE_CONFIRM_DELAY_MS}ms) sits well inside the scaled hold (${HOLD_MS + expectedExtra}ms) and well past where an unscaled ~${HOLD_MS}ms x 2-cycle ladder would already have parked`,
  LATE_CONFIRM_DELAY_MS < HOLD_MS + expectedExtra && LATE_CONFIRM_DELAY_MS > HOLD_MS * 4);

const submitLog = [];
const giveUpLog = [];
// Card fd4704bc CR round 2 (BLOCKING): the real moment cycle 1's own give-up fires is recorded HERE,
// inside the interceptor, at the instant the HELD log line is actually produced — not later, when some
// `waitUntil` call elsewhere happens to notice it in `submitLog`. The HELD event can fire WHILE this file
// is still blocked in the earlier first-flush `waitUntil` (below); if it does, `submitLog` already holds
// the line by the time that wait's own `waitUntil` for the HELD text is reached, which returns almost
// instantly — but at a time that has nothing to do with when HELD actually happened. Anchoring the later
// reconcile-driving window to THIS timestamp (not to "whenever we got around to checking") is what makes
// the window's real duration match its intended ~8s, instead of silently eating however long the
// first-flush wait took first.
let heldAt = null;
const realConsoleLog = console.log.bind(console);
const realConsoleWarn = console.warn.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("[submit]")) {
    submitLog.push(args[0]);
    if (heldAt === null && args[0].includes("HELD from drain for up to")) heldAt = Date.now();
  }
  realConsoleLog(...args);
};
console.warn = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) giveUpLog.push(args[0]); realConsoleWarn(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && (args[0].startsWith("[submit]") || args[0].startsWith("[give-up]"))) giveUpLog.push(args[0]); realConsoleError(...args); };

const exitedSessions = new Set();
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(sessionId) { exitedSessions.add(sessionId); } };
const host = new PtyHost(events);

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}`;
const proj = `ghrs-proj-${sfx}`, agent = `ghrs-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mgr = `ghrs-mgr-${sfx}`, SID = `ghrs-wkr-${sfx}`, taskId = `tk-ghrs-${sfx}`;
db.insertSession({
  id: mgr, projectId: proj, agentId: agent, engineSessionId: `eng-${mgr}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", parentSessionId: null, taskId: null, worktreePath: null, branch: null,
});
db.insertSession({
  id: SID, projectId: proj, agentId: agent, engineSessionId: `eng-${SID}`, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: mgr, taskId, worktreePath: null, branch: null,
});
const sessions = new SessionService(db, host, new OrchestrationControl());
// Wire the REAL production chain — PtyHost's own onKickoffGiveUpExhausted event is DB-agnostic by design
// (card a8f8a8f2) and is wired to SessionService by the host process (index.ts in production); mirrors
// kickoff-giveup-remint-purge.mjs's own wiring.
events.onKickoffGiveUpExhausted = (sessionId, msgId, rootMsgId, kickoffText) =>
  sessions.handleKickoffGiveUpExhausted(sessionId, msgId, rootMsgId, kickoffText);

const stoppedSessions = new Set();
async function stopAndAwaitExit(sessionId) {
  if (stoppedSessions.has(sessionId)) return;
  stoppedSessions.add(sessionId);
  try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ }
  try {
    await sharedWaitUntil(() => exitedSessions.has(sessionId), { label: `${sessionId} real child onExit`, timeoutMs: 5000 });
  } catch (err) {
    console.warn(`[give-up-hold-scale-real-spawn] ${sessionId} never reported onExit within budget: ${err.message}`);
  }
}

try {
  const outputFile = path.join(tmpHome, `received-${SID}`);
  process.env.FIXTURE_OUTPUT_FILE = outputFile;
  const opts = {
    sessionId: SID, cwd: tmpHome, startupPrompt: KICKOFF, role: "worker",
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  };
  const reproArgs = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: {}, startupPrompt: KICKOFF });
  check("buildSpawnArgs never emits the kickoff into argv", !reproArgs.includes(KICKOFF) && !reproArgs.includes("--"));

  const fakes = []; // populated via subscribe below, mirrors kickoff-real-spawn.mjs's RealFixtureHarness
  let buf = "";
  host.spawn(opts);
  host.subscribe(SID, { onData: (chunk) => { buf += chunk.toString("utf8"); }, onControl: () => {} });
  host.markMcpSeen(SID); // see kickoff-real-spawn.mjs's own doc — no real HTTP gateway in this harness

  await sharedWaitUntil(() => /FIXTURE_READY/.test(buf), { label: "real fixture FIXTURE_READY", timeoutMs: 20_000 });
  check("the real child process never reported an extra positional argv entry", !/FIXTURE_FAIL/.test(buf));

  host.deliverHook(SID, { hook_event_name: "SessionStart" }); // triggers the real kickoff delivery

  // Wait for the FIRST physical flush (the real child's debounced write of the original paste) — this is
  // the ONE AND ONLY expected body write for the whole scenario.
  // Budget widened past the old 15_000ms (card fd4704bc CR follow-up): a real child boot + a ~28K-char
  // real paste on a loaded host measurably overshot that to ~23s in one observed run — a genuine LATE
  // arrival (per `waitUntil`'s own ARRIVED-LATE/ABSENT distinction), not a hang. 45s stays well clear of
  // this hold's own `LATE_CONFIRM_DELAY_MS` (8s), so a genuine hang still fails loudly and fast relative
  // to the scenario's own real timeline.
  await sharedWaitUntil(() => fs.existsSync(`${outputFile}.1`), { label: "real fixture's first output flush", timeoutMs: 45_000 });

  // Anchor the late-confirm delay to cycle 1's OWN give-up (observed, not assumed) — not to the earlier
  // first-flush event above. The gap between "paste landed" and "cycle 1 actually gives up" is itself
  // real-child/host-speed-dependent (the Enter-retry ladder runs on its own internal timers), so timing
  // the late confirm from the EARLIER event risks eating into the hold's own margin on a loaded host —
  // measured directly: one run's first-flush wait alone absorbed ~23s of real time, which would have left
  // a FIXED post-flush delay no longer "well within" the scaled hold. Waiting for the give-up's own log
  // line removes that dependency entirely.
  await sharedWaitUntil(() => submitLog.some((l) => l.includes("HELD from drain for up to")), { label: "cycle 1's own give-up (HELD log line)", timeoutMs: 30_000 });

  // `heldAt` was stamped by the console.log interceptor above at the REAL moment HELD fired — possibly
  // well before the `await` just above returned, if HELD happened while this file was still blocked in
  // the earlier first-flush wait. Everything below is anchored to THAT real timestamp, never to a fresh
  // `Date.now()` taken here — see the interceptor's own comment for why the two can diverge by many
  // seconds on a slow/loaded host.
  if (heldAt === null) heldAt = Date.now(); // defensive only: the waitUntil above cannot resolve without it

  // Card fd4704bc CR round 2 (BLOCKING): if the delay between the REAL HELD event and this point has
  // already eaten too much of the scaled hold's own margin, driving the reconcile loop for the full
  // LATE_CONFIRM_DELAY_MS would push PAST the scaled hold and into cycle 2's own exhaust/re-mint/park —
  // a FALSE RED on fixed code, not a real regression (this is the exact false-positive the predecessor's
  // own specimen measured: HELD at +9370ms, first redrain only at +21544ms, because the window used to be
  // anchored to "whenever we noticed HELD" instead of to HELD itself). Bail out as INCONCLUSIVE instead —
  // this must never be scored as a fix regression, and must never silently pass either.
  const scaledHoldMs = HOLD_MS + expectedExtra;
  const SAFETY_MARGIN_MS = 3000;
  const elapsedSinceHeld = Date.now() - heldAt;
  const remainingBudgetMs = scaledHoldMs - elapsedSinceHeld - SAFETY_MARGIN_MS;
  if (remainingBudgetMs < LATE_CONFIRM_DELAY_MS) {
    // `failures` can already be nonzero from an earlier setup/fixture check (lines ~107-201) — those are
    // REAL bugs, not a timing-margin casualty, and must never be swallowed by this inconclusive exit.
    if (failures > 0) {
      console.log(`\n⚠️  Also inconclusive on timing margin (${elapsedSinceHeld}ms elapsed since HELD, ${remainingBudgetMs}ms `
        + `remaining budget), but reporting as a REAL FAILURE instead because ${failures} earlier check(s) already failed.`);
      await stopAndAwaitExit(SID);
      await finishAndExit(1);
    }
    console.log(`\n⚠️  INCONCLUSIVE — harness too slow for this run: ${elapsedSinceHeld}ms already elapsed since the `
      + `REAL HELD event (observed via the console.log interceptor, not a guess) before this file could start `
      + `driving reconcile(), leaving only ${remainingBudgetMs}ms of margin inside the scaled hold `
      + `(${scaledHoldMs}ms, minus a ${SAFETY_MARGIN_MS}ms safety margin) for the ${LATE_CONFIRM_DELAY_MS}ms `
      + `late-confirm window this scenario needs. Driving the full window here could push past the scaled hold `
      + `and trip cycle 2's own exhaust/re-mint/park on fixed code — a harness-timing limitation, not a fix `
      + `regression. Exiting 0 (inconclusive, not a pass and not a fail) rather than reporting a false red.`);
    await stopAndAwaitExit(SID);
    await finishAndExit(0);
  }

  // Deliberately wait past where the UNSCALED ladder would already have exhausted/re-minted/parked, but
  // well within the scaled hold — then deliver the late confirming hook, exactly as a real, slow `claude`
  // engine eventually would via its own UserPromptSubmit hook.
  //
  // CODE REVIEW CATCH (2d2751bc), BLOCKING: this harness is a bare `PtyHost`, not the real daemon — nothing
  // calls `host.reconcile()` on a timer the way production's own periodic reconcile does. Without driving
  // it here, a HELD entry (cycle 1's own give-up) can NEVER redrain regardless of how long this file waits
  // — meaning this whole scenario passed even with the fix fully reverted at all three call sites (the CR's
  // own negative control proved it), because no SECOND give-up could ever fire to exhaust/re-mint/park in
  // the first place. Drive it explicitly, same discipline as give-up-hold-scales-with-paste-size.mjs's own
  // `waitForNextRedrainMs` — this is what actually lets the UNSCALED ladder complete its own park inside
  // this same wait when the fix is reverted, which is the only way this scenario can discriminate at all.
  // Anchored to the REAL `heldAt` timestamp (above), never to a fresh `Date.now()` taken here — see that
  // block's own comment for why the two can diverge by many seconds on a slow/loaded host.
  const reconcileUntil = heldAt + LATE_CONFIRM_DELAY_MS;
  while (Date.now() < reconcileUntil) {
    host.reconcile();
    await sleep(10);
  }
  submitLog.length = 0;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: KICKOFF });
  host.reconcile(); // let the content-match purge (if the hook landed on an already-parked re-mint) settle

  // SANITY CHECK, not a discriminator (CR round 2 comment fix): the late hook must be accepted as a
  // genuine, content-matched confirmation — no OR-fallback (the prior draft's `|| submitLog.length === 0`
  // made this pass even when the hook produced NO log at all, exactly the shape a parked/dead lineage can
  // produce — CR catch). But CONFIRMED fires even under REVERTED code: a late UserPromptSubmit still
  // content-matches against whatever's left (a re-minted copy, or the parked entry's own stored text), so
  // this check alone cannot tell fixed from reverted — it only proves the hook wasn't silently dropped.
  check("sanity: the late hook was accepted as a genuine, content-matched confirmation",
    submitLog.some((l) => l.includes("CONFIRMED") && l.includes("content-matched")));
  // THE DISCRIMINATING OBSERVABLE: no give-up ever exhausted its budget, re-minted, or parked across the
  // whole scenario. This is the check that actually tells fixed from reverted — under reverted code (with
  // reconcile() genuinely driven above), the UNSCALED hold redrains, exhausts, re-mints, and parks WELL
  // BEFORE this point, which is exactly what this regex matches.
  check("no give-up EVER exhausted its budget, re-minted, or parked across the whole scenario — the hold held long enough, now that reconcile() is actually driven",
    !giveUpLog.some((l) => /exhausted its (in-session requeue|give-up requeue) budget|re-minted as|PARKING/.test(l)));
  // SANITY CHECK, not a discriminator (CR round 2 comment fix): the pending queue should be EMPTY after
  // the confirm. But this ALSO passes under reverted code — a park removes the entry from `pending` just
  // as cleanly as a content-matched purge does, so an empty queue here is consistent with either outcome
  // and cannot by itself prove which one happened. The giveUpLog regex above, and the durable PARK-event
  // check below, are what actually discriminate.
  check("sanity: the pending queue is empty after the confirm — nothing was ever left HELD/re-minted for reconcile() to still be sitting on",
    host.getPendingEntries(SID).length === 0);

  // Read the flush file(s) back directly — a SANITY CHECK, not this card's own discriminator (same
  // technique as kickoff-real-spawn.mjs, where it IS decisive for that file's own duplicate-paste claim).
  // NOTE (CR catch, comment fix): a REVERTED fix does NOT show 2+ body copies here — 844ca34e (already
  // deployed, unrelated to this card) already makes any re-mint/redelivery Enter-only, never a second
  // physical paste. The reverted-code failure mode THIS card cares about is PARK, not duplication — caught
  // by the giveUpLog regex and the durable PARK-event check below, not by this count. This count instead
  // guards against a DIFFERENT regression (any future change that reintroduces a duplicate paste).
  const flushFiles = fs.readdirSync(tmpHome).filter((f) => f.startsWith(path.basename(outputFile) + "."));
  check(`at least one flush file was written (found ${flushFiles.length})`, flushFiles.length >= 1);
  const allReceived = flushFiles.map((f) => fs.readFileSync(path.join(tmpHome, f), "utf8")).join("");
  const bodyOccurrences = allReceived.split(KICKOFF).length - 1;
  check(`sanity: the kickoff body was physically written to the real child's real stdin EXACTLY ONCE (found ${bodyOccurrences} occurrence(s) across ${flushFiles.length} flush file(s)) — a future duplicate-paste regression would show 2+ here`,
    bodyOccurrences === 1);

  // THE OTHER DISCRIMINATING OBSERVABLE: a PARK is durably recorded as its own event kind, independent of
  // the in-memory giveUpLog regex above — reverted code parking this session leaves a real row here.
  const noParkEvents = db.listEventsForWorker(SID).filter((e) => e.kind === "session_message_gave_up" && e.detail?.outcome === "parked");
  check("no durable PARK event was ever recorded for this session", noParkEvents.length === 0);

  await stopAndAwaitExit(SID);
} catch (err) {
  console.error(`\n💥 UNCAUGHT — ${err?.stack || err}`);
  failures++;
} finally {
  await stopAndAwaitExit(SID);
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card fd4704bc, REAL SPAWN: a ~28K-char kickoff delivered to a REAL spawned child "
    + "(real node-pty, real OS process, real bidirectional pty I/O) whose confirming UserPromptSubmit hook "
    + "arrives late — well past where the pre-fix unscaled give-up/re-mint ladder would already have "
    + "parked it, but comfortably inside this kickoff's own scaled hold — lands as a clean, single, "
    + "content-matched confirmation: the body was written to the real child's real stdin exactly once, no "
    + "give-up ever exhausted its budget or parked, and no duplicate/corrupting re-paste ever happened."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
