import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fe4fdf5e — human-only POST /api/harness/switch-now (SessionService.switchHarnessNow). HERMETIC, CLAUDE-
// and CODEX-FREE: a real Db + SessionService over fixture rows and a FAKE pty (isAlive/isBusy/enqueueStdin/
// interruptForRedirect/flushPending are recorded; nothing is ever spawned; LOOM_CODEX_BIN is a dead path).
//
// REWRITTEN for card 7955458e's Code Review CRITICAL fix: `resolveAgentSpawn`'s role-based backstop now
// FORCES a resolved codex harness back to claude unconditionally for role:manager (a
// TRANSCRIPT_ROOT_DENY_ROLES member) — so `wanted` can never be "codex" for a manager anymore, regardless
// of an explicit codex profile pin or restrictedTools/etc. The ONLY way a manager can still be
// "off-target" (current !== wanted) is the OPPOSITE direction from before: a row whose CURRENT harness is
// already "codex" (e.g. a pre-existing row from before this fix shipped) now drifts back toward claude.
// This file's fixtures are updated to that shape; the OLD "restrictedTools ⇒ BLOCKED, never nudged"
// scenario is now itself unreachable for this role (recycleHarness's own codexIncompatibilities branch
// never runs, since `wanted` is already forced before it would apply) — that row is renamed
// `m-restricted` and is now asserted PENDING + NUDGED like any other off-target idle manager, not blocked.
//   (1) an IDLE off-target manager (row still codex, wanted now forced to claude) is nudged with the
//       ordinary ContextWatcher-shaped nudge (prefix + shared tail)
//   (2) a BUSY manager is skipped and counted, never nudged
//   (3) the interrupt path (interruptForRedirect / flushPending) is NEVER called
//   (4) `blocked` is now ALWAYS empty for role:manager (the restrictedTools row is pending, not blocked)
//   (5) codex + fleet is refused (409 over REST; {refused} from the service) and nothing is nudged
//   (6) REST: project scope, unknown project 404, route is Tier 0
// NOT COVERED: the real pty busy-gating/drain of the queued nudge (PtyHost is faked), the recycle itself.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-hswitch-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(46318 + (process.pid % 900));
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
const { CONTEXT_RECYCLE_NUDGE_PREFIX, RECYCLE_WIND_DOWN_INSTRUCTIONS } = await import("../dist/orchestration/context-watcher.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const now = new Date().toISOString();
const db = new Db(path.join(TMP, "loom.db"));
const busyIds = new Set();
const calls = { enqueue: [], interrupt: [], flush: [] };
const noPty = () => { throw new Error("harness-switch-now must never spawn"); };
class FakeHost extends PtyHost {
  createPty() { return noPty(); }
  createCodexPty() { return noPty(); }
  isAlive() { return true; }
  isBusy(id) { return busyIds.has(id); }
  enqueueStdin(id, text) { calls.enqueue.push({ id, text }); return { delivered: false, queued: true, position: 0 }; }
  interruptForRedirect(id) { calls.interrupt.push(id); }
  flushPending(id) { calls.flush.push(id); return []; }
}
const host = new FakeHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pA", name: "pA", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pB", name: "pB", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profMgrCodex", name: "profMgrCodex", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
db.insertProfile({ id: "profWCodex", name: "profWCodex", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, harness: "codex" });
const agent = (id, projectId, profileId) => db.insertAgent({ id, projectId, name: id, startupPrompt: id, position: 0, profileId });
agent("aMgrA", "pA", "profMgrCodex"); agent("aMgrB", "pB", "profMgrCodex"); agent("aWorkA", "pA", "profWCodex");
const sess = (id, projectId, agentId, role, extra = {}) =>
  db.insertSession({ id, projectId, agentId, engineSessionId: null, title: null, cwd: TMP, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role, ...extra });
// Managers whose ROW is still codex (pre-existing data) ⇒ off target, since role:manager's resolved
// harness is now UNCONDITIONALLY forced to claude (card 7955458e) — a recycle will move every one of
// these back to claude, restrictedTools or not (that field no longer exempts a manager from anything here).
sess("m-idle", "pA", "aMgrA", "manager", { harness: "codex" });
sess("m-busy", "pA", "aMgrA", "manager", { harness: "codex" });
sess("m-restricted", "pA", "aMgrA", "manager", { harness: "codex", restrictedTools: true });
sess("w-offtarget", "pA", "aWorkA", "worker"); // a worker is pending in the drain, but is NOT a switch-now candidate
sess("m-idle-pB", "pB", "aMgrB", "manager", { harness: "codex" });
busyIds.add("m-busy");

const app = await buildServer({
  db, pty: {}, sessions: svc, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {},
  runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});
const H = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
const post = (url, payload) => app.inject({ method: "POST", url, headers: { ...H, "content-type": "application/json" }, payload: JSON.stringify(payload ?? {}) });
const reset = () => { calls.enqueue.length = 0; calls.interrupt.length = 0; calls.flush.length = 0; };

try {
  // Precondition: the drain really lists all three managers as pending (none blocked anymore — card
  // 7955458e's role-force makes `blocked` structurally empty for role:manager) and the worker too.
  const drain = svc.harnessDrainStatus({ projectId: "pA" });
  check("(0) precondition: drain pending ⊇ {m-idle, m-busy, m-restricted, w-offtarget}, blocked = {} (empty)",
    ["m-idle", "m-busy", "m-restricted", "w-offtarget"].every((i) => drain.pending.some((p) => p.sessionId === i)) &&
    drain.blocked.length === 0);

  const r = svc.switchHarnessNow({ projectId: "pA" });
  check("(1) both idle off-target managers nudged; result names exactly them", same(r.nudged.sort(), ["m-idle", "m-restricted"]));
  const sent = calls.enqueue.find((c) => c.id === "m-idle");
  check("(1) nudge is the ordinary one: shared prefix + shared wind-down tail (imported, not copied)",
    !!sent && sent.text.startsWith(CONTEXT_RECYCLE_NUDGE_PREFIX) && sent.text.endsWith(RECYCLE_WIND_DOWN_INSTRUCTIONS));
  check("(2) busy manager skipped and counted, never enqueued", same(r.skippedBusy, ["m-busy"]) && !calls.enqueue.some((c) => c.id === "m-busy"));
  check("(3) interrupt path never called (interruptForRedirect + flushPending both untouched)", calls.interrupt.length === 0 && calls.flush.length === 0);
  check("(4) blocked is 0 — restrictedTools no longer exempts a manager from anything (the role-force already decided it)", r.blocked === 0);
  check("(4) m-restricted WAS nudged (pending, not blocked, and idle)", calls.enqueue.some((c) => c.id === "m-restricted"));
  check("(4) a worker is never nudged even though it is pending", !calls.enqueue.some((c) => c.id === "w-offtarget"));
  check("(4) EXACT enqueue set = {m-idle, m-restricted}", same(calls.enqueue.map((c) => c.id).sort(), ["m-idle", "m-restricted"]));

  // Negative control: idle the busy manager ⇒ it IS nudged (the skip was the busy flag, not a broken reader).
  reset(); busyIds.delete("m-busy");
  const r2 = svc.switchHarnessNow({ projectId: "pA" });
  check("(2) CONTROL: once idle, m-busy is nudged too", same(r2.nudged.sort(), ["m-busy", "m-idle", "m-restricted"]) && r2.skippedBusy.length === 0);
  busyIds.add("m-busy");

  // (6) REST.
  reset();
  const rest = await post("/api/harness/switch-now", { projectId: "pA" });
  const body = JSON.parse(rest.body);
  check("(6) POST ?projectId=pA → 200 with the same result", rest.statusCode === 200 && same(body.nudged.sort(), ["m-idle", "m-restricted"]) && same(body.skippedBusy, ["m-busy"]));
  reset();
  const restFleet = JSON.parse((await post("/api/harness/switch-now", {})).body);
  check("(6) POST {} (fleet) → nudges both projects' idle managers", same(restFleet.nudged.sort(), ["m-idle", "m-idle-pB", "m-restricted"]));
  check("(6) unknown project → 404", (await post("/api/harness/switch-now", { projectId: "nope" })).statusCode === 404);
  check("(6) the route is Tier 0 (loopback-only)", routeTier("POST", "/api/harness/switch-now") === 0);

  // (5) codex + fleet refusal — platform layer, then a project layer; nothing nudged either way.
  reset();
  db.setPlatformConfig({ harness: { default: "codex", scope: "fleet" } });
  const ref = svc.switchHarnessNow("fleet");
  check("(5) service refuses codex+fleet (platform layer)", typeof ref.refused === "string" && ref.refused.includes("fleet") && !("nudged" in ref));
  const refRest = await post("/api/harness/switch-now", {});
  check("(5) REST → 409 with the refusal", refRest.statusCode === 409 && /fleet/.test(JSON.parse(refRest.body).error));
  check("(5) nothing enqueued under the refusal", calls.enqueue.length === 0 && calls.interrupt.length === 0);
  db.setPlatformConfig({});
  db.setProjectConfig("pB", { harness: { default: "codex", scope: "fleet" } });
  check("(5) project-layer codex+fleet on a scoped call refuses", typeof svc.switchHarnessNow({ projectId: "pB" }).refused === "string");
  check("(5) fleet-wide call refuses when a pending manager's project resolves codex+fleet", typeof svc.switchHarnessNow("fleet").refused === "string");
  db.setProjectConfig("pB", {});
  check("(5) CONTROL: with the layers cleared, the same call proceeds", Array.isArray(svc.switchHarnessNow({ projectId: "pB" }).nudged));
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — switch-now nudges only idle, pending managers; never interrupts; refuses codex+fleet." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
