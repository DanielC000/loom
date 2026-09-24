import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 961da6c6 — a DEFAULT-derived codex harness must not silently strip a safety-scoped agent, the per-role
// fleet allowlist is ONE shared const, and forking a codex session refuses. DETERMINISTIC + CLAUDE/CODEX-FREE:
// a real Db + SessionService against a fake pty on BOTH spawn seams (createPty AND createCodexPty), with
// LOOM_CODEX_BIN pointed at a dead path as a loud backstop. No real claude/codex, no daemon, no network.
//
//   (1) codexIncompatibilities matrix (pure): each field alone, in combination, none; reasons are the SAME strings
//       validateProfile uses (one source).
//   (2) spawnWorker under a codex default: a worker profile needing restrictedTools / browserTesting /
//       documentConversion / capabilities / codescape STAYS claude + files a durable harness_default_skipped event
//       (exact attribution); a compatible profile still gets codex; an EXPLICIT codex profile is untouched.
//   (3) HARNESS_FLEET_ROLES: scope:'fleet' rejected while it is ["worker"]; a temporarily WIDENED list flips the
//       validator AND harnessDefaultForRole (negative control: the refinement really keys off the const).
//   (4) forkSession refuses a codex-pinned source (typed error, no spawn); a claude source still forks
//       (positive control); the REAL route maps the typed error to a 409 carrying the reason.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-fleet-switch-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cfsg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(tmpHome, "no-such-codex-binary");

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService, CodexForkUnsupportedError } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { harnessDefaultForRole, HARNESS_FLEET_ROLES, harnessFleetScopeAvailable } = await import("@loom/shared");
const { validatePlatformConfigOverride, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { codexIncompatibilities, CODEX_RESTRICTED_TOOLS_REASON, codexStdioCapabilityReason } = await import("../dist/profiles/codex-compat.js");
const { CODEX_CODESCAPE_REASON } = await import("../dist/pty/host.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { buildServer } = await import("../dist/gateway/server.js");

// ============ (1) pure matrix ============
const ids = (input) => codexIncompatibilities(input).map((i) => i.id).join(",");
check("(1) no fields ⇒ compatible (empty list)", ids({}) === "");
check("(1) all-false/empty ⇒ compatible", ids({ restrictedTools: false, browserTesting: false, documentConversion: false, capabilities: [] }) === "");
check("(1) restrictedTools alone", ids({ restrictedTools: true }) === "restrictedTools");
check("(1) browserTesting alone", ids({ browserTesting: true }) === "browserTesting");
check("(1) documentConversion alone", ids({ documentConversion: true }) === "documentConversion");
check("(1) capabilities alone (non-empty)", ids({ capabilities: [{ slug: "x" }] }) === "capabilities");
check("(1) every field ⇒ one item per field, fixed order",
  ids({ restrictedTools: true, browserTesting: true, documentConversion: true, capabilities: [{ slug: "x" }] })
    === "restrictedTools,browserTesting,documentConversion,capabilities");
const reasonOf = (input, id) => codexIncompatibilities(input).find((i) => i.id === id)?.reason;
check("(1) restrictedTools reason IS validateProfile's string (one source)", reasonOf({ restrictedTools: true }, "restrictedTools") === CODEX_RESTRICTED_TOOLS_REASON);
const vRestricted = validateProfile({ name: "r", role: "worker", harness: "codex", restrictedTools: true });
check("(1) validateProfile(codex+restrictedTools) still rejects with that exact string", vRestricted.ok === false && vRestricted.error === CODEX_RESTRICTED_TOOLS_REASON);
const vStdio = validateProfile({ name: "s", role: "worker", harness: "codex", browserTesting: true });
check("(1) validateProfile(codex+browserTesting) still rejects with the shared per-field reason", vStdio.ok === false && vStdio.error === codexStdioCapabilityReason(["browserTesting"]));
check("(1) NEGATIVE CONTROL: a bogus field name yields no incompatibility", ids({ bogusZZZ: true }) === "");

// ============ (2) spawnWorker under a codex default ============
const repo = path.join(os.tmpdir(), `loom-cfsg-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codex-fleet-switch-guard test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=cf@loom -c user.name=cf");

const now = new Date().toISOString();
const db = new Db();
db.setPlatformConfig({ harness: { default: "codex" } }); // the fleet default is codex for the whole run
const baseCfg = { orchestration: { maxConcurrentWorkers: 50 } };
db.insertProject({ id: "pC", name: "C", repoPath: repo, vaultPath: repo, config: baseCfg, createdAt: now, archivedAt: null });
db.insertProject({ id: "pCS", name: "CS", repoPath: repo, vaultPath: repo, config: { ...baseCfg, codescape: { enabled: true } }, createdAt: now, archivedAt: null });
const profile = (id, extra) => db.insertProfile({ id, name: id, role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, ...extra });
profile("profPlain", {});
profile("profRestricted", { restrictedTools: true });
profile("profBrowser", { browserTesting: true });
profile("profDoc", { documentConversion: true });
profile("profCaps", { capabilities: [{ slug: "somecap" }] });
profile("profExplicitCodex", { harness: "codex" });
const agent = (id, projectId, profileId, pos) => db.insertAgent({ id, projectId, name: id, startupPrompt: id, position: pos, profileId });
agent("agPlain", "pC", "profPlain", 0);
agent("agRestricted", "pC", "profRestricted", 1);
agent("agBrowser", "pC", "profBrowser", 2);
agent("agDoc", "pC", "profDoc", 3);
agent("agCaps", "pC", "profCaps", 4);
agent("agExplicit", "pC", "profExplicitCodex", 5);
agent("agPlainCS", "pCS", "profPlain", 0);
agent("agNoProfile", "pC", null, 6);
agent("agMgr", "pC", null, 7);
agent("agMgrCS", "pCS", null, 1);
db.insertSession({
  id: "mgr1", projectId: "pC", agentId: "agMgr", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

db.insertSession({
  id: "mgrCS", projectId: "pCS", agentId: "agMgrCS", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager",
});

const fakePty = () => {
  let exitCb = null;
  return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit(cb) { exitCb = cb; return { dispose() {} }; }, kill() { exitCb?.({ exitCode: 0 }); }, resize() {} };
};
class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return fakePty(); }
  createCodexPty(opts) { this.capture.push(opts); return fakePty(); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);
const worktrees = [];
const spawn = async (agentId, projectId = "pC") => {
  const taskId = randomUUID();
  db.insertTask({ id: taskId, projectId, title: `T-${agentId}`, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  const w = await svc.spawnWorker(projectId === "pCS" ? "mgrCS" : "mgr1", { taskId, agentId, kickoffPrompt: "KICK" });
  worktrees.push(w.worktreePath);
  const skipped = db.listEventsForWorker(w.id).filter((e) => e.kind === "harness_default_skipped");
  return { w, opts: optsFor(w.id), row: db.getSession(w.id), skipped };
};

try {
  const plain = await spawn("agPlain");
  check("(2) POSITIVE CONTROL: a compatible worker under a codex default still spawns codex", plain.opts?.harness === "codex" && plain.row.harness === "codex");
  check("(2) a compatible worker files NO harness_default_skipped event", plain.skipped.length === 0);
  const noProf = await spawn("agNoProfile");
  check("(2) a profile-less worker under a codex default still spawns codex", noProf.opts?.harness === "codex");

  for (const [agentId, field] of [["agRestricted", "restrictedTools"], ["agBrowser", "browserTesting"], ["agDoc", "documentConversion"], ["agCaps", "capabilities"]]) {
    const r = await spawn(agentId);
    check(`(2) ${field} worker STAYS claude under a codex default (opts.harness undefined)`, r.opts?.harness === undefined);
    check(`(2) ${field} worker's session column is NULL (claude)`, r.row.harness === undefined || r.row.harness === null);
    check(`(2) ${field}: exactly one harness_default_skipped event naming it`, r.skipped.length === 1 && r.skipped[0].detail.items.some((i) => i.id === field));
    check(`(2) ${field}: event attribution — manager = spawning manager, worker = the new session`,
      r.skipped[0]?.managerSessionId === "mgr1" && r.skipped[0]?.workerSessionId === r.w.id);
    check(`(2) ${field}: the event carries the SAME reason validateProfile uses`,
      r.skipped[0]?.detail.items.find((i) => i.id === field)?.reason === reasonOf({ restrictedTools: field === "restrictedTools", browserTesting: field === "browserTesting", documentConversion: field === "documentConversion", capabilities: field === "capabilities" ? [{ slug: "x" }] : [] }, field));
  }

  const cs = await spawn("agPlainCS", "pCS");
  check("(2) a codescape-enabled project's worker STAYS claude", cs.opts?.harness === undefined && cs.skipped.length === 1 && cs.skipped[0].detail.items[0].id === "codescape");
  check("(2) the codescape item carries host.ts's one reason string", cs.skipped[0]?.detail.items[0].reason === CODEX_CODESCAPE_REASON);

  const explicit = await spawn("agExplicit");
  check("(2) an EXPLICIT harness:'codex' profile is unchanged (still codex)", explicit.opts?.harness === "codex" && explicit.row.harness === "codex");
  check("(2) an explicit codex profile files no skipped event (the default was never consulted)", explicit.skipped.length === 0);

  // ============ (4) fork ============
  db.insertSession({ id: "srcCodex", projectId: "pC", agentId: "agPlain", engineSessionId: "srcCodex-eng-0000-0000-000000000000", title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: undefined, harness: "codex" });
  const spawnsBefore = host.capture.length;
  const sessionsBefore = db.listSessions("agPlain").length;
  let forkErr = null;
  try { svc.forkSession("srcCodex"); } catch (e) { forkErr = e; }
  check("(4) forking a codex-pinned session throws CodexForkUnsupportedError", forkErr instanceof CodexForkUnsupportedError);
  check("(4) the refusal names the reason (no fork primitive)", /no fork\/branch primitive/.test(forkErr?.message ?? ""));
  check("(4) NOTHING was created: no pty spawn and no new session row", host.capture.length === spawnsBefore && db.listSessions("agPlain").length === sessionsBefore);

  const engId = "srcClaude-eng-0000-0000-000000000000";
  db.insertSession({ id: "srcClaude", projectId: "pC", agentId: "agPlain", engineSessionId: engId, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: undefined });
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  const forked = svc.forkSession("srcClaude");
  check("(4) POSITIVE CONTROL: a claude-pinned source still forks (fork spawn captured with fork:true)", optsFor(forked.id)?.fork === true);

  // The REAL route: a stubbed sessions whose forkSession throws the REAL typed error (from the shared class).
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: { forkSession: (id) => { if (id === "boom") throw new Error("plain failure"); throw new CodexForkUnsupportedError(); } }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const r409 = await app.inject({ method: "POST", url: "/api/sessions/srcCodex/fork" });
  check("(4) POST /api/sessions/:id/fork on a codex source ⇒ 409", r409.statusCode === 409);
  check("(4) the 409 body carries the reason under `error` (what the web client surfaces)", /no fork\/branch primitive/.test(JSON.parse(r409.body).error ?? ""));
  const r500 = await app.inject({ method: "POST", url: "/api/sessions/boom/fork" });
  check("(4) CONTROL: any OTHER fork error is NOT remapped to 409", r500.statusCode !== 409);
  await app.close();
} finally {
  try { const { removeWorktree } = await import("../dist/git/worktrees.js"); for (const wt of worktrees) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } } } catch { /* best-effort */ }
}

// ============ (3) the shared per-role allowlist ============
const ok = (r) => r.ok === true;
const err = (r) => (r.ok === false ? r.error : "");
check("(3) HARNESS_FLEET_ROLES is exactly ['worker'] today (nothing widened by this card)", HARNESS_FLEET_ROLES.length === 1 && HARNESS_FLEET_ROLES[0] === "worker");
check("(3) harnessFleetScopeAvailable() is false while the allowlist is worker-only", harnessFleetScopeAvailable() === false);
const platFleet = validatePlatformConfigOverride({ harness: { scope: "fleet" } });
const projFleet = validateProjectConfigOverride({ harness: { scope: "fleet" } });
check("(3) platform validator still REJECTS scope:'fleet', naming card 4c4eb9af", !ok(platFleet) && err(platFleet).includes("4c4eb9af"));
check("(3) project validator still REJECTS scope:'fleet', naming card 4c4eb9af", !ok(projFleet) && err(projFleet).includes("4c4eb9af"));
check("(3) scope:'workers' still accepted", ok(validatePlatformConfigOverride({ harness: { scope: "workers" } })));
check("(3) a stored fleet scope still reaches ONLY worker (manager stays claude)",
  harnessDefaultForRole({ default: "codex", scope: "fleet" }, "worker") === "codex" && harnessDefaultForRole({ default: "codex", scope: "fleet" }, "manager") === undefined);
HARNESS_FLEET_ROLES.push("manager"); // NEGATIVE CONTROL: a widened list must flip BOTH consumers, then be restored
try {
  check("(3) NEG-CONTROL: widened allowlist ⇒ harnessFleetScopeAvailable() true", harnessFleetScopeAvailable() === true);
  check("(3) NEG-CONTROL: widened allowlist ⇒ the validators now ACCEPT scope:'fleet' (refinement keys off the const)",
    ok(validatePlatformConfigOverride({ harness: { scope: "fleet" } })) && ok(validateProjectConfigOverride({ harness: { scope: "fleet" } })));
  check("(3) NEG-CONTROL: widened allowlist ⇒ harnessDefaultForRole honours fleet for manager", harnessDefaultForRole({ default: "codex", scope: "fleet" }, "manager") === "codex");
  check("(3) NEG-CONTROL: scope:'workers' STILL excludes manager even when the fleet list is widened", harnessDefaultForRole({ default: "codex", scope: "workers" }, "manager") === undefined);
} finally {
  HARNESS_FLEET_ROLES.pop();
}
check("(3) allowlist restored to ['worker'] after the control", HARNESS_FLEET_ROLES.length === 1 && HARNESS_FLEET_ROLES[0] === "worker");

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — a default-derived codex harness skips (and records) codex-incompatible agents, the per-role fleet allowlist is one shared const, and forking a codex session refuses."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
