import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3df86c87 — the HUMAN REST surface for task parents/relations (the contract the web board/drawer
// builds to; see docs/decisions/3df86c87-*.md "FROZEN contract for the web"). Real fastify app.inject over a
// throwaway Db, mirroring held-clear-guard.mjs's Part C. Proves:
//   (1) POST /api/projects/:id/tasks accepts parentId/blockedBy and rejects a bad one with a 400 that says
//       what would work — and leaves NO card behind;
//   (2) POST /api/tasks/:id runs parentId/relations through the SAME validator (depth, cross-project), and a
//       raw `parentId` in the body can never bypass it (nothing written on a 400);
//   (3) GET /api/tasks/:id carries parentId/parent/children{done,total,items}/relations (both directions);
//   (4) GET /api/projects/:id/board carries ONLY the light roll-up per card (no relation arrays);
//   (5) DELETE /api/tasks/:id on a parent with children succeeds and the children become top-level.
// Run: 1) build (turbo builds shared first), 2) node test/task-relations-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-relations-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const db = new Db(path.join(tmpHome, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "pA", name: "A", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "pB", name: "B", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
process.env.LOOM_PORT = String(hermeticPort());
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

const post = async (url, payload) => { const r = await app.inject({ method: "POST", url, payload }); return { code: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
const get = async (url) => { const r = await app.inject({ method: "GET", url }); return { code: r.statusCode, body: JSON.parse(r.body) }; };

try {
  const epic = (await post("/api/projects/pA/tasks", { title: "feat(x): epic" })).body;
  const kid = await post("/api/projects/pA/tasks", { title: "feat(x): child", parentId: epic.id });
  check("(1) create with parentId → 201 and the row carries parentId", kid.code === 201 && kid.body.parentId === epic.id);
  const grand = (await post("/api/projects/pA/tasks", { title: "feat(x): grandchild", parentId: kid.body.id })).body;
  const before = db.listTasks("pA").length;
  const deep = await post("/api/projects/pA/tasks", { title: "feat(x): too deep", parentId: grand.id });
  check("(1) a 3rd level is rejected with a 400 that says what would work", deep.code === 400 && /too deep/.test(deep.body.error) && /parentId:null/.test(deep.body.error));
  check("(1) ...and NO card was created by the rejected call", db.listTasks("pA").length === before);
  const blocker = (await post("/api/projects/pA/tasks", { title: "feat(x): blocker", columnKey: "in_progress" })).body;
  const blocked = (await post("/api/projects/pA/tasks", { title: "feat(x): blocked", blockedBy: [blocker.id] })).body;

  const foreign = (await post("/api/projects/pB/tasks", { title: "feat(x): other board" })).body;
  const xproj = await post(`/api/tasks/${kid.body.id}`, { parentId: foreign.id });
  check("(2) a cross-project parentId via POST /api/tasks/:id is a 400", xproj.code === 400 && /same-project only/.test(xproj.body.error));
  check("(2) ...and the raw parentId was NOT written (the validator cannot be bypassed)", db.getTask(kid.body.id).parentId === epic.id);
  const cyc = await post(`/api/tasks/${epic.id}`, { parentId: grand.id });
  check("(2) a cycle via POST is a 400", cyc.code === 400 && /cycle/.test(cyc.body.error));
  const bcyc = await post(`/api/tasks/${blocker.id}`, { blockedBy: [blocked.id] });
  check("(2) a blocks cycle via POST is a 400", bcyc.code === 400 && /cycle/.test(bcyc.body.error));
  const okMove = await post(`/api/tasks/${blocked.id}`, { parentId: epic.id, related: [kid.body.id], title: "feat(x): blocked (renamed)" });
  check("(2) a valid parent + relation + title patch is applied together", okMove.code === 200 && db.getTask(blocked.id).parentId === epic.id && db.getTask(blocked.id).title === "feat(x): blocked (renamed)");

  const one = await get(`/api/tasks/${epic.id}`);
  check("(3) GET /api/tasks/:id carries parentId/parent/children/relations", one.code === 200 && "parentId" in one.body && "parent" in one.body && "children" in one.body && "relations" in one.body);
  check("(3) children roll-up is exact and lists both children", one.body.children.total === 2 && one.body.children.done === 0 && one.body.children.items.length === 2);
  const blk = await get(`/api/tasks/${blocked.id}`);
  check("(3) the blocked card lists its OPEN blocker (resolved:false) and its parent", blk.body.relations.blockedBy[0]?.id === blocker.id && blk.body.relations.blockedBy[0]?.resolved === false && blk.body.parent?.id === epic.id);
  check("(3) the related card sees it from the other side", (await get(`/api/tasks/${kid.body.id}`)).body.relations.related[0]?.id === blocked.id);
  const blkr = await get(`/api/tasks/${blocker.id}`);
  check("(3) the blocker's reverse view lists what it blocks", blkr.body.relations.blocks[0]?.id === blocked.id);

  const board = await get("/api/projects/pA/board");
  const row = board.body.tasks.find((t) => t.id === blocked.id);
  check("(4) board list rows carry parentId + the light roll-up", row.parentId === epic.id && row.blockedByOpen === 1 && row.blockedByFirst?.id === blocker.id && row.childCount === 0);
  check("(4) ...and NO relation arrays (the list stays light)", !("relations" in row) && !("children" in row));
  const epicRow = board.body.tasks.find((t) => t.id === epic.id);
  check("(4) the epic row reads childCount 2 / childDone 0", epicRow.childCount === 2 && epicRow.childDone === 0);
  await post(`/api/tasks/${blocker.id}`, { columnKey: "done" });
  const board2 = await get("/api/projects/pA/board");
  check("(4) closing the blocker drops blockedByOpen to 0 on the next poll", board2.body.tasks.find((t) => t.id === blocked.id).blockedByOpen === 0);

  const epic2 = (await post("/api/projects/pA/tasks", { title: "feat(x): epic 2" })).body;
  // (6) the raw deferredUntilTaskId goes through the SAME validation (review 4d3096d0: it used to hit db.updateTask raw)
  const dA = (await post("/api/projects/pA/tasks", { title: "feat(x): defer A" })).body;
  const dB = (await post("/api/projects/pA/tasks", { title: "feat(x): defer B" })).body;
  const foreign2 = (await post("/api/projects/pB/tasks", { title: "feat(x): other board 2" })).body;
  const dBad = await post(`/api/tasks/${dA.id}`, { title: "feat(x): defer A (renamed)", deferredUntilTaskId: foreign2.id });
  check("(6) a cross-project deferredUntilTaskId via REST is a 400 (was written unvalidated)", dBad.code === 400 && /same-project only/.test(dBad.body.error));
  check("(6) ...and the accompanying title was NOT written (whole patch, all or nothing)", db.getTask(dA.id).title === "feat(x): defer A" && db.getTask(dA.id).deferredUntilTaskId === null);
  const dEmpty = await post(`/api/tasks/${dA.id}`, { deferredUntilTaskId: [] });
  check("(6) an empty array is a 400", dEmpty.code === 400 && /empty array/.test(dEmpty.body.error));
  const dSelf = await post(`/api/tasks/${dA.id}`, { deferredUntilTaskId: dA.id });
  check("(6) a self reference is a 400", dSelf.code === 400 && /itself/.test(dSelf.body.error));
  const dOk = await post(`/api/tasks/${dA.id}`, { deferred: true, deferredUntilTaskId: dB.id.slice(0, 8) });
  check("(6) a valid PREFIX id resolves to the full id and is stored as a flagged edge", dOk.code === 200 && db.getTask(dA.id).deferredUntilTaskId === dB.id && db.listRelations("pA").some((e) => e.fromTaskId === dB.id && e.toTaskId === dA.id && e.gatesDeferral));
  const dCyc = await post(`/api/tasks/${dB.id}`, { deferredUntilTaskId: dA.id });
  check("(6) a deferral cycle via REST is a 400", dCyc.code === 400 && /cycle/.test(dCyc.body.error));
  const dCyc2 = await post(`/api/tasks/${dB.id}`, { deferredUntilTaskId: dA.id, blocks: [dA.id] });
  check("(6) deferral + blocks combining into a cycle is ALSO a 400 (combined graph, no silent partial write)", dCyc2.code === 400);
  await post(`/api/tasks/${dA.id}`, { deferred: false, deferredUntilTaskId: null });
  check("(6) deferredUntilTaskId:null clears the alias edges", db.getTask(dA.id).deferredUntilTaskId === null && db.listRelations("pA").every((e) => !(e.toTaskId === dA.id && e.gatesDeferral)));

  // (7) plan AFTER the last await (review 8d5f73bd): a repoKey + parent/relation patch must work together, and the
  // planner call must sit AFTER checkTaskRepoKeyRebind in the update route, with no await between plan and apply.
  const rk = await post(`/api/tasks/${dB.id}`, { repoKey: "primary", parentId: epic2.id, related: [dA.id] });
  check("(7) a repoKey + parentId + related patch applies together", rk.code === 200 && db.getTask(dB.id).parentId === epic2.id);
  const src = fs.readFileSync(new URL("../dist/gateway/server.js", import.meta.url), "utf8");
  const routeStart = src.indexOf('app.post("/api/tasks/:id"');
  const routeSrc = src.slice(routeStart, src.indexOf('app.delete("/api/tasks/:id"', routeStart));
  // strip comments first (a comment naming one of these calls must not satisfy or fail the scan), then check EVERY
  // applyTaskPlan( call site: its nearest preceding planTaskStructure( must come after checkTaskRepoKeyRebind( and
  // have no await between the two.
  const code = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const iRebind = code.indexOf("checkTaskRepoKeyRebind(");
  const applyIdx = [];
  for (let i = code.indexOf("applyTaskPlan("); i >= 0; i = code.indexOf("applyTaskPlan(", i + 1)) applyIdx.push(i);
  const scanOk = applyIdx.length >= 2 && applyIdx.every((ia) => { const ip = code.lastIndexOf("planTaskStructure(", ia); return ip > iRebind && iRebind > 0 && !/\bawait\b/.test(code.slice(ip, ia)); });
  check("(7) SOURCE-ORDER scan (comments stripped, EVERY applyTaskPlan( site — " + applyIdx.length + " found): the update route plans AFTER checkTaskRepoKeyRebind, with no await between plan and apply", scanOk);

  const del = await app.inject({ method: "DELETE", url: `/api/tasks/${epic.id}` });
  check("(5) deleting a parent WITH children succeeds", del.statusCode === 200 && db.getTask(epic.id) === undefined);
  check("(5) ...and its children are top-level now", db.getTask(kid.body.id).parentId === null && db.getTask(blocked.id).parentId === null);
} finally {
  await app.close?.();
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the REST surface validates parents/relations through the one validator, exposes the frozen drawer + light board shapes, and a parent delete detaches its children."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
