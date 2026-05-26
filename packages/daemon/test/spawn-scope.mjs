// DEFINITION-OF-DONE for the spawn-from-UI chunk: the FULLER real-claude §6 scoping test.
//
// Unlike test/mcp-scope.mjs (which drives the MCP client directly), this spawns a REAL
// interactive `claude` session via the daemon — exercising the --mcp-config injection in
// pty/host.ts — and proves the agent itself can only see its own project's tasks.
//
// Flow: create projects A (task ALPHA-ONLY) and B (task BETA-ONLY); create a topic in A whose
// startup prompt instructs the agent to call tasks_list and write back what it saw as a
// "SAW=..." marker task; spawn the session; then assert via the DB that A got SAW=ALPHA-ONLY
// (never BETA-ONLY) and B got no marker.
//
// Run: 1) start the daemon (node dist/index.js), 2) node test/spawn-scope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:4317";
const stamp = Date.now();
const dirA = path.join(os.tmpdir(), `loom-test-A-${stamp}`);
const dirB = path.join(os.tmpdir(), `loom-test-B-${stamp}`);
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const PROMPT =
  "You are in an automated test. Do EXACTLY this and nothing else: " +
  "(1) Call the tasks_list tool. " +
  "(2) Join the 'title' of every task it returns with '+'. " +
  "(3) Call the tasks_create tool with title set to exactly 'SAW=' followed by that joined string " +
  "(e.g. 'SAW=Foo+Bar'). (4) Then stop. Do not call any other tools and do not ask questions.";

const post = async (url, body) =>
  (await fetch(BASE + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
const get = async (url) => (await fetch(BASE + url)).json();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const A = await post("/api/projects", { name: `A-${stamp}`, repoPath: dirA, vaultPath: dirA });
const B = await post("/api/projects", { name: `B-${stamp}`, repoPath: dirB, vaultPath: dirB });
await post(`/api/projects/${A.id}/tasks`, { title: "ALPHA-ONLY" });
await post(`/api/projects/${B.id}/tasks`, { title: "BETA-ONLY" });
const topicA = await post(`/api/projects/${A.id}/topics`, { name: "probe", startupPrompt: PROMPT });
const session = await post(`/api/topics/${topicA.id}/sessions`, {});
console.log(`spawned session ${session.id} in project A (${dirA})`);
console.log("waiting for the real claude agent to call tasks_list + write the SAW marker...");

let marker = null;
for (let i = 0; i < 75; i++) {            // up to ~150s
  await new Promise((r) => setTimeout(r, 2000));
  const tasksA = await get(`/api/projects/${A.id}/tasks`);
  marker = tasksA.find((t) => t.title.startsWith("SAW="));
  if (marker) { console.log(`[${i * 2}s] marker appeared: "${marker.title}"`); break; }
}

check("agent produced a SAW= marker in project A", !!marker);
if (marker) {
  check(`marker reflects A's task only: includes ALPHA-ONLY  ("${marker.title}")`, marker.title.includes("ALPHA-ONLY"));
  check(`marker did NOT leak B's task: excludes BETA-ONLY`, !marker.title.includes("BETA-ONLY"));
}
const tasksB = await get(`/api/projects/${B.id}/tasks`);
check("project B received no marker (agent could not write across projects)",
  !tasksB.some((t) => t.title.startsWith("SAW=")));

await post(`/api/sessions/${session.id}/stop`, { mode: "hard" });
console.log(failures === 0
  ? "\nALL PASS — real-claude MCP auto-scoping holds end-to-end via pty --mcp-config injection (§6)."
  : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
