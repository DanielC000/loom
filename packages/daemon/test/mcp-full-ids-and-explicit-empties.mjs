import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// One check per sub-point of the "full worker ids in notices + explicit empty results" fix.
//   (a) the busy-worker notice prints the FULL worker session id (the worker_* tools need it whole).
//   (b) tasks_create accepts deferred/deferredUntilTaskId/deferredReason, symmetric with tasks_update.
//   (c) an empty tasks_list returns an explicit, non-empty envelope — never text:"".
//   (d) memory_write's slug error names the offending character.
//   (e) tasks_update appendBody returns a short ack; returnFullTask:true opts back into the full row.
// HERMETIC: temp LOOM_HOME, real Db, real TaskMcpRouter over an in-process transport, no daemon/claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-fid-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { BusyWorkerWatcher } = await import("../dist/orchestration/busy-worker-watcher.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { writeProjectMemory } = await import("../dist/mcp/memory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const NOW = new Date("2026-06-03T12:00:00.000Z");
const nowIso = NOW.toISOString();
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const db = new Db(path.join(tmpHome, "fid.db"));
const projId = "p-fid";
const MGR = "mgr-session-full-id-0001";
const WORKER = randomUUID();
db.insertProject({ id: projId, name: "Fid", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: nowIso, archivedAt: null, reserved: false });
db.insertAgent({ id: "ag-fid", projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
const seed = (id, role, extra = {}) => db.insertSession({
  id, projectId: projId, agentId: "ag-fid", engineSessionId: "eng-" + id, title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: nowIso, lastActivity: nowIso,
  lastError: null, role, ...extra,
});
seed(MGR, "manager");

try {
  // ===== (a) full worker id in the busy-worker notice =====
  seed(WORKER, "worker", { busy: true, createdAt: minutesAgo(65), lastActivity: minutesAgo(65), parentSessionId: MGR, taskId: randomUUID() });
  const enqueued = [];
  const pty = { isAlive: () => true, enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; } };
  new BusyWorkerWatcher({ db, pty, control: new OrchestrationControl() }).tick(NOW);
  const notice = enqueued.find((m) => m.id === MGR)?.text ?? "";
  check("(a) the notice was delivered to the manager", notice.startsWith("[loom:worker-busy-long]"));
  check("(a) the notice carries the FULL worker session id", notice.includes(`worker ${WORKER} `));
  check("(a) NEGATIVE CONTROL: the 8-char prefix alone is not what the notice prints", !notice.includes(`worker ${WORKER.slice(0, 8)} `));

  const server = new TaskMcpRouter(db, new WakeService({ db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {} })).buildServer(projId, MGR);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "full-ids-test", version: "0" });
  await client.connect(clientT);
  const raw = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  const call = async (name, args) => JSON.parse(await raw(name, args));

  // ===== (c) empty tasks_list is explicit =====
  const emptyText = await raw("tasks_list", { titleContains: "no-such-card-anywhere" });
  check("(c) an empty tasks_list response is NON-empty text", emptyText.length > 0);
  const emptyObj = JSON.parse(emptyText);
  check("(c) ...an explicit envelope with rows:[] total:0 returned:0", Array.isArray(emptyObj.rows) && emptyObj.rows.length === 0 && emptyObj.total === 0 && emptyObj.returned === 0);
  // Contrast: a non-empty list is still bare NDJSON (no envelope).
  await call("tasks_create", { title: "feat(daemon): contrast card" });
  const nonEmpty = await raw("tasks_list", { titleContains: "contrast card" });
  check("(c) CONTRAST: a non-empty list is still bare NDJSON rows", nonEmpty.startsWith("{\"id\"") && !("rows" in JSON.parse(nonEmpty.split("\n")[0])));

  // ===== (b) tasks_create with deferral fields =====
  const blocker = await call("tasks_create", { title: "feat(daemon): the blocker" });
  const viaBlocker = await call("tasks_create", { title: "feat(daemon): deferred behind blocker", deferred: true, deferredUntilTaskId: blocker.id });
  check("(b) create with deferred+deferredUntilTaskId succeeds", !viaBlocker.error && !viaBlocker.deferralError);
  check("(b) the stored row is deferred behind the blocker", db.getTask(viaBlocker.id)?.deferred === true && db.getTask(viaBlocker.id)?.deferredUntilTaskId === blocker.id);
  const manual = await call("tasks_create", { title: "feat(daemon): manually deferred", deferred: true, deferredReason: "waiting on the owner" });
  check("(b) a manual deferral with deferredReason is stored", db.getTask(manual.id)?.deferred === true && db.getTask(manual.id)?.deferredReason === "waiting on the owner");
  const noReason = await call("tasks_create", { title: "feat(daemon): manual deferral without reason", deferred: true });
  check("(b) a manual deferral WITHOUT a reason is refused exactly like tasks_update (deferralError)", typeof noReason.deferralError === "string" && noReason.deferralError.includes("deferredReason"));
  check("(b) ...but the card itself was still created, and is not deferred", !!db.getTask(noReason.id) && db.getTask(noReason.id).deferred !== true);
  const plain = await call("tasks_create", { title: "feat(daemon): plain create" });
  check("(b) CONTRAST: a create with no deferral fields is unchanged (no deferral, no deferralError)", !plain.deferralError && db.getTask(plain.id)?.deferred !== true);

  // ===== (e) appendBody ack =====
  const card = await call("tasks_create", { title: "feat(daemon): append target", body: "ORIGINAL-BODY-MARKER" });
  const ack = await call("tasks_update", { id: card.id, appendBody: "a triage note" });
  check("(e) appendBody returns a trimmed ack: no body key", !("body" in ack) && ack.id === card.id && typeof ack.version === "number");
  check("(e) ...whose `changed` names body", Array.isArray(ack.changed) && ack.changed.includes("body"));
  check("(e) ...and the append really landed", db.getTask(card.id).body.includes("ORIGINAL-BODY-MARKER") && db.getTask(card.id).body.includes("a triage note"));
  const full = await call("tasks_update", { id: card.id, appendBody: "second note", returnFullTask: true });
  check("(e) returnFullTask:true returns the full task incl. body", typeof full.body === "string" && full.body.includes("ORIGINAL-BODY-MARKER") && full.body.includes("second note"));
  const replaced = await call("tasks_update", { id: card.id, body: "replacement", baseVersion: full.version });
  check("(e) CONTRAST: a plain `body` replace still returns the full task", replaced.body === "replacement");

  // ===== (d) slug error names the offending character =====
  const bad = writeProjectMemory(db, projId, { key: "has space", text: "x" });
  check("(d) the slug error names the offending character and its position", typeof bad.error === "string" && bad.error.includes('" "') && bad.error.includes("position 4"));
  const badDot = writeProjectMemory(db, projId, { key: "ok.dot", text: "x" });
  check("(d) a different offender (a dot) is named too", typeof badDot.error === "string" && badDot.error.includes('"."'));
  const tooLong = writeProjectMemory(db, projId, { key: "a".repeat(65), text: "x" });
  check("(d) an over-long key names the length rule", typeof tooLong.error === "string" && tooLong.error.includes("65 characters"));
  const good = writeProjectMemory(db, projId, { key: "good-key_1", text: "x" });
  check("(d) CONTRAST: a valid slug is accepted", !good.error);
} finally {
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
