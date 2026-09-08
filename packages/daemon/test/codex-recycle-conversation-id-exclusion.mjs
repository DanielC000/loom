import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cbae4520: closes the SEQUENTIAL-reuse shape of the residual `49d43ef9` left open —
// `sessions/service.ts`'s recycleWorker spawns a codex successor into the SAME cwd as its predecessor, with
// NO --resume, and the predecessor's own rollout file is already sitting on disk when the successor's scan
// runs. If that file's mtime lands within MTIME_SKEW_TOLERANCE_MS (100ms) of the successor's own sinceMs, a
// naive mtime-only scan can adopt the PREDECESSOR's conversation id — a silent identity-adoption failure.
// This is closed BY CONSTRUCTION for that sequential shape: `pty/host.ts#spawnCodexProcess` snapshots every
// rollout session_id already on disk for the cwd BEFORE the new (non-resume) codex process is even created
// (`snapshotExistingConversationIdsForSpawn`), and that snapshot is threaded into every
// `findConversationIdForSpawn` call this pty's capture retry ladder makes as `excludeSessionIds` — a
// pre-existing predecessor's file can never be selected, regardless of its mtime relative to the tolerance
// window. ⚠️ NOT covered (see that function's own doc for why, and why it's out of scope for this test): a
// SECOND fresh spawn into the SAME cwd created AFTER this snapshot, within the ~120s capture retry window —
// a narrower, pre-existing, still-open shape this card does not close.
//
// ⛔ `codex-transcript-mtime-skew.mjs`'s own Case 6 uses a 500ms predecessor/successor gap — well OUTSIDE
// the 100ms tolerance, so it is rejected by the tolerance alone and proves nothing about the sub-100ms case
// this card is about. This test deliberately puts the predecessor's mtime INSIDE the tolerance window (and,
// for the strongest form, NEWER than the successor's own file) — the exact shape the tolerance alone cannot
// reject and only the exclusion set closes.
//
// TECHNIQUE: mirrors `codex-engine-session-id-capture.mjs`'s established pattern — a fake `createCodexPty()`
// override drives the REAL `spawnCodexProcess` onData handler with scripted chunks, no real codex process.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-recycle-conversation-id-exclusion.mjs
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

const tmpCodexHome = mkdtempManaged("loom-codex-recycle-exclusion-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
process.env.LOOM_HOME = mkdtempManaged("loom-codex-recycle-exclusion-loomhome-");

const { PtyHost } = await import("../dist/pty/host.js");
const { findConversationIdForSpawn, snapshotExistingConversationIdsForSpawn, MTIME_SKEW_TOLERANCE_MS } =
  await import("../dist/pty/codex-transcript.js");

const READY = "> Ask Codex to do anything";

function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 6160,
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
  return path.join(home, "sessions", "2026", "09", "08");
}
function writeRollout(conversationId, cwd, mtimeMs) {
  const dir = dayDirFor(tmpCodexHome);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-08T00-00-00-${conversationId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { session_id: conversationId, cwd, originator: "codex-tui" } }) + "\n");
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return file;
}

// --- Unit coverage: snapshotExistingConversationIdsForSpawn itself -------------------------------------
{
  const home = mkdtempManaged("loom-codex-recycle-exclusion-snapshot-unit-");
  process.env.CODEX_HOME = home;
  const cwd = "/fake/codex/cwd-snapshot-unit";
  const otherCwd = "/fake/codex/cwd-snapshot-unit-DIFFERENT";
  const dir = dayDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, c) => fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { session_id: id, cwd: c, originator: "codex-tui" } }) + "\n");

  check("empty sessions tree yields an empty snapshot", snapshotExistingConversationIdsForSpawn(cwd).size === 0);

  write("gen1-id", cwd);
  write("gen2-id", cwd); // a SECOND prior generation sharing the same recycled worktree cwd
  write("other-cwd-id", otherCwd);

  const snap = snapshotExistingConversationIdsForSpawn(cwd);
  check("snapshot includes EVERY prior generation's id for this cwd (not just the newest)", snap.has("gen1-id") && snap.has("gen2-id"));
  check("snapshot excludes a different cwd's id", !snap.has("other-cwd-id"));
  check("snapshot size is exactly 2 (no extras)", snap.size === 2);

  process.env.CODEX_HOME = tmpCodexHome;
}

// --- Scenario A: the sub-100ms recycle race — predecessor's mtime lands INSIDE the tolerance window, and
// (the strongest form) NEWER than the successor's own eventual file, so the pre-existing newest-mtime
// tiebreak alone would pick the WRONG one. Only construction-based exclusion closes this. ------------------
{
  const cwd = "/fake/codex/cwd-recycle-race";
  const predecessorId = "predecessor-conversation-id";
  const successorId = "successor-conversation-id";

  // The predecessor's own rollout file already exists on disk BEFORE the successor is ever spawned — this
  // is exactly recycleWorker's shape (same cwd, no --resume). Its exact mtime doesn't matter for snapshot
  // membership (the snapshot reads session_id by CONTENT, not mtime) — set below, after sinceMs is known.
  const predecessorFile = writeRollout(predecessorId, cwd, Date.now());

  const successorSessionId = "recycle-successor";
  host.spawn({ sessionId: successorSessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(successorSessionId);
  const live = host.liveCodex.get(successorSessionId);
  const sinceMs = live?.startedAt ?? null;

  check("a fresh (non-resume) codex spawn's excludeEngineSessionIds is a non-null snapshot", live?.excludeEngineSessionIds instanceof Set);
  check("the snapshot taken at spawn time already contains the pre-existing predecessor id",
    live?.excludeEngineSessionIds?.has(predecessorId) === true);

  // Now land the predecessor's LAST write inside the tolerance window, and NEWER than the successor's own
  // file (written below) — the worst case for the mtime-only tiebreak.
  const predecessorMtimeMs = sinceMs + 20; // +20ms: comfortably inside MTIME_SKEW_TOLERANCE_MS (100ms)
  const predecessorSeconds = predecessorMtimeMs / 1000;
  fs.utimesSync(predecessorFile, predecessorSeconds, predecessorSeconds);

  // RED CONTROL (prove the check can fail): a NAIVE scan with no exclusion, on this exact fixture, DOES
  // wrongly adopt the predecessor — demonstrating the vulnerability card cbae4520 describes is real, not
  // hypothetical, and that MTIME_SKEW_TOLERANCE_MS alone does not reject it.
  check("RED CONTROL: without the exclusion set, this exact fixture reproduces the identity-adoption bug",
    findConversationIdForSpawn(cwd, sinceMs) === predecessorId,
    `sinceMs=${sinceMs} predecessorMtimeMs=${predecessorMtimeMs} delta=${predecessorMtimeMs - sinceMs}ms tolerance=${MTIME_SKEW_TOLERANCE_MS}ms`);

  // GREEN, with the real exclusion set: the predecessor is invisible to the scan, and the successor's own
  // file doesn't exist yet, so nothing matches.
  check("with the real spawn-time exclusion set, the same fixture matches nothing (successor's own file doesn't exist yet)",
    findConversationIdForSpawn(cwd, sinceMs, live?.excludeEngineSessionIds) === null);

  // Now the successor's own file lands — OLDER (by mtime) than the predecessor's leftover, so the pre-
  // existing newest-mtime tiebreak would still prefer the predecessor if exclusion didn't apply.
  const successorMtimeMs = sinceMs + 10;
  writeRollout(successorId, cwd, successorMtimeMs);

  check("CONTRAST: a naive newest-mtime scan (no exclusion) still prefers the mtime-newer predecessor over the successor's own file",
    findConversationIdForSpawn(cwd, sinceMs) === predecessorId);

  // Drive the REAL host capture path — it was given the exclusion set at spawn time, before either file's
  // final mtime was known, so it must resolve to the successor regardless of relative mtime.
  fakePty.push(`codex TUI booted\n${READY}\n`);
  await waitUntil(
    () => engineSessionIdEvents.some((e) => e.sessionId === successorSessionId),
    { label: "(A) the real host capture path resolves the recycled successor's own conversation id" },
  );
  const captured = engineSessionIdEvents.find((e) => e.sessionId === successorSessionId);
  check("(A) the REAL host capture adopts the SUCCESSOR's id, never the predecessor's, despite the predecessor being mtime-newer",
    captured?.engineId === successorId,
    `captured=${JSON.stringify(captured)}`);
}

// --- Scenario B: REGRESSION GUARD — a resume spawn must NOT receive an exclusion set, and must still
// correctly re-discover its OWN pre-existing rollout file. -------------------------------------------------
{
  const cwd = "/fake/codex/cwd-resume-no-exclusion";
  const resumedId = "resumed-conversation-id";
  writeRollout(resumedId, cwd, Date.now());

  const sessionId = "resume-regression-guard";
  host.spawn({ sessionId, cwd, resumeId: resumedId, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const fakePty = host.fakeCodexPtys.get(sessionId);
  const live = host.liveCodex.get(sessionId);
  const sinceMs = live?.startedAt ?? null;

  check("(B) a RESUME spawn's excludeEngineSessionIds is null — never excludes its own pre-existing file", live?.excludeEngineSessionIds === null);

  // Land a fresh write on the resumed file (mirrors a resume session appending on wake) so the discovery
  // scan's own mtime>=sinceMs-tolerance filter is satisfied, same as production.
  const resumedFile = path.join(dayDirFor(tmpCodexHome), `rollout-2026-09-08T00-00-00-${resumedId}.jsonl`);
  const freshMs = sinceMs + 5;
  fs.utimesSync(resumedFile, freshMs / 1000, freshMs / 1000);

  fakePty.push(`codex TUI booted\n${READY}\n`);
  await waitUntil(
    () => engineSessionIdEvents.some((e) => e.sessionId === sessionId),
    { label: "(B) a resume spawn still re-discovers its own pre-existing conversation id" },
  );
  const captured = engineSessionIdEvents.find((e) => e.sessionId === sessionId);
  check("(B) the resumed session's own id is correctly captured (unaffected by the new exclusion mechanism)", captured?.engineId === resumedId);
}

// --- Scenario C: ORDERING-SENSITIVE PROOF (code review [4]) — the whole "by construction" argument rests
// on ONE statement ordering in spawnCodexProcess: the snapshot must be taken BEFORE createCodexPty creates
// the real process. Nothing in Scenarios A/B above mechanically protects that ordering — the fake
// `createCodexPty` there never writes a file, so swapping the snapshot call to AFTER it would leave every
// assertion above still green. This fake DOES write a rollout file for `opts.cwd` from inside
// `createCodexPty` itself (simulating the real codex process starting to persist ITS OWN session_meta), so
// this check goes RED the instant that statement order is ever reversed. -----------------------------------
class OrderSensitiveFakeCodexHost extends PtyHost {
  constructor(events) {
    super(events);
    this.fakeCodexPtys = new Map();
  }
  createCodexPty(opts) {
    writeRollout(`own-file-${opts.sessionId}`, opts.cwd, Date.now());
    const fake = makeFakePty();
    this.fakeCodexPtys.set(opts.sessionId, fake);
    return fake;
  }
}
{
  const orderHost = new OrderSensitiveFakeCodexHost(events);
  const cwd = "/fake/codex/cwd-ordering-proof";
  const sessionId = "ordering-proof-session";
  orderHost.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
  const live = orderHost.liveCodex.get(sessionId);
  check("(C) ORDERING PROOF: the snapshot excludes NOTHING that this spawn's own createCodexPty call itself " +
    "wrote — proves the snapshot is genuinely taken BEFORE the process exists, not after (would go RED the " +
    "instant that statement order were swapped)",
    live?.excludeEngineSessionIds?.has(`own-file-${sessionId}`) !== true);
}

await finishAndExit(failures === 0 ? 0 : 1);
