import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C2 — inject the built-in Codescape MCP for agents on a
// LOOM_DEV Codescape-enabled project. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// deja-corpus-spawn.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam, and a FAKE CodescapeSupervisor (just
// `getPort()`) injected via SessionService's `opts.codescape` — no real supervisor process, no real
// claude spawn.
//
// Proves the DoD:
//   (helpers) shared/src/config.ts's `codescape.enabled` resolves default-false / per-project-override
//       through resolveConfig; paths.ts's `isCodescapeEnabled` combines the daemon-wide supervisor gate
//       with the per-project flag; git/worktrees.ts's `codescapeWorktreeId` derives the SAME key as
//       `taskKey` (worktree branch/dir naming), null for a taskless/non-worktree session.
//   (a) buildMcpServers mounts `{type:"http", url}` (loom-tasks' shape, NOT transport:"streamable-http")
//       for "codescape" iff codescapeEnabled && isLoomDev() && a non-null port — a WORKTREE session gets
//       the 3-segment `<projectId>/<worktreeId>` URL, a non-worktree (manager/plain) session gets the
//       2-segment `<projectId>` URL (no "main" sentinel).
//   NEGATIVE CASE x3 (byte-identical to a no-flag spawn): LOOM_DEV off / codescapeEnabled false (project
//       not enabled) / port null.
//   (b) CODESCAPE_TOOL_ALLOW carries exactly the 7 read tools, none of the 5 control/write tools; createPty
//       allowlists them iff the mcpServers map actually carries the "codescape" entry.
//   plus end-to-end: startManager/spawnWorker thread codescapeEnabled/codescapePort/projectId/worktreeId
//       through SessionService → spawn opts, reading the project's resolved config + the injected fake
//       supervisor's port — a manager gets worktreeId undefined, a worker gets taskKey(taskId).
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-mcp-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// The isLoomDev() gate check below needs the TRUE default-off state — delete any inherited LOOM_DEV=1
// (e.g. this test running inside a LOOM_DEV=1 self-hosting/orchestration shell; mirrors deja-corpus-spawn.mjs).
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, CODESCAPE_TOOL_ALLOW } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { isLoomDev, isCodescapeSupervisorEnabled, isCodescapeEnabled } = await import("../dist/paths.js");
const { taskKey, codescapeWorktreeId } = await import("../dist/git/worktrees.js");
const { resolveConfig } = await import("@loom/shared");

// ===================== shared config: codescape.enabled default-false / per-project override =====================
check("(config) default resolveConfig(undefined) ⇒ codescape.enabled === false", resolveConfig(undefined).codescape.enabled === false);
check("(config) resolveConfig({}) ⇒ codescape.enabled === false", resolveConfig({}).codescape.enabled === false);
check("(config) resolveConfig({codescape:{enabled:true}}) ⇒ true", resolveConfig({ codescape: { enabled: true } }).codescape.enabled === true);
check("(config) resolveConfig({codescape:{enabled:false}}) ⇒ false", resolveConfig({ codescape: { enabled: false } }).codescape.enabled === false);

// ===================== isCodescapeEnabled: daemon-wide supervisor gate AND the per-project flag =====================
check("(gate) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
check("(gate) isCodescapeSupervisorEnabled() is FALSE by default", isCodescapeSupervisorEnabled() === false);
check("(gate) isCodescapeEnabled: LOOM_DEV off + project enabled ⇒ still false (daemon-wide gate wins)",
  isCodescapeEnabled({ codescape: { enabled: true } }) === false);
process.env.LOOM_DEV = "1";
check("(gate) LOOM_DEV=1 alone (LOOM_CODESCAPE_ENABLED unset) ⇒ isCodescapeEnabled still false",
  isCodescapeEnabled({ codescape: { enabled: true } }) === false);
process.env.LOOM_CODESCAPE_ENABLED = "1";
check("(gate) LOOM_DEV=1 + LOOM_CODESCAPE_ENABLED=1 + project enabled ⇒ true",
  isCodescapeEnabled({ codescape: { enabled: true } }) === true);
check("(gate) daemon-wide gate on but project NOT enabled ⇒ false",
  isCodescapeEnabled({ codescape: { enabled: false } }) === false);
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;

// ===================== codescapeWorktreeId: same key as taskKey, null for no taskId =====================
const tid = "11111111-1111-4111-8111-111111111111";
check("(worktreeId) codescapeWorktreeId(taskId) === taskKey(taskId)", codescapeWorktreeId(tid) === taskKey(tid));
check("(worktreeId) codescapeWorktreeId(null) === null", codescapeWorktreeId(null) === null);
check("(worktreeId) codescapeWorktreeId(undefined) === null", codescapeWorktreeId(undefined) === null);

// ===================== CODESCAPE_TOOL_ALLOW: exactly the 7 read tools, none of the 5 write tools =====================
const expectedRead = ["mcp__codescape__list_flows", "mcp__codescape__trace_flow", "mcp__codescape__what_touches",
  "mcp__codescape__describe_symbol", "mcp__codescape__render_tree", "mcp__codescape__boundary_map", "mcp__codescape__scenario_space"];
const forbiddenWrite = ["mcp__codescape__focus_flow", "mcp__codescape__highlight", "mcp__codescape__open_view",
  "mcp__codescape__annotate", "mcp__codescape__show_diff"];
check("(allowlist) CODESCAPE_TOOL_ALLOW has exactly the 7 read tools",
  CODESCAPE_TOOL_ALLOW.length === 7 && expectedRead.every((t) => CODESCAPE_TOOL_ALLOW.includes(t)));
check("(allowlist) CODESCAPE_TOOL_ALLOW contains NONE of the 5 control/write tools",
  forbiddenWrite.every((t) => !CODESCAPE_TOOL_ALLOW.includes(t)));

// ===================== buildMcpServers: NEGATIVE CASE x3 — byte-identical to a no-flag spawn =====================
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });

// (1) LOOM_DEV off, project enabled, port present.
delete process.env.LOOM_DEV;
const devOff = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, codescapePort: 5555, projectId: "projA", worktreeId: "wtA" });
check("(neg-1) LOOM_DEV off ⇒ NO 'codescape' entry", !("codescape" in devOff));
check("(neg-1) LOOM_DEV off ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(devOff) === JSON.stringify(noFlag));

// (2) LOOM_DEV on, project NOT enabled (codescapeEnabled: false), port present.
process.env.LOOM_DEV = "1";
const notEnabled = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: false, codescapePort: 5555, projectId: "projA", worktreeId: "wtA" });
check("(neg-2) project not enabled ⇒ NO 'codescape' entry", !("codescape" in notEnabled));
check("(neg-2) project not enabled ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(notEnabled) === JSON.stringify(noFlag));

// (3) LOOM_DEV on, project enabled, port null (supervisor down/disabled).
const portNull = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, codescapePort: null, projectId: "projA", worktreeId: "wtA" });
check("(neg-3) port null ⇒ NO 'codescape' entry (clean-skip, never throws)", !("codescape" in portNull));
check("(neg-3) port null ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(portNull) === JSON.stringify(noFlag));

// unset entirely (no codescapeEnabled key at all) ⇒ also byte-identical (fully additive).
const unset = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapePort: 5555, projectId: "projA" });
check("(neg-4) codescapeEnabled unset ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(unset) === JSON.stringify(noFlag));

// ===================== buildMcpServers: positive — worker (3-segment) vs manager/plain (2-segment) =====================
const workerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, codescapePort: 5555, projectId: "projA", worktreeId: "wtA" });
check("(a) worker: 'codescape' entry present", "codescape" in workerOn);
check("(a) worker: entry shape is {type:'http', url} (loom-tasks shape, NOT transport:'streamable-http')",
  workerOn.codescape.type === "http" && typeof workerOn.codescape.url === "string" && !("transport" in workerOn.codescape));
check("(a) worker: URL is 3-segment <projectId>/<worktreeId>", workerOn.codescape.url === "http://127.0.0.1:5555/mcp/projA/wtA");

const managerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "manager", codescapeEnabled: true, codescapePort: 5555, projectId: "projA" });
check("(a) manager (no worktreeId): URL is 2-segment <projectId> (no 'main' sentinel)",
  managerOn.codescape.url === "http://127.0.0.1:5555/mcp/projA");

const plainOn = buildMcpServers({ sessionId: "s1", port: 4317, codescapeEnabled: true, codescapePort: 5555, projectId: "projA" });
check("(a) plain (role-less) session also gets the 2-segment scope (orthogonal to role, like deja)",
  plainOn.codescape.url === "http://127.0.0.1:5555/mcp/projA");

// ON adds exactly the codescape key, nothing else changes vs the negative-case map.
check("(a) ON adds exactly the codescape key (everything else unchanged)",
  JSON.stringify({ ...workerOn, codescape: undefined }) === JSON.stringify({ ...notEnabled, codescape: undefined }));

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
const repo = path.join(os.tmpdir(), `loom-cs-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codescape-mcp-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=cs@loom -c user.name=cs commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Project A: codescape enabled. Project B: codescape NOT enabled (default).
db.insertProject({ id: "pA", name: "A", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrA", projectId: "pA", name: "Mgr", startupPrompt: "MGR_PROMPT", position: 0, profileId: null });
db.insertAgent({ id: "agentWorkerA", projectId: "pA", name: "Worker", startupPrompt: "WORKER_PROMPT", position: 1, profileId: null });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const fakeSupervisor = { getPort: () => 5555 };
const svc = new SessionService(db, host, new OrchestrationControl(), { codescape: fakeSupervisor });
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let workerWorktree = null;
try {
  const mgrA = svc.startManager("agentMgrA");
  const oMgrA = optsFor(mgrA.id);
  check("(e2e) manager: opts.codescapeEnabled === true (project A opted in)", oMgrA?.codescapeEnabled === true);
  check("(e2e) manager: opts.codescapePort === 5555 (from the injected fake supervisor)", oMgrA?.codescapePort === 5555);
  check("(e2e) manager: opts.projectId === 'pA'", oMgrA?.projectId === "pA");
  check("(e2e) manager: opts.worktreeId is undefined (non-worktree session)", oMgrA?.worktreeId === undefined);
  const mgrMcp = buildMcpServers({ sessionId: mgrA.id, port: 4317, role: oMgrA.role, codescapeEnabled: oMgrA.codescapeEnabled, codescapePort: oMgrA.codescapePort, projectId: oMgrA.projectId, worktreeId: oMgrA.worktreeId });
  check("(e2e) manager: mcpServers has the 2-segment codescape entry", mgrMcp.codescape?.url === "http://127.0.0.1:5555/mcp/pA");

  const tW1 = "22222222-2222-4222-8222-222222222222";
  db.insertTask({ id: tW1, projectId: "pA", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const worker = await svc.spawnWorker(mgrA.id, { taskId: tW1, agentId: "agentWorkerA", kickoffPrompt: "GO" });
  workerWorktree = worker.worktreePath;
  const oWorker = optsFor(worker.id);
  check("(e2e) worker: opts.codescapeEnabled === true", oWorker?.codescapeEnabled === true);
  check("(e2e) worker: opts.worktreeId === taskKey(taskId)", oWorker?.worktreeId === taskKey(tW1));
  const workerMcp = buildMcpServers({ sessionId: worker.id, port: 4317, role: oWorker.role, codescapeEnabled: oWorker.codescapeEnabled, codescapePort: oWorker.codescapePort, projectId: oWorker.projectId, worktreeId: oWorker.worktreeId });
  check("(e2e) worker: mcpServers has the 3-segment codescape entry", workerMcp.codescape?.url === `http://127.0.0.1:5555/mcp/pA/${taskKey(tW1)}`);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_ENABLED;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape MCP wiring (card C2): shared config default-false/per-project-override; isCodescapeEnabled combines the daemon-wide + per-project gates; codescapeWorktreeId mirrors taskKey; buildMcpServers mounts the {type:'http',url} entry (3-segment worker / 2-segment manager) iff enabled+isLoomDev+port, with all 3 negative cases byte-identical off; the 7-tool read-only allowlist excludes the 5 write tools; the flags thread through startManager/spawnWorker — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
