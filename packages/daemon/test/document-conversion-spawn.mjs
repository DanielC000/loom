import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker document-conversion (per-session markitdown MCP, opt-in via profile flag). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE, hermetic like browser-testing-spawn.mjs: isolated LOOM_HOME + a sandboxed
// HOME (so resume's transcript check never touches the real ~/.claude), a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam. A real temp git repo backs spawnWorker's
// createWorktree; the only thing faked is the claude pty.
//
// markitdown is a PYTHON tool (`pip install markitdown-mcp`), NOT a node_modules dependency, so unlike
// Playwright's cli.js it is NOT present in the worktree. We therefore exercise the resolver through its
// HUMAN-only override seam: LOOM_MARKITDOWN_BIN points at a real absolute path (process.execPath here),
// which resolveExecutable returns verbatim — so markitdownMcpServer() resolves deterministically with no
// markitdown install. (The same env override is the production human-config path.)
//
// Proves the two DoD points + the load-bearing threading:
//   (a) the spawn mcp-config (buildMcpServers) INCLUDES the per-session markitdown stdio server when
//       documentConversion=true and OMITS it when false (the OFF map is byte-identical to a no-flag spawn;
//       the entry is stdio + uses the resolved ABSOLUTE command + needs no args);
//   (b) resolveProfile backstops documentConversion to FALSE for a null/absent profile and for a profile
//       that doesn't set it, and PASSES IT THROUGH when set;
//   plus end-to-end: a document-profile agent threads documentConversion=true through startNew → spawn
//       opts + the persisted session row; a plain agent stays false (byte-identical); RESUME re-passes it
//       (a resumed document-worker keeps its markitdown MCP); spawnWorker resolves it from the worker
//       agent's profile; recycle carries it forward.
//
// Run: 1) build (turbo builds shared first), 2) node test/document-conversion-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir + worktrees) AND a sandboxed HOME so resume()'s
// engineTranscriptExists reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-dc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// The HUMAN-only markitdown override: point it at a real absolute path so resolveMarkitdownBin() resolves
// deterministically with no markitdown install. Mirrors LOOM_CLAUDE_BIN; set BEFORE importing dist so the
// resolver's memoization captures it. process.execPath is the daemon's own node binary — guaranteed to exist.
const MARKITDOWN_BIN = process.execPath;
process.env.LOOM_MARKITDOWN_BIN = MARKITDOWN_BIN;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, markitdownMcpServer } = await import("../dist/pty/host.js");
const { loomVenvBin, loomVenvDir } = await import("../dist/python/venv.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveProfile } = await import("@loom/shared");

const AGENT = { startupPrompt: "agent own prompt" };

// ===================== (v) loomVenvBin — pure platform-path shape (single shared venv) =====================
// The shared venv lives under <LOOM_HOME>/python/venv; loomVenvBin returns the ABSOLUTE console-script path
// inside it, win32 (Scripts\<bin>.exe) vs posix (bin/<bin>). Pure — no filesystem touch.
const venvDir = loomVenvDir();
check("(v) loomVenvDir is <LOOM_HOME>/python/venv (single shared venv, not per-tool)",
  venvDir === path.join(tmpHome, "python", "venv"));
check("(v) loomVenvBin win32 ⇒ Scripts\\<bin>.exe",
  loomVenvBin("markitdown-mcp", "win32") === path.join(venvDir, "Scripts", "markitdown-mcp.exe"));
check("(v) loomVenvBin posix ⇒ bin/<bin> (no .exe)",
  loomVenvBin("markitdown-mcp", "linux") === path.join(venvDir, "bin", "markitdown-mcp"));
check("(v) loomVenvBin is reusable for any binary name (future Python tools share the venv)",
  loomVenvBin("some-tool", "darwin") === path.join(venvDir, "bin", "some-tool"));

// ===================== (b) resolveProfile backstop + passthrough (claude-free, pure) =====================
check("(b) null profile ⇒ documentConversion backstops to false", resolveProfile(AGENT, null).documentConversion === false);
check("(b) absent profile (undefined) ⇒ false", resolveProfile(AGENT, undefined).documentConversion === false);
const profNoFlag = { id: "p1", name: "NoFlag", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null };
check("(b) a profile that doesn't set documentConversion ⇒ false", resolveProfile(AGENT, profNoFlag).documentConversion === false);
check("(b) a profile with documentConversion:false ⇒ false", resolveProfile(AGENT, { ...profNoFlag, documentConversion: false }).documentConversion === false);
check("(b) a profile with documentConversion:true ⇒ true (passthrough)", resolveProfile(AGENT, { ...profNoFlag, documentConversion: true }).documentConversion === true);

// ===================== (a) buildMcpServers includes/omits the markitdown stdio server =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", documentConversion: false });
const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", documentConversion: true });
check("(a) documentConversion=false ⇒ NO 'markitdown' server in the mcp-config", !("markitdown" in off));
check("(a) documentConversion=true ⇒ 'markitdown' server IS in the mcp-config", "markitdown" in on);
check("(a) the OFF map still has the base + role servers (loom-tasks + loom-orchestration)",
  "loom-tasks" in off && "loom-orchestration" in off);
// byte-identical-when-off: the OFF map equals a spawn that never passed the flag at all.
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(a) OFF map is byte-identical to a no-flag spawn (fully additive)",
  JSON.stringify(off) === JSON.stringify(noFlag));
// turning the flag on adds EXACTLY the one 'markitdown' key, nothing else changes.
check("(a) ON adds exactly the markitdown key (everything else unchanged)",
  JSON.stringify({ ...on, markitdown: undefined }) === JSON.stringify({ ...off, markitdown: undefined }));

const md = on.markitdown;
check("(a) markitdown entry is a stdio server", md?.type === "stdio");
check("(a) command is the resolved ABSOLUTE markitdown bin", typeof md?.command === "string" && path.isAbsolute(md.command) && md.command === MARKITDOWN_BIN);
check("(a) args is an array (markitdown-mcp speaks STDIO by default — no args needed)",
  Array.isArray(md?.args) && md.args.length === 0);
// markitdownMcpServer() (the exported builder) agrees with what buildMcpServers embedded.
check("(a) markitdownMcpServer() returns the same absolute-path stdio entry",
  JSON.stringify(markitdownMcpServer()) === JSON.stringify(md));

// a plain (role-null) document session still gets the server (document conversion is orthogonal to role).
const plainDoc = buildMcpServers({ sessionId: "s2", port: 4317, documentConversion: true });
check("(a) documentConversion works for a role-null session too (orthogonal to role)",
  "markitdown" in plainDoc && !("loom-orchestration" in plainDoc));

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-dc-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# document-conversion-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=dc@loom -c user.name=dc commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// THE document-capable profile + a plain worker profile.
db.insertProfile({ id: "profDoc", name: "Researcher", role: "worker", description: "doc rig", allowDelta: [], skills: null, model: null, icon: "📄", documentConversion: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentDoc", projectId: "pP", name: "Doc", startupPrompt: "DOC_PROMPT", position: 0, profileId: "profDoc" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 2, profileId: "profDev" });
// A live manager (plain-role session is fine) to drive spawnWorker.
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// worker_spawn validates taskId (PL finding #1): the success-case spawns need real, non-terminal tasks.
const tW1 = "11111111-1111-4111-8111-111111111111", tW2 = "22222222-2222-4222-8222-222222222222";
for (const id of [tW1, tW2])
  db.insertTask({ id, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// roundtrip: the profile's flag persists through the DB
check("(roundtrip) Doc profile persists documentConversion=true", db.getProfile("profDoc").documentConversion === true);
check("(roundtrip) Dev profile defaults documentConversion=false", db.getProfile("profDev").documentConversion === false);

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
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

let workerWorktree = null;
try {
  // startNew on a Doc-profile agent → documentConversion threads to spawn opts + the persisted row.
  const sDoc = svc.startNew("agentDoc");
  const oDoc = optsFor(sDoc.id);
  check("(e2e) Doc agent: spawn opts.documentConversion === true", oDoc?.documentConversion === true);
  check("(e2e) Doc agent: returned session.documentConversion === true", sDoc.documentConversion === true);
  check("(e2e) Doc agent: DB persists document_conversion=1 (pins it for respawns)", db.getSession(sDoc.id).documentConversion === true);
  check("(e2e) Doc agent: the spawn's mcp-config includes the markitdown server",
    "markitdown" in buildMcpServers({ sessionId: sDoc.id, port: 4317, role: oDoc.role, documentConversion: oDoc.documentConversion }));

  // startNew on a plain agent → false, byte-identical (no markitdown).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(e2e) plain agent: spawn opts.documentConversion is falsy", !oPlain?.documentConversion);
  check("(e2e) plain agent: DB persists document_conversion=0", db.getSession(sPlain.id).documentConversion === false);

  // RESUME the Doc session → the document capability is re-passed (carried from the pinned row), exactly
  // like role. Give it an engine id + a sandboxed transcript so resume()'s resumability check passes.
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(sDoc.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sDoc.id);
  const oResume = optsFor(sDoc.id);
  check("(e2e) RESUME re-passes documentConversion=true (a resumed document-worker keeps its markitdown MCP)",
    oResume?.documentConversion === true);

  // spawnWorker pointed at the Doc agent → resolves documentConversion from THAT agent's profile.
  const wDoc = await svc.spawnWorker("mgr1", { taskId: tW1, agentId: "agentDoc", kickoffPrompt: "GO" });
  workerWorktree = wDoc.worktreePath;
  const oWDoc = optsFor(wDoc.id);
  check("(e2e) spawnWorker(Doc agent): spawn opts.documentConversion === true", oWDoc?.documentConversion === true);
  check("(e2e) spawnWorker(Doc agent): role is still worker (document conversion is orthogonal)", oWDoc?.role === "worker");
  check("(e2e) spawnWorker(Doc agent): DB row persists document_conversion=1", db.getSession(wDoc.id).documentConversion === true);

  // RECYCLE the document worker → it keeps its markitdown capability (pinned, carried from the old row).
  // recycleWorker reuses the SAME worktree, so no extra cleanup path is needed.
  host.capture.length = 0;
  const rWDoc = await svc.recycleWorker("mgr1", wDoc.id, "CONTINUE");
  const oRWDoc = optsFor(rWDoc.id);
  check("(e2e) recycleWorker(Doc): spawn opts.documentConversion === true (carried forward)", oRWDoc?.documentConversion === true);
  check("(e2e) recycleWorker(Doc): DB row persists document_conversion=1", db.getSession(rWDoc.id).documentConversion === true);

  // spawnWorker pointed at a plain worker (Dev profile, no flag) → false, byte-identical.
  const wDev = await svc.spawnWorker("mgr1", { taskId: tW2, agentId: "agentDev", kickoffPrompt: "GO" });
  const oWDev = optsFor(wDev.id);
  check("(e2e) spawnWorker(Dev agent): documentConversion is falsy (no markitdown)", !oWDev?.documentConversion);
  check("(e2e) spawnWorker(Dev agent): DB row document_conversion=0", db.getSession(wDev.id).documentConversion === false);
  workerWorktree = [workerWorktree, wDev.worktreePath];
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [].concat(workerWorktree).filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — opt-in document conversion: resolveProfile backstops/passes documentConversion; the markitdown stdio MCP is injected iff documentConversion (resolved absolute command, no args, byte-identical off); the flag threads through startNew/resume/spawnWorker/recycle + the persisted row — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
