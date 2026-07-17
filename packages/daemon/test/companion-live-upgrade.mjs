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
//      documentConversion/restrictedTools/skills land on BOTH the session row and the freshly-captured
//      pty.spawn() opts — and capabilityToolAllowlist (the real, pure allow-list builder) shows a
//      brand-new capability's tool name present after upgrade, absent before.
//   1b. connections/vaultWrite (card 1a048349) are the ROW-ONLY exception — mcp/server.ts's TaskMcpRouter
//      reads them LIVE off the session row on every request, never threading either through pty.spawn, so
//      a row write alone (no respawn needed) is what a live upgrade must produce. Verified in BOTH
//      directions AT THE ENFORCEMENT SITE, not just the DB column: a real tools/list round-trip through
//      the (stateless, rebuilt-per-request) TaskMcpRouter — GRANT (Profile adds a connection/vaultWrite →
//      authenticated_request/vault_write go from OMITTED to PRESENT in tools/list) and REVOKE (Profile
//      removes them → both go from PRESENT back to OMITTED) — the security-relevant direction, proving a
//      revoked exfil-class grant is UNREACHABLE on the companion's very next tool call, no residual window.
//   2. The engine session id (conversation) is PRESERVED: the post-upgrade spawn is a `--resume
//      <engineSessionId>` (opts.resumeId === the ORIGINAL engineSessionId, unchanged in the DB), never a
//      fresh/fork spawn.
//   3. The OLD OS process is actually stopped (graceful, escalating to hard) before the new one spawns —
//      never two ptys alive for the same session id at once.
//   4. Guardrails: unknown session, non-assistant role, and no-engine-id (never spawned) are all refused
//      with a clear error and no pin/spawn side effects.
//   5. IN-FLIGHT-TURN PRESERVATION (card d88163b7): a BUSY companion turn gets a short bounded wait to go
//      idle before the interrupt lands — idle proceeds with zero added delay, a turn that clears within
//      the bound is never interrupted, and a turn that stays busy past the bound (a genuinely long turn,
//      or a stale busy stuck true) still proceeds — bounded, never a permanent refusal.
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
// Shrink the busy-turn preservation wait (card d88163b7 — read once at sessions/service.js import time) so
// the busy-clears/stale-busy checks below resolve in well under a second instead of the real 3s bound.
process.env.LOOM_UPGRADE_BUSY_WAIT_MS = "300";

const { Db } = await import("../dist/db.js");
const { PtyHost, capabilityToolAllowlist } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

// TaskMcpRouter is STATELESS — a fresh McpServer is built per request, re-reading the session row fresh
// each time (mcp/server.ts's own class doc). This helper drives a REAL tools/list round-trip through it
// (mirrors authenticated-request.mjs Part 2), so the connections/vaultWrite checks below prove the fix at
// the ACTUAL enforcement site (does the tool disappear from tools/list on the very next call after a
// revoke?), not merely that a DB column changed underneath it.
const throwFetch = async () => { throw new Error("unexpected real fetch in a tools/list-only test"); };
const listToolsFor = async (sessionId) => {
  const router = new TaskMcpRouter(db, {}, throwFetch);
  const projectId = router.resolveProject(sessionId);
  const server = router.buildServer(projectId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-upgrade-test", version: "0" });
  await client.connect(clientT);
  const tools = (await client.listTools()).tools;
  await client.close();
  return tools.map((t) => t.name);
};

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
  // (This still holds after card d88163b7's busy-wait: the fresh pty resumed above is idle — `live.busy`
  // is false, per PtyHost.spawn's own initial Live shape — so that wait's isBusy-gated loop condition is
  // false on its FIRST check and its own `await` never runs; the busy-wait/stale-busy behavior itself is
  // covered separately below with a scripted pty that controls `isBusy` directly.)
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
      // Not-busy ⇒ the card-d88163b7 pre-stop wait (isBusy-gated) below never runs, so it adds no extra
      // isAlive() calls here — the Call-1/2/3+ counting above is unaffected by that fix.
      isBusy() { return false; },
      holdDrain() {}, releaseDrain() {}, // the CR-fix drain-hold seam — no-ops on this scripted double
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

  // ===================== IN-FLIGHT-TURN PRESERVATION (card d88163b7) =====================
  // Before this fix, a BUSY companion (mid-turn — possibly with an in-flight `chat_reply` MCP call) was
  // ALWAYS force-interrupted the instant an upgrade ran, discarding that turn with no recovery. The fix
  // gives a busy session a short bounded wait (LOOM_UPGRADE_BUSY_WAIT_MS, shrunk to 300ms above) to go
  // idle on its own BEFORE `pty.stop` is ever called. Both branches use a SCRIPTED pty (not the real
  // PtyHost) so `isBusy` is driven deterministically rather than depending on real turn timing.
  const makeBusySession = (label, rowBusy) => {
    const bDb = new Db();
    const bProjId = randomUUID();
    bDb.insertProject({ id: bProjId, name: `Busy ${label}`, repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
    const bAgentId = randomUUID();
    bDb.insertAgent({ id: bAgentId, projectId: bProjId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
    const bSessionId = randomUUID();
    const bEngineId = `eng-busy-${label}`;
    bDb.insertSession({
      id: bSessionId, projectId: bProjId, agentId: bAgentId, engineSessionId: bEngineId, title: null, cwd,
      processState: "live", resumability: "resumable", busy: rowBusy, createdAt: now, lastActivity: now, lastError: null,
      role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
      noCommit: false, skills: null, connections: [], capabilities: [],
    });
    const bTpath = engineTranscriptPath(cwd, bEngineId);
    fs.mkdirSync(path.dirname(bTpath), { recursive: true });
    fs.writeFileSync(bTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
    return { bDb, bSessionId };
  };

  // ---- (0) IDLE: the upgrade proceeds immediately, with NO added wait ----
  {
    const { bDb, bSessionId } = makeBusySession("idle", false);
    const callLog = [];
    let busyPolls = 0;
    let stopped = false;
    const idlePty = {
      isAlive() { return !stopped; },
      isBusy() { busyPolls++; callLog.push("isBusy"); return false; }, // idle from the very first check
      holdDrain() { callLog.push("holdDrain"); }, releaseDrain() { callLog.push("releaseDrain"); },
      stop(_sid, mode) { callLog.push(`stop:${mode}`); stopped = true; },
      spawn() { callLog.push("spawn"); stopped = false; },
      enqueueStdin() { return { delivered: false, position: 0 }; },
      flushPending() { return []; },
      getPending() { return []; },
    };
    const bSvc = new SessionService(bDb, idlePty, new OrchestrationControl());
    const result = await bSvc.upgradeCompanionCapabilities(bSessionId);

    check("idle: isBusy was checked exactly once — the wait loop's condition short-circuits, no polling delay added", busyPolls === 1);
    check("idle: pty.stop was called immediately (idle ⇒ the clean, no-interrupt stop path)", callLog.indexOf("stop:graceful") === 2);
    check("idle: holdDrain was called BEFORE isBusy was ever checked (the hold covers the wait from its very first check)", callLog.indexOf("holdDrain") === 0);
    check("idle: releaseDrain was called (the hold is always lifted)", callLog.includes("releaseDrain"));
    check("idle: the upgrade completes successfully", result.id === bSessionId && result.engineSessionId === "eng-busy-idle");
    bDb.close();
  }

  // ---- (A) busy CLEARS within the bound: the interrupt never lands on a live turn ----
  {
    const { bDb, bSessionId } = makeBusySession("clears", true);
    const callLog = [];
    let busyPolls = 0;
    let stopped = false;
    const busyClearsPty = {
      isAlive() { return !stopped; },
      isBusy() { busyPolls++; callLog.push("isBusy"); return busyPolls < 2; }, // busy on poll 1, idle from poll 2
      holdDrain() { callLog.push("holdDrain"); }, releaseDrain() { callLog.push("releaseDrain"); },
      stop(_sid, mode) { callLog.push(`stop:${mode}`); stopped = true; },
      spawn() { callLog.push("spawn"); stopped = false; },
      enqueueStdin() { return { delivered: false, position: 0 }; },
      flushPending() { return []; },
      getPending() { return []; },
    };
    const bSvc = new SessionService(bDb, busyClearsPty, new OrchestrationControl());
    await bSvc.upgradeCompanionCapabilities(bSessionId);

    check("busy-clears: holdDrain was called BEFORE the wait started (the hold covers the whole wait, not just part of it)", callLog.indexOf("holdDrain") === 0 && callLog.indexOf("holdDrain") < callLog.indexOf("isBusy"));
    check("busy-clears: isBusy was polled MORE than once (the wait loop actually waited, not skipped)", busyPolls >= 2);
    check("busy-clears: isBusy was polled EXACTLY twice — it stopped polling the instant busy cleared, not the full bound", busyPolls === 2);
    check("busy-clears: pty.stop was still called (the upgrade always proceeds once idle)", callLog.includes("stop:graceful"));
    check("busy-clears: EVERY isBusy poll ran BEFORE stop — the interrupt never landed while isBusy was still returning true", callLog.indexOf("stop:graceful") === busyPolls + 1);
    check("busy-clears: only a graceful stop, never a hard one (no interrupted turn to escalate against)", !callLog.includes("stop:hard"));
    check("busy-clears: releaseDrain was called AFTER stop (the hold spans the full stop sequence)", callLog.indexOf("releaseDrain") > callLog.indexOf("stop:graceful"));
    bDb.close();
  }

  // ---- (B) busy NEVER clears (a genuinely long turn, or a STALE busy only the multi-minute self-heal
  //      watchdog would otherwise clear): the wait is BOUNDED — it still proceeds, never a permanent
  //      refusal, and never blocks the REST caller longer than LOOM_UPGRADE_BUSY_WAIT_MS ----
  {
    const { bDb, bSessionId } = makeBusySession("stale", true);
    const callLog = [];
    let busyPolls = 0;
    let stopped = false;
    const staleBusyPty = {
      isAlive() { return !stopped; },
      isBusy() { busyPolls++; callLog.push("isBusy"); return true; }, // never clears
      holdDrain() { callLog.push("holdDrain"); }, releaseDrain() { callLog.push("releaseDrain"); },
      stop(_sid, mode) { callLog.push(`stop:${mode}`); stopped = true; },
      spawn() { callLog.push("spawn"); stopped = false; },
      enqueueStdin() { return { delivered: false, position: 0 }; },
      flushPending() { return []; },
      getPending() { return []; },
    };
    const bSvc = new SessionService(bDb, staleBusyPty, new OrchestrationControl());
    const t0 = performance.now();
    const result = await bSvc.upgradeCompanionCapabilities(bSessionId);
    const elapsedMs = performance.now() - t0;

    // The production wait is bounded on a MONOTONIC clock (performance.now()), not an iteration count —
    // so the poll count is real-timing-dependent (setTimeout jitter under load) and asserting an EXACT
    // count here would be its own flake risk. Assert boundedness the same way: real elapsed wall time, with
    // a generous margin above LOOM_UPGRADE_BUSY_WAIT_MS (300ms) that would only trip if the wait were
    // genuinely open-ended (it stops "3 polls" from being provable — the loop still visibly iterates,
    // which busyPolls >= 2 below proves).
    check("stale-busy: isBusy was polled MORE than once (the wait loop actually iterated, not skipped)", busyPolls >= 2);
    check("stale-busy: the wait is BOUNDED — total elapsed stays within a generous margin above LOOM_UPGRADE_BUSY_WAIT_MS, never open-ended", elapsedMs < 300 + 2000);
    check("stale-busy: pty.stop was STILL called despite busy never clearing — never a permanent refusal", callLog.includes("stop:graceful"));
    check("stale-busy: the upgrade still completes successfully (degrades to today's forced-interrupt behavior, never worse)", result.id === bSessionId && result.engineSessionId === `eng-busy-stale`);
    check("stale-busy: releaseDrain was called even though the wait ran the full bound (the hold is never left dangling)", callLog.includes("releaseDrain"));
    bDb.close();
  }

  // ===================== CR-CAUGHT REGRESSION: a QUEUED message must survive its busy turn ending
  // MID-WAIT (card d88163b7 follow-up) =====================
  // The scripted-pty tests above prove the wait LOOP behaves correctly; they can't prove a message
  // actually SURVIVES, because their `flushPending`/`getPending` are hardcoded stubs decoupled from
  // `isBusy`/`stop` — the exact drainPending/enqueueStdin interaction where the bug lived is never
  // exercised. This block drives the REAL PtyHost (via SeamHost, not a scripted double) so that real
  // interaction runs for real.
  //
  // Scenario: the companion is BUSY (a turn in flight) AND a second chat message is sitting QUEUED in
  // `live.pending` behind it. The busy turn's Stop hook fires WHILE the upgrade's busy-wait is still
  // polling — simulating "the turn finishes naturally right as the upgrade started waiting". Pre-fix (or
  // with the hold sitting in the wrong place), that Stop hook's OWN synchronous `drainPending` would
  // splice the queued message OUT of `pending` and submit it as a fresh turn — invisible to `flushPending`
  // (it's no longer queued) and then killed outright by the upgrade's own subsequent `pty.stop()`. With
  // `holdDrain` held across the whole wait, that Stop hook's drain bails instead, so the message stays in
  // `pending` and is recovered normally.
  {
    const rDb = new Db();
    const rProjId = randomUUID();
    rDb.insertProject({ id: rProjId, name: "Regression", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
    const rAgentId = randomUUID();
    rDb.insertAgent({ id: rAgentId, projectId: rProjId, name: "Companion", startupPrompt: "", position: 0, profileId, endpoint: false, ioSchema: null });
    const rSessionId = randomUUID();
    const rEngineId = "eng-regression-drain-hold";
    rDb.insertSession({
      id: rSessionId, projectId: rProjId, agentId: rAgentId, engineSessionId: rEngineId, title: null, cwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
      noCommit: false, skills: null, connections: [], capabilities: [],
    });
    const rTpath = engineTranscriptPath(cwd, rEngineId);
    fs.mkdirSync(path.dirname(rTpath), { recursive: true });
    fs.writeFileSync(rTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    const rEvents = {
      onEngineSessionId(id, eng) { rDb.setEngineSessionId(id, eng); },
      onBusy(id, b) { rDb.setBusy(id, b); },
      onContextStats() {}, onRateLimited() {},
      onExit(id) { rDb.setProcessState(id, "exited"); rDb.setBusy(id, false); },
    };
    const rHost = new SeamHost(rEvents);
    rHost.spawn({
      sessionId: rSessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
      resumeId: rEngineId, role: "assistant", browserTesting: false, documentConversion: false,
      capabilities: [], restrictedTools: false, skills: null,
    });
    rHost.deliverHook(rSessionId, { hook_event_name: "SessionStart" });

    const primer = rHost.enqueueStdin(rSessionId, "PRIMER_TURN", "system");
    check("regression setup: the primer turn submits immediately on an idle session (arms busy)", primer.delivered === true);
    check("regression setup: the companion is BUSY before the upgrade starts", rHost.isBusy(rSessionId) === true);

    const queued = rHost.enqueueStdin(rSessionId, "URGENT: reply to this while busy", "system", undefined, undefined, "agent");
    check("regression setup: a second message QUEUES behind the busy turn (not yet a turn of its own)", queued.delivered === false && queued.reason === "held");

    const rSvc = new SessionService(rDb, rHost, new OrchestrationControl());
    const upgradePromise = rSvc.upgradeCompanionCapabilities(rSessionId);
    // upgradeCompanionCapabilities runs synchronously through its guards + holdDrain call before its first
    // `await` (inside the busy-wait loop) — so by this point holdDrain has DEFINITELY already run (same
    // reasoning as the AVAILABILITY-GAP test's own comment above). Firing the Stop hook now — itself fully
    // synchronous, per the M2 invariant — simulates the busy turn ending WHILE the upgrade is still
    // waiting, and its effect (or non-effect) on `pending` is observable immediately, no race.
    rHost.deliverHook(rSessionId, { hook_event_name: "Stop" });
    check(
      "(CR regression) the queued message was NOT promoted into a fresh turn by the mid-wait Stop hook — it survives in `pending`",
      rHost.getPending(rSessionId).includes("URGENT: reply to this while busy"),
    );
    check("(CR regression) the companion is idle again after the mid-wait Stop (drainPending bailed, so nothing re-armed busy)", rHost.isBusy(rSessionId) === false);

    // The session is now IDLE (busy=false) but the drain is STILL HELD — the upgrade's wait loop hasn't
    // exited yet (we haven't `await`ed it), so `pty.stop` hasn't run either. Without the SEPARATE
    // enqueueStdin-side `!live.drainHeld` gate (host.ts:2864), THIS is exactly the instant a brand-new
    // inbound chat message would hit the idle-submit path (ready && !busy && !stopping && !rateLimited)
    // and become a turn with NO `pending` entry at all — the OTHER half of the Critical (case (b) via the
    // enqueueStdin door, distinct from the drainPending door the checks above already cover). The two
    // gates are independently falsifiable: stripping drainPending's gate fails the checks above (the
    // QUEUED message gets drained/promoted, busy re-arms); stripping THIS gate leaves those passing but
    // fails the one below (verified by hand against both single-gate strips).
    const midHoldNew = rHost.enqueueStdin(rSessionId, "NEW: arrived mid-hold", "system", undefined, undefined, "agent");
    check(
      "(CR regression, gate 2/2) a FRESH message arriving idle-but-held is HELD, not submitted as its own turn",
      midHoldNew.delivered === false && midHoldNew.reason === "held",
    );

    await upgradePromise;

    check(
      "(CR regression, gate 1/2) the ORIGINAL queued message SURVIVED the whole upgrade — redelivered onto the fresh pty, never lost",
      rHost.getPending(rSessionId).includes("URGENT: reply to this while busy"),
    );
    check(
      "(CR regression, gate 2/2) the FRESH mid-hold message ALSO survived — redelivered onto the fresh pty, never lost",
      rHost.getPending(rSessionId).includes("NEW: arrived mid-hold"),
    );
    rDb.close();
  }

  // ===================== connections/vaultWrite (card 1a048349): BOTH directions =====================
  // mcp/server.ts's TaskMcpRouter reads a session's connections/vaultWrite LIVE off the ROW on every
  // request (stateless — never threaded through pty.spawn/resume() at all), so a live upgrade must WRITE
  // those columns for a Profile change to take effect, not merely re-resolve them for the fresh spawn.
  // GRANT and REVOKE are each set up with the ROW starting in the OPPOSITE state from where the Profile
  // is about to move it — never with the row already sitting at the post-upgrade value it's about to be
  // asserted at — so neither check can pass merely because nothing happened to write the row (a mistake
  // caught while authoring this test: an earlier draft seeded REVOKE's row from GRANT's own, possibly-
  // unwritten, post-state and passed vacuously on unfixed code).
  const makeConnWriteSession = (label, { profileConnections, profileVaultWrite, rowConnections, rowVaultWrite }) => {
    const cwProfileId = randomUUID();
    db.insertProfile({
      id: cwProfileId, name: `ConnWrite ${label}`, role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
      browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false,
      connections: profileConnections, vaultWrite: profileVaultWrite, capabilities: [],
    });
    const cwAgentId = randomUUID();
    db.insertAgent({ id: cwAgentId, projectId: projId, name: `ConnWrite ${label} Companion`, startupPrompt: "", position: 3, profileId: cwProfileId, endpoint: false, ioSchema: null });
    const cwSessionId = randomUUID();
    const cwEngineId = `eng-connwrite-${label}`;
    db.insertSession({
      id: cwSessionId, projectId: projId, agentId: cwAgentId, engineSessionId: cwEngineId, title: null, cwd,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
      noCommit: false, skills: null, connections: rowConnections, vaultWrite: rowVaultWrite, capabilities: [],
    });
    const cwTpath = engineTranscriptPath(cwd, cwEngineId);
    fs.mkdirSync(path.dirname(cwTpath), { recursive: true });
    fs.writeFileSync(cwTpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");

    const cwEvents = {
      onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
      onBusy(id, b) { db.setBusy(id, b); },
      onContextStats() {}, onRateLimited() {},
      onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
    };
    const cwHost = new SeamHost(cwEvents);
    cwHost.spawn({
      sessionId: cwSessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 },
      resumeId: cwEngineId, role: "assistant", browserTesting: false, documentConversion: false,
      capabilities: [], restrictedTools: false, skills: null,
    });
    return { cwSessionId, cwSvc: new SessionService(db, cwHost, new OrchestrationControl()) };
  };

  // ---- GRANT: the row starts with NO grant; the Profile ALREADY carries one (the owner granted it
  // before this upgrade); the upgrade must WRITE it onto the row ----
  {
    const { cwSessionId, cwSvc } = makeConnWriteSession("grant", {
      profileConnections: ["conn-acme"], profileVaultWrite: true,
      rowConnections: [], rowVaultWrite: false,
    });
    check("(GRANT) setup: row starts with no grant", db.getSession(cwSessionId).connections.length === 0 && db.getSession(cwSessionId).vaultWrite === false);
    const preGrantTools = await listToolsFor(cwSessionId);
    check("(GRANT) enforcement site, BEFORE: authenticated_request OMITTED from tools/list (no grant yet)", !preGrantTools.includes("authenticated_request"));
    check("(GRANT) enforcement site, BEFORE: vault_write OMITTED from tools/list (no grant yet)", !preGrantTools.includes("vault_write"));

    await cwSvc.upgradeCompanionCapabilities(cwSessionId);

    const grantedRow = db.getSession(cwSessionId);
    check("(GRANT) row: connections re-pinned to the newly-granted id", JSON.stringify(grantedRow.connections) === JSON.stringify(["conn-acme"]));
    check("(GRANT) row: vaultWrite re-pinned true", grantedRow.vaultWrite === true);
    // The ENFORCEMENT SITE, not just the column: a fresh tools/list (the router is stateless — this is
    // exactly what the companion's VERY NEXT tool call would rebuild) now offers both gated tools, proving
    // the grant is actually live, not merely reflected in the DB.
    const postGrantTools = await listToolsFor(cwSessionId);
    check("(GRANT) enforcement site, AFTER: authenticated_request now PRESENT in tools/list — the grant is LIVE on the very next call", postGrantTools.includes("authenticated_request"));
    check("(GRANT) enforcement site, AFTER: vault_write now PRESENT in tools/list — the grant is LIVE on the very next call", postGrantTools.includes("vault_write"));
  }

  // ---- REVOKE: the row starts with a PRE-EXISTING grant (e.g. from an earlier spawn); the Profile has
  // ALREADY been revoked to empty/false; the upgrade must CLEAR the row — the security-relevant
  // direction, since a stale row would otherwise keep feeding an exfil-class grant to the live
  // per-request TaskMcpRouter read indefinitely after the owner revoked it ----
  {
    const { cwSessionId, cwSvc } = makeConnWriteSession("revoke", {
      profileConnections: [], profileVaultWrite: false,
      rowConnections: ["conn-legacy"], rowVaultWrite: true,
    });
    check("(REVOKE) setup: row starts with a pre-existing grant", JSON.stringify(db.getSession(cwSessionId).connections) === JSON.stringify(["conn-legacy"]) && db.getSession(cwSessionId).vaultWrite === true);
    const preRevokeTools = await listToolsFor(cwSessionId);
    check("(REVOKE) enforcement site, BEFORE: authenticated_request is PRESENT (the pre-existing grant is live)", preRevokeTools.includes("authenticated_request"));
    check("(REVOKE) enforcement site, BEFORE: vault_write is PRESENT (the pre-existing grant is live)", preRevokeTools.includes("vault_write"));

    await cwSvc.upgradeCompanionCapabilities(cwSessionId);

    const revokedRow = db.getSession(cwSessionId);
    check("(REVOKE) row: connections cleared — a revoked exfil-class grant does NOT survive a live upgrade", revokedRow.connections.length === 0);
    check("(REVOKE) row: vaultWrite cleared false — a revoked grant does NOT survive a live upgrade", revokedRow.vaultWrite === false);
    // THE SECURITY-RELEVANT PROOF: the ENFORCEMENT SITE, not just the column. mcp/server.ts's TaskMcpRouter
    // is stateless and rebuilds fresh on every request, so this tools/list call is EXACTLY what the
    // companion's very next tool call would see — proving the revoked grant is unreachable IMMEDIATELY
    // (no respawn, no delay, no residual window), not merely that a DB column changed underneath a still-
    // trusting live router.
    const postRevokeTools = await listToolsFor(cwSessionId);
    check("(REVOKE) enforcement site, AFTER: authenticated_request OMITTED — the revoked grant is UNREACHABLE on the very next call", !postRevokeTools.includes("authenticated_request"));
    check("(REVOKE) enforcement site, AFTER: vault_write OMITTED — the revoked grant is UNREACHABLE on the very next call", !postRevokeTools.includes("vault_write"));
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
  ? "\n✅ ALL PASS — upgradeCompanionCapabilities re-resolves + re-pins the capability surface, stops the old pty, and resumes with the SAME engine session id — the new tool allow-list is present post-upgrade and absent pre-upgrade; guardrails refuse an unknown/non-assistant/never-spawned session; a BUSY turn gets a short bounded wait before the interrupt (idle: no delay, clears-in-time: never interrupted, stays-busy: still bounded, never a permanent refusal) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
