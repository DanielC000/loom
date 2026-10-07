import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 60aff555: a codex RESUME already knows its own engine id — it's `opts.resumeId`, the very id this
// spawn just told codex to `resume <uuid>`. Before this card's fix, `spawnCodexProcess` seeded
// `CodexLive.engineSessionId: null` UNCONDITIONALLY, even for a resume, and relied on
// `captureCodexEngineSessionId`'s freshness-only rediscovery scan to fill it back in — a scan that runs
// with NO sibling exclusion on the resume path (`excludeEngineSessionIds` is `null` for a resume, by
// design: a resume legitimately needs to re-match its OWN pre-existing file, which the fresh-spawn
// snapshot would otherwise wrongly exclude). So a SIBLING codex session's rollout file, written into the
// SAME cwd with a fresher mtime during the resume's capture window, could be wrongly adopted instead of
// the resume's own file. `184fd82e` tracks only the FRESH-vs-FRESH concurrent-same-cwd shape (two brand
// new spawns racing); this is a different shape — a RESUME racing a sibling — and is closed here by
// seeding `engineSessionId` directly from `opts.resumeId`, which makes the rediscovery scan never run at
// all for a resume (see `captureCodexEngineSessionId`'s own `if (live.engineSessionId || !live.alive)
// return;` guard).
//
// TECHNIQUE: mirrors `codex-concurrent-same-cwd-exclusion.mjs` — a fake `createCodexPty()` override drives
// the REAL `spawnCodexProcess`/`captureCodexEngineSessionId` path with scripted onData chunks, no real
// codex process. `LOOM_CODEX_ENGINE_ID_RETRY_MS`/`_MAX_ATTEMPTS` shrink the retry ladder so a (pre-fix)
// failing run would not hang this test.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-resume-engine-id-sibling-isolation.mjs
process.env.LOOM_CODEX_ENGINE_ID_RETRY_MS = "40";
process.env.LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS = "10";
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

const tmpCodexHome = mkdtempManaged("loom-codex-resume-sibling-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
process.env.LOOM_HOME = mkdtempManaged("loom-codex-resume-sibling-loomhome-");

const { PtyHost } = await import("../dist/pty/host.js");

const READY = "> Ask Codex to do anything";

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 7171,
    write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
  };
}

class FakeCodexHost extends PtyHost {
  sweepOrphanedDescendants(_rootPid) {}
  reapExitedDescendants(_rootPid) {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
  async captureRootCreationRow(_pid) { return null; }
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

// --- Scenario A (THE BUG): a resume spawn, with a SIBLING codex session's rollout file landing in the
// SAME cwd, with a fresher mtime, during the resume's own capture window. Pre-fix, the resume's rescan
// (no exclusion) would adopt the sibling's file once the ready marker fired. Post-fix, the resume's own
// `engineSessionId` is already seeded from `opts.resumeId` at spawn time — the scan is never consulted at
// all, so the sibling's file can never be adopted. -----------------------------------------------------
{
  const cwd = "/fake/codex/cwd-resume-sibling";
  const RESUME_ID = "resumed-conversation-real-id";
  const SIBLING_ID = "sibling-conversation-real-id";

  host.spawn({
    sessionId: "resume-a", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    role: "worker", harness: "codex", resumeId: RESUME_ID,
  });
  const fakePty = host.fakeCodexPtys.get("resume-a");
  const live = host.liveCodex.get("resume-a");
  const sinceMs = live.startedAt;

  check("RESUME: engineSessionId is seeded SYNCHRONOUSLY from opts.resumeId at spawn — before any ready marker, before any scan",
    live.engineSessionId === RESUME_ID, `live.engineSessionId=${live.engineSessionId}`);
  check("RESUME: excludeEngineSessionIds stays null for a resume (unchanged — only the seed above is new)",
    live.excludeEngineSessionIds === null, `excludeEngineSessionIds=${live.excludeEngineSessionIds}`);

  // The sibling's rollout file lands in the SAME cwd, with a mtime strictly fresher than this resume's own
  // startedAt — exactly the shape that, pre-fix, would win `findConversationIdForSpawn`'s "newest wins"
  // freshness scan once this resume's own ready marker fired.
  writeRollout(SIBLING_ID, cwd, sinceMs + 100);

  // Fire the ready marker — this is the ONLY thing that triggers `captureCodexEngineSessionId` at all.
  fakePty.push(`codex TUI booted\n${READY}\n`);
  await waitUntil(
    () => live.engineSessionIdCaptureAttempted === true,
    { label: "resume-a's onData handler to run its one-shot capture-attempt branch (ready marker seen)" },
  );
  // No further wait is needed here, on EITHER side of this fix: `findConversationIdForSpawn` is a plain
  // synchronous filesystem scan (no async scheduling on its own), so `captureCodexEngineSessionId`'s
  // FIRST attempt — whether it early-returns (fixed) or runs the scan and adopts whatever it finds
  // (pre-fix) — completes synchronously, in the SAME tick `engineSessionIdCaptureAttempted` flips true.
  // A retry is only ever scheduled (`setTimeout`) when that first synchronous attempt finds nothing at
  // all — not the shape under test here, where a matching file (the sibling's) is already on disk. So the
  // state is already final the instant the wait above resolves; this is not a fixed-wait negative
  // assertion racing a background timer.
  check("THE FIX: engineSessionId is STILL the resume's own id — the sibling's fresher file was never adopted",
    live.engineSessionId === RESUME_ID, `live.engineSessionId=${live.engineSessionId}`);
  check("THE FIX: no onEngineSessionId event fired for this session — the scan (and its event) never ran at all, because the id was already known",
    !engineSessionIdEvents.some((e) => e.sessionId === "resume-a"),
    `events=${JSON.stringify(engineSessionIdEvents)}`);
  check("THE FIX: engineSessionIdCaptureEndReason stays null — nothing was ever attempted against the pty-alive/exhausted/died-mid-capture tri-state, because there was nothing left to capture",
    live.engineSessionIdCaptureEndReason === null, `engineSessionIdCaptureEndReason=${live.engineSessionIdCaptureEndReason}`);
}

// --- Scenario B (sanity/baseline): a resume with NO sibling in the cwd at all still resolves correctly to
// its own known id — the fix doesn't merely suppress the bug, it keeps the ordinary case working. --------
{
  const cwd = "/fake/codex/cwd-resume-alone";
  const RESUME_ID = "resumed-alone-real-id";

  host.spawn({
    sessionId: "resume-b", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    role: "worker", harness: "codex", resumeId: RESUME_ID,
  });
  const live = host.liveCodex.get("resume-b");

  check("BASELINE: a resume with no sibling present still has its engineSessionId seeded correctly",
    live.engineSessionId === RESUME_ID, `live.engineSessionId=${live.engineSessionId}`);
}

// --- Scenario C (negative control): `fork:true` (even with a `resumeId` also present) must NOT seed from
// resumeId — `isCodexResumeSpawn` is false whenever `fork` is true (buildCodexResumeArgs), and a fork is a
// genuinely fresh, independent codex session that must still discover its OWN id via the normal scan. This
// guards against an overly broad fix that seeds from `opts.resumeId` regardless of `fork`. ----------------
{
  const cwd = "/fake/codex/cwd-fork-not-seeded";
  const SOURCE_ID = "fork-source-id-must-not-be-reused";

  host.spawn({
    sessionId: "fork-c", cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    role: "worker", harness: "codex", resumeId: SOURCE_ID, fork: true,
  });
  const live = host.liveCodex.get("fork-c");

  check("NEGATIVE CONTROL: fork:true (with a resumeId also present) does NOT seed engineSessionId from the source's id — it stays null, pending its own discovery scan",
    live.engineSessionId === null, `live.engineSessionId=${live.engineSessionId}`);
  check("NEGATIVE CONTROL: fork:true still gets a real (non-null) exclusion snapshot — it is treated as a fresh spawn for exclusion purposes, unchanged by this fix",
    live.excludeEngineSessionIds !== null, `excludeEngineSessionIds=${live.excludeEngineSessionIds}`);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a codex resume seeds its engineSessionId directly from the already-known opts.resumeId, so the rediscovery scan (which has no sibling exclusion on the resume path) never runs and can never adopt a sibling session's rollout file; a resume with no sibling present still resolves correctly, and fork:true (which is never a resume) is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
