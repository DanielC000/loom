import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Worker browser-automation (per-session Playwright MCP, opt-in via profile flag). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE, hermetic like profile-spawn.mjs: isolated LOOM_HOME + a sandboxed HOME
// (so resume's transcript check never touches the real ~/.claude), a REAL Db + SessionService driven
// against a FAKE pty injected via PtyHost's createPty() seam. A real temp git repo backs spawnWorker's
// createWorktree; the only thing faked is the claude pty.
//
// Proves the two DoD points + the load-bearing threading:
//   (a) the spawn mcp-config (buildMcpServers) INCLUDES the per-session Playwright stdio server when
//       browserTesting=true and OMITS it when false (and the entry uses ABSOLUTE node + cli.js paths,
//       --headless --isolated; the OFF map is byte-identical to a no-flag spawn);
//   (b) resolveProfile backstops browserTesting to FALSE for a null/absent profile and for a profile
//       that doesn't set it, and PASSES IT THROUGH when set;
//   plus end-to-end: a QA-Tester-profile agent threads browserTesting=true through startNew →
//       spawn opts + the persisted session row; a plain agent stays false (byte-identical); RESUME
//       re-passes it (a resumed browser-worker keeps its browser); spawnWorker resolves it from the
//       worker agent's profile.
//   plus (out) --output-dir is ALWAYS the per-session scratch dir, regardless of the project's vaultPath —
//       card 61ab62e3: an earlier revision pointed --output-dir at vaultPath when set, which meant the
//       ARIA `page-*.yml` snapshot @playwright/mcp writes by default on every browser tool call littered
//       the user's Obsidian vault. buildMcpServers no longer takes a vaultPath param at all.
//   plus (env) browserScratchEnv sets LOOM_SCRATCH_DIR == sessionScratchDir (== the Playwright
//       --output-dir) for a browserTesting spawn, and is fully absent for a plain spawn — gated on the
//       mcp-config's actual 'playwright' entry, not a raw flag.
//
// Run: 1) build (turbo builds shared first), 2) node test/browser-testing-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (host.ts log dir + worktrees) AND a sandboxed HOME so resume()'s
// engineTranscriptExists reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-bt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, playwrightMcpServer, browserScratchEnv } = await import("../dist/pty/host.js");
const { sessionScratchDir } = await import("../dist/paths.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { resolveProfile } = await import("@loom/shared");

const AGENT = { startupPrompt: "agent own prompt" };

// ===================== (b) resolveProfile backstop + passthrough (claude-free, pure) =====================
check("(b) null profile ⇒ browserTesting backstops to false", resolveProfile(AGENT, null).browserTesting === false);
check("(b) absent profile (undefined) ⇒ false", resolveProfile(AGENT, undefined).browserTesting === false);
const profNoFlag = { id: "p1", name: "NoFlag", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null };
check("(b) a profile that doesn't set browserTesting ⇒ false", resolveProfile(AGENT, profNoFlag).browserTesting === false);
check("(b) a profile with browserTesting:false ⇒ false", resolveProfile(AGENT, { ...profNoFlag, browserTesting: false }).browserTesting === false);
check("(b) a profile with browserTesting:true ⇒ true (passthrough)", resolveProfile(AGENT, { ...profNoFlag, browserTesting: true }).browserTesting === true);

// ===================== (a) buildMcpServers includes/omits the Playwright stdio server =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", browserTesting: false });
const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", browserTesting: true });
check("(a) browserTesting=false ⇒ NO 'playwright' server in the mcp-config", !("playwright" in off));
check("(a) browserTesting=true ⇒ 'playwright' server IS in the mcp-config", "playwright" in on);
check("(a) the OFF map still has the base + role servers (loom-tasks + loom-orchestration)",
  "loom-tasks" in off && "loom-orchestration" in off);
// byte-identical-when-off: the OFF map equals a spawn that never passed the flag at all.
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(a) OFF map is byte-identical to a no-flag spawn (fully additive)",
  JSON.stringify(off) === JSON.stringify(noFlag));
// turning the flag on adds EXACTLY the one 'playwright' key, nothing else changes.
check("(a) ON adds exactly the playwright key (everything else unchanged)",
  JSON.stringify({ ...on, playwright: undefined }) === JSON.stringify({ ...off, playwright: undefined }));

const pw = on.playwright;
check("(a) playwright entry is a stdio server", pw?.type === "stdio");
check("(a) command is an ABSOLUTE node path", typeof pw?.command === "string" && path.isAbsolute(pw.command));
check("(a) args[0] is an ABSOLUTE path to the @playwright/mcp cli.js",
  Array.isArray(pw?.args) && path.isAbsolute(pw.args[0]) && pw.args[0].endsWith("cli.js"));
check("(a) the resolved cli.js exists on disk (pinned daemon dependency)", fs.existsSync(pw.args[0]));
check("(a) headless + isolated flags are passed (unattended, per-worker isolation)",
  pw.args.includes("--headless") && pw.args.includes("--isolated"));
// playwrightMcpServer(dir) (the exported builder) agrees with what buildMcpServers embedded — and
// buildMcpServers wires the per-session scratch dir, so the no-output-dir builder is NOT equal.
check("(a) playwrightMcpServer(scratchDir) returns the same absolute-path stdio entry",
  JSON.stringify(playwrightMcpServer(sessionScratchDir("s1"))) === JSON.stringify(pw));

// ===================== screenshot output defaults OUTSIDE the repo working tree (card 2218530e) =====================
// The footgun: with no --output-dir, the Playwright MCP defaults captures to `<cwd>/.playwright-mcp`,
// and cwd IS the project repo root — a stray-PNG-commit risk in a self-hosting repo. buildMcpServers
// must wire --output-dir to a repo-EXTERNAL per-session scratch dir.
const oi = pw.args.indexOf("--output-dir");
check("(out) the spawn passes --output-dir", oi !== -1);
const outDir = pw.args[oi + 1];
check("(out) --output-dir is an ABSOLUTE path", typeof outDir === "string" && path.isAbsolute(outDir));
check("(out) --output-dir is the per-session scratch dir (deterministic, under LOOM_HOME)",
  outDir === sessionScratchDir("s1"));
check("(out) the scratch dir lives under LOOM_HOME/tmp (repo-external, daemon-owned)",
  outDir.startsWith(path.join(tmpHome, "tmp")));
// An EXPLICIT caller-provided output dir is honored verbatim (the seam still threads a chosen path) —
// and an absolute screenshot FILENAME bypasses --output-dir via playwright-core's path.resolve, so an
// explicit caller path always lands where asked.
const explicit = path.join(tmpHome, "explicit-shots");
check("(out) an explicit output dir passed to playwrightMcpServer is honored verbatim",
  playwrightMcpServer(explicit).args.includes("--output-dir")
  && playwrightMcpServer(explicit).args[playwrightMcpServer(explicit).args.indexOf("--output-dir") + 1] === explicit);
// omitting the dir ⇒ NO --output-dir flag (byte-identical to the pre-output-dir spawn shape).
check("(out) playwrightMcpServer() with no dir omits --output-dir (additive)",
  !playwrightMcpServer().args.includes("--output-dir"));

// a plain (role-null) browser session still gets the server (browser is orthogonal to role).
const plainBrowser = buildMcpServers({ sessionId: "s2", port: 4317, browserTesting: true });
check("(a) browserTesting works for a role-null session too (orthogonal to role)",
  "playwright" in plainBrowser && !("loom-orchestration" in plainBrowser));

// ===================== (env) LOOM_SCRATCH_DIR — the agent's own pointer to Playwright's write boundary =====================
// @playwright/mcp's checkFile guard only allows a write inside --output-dir or cwd; the agent's generic
// harness scratchpad is neither, so a browser-testing session needs LOOM_SCRATCH_DIR telling it exactly
// where --output-dir points (sessionScratchDir) so it can stage an upload / persist an explicit-path shot.
const scratchOn = browserScratchEnv(on, "s1");
const scratchOff = browserScratchEnv(off, "s1");
check("(env) browserTesting spawn: LOOM_SCRATCH_DIR is present and equals sessionScratchDir(sessionId)",
  scratchOn.LOOM_SCRATCH_DIR === sessionScratchDir("s1"));
check("(env) browserTesting spawn: LOOM_SCRATCH_DIR equals the Playwright --output-dir (same allowed root)",
  scratchOn.LOOM_SCRATCH_DIR === on.playwright.args[on.playwright.args.indexOf("--output-dir") + 1]);
check("(env) plain (non-browser) spawn: NO LOOM_SCRATCH_DIR key at all", !("LOOM_SCRATCH_DIR" in scratchOff));
check("(env) plain spawn: browserScratchEnv returns {} (fully additive)", Object.keys(scratchOff).length === 0);
// Gated on the ACTUAL mount (mcpServers.playwright), not a raw flag — a map that never got the entry
// (e.g. resolution failure) yields no env var either, even if called with browserTesting semantics elsewhere.
check("(env) gated on the map's actual 'playwright' entry, not a separate flag",
  JSON.stringify(browserScratchEnv({ "loom-tasks": off["loom-tasks"] }, "s1")) === "{}");

// ===================== --output-dir is ALWAYS scratch, never the vault (card 61ab62e3) =====================
// buildMcpServers no longer accepts (or consults) a vaultPath — an unrecognized property passed alongside
// a real call is simply ignored by a plain JS object, so this also proves an accidental vaultPath on the
// call site can't resurrect the old vault-littering behavior.
const vault = path.join(tmpHome, "the-vault");
const withVault = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", browserTesting: true, vaultPath: vault });
const vaultOutDir = withVault.playwright.args[withVault.playwright.args.indexOf("--output-dir") + 1];
check("(vault) a vaultPath property on the call is IGNORED — --output-dir is still the scratch dir",
  vaultOutDir === sessionScratchDir("s1"));
check("(vault) --output-dir is an ABSOLUTE path", path.isAbsolute(vaultOutDir));
// with vs without a (now-ignored) vaultPath: the mcp-config is fully byte-identical.
const noVault = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", browserTesting: true });
check("(vault) a vaultPath property changes NOTHING in the mcp-config",
  JSON.stringify(withVault) === JSON.stringify(noVault));

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-bt-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# browser-testing-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=bt@loom -c user.name=bt commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
// THE browser-capable profile (mirrors the bundled QA Tester) + a plain worker profile.
db.insertProfile({ id: "profQA", name: "QA Tester", role: "worker", description: "qa rig", allowDelta: [], skills: null, model: null, icon: "🧪", browserTesting: true });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });
db.insertAgent({ id: "agentQA", projectId: "pP", name: "QA", startupPrompt: "QA_PROMPT", position: 0, profileId: "profQA" });
db.insertAgent({ id: "agentPlain", projectId: "pP", name: "Plain", startupPrompt: "PLAIN_PROMPT", position: 1, profileId: null });
db.insertAgent({ id: "agentDev", projectId: "pP", name: "Dev", startupPrompt: "DEV_PROMPT", position: 2, profileId: "profDev" });
// A live manager (plain-role session is fine) to drive spawnWorker.
db.insertSession({ id: "mgr1", projectId: "pP", agentId: "agentPlain", engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// worker_spawn now validates taskId (PL finding #1): the success-case spawns need real, non-terminal tasks.
const tW1 = "11111111-1111-4111-8111-111111111111", tW2 = "22222222-2222-4222-8222-222222222222";
for (const id of [tW1, tW2])
  db.insertTask({ id, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

// roundtrip: the profile's flag persists through the DB
check("(roundtrip) QA profile persists browserTesting=true", db.getProfile("profQA").browserTesting === true);
check("(roundtrip) Dev profile defaults browserTesting=false", db.getProfile("profDev").browserTesting === false);

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  // resume()'s already-live short-circuit consults pty.isAlive: this capture seam drives NO live OS pty,
  // so report not-live — the test resumes a (notionally stopped) session to inspect its resume spawn args.
  isAlive() { return false; }
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
  // startNew on a QA-profile agent → browserTesting threads to spawn opts + the persisted row.
  const sQA = svc.startNew("agentQA");
  const oQA = optsFor(sQA.id);
  check("(e2e) QA agent: spawn opts.browserTesting === true", oQA?.browserTesting === true);
  check("(e2e) QA agent: returned session.browserTesting === true", sQA.browserTesting === true);
  check("(e2e) QA agent: DB persists browser_testing=1 (pins it for respawns)", db.getSession(sQA.id).browserTesting === true);
  const qaMcp = buildMcpServers({ sessionId: sQA.id, port: 4317, role: oQA.role, browserTesting: oQA.browserTesting });
  check("(e2e) QA agent: the spawn's mcp-config includes the playwright server", "playwright" in qaMcp);
  // DoD: the resolved default capture output dir is OUTSIDE the project repo working tree (repoPath).
  const qaArgs = qaMcp.playwright.args;
  const qaOut = qaArgs[qaArgs.indexOf("--output-dir") + 1];
  const rel = path.relative(repo, qaOut);
  check("(e2e) QA agent: default screenshot output dir is OUTSIDE repoPath (no stray-PNG-in-repo)",
    path.isAbsolute(qaOut) && (rel.startsWith("..") || path.isAbsolute(rel)));

  // startNew on a plain agent → false, byte-identical (no browser).
  const sPlain = svc.startNew("agentPlain");
  const oPlain = optsFor(sPlain.id);
  check("(e2e) plain agent: spawn opts.browserTesting is falsy", !oPlain?.browserTesting);
  check("(e2e) plain agent: DB persists browser_testing=0", db.getSession(sPlain.id).browserTesting === false);

  // RESUME the QA session → the browser capability is re-passed (carried from the pinned row), exactly
  // like role. Give it an engine id + a sandboxed transcript so resume()'s resumability check passes.
  const engId = "11111111-2222-3333-4444-555555555555";
  db.setEngineSessionId(sQA.id, engId);
  const tpath = engineTranscriptPath(repo, engId);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  fs.writeFileSync(tpath, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  host.capture.length = 0; // isolate the resume's captured opts
  svc.resume(sQA.id);
  const oResume = optsFor(sQA.id);
  check("(e2e) RESUME re-passes browserTesting=true (a resumed browser-worker keeps its browser)",
    oResume?.browserTesting === true);

  // spawnWorker pointed at the QA agent → resolves browserTesting from THAT agent's profile.
  const wQA = await svc.spawnWorker("mgr1", { taskId: tW1, agentId: "agentQA", kickoffPrompt: "GO" });
  workerWorktree = wQA.worktreePath;
  const oWQA = optsFor(wQA.id);
  check("(e2e) spawnWorker(QA agent): spawn opts.browserTesting === true", oWQA?.browserTesting === true);
  check("(e2e) spawnWorker(QA agent): role is still worker (browser is orthogonal)", oWQA?.role === "worker");
  check("(e2e) spawnWorker(QA agent): DB row persists browser_testing=1", db.getSession(wQA.id).browserTesting === true);

  // spawnWorker pointed at a plain worker (Dev profile, no flag) → false, byte-identical.
  const wDev = await svc.spawnWorker("mgr1", { taskId: tW2, agentId: "agentDev", kickoffPrompt: "GO" });
  const oWDev = optsFor(wDev.id);
  check("(e2e) spawnWorker(Dev agent): browserTesting is falsy (no browser)", !oWDev?.browserTesting);
  check("(e2e) spawnWorker(Dev agent): DB row browser_testing=0", db.getSession(wDev.id).browserTesting === false);
  // (createWorktree made a 2nd worktree; clean both up below via the repo's worktree prune.)
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
  ? "\n✅ ALL PASS — opt-in worker browser: resolveProfile backstops/passes browserTesting; the Playwright stdio MCP is injected iff browserTesting (absolute paths, headless+isolated, byte-identical off); LOOM_SCRATCH_DIR mirrors the Playwright --output-dir iff the MCP mounted (absent otherwise); the flag threads through startNew/resume/spawnWorker + the persisted row — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
