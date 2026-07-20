import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f6753002 — getProjectTask/listProjectTasks grew an `includeMerged` opt-out (default true, so
// tasks_get/tasks_list/project_task_get/list_all_tasks stay byte-identical) so the companion
// board_list/board_get (a latency-sensitive, non-surfacing path) can skip the git ship-state
// enrichment (readHeadSha + cached-map lookup) entirely instead of computing a field it discards.
//
// Proves:
//   (1) with a REAL landed task (a real git repo + a landed squash commit, same setup as
//       task-merged-state.mjs), includeMerged:true (the default) still resolves merged:{sha,date} on
//       both getProjectTask and listProjectTasks — the surfacing tools' behavior is unchanged.
//   (2) the SAME landed task resolves merged:null under includeMerged:false — since the task IS
//       actually merged, a non-null result would prove the enrichment ran; null proves the code path
//       was genuinely skipped, not just projected away downstream.
//   (3) the companion board_list/board_get capabilities (which call these with includeMerged:false)
//       never surface a `merged` field, over the SAME real landed-task repo — an end-to-end check that
//       the low-level opt-out is actually wired at the companion call sites.
//
// HERMETIC: a real temp git repo (execSync) + a real Db, driving the built business logic directly
// (dist/mcp/tasks.js) for (1)/(2), and the real OrchestrationMcpRouter over an in-memory MCP transport
// for (3). No daemon, no real claude.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-include-merged-opt-out.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-include-merged-opt-out-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const repo = path.join(os.tmpdir(), `loom-include-merged-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);

const file = path.join(os.tmpdir(), `loom-include-merged-${Date.now()}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // Land a real task via a squash commit carrying the Loom-Worker-Branch trailer.
  const task = createProjectTask(db, "pRepo", { title: "landed task" });
  const branch = `loom/${taskKey(task.id)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "feat(x): landed squash" -m "Loom-Worker-Branch: ${branch}"`);
  const mergedSha = git("log -1 --format=%H").trim();

  // (1) default (includeMerged:true) still resolves merged for the surfacing path.
  const gotDefault = await getProjectTask(db, "pRepo", task.id);
  check("(1) getProjectTask default (includeMerged:true) resolves merged", gotDefault.merged?.sha === mergedSha.slice(0, 7));
  const listDefault = await listProjectTasks(db, "pRepo", { includeBody: true });
  check("(1) listProjectTasks default (includeMerged:true) ALSO resolves merged", listDefault.find((t) => t.id === task.id)?.merged?.sha === mergedSha.slice(0, 7));

  // (2) includeMerged:false skips the enrichment for the SAME actually-landed task — merged:null
  // here proves the git lookup was never run, not merely projected away.
  const gotSkip = await getProjectTask(db, "pRepo", task.id, { includeMerged: false });
  check("(2) getProjectTask includeMerged:false resolves merged:null for an actually-landed task (enrichment skipped)", gotSkip.merged === null);
  const listSkip = await listProjectTasks(db, "pRepo", { includeBody: true, includeMerged: false });
  check("(2) listProjectTasks includeMerged:false ALSO resolves merged:null (enrichment skipped)", listSkip.find((t) => t.id === task.id)?.merged === null);

  // (3) end-to-end: the companion board_list/board_get capabilities call these with includeMerged:false —
  // confirm no `merged` field ever surfaces through that path, against the same real landed-task repo.
  const companionSess = "companion-include-merged";
  db.insertAgent({ id: `a-${companionSess}`, projectId: "pRepo", name: "assistant", startupPrompt: "", position: 0 });
  db.insertSession({
    id: companionSess, projectId: "pRepo", agentId: `a-${companionSess}`, engineSessionId: `eng-${companionSess}`,
    title: null, cwd: "pRepo", processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "assistant",
  });
  db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "board-reach", projectId: "pRepo", mode: "read" });
  const orch = new OrchestrationMcpRouter(db, {});
  const client = await connect(orch.buildServer(companionSess, "assistant"));

  const listRes = await call(client, "board_list", {});
  const row = listRes.cards?.find((c) => c.id === task.id);
  check("(3) board_list finds the landed task's card", !!row);
  check("(3) board_list never surfaces a `merged` field", row && !("merged" in row));

  const getRes = await call(client, "board_get", { project: "pRepo", taskId: task.id });
  check("(3) board_get finds the landed task's card", !!getRes.card);
  check("(3) board_get never surfaces a `merged` field", getRes.card && !("merged" in getRes.card));

  await client.close();
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — includeMerged:true (default) preserves getProjectTask/listProjectTasks' merged resolution, includeMerged:false genuinely skips the git ship-state enrichment (not just its projection) for an actually-landed task, and the companion board_list/board_get capabilities (which pass includeMerged:false) never surface `merged`."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
