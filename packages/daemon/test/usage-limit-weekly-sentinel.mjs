// Weekly/account usage-cap TEXT-SENTINEL test (card b16320bc). HERMETIC — no daemon, no real claude.
//
// PROBLEM this guards: a SESSION-scoped 5h cap kills the turn with a StopFailure{error:"rate_limit"} —
// already detected (usage-limit-detect.mjs). A WEEKLY/ACCOUNT cap is different: the interactive CLI
// answers it as an ORDINARY assistant reply — e.g. "You've hit your weekly limit · resets 5pm
// (America/Los_Angeles)." — followed by a CLEAN Stop, not a StopFailure. Before this fix, that meant the
// worker just stalled, replying bare "No response requested" to every later manager nudge, with NOTHING
// visible in structured state (busy:false, rateLimitedUntil/rateLimitDeadline empty) — a manager could
// only diagnose it by reading the transcript.
//
// Two parts, mirroring usage-limit-detect.mjs's split:
//   PART 1 (pure): isWeeklyUsageLimitSentinel's phrase matching (positive + negative + FALSE-POSITIVE
//     controls) and readContextStats.lastAssistantText's text-only extraction (tool_use/tool_result
//     excluded, missing file → null) — folded into readContextStats's single-pass scan (review: avoid a
//     second full transcript parse on the Stop hot path), so every fixture below carries a `usage` block
//     (readContextStats returns null with none — see context-stats.mjs's own (d) case).
//   PART 2 (PtyHost, fake pty via the createPty() seam — no real claude, no daemon, no network): a plain
//     Stop hook whose transcript's last assistant turn carries the sentinel PARKS the session through the
//     EXACT SAME onRateLimited path a StopFailure{rate_limit} would — busy falls, the pending queue is
//     HELD (not drained), and a plain Stop with an ordinary reply (including the literal "No response
//     requested" stall text alone, with no sentinel phrase) does NOT park (negative control — precision).
//
// All daemon dist/ imports are DYNAMIC (await import), not static — paths.ts reads LOOM_HOME at import
// time, and static imports hoist ahead of any top-level code (pty-rate-limit-park-drain.mjs's pattern).
//
// RUN (no daemon needed): node test/usage-limit-weekly-sentinel.mjs
//   Requires the daemon built first (reads ../dist/*): from packages/daemon run `pnpm build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE any
// dynamic import of a dist/ module — paths.ts reads LOOM_HOME at import time.
const tmpHome = path.join(os.tmpdir(), `loom-wls-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { readContextStats } = await import("../dist/sessions/context.js");
const { isWeeklyUsageLimitSentinel } = await import("../dist/orchestration/usage-limit.js");
const { PtyHost } = await import("../dist/pty/host.js");

// Every fixture line below needs a `usage` block: readContextStats (whose single pass now also derives
// lastAssistantText) returns null with none, same as its own no-usage case (context-stats.mjs's (d)).
const USAGE = { input_tokens: 100, output_tokens: 10 };

// ============================ PART 1 — pure (no pty, no daemon) ============================

{
  // --- isWeeklyUsageLimitSentinel: the REAL CLI shape, ≥2 timezone variants ---
  check("sentinel: the literal evidence phrase matches (Europe/Vienna)",
    isWeeklyUsageLimitSentinel("You've hit your weekly limit · resets 5pm (Europe/Vienna).") === true);
  check("sentinel: the literal evidence phrase matches (America/Los_Angeles)",
    isWeeklyUsageLimitSentinel("You've hit your weekly limit · resets 5pm (America/Los_Angeles).") === true);
  check("sentinel: 'account' variant + 'have' (not 've) + colon clock time matches",
    isWeeklyUsageLimitSentinel("You have hit your account limit · resets 17:00 (UTC).") === true);
  check("sentinel: 'usage limit' variant + 'resets at <time>' matches",
    isWeeklyUsageLimitSentinel("You've hit your weekly usage limit — resets at 11:30pm (UTC).") === true);

  // --- negative controls: unrelated / generic text ---
  check("sentinel: bare 'No response requested' (no phrase) does NOT match — precision",
    isWeeklyUsageLimitSentinel("No response requested.") === false);
  check("sentinel: 'limit' alone (no weekly/account) does NOT match",
    isWeeklyUsageLimitSentinel("There's a rate limit on this API, it resets hourly.") === false);
  check("sentinel: 'weekly limit' with NO 'hit your' framing does NOT match",
    isWeeklyUsageLimitSentinel("We discussed the weekly limit in the design doc.") === false);
  check("sentinel: unrelated prose does NOT match",
    isWeeklyUsageLimitSentinel("The build finished; all tests passed.") === false);

  // --- FALSE-POSITIVE controls (the review blocker): a Loom dev session routinely talks ABOUT this very
  // feature — "weekly limit" + "resets" appearing together in ordinary prose must NEVER park a healthy
  // session. Requiring the CLI's "hit your ... limit" framing AND a resets+CLOCK-TIME (not a bare
  // "resets on Monday") is what keeps these rejected.
  check("FALSE POSITIVE: a worker describing the feature ('the weekly-limit resets detection …') does NOT match",
    isWeeklyUsageLimitSentinel("the weekly-limit resets detection parks the worker") === false);
  check("FALSE POSITIVE: 'your account limit resets on Monday' (reset day, no clock time, no 'hit') does NOT match",
    isWeeklyUsageLimitSentinel("when your account limit resets on Monday, you can retry") === false);
  check("FALSE POSITIVE: a realistic multi-paragraph worker report mentioning weekly limits + resets in passing does NOT match",
    isWeeklyUsageLimitSentinel(
      "Implemented detection for the weekly/account usage cap (card b16320bc).\n\n"
      + "When a session hits the limit, the CLI shows a message and the account resets after the cap "
      + "window clears. I added a sentinel matcher and wired it through the existing park path so a "
      + "manager can see weekly limits and their resets reflected in worker_list without reading the "
      + "transcript. All tests for the weekly-cap resets pass and the daemon suite is green."
    ) === false);
  check("FALSE POSITIVE (CLOCK_RE precision): 'hit your weekly limit' + a BARE INTEGER after 'resets' does NOT match",
    isWeeklyUsageLimitSentinel("Once you hit your weekly limit the retry counter resets 5 items later.") === false);
  check("FALSE POSITIVE (CLOCK_RE precision): 'hit your weekly limit' + 'resets 5×' (no clock shape) does NOT match",
    isWeeklyUsageLimitSentinel("If you hit your weekly limit, note the counter resets 5× before giving up.") === false);

  // --- readContextStats.lastAssistantText: text-only extraction (tool_use/tool_result excluded),
  // last-wins, missing → null. Folded into readContextStats's existing single-pass scan (review) rather
  // than a second parse — every fixture needs a `usage` block or the WHOLE stats object reads null.
  const cwd = path.join(os.tmpdir(), `loom-wls-txt-${Date.now()}`);
  const dir = path.dirname(engineTranscriptPath(cwd, "seed"));
  fs.mkdirSync(dir, { recursive: true });
  const writeFixture = (id, lines) =>
    fs.writeFileSync(engineTranscriptPath(cwd, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    writeFixture("cap", [
      { type: "user", message: { content: "keep going" } },
      { type: "assistant", message: { content: [{ type: "text", text: "first reply" }], usage: USAGE } },
      { type: "assistant", message: { content: [{ type: "text", text: "You've hit your weekly limit · resets 5pm (America/Los_Angeles)." }], usage: USAGE } },
    ]);
    check("readContextStats.lastAssistantText: reads the LAST text-bearing assistant line",
      readContextStats(cwd, "cap")?.lastAssistantText === "You've hit your weekly limit · resets 5pm (America/Los_Angeles).");

    // A tool_use block's JSON args could itself contain the sentinel phrase (e.g. a Write of THIS
    // fixture) — must be excluded so a tool call can never masquerade as the model's own words.
    writeFixture("toolonly", [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { content: "You've hit your weekly limit · resets 5pm" } }], usage: USAGE } },
    ]);
    check("readContextStats.lastAssistantText: a tool_use-only line contributes NO text (tool args excluded)",
      readContextStats(cwd, "toolonly")?.lastAssistantText === null);

    // tool_result content lives on a `user`-role line in the real transcript shape — must never be read.
    writeFixture("toolresult", [
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }], usage: USAGE } },
      { type: "user", message: { content: [{ type: "tool_result", content: "You've hit your weekly limit · resets 5pm" }] } },
    ]);
    check("readContextStats.lastAssistantText: a tool_result on a user-role line is never read as the assistant's words",
      readContextStats(cwd, "toolresult")?.lastAssistantText === "ok");

    check("readContextStats: missing transcript → null (unchanged)", readContextStats(cwd, "no-such-id") === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===================== PART 2 — PtyHost (fake pty, no real claude, no daemon) =====================

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = {
    pid: 4243,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.push(fake);
  return fake;
}

class TestPtyHost extends PtyHost {
  createPty() { return makeFakePty(); }
}

const busyLog = [];
const rateLimitedLog = [];
const events = {
  onEngineSessionId() {},
  onBusy(_id, busy) { busyLog.push(busy); },
  onContextStats() {},
  onRateLimited(id, until, detail) { rateLimitedLog.push({ id, until, detail }); },
  onExit() {},
};

const host = new TestPtyHost(events);
const SID = "sess-wls";
const ENGINE_ID = "engine-wls-1";
const cwd = path.join(os.tmpdir(), `loom-wls-cwd-${Date.now()}`);
const transcriptDir = path.dirname(engineTranscriptPath(cwd, ENGINE_ID));
fs.mkdirSync(transcriptDir, { recursive: true });
const writeTranscript = (lines) =>
  fs.writeFileSync(engineTranscriptPath(cwd, ENGINE_ID), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const lastBusy = () => busyLog[busyLog.length - 1];

host.spawn({
  sessionId: SID, cwd,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
const fake = fakes[0];
check("spawn used the injected fake pty (no real claude)", !!fake && host.isAlive(SID) === true);

try {
  // SessionStart carries the engine id → captured (readContextStats needs cwd+engineSessionId).
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_ID });

  // A turn goes out; the manager also queues a follow-up direction behind it.
  const rp = host.enqueueStdin(SID, "keep working on the task");
  check("setup: the turn submitted immediately (busy armed)", rp.delivered === true && lastBusy() === true);
  await sleep(120);
  const followUp = host.enqueueStdin(SID, "[loom:from-manager]\nANY_UPDATES", "system");
  check("setup: the follow-up QUEUED behind the busy turn", followUp.delivered === false && followUp.position === 1);

  // The engine answers with the weekly-cap sentinel as its actual reply, then a CLEAN Stop (not StopFailure)
  // — exactly the evidence shape (Bugfix 4d8dad0a / Codescape Web-Designer 85cd2ff5). A REAL completed
  // turn always carries `usage` (readContextStats' single-pass scan needs it — see PART 1's note).
  writeTranscript([
    { type: "user", message: { content: "keep working on the task" } },
    { type: "assistant", message: { content: [{ type: "text", text: "You've hit your weekly limit · resets 5pm (America/Los_Angeles)." }], usage: USAGE } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop" });

  check("PARK: onRateLimited fired exactly once via the TEXT-sentinel path (plain Stop, no StopFailure)",
    rateLimitedLog.length === 1 && rateLimitedLog[0].id === SID);
  check("PARK: the park message names 'usage limit'",
    typeof rateLimitedLog[0].detail?.message === "string" && rateLimitedLog[0].detail.message.includes("usage limit"));
  check("PARK: busy fell to false", lastBusy() === false);
  check("PARK: the queued follow-up was NOT drained (a real StopFailure park would hold it identically)",
    JSON.stringify(host.getPending(SID)) === JSON.stringify(["[loom:from-manager]\nANY_UPDATES"]));
  host.reconcile();
  check("PARK: reconcile() is a no-op while parked (mirrors the StopFailure park guard)",
    JSON.stringify(host.getPending(SID)) === JSON.stringify(["[loom:from-manager]\nANY_UPDATES"]));

  // Resume clears the park exactly like the StopFailure path (SAME onRateLimited-driven machinery) and
  // re-submits the interrupted turn.
  const resumed = host.resumeAfterRateLimit(SID);
  check("RESUME: resumeAfterRateLimit unparks the session", resumed === true);
  await sleep(120);

  // End the resumed turn normally (an ordinary reply, no sentinel) → the held follow-up finally drains.
  writeTranscript([{ type: "assistant", message: { content: [{ type: "text", text: "sure, continuing" }], usage: USAGE } }]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("POST-RESUME: the held follow-up drained once the resumed turn ended cleanly",
    host.getPending(SID).length === 0 && lastBusy() === true);
  await sleep(120);

  // ── Negative control: a plain Stop whose reply is the BARE stall text alone (no sentinel phrase)
  // must NOT park — precision, so an ordinary "nothing to do" turn never falsely parks the fleet.
  rateLimitedLog.length = 0;
  writeTranscript([{ type: "assistant", message: { content: [{ type: "text", text: "No response requested." }], usage: USAGE } }]);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("NEGATIVE CONTROL: a bare 'No response requested' reply alone does NOT park",
    rateLimitedLog.length === 0);
  check("NEGATIVE CONTROL: busy fell to false normally (clean Stop, normal drain)", lastBusy() === false);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the weekly/account usage-cap TEXT sentinel is detected from the assistant's own last reply (not tool output), parks the session through the SAME onRateLimited path as a StopFailure cap, and does not false-positive on an ordinary reply or the bare stall text alone."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
