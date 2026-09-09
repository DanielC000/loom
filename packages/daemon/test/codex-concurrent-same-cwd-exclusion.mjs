import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7a0b826e: documents the STILL-OPEN concurrent-same-cwd codex conversation-id race — this is NOT a
// passing fix, it is a standing description of an open gap. Do not read a green run here as "closed."
//
// `cbae4520` closes the SEQUENTIAL-reuse shape (a predecessor's rollout file already on disk BEFORE a
// successor is spawned, in the SAME cwd, no --resume) by snapshotting every pre-existing id at spawn time
// — see `codex-recycle-conversation-id-exclusion.mjs`. That snapshot is FROZEN at spawn — it cannot see a
// DIFFERENT fresh codex spawn created into the SAME cwd AFTER the snapshot was taken (e.g. two workers
// dispatched to one project `repoPath` within the ~120s capture window; `sessions/service.ts` fresh-spawns
// at least seven session kinds sharing `cwd: project.repoPath`, and no per-cwd spawn lock exists anywhere —
// this shape is genuinely reachable, not merely hypothetical).
//
// ⚠️ AN IN-SCAN MITIGATION WAS TRIED HERE AND ABANDONED AS A NET REGRESSION (Code Review, two rounds).
// Rejecting a candidate already claimed by a live sibling systematically punishes whichever session is the
// RIGHTFUL owner of that file — the thief has already captured and stopped scanning, so it's always the
// owner's OWN scan that keeps re-encountering "already claimed." Every variant tried either reproduced a
// two-way identity swap when the candidate set shifted mid-ladder, or left the rightful owner with no id
// at all (worse than the plain race below: `sessions/service.ts` derives `resumeId` from `engineSessionId`,
// so "no id" means unresumable, not just misattributed). The scan has no identity information — no signal
// tying a codex process to its own rollout file — to resolve this with. Real closure needs either a
// genuine spawn-time identity correlator (none found in the codex CLI's own flags/docs) or serialising
// fresh codex spawns per cwd — both tracked at card `184fd82e`, not here.
//
// WHAT THIS TEST ASSERTS: the CURRENT, real behaviour of the unmodified `cbae4520` capture path when two
// fresh codex spawns share a cwd — driven end-to-end through the REAL host capture machinery, no shortcut
// pure-function call standing in for it. One session (whose ready marker fires while the other's rollout
// file already exists but uncaptured) can and does adopt the OTHER session's real conversation id; the
// other session's own scan is unaffected by this (nothing here reads or writes any cross-session state)
// and independently, correctly resolves to its own real file — so the end state is two sessions sharing
// ONE real id (one wrong capture + one correct one), not two sessions each holding a distinct wrong id.
// That collision is at least detectable by a uniqueness sweep across live `engineSessionId`s — the reason
// this shape, while still open, is not as bad as the abandoned mitigation's own failure modes.
//
// ⛔ THIS TEST DELIBERATELY DOES NOT REUSE `codex-recycle-conversation-id-exclusion.mjs`'s sequential
// fixture (predecessor file already on disk before the successor is ever spawned) — that shape is already
// covered there and proves nothing about two SIBLINGS spawned close together, each still mid capture-ladder
// when the other's rollout file appears.
//
// Card 184fd82e (decision on this residual): rather than sizing a per-cwd spawn lock off the retry ladder's
// unmeasured ~120s worst-case ceiling, `captureCodexEngineSessionId` (host.ts) now logs a
// CONCURRENT-RACE-WINDOW diagnostic on every capture where another live, same-cwd codex entry is still
// unresolved — the real exposure precondition, observable in production without waiting for a real
// misattribution to occur. This fixture, already manufacturing the exact collision above, is extended below
// to assert that diagnostic fires on A's mis-capture and does NOT false-positive on B's later correct one —
// see docs/adr/184fd82e-defer-serializing-fresh-codex-spawns-per-cwd.md for the full decision + evidence.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-concurrent-same-cwd-exclusion.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (diag) console.log(`      ${diag}`);
  }
};

// Card 184fd82e: capture real console.log output too, so the checks below can assert on the NEW
// concurrent-race-window diagnostic (`captureCodexEngineSessionId`, host.ts) that this same fixture now
// also exercises — real console.log still fires underneath (so PASS/FAIL lines still print).
const capturedLogs = [];
const originalConsoleLog = console.log;
console.log = (...args) => { capturedLogs.push(args.map(String).join(" ")); originalConsoleLog(...args); };

process.env.LOOM_CODEX_ENGINE_ID_RETRY_MS = "40"; // fast retry ladder for this test only
process.env.LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS = "30"; // ~1.2s total budget — ample for a hermetic fixture

const tmpCodexHome = mkdtempManaged("loom-codex-concurrent-residual-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
process.env.LOOM_HOME = mkdtempManaged("loom-codex-concurrent-residual-loomhome-");

const { PtyHost } = await import("../dist/pty/host.js");

const READY = "> Ask Codex to do anything";

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 6161,
    write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
  };
}

class FakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}

const engineSessionIdEvents = [];
const events = {
  onEngineSessionId(sessionId, engineId, previousEngineId) { engineSessionIdEvents.push({ sessionId, engineId, previousEngineId }); },
  onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit() {},
};
const host = new FakeCodexHost(events);

function dayDirFor(home) {
  return path.join(home, "sessions", "2026", "09", "09");
}
function writeRollout(conversationId, cwd, mtimeMs) {
  const dir = dayDirFor(tmpCodexHome);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-09T00-00-00-${conversationId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { session_id: conversationId, cwd, originator: "codex-tui" } }) + "\n");
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return file;
}

// --- THE RESIDUAL: two fresh (non-resume) codex spawns into the SAME cwd, close together — neither's
// spawn-time snapshot can see the other, since neither's rollout file exists yet at either spawn instant.
// B's real file lands first; A's ready marker fires while B's own capture ladder hasn't run yet. This is
// the CURRENT, unmitigated behaviour of the real host capture path — not a hypothetical. ---------------
{
  const cwd = "/fake/codex/cwd-concurrent-residual";
  const victimRealId = "victim-b-real-id"; // B's own genuine conversation id

  host.spawn({ sessionId: "concurrent-a", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePtyA = host.fakeCodexPtys.get("concurrent-a");
  const liveA = host.liveCodex.get("concurrent-a");
  const sinceA = liveA.startedAt;

  host.spawn({ sessionId: "concurrent-b", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePtyB = host.fakeCodexPtys.get("concurrent-b");
  const liveB = host.liveCodex.get("concurrent-b");

  check("neither sibling's spawn-time snapshot sees the other (both fresh, same cwd, no files exist yet)",
    liveA.excludeEngineSessionIds.size === 0 && liveB.excludeEngineSessionIds.size === 0);

  // B's own real rollout file lands on disk — but B's OWN capture ladder has not run yet (B's ready marker
  // hasn't fired), so nothing has captured anything at this instant.
  writeRollout(victimRealId, cwd, sinceA + 100);

  // A's ready fires. A's scan sees ONLY B's file (A's own file doesn't exist yet) and, with no cross-
  // session state to consult, adopts it — this IS today's real behaviour, driven through the real,
  // unmodified capture path.
  fakePtyA.push(`codex TUI booted\n${READY}\n`);
  await waitUntil(
    () => engineSessionIdEvents.some((e) => e.sessionId === "concurrent-a"),
    { label: "A's real capture path resolves (today: adopts whatever matches, including a sibling's file)" },
  );
  check("THE RESIDUAL: A adopted B's REAL conversation id — a live, still-open misattribution, not a hypothetical",
    liveA.engineSessionId === victimRealId,
    `liveA.engineSessionId=${liveA.engineSessionId}`);

  // Card 184fd82e: this is exactly the precondition the new concurrent-race-window diagnostic exists to
  // surface — B is still live, same cwd, and B's own engineSessionId is still unresolved at the instant A
  // captures. MEASURED here, not asserted from the source: the diagnostic fires on the manufactured
  // collision itself, not merely on the code path existing.
  check("NEW INSTRUMENTATION (card 184fd82e): A's capture logged a CONCURRENT-RACE-WINDOW warning — the " +
    "real precondition (B still live, same cwd, uncaptured) held at A's capture instant",
    capturedLogs.some((l) => l.includes("[codex-engine-id] concurrent-a") && l.includes("CONCURRENT-RACE-WINDOW")),
    `logs=${JSON.stringify(capturedLogs.filter((l) => l.includes("codex-engine-id")))}`);

  // B's ready fires next. Nothing in the unmitigated capture path reads or writes any cross-session state,
  // so B's own scan is entirely unaffected by A's earlier (wrong) capture — B independently finds and
  // adopts its OWN real file too.
  fakePtyB.push(`codex TUI booted\n${READY}\n`);
  await waitUntil(
    () => engineSessionIdEvents.some((e) => e.sessionId === "concurrent-b"),
    { label: "B's real capture path independently resolves its own real id" },
  );
  check("B correctly captured ITS OWN real id, unaffected by A's earlier wrong capture",
    liveB.engineSessionId === victimRealId,
    `liveB.engineSessionId=${liveB.engineSessionId}`);

  // Card 184fd82e: B captures AFTER A already resolved, so at B's own capture instant A no longer counts
  // as "still capturing" (A.engineSessionId is set) — the diagnostic must NOT falsely flag B's own correct,
  // unremarkable capture. Guards against a version of the check that fires on ANY same-cwd sibling rather
  // than specifically an UNRESOLVED one.
  check("NEW INSTRUMENTATION: B's own later, correct capture logged NO race-window warning (A had already " +
    "resolved by the time B captured)",
    !capturedLogs.some((l) => l.includes("[codex-engine-id] concurrent-b") && l.includes("CONCURRENT-RACE-WINDOW")),
    `logs=${JSON.stringify(capturedLogs.filter((l) => l.includes("codex-engine-id")))}`);

  check("END STATE: A and B now share ONE real id (one wrong capture + one correct one) — " +
    "a detectable collision (a uniqueness sweep across live engineSessionIds would catch this), " +
    "distinct from a two-way swap where both would hold distinct WRONG ids and nothing would look anomalous",
    liveA.engineSessionId === liveB.engineSessionId && liveA.engineSessionId === victimRealId);

  // A's own real file later lands — but `captureCodexEngineSessionId` returns immediately once
  // `live.engineSessionId` is set (see that method's own doc) and schedules NO further `setTimeout` on the
  // success path, so there is no pending rescan to wait for here at all: A's state is already final,
  // checkable synchronously, the instant it captured above.
  writeRollout("grabber-a-real-id", cwd, sinceA + 20);
  check("A's OWN real conversation is never discovered once A has latched onto B's id — the misattribution is permanent for A's lifetime",
    liveA.engineSessionId === victimRealId && !engineSessionIdEvents.some((e) => e.sessionId === "concurrent-a" && e.engineId === "grabber-a-real-id"));
}

console.log = originalConsoleLog;
await finishAndExit(failures === 0 ? 0 : 1);
