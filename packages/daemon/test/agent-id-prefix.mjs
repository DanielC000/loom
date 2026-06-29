import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unambiguous agent id-PREFIX resolution in worker_spawn AND the platform *_get reads (card f9412b5e).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-spawn-agent-name.mjs: isolated LOOM_HOME +
// a sandboxed HOME, a REAL Db + SessionService against a FAKE pty, and the REAL PlatformMcpRouter over an
// in-process MCP InMemoryTransport (no HTTP). A real temp git repo backs spawnWorker's createWorktree.
//
// The bug: Loom DISPLAYS the 8-char agent id-prefix everywhere as the paste-able id, but resolveWorkerAgentRef
// (+ the platform *_get reads) resolved ONLY an exact id or name/slug — a valid prefix never resolved. Worse,
// the "did you mean" hint ran Levenshtein on agent NAME, so a hex id-prefix miss got an arbitrary nearest
// NAME → it confidently named the WRONG agent.
//
// Proves:
//   (1) worker_spawn resolves a valid UNAMBIGUOUS 8-char id-prefix → spawns the right agent (role=worker);
//   (2) worker_spawn on an AMBIGUOUS prefix is REJECTED, the error naming BOTH candidate ids (never a pick);
//   (3) an id-SHAPED miss yields an id-based hint (a close typo) OR no hint (a far miss) — NEVER an agent NAME;
//   (4) exact-id + name resolution still work (regression — historical contract preserved);
//   (5) agent_get resolves the same UNAMBIGUOUS prefix; an AMBIGUOUS prefix errors listing the candidates;
//       an unknown prefix → "agent not found"; exact id still works.
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-id-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const rejects = async (label, fn, ...needles) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  const ok = threw != null && needles.every((n) => String(threw.message).includes(n));
  check(`${label}${ok || !threw ? "" : ` (got: ${threw.message})`}`, ok);
  return threw;
};

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-idp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so spawnWorker's createWorktree (real git) has a HEAD to branch off ---
const repo = path.join(os.tmpdir(), `loom-idp-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# agent-id-prefix test\n");
execSync(`git init -q && git add . && git -c user.email=idp@loom -c user.name=idp commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pP", name: "P", repoPath: repo, vaultPath: repo, config: { orchestration: { maxConcurrentWorkers: 10 } }, createdAt: now, archivedAt: null });
db.insertProfile({ id: "profDev", name: "Dev", role: "worker", description: "dev rig", allowDelta: [], skills: null, model: null, icon: null });

// CRAFTED UUID-shaped agent ids: one with a UNIQUE 8-char prefix, two that SHARE an 8-char prefix (the
// ambiguity fixture). The 8-char prefix is what Loom displays + what gets pasted.
const ID_SOLO = "12ab34cd-0000-4000-8000-000000000001"; // unique prefix "12ab34cd"
const ID_DUP_A = "feedface-0000-4000-8000-00000000000a"; // shares prefix "feedface" with…
const ID_DUP_B = "feedface-0000-4000-8000-00000000000b"; // …this one
db.insertAgent({ id: ID_SOLO, projectId: "pP", name: "Solo", startupPrompt: "SOLO", position: 0, profileId: "profDev" });
db.insertAgent({ id: ID_DUP_A, projectId: "pP", name: "Alpha", startupPrompt: "A", position: 1, profileId: "profDev" });
db.insertAgent({ id: ID_DUP_B, projectId: "pP", name: "Bravo", startupPrompt: "B", position: 2, profileId: "profDev" });

db.insertSession({ id: "mgr1", projectId: "pP", agentId: ID_SOLO, engineSessionId: null, title: null,
  cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

// Real, non-terminal tasks for each SUCCESS spawn (worker_spawn validates taskId).
const tPrefix = randomUUID(), tExact = randomUUID(), tName = randomUUID();
for (const id of [tPrefix, tExact, tName])
  db.insertTask({ id, projectId: "pP", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

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

const worktrees = [];
try {
  // ===================== (1) worker_spawn resolves a valid UNAMBIGUOUS 8-char id-prefix =====================
  const wPrefix = await svc.spawnWorker("mgr1", { taskId: tPrefix, agentId: "12ab34cd", kickoffPrompt: "GO" });
  worktrees.push(wPrefix.worktreePath);
  check("(1) prefix '12ab34cd' resolves to ID_SOLO, role=worker", wPrefix.agentId === ID_SOLO && wPrefix.role === "worker");

  // ===================== (4) exact id + name still resolve (regression) =====================
  const wExact = await svc.spawnWorker("mgr1", { taskId: tExact, agentId: ID_SOLO, kickoffPrompt: "GO" });
  worktrees.push(wExact.worktreePath);
  check("(4) exact id still resolves (historical contract preserved)", wExact.agentId === ID_SOLO);
  const wName = await svc.spawnWorker("mgr1", { taskId: tName, agentId: "Alpha", kickoffPrompt: "GO" });
  worktrees.push(wName.worktreePath);
  check("(4) name 'Alpha' still resolves", wName.agentId === ID_DUP_A);

  // ===================== (2) AMBIGUOUS prefix REJECTED, naming BOTH candidate ids =====================
  const ambErr = await rejects("(2) ambiguous prefix 'feedface' rejected as ambiguous",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "feedface", kickoffPrompt: "GO" }),
    "ambiguous id-prefix");
  check("(2) the ambiguity error names BOTH candidate ids",
    ambErr != null && String(ambErr.message).includes(ID_DUP_A) && String(ambErr.message).includes(ID_DUP_B));

  // ===================== (3) id-SHAPED miss: id hint for a typo / NO hint for a far miss — NEVER a name ====
  // A close typo of the unique prefix ('12ab34ce' is 1 edit from '12ab34cd') → an id-PREFIX hint, no name.
  const typoErr = await rejects("(3) id-shaped typo '12ab34ce' rejected with 'does not resolve'",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "12ab34ce", kickoffPrompt: "GO" }),
    "does not resolve to an existing agent", "did you mean", "12ab34cd");
  check("(3) the id-typo hint NEVER names an agent (no 'Solo'/'Alpha'/'Bravo')",
    typoErr != null && !/Solo|Alpha|Bravo/.test(String(typoErr.message)));
  // A FAR id-shaped miss ('99999999' is >2 edits from every prefix) → NO suggestion at all, and NO name.
  const farErr = await rejects("(3) far id-shaped miss '99999999' rejected with 'does not resolve'",
    () => svc.spawnWorker("mgr1", { taskId: randomUUID(), agentId: "99999999", kickoffPrompt: "GO" }),
    "does not resolve to an existing agent");
  check("(3) a far id-shaped miss yields NO 'did you mean' and NO agent name",
    farErr != null && !String(farErr.message).includes("did you mean") && !/Solo|Alpha|Bravo/.test(String(farErr.message)));

  // ===================== (5) agent_get via the REAL PlatformMcpRouter over an in-memory MCP client ========
  // Seed a platform session so the elevated surface is reachable (resolveRole truthy), then connect a client
  // to the (private at TS, callable at runtime) buildServer().
  db.insertProject({ id: "pPlat", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "agentPL", projectId: "pPlat", name: "Platform Lead", startupPrompt: "PL", position: 0, profileId: null });
  db.insertSession({ id: "PL", projectId: "pPlat", agentId: "agentPL", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });
  const router = new PlatformMcpRouter(db, svc);
  const server = router.buildServer("PL");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agent-id-prefix-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const gPrefix = await call("agent_get", { agentId: "12ab34cd" });
  check("(5) agent_get resolves prefix '12ab34cd' → ID_SOLO (FULL record incl. startupPrompt)",
    gPrefix.id === ID_SOLO && gPrefix.startupPrompt === "SOLO");
  const gExact = await call("agent_get", { agentId: ID_SOLO });
  check("(5) agent_get exact id still resolves (regression)", gExact.id === ID_SOLO);
  const gAmb = await call("agent_get", { agentId: "feedface" });
  check("(5) agent_get on an ambiguous prefix errors, naming BOTH candidate ids",
    typeof gAmb.error === "string" && gAmb.error.includes("ambiguous") && gAmb.error.includes(ID_DUP_A) && gAmb.error.includes(ID_DUP_B));
  const gMiss = await call("agent_get", { agentId: "99999999" });
  check("(5) agent_get on an unknown prefix → 'agent not found'", gMiss.error === "agent not found");
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    for (const wt of worktrees.filter(Boolean)) { try { await removeWorktree(repo, wt); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn + agent_get resolve an unambiguous 8-char agent id-prefix, reject an ambiguous prefix naming the candidate ids, and route an id-shaped miss to an id-based hint (or none) — never a wrong agent name; exact-id + name resolution unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
