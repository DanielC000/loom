// Engine-session-id ROTATION test (card 7c1fc117) — HERMETIC, no daemon, no real claude.
//
// Root cause this locks in (confirmed against a REAL production incident, not a theory): a manager
// ran for hours; `readContextStats` faithfully read its tracked engine transcript the whole time, but
// that transcript had gone silently abandoned mid-session — the CLAUDE ENGINE ITSELF fired a SECOND
// `SessionStart` hook, reporting a DIFFERENT session_id, for the SAME live pty process (no new Loom
// spawn, no resume, no fork — most likely an internal auto-compact). The OLD guard in pty/host.ts's
// SessionStart handler (`!live.engineSessionId`, capture-once) silently discarded that second hook, so
// `live.engineSessionId` stayed pinned at the first (now-abandoned) id FOREVER — every later Stop kept
// reading a transcript the engine had stopped writing to, freezing the persisted `ctxInputTokens` (the
// ContextWatcher recycle-nudge's only input) while the REAL conversation kept growing, untracked, in a
// file Loom never knew existed.
//
// This drives the REAL PtyHost state machine (fake pty via the createPty() seam) through exactly that
// sequence — SessionStart(engine-1) → Stop → SessionStart(engine-2), no new spawn → Stop — wires
// onContextStats into a REAL Db (mirroring index.ts's own wiring), and asserts the FULL pipeline:
// rotation is tracked → readContextStats follows the ACTIVE file → ContextWatcher fires the nudge once
// the (correctly-measured) context crosses the ratio. Also proves the events.onEngineSessionId callback
// (which persists engine_session_id) fires again on rotation, and that the rotation is logged
// fail-visibly, not silently.
//
// RUN: 1) build daemon (pnpm --filter @loom/daemon build), 2) node test/engine-session-rotation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (host.ts opens a per-session log under $LOOM_HOME/logs in spawn()). Set BEFORE any
// dynamic import of a dist/ module.
const tmpHome = path.join(os.tmpdir(), `loom-rotate-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { Db } = await import("../dist/db.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  const fake = {
    pid: 4242, write: (d) => writes.push(d),
    onData: (cb) => { dataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {}, writes,
    feed: (s) => { if (dataCb) dataCb(s); },
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }

// --- Db wiring: mirrors index.ts's real onEngineSessionId/onContextStats event → db.* wiring.
const dbFile = path.join(tmpHome, "test.db");
const db = new Db(dbFile);
const projId = "proj-rotate";
const agentId = "agent-rotate";
const SID = "mgr-rotate";
const now = new Date().toISOString();
// ratio 0.5 (explicit, not the platform default) so the crossing point is a round, easy-to-read number.
db.insertProject({ id: projId, name: "Rotate", repoPath: projId, vaultPath: projId, config: { orchestration: { recycleAtContextRatio: 0.5 } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "mgr", startupPrompt: "orchestrate", position: 0 });
db.insertSession({
  id: SID, projectId: projId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "resumable", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
  ctxInputTokens: null, ctxTurns: null, model: null,
});

const engineIdEvents = [];
const warnLog = [];
const realWarn = console.warn;
console.warn = (...args) => { warnLog.push(args.join(" ")); realWarn(...args); };

const events = {
  onEngineSessionId(id, engineId) { engineIdEvents.push({ id, engineId }); db.setEngineSessionId(id, engineId); },
  onBusy() {}, onRateLimited() {}, onExit() {},
  onContextStats(id, s) { db.setContextCounters(id, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns, model: s.model }); },
};
const host = new TestPtyHost(events);
const watcher = new ContextWatcher({ db, pty: { isAlive: (id) => host.isAlive(id), enqueueStdin: (id, t) => host.enqueueStdin(id, t) }, ratio: 0 });

const ENGINE_1 = "engine-session-alpha";
const ENGINE_2 = "engine-session-beta"; // the rotated (untracked-until-fixed) id

const writeTranscript = (engineId, lines) => {
  const file = engineTranscriptPath(tmpHome, engineId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};

try {
  host.spawn({
    sessionId: SID, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });

  // === 1) Fresh spawn: first SessionStart captures engine-1 silently (no rotation warning). ===
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_1 });
  check("1: first capture recorded engine-1", engineIdEvents.length === 1 && engineIdEvents[0].engineId === ENGINE_1);
  check("1: first capture logs NO rotation warning", !warnLog.some((w) => w.includes("ROTATED")));

  writeTranscript(ENGINE_1, [
    { type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 1000 } } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop", session_id: ENGINE_1 });
  check("2: ctxInputTokens tracks engine-1's transcript (1000)", db.getSession(SID)?.ctxInputTokens === 1000);

  watcher.tick();
  check("3: below the 0.5 ratio (1000/200000) → NOT nudged yet", db.getContextNudgeState(SID)?.lastContextNudgeAt == null);

  // === 4) ROTATION: a SECOND SessionStart, a DIFFERENT session_id, NO new host.spawn() call. This is
  // the exact sequence the real incident's daemon log showed (SessionStart mid-turn, no intervening
  // [pty] spawn) — simulating the engine's own internal restart (e.g. auto-compact). ===
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_2 });
  check("4: rotation captured — a SECOND onEngineSessionId event, now engine-2",
    engineIdEvents.length === 2 && engineIdEvents[1].engineId === ENGINE_2);
  check("4: the tracked engine_session_id in the DB actually moved to engine-2",
    db.getSession(SID)?.engineSessionId === ENGINE_2);
  check("4: the rotation is FAIL-VISIBLE — a warning names both ids and the session",
    warnLog.some((w) => w.includes("ROTATED") && w.includes(SID) && w.includes(ENGINE_1) && w.includes(ENGINE_2)));

  // The REAL context had been growing in engine-2's transcript the whole time (per the incident: the
  // engine kept running, context kept growing, but Loom was blind to it). Simulate that: engine-2's
  // transcript crosses the 0.5 ratio (100,000 of 200,000).
  writeTranscript(ENGINE_2, [
    { type: "assistant", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 10, cache_read_input_tokens: 150_000 } } },
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop", session_id: ENGINE_2 });
  check("5: post-rotation Stop reads engine-2's (correct, ROTATED-TO) transcript, not the abandoned engine-1 one",
    db.getSession(SID)?.ctxInputTokens === 150_010);

  // === 6) DoD: the recycle nudge fires once the TRUE (post-rotation) context crosses the ratio. ===
  watcher.tick();
  check("6: crossing the ratio via the ROTATED file's measurement fires the recycle nudge",
    db.getContextNudgeState(SID)?.lastContextNudgeAt != null);

  // === 7) A repeat report of the SAME (already-tracked) id stays a no-op — no spurious rotation. ===
  const warnCountBefore = warnLog.length;
  const eventsCountBefore = engineIdEvents.length;
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_2 });
  check("7: a repeat SessionStart with the SAME id is a no-op (no new event, no warning)",
    engineIdEvents.length === eventsCountBefore && warnLog.length === warnCountBefore);

  // === 8) The null-branch fail-visible logging DISTINGUISHES its two causes (both used to be silent). ===
  const ENGINE_3 = "engine-session-gamma";
  host.deliverHook(SID, { hook_event_name: "SessionStart", session_id: ENGINE_3 }); // rotate again, no transcript written yet
  const ctxBefore8 = db.getSession(SID)?.ctxInputTokens;
  host.deliverHook(SID, { hook_event_name: "Stop", session_id: ENGINE_3 }); // no engine-3 transcript on disk at all
  check("8a: file-not-found is named distinctly", warnLog.some((w) => w.includes("context-stats read failed (file-not-found") && w.includes(ENGINE_3)));
  check("8a: ctxInputTokens stays frozen at the last good value (not clobbered to null/0)", db.getSession(SID)?.ctxInputTokens === ctxBefore8);

  writeTranscript(ENGINE_3, [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { content: [{ type: "text", text: "no usage on this line" }] } }, // exists, but no `usage`
  ]);
  host.deliverHook(SID, { hook_event_name: "Stop", session_id: ENGINE_3 });
  check("8b: found-but-no-usage-line is named distinctly (a DIFFERENT reason than 8a)",
    warnLog.some((w) => w.includes("context-stats read failed (found-but-no-usage-line") && w.includes(ENGINE_3)));
  check("8b: ctxInputTokens still frozen (this transcript never gained a usage-bearing line)", db.getSession(SID)?.ctxInputTokens === ctxBefore8);
} finally {
  console.warn = realWarn;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  // Also clean up the transcript fixtures written under the REAL ~/.claude/projects (engineTranscriptPath
  // resolves there, not under tmpHome — mirrors context-stats.mjs's / paste-placeholder-tripwire.mjs's
  // own cleanup of the same real-home fixture pattern).
  try {
    const dir = path.dirname(engineTranscriptPath(tmpHome, ENGINE_1));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a mid-session engine-session-id rotation is tracked (not silently discarded), the DB " +
    "persists it, context-stats follow the ACTUAL active transcript, and the recycle nudge fires on the " +
    "TRUE crossed ratio."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
