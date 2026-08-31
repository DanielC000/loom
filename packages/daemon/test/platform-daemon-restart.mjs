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
//   (N4)/(N5) Card db2179f6: `intent.supervisorChanged:true` makes the requester's "your merged daemon
//       code is now LIVE" claim conditional — both the manager AND platform-Lead branches must say the
//       supervisor part is NOT live and name the human `pnpm daemon:stable` step, instead of the
//       unconditional claim the common (supervisorChanged absent/false) case still makes — see (N1)/(N2)'s
//       new positive-control checks for that common-case text staying byte-identical.
//   (N6) Card b2dcf930: the Lead branch's fleet-wide "whole fleet ... was resumed too" claim, RED-proofed
//       for the platform requester specifically (restart-fleet.mjs's (2) section already covers the
//       manager branch) — the Lead branch had NO ratio at all before the fix.
//   (N7)/(N8) Card 062fa934: `deployStaleness.deploySignatureMismatch:true` (injected via resumeFleetOnBoot's
//       new `deployStaleness` test seam) WITHHOLDS the unconditional "your merged daemon code is now LIVE"
//       assurance for both the manager and platform-Lead requester branches — checked ahead of
//       supervisorChanged (a stronger doubt: the build's own identity is in question). (N1)/(N2) are this
//       finding's own negative control: they now pass an explicit CLEAN_STALENESS fixture and still assert
//       the unconditional claim, proving the SAME branch emits normally when the signature is clean.
//   (N9) Code Review BLOCKING MAJOR (card 062fa934): the ORDERING decision itself — deploySignatureMismatch
//       checked ahead of supervisorChanged — was previously pinned by NOTHING: every (N7)/(N8) case leaves
//       supervisorChanged unset, and every (N4)/(N5) case uses clean staleness, so inverting the precedence
//       in service.ts left every prior check green. This sets BOTH flags at once and asserts the signature
//       wording wins (present) while the supervisor wording loses (absent) — RED-proofed by inverting the
//       real precedence and confirming this is the ONE case that then fails.
// Run: 1) build daemon, 2) node test/platform-daemon-restart.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

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
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs, label: "platform-daemon-restart" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};
const flush = () => new Promise((r) => setTimeout(r, 0));

// Card 062fa934, Code Review CRITICAL — every (N*) section below now injects `deployStaleness` explicitly
// rather than letting resumeFleetOnBoot fall back to the real `currentDeployStaleness()` (a live
// `execFileSync("git", ...)` read of THIS checkout) — this test's whole point is a hermetic, deterministic
// fixture, and a hidden dependency on real git/dist state would make it neither (worse: it was PROVEN to
// actively lie on a turbo cache-hit build — see `_deploy-staleness-fixture.mjs`'s own doc for the
// reproduced incident this shared fixture exists to prevent). CLEAN_STALENESS/MISMATCH_STALENESS are
// shared with every other file exercising this same call, not a per-file copy.
const { CLEAN_STALENESS, MISMATCH_STALENESS } = await import("./_deploy-staleness-fixture.mjs");

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

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
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
  check("(N1) common case (no failed resumes) keeps the unconditional fleet clause unchanged",
    mgrMsgs[0].includes("the rest of the fleet across all projects was resumed too"));

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

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  await flush();
  const platMsgs = pty.getPending("reqPlat");
  check("(N2) a PLATFORM requester's nudge is delivered IMMEDIATELY — no markMcpSeen ever called, no wait",
    platMsgs.length === 1 && platMsgs[0].includes("now LIVE") && platMsgs[0].includes("[loom:daemon-restarted]"));
  check("(N2) the platform requester's nudge uses Lead-appropriate phrasing (board + resume doc)",
    /living resume doc/i.test(platMsgs[0]) && /home board/i.test(platMsgs[0]));
  check("(N2) the platform requester's nudge does NOT use the manager's worker/worktree framing",
    !/of your live/i.test(platMsgs[0]));
  check("(N2) common case (no failed resumes) keeps the Lead's unconditional fleet sentence unchanged",
    platMsgs[0].includes("The whole fleet across all projects was resumed too."));
  // markMcpSeen was never called for reqPlat in this section — proves delivery did not depend on it.
  check("(N2) delivery happened with zero pending MCP-seen waiters left dangling", pty.waiters.get("reqPlat") === undefined);

  db.close();
  rmDb(file);
}

// --- (N4) card db2179f6: supervisorChanged:true — a MANAGER requester's "code is live" claim becomes
// conditional. The supervisor script is NOT re-execed across daemon_restart, so a deploy touching it
// must say so instead of the unconditional "now LIVE" claim. ---
{
  const file = tmpDbFile("nudge-mgr-sc");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npsc", name: "NPSC", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "nasc", projectId: "npsc", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqMgrSC", projectId: "npsc", agentId: "nasc", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy touching the supervisor", managerSessionId: "reqMgrSC", requestedAt: now, supervisorChanged: true, resume: [{ sessionId: "reqMgrSC", role: "manager", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  pty.markMcpSeen("reqMgrSC"); // manager requester's nudge is gated behind waitForMcpSeen — see (N1)
  await flush();
  const msgs = pty.getPending("reqMgrSC");
  check("(N4) supervisorChanged:true — the manager requester's nudge says the supervisor part is NOT live and names the human step",
    msgs.length === 1 && /EXCEPT the supervisor script itself/.test(msgs[0]) && /pnpm daemon:stable/.test(msgs[0]));
  check("(N4) it drops the unconditional 'now LIVE in the running daemon' claim it makes in the common case",
    !/now LIVE in the running daemon/.test(msgs[0]));

  db.close();
  rmDb(file);
}

// --- (N5) card db2179f6: supervisorChanged:true — the PLATFORM (Lead) requester gets the SAME
// conditional claim as the manager branch above (both branches share one ternary in service.ts). ---
{
  const file = tmpDbFile("nudge-plat-sc");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npsc2", name: "NPSC2", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "nasc2", projectId: "npsc2", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqPlatSC", projectId: "npsc2", agentId: "nasc2", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy touching the supervisor", managerSessionId: "reqPlatSC", requestedAt: now, supervisorChanged: true, resume: [{ sessionId: "reqPlatSC", role: "platform", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
  await flush();
  const msgs = pty.getPending("reqPlatSC");
  check("(N5) supervisorChanged:true — the platform Lead requester's nudge ALSO says the supervisor part is NOT live",
    msgs.length === 1 && /EXCEPT the supervisor script itself/.test(msgs[0]) && /pnpm daemon:stable/.test(msgs[0]));

  db.close();
  rmDb(file);
}

// --- (N7) card 062fa934: deploySignatureMismatch:true — a MANAGER requester's "code is live" claim is
// WITHHELD (not a refusal — the restart already happened; only the assurance is gated). Checked FIRST,
// ahead of supervisorChanged (a strictly stronger doubt — see service.ts's own comment at the liveClaim
// ternary). RED-PROOF pairing with the (N1) positive control above: (N1) already proves the SAME manager
// branch emits the unconditional claim when deployStaleness is clean; this proves the identical branch
// withholds it when the signature disagrees — same code path, both directions independently asserted. ---
{
  const file = tmpDbFile("nudge-mgr-dsm");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npdsm", name: "NPDSM", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "nadsm", projectId: "npdsm", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqMgrDSM", projectId: "npdsm", agentId: "nadsm", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy", managerSessionId: "reqMgrDSM", requestedAt: now, resume: [{ sessionId: "reqMgrDSM", role: "manager", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: MISMATCH_STALENESS });
  pty.markMcpSeen("reqMgrDSM"); // manager requester's nudge is gated behind waitForMcpSeen — see (N1)
  await flush();
  const msgs = pty.getPending("reqMgrDSM");
  check("(N7) deploySignatureMismatch:true — the unconditional 'now LIVE' assurance is WITHHELD",
    msgs.length === 1 && !/now LIVE in the running daemon/.test(msgs[0]) && !/EXCEPT the supervisor script itself/.test(msgs[0]));
  check("(N7) it says what is actually known instead — the build signature could not be confirmed",
    /could NOT be confirmed as your merged code/.test(msgs[0]) && /deploySignatureMismatch/.test(msgs[0]));
  check("(N7) it is a NOTICE, not a refusal — the requester still gets its full continue/verify nudge",
    /\[loom:daemon-restarted\]/.test(msgs[0]) && /Continue\./.test(msgs[0]));

  db.close();
  rmDb(file);
}

// --- (N8) card 062fa934: deploySignatureMismatch:true — the PLATFORM (Lead) requester gets the SAME
// withheld claim as the manager branch above (both branches share the one ternary in service.ts). ---
{
  const file = tmpDbFile("nudge-plat-dsm");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npdsm2", name: "NPDSM2", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "nadsm2", projectId: "npdsm2", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqPlatDSM", projectId: "npdsm2", agentId: "nadsm2", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy", managerSessionId: "reqPlatDSM", requestedAt: now, resume: [{ sessionId: "reqPlatDSM", role: "platform", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: MISMATCH_STALENESS });
  await flush();
  const msgs = pty.getPending("reqPlatDSM");
  check("(N8) deploySignatureMismatch:true — the platform Lead requester's nudge ALSO withholds the claim",
    msgs.length === 1 && !/now LIVE in the running daemon/.test(msgs[0]) && /could NOT be confirmed as your merged code/.test(msgs[0]));

  db.close();
  rmDb(file);
}

// --- (N9) Code Review BLOCKING MAJOR (card 062fa934): BOTH deploySignatureMismatch:true AND
// supervisorChanged:true at once. The precedence decision (signature checked FIRST) was previously
// unpinned by any test — every (N7)/(N8) case leaves supervisorChanged unset and every (N4)/(N5) case uses
// clean staleness, so a reviewer inverting the real precedence still passed everything. This is the ONE
// case that discriminates: the signature wording must win, and the supervisor wording must NOT appear
// (a caveated "live EXCEPT the supervisor" would still assert the very identity now in doubt). ---
{
  const file = tmpDbFile("nudge-mgr-both");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npboth", name: "NPBOTH", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "naboth", projectId: "npboth", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqMgrBoth", projectId: "npboth", agentId: "naboth", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = { reason: "deploy", managerSessionId: "reqMgrBoth", requestedAt: now, supervisorChanged: true, resume: [{ sessionId: "reqMgrBoth", role: "manager", parentSessionId: null }] };

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: MISMATCH_STALENESS });
  pty.markMcpSeen("reqMgrBoth"); // manager requester's nudge is gated behind waitForMcpSeen — see (N1)
  await flush();
  const msgs = pty.getPending("reqMgrBoth");
  check("(N9) both flags set — the signature-mismatch wording WINS (precedence proven, not assumed)",
    msgs.length === 1 && /could NOT be confirmed as your merged code/.test(msgs[0]));
  check("(N9) both flags set — the supervisor-caveat wording does NOT also appear",
    !/EXCEPT the supervisor script itself/.test(msgs[0]) && !/pnpm daemon:stable/.test(msgs[0]));

  db.close();
  rmDb(file);
}

// --- (N6) card b2dcf930: failed.length > 0 for the PLATFORM (Lead) BRANCH specifically — restart-
// fleet.mjs's (2) section already covers the manager branch; the Lead branch had NO ratio at all before
// the fix (it unconditionally claimed "The whole fleet across all projects was resumed too."). ---
{
  const file = tmpDbFile("nudge-plat-failed");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "npf", name: "NPF", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "naf", projectId: "npf", name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: "reqPlatFailed", projectId: "npf", agentId: "naf", engineSessionId: null, title: null, cwd: "/x", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const pty = new ControllableMcpPty();
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const intent = {
    reason: "deploy", managerSessionId: "reqPlatFailed", requestedAt: now,
    resume: [
      { sessionId: "reqPlatFailed", role: "platform", parentSessionId: null },
      { sessionId: "some-dead-session", role: "worker", parentSessionId: null },
    ],
  };
  const resumeOne = (id) => id !== "some-dead-session";
  const result = sessions.resumeFleetOnBoot(intent, { resumeOne, deployStaleness: CLEAN_STALENESS });
  await flush();
  check("(N6) the unresumable session lands in `failed`", result.failed.includes("some-dead-session") && result.failed.length === 1);
  const msgs = pty.getPending("reqPlatFailed");
  check("(N6) the Lead's nudge names the failure INSTEAD of the unconditional 'whole fleet was resumed too' claim",
    msgs.length === 1 && /1 session\(s\) elsewhere in the fleet failed to resume/.test(msgs[0]) && !/The whole fleet across all projects was resumed too/.test(msgs[0]));

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

  sessions.resumeFleetOnBoot(intent, { resumeOne: () => true, deployStaleness: CLEAN_STALENESS });
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

  const sessions = new SessionService(db, { getPersistablePendingSnapshot: () => ({ texts: [], holds: {} }), isComposerDirty: () => false }, new OrchestrationControl());
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
  check("(W) after the 300ms delay elapses, the captured exit fires with 75 (not a real process.exit)",
    await waitUntil(() => exitCalls.length === 1, 3000) && exitCalls[0] === restart.RESTART_EXIT_CODE); // > the real setTimeout(…, 300) inside requestDaemonRestart, generous bound

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
