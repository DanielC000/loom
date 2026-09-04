import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 245c0837 — `held`/`heldBy` were absent from TaskSummary/toTaskSummary (mcp/tasks.ts:33,:325), the
// ONE shared projection feeding BOTH tasks_list (in-project) and list_all_tasks (Platform cross-project
// aggregate, mcp/platform.ts:2572, importing the same toTaskSummary at :57). Absent read as false read as
// "actionable" — the owner's SOLE brake (worker_spawn refuses a held:true card, sessions/service.ts:6831)
// was invisible on both surfaces. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// platform-cross-project-task.mjs: a REAL Db + SessionService against a FAKE pty (PtyHost createPty()
// seam), the REAL routers driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// This is a READ-path regression only — held/heldBy are seeded directly via db.insertTask, never through
// a write tool, since the write/enforcement path (worker_spawn's refusal) is unchanged and out of scope.
//
// Proves the DoD:
//   (1) a held:true card shows held:true (+ the right heldBy) in the default in-project tasks_list summary.
//   (2) the SAME card shows held:true (+ heldBy) in list_all_tasks — the extension nobody had hit yet.
//   (3) the reporter's own positive control survives: deferred still projects AND still varies (true on
//       some rows, false on others) on BOTH surfaces, so a future regression can't pass by dropping both.
//   (4) a non-held card reads held:false, heldBy:null on both surfaces (no false positive either).
//
// Run: 1) build (turbo builds shared first), 2) node test/held-in-task-summary.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-hits-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-hits-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# held-in-task-summary test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=hits@loom -c user.name=hits");

const now = new Date().toISOString();
const db = new Db();

const P = "cafe1234-0000-4000-8000-000000000001";
db.insertProject({ id: P, name: "HeldSummary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentM", projectId: P, name: "Manager", startupPrompt: "M", position: 0, profileId: null });
db.insertSession({ id: "M", projectId: P, agentId: "agentM", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// Four cards spanning the held x deferred matrix, seeded directly (read-path test, not a write-path one).
db.insertTask({ id: "t-held-human", projectId: P, title: "fix(x): owner-held card", body: "b", columnKey: "backlog", position: 0, priority: "p2", createdAt: now, updatedAt: now, held: true, heldBy: "human" });
db.insertTask({ id: "t-held-agent", projectId: P, title: "fix(x): agent-held card", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now, held: true, heldBy: "agent" });
db.insertTask({ id: "t-deferred", projectId: P, title: "fix(x): deferred, not held", body: "b", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now, held: false, deferred: true, deferredReason: "waiting on a blocker" });
db.insertTask({ id: "t-plain", projectId: P, title: "fix(x): plain actionable card", body: "b", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now, held: false, deferred: false });

class SeamHost extends createSeamHost(PtyHost) {
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const wakes = new WakeService({ db, pty: host, resume: () => {} }); // never ticked; TaskMcpRouter only lists/reads tasks here

const ndjson = (res) => {
  const text = res.content[0].text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.rowsFile === "string") {
    return fs.readFileSync(parsed.rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.rows)) return parsed.rows;
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const byId = (rows, id) => rows.find((r) => r.id === id);

try {
  // ===================== (1) in-project tasks_list — default summary =====================
  const inProjServer = new TaskMcpRouter(db, wakes).buildServer(P, "M");
  const [ipClientT, ipServerT] = InMemoryTransport.createLinkedPair();
  await inProjServer.connect(ipServerT);
  const ipClient = new Client({ name: "held-summary-inproj", version: "0" });
  await ipClient.connect(ipClientT);

  const ipRows = ndjson(await ipClient.callTool({ name: "tasks_list", arguments: {} }));
  check("(1) setup: tasks_list returned all four seeded cards", ipRows.length === 4);

  check("(1) tasks_list: human-held card projects held:true, heldBy:\"human\"",
    byId(ipRows, "t-held-human")?.held === true && byId(ipRows, "t-held-human")?.heldBy === "human");
  check("(1) tasks_list: agent-held card projects held:true, heldBy:\"agent\"",
    byId(ipRows, "t-held-agent")?.held === true && byId(ipRows, "t-held-agent")?.heldBy === "agent");
  check("(1) tasks_list: a NON-held card reads held:false, heldBy:null (no false positive)",
    byId(ipRows, "t-plain")?.held === false && byId(ipRows, "t-plain")?.heldBy === null);
  check("(1) tasks_list: the deferred (not held) card reads held:false, heldBy:null",
    byId(ipRows, "t-deferred")?.held === false && byId(ipRows, "t-deferred")?.heldBy === null);

  // (3) positive control, preserved: deferred still projects AND still varies on this same read.
  check("(3) tasks_list: deferred still projects and VARIES (true on t-deferred, false on the rest)",
    byId(ipRows, "t-deferred")?.deferred === true &&
    byId(ipRows, "t-held-human")?.deferred === false &&
    byId(ipRows, "t-held-agent")?.deferred === false &&
    byId(ipRows, "t-plain")?.deferred === false);

  await ipClient.close();

  // ===================== (2) list_all_tasks — the Platform cross-project aggregate =====================
  const platServer = new PlatformMcpRouter(db, svc).buildServer("M");
  const [plClientT, plServerT] = InMemoryTransport.createLinkedPair();
  await platServer.connect(plServerT);
  const plClient = new Client({ name: "held-summary-platform", version: "0" });
  await plClient.connect(plClientT);
  const call = async (name, args) => JSON.parse((await plClient.callTool({ name, arguments: args })).content[0].text);

  const agg = await call("list_all_tasks", { projectId: P });
  const aggRows = Array.isArray(agg) ? agg : agg.tasks;
  check("(2) setup: list_all_tasks returned all four seeded cards", Array.isArray(aggRows) && aggRows.length === 4);

  check("(2) list_all_tasks: human-held card projects held:true, heldBy:\"human\" — the extension nobody had hit yet",
    byId(aggRows, "t-held-human")?.held === true && byId(aggRows, "t-held-human")?.heldBy === "human");
  check("(2) list_all_tasks: agent-held card projects held:true, heldBy:\"agent\"",
    byId(aggRows, "t-held-agent")?.held === true && byId(aggRows, "t-held-agent")?.heldBy === "agent");
  check("(2) list_all_tasks: a NON-held card reads held:false, heldBy:null (no false positive)",
    byId(aggRows, "t-plain")?.held === false && byId(aggRows, "t-plain")?.heldBy === null);

  // (3) same positive control, on the second surface.
  check("(3) list_all_tasks: deferred still projects and VARIES (true on t-deferred, false on the rest)",
    byId(aggRows, "t-deferred")?.deferred === true &&
    byId(aggRows, "t-held-human")?.deferred === false &&
    byId(aggRows, "t-held-agent")?.deferred === false &&
    byId(aggRows, "t-plain")?.deferred === false);

  await plClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — held/heldBy are now projected by toTaskSummary and visible on BOTH tasks_list (in-project) and list_all_tasks (Platform cross-project aggregate), with the reporter's own deferred positive control preserved and still varying on both surfaces."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
