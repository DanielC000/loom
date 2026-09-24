import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3d8edea5 (multi-harness epic df1f94b0) — the derived harness DRAIN-STATUS read model
// (SessionService.harnessDrainStatus) and its human-only REST GET (/api/harness/drain). HERMETIC, CLAUDE-
// and CODEX-FREE: a real Db + SessionService over fixture rows, nothing is ever spawned (the pty host is
// never asked to create a pty; both createPty/createCodexPty are faked anyway and LOOM_CODEX_BIN points at
// a dead path as a loud backstop).
//   (1) EXACT pending set over a mix of harnesses/roles/live/exited/archived/projects, under a platform
//       codex default; then again after the default is flipped back (proves it is DERIVED, not stored).
//   (2) scope narrowing: project scope returns only that project's rows; done:true when nothing differs.
//   (3) a Profile harness pin beats the default in BOTH directions (the real resolver is reused).
//   (4) REST: fleet, ?projectId=, unknown project 404, and the route is Tier 0 (loopback-only).
// NOT COVERED: the web surface, switch-now, the optional drain-complete event (deliberately omitted).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-hdrain-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(45318 + (process.pid % 900));
const PORT = process.env.LOOM_PORT;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
process.env.LOOM_CODEX_BIN = path.join(TMP, "no-such-codex-binary");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const ids = (r) => r.pending.map((p) => p.sessionId).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
const noPty = () => { throw new Error("harness-drain-status must never spawn"); };
class NoSpawnHost extends PtyHost { createPty() { return noPty(); } createCodexPty() { return noPty(); } }
const host = new NoSpawnHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

for (const id of ["pA", "pB"]) db.insertProject({ id, name: id, repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
const prof = (id, role, harness) => db.insertProfile({ id, name: id, role, description: "", allowDelta: [], skills: null, model: null, icon: null, ...(harness ? { harness } : {}) });
prof("profWClaude", "worker", "claude");
prof("profWCodex", "worker", "codex");
prof("profMgr", "manager");
const agent = (id, projectId, profileId) => db.insertAgent({ id, projectId, name: id, startupPrompt: id, position: 0, profileId });
agent("aPlainA", "pA", null); agent("aClaudeA", "pA", "profWClaude"); agent("aCodexA", "pA", "profWCodex"); agent("aMgrA", "pA", "profMgr"); agent("aPlainB", "pB", null);

const sess = (id, projectId, agentId, role, harness, processState = "live", extra = {}) =>
  db.insertSession({ id, projectId, agentId, engineSessionId: null, title: null, cwd: TMP, processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...(harness ? { harness } : {}), ...extra });
sess("s1-worker-plain-claude", "pA", "aPlainA", "worker", null);
sess("s2-worker-plain-codex", "pA", "aPlainA", "worker", "codex");
sess("s3-worker-claudepin-claude", "pA", "aClaudeA", "worker", null);
sess("s4-worker-codexpin-claude", "pA", "aCodexA", "worker", null);
sess("s5-mgr-claude", "pA", "aMgrA", "manager", null);
sess("s6-mgr-codex", "pA", "aMgrA", "manager", "codex");
sess("s7-worker-plain-claude-EXITED", "pA", "aPlainA", "worker", null, "exited");
sess("s8-worker-plain-claude-ARCHIVED", "pA", "aPlainA", "worker", null);
db.archiveSession("s8-worker-plain-claude-ARCHIVED");
sess("s9-worker-plain-claude-pB", "pB", "aPlainB", "worker", null);

const app = await buildServer({
  db, pty: {}, sessions: svc, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {},
  runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
const get = (url) => app.inject({ method: "GET", url, headers: H });

try {
  // (0) nothing configured: a fresh spawn would pick claude for everything ⇒ only the codex-row sessions differ.
  const r0 = svc.harnessDrainStatus("fleet");
  check("(0) no default set: pending = the two non-claude rows whose spawn now resolves differently (s2 codex, s6 codex; s4 pins codex vs row claude)",
    same(ids(r0), ["s2-worker-plain-codex", "s4-worker-codexpin-claude", "s6-mgr-codex"]));

  // (1) platform default codex (worker scope): plain workers now want codex.
  db.setPlatformConfig({ harness: { default: "codex" } });
  const r1 = svc.harnessDrainStatus("fleet");
  check("(1) EXACT fleet pending under platform default codex = {s1, s4, s6, s9}",
    same(ids(r1), ["s1-worker-plain-claude", "s4-worker-codexpin-claude", "s6-mgr-codex", "s9-worker-plain-claude-pB"]));
  check("(1) target is codex; scope echoed; done false", r1.target === "codex" && r1.scope === "fleet" && r1.done === false);
  check("(1) exited (s7) and archived (s8) rows are excluded; already-matching rows (s2,s3,s5) are excluded",
    !ids(r1).some((i) => /^s(2|3|5|7|8)-/.test(i)));
  const s1 = r1.pending.find((p) => p.sessionId === "s1-worker-plain-claude");
  check("(1) a pending row carries {sessionId, role, harness (the CURRENT one), projectId}",
    s1 && s1.role === "worker" && s1.harness === "claude" && s1.projectId === "pA");
  const s6 = r1.pending.find((p) => p.sessionId === "s6-mgr-codex");
  check("(1) a manager on codex is pending because the default does NOT reach managers (wanted claude)", s6 && s6.harness === "codex" && s6.role === "manager");

  // (2) scope narrowing.
  check("(2) project pA scope = {s1, s4, s6}", same(ids(svc.harnessDrainStatus({ projectId: "pA" })), ["s1-worker-plain-claude", "s4-worker-codexpin-claude", "s6-mgr-codex"]));
  check("(2) project pB scope = {s9}", same(ids(svc.harnessDrainStatus({ projectId: "pB" })), ["s9-worker-plain-claude-pB"]));
  db.setProjectConfig("pB", { harness: { default: "claude" } });
  const rB = svc.harnessDrainStatus({ projectId: "pB" });
  check("(2) a project override back to claude empties pB's pending and reports done:true / target claude",
    rB.pending.length === 0 && rB.done === true && rB.target === "claude");
  check("(2) NEGATIVE CONTROL: fleet pending shrinks by exactly s9 after that override (the override, not a broken reader)",
    same(ids(svc.harnessDrainStatus("fleet")), ["s1-worker-plain-claude", "s4-worker-codexpin-claude", "s6-mgr-codex"]));
  db.setProjectConfig("pB", {});

  // (3) derived, not stored: flip the default back and the set recomputes with no bookkeeping.
  db.setPlatformConfig({ harness: { default: "claude" } });
  check("(3) default flipped back to claude ⇒ pending = {s2, s4, s6} (plain codex row now drifts; s1/s9 no longer do)",
    same(ids(svc.harnessDrainStatus("fleet")), ["s2-worker-plain-codex", "s4-worker-codexpin-claude", "s6-mgr-codex"]));
  db.setPlatformConfig({ harness: { default: "codex" } });
  check("(3) flipping to codex again reproduces the earlier set exactly (no persisted drain state)",
    same(ids(svc.harnessDrainStatus("fleet")), ids(r1)));

  // (2b) done:true on a fleet where everything matches.
  db.setPlatformConfig({});
  for (const id of ["s2-worker-plain-codex", "s4-worker-codexpin-claude", "s6-mgr-codex"]) db.setProcessState(id, "exited");
  const rDone = svc.harnessDrainStatus("fleet");
  check("(2b) every drifting row exited ⇒ pending empty, done:true", rDone.pending.length === 0 && rDone.done === true);
  for (const id of ["s2-worker-plain-codex", "s4-worker-codexpin-claude", "s6-mgr-codex"]) db.setProcessState(id, "live");
  db.setPlatformConfig({ harness: { default: "codex" } });

  // (4) REST.
  const rest = await get("/api/harness/drain");
  const restBody = JSON.parse(rest.body);
  check("(4) GET /api/harness/drain (fleet) → 200 with the SAME exact pending set as the service", rest.statusCode === 200 && same(ids(restBody), ids(r1)) && restBody.done === false && restBody.target === "codex");
  const restA = await get("/api/harness/drain?projectId=pB");
  check("(4) GET ?projectId=pB → 200 narrowed to {s9}", restA.statusCode === 200 && same(ids(JSON.parse(restA.body)), ["s9-worker-plain-claude-pB"]));
  const restBad = await get("/api/harness/drain?projectId=nope");
  check("(4) unknown projectId → 404", restBad.statusCode === 404);
  check("(4) the route is Tier 0 (loopback-only, never allowlisted for a remote bind)", routeTier("GET", "/api/harness/drain") === 0);
  check("(4) POSITIVE CONTROL: routeTier really returns 1 for an allowlisted read", routeTier("GET", "/api/sessions") === 1);

  // (5) card c17ba928: a manager whose OLD ROW carries restrictedTools under a codex profile is BLOCKED (a recycle
  // keeps it on claude — `recycleHarness`), never pending; a same-shaped manager without the field stays pending.
  // Isolated in its own project so the exact sets above are untouched.
  db.insertProject({ id: "pC", name: "pC", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
  prof("profMgrCodex", "manager", "codex");
  agent("aMgrCodexC", "pC", "profMgrCodex");
  sess("s10-mgr-claude-restricted", "pC", "aMgrCodexC", "manager", null, "live", { restrictedTools: true });
  sess("s11-mgr-claude-plain", "pC", "aMgrCodexC", "manager", null);
  const rC = svc.harnessDrainStatus({ projectId: "pC" });
  check("(5) row WITHOUT carried fields is pending (recycle WILL move it)", same(ids(rC), ["s11-mgr-claude-plain"]));
  check("(5) row WITH restrictedTools is blocked, not pending, with the compat reason",
    rC.blocked.length === 1 && rC.blocked[0].sessionId === "s10-mgr-claude-restricted" && rC.blocked[0].wanted === "codex" &&
    rC.blocked[0].harness === "claude" && rC.blocked[0].reasons.some((r) => r.id === "restrictedTools" && r.reason.length > 0));
  check("(5) done false while s11 pending", rC.done === false);
  db.setProcessState("s11-mgr-claude-plain", "exited");
  const rCb = svc.harnessDrainStatus({ projectId: "pC" });
  check("(5) blocked-only scope ⇒ pending empty, blocked 1, done FALSE", rCb.pending.length === 0 && rCb.blocked.length === 1 && rCb.done === false);
  db.setProcessState("s10-mgr-claude-restricted", "exited");
  check("(5) CONTROL: nothing pending or blocked ⇒ done true", svc.harnessDrainStatus({ projectId: "pC" }).done === true);
  db.setProcessState("s10-mgr-claude-restricted", "live");
  db.setProcessState("s11-mgr-claude-plain", "live");
  const restC = JSON.parse((await get("/api/harness/drain?projectId=pC")).body);
  check("(5) REST carries the same blocked list", restC.blocked?.length === 1 && restC.blocked[0].sessionId === "s10-mgr-claude-restricted");
  check("(5) NEGATIVE CONTROL: earlier scopes have no blocked rows", svc.harnessDrainStatus({ projectId: "pA" }).blocked.length === 0);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — harness drain status is an exact, derived, scoped read; REST GET is loopback-only." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
