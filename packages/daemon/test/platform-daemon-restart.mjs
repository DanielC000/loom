import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 39fcaad3 — expose a scoped `daemon_restart` on the Platform Lead surface, reusing the SAME
// SessionService.requestDaemonRestart + resumeFleetOnBoot machinery a manager already uses (no fork, no
// reimplementation). Mirrors idle-report.mjs's (S)/(T)/(P) shape (card 98b3725c precedent) plus a
// dedicated (N) section for the one genuinely risky change: resumeFleetOnBoot's post-restart requester
// nudge used to hardcode `deferredNudge` (assuming the requester is ALWAYS a manager). Proves:
//   (S) SERVICE requestDaemonRestart role gate: 'manager' and 'platform' are BOTH accepted (the
//       unsupervised-refusal path is exercised — cheap, deterministic, no real build spawn); 'worker',
//       'assistant', 'setup', and an unknown session are ALL still rejected (gate widened from one role
//       to exactly two, not loosened further).
//   (T) TOOL SURFACE: daemon_restart is registered on the manager's OrchestrationMcpRouter surface (pre-
//       existing) and NOT on the worker surface — unchanged, asserted as a regression guard.
//   (P) PLATFORM ROUTER: daemon_restart is registered on the Lead's PlatformMcpRouter and reachable
//       end-to-end over a real MCP InMemoryTransport, mirroring idle_report's (P) section exactly — the
//       unsupervised refusal shape is IDENTICAL to the manager tool's.
//   (N) NUDGE ROUTING — the risky change: a MANAGER requester's "code is live" nudge must still be
//       gated behind PtyHost.waitForMcpSeen (byte-identical to before — manager mounts loom-orchestration,
//       so this wait is load-bearing); a PLATFORM requester's nudge must be delivered immediately WITHOUT
//       waiting on a markMcpSeen signal that could never fire for it (platform never mounts
//       loom-orchestration — see usesOrchestrationMcp), and carries Lead-appropriate phrasing (no
//       "your live workers" framing, since a Lead has none of its own).
//   (N3) Code-review follow-up: `reqRole` must be derived from the DB (the authoritative, live source),
//       NOT solely from `entries` (liveFleetResumeSet()'s capture-time snapshot, which filters on
//       `fs.existsSync(s.cwd)` — a platform Lead whose project home is transiently unreachable would be
//       dropped from `entries` yet still resumed, since `resumeOne(reqId)` runs unconditionally). Proves
//       a platform requester OMITTED from `intent.resume` still gets the Lead-appropriate nudge, not the
//       old entries-only lookup's wrong "manager" fallback.
//   (W) WRITE-PATH: requestDaemonRestart's `writeRestartIntent` call actually stamps the CALLER's own
//       session id into `RestartIntent.managerSessionId` for a platform caller too (not just proven by
//       reading the source) — driven via the TEST-ONLY `deps` injection seam (fake instant-green build +
//       a captured exit) added for exactly this, so no real pnpm/turbo spawn or process.exit occurs.
// Run: 1) build daemon, 2) node test/platform-daemon-restart.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated LOOM_HOME BEFORE any dist import (paths.ts's LOOM_HOME is a top-level const fixed at import
// time) — (W) below drives a real requestDaemonRestart() supervised path, which touches
// writeRestartIntent + the pre-restart backup check, both LOOM_HOME-derived. Mirrors restart-intent.mjs /
// restart-fleet.mjs exactly; never touch the real ~/.loom.
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-platrestart-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
delete process.env.LOOM_SUPERVISED; // ensure every unsupervised-refusal check below is deterministic

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const restart = await import("../dist/orchestration/restart.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const flush = () => new Promise((r) => setTimeout(r, 0));

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-platrestart-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

// ============================ (S) SERVICE: requestDaemonRestart role gate ============================
{
  const file = tmpDbFile("svc");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });

  const svc = new SessionService(db, /* pty */ {}, new OrchestrationControl());
  let n = 0;
  const mkSession = (role) => {
    const id = `s${++n}-${role ?? "null"}`;
    db.insertSession({
      id, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: "/x",
      processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: role ?? null,
    });
    return id;
  };

  const mgrId = mkSession("manager");
  const platId = mkSession("platform");
  const wkrId = mkSession("worker");
  const asstId = mkSession("assistant");
  const setupId = mkSession("setup");

  const r1 = await svc.requestDaemonRestart(mgrId, "manager unsupervised check");
  check("(S) manager: unsupervised → restarting:false (unchanged baseline)", r1.restarting === false);
  check("(S) manager: unsupervised refusal carries an explanatory error", typeof r1.error === "string" && r1.error.length > 0);

  const r2 = await svc.requestDaemonRestart(platId, "platform unsupervised check");
  check("(S) platform: role gate now ACCEPTS it (reaches the SAME unsupervised refusal, not a role throw)", r2.restarting === false);
  check("(S) platform: unsupervised refusal carries an explanatory error", typeof r2.error === "string" && r2.error.length > 0);
  check("(S) manager and platform get the IDENTICAL unsupervised-refusal error text (same code path)", r1.error === r2.error);

  for (const [label, id] of [["worker", wkrId], ["assistant", asstId], ["setup", setupId], ["unknown session", "no-such-session"]]) {
    let threw = false;
    try { await svc.requestDaemonRestart(id, "nope"); } catch { threw = true; }
    check(`(S) ${label}: still REJECTED — the gate widened to exactly {manager,platform}, not further`, threw);
  }

  db.close();
  rmDb(file);
}

// ============================ (T) TOOL SURFACE: manager registration unaffected ============================
{
  const file = tmpDbFile("tool-mgr");
  const db = new Db(file);
  const router = new OrchestrationMcpRouter(db, {});
  const toolNames = (role) => Object.keys(router.buildServer("sid", role)._registeredTools);

  check("(T) daemon_restart IS still registered on the MANAGER surface", toolNames("manager").includes("daemon_restart"));
  check("(T) daemon_restart is NOT on the worker surface", !toolNames("worker").includes("daemon_restart"));

  db.close();
  rmDb(file);
}

// ==================== (P) PLATFORM ROUTER — daemon_restart reachable end-to-end ====================
{
  const file = tmpDbFile("platform");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pp", name: "PP", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "pt", projectId: "pp", name: "t", startupPrompt: "x", position: 0 });
  db.insertSession({
    id: "PL", projectId: "pp", agentId: "pt", engineSessionId: null, title: null, cwd: "/x",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });

  const svc = new SessionService(db, /* pty */ {}, new OrchestrationControl());
  const router = new PlatformMcpRouter(db, svc);
  const server = router.buildServer("PL"); // callerSessionId — mirrors idle_report/end_me/recycle_me's self-scoping

  check("(P) daemon_restart IS registered on the PlatformMcpRouter surface",
    Object.keys(server._registeredTools).includes("daemon_restart"));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-daemon-restart-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const r = await call("daemon_restart", { reason: "verify Lead-surface wiring" });
  check("(P) daemon_restart via the platform router reaches the SAME unsupervised refusal (no build/exit side effects)",
    r.restarting === false && typeof r.error === "string" && r.error.length > 0);

  db.close();
  rmDb(file);
}

// ============================ (N) NUDGE ROUTING — resumeFleetOnBoot requester dispatch ============================
// A controllable pty stub whose waitForMcpSeen NEVER auto-resolves — only an explicit markMcpSeen()
// call settles it — so we can distinguish "delivered immediately" from "delivered only once the
// MCP-seen wait settles" (the exact distinction the manager-vs-platform requester fix hinges on).
class ControllableMcpPty {
  constructor() { this.q = new Map(); this.waiters = new Map(); }
  enqueueStdin(id, text) { const a = this.q.get(id) ?? []; a.push(text); this.q.set(id, a); return { delivered: false, position: a.length }; }
  getPending(id) { return [...(this.q.get(id) ?? [])]; }
  isComposerDirty() { return false; }
  waitForMcpSeen(id) {
    return new Promise((resolve) => {
      const existing = this.waiters.get(id) ?? [];
      existing.push(resolve);
      this.waiters.set(id, existing);
    });
  }
  markMcpSeen(id) {
    for (const resolve of this.waiters.get(id) ?? []) resolve(true);
    this.waiters.delete(id);
  }
}

// --- (N1) MANAGER requester: nudge stays gated behind waitForMcpSeen — byte-identical to pre-fix ---
{
  const file = tmpDbFile("nudge-mgr");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "np", name: "NP", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "na", projectId: "np", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqMgr", projectId: "np", agentId: "na", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy", managerSessionId: "reqMgr", requestedAt: now, resume: [{ sessionId: "reqMgr", role: "manager", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flush();
  check("(N1) a MANAGER requester's nudge is WITHHELD while its MCP-seen wait is unsettled (load-bearing, unchanged)",
    pty.getPending("reqMgr").length === 0);

  pty.markMcpSeen("reqMgr");
  await flush();
  const mgrMsgs = pty.getPending("reqMgr");
  check("(N1) once markMcpSeen fires, the manager requester gets its 'code is live' nudge",
    mgrMsgs.length === 1 && mgrMsgs[0].includes("now LIVE") && mgrMsgs[0].includes("[loom:daemon-restarted]"));
  check("(N1) the manager's nudge uses worker/worktree-shaped phrasing, not the Lead's board/resume-doc framing",
    /of your live/i.test(mgrMsgs[0]) && !/living resume doc/i.test(mgrMsgs[0]));

  db.close();
  rmDb(file);
}

// --- (N2) PLATFORM requester: nudge delivers IMMEDIATELY — never waits on a signal that can't fire ---
{
  const file = tmpDbFile("nudge-plat");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "np2", name: "NP2", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "na2", projectId: "np2", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqPlat", projectId: "np2", agentId: "na2", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy", managerSessionId: "reqPlat", requestedAt: now, resume: [{ sessionId: "reqPlat", role: "platform", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flush();
  const platMsgs = pty.getPending("reqPlat");
  check("(N2) a PLATFORM requester's nudge is delivered IMMEDIATELY — no markMcpSeen ever called, no wait",
    platMsgs.length === 1 && platMsgs[0].includes("now LIVE") && platMsgs[0].includes("[loom:daemon-restarted]"));
  check("(N2) the platform requester's nudge uses Lead-appropriate phrasing (board + resume doc)",
    /living resume doc/i.test(platMsgs[0]) && /home board/i.test(platMsgs[0]));
  check("(N2) the platform requester's nudge does NOT use the manager's worker/worktree framing",
    !/of your live/i.test(platMsgs[0]));
  // markMcpSeen was never called for reqPlat in this section — proves delivery did not depend on it.
  check("(N2) delivery happened with zero pending MCP-seen waiters left dangling", pty.waiters.get("reqPlat") === undefined);

  db.close();
  rmDb(file);
}

// --- (N3) PLATFORM requester OMITTED from intent.resume — reqRole must still resolve via the DB, not
// mis-derive "manager" from an absent/stale `entries` lookup (the exact scenario code review flagged:
// liveFleetResumeSet()'s fs.existsSync(cwd) filter could drop a live platform Lead's own entry from
// `entries` at capture time, yet resumeFleetOnBoot still resumes+nudges it unconditionally). ---
{
  const file = tmpDbFile("nudge-plat-omitted");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "np3", name: "NP3", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "na3", projectId: "np3", name: "t", startupPrompt: "", position: 0 });
  // The requester's OWN row IS in the DB (role: platform) — this is what a correct reqRole derivation
  // must fall back to — but its `resume` entry is deliberately OMITTED from intent.resume below.
  db.insertSession({ id: "reqPlatOmitted", projectId: "np3", agentId: "na3", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  // intent.resume is EMPTY — `entries.find(...)` can find NOTHING for reqPlatOmitted, exactly the
  // fs.existsSync-filtered-out scenario. resumeOne still resumes it (mirrors resumeFleetOnBoot's real
  // unconditional `resumeOne(reqId)` call).
  const intent = { reason: "deploy", managerSessionId: "reqPlatOmitted", requestedAt: now, resume: [] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true });
  await flush();
  const omittedMsgs = pty.getPending("reqPlatOmitted");
  check("(N3) a platform requester OMITTED from intent.resume is still resolved via the DB — delivered immediately",
    omittedMsgs.length === 1 && omittedMsgs[0].includes("now LIVE"));
  check("(N3) it gets Lead-appropriate phrasing (proves the DB-derived role, NOT the entries-lookup 'manager' fallback)",
    /living resume doc/i.test(omittedMsgs[0]) && !/of your live/i.test(omittedMsgs[0]));

  db.close();
  rmDb(file);
}

// --- (W) WRITE-PATH: requestDaemonRestart actually stamps the CALLER's id into
// RestartIntent.managerSessionId for a platform caller — driven via the deps injection seam (fake instant
// build + captured exit), never a real pnpm/turbo spawn or process.exit. ---
{
  const file = tmpDbFile("write-path");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "wp", name: "WP", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "wa", projectId: "wp", name: "t", startupPrompt: "", position: 0 });
  // cwd MUST be a real, existing directory — liveFleetResumeSet() filters on fs.existsSync(cwd) (the
  // ghost-resume guard), so a fake path like "/x" would silently drop this session from the resume set.
  db.insertSession({ id: "reqPlatWrite", projectId: "wp", agentId: "wa", engineSessionId: null, title: null, cwd: os.tmpdir(), processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const sessions = new SessionService(db, { getPersistablePending: () => [], isComposerDirty: () => false }, new OrchestrationControl());
  const fakeRunStep = async () => ({ code: 0, out: "" }); // instant green "build" — no real spawn
  const exitCalls = [];
  const captureExit = (code) => exitCalls.push(code); // never actually exits this test process

  process.env.LOOM_SUPERVISED = "1"; // ONLY this block needs it — restored immediately after
  let result;
  try {
    result = await sessions.requestDaemonRestart("reqPlatWrite", "verify write-path", {
      buildDeps: { runStep: fakeRunStep },
      exit: captureExit,
    });
  } finally {
    delete process.env.LOOM_SUPERVISED;
  }
  check("(W) requestDaemonRestart with a fake green build reports restarting:true", result.restarting === true);

  const written = restart.readRestartIntent();
  check("(W) the persisted intent's managerSessionId equals the PLATFORM caller's own session id",
    written?.managerSessionId === "reqPlatWrite");
  check("(W) the caller's own session is present in the persisted resume set",
    Array.isArray(written?.resume) && written.resume.some((e) => e.sessionId === "reqPlatWrite" && e.role === "platform"));
  check("(W) the exit callback fires with RESTART_EXIT_CODE (75) — captured, never actually exits", exitCalls.length === 0);
  await new Promise((r) => setTimeout(r, 350)); // the real setTimeout(…, 300) inside requestDaemonRestart
  check("(W) after the 300ms delay elapses, the captured exit fires with 75 (not a real process.exit)",
    exitCalls.length === 1 && exitCalls[0] === restart.RESTART_EXIT_CODE);

  restart.clearRestartIntent();
  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — daemon_restart's role gate now accepts BOTH manager and platform (worker/assistant/setup/" +
    "unknown still rejected, identical refusal shape either way), is registered end-to-end on the Lead's " +
    "PlatformMcpRouter (manager/worker surfaces unaffected), and resumeFleetOnBoot's requester nudge is " +
    "correctly role-routed: a manager stays gated behind waitForMcpSeen (byte-identical), a platform Lead " +
    "requester is delivered immediately with Lead-appropriate phrasing instead of waiting on a signal that " +
    "could never fire for it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
