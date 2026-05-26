// Integrated phase-1 end-to-end pass: drives the WHOLE assembled product through one
// running daemon, exercising every surface the UI sits on top of, in one flow:
//   project -> topic -> board task + move -> spawn real session (live terminal) ->
//   agent sees the board via MCP -> vault browse -> git view -> transcript ->
//   dead-session detection (grey-out).
// Run: 1) start the daemon, 2) node test/integration-e2e.mjs
//
// This is the one test that MUST spawn a real `claude` (so it can't use an isolated
// CLAUDE_CONFIG_DIR — that breaks the unattended spawn; see test/claude-config.mjs). The
// real spawn makes the daemon's ensureTrusted add a trust entry for our temp dir into the
// real ~/.claude.json. The finally block surgically removes ONLY that entry and the temp
// dir afterward, so the suite leaves ~/.claude.json and %TEMP% unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = "http://127.0.0.1:4317";
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const postRaw = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encodeProjectDir = (cwd) => path.resolve(cwd).replace(/[:\\/]/g, "-");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- a real git repo with docs, used as both repo + vault ---
const dir = path.join(os.tmpdir(), `loom-e2e-${Date.now()}`);
fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
fs.writeFileSync(path.join(dir, "README.md"), "# E2E Project\nIntegrated phase-1 pass.\n");
fs.writeFileSync(path.join(dir, "docs", "note.md"), "# Note\nhello vault\n");
execSync(`git init -q && git add . && git -c user.email=e2e@loom -c user.name=e2e commit -q -m "init e2e"`, { cwd: dir });

// Hermeticity bookkeeping: the trust key ensureTrusted will add, and whether the real
// ~/.claude.json already had it (it shouldn't — fresh temp dir — but only remove what we add).
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let session = null;
try {
  // 1. project + topic
  const P = await post("/api/projects", { name: `E2E-${Date.now()}`, repoPath: dir, vaultPath: dir });
  check("1. project created", !!P.id);
  const PROMPT = "Call the tasks_list tool. Then call tasks_create with title set to exactly 'SAW=' followed by the titles of the tasks you saw joined with '+'. Then stop. Do not use other tools or ask questions.";
  const topic = await post(`/api/projects/${P.id}/topics`, { name: "build", startupPrompt: PROMPT });
  check("1. topic created", !!topic.id);

  // 2. board: create a task and MOVE it (the kanban drag path)
  const t1 = await post(`/api/projects/${P.id}/tasks`, { title: "T1" });
  await post(`/api/tasks/${t1.id}`, { columnKey: "in_progress" });
  const board = await get(`/api/projects/${P.id}/board`);
  check("2. board has 6 resolved columns", board.columns.length === 6);
  check("2. card T1 moved to in_progress", board.tasks.find((t) => t.id === t1.id)?.columnKey === "in_progress");

  // 3. spawn -> live session + engine id (the live terminal)
  session = await post(`/api/topics/${topic.id}/sessions`, {});
  check("3. session spawned live", session.processState === "live");
  let engineId = null;
  for (let i = 0; i < 40 && !engineId; i++) {
    await sleep(1000);
    engineId = (await get("/api/sessions")).find((s) => s.id === session.id)?.engineSessionId;
  }
  check("3. engine session id captured (terminal warmed)", !!engineId);

  // 4. the spawned agent saw the board via MCP (board <-> MCP integration in-flow)
  let marker = null;
  for (let i = 0; i < 40 && !marker; i++) {
    await sleep(1500);
    marker = (await get(`/api/projects/${P.id}/board`)).tasks.find((t) => t.title.startsWith("SAW="));
  }
  check("4. agent's tasks_list saw the board task T1", !!marker && marker.title.includes("T1"));

  // 5. vault browse + file viewer
  const tree = await get(`/api/projects/${P.id}/vault`);
  const files = new Set(tree.map((e) => e.path));
  check("5. vault tree lists README.md and docs/note.md", files.has("README.md") && files.has("docs/note.md"));
  const readme = await get(`/api/projects/${P.id}/vault/file?path=README.md`);
  check("5. vault file viewer returns content", readme.content.includes("E2E Project"));

  // 6. git view
  const branches = await get(`/api/projects/${P.id}/git/branches`);
  check("6. git branches present", branches.all.length >= 1);
  const log = await get(`/api/projects/${P.id}/git/log`);
  check("6. git log shows the init commit", log.some((c) => c.message === "init e2e"));

  // 7. transcript
  const tx = await get(`/api/sessions/${session.id}/transcript`);
  check("7. transcript renders real turns", tx.length > 0 && tx.some((t) => t.role === "assistant"));

  // 8. dead-session grey-out: stop, delete the engine transcript, let the watcher mark it dead
  await post(`/api/sessions/${session.id}/stop`, { mode: "hard" });
  await sleep(1500);
  if (engineId) fs.rmSync(path.join(os.homedir(), ".claude", "projects", encodeProjectDir(dir), `${engineId}.jsonl`), { force: true });
  let dead = false;
  for (let i = 0; i < 12 && !dead; i++) {
    await sleep(1000);
    dead = (await get("/api/sessions")).find((s) => s.id === session.id)?.resumability === "dead";
  }
  check("8. session greyed out as dead once its transcript vanished", dead);
} finally {
  // Tear down so the suite is hermetic: stop a still-live session, remove ONLY the trust entry
  // we caused (if we added it), and drop the temp dir.
  try { if (session?.id) await postRaw(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) {
        delete cfg.projects[trustKey];
        writeJsonAtomic(realClaudeJson, cfg); // atomic: a crash mid-write can't corrupt the real config
      }
    } catch { /* nothing to clean */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ INTEGRATED PASS — the assembled phase-1 product works end-to-end in one session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
