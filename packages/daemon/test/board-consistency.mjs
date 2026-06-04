import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// DoD for the Task board chunk: prove the kanban (REST) and the MCP task tools read/write
// the SAME store with no divergence — including a column MOVE.
//
// Flow: REST creates task BOARD-ONE (backlog), then REST MOVES it to "review". A real
// spawned agent calls tasks_list and writes back each task as title@columnKey. We assert the
// agent saw BOARD-ONE@review (REST writes -> MCP reads, move included) and that the agent's
// created marker is visible via REST (MCP writes -> REST reads).
//
// HERMETIC: boots its OWN isolated daemon on a temp LOOM_HOME + a non-4317 LOOM_PORT (mirroring
// profiles-rest.mjs / skills-e2e.mjs) so it NEVER touches the real ~/.loom or the prod loom.db —
// the Board-<ts> project/agent/session it creates live only in the throwaway db, which is deleted
// on teardown. Spawns one real claude. Run after build (needs dist/):  node test/board-consistency.mjs
// (honors LOOM_HOME/LOOM_PORT if you pre-set them to target an externally-started daemon instead.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOOM_PORT) || 4318 + (process.pid % 900); // non-4317, low-collision
const BASE = `http://127.0.0.1:${PORT}`;
const ownDaemon = !process.env.LOOM_HOME; // if the operator pre-set LOOM_HOME we reuse their daemon
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.tmpdir(), `loom-board-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(LOOM_HOME, { recursive: true });

// The project's repo/vault dir — separate from LOOM_HOME; also the spawned agent's cwd.
const dir = path.join(os.tmpdir(), `loom-board-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const PROMPT =
  "You are in an automated test. Do EXACTLY this and nothing else: " +
  "(1) Call the tasks_list tool. " +
  "(2) For each task returned, form the string: its 'title', then '@', then its 'columnKey'. " +
  "(3) Call the tasks_create tool with title set to exactly 'SAW=' followed by those strings joined with '+'. " +
  "(4) Then stop. Do not call any other tools and do not ask questions.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const get = async (u) => (await fetch(BASE + u)).json();

// The real-claude spawn adds a trust key for `dir` to ~/.claude.json — clean it iff it wasn't there.
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const hadTrust = (() => { try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; } })();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- boot the isolated daemon (dist/index.js) ---
let daemon = null;
if (ownDaemon) {
  daemon = spawn(process.execPath, [path.join(__dirname, "..", "dist", "index.js")], {
    env: { ...process.env, LOOM_HOME, LOOM_PORT: String(PORT), LOOM_SCHEDULER_ENABLED: "0" },
    stdio: "ignore",
  });
}
async function waitReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

let session = null;
try {
  if (!(await waitReady())) { console.error("daemon did not become ready"); process.exit(2); }

  const P = await post("/api/projects", { name: `Board-${Date.now()}`, repoPath: dir, vaultPath: dir });
  const t1 = await post(`/api/projects/${P.id}/tasks`, { title: "BOARD-ONE" });           // backlog
  await post(`/api/tasks/${t1.id}`, { columnKey: "review" });                              // MOVE via REST
  const agent = await post(`/api/projects/${P.id}/agents`, { name: "probe", startupPrompt: PROMPT });
  session = await post(`/api/agents/${agent.id}/sessions`, {});
  console.log(`spawned ${session.id}; REST created BOARD-ONE and moved it to 'review'. Waiting for the agent...`);

  let marker = null;
  for (let i = 0; i < 75; i++) {
    await sleep(2000);
    const { tasks } = await get(`/api/projects/${P.id}/board`);
    marker = tasks.find((t) => t.title.startsWith("SAW="));
    if (marker) { console.log(`[${i * 2}s] marker: "${marker.title}"`); break; }
  }

  check("agent produced a SAW= marker (MCP write -> visible via REST board)", !!marker);
  check("agent's tasks_list saw the REST-created+moved task as BOARD-ONE@review",
    !!marker && marker.title.includes("BOARD-ONE@review"));
} finally {
  // Hard-stop the pty first so the OS releases the agent's .claude/ handles under `dir`.
  try { if (session?.id) await post(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1000);
  try { daemon?.kill(); } catch { /* ignore */ }
  await sleep(1000);
  // The spawned agent's cwd is `dir`, so on Windows the OS can briefly hold its .claude/
  // handles after the hard-stop kills the pty. Retry the removal a few times until the
  // handles release so the temp dir never leaks.
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break; }
    catch { await sleep(300); }
  }
  if (ownDaemon) { try { fs.rmSync(LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort (WAL handle) */ } }
  // Surgically remove the trust key the spawn added to the REAL ~/.claude.json (iff we added it).
  if (!hadTrust) {
    try { const c = JSON.parse(fs.readFileSync(realClaudeJson, "utf8")); if (c.projects && trustKey in c.projects) { delete c.projects[trustKey]; fs.writeFileSync(realClaudeJson, JSON.stringify(c, null, 2)); } } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\nALL PASS — kanban (REST) and MCP tools share one task store; moves propagate both ways (isolated daemon)."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
