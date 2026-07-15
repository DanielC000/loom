import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion CONVERSATION-PRESERVING RESPAWN (Companion Capability & Permission-Lever Framework §6):
// SessionService.upgradeCompanionCapabilities re-resolves the agent's CURRENT profile-driven capability
// surface via resolveAgentSpawn, re-pins it on the session ROW, gracefully stops the OLD pty, then
// `resume()`s with the SAME engineSessionId — so a newly-granted tool-bearing lever reaches an
// already-running companion without losing its conversation thread. Fully hermetic, like
// respawn-profile-attrs.mjs: isolated LOOM_HOME + a sandboxed HOME (resume()'s transcript check never
// touches the real ~/.claude), a REAL Db + SessionService driven against a FAKE pty via PtyHost's
// createPty() seam — no real claude, no daemon, no network. The fake pty's graceful-stop escalation timers
// are sped up via the LOOM_GRACEFUL_*_MS env overrides (read once at pty/host.js import time) so the test
// doesn't wait out the real ~6s hard-kill bound.
//
// Proves:
//   1. The NEW tool surface is present post-upgrade: the re-resolved capabilities/browserTesting/
//      documentConversion/restrictedTools/skills/connections land on BOTH the session row and the
//      freshly-captured pty.spawn() opts — and capabilityToolAllowlist (the real, pure allow-list builder)
//      shows a brand-new capability's tool name present after upgrade, absent before.
//   2. The engine session id (conversation) is PRESERVED: the post-upgrade spawn is a `--resume
//      <engineSessionId>` (opts.resumeId === the ORIGINAL engineSessionId, unchanged in the DB), never a
//      fresh/fork spawn.
//   3. The OLD OS process is actually stopped (graceful, escalating to hard) before the new one spawns —
//      never two ptys alive for the same session id at once.
//   4. Guardrails: unknown session, non-assistant role, and no-engine-id (never spawned) are all refused
//      with a clear error and no pin/spawn side effects.
//
// Run: 1) build (turbo builds shared first), 2) node test/companion-live-upgrade.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-upgrade-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Speed up the graceful-stop escalation (read once at pty/host.js import time) so the wait-for-dead poll
// in upgradeCompanionCapabilities resolves in well under a second instead of the real ~6s hard-kill bound.
// KILL_MS is deliberately kept ABOVE the poll loop's own 100ms tick (not squeezed down to it) — the
// mid-gap message-preservation check below needs at least one 100ms `drain()` poll to land BEFORE the
// fake pty actually dies (which wipes its pending FIFO), so it can observe the fix's real mechanism
// instead of the message being wiped before any poll had a chance to capture it.
process.env.LOOM_GRACEFUL_GAP_MS = "50";
process.env.LOOM_GRACEFUL_RETRY_MS = "150";
process.env.LOOM_GRACEFUL_KILL_MS = "300";

const { Db } = await import("../dist/db.js");
const { PtyHost, capabilityToolAllowlist } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

// Fake pty seam (mirrors respawn-profile-attrs.mjs's SeamHost): captures every SpawnOpts and wires kill()
// to fire the REAL onExit callback the base PtyHost.spawn() registers — so the base class's OWN `live` map
// (and therefore its REAL isAlive()) tracks alive/dead exactly like a real pty would, letting this test
// exercise the actual graceful-stop-then-wait loop rather than bypassing it.
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    this.capture.push(opts);
    let exitCb = null;
    return {
      pid: 4242 + this.capture.length,
      write() {}, // graceful stop's Ctrl-C writes are no-ops here — the escalation timers drive the exit
      onData() { return { dispose() {} }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { if (exitCb) exitCb({ exitCode: 0 }); },
      resize() {},
    };
  }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const now = new Date().toISOString();
const cwd = path.join(tmpHome, "companion-cwd");
fs.mkdirSync(cwd, { recursive: true });

const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const projId = randomUUID();
db.insertProject({ id: projId, name: "Companion Upgrade", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });

// The BEFORE profile: no registry-capability grants, browser-testing off.
const profileId = randomUUID();
db.insertProfile({
  id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
});
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });

const sessionId = randomUUID();
const engineId = "eng-companion-conversation-1";
db.insertSession({
  id: sessionId, projectId: projId, agentId, engineSessionId: engineId, title: null, cwd,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
  noCommit: false, skills: null, connections: [], capabilities: [],
});
// The engine transcript must exist for resume() to proceed (its dead-ID + cwd-missing backstops).
const tpath = engineTranscriptPath(cwd, engineId);
fs.mkdirSync(path.dirname(tpath), { recursive: true });
fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hello, companion" } }) + "\n");

// A pre-existing capability catalog def used only to exercise capabilityToolAllowlist (pure, no filesystem
// probing — unlike buildMcpServers' browser-testing/document-conversion branches, which resolve real
// packages and would be environment-dependent).
const FAKE_CATALOG = [{
  id: "def-acme", slug: "acme-tool", name: "Acme", description: "", transport: "stdio", kind: "command",
  provisionJson: JSON.stringify({ kind: "command", command: "acme", args: [] }),
  toolAllowlistJson: JSON.stringify(["mcp__acme__do_thing"]),
  wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, createdAt: now,
}];

try {
  // ===================== spawn the companion fresh, so it's "live" under the OLD (empty) capability surface =====================
  db.setProcessState(sessionId, "starting"); // resume()'s isAlive short-circuit needs the pty to actually be live
  host.spawn({
    sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
    resumeId: engineId, role: "assistant", browserTesting: false, documentConversion: false,
    capabilities: [], restrictedTools: false, skills: null,
  });
  check("setup: the companion pty is alive before upgrade", host.isAlive(sessionId));
  const preCapture = host.capture.at(-1);
  check("setup: the PRE-upgrade spawn carries NO registry capabilities", (preCapture?.capabilities ?? []).length === 0);
  const preAllowlist = capabilityToolAllowlist(preCapture?.capabilities ?? [], FAKE_CATALOG);
  check("(1) PRE-upgrade: the new capability's tool is NOT yet in the allow-list", !preAllowlist.includes("mcp__acme__do_thing"));

  // ===================== simulate the owner granting new capabilities via a Profile edit =====================
  db.updateProfile(profileId, { browserTesting: true, restrictedTools: true, capabilities: [{ slug: "acme-tool" }] });

  // ===================== the live upgrade =====================
  host.capture.length = 0;
  const upgraded = await svc.upgradeCompanionCapabilities(sessionId);

  // ---- (3) the OLD process was actually stopped before the new one spawned ----
  check("(3) exactly ONE fresh spawn happened (old pty was stopped first, not left running alongside a 2nd)", host.capture.length === 1);

  // ---- (1) the NEW tool surface is present post-upgrade — on the ROW ----
  const row = db.getSession(sessionId);
  check("(1) row: browserTesting re-pinned true", row.browserTesting === true);
  check("(1) row: restrictedTools re-pinned true", row.restrictedTools === true);
  check("(1) row: capabilities re-pinned to the new grant", JSON.stringify(row.capabilities) === JSON.stringify([{ slug: "acme-tool" }]));

  // ---- (1) the NEW tool surface is present post-upgrade — on the freshly-captured spawn opts ----
  const postCapture = host.capture.at(-1);
  check("(1) spawn opts: browserTesting true reaches the fresh pty.spawn call", postCapture?.browserTesting === true);
  check("(1) spawn opts: restrictedTools true reaches the fresh pty.spawn call", postCapture?.restrictedTools === true);
  check("(1) spawn opts: the new capability reaches the fresh pty.spawn call", JSON.stringify(postCapture?.capabilities) === JSON.stringify([{ slug: "acme-tool" }]));
  const postAllowlist = capabilityToolAllowlist(postCapture?.capabilities ?? [], FAKE_CATALOG);
  check("(1) POST-upgrade: the new capability's tool IS now in the allow-list (was absent pre-upgrade)", postAllowlist.includes("mcp__acme__do_thing"));

  // ---- (2) the conversation (engine session id) is PRESERVED across the respawn ----
  check("(2) the fresh spawn is a --resume of the ORIGINAL engine session id (never a fresh/fork spawn)", postCapture?.resumeId === engineId);
  check("(2) the DB row's engineSessionId is unchanged", db.getSession(sessionId).engineSessionId === engineId);
  check("(2) upgradeCompanionCapabilities' own return value carries the SAME engineSessionId", upgraded.engineSessionId === engineId);
  check("(2) the returned session is live again", upgraded.processState === "live");

  // ---- the companion is alive again after the upgrade ----
  check("post-upgrade: the companion pty is alive again", host.isAlive(sessionId));

  // ===================== AVAILABILITY-GAP message preservation (CR fix) =====================
  // A chat message that lands while the OLD pty is "stopping" (Ctrl-C sent, escalation timers running,
  // but not yet exited) is HELD in its in-memory FIFO, not treated as "session dead" — so it must be
  // captured (flushPending) and redelivered onto the fresh pty, or the old process's own exit (which
  // unconditionally wipes that FIFO) would silently lose it. `upgradeCompanionCapabilities` runs
  // synchronously through its guards/DB-writes/pty.stop() call before its first `await` (inside the poll
  // loop) — so by the time this synchronous call below returns, pty.stop("graceful") has DEFINITELY
  // already run and `live.stopping` is already true, making this deterministic rather than a timing race.
  {
    const upgradePromise = svc.upgradeCompanionCapabilities(sessionId);
    const midGap = host.enqueueStdin(sessionId, "URGENT: hi during the gap", "system", undefined, undefined, "agent");
    check("mid-gap: the inbound message is HELD (not treated as session-dead) while the old pty is stopping", midGap.delivered === false && midGap.reason === "held");
    // CR follow-up carried into card a8ddd6d2 (decision_resolve, the first `attest`/ownerText consumer):
    // an owner-attested message (Companion injection-guard Primitive A) queued during the gap must keep
    // its `ownerText` across this SAME carry-forward, or a decision_resolve confirm surviving a capability-
    // upgrade respawn would silently lose its attestation and refuse a legitimate owner confirm.
    const ownerGap = host.enqueueStdin(sessionId, "CONFIRM ABC123", "human", undefined, undefined, "agent", undefined, "CONFIRM ABC123");
    check("mid-gap: the owner-attested message is also HELD", ownerGap.delivered === false && ownerGap.reason === "held");
    await upgradePromise;
    check("mid-gap: the message was captured and redelivered onto the FRESH pty (not lost to the old pty's FIFO wipe on exit)", host.getPending(sessionId).includes("URGENT: hi during the gap"));
    check("mid-gap: the owner-attested message was also redelivered", host.getPending(sessionId).includes("CONFIRM ABC123"));
    // flushPending exposes the FULL QueuedMessage (incl. ownerText) — getPending/getPendingEntries both
    // strip it, so this is the one public seam that can prove the field actually survived the carry.
    const freshPending = host.flushPending(sessionId);
    const preserved = freshPending.find((m) => m.text === "CONFIRM ABC123");
    const plain = freshPending.find((m) => m.text === "URGENT: hi during the gap");
    check("(CR follow-up) ownerText SURVIVES the capability-upgrade carry-forward (was silently dropped before this fix)", preserved?.ownerText === "CONFIRM ABC123");
    check("(CR follow-up, refuse-path) a message with no ownerText still carries none through the SAME carry-forward — the fix doesn't fabricate attestation", plain !== undefined && plain.ownerText === undefined);
  }

  // ===================== SELF-HEAL RACE (CR fix): the wait loop must LATCH death, never re-read =====================
  // A self-heal auto-resume (companion/revive.ts's withCompanionSelfHeal) runs OUTSIDE this controller's
  // serialization and can respawn a fresh pty for this session the INSTANT the old one dies. If the wait
  // loop re-derives "still alive?" from a fresh isAlive() call after that point, it wrongly concludes the
  // OLD process needs a hard stop — killing the self-healed one instead. This is tested with a SCRIPTED
  // fake pty (not the real PtyHost) that returns `false` from isAlive() EXACTLY ONCE (simulating the loop
  // observing the original pty's death) and `true` on every OTHER call (simulating a self-healed pty being
  // alive both before AND immediately after) — deterministic, no real timing race needed. If the code
  // correctly LATCHES the one `false` observation, it must: (a) never call pty.stop(sessionId, "hard") —
  // the fresh (self-healed) pty is never killed, and (b) never call pty.spawn again — resume()'s OWN
  // isAlive short-circuit sees the self-healed pty already alive and no-ops, so there is no THIRD respawn.
  {
    const scriptDb = new Db();
    const scriptProjId = randomUUID();
    scriptDb.insertProject({ id: scriptProjId, name: "Race", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
    const scriptAgentId = randomUUID();
    scriptDb.insertAgent({ id: scriptAgentId, projectId: scriptProjId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
    const scriptSessionId = randomUUID();
    const scriptEngineId = "eng-race-conversation";
    scriptDb.insertSession({
      id: scriptSessionId, projectId: scriptProjId, agentId: scriptAgentId, engineSessionId: scriptEngineId, title: null, cwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
      noCommit: false, skills: null, connections: [], capabilities: [],
    });
    const raceTpath = engineTranscriptPath(cwd, scriptEngineId);
    fs.mkdirSync(path.dirname(raceTpath), { recursive: true });
    fs.writeFileSync(raceTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    let aliveCalls = 0;
    const stopModes = [];
    const spawns = [];
    const scriptedPty = {
      isAlive() {
        aliveCalls++;
        // Call 1: the OUTER "is there anything to stop?" guard — still alive.
        // Call 2: the wait loop's FIRST check — the original pty JUST died. Latch this.
        // Call 3+: resume()'s own short-circuit (and anything after) — a self-heal already respawned it.
        return aliveCalls !== 2;
      },
      stop(_sid, mode) { stopModes.push(mode); },
      spawn(opts) { spawns.push(opts); },
      enqueueStdin() { return { delivered: false, position: 0 }; },
      flushPending() { return []; },
      getPending() { return []; },
    };
    const scriptSvc = new SessionService(scriptDb, scriptedPty, new OrchestrationControl());
    const raceResult = await scriptSvc.upgradeCompanionCapabilities(scriptSessionId);

    check("race: never issues a hard stop against the (self-healed) fresh pty", !stopModes.includes("hard"));
    check("race: issues exactly the one graceful stop, nothing more", JSON.stringify(stopModes) === JSON.stringify(["graceful"]));
    check("race: resume()'s own isAlive short-circuit no-ops — no THIRD respawn (pty.spawn never called)", spawns.length === 0);
    check("race: the upgrade still reports success (whichever resume won, identical outcome)", raceResult.id === scriptSessionId && raceResult.engineSessionId === scriptEngineId);
    scriptDb.close();
  }

  // ===================== guardrails =====================
  {
    let threw = null;
    try { await svc.upgradeCompanionCapabilities(randomUUID()); } catch (e) { threw = e; }
    check("guard: an unknown session id throws", threw instanceof Error);
  }
  {
    const workerAgentId = randomUUID();
    db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "", position: 1, profileId: null, endpoint: false, ioSchema: null });
    const workerSessId = randomUUID();
    db.insertSession({
      id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
    });
    let threw = null;
    try { await svc.upgradeCompanionCapabilities(workerSessId); } catch (e) { threw = e; }
    check("guard: a non-assistant (worker) session throws, never silently upgraded", threw instanceof Error);
    check("guard: the refused worker session's row is untouched", db.getSession(workerSessId).capabilities.length === 0);
  }
  {
    const neverSpawnedAgentId = randomUUID();
    db.insertAgent({ id: neverSpawnedAgentId, projectId: projId, name: "Fresh Companion", startupPrompt: "", position: 2, profileId, endpoint: false, ioSchema: null });
    const neverSpawnedId = randomUUID();
    db.insertSession({
      id: neverSpawnedId, projectId: projId, agentId: neverSpawnedAgentId, engineSessionId: null, title: null, cwd,
      processState: "starting", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
    });
    let threw = null;
    try { await svc.upgradeCompanionCapabilities(neverSpawnedId); } catch (e) { threw = e; }
    check("guard: a companion with no engineSessionId (never completed a fresh spawn) throws", threw instanceof Error);
  }
} finally {
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — upgradeCompanionCapabilities re-resolves + re-pins the capability surface, stops the old pty, and resumes with the SAME engine session id — the new tool allow-list is present post-upgrade and absent pre-upgrade; guardrails refuse an unknown/non-assistant/never-spawned session — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
