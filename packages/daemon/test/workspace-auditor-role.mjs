import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// End-User Platform tier card B1: the new `workspace-auditor` SessionRole + its three caller-set-only
// guards. HERMETIC + CLAUDE-FREE: isolated LOOM_HOME, imports dist/* + @loom/shared, a FAKE pty via the
// PtyHost createPty() seam — no daemon, no real claude, no network. Proves the design note
// (`End-User Platform Tier Design` Part B "Containment" + gotchas #5/#6): the new role is caller-set ONLY
// (by the future startWorkspaceAuditor), NEVER mintable via a profile or by the operator/Setup surface.
//
//   GUARD 1 — profiles/validate.ts: validateProfile({role:"workspace-auditor"}) is REJECTED (it's absent
//             from the mintable enum, exactly like "auditor"). Regression: the existing mintable roles
//             still pass and "auditor" is still rejected.
//   GUARD 2 — mcp/setup.ts: setupRoleError("workspace-auditor") returns an error string, so the ungated
//             operator/Setup surface can never mint it. Regression: manager/worker/setup/null still pass;
//             platform/auditor still rejected.
//   GUARD 3 — sessions service + seed gate:
//             (a) PROFILE_SPAWNABLE_ROLES stays {manager,worker}: a profile carrying "workspace-auditor"
//                 is DROPPED TO PLAIN (role null) on a default role-omitted startNew — no silent elevation.
//             (b) isPlatformProfile() is FALSE for it (it gates on platform/auditor only), so the future
//                 bundled "Workspace Auditor" rig (B4) CORE-seeds ungated, NOT LOOM_DEV-gated.
//
// NOTE: nothing here spawns a workspace-auditor SESSION — no startWorkspaceAuditor exists yet (that's B5).
// B1 is JUST the role + guards.
//
// Run: 1) build (turbo builds shared first), 2) node test/workspace-auditor-role.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROLE = "workspace-auditor";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Set LOOM_HOME BEFORE importing dist (paths.ts reads it at import). host.ts opens a per-session log
// under LOGS_DIR (= $LOOM_HOME/logs); create it so the fake-pty spawn's createWriteStream succeeds.
const tmpHome = path.join(os.tmpdir(), `loom-wsaud-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_DEV; // GUARD 3(b) is about the NON-dev (ungated) seed gate

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { setupRoleError } = await import("../dist/mcp/setup.js");
const { isPlatformProfile } = await import("../dist/profiles/seed.js");

try {
  // ===================== GUARD 1 — validateProfile rejects the new role =====================
  check("(G1) validateProfile REJECTS role:'workspace-auditor' (caller-set only, never profile-mintable)",
    validateProfile({ name: "X", role: ROLE }).ok === false);
  check("(G1 regression) validateProfile STILL rejects role:'auditor'",
    validateProfile({ name: "X", role: "auditor" }).ok === false);
  check("(G1 regression) validateProfile still accepts the mintable roles (manager/worker/platform/setup) + null",
    ["manager", "worker", "platform", "setup"].every((r) => validateProfile({ name: "X", role: r }).ok === true) &&
    validateProfile({ name: "X", role: null }).ok === true);

  // ===================== GUARD 2 — the operator/Setup surface refuses to mint it =====================
  check("(G2) setupRoleError('workspace-auditor') returns an error (operator can never mint it)",
    typeof setupRoleError(ROLE) === "string" && setupRoleError(ROLE).length > 0);
  check("(G2 regression) setupRoleError still rejects platform + auditor",
    typeof setupRoleError("platform") === "string" && typeof setupRoleError("auditor") === "string");
  check("(G2 regression) setupRoleError still ALLOWS manager/worker/setup/null (returns null)",
    setupRoleError("manager") === null && setupRoleError("worker") === null &&
    setupRoleError("setup") === null && setupRoleError(null) === null);

  // ===================== GUARD 3(b) — isPlatformProfile is FALSE for it (ungated CORE seed) =====================
  check("(G3b) isPlatformProfile({role:'workspace-auditor'}) === false (NOT platform-gated → ungated CORE seed)",
    isPlatformProfile({ role: ROLE }) === false);
  check("(G3b regression) isPlatformProfile is still TRUE for platform + auditor (no gate regression)",
    isPlatformProfile({ role: "platform" }) === true && isPlatformProfile({ role: "auditor" }) === true);
  check("(G3b regression) isPlatformProfile is false for manager/worker/setup/null (ungated, unchanged)",
    [ "manager", "worker", "setup", null ].every((r) => isPlatformProfile({ role: r }) === false));

  // ===================== GUARD 3(a) — a workspace-auditor PROFILE is dropped to plain on a default spawn ===========
  // A REAL Db + SessionService driven against a FAKE pty (the createPty seam) — no real claude. A
  // role-omitted startNew (the "+New" / POST /api/agents/:id/sessions default branch) resolves the
  // profile role; PROFILE_SPAWNABLE_ROLES = {manager,worker} clamps anything else to a plain (role-null)
  // session, so an agent carrying a workspace-auditor profile can never silently elevate.
  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) {
      this.capture.push(opts);
      return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} };
    }
  }
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
    onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  const now = new Date().toISOString();
  db.insertProject({ id: "pW", name: "P", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  // Insert the elevated-role profile via the raw db (validateProfile would reject it — exactly the point:
  // a mis-seeded/edited row could carry it, and the spawn-side clamp is the backstop regardless).
  db.insertProfile({ id: "profWs", name: "WsAuditRig", role: ROLE, description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentWs", projectId: "pW", name: "WsProfiled", startupPrompt: "AGENT_WS_PROMPT", position: 0, profileId: "profWs" });
  // Regression control: a worker-role profile (worker IS profile-spawnable) must be UNCHANGED.
  db.insertProfile({ id: "profWk", name: "WkRig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agentWk", projectId: "pW", name: "WkProfiled", startupPrompt: "AGENT_WK_PROMPT", position: 1, profileId: "profWk" });

  const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

  const s = svc.startNew("agentWs");
  const o = optsFor(s.id);
  check("(G3a) workspace-auditor profile default spawn: returned session.role is NOT 'workspace-auditor'", s.role !== ROLE);
  check("(G3a) workspace-auditor profile default spawn: DB role is null (dropped to plain)", db.getSession(s.id).role === null);
  check("(G3a) workspace-auditor profile default spawn: opts.role undefined (plain MCP surface, no elevation)", o?.role === undefined);

  const sWk = svc.startNew("agentWk");
  check("(G3a regression) worker-profile default spawn: role=worker preserved EXACTLY (worker is profile-spawnable)",
    sWk.role === "worker" && db.getSession(sWk.id).role === "worker" && optsFor(sWk.id)?.role === "worker");

  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* retry (WAL handle on Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — 'workspace-auditor' is caller-set only: validateProfile rejects it, the operator/Setup surface rejects it, it drops to plain on a profile spawn, and isPlatformProfile is false (ungated CORE seed)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
