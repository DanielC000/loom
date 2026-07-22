import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 540a3281 (multi-repo epic 49136451's last gap): on a `PATCH /api/projects/:id` whose `repos`
// registry ACTUALLY changes, live manager AND platform (Lead) sessions for that project get a
// `kind:"warning"` `[loom:repo-registry-changed]` operational note naming the added/removed/reconfigured
// keys — because a manager's startup prompt (composeManagerStartupPrompt) is the ONLY other place the
// registry is surfaced, and resume injects nothing (load-bearing invariant), so a manager idle between
// waves — the overwhelmingly likely moment a human edits the registry, since a live WORKTREE session is
// what actually blocks the edit and a manager has none — would otherwise silently keep dispatching every
// card at the stale registry forever.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. Drives the REAL PATCH /api/projects/:id route (not a synthetic
// event) against a REAL PtyHost (fake pty injected via the createPty() seam, mirrors
// enqueue-delivery-reason.mjs) so the assertions exercise the actual writer + the actual enqueueStdin
// rail, not a stand-in for either.
//
// Proves the DoD:
//   (T1) adding a registry entry enqueues a note to a live manager AND a live platform session, naming
//        the added key; the manager's note is NOT prefixed with the project name (already scoped to it),
//        the platform note IS (it spans every project).
//   (T2) removing a registry entry enqueues a note naming the removed key.
//   (T3) reconfiguring an existing key (gateCommand added, path unchanged) enqueues a note naming it as
//        reconfigured — not silently folded into "nothing to report".
//   (T4) a NO-OP PATCH (echoing the exact current registry) enqueues NOTHING to either session.
//   (T5) the SIBLING repoPath-rebind branch (repos omitted, repoPath changes, existing repos revalidated
//        as-is) enqueues NOTHING — the "guard on one path, silently absent on its sibling" shape this
//        codebase keeps producing, turned into an assertion instead of resting on code-reading alone.
//   (T6) a live session whose `pty.enqueueStdin` THROWS (simulating a mid-teardown race) never turns the
//        PATCH into an error — it still 200s and the registry write still persists.
//
// Run: 1) build (turbo builds shared first), 2) node test/repo-registry-notify.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-reponotify-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45324";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");

// --- Real temp git repos: valid registry targets. ---
const mkRepo = (tag) => {
  const r = path.join(os.tmpdir(), `loom-reponotify-${tag}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(r, { recursive: true });
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git add . && git -c user.email=r@loom -c user.name=r commit -q -m init`, { cwd: r });
  return r;
};
const primary = mkRepo("primary");
const svcA = mkRepo("svc-a");
const primary2 = mkRepo("primary2"); // a distinct repo for the repoPath-rebind scenario (T5)

const now = new Date().toISOString();

function makeFakePty() {
  return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
}

// Records every enqueueStdin call (sessionId + text) BEFORE delegating to the real implementation, so
// assertions can inspect exactly what was sent to which session without depending on live/busy/ready
// timing — while still exercising the REAL host.enqueueStdin (queueing, sanitization, etc.) underneath.
// `throwFor` lets ONE test (T6) simulate the "pty mid-teardown" race the route's own comment describes.
class RecordingHost extends PtyHost {
  constructor(events) {
    super(events);
    this.calls = [];
    this.throwFor = null;
  }
  createPty() { return makeFakePty(); }
  enqueueStdin(sessionId, text, ...rest) {
    this.calls.push({ sessionId, text });
    if (this.throwFor && sessionId === this.throwFor) throw new Error("simulated pty mid-teardown race");
    return super.enqueueStdin(sessionId, text, ...rest);
  }
}

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

const db = new Db(path.join(tmpHome, "test.db"));
const host = new RecordingHost(events);
const app = await buildServer({ db, pty: host, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, control: {}, usageStatus: {} });

// A real "live" session, for both DB visibility (listLiveManagersInProject / listLivePlatformSessions)
// AND the pty layer (so enqueueStdin has somewhere real to deliver, mirroring enqueue-delivery-reason.mjs).
function spawnLiveSession(id, projectId, role) {
  db.insertAgent({ id: `agent-${id}`, projectId, name: id, startupPrompt: "X", position: 0, profileId: null });
  db.insertSession({
    id, projectId, agentId: `agent-${id}`, engineSessionId: null, title: null, cwd: primary,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role, parentSessionId: null,
  });
  host.spawn({
    sessionId: id, cwd: primary,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(id, { hook_event_name: "SessionStart" }); // ready + idle
}

try {
  const proj = db.insertProject({
    id: "pA", name: "Alpha Project", repoPath: primary, vaultPath: primary, config: {}, createdAt: now,
    archivedAt: null, reserved: false, repos: [],
  });
  const MGR = "mgr-1";
  const LEAD = "lead-1";
  spawnLiveSession(MGR, "pA", "manager");
  spawnLiveSession(LEAD, "pA", "platform");

  const callsFor = (id) => host.calls.filter((c) => c.sessionId === id);
  const clearCalls = () => { host.calls.length = 0; };

  // =====================================================================================================
  // (T1) ADD — a fresh registry entry enqueues a note to BOTH the manager and the platform session.
  // =====================================================================================================
  {
    const res = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repos: [{ key: "svc-a", path: svcA }] } });
    check("(T1) PATCH adding a registry entry -> 200", res.statusCode === 200);
    check("(T1) DB persisted the new entry", db.getProject("pA")?.repos?.length === 1);

    const mgrCalls = callsFor(MGR);
    const leadCalls = callsFor(LEAD);
    check("(T1) exactly one note enqueued to the live manager", mgrCalls.length === 1);
    check("(T1) exactly one note enqueued to the live platform session", leadCalls.length === 1);
    check("(T1) manager note is tagged [loom:repo-registry-changed]", /\[loom:repo-registry-changed\]/.test(mgrCalls[0]?.text ?? ""));
    check("(T1) manager note names the added key", /added: `svc-a`/.test(mgrCalls[0]?.text ?? ""));
    check("(T1) manager note restates repoKey dispatch (unset = primary)", /repoKey/.test(mgrCalls[0]?.text ?? "") && /primary/.test(mgrCalls[0]?.text ?? ""));
    check("(T1) manager note is NOT prefixed with the project name (already scoped to it)", !/Alpha Project/.test(mgrCalls[0]?.text ?? ""));
    check("(T1) platform note ALSO names the added key", /added: `svc-a`/.test(leadCalls[0]?.text ?? ""));
    check("(T1) platform note IS prefixed with the project name (spans every project)", /Alpha Project/.test(leadCalls[0]?.text ?? ""));
    clearCalls();
  }

  // =====================================================================================================
  // (T4) NO-OP — echoing the exact current registry enqueues NOTHING to either session.
  // =====================================================================================================
  {
    const current = db.getProject("pA").repos;
    const res = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repos: current } });
    check("(T4) no-op PATCH -> 200", res.statusCode === 200);
    check("(T4) no note enqueued to the manager", callsFor(MGR).length === 0);
    check("(T4) no note enqueued to the platform session", callsFor(LEAD).length === 0);
    clearCalls();
  }

  // =====================================================================================================
  // (T3) UPDATED — reconfiguring an existing key (adding a gateCommand, same path) enqueues a note
  // naming it as reconfigured — distinct from added/removed.
  // =====================================================================================================
  {
    const res = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repos: [{ key: "svc-a", path: svcA, gateCommand: "npm test" }] } });
    check("(T3) PATCH reconfiguring an existing key -> 200", res.statusCode === 200);
    const mgrCalls = callsFor(MGR);
    check("(T3) exactly one note enqueued to the manager", mgrCalls.length === 1);
    check("(T3) note names svc-a as reconfigured, not added/removed", /reconfigured[^`]*`svc-a`/.test(mgrCalls[0]?.text ?? ""));
    check("(T3) note does NOT claim svc-a was added", !/added: `svc-a`/.test(mgrCalls[0]?.text ?? ""));
    check("(T3) note does NOT claim svc-a was removed", !/removed: `svc-a`/.test(mgrCalls[0]?.text ?? ""));
    clearCalls();
  }

  // =====================================================================================================
  // (T2) REMOVE — clearing the registry enqueues a note naming the removed key.
  // =====================================================================================================
  {
    const res = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repos: [] } });
    check("(T2) PATCH removing the entry -> 200", res.statusCode === 200);
    check("(T2) DB persisted the removal", db.getProject("pA")?.repos?.length === 0);
    const mgrCalls = callsFor(MGR);
    check("(T2) exactly one note enqueued to the manager", mgrCalls.length === 1);
    check("(T2) note names the removed key", /removed: `svc-a`/.test(mgrCalls[0]?.text ?? ""));
    check("(T2) note warns a still-targeting card 400s at write time", /400/.test(mgrCalls[0]?.text ?? ""));
    clearCalls();
  }

  // =====================================================================================================
  // (T5) The SIBLING repoPath-rebind branch (repos OMITTED, repoPath changes, existing repos revalidated
  // as-is) must enqueue NOTHING — the diff there is always empty by construction, asserted rather than
  // just reasoned about.
  // =====================================================================================================
  {
    // Re-seed a registry entry first so the rebind branch actually has something to revalidate.
    const seedRes = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repos: [{ key: "svc-a", path: svcA }] } });
    check("(T5 setup) re-seeding the registry entry -> 200", seedRes.statusCode === 200);
    clearCalls(); // the re-seed itself is a real add and would (correctly) notify — clear before the real T5 assertion

    const rebindRes = await app.inject({ method: "PATCH", url: "/api/projects/pA", payload: { repoPath: primary2 } });
    check("(T5) repoPath rebind (repos omitted) -> 200", rebindRes.statusCode === 200);
    check("(T5) repoPath actually rebound", db.getProject("pA")?.repoPath === primary2);
    check("(T5) registry entry survives the rebind unchanged", db.getProject("pA")?.repos?.length === 1);
    check("(T5) NO note enqueued to the manager on the rebind branch", callsFor(MGR).length === 0);
    check("(T5) NO note enqueued to the platform session on the rebind branch", callsFor(LEAD).length === 0);
    clearCalls();
  }

  // =====================================================================================================
  // (T6) A live session whose enqueueStdin THROWS (mid-teardown race) must never fail the PATCH — the
  // write already succeeded and is not allowed to be undone or reported as an error by a best-effort nudge.
  // =====================================================================================================
  {
    const proj2 = db.insertProject({
      id: "pB", name: "Beta Project", repoPath: primary2, vaultPath: primary2, config: {}, createdAt: now,
      archivedAt: null, reserved: false, repos: [],
    });
    const THROWY = "mgr-throwy";
    spawnLiveSession(THROWY, "pB", "manager");
    clearCalls();
    host.throwFor = THROWY;
    try {
      const res = await app.inject({ method: "PATCH", url: "/api/projects/pB", payload: { repos: [{ key: "svc-a", path: svcA }] } });
      check("(T6) PATCH still 200s despite the notify target throwing", res.statusCode === 200);
      check("(T6) the registry write still persisted", db.getProject("pB")?.repos?.length === 1);
      check("(T6) the throwing call was actually attempted (not silently skipped)", callsFor(THROWY).length === 1);
    } finally {
      host.throwFor = null;
    }
  }
} finally {
  db.close();
  for (const d of [tmpHome, primary, svcA, primary2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PATCH /api/projects/:id notifies live manager + platform sessions ([loom:repo-registry-changed], kind:\"warning\") on a REAL repos registry change, naming added/removed/reconfigured keys; a no-op PATCH and the sibling repoPath-rebind branch enqueue nothing; a throwing notify target never fails the write; manager/platform note asymmetry (project name) holds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
