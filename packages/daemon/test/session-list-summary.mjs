import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MCP-layer session-list PROJECTION test — the summary/paginated mode added to the cross-project
// session list tools so they stop returning a 300K+ blob: audit `list_sessions` (mcp/audit.ts) and
// platform `list_all_sessions` (mcp/platform.ts). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like audit-surface.mjs: a REAL Db + the REAL routers driven over an in-process MCP
// InMemoryTransport (no HTTP, no external daemon). Mirrors the tasks_list/TaskSummary pattern.
//
// Proves, for BOTH tools:
//   - DEFAULT returns a lightweight SUMMARY: the agreed key fields are present, and the HEAVY fields
//     (title, cwd, engineSessionId, branch, worktreePath, lastError, …) are OMITTED.
//   - full:true returns the WHOLE session record (heavy fields restored).
//   - limit/offset paginate the result.
// And for platform list_all_sessions specifically (the bugfix):
//   - the `state` filter DEFAULTS to "live" so a finished-but-unarchived (exited) session is dropped
//     from the feed; state:"exited"/"all" opt into history. Mirrors tasks_list's excludeDone default.
// Run: 1) build (turbo builds shared first), 2) node test/session-list-summary.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME + sandbox HOME — set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-sls-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// A real temp git repo so a spawn has a valid cwd (createPty is faked → no real claude).
const repo = path.join(os.tmpdir(), `loom-sls-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# session-list-summary test repo\n");
execSync(`git init -q && git add . && git -c user.email=sls@loom -c user.name=sls commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProfile({ id: "profAudit", name: "Platform-audit", role: "auditor", description: "audit rig", allowDelta: [], skills: null, model: null, icon: "🔎" });
db.insertAgent({ id: "agentAud", projectId: "pHome", name: "Platform Auditor", startupPrompt: "AUDIT", position: 0, profileId: "profAudit" });
db.insertAgent({ id: "agentWork", projectId: "pOrd", name: "Worker", startupPrompt: "WORK", position: 0, profileId: null });

// The auditor caller (for the loom-audit surface) and the platform caller (for /mcp-platform).
db.insertSession({ id: "AUD", projectId: "pHome", agentId: "agentAud", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });
db.insertSession({ id: "PLAT", projectId: "pHome", agentId: "agentAud", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform", parentSessionId: null });

// A heavy worker session: every heavy field is populated so the projection has something to DROP and
// full:true has something to RESTORE. lastActivity is newest so it sorts first (rows are newest-first).
db.insertSession({
  id: "WHEAVY", projectId: "pOrd", agentId: "agentWork",
  engineSessionId: "eng-heavy-1", title: "A long human-readable session title that bloats the blob",
  cwd: repo, processState: "live", resumability: "resumable", busy: true,
  createdAt: now, lastActivity: new Date(Date.now() + 5_000).toISOString(),
  lastError: "some stack trace string that is heavy", role: "worker", parentSessionId: "M-parent",
  worktreePath: "C:/some/worktree/path", branch: "loom/feature-branch", gen: 1, recycledFrom: "prev-gen",
  ctxInputTokens: 123456, ctxTurns: 42, ctxUpdatedAt: now, model: "claude-opus-4-8",
});
// A couple more live sessions so pagination has >1 row.
db.insertSession({ id: "W2", projectId: "pOrd", agentId: "agentWork", engineSessionId: "eng-2", title: "second", cwd: repo,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: new Date(Date.now() + 3_000).toISOString(), lastError: null, role: "worker", parentSessionId: null, model: "claude-sonnet-4-6", ctxInputTokens: 10, ctxTurns: 2 });
db.insertSession({ id: "W3", projectId: "pOrd", agentId: "agentWork", engineSessionId: "eng-3", title: "third", cwd: repo,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: new Date(Date.now() + 1_000).toISOString(), lastError: null, role: "worker", parentSessionId: null });
// An EXITED (finished, NOT archived) worker — the row that used to stream back forever. Older lastActivity
// so it sorts AFTER the live rows (proving `limit` alone is a band-aid: it'd never be pruned by recency).
db.insertSession({ id: "WEXIT", projectId: "pOrd", agentId: "agentWork", engineSessionId: "eng-exit", title: "finished", cwd: repo,
  processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: new Date(Date.now() - 10_000).toISOString(), lastError: null, role: "worker", parentSessionId: null });

// Fake pty seam (no real claude).
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const auditRouter = new AuditMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);

const parse = (res) => JSON.parse(res.content[0].text);

// The fields a default summary row MUST carry, and the heavy fields it MUST drop.
const SUMMARY_KEYS = ["id", "projectId", "projectName", "agentName", "role", "processState", "busy", "archivedAt", "createdAt", "lastActivity", "model", "ctxInputTokens", "ctxTurns"];
const HEAVY_KEYS = ["title", "cwd", "engineSessionId", "worktreePath", "branch", "lastError", "resumability", "parentSessionId", "recycledFrom", "ctxUpdatedAt"];

// An explicit limit/offset on platform.list_all_sessions (unlike audit.list_sessions, untouched by card
// 9ad4dce7) now returns the {sessions,total,returned,offset,nextOffset} pagination envelope rather than a
// bare array — mirrors list_all_agents. Unwrap either shape down to its row array.
const toRows = (result) => Array.isArray(result) ? result : result.sessions;

// Shared assertions over a given tool's result rows (default summary + full record).
async function assertProjection(toolLabel, callTool) {
  // --- DEFAULT: lightweight summary ---
  const def = toRows(await callTool({}));
  check(`(${toolLabel}) default returns rows`, Array.isArray(def) && def.length > 0);
  const heavyRow = def.find((s) => s.id === "WHEAVY");
  check(`(${toolLabel}) default: the heavy session is present`, !!heavyRow);
  check(`(${toolLabel}) default: summary carries all key fields`, !!heavyRow && SUMMARY_KEYS.every((k) => k in heavyRow));
  check(`(${toolLabel}) default: summary OMITS every heavy field`, !!heavyRow && HEAVY_KEYS.every((k) => !(k in heavyRow)));
  check(`(${toolLabel}) default: enriched names are present (projectName/agentName)`, !!heavyRow && heavyRow.projectName === "Ordinary" && heavyRow.agentName === "Worker");
  check(`(${toolLabel}) default: context meters survive the projection`, !!heavyRow && heavyRow.ctxInputTokens === 123456 && heavyRow.ctxTurns === 42 && heavyRow.model === "claude-opus-4-8");

  // --- full:true: the WHOLE record ---
  const full = toRows(await callTool({ full: true }));
  const fullHeavy = full.find((s) => s.id === "WHEAVY");
  check(`(${toolLabel}) full:true: heavy fields are RESTORED`, !!fullHeavy && fullHeavy.title?.startsWith("A long") && fullHeavy.cwd === repo && fullHeavy.engineSessionId === "eng-heavy-1" && fullHeavy.branch === "loom/feature-branch" && fullHeavy.worktreePath === "C:/some/worktree/path");
  check(`(${toolLabel}) full:true: key fields still present too`, !!fullHeavy && SUMMARY_KEYS.every((k) => k in fullHeavy));

  // --- limit/offset paginate ---
  const limited = toRows(await callTool({ limit: 2 }));
  check(`(${toolLabel}) limit:2 returns exactly 2 rows`, limited.length === 2);
  check(`(${toolLabel}) limit:2 keeps the newest-first order (WHEAVY first)`, limited[0].id === "WHEAVY");
  const offset = toRows(await callTool({ limit: 1, offset: 1 }));
  check(`(${toolLabel}) limit:1 offset:1 returns the 2nd row`, offset.length === 1 && offset[0].id === limited[1].id);
}

try {
  // ---- audit list_sessions (scope:"live" so the set matches list_all_sessions; archived excluded) ----
  const aServer = auditRouter.buildServer("AUD");
  const [acT, asT] = InMemoryTransport.createLinkedPair();
  await aServer.connect(asT);
  const aClient = new Client({ name: "sls-audit", version: "0" });
  await aClient.connect(acT);
  await assertProjection("audit.list_sessions", async (extra) =>
    parse(await aClient.callTool({ name: "list_sessions", arguments: { scope: "live", projectId: "pOrd", ...extra } })));
  await aClient.close();

  // ---- platform list_all_sessions (live only by construction; narrow to pOrd) ----
  const pServer = platformRouter.buildServer();
  const [pcT, psT] = InMemoryTransport.createLinkedPair();
  await pServer.connect(psT);
  const pClient = new Client({ name: "sls-platform", version: "0" });
  await pClient.connect(pcT);
  await assertProjection("platform.list_all_sessions", async (extra) =>
    parse(await pClient.callTool({ name: "list_all_sessions", arguments: { projectId: "pOrd", ...extra } })));

  // ---- STATE filter (the bugfix): default EXCLUDES exited; state opts into history ----
  const platIds = async (args) => new Set(
    parse(await pClient.callTool({ name: "list_all_sessions", arguments: { projectId: "pOrd", ...args } })).map((s) => s.id));
  const def = await platIds({});
  check("state default: EXCLUDES the exited session (WEXIT dropped)", !def.has("WEXIT"));
  check("state default: keeps the live sessions (WHEAVY/W2/W3 present)", def.has("WHEAVY") && def.has("W2") && def.has("W3"));
  const live = await platIds({ state: "live" });
  check("state:live: same set as default (no exited)", !live.has("WEXIT") && live.has("WHEAVY"));
  const exited = await platIds({ state: "exited" });
  check("state:exited: returns ONLY the exited session", exited.has("WEXIT") && !exited.has("WHEAVY") && !exited.has("W2") && !exited.has("W3"));
  const all = await platIds({ state: "all" });
  check("state:all: includes BOTH exited and live", all.has("WEXIT") && all.has("WHEAVY") && all.has("W2") && all.has("W3"));
  await pClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both audit list_sessions and platform list_all_sessions default to a lightweight summary (key fields kept, heavy fields dropped), restore the whole record on full:true, paginate via limit/offset; and platform list_all_sessions defaults its `state` filter to live (exited dropped) with state:exited/all opting into history."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
