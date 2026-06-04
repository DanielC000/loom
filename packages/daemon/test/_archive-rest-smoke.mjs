// Throwaway REST smoke for the session-archive endpoints (NOT a kept test). Seeds the running
// daemon's DB directly (sessions are 'exited', so no race with boot recover), pre-writes the
// manager's transcript snapshot, then drives the REST routes. Run against an ISOLATED daemon:
//   LOOM_HOME=<temp> LOOM_PORT=4399 node dist/index.js        (background)
//   LOOM_HOME=<temp> LOOM_PORT=4399 node test/_archive-rest-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = `http://127.0.0.1:${process.env.LOOM_PORT}`;
const LOOM = process.env.LOOM_HOME;
const get = async (u) => (await fetch(BASE + u)).json();
const post = (u) => fetch(BASE + u, { method: "POST" });
const del = (u) => fetch(BASE + u, { method: "DELETE" });

let failures = 0;
const check = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) failures++; };

const projId = "rp", agentId = "ra", mgr = "rmgr", w1 = "rw1";
const now = new Date().toISOString();

// ── seed the daemon's DB directly (WAL allows a concurrent writer) ──
const db = new Database(path.join(LOOM, "loom.db"));
db.prepare("INSERT OR IGNORE INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at) VALUES (?,?,?,?,?,?,NULL)")
  .run(projId, "RestArch", "C:/tmp/rp", "C:/tmp/rp", "{}", now);
db.prepare("INSERT OR IGNORE INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,0)")
  .run(agentId, projId, "ra", "");
const ins = db.prepare(`INSERT OR IGNORE INTO sessions (id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error,role,parent_session_id)
  VALUES (?,?,?,?,NULL,?,'exited','resumable',0,?,?,NULL,?,?)`);
ins.run(mgr, projId, agentId, "rest-eng", "C:/tmp/rp", now, now, "manager", null);
ins.run(w1, projId, agentId, "rest-eng-w1", "C:/tmp/rp", now, now, "worker", mgr);
db.close();

// pre-write the manager's snapshot (simulates the on-exit copy); keyed by (projId, sessionId).
const snap = path.join(LOOM, "archives", projId, `${mgr}.jsonl`);
fs.mkdirSync(path.dirname(snap), { recursive: true });
fs.writeFileSync(snap,
  '{"type":"user","message":{"content":"hello"}}\n' +
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}\n');

const aRes = await (await post(`/api/sessions/${mgr}/archive`)).json();
check("REST archive cascades (mgr + w1)", aRes.archived?.length === 2 && aRes.archived.includes(w1));
const all = await get("/api/sessions");
check("REST archived rows excluded from /api/sessions", !all.some((s) => s.id === mgr || s.id === w1));
const arch = await get(`/api/projects/${projId}/archive`);
check("REST archive list returns 2", arch.length === 2);
check("REST mgr row snapshotExists=true", arch.find((s) => s.id === mgr)?.snapshotExists === true);
check("REST w1 row snapshotExists=false", arch.find((s) => s.id === w1)?.snapshotExists === false);
const turns = await get(`/api/sessions/${mgr}/transcript`);
check("REST transcript falls back to the snapshot (2 turns)", Array.isArray(turns) && turns.length === 2 && turns[0].text === "hello");
await post(`/api/sessions/${w1}/restore`);
check("REST restore returns w1 to the rail", (await get("/api/sessions")).some((s) => s.id === w1));
const dRes = await (await del(`/api/sessions/${mgr}/archive`)).json();
check("REST delete removes mgr only (w1 restored)", dRes.deleted?.includes(mgr) && !dRes.deleted.includes(w1));
check("REST archive list empty after delete", (await get(`/api/projects/${projId}/archive`)).length === 0);
check("REST snapshot file removed on delete", !fs.existsSync(snap));

console.log(failures === 0 ? "\n✅ REST smoke PASS" : `\n❌ ${failures} REST FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
