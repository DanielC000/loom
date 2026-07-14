import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C2 REWRITE (card e068a2ab) — inject the built-in Codescape MCP
// for agents on a LOOM_DEV Codescape-enabled project. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like deja-corpus-spawn.mjs: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService
// driven against a FAKE pty injected via PtyHost's createPty() seam, and a FAKE CodescapeSupervisor (just
// `ingestToGraph`) injected via SessionService's `opts.codescape` — no real supervisor/serve process, no
// real claude spawn. `LOOM_CODESCAPE_BIN` points at the fixture CLI (test/fixtures/fake-codescape-cli.mjs)
// so `codescapeMcpServer`'s spawn-shape assertions are real (mirrors deja-corpus-spawn.mjs's
// LOOM_DEJA_BIN pattern) without needing a real `codescape` install.
//
// WAS: a shared `codescape serve` HTTP mount scoped by the LOOM projectId — codescape ingested the repo
// under its OWN derived id, so scope lookups 400/404'd and the MCP never registered (agents got zero
// tools; card e068a2ab). NOW: a per-session STDIO `codescape mcp --graph <graph.json>` process reading a
// project-wide graph file the daemon keeps fresh via `codescape ingest --out` — no shared serve on the
// agent path, no scope multiplexing, no project-id mismatch possible.
//
// Proves the DoD:
//   (helpers) shared/src/config.ts's `codescape.enabled` resolves default-false / per-project-override
//       through resolveConfig; paths.ts's `isCodescapeEnabled` combines the daemon-wide supervisor gate
//       with the per-project flag; paths.ts's `codescapeGraphPath` derives the ONE project-wide graph path.
//   (resolver) `codescapeMcpServer(graphPath)` returns null when the graph file doesn't exist yet
//       (clean-skip, mirrors markitdown's "venv not warm" fallback), and a real `{type:"stdio", command,
//       args}` entry — command wrapped in `process.execPath` for a `.js`/`.mjs` codescape checkout
//       (mirrors dejaMcpServer's shape), args ending `mcp --graph <graphPath>` — once it exists.
//   (a) buildMcpServers mounts that stdio entry for "codescape" iff codescapeEnabled && isLoomDev() &&
//       isCodescapeSupervisorEnabled() && the project's graph.json exists — orthogonal to role: worker,
//       manager, and plain all get the SAME project-wide entry (no more worktree-scoped 2-/3-segment URL).
//   NEGATIVE CASES (byte-identical to a no-flag spawn): LOOM_DEV off / LOOM_CODESCAPE_ENABLED unset /
//       project not enabled / graph.json missing.
//   (b) CODESCAPE_TOOL_ALLOW carries exactly the 7 read tools, none of the 5 control/write tools; createPty
//       allowlists them iff the mcpServers map actually carries the "codescape" entry (shape-independent —
//       keys off presence, not transport).
//   plus end-to-end: spawnWorker's C3 `fireCodescapeEnsureGraph` hook fires `ingestToGraph` against the
//       PROJECT's main repoPath (not the worker's own worktree) and writes the project-wide graph file;
//       once it lands, buildMcpServers (fed the real spawn opts) mounts the codescape entry; a SECOND
//       worker spawn does NOT re-ingest (existence-gated); opts carry no codescapePort/worktreeId keys.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-mcp-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");
delete process.env.LOOM_CODESCAPE_BIN;
process.env.LOOM_CODESCAPE_BIN = fixtureCli;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, buildSpawnArgs, disallowedToolsForSpawn, codescapeMcpServer, CODESCAPE_TOOL_ALLOW, CODESCAPE_WRITE_TOOLS } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { isLoomDev, isCodescapeSupervisorEnabled, isCodescapeEnabled, codescapeGraphPath } = await import("../dist/paths.js");
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

// ===================== codescapeGraphPath: ONE project-wide graph file =====================
check("(graphpath) codescapeGraphPath derives <LOOM_HOME>/codescape/<projectId>/graph.json",
  codescapeGraphPath("projA") === path.join(tmpHome, "codescape", "projA", "graph.json"));
check("(graphpath) different projects get different paths", codescapeGraphPath("projA") !== codescapeGraphPath("projB"));

// ===================== CODESCAPE_TOOL_ALLOW: exactly the 7 read tools, none of the 5 write tools =====================
const expectedRead = ["mcp__codescape__list_flows", "mcp__codescape__trace_flow", "mcp__codescape__what_touches",
  "mcp__codescape__describe_symbol", "mcp__codescape__render_tree", "mcp__codescape__boundary_map", "mcp__codescape__scenario_space"];
const forbiddenWrite = ["mcp__codescape__focus_flow", "mcp__codescape__highlight", "mcp__codescape__open_view",
  "mcp__codescape__annotate", "mcp__codescape__show_diff"];
check("(allowlist) CODESCAPE_TOOL_ALLOW has exactly the 7 read tools",
  CODESCAPE_TOOL_ALLOW.length === 7 && expectedRead.every((t) => CODESCAPE_TOOL_ALLOW.includes(t)));
check("(allowlist) CODESCAPE_TOOL_ALLOW contains NONE of the 5 control/write tools",
  forbiddenWrite.every((t) => !CODESCAPE_TOOL_ALLOW.includes(t)));

// ===================== CR fix: the 5 write tools are actually UNREACHABLE, not just un-allowlisted =====================
// The allowlist checks above only prove the write tools are absent from --allowedTools; under
// `acceptEdits` a mounted-but-unallowlisted MCP tool still PROMPTS (it isn't auto-denied), which would
// wedge a Loom-driven worker session. disallowedToolsForSpawn must union CODESCAPE_WRITE_TOOLS into
// `--disallowedTools` whenever the codescape MCP is actually mounted — proving the write tools are
// structurally unreachable, not merely unallowlisted. Shape-independent: it keys off the "codescape"
// entry's mere PRESENCE in mcpServers, not its transport, so this holds for the new stdio shape too.
check("(CODESCAPE_WRITE_TOOLS) carries exactly the 5 control/write tool names",
  CODESCAPE_WRITE_TOOLS.length === 5 && forbiddenWrite.every((t) => CODESCAPE_WRITE_TOOLS.includes(t)));

check("(disallow) codescapeMounted=false ⇒ disallowedToolsForSpawn has NONE of the write tools",
  forbiddenWrite.every((t) => !disallowedToolsForSpawn("worker", false, false).includes(t)));
check("(disallow) codescapeMounted=true ⇒ disallowedToolsForSpawn has ALL 5 write tools",
  forbiddenWrite.every((t) => disallowedToolsForSpawn("worker", false, true).includes(t)));
check("(disallow) codescapeMounted=true still keeps the role's own disallow list (union, not replace)",
  ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].every((t) => disallowedToolsForSpawn("worker", false, true).includes(t)));
check("(disallow) codescapeMounted + restrictedTools both off ⇒ byte-identical to disallowedToolsForSpawn(role) alone",
  JSON.stringify(disallowedToolsForSpawn("worker", false, false)) === JSON.stringify(disallowedToolsForSpawn("worker")));

// End-to-end through buildSpawnArgs: the write tools actually land in `--disallowedTools` argv when
// codescape is mounted (now a stdio entry), and are absent when it isn't — proving the flag is emitted,
// not just the array.
{
  const mcpNoCodescape = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const mcpWithCodescape = { ...mcpNoCodescape, codescape: { type: "stdio", command: process.execPath, args: [fixtureCli, "mcp", "--graph", "g.json"] } };
  const argsWithout = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: mcpNoCodescape, startupPrompt: "GO", disallowedTools: disallowedToolsForSpawn("worker", false, !!mcpNoCodescape.codescape) });
  const argsWith = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: mcpWithCodescape, startupPrompt: "GO", disallowedTools: disallowedToolsForSpawn("worker", false, !!mcpWithCodescape.codescape) });
  check("(e2e-disallow) codescape NOT mounted: none of the 5 write tools appear in argv",
    forbiddenWrite.every((t) => !argsWithout.includes(t)));
  check("(e2e-disallow) codescape MOUNTED: all 5 write tools appear in --disallowedTools argv",
    forbiddenWrite.every((t) => argsWith.includes(t)));
  const d = argsWith.indexOf("--disallowedTools");
  const strict = argsWith.indexOf("--strict-mcp-config");
  check("(e2e-disallow) --disallowedTools still precedes --strict-mcp-config (flag-ordering invariant preserved)",
    d !== -1 && strict !== -1 && d < strict);
}

// ===================== codescapeMcpServer: the stdio resolver (new C2 seam) =====================
const graphPathA = codescapeGraphPath("projA");
{
  const missingPath = path.join(tmpHome, "codescape", "no-such-project", "graph.json");
  check("(resolver) codescapeMcpServer returns null when the graph file doesn't exist yet (clean-skip)",
    codescapeMcpServer(missingPath) === null);

  fs.mkdirSync(path.dirname(graphPathA), { recursive: true });
  fs.writeFileSync(graphPathA, JSON.stringify({ nodes: [], edges: [], flows: [] }));
  const entry = codescapeMcpServer(graphPathA);
  check("(resolver) returns a stdio entry once the graph file exists", entry?.type === "stdio");
  check("(resolver) a .mjs codescape checkout is wrapped in process.execPath (mirrors dejaMcpServer's shape)",
    entry?.command === process.execPath);
  check("(resolver) args are [<cli.js>, 'mcp', '--graph', <graphPath>]",
    JSON.stringify(entry?.args) === JSON.stringify([fixtureCli, "mcp", "--graph", graphPathA]));
}

// ===================== buildMcpServers: NEGATIVE CASES — byte-identical to a no-flag spawn =====================
const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });

// (1) LOOM_DEV off (graph exists, everything else on) — the hard gate wins first.
delete process.env.LOOM_DEV;
const devOff = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, projectId: "projA" });
check("(neg-1) LOOM_DEV off ⇒ NO 'codescape' entry", !("codescape" in devOff));
check("(neg-1) LOOM_DEV off ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(devOff) === JSON.stringify(noFlag));

// (2) LOOM_DEV on, LOOM_CODESCAPE_ENABLED unset (the daemon-wide feature switch itself off).
process.env.LOOM_DEV = "1";
delete process.env.LOOM_CODESCAPE_ENABLED;
const supervisorOff = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, projectId: "projA" });
check("(neg-2) LOOM_CODESCAPE_ENABLED unset ⇒ NO 'codescape' entry", !("codescape" in supervisorOff));
check("(neg-2) byte-identical to a no-flag spawn", JSON.stringify(supervisorOff) === JSON.stringify(noFlag));
process.env.LOOM_CODESCAPE_ENABLED = "1";

// (3) project NOT enabled (codescapeEnabled: false), everything else on.
const notEnabled = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: false, projectId: "projA" });
check("(neg-3) project not enabled ⇒ NO 'codescape' entry", !("codescape" in notEnabled));
check("(neg-3) project not enabled ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(notEnabled) === JSON.stringify(noFlag));

// (4) graph.json missing (a DIFFERENT, never-ingested project) — the async-provisioning clean-skip.
const missingGraph = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, projectId: "proj-never-ingested" });
check("(neg-4) missing graph.json ⇒ NO 'codescape' entry (clean-skip, never throws)", !("codescape" in missingGraph));
check("(neg-4) missing graph.json ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(missingGraph) === JSON.stringify(noFlag));

// unset entirely (no codescapeEnabled key at all) ⇒ also byte-identical (fully additive).
const unset = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", projectId: "projA" });
check("(neg-5) codescapeEnabled unset ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(unset) === JSON.stringify(noFlag));

// ===================== buildMcpServers: POSITIVE — same project-wide entry regardless of role =====================
const workerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, projectId: "projA" });
check("(a) worker: 'codescape' entry present", "codescape" in workerOn);
check("(a) worker: entry shape is {type:'stdio', command, args} (NOT the old http/URL shape)",
  workerOn.codescape.type === "stdio" && typeof workerOn.codescape.command === "string" && Array.isArray(workerOn.codescape.args) && !("url" in workerOn.codescape));
check("(a) worker: args end in 'mcp' '--graph' <graphPath>", JSON.stringify(workerOn.codescape.args.slice(-3)) === JSON.stringify(["mcp", "--graph", graphPathA]));

const managerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "manager", codescapeEnabled: true, projectId: "projA" });
check("(a) manager gets the EXACT SAME project-wide entry as a worker (no more worktree scoping)",
  JSON.stringify(managerOn.codescape) === JSON.stringify(workerOn.codescape));

const plainOn = buildMcpServers({ sessionId: "s1", port: 4317, codescapeEnabled: true, projectId: "projA" });
check("(a) plain (role-less) session also gets it (orthogonal to role, like deja)",
  JSON.stringify(plainOn.codescape) === JSON.stringify(workerOn.codescape));

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
// Project A: codescape enabled (its graph.json does NOT exist yet at start of this section).
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
// A fake CodescapeSupervisor whose ingestToGraph resolves immediately and writes a REAL graph file — the
// real spawn shape (fixture-CLI-backed) is already proven above via codescapeMcpServer() directly, so this
// e2e section only needs to prove the C3 threading (WHO gets called, WITH what args, WHEN).
const ingestCalls = [];
const fakeSupervisor = {
  async ingestToGraph(repoPath, graphPath) {
    ingestCalls.push({ repoPath, graphPath });
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify({ nodes: [], edges: [], flows: [] }));
    return { ok: true, outcome: "ready" };
  },
};
const svc = new SessionService(db, host, new OrchestrationControl(), { codescape: fakeSupervisor });
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let workerWorktree = null;
let worker2Worktree = null;
try {
  const mgrA = svc.startManager("agentMgrA");
  const oMgrA = optsFor(mgrA.id);
  check("(e2e) manager: opts.codescapeEnabled === true (project A opted in)", oMgrA?.codescapeEnabled === true);
  check("(e2e) manager: opts.projectId === 'pA'", oMgrA?.projectId === "pA");
  check("(e2e) manager: opts carry NO codescapePort/worktreeId keys anymore (C2 rewrite dropped them)",
    !("codescapePort" in oMgrA) && !("worktreeId" in oMgrA));
  const mgrMcp = buildMcpServers({ sessionId: mgrA.id, port: 4317, role: oMgrA.role, codescapeEnabled: oMgrA.codescapeEnabled, projectId: oMgrA.projectId });
  check("(e2e) manager: mcpServers has NO codescape entry yet (pA's graph.json doesn't exist until a worker ensures it)",
    !("codescape" in mgrMcp));

  const tW1 = "22222222-2222-4222-8222-222222222222";
  db.insertTask({ id: tW1, projectId: "pA", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const worker = await svc.spawnWorker(mgrA.id, { taskId: tW1, agentId: "agentWorkerA", kickoffPrompt: "GO" });
  workerWorktree = worker.worktreePath;
  const oWorker = optsFor(worker.id);
  check("(e2e) worker: opts.codescapeEnabled === true", oWorker?.codescapeEnabled === true);
  check("(e2e) worker: opts.projectId === 'pA'", oWorker?.projectId === "pA");

  // fireCodescapeEnsureGraph is fire-and-forget (not awaited by spawnWorker) — give it a beat to land.
  for (let i = 0; i < 100 && ingestCalls.length === 0; i++) await sleep(20);
  check("(e2e) spawnWorker's C3 ensure-graph hook fired ingestToGraph exactly once", ingestCalls.length === 1);
  check("(e2e) ensure-graph ingested the PROJECT'S MAIN repoPath (not the worker's own new worktree)", ingestCalls[0]?.repoPath === repo);
  check("(e2e) ensure-graph wrote to codescapeGraphPath('pA')", ingestCalls[0]?.graphPath === codescapeGraphPath("pA"));
  check("(e2e) the project's graph file now genuinely exists on disk", fs.existsSync(codescapeGraphPath("pA")));

  // NOW buildMcpServers (fed the SAME real spawn opts) mounts the codescape entry — proving C2+C3 connect.
  const workerMcp = buildMcpServers({ sessionId: worker.id, port: 4317, role: oWorker.role, codescapeEnabled: oWorker.codescapeEnabled, projectId: oWorker.projectId });
  check("(e2e) after ensure-graph lands, buildMcpServers mounts the codescape stdio entry", workerMcp.codescape?.type === "stdio");
  check("(e2e) its args point at pA's graph file", JSON.stringify(workerMcp.codescape.args.slice(-3)) === JSON.stringify(["mcp", "--graph", codescapeGraphPath("pA")]));

  // A SECOND worker spawn must NOT re-ingest — ensure-graph is existence-gated (an ingest can take up to
  // ~2 minutes on a big repo; re-running it on every worker spawn would be wasteful).
  const tW2 = "33333333-3333-4333-8333-333333333333";
  db.insertTask({ id: tW2, projectId: "pA", title: "t2", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  const worker2 = await svc.spawnWorker(mgrA.id, { taskId: tW2, agentId: "agentWorkerA", kickoffPrompt: "GO" });
  worker2Worktree = worker2.worktreePath;
  await sleep(150);
  check("(e2e) a second worker spawn does NOT re-ingest (graph already exists)", ingestCalls.length === 1);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of [workerWorktree, worker2Worktree].filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_ENABLED;
  delete process.env.LOOM_CODESCAPE_BIN;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape MCP wiring (card C2 rewrite, e068a2ab): shared config default-false/per-project-override; isCodescapeEnabled combines the daemon-wide + per-project gates; codescapeGraphPath derives ONE project-wide graph file; codescapeMcpServer clean-skips until that file exists then returns a real stdio entry (process.execPath-wrapped for a .mjs checkout, mirroring dejaMcpServer); buildMcpServers mounts it iff enabled+isLoomDev+supervisorEnabled+graph-exists, with all 4 negative cases byte-identical off, orthogonally across worker/manager/plain roles; the 7-tool read-only allowlist excludes the 5 write tools and they're structurally disallowed once mounted; end-to-end, spawnWorker's C3 hook ingests the project's MAIN repoPath (not the worktree) exactly once, after which buildMcpServers mounts it and a second spawn skips re-ingesting — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
