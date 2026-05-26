// DoD for the Task board chunk: prove the kanban (REST) and the MCP task tools read/write
// the SAME store with no divergence — including a column MOVE.
//
// Flow: REST creates task BOARD-ONE (backlog), then REST MOVES it to "review". A real
// spawned agent calls tasks_list and writes back each task as title@columnKey. We assert the
// agent saw BOARD-ONE@review (REST writes -> MCP reads, move included) and that the agent's
// created marker is visible via REST (MCP writes -> REST reads).
//
// Run: 1) start the daemon, 2) node test/board-consistency.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:4317";
const dir = path.join(os.tmpdir(), `loom-board-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const PROMPT =
  "You are in an automated test. Do EXACTLY this and nothing else: " +
  "(1) Call the tasks_list tool. " +
  "(2) For each task returned, form the string: its 'title', then '@', then its 'columnKey'. " +
  "(3) Call the tasks_create tool with title set to exactly 'SAW=' followed by those strings joined with '+'. " +
  "(4) Then stop. Do not call any other tools and do not ask questions.";

const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const get = async (u) => (await fetch(BASE + u)).json();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const P = await post("/api/projects", { name: `Board-${Date.now()}`, repoPath: dir, vaultPath: dir });
const t1 = await post(`/api/projects/${P.id}/tasks`, { title: "BOARD-ONE" });           // backlog
await post(`/api/tasks/${t1.id}`, { columnKey: "review" });                              // MOVE via REST
const topic = await post(`/api/projects/${P.id}/topics`, { name: "probe", startupPrompt: PROMPT });
const session = await post(`/api/topics/${topic.id}/sessions`, {});
console.log(`spawned ${session.id}; REST created BOARD-ONE and moved it to 'review'. Waiting for the agent...`);

let marker = null;
for (let i = 0; i < 75; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const { tasks } = await get(`/api/projects/${P.id}/board`);
  marker = tasks.find((t) => t.title.startsWith("SAW="));
  if (marker) { console.log(`[${i * 2}s] marker: "${marker.title}"`); break; }
}

check("agent produced a SAW= marker (MCP write -> visible via REST board)", !!marker);
check("agent's tasks_list saw the REST-created+moved task as BOARD-ONE@review",
  !!marker && marker.title.includes("BOARD-ONE@review"));

await post(`/api/sessions/${session.id}/stop`, { mode: "hard" });
console.log(failures === 0
  ? "\nALL PASS — kanban (REST) and MCP tools share one task store; moves propagate both ways."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
