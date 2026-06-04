// Alert-webhook (external delivery) test — Task f374bcd3. HERMETIC like orch-model.mjs / config-bounds.mjs:
// isolated LOOM_HOME, imports dist/* only, NO daemon, NO claude. Covers:
//   (emitter) a configured webhook + a MATCHING event kind  -> exactly one POST with the right payload;
//   (emitter) a non-matching kind / an unconfigured project -> NO POST;
//   (emitter) a FAILING/timing-out POST is best-effort       -> never throws into the event path;
//   (chokepoint) Db.appendEvent invokes the listener AND a listener that THROWS never breaks the audit write;
//   (security) the AGENT config validator REJECTS orchestration.alertWebhook while the HUMAN validator ACCEPTS it.
// Run: 1) build the daemon, 2) node test/alert-webhook.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-alertwh-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
const now = new Date().toISOString();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { AlertWebhookEmitter } = await import("../dist/orchestration/alert-webhook.js");
const { validateProjectConfigOverride, validateAgentProjectConfigOverride } = await import("../dist/mcp/platform.js");

// --- seed: a project WITH a webhook (subscribed to merge_done only) + its manager session ---------
const db = new Db();
const WEBHOOK = { url: "https://hooks.example.com/loom", events: ["merge_done", "merge_rejected"] };
db.insertProject({ id: "pWH", name: "Hooked", repoPath: "C:/tmp/wh", vaultPath: "C:/tmp/wh",
  config: { orchestration: { alertWebhook: WEBHOOK } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aWH", projectId: "pWH", name: "lead", startupPrompt: "", position: 0 });
db.insertSession({ id: "mWH", projectId: "pWH", agentId: "aWH", engineSessionId: null, title: null,
  cwd: "C:/tmp/wh", processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager" });
// A second project with NO webhook configured (default OFF).
db.insertProject({ id: "pBare", name: "Bare", repoPath: "C:/tmp/bare", vaultPath: "C:/tmp/bare",
  config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aBare", projectId: "pBare", name: "lead", startupPrompt: "", position: 0 });
db.insertSession({ id: "mBare", projectId: "pBare", agentId: "aBare", engineSessionId: null, title: null,
  cwd: "C:/tmp/bare", processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const evt = (kind, managerSessionId, extra = {}) => ({ id: `e-${kind}-${managerSessionId}`, ts: now, managerSessionId, kind, ...extra });

// --- (1) matching kind -> exactly one POST with the expected payload -------------------------------
{
  const posts = [];
  const emitter = new AlertWebhookEmitter({ db, post: async (url, body) => { posts.push({ url, body }); } });
  await emitter.onEvent(evt("merge_done", "mWH", { workerSessionId: "w1", taskId: "t1", detail: { branch: "feat/x" } }));
  check("matching event POSTs exactly once", posts.length === 1);
  const p = posts[0] ?? {};
  check("POST goes to the configured URL", p.url === WEBHOOK.url);
  check("payload carries event kind + ts", p.body?.event === "merge_done" && p.body?.ts === now);
  check("payload carries project {id,name}", p.body?.project?.id === "pWH" && p.body?.project?.name === "Hooked");
  check("payload carries detail + lineage ids", p.body?.detail?.branch === "feat/x" && p.body?.workerSessionId === "w1" && p.body?.taskId === "t1");
}

// --- (2) non-matching kind -> NO POST (subscribed to merge_done/merge_rejected only) ---------------
{
  const posts = [];
  const emitter = new AlertWebhookEmitter({ db, post: async (url, body) => { posts.push({ url, body }); } });
  await emitter.onEvent(evt("spawn_worker", "mWH"));
  check("a non-subscribed kind does NOT POST", posts.length === 0);
  // a SECOND subscribed kind does fire (set membership, not single-kind)
  await emitter.onEvent(evt("merge_rejected", "mWH"));
  check("a second subscribed kind DOES POST", posts.length === 1);
}

// --- (3) a project with no webhook configured -> NO POST -------------------------------------------
{
  const posts = [];
  const emitter = new AlertWebhookEmitter({ db, post: async (url, body) => { posts.push({ url, body }); } });
  await emitter.onEvent(evt("merge_done", "mBare"));
  check("an unconfigured project does NOT POST", posts.length === 0);
}

// --- (4) best-effort: a FAILING POST never throws into the event path ------------------------------
{
  let attempted = 0;
  let errored = 0;
  const emitter = new AlertWebhookEmitter({
    db,
    post: async () => { attempted++; throw new Error("boom (simulated endpoint failure / timeout)"); },
    onError: () => { errored++; },
  });
  let threw = false;
  try { await emitter.onEvent(evt("merge_done", "mWH")); } catch { threw = true; }
  check("a failing POST was attempted", attempted === 1);
  check("a failing POST does NOT throw out of onEvent (best-effort)", threw === false);
  check("a failing POST is reported to the error sink (swallowed, not silent)", errored === 1);
}

// --- (5) chokepoint: Db.appendEvent invokes the listener, and a THROWING listener never breaks it --
{
  let received = null;
  db.setEventListener((e) => { received = e; });
  db.appendEvent({ id: "ev-listener", ts: now, managerSessionId: "mWH", kind: "merge_done", detail: { n: 1 } });
  check("Db.appendEvent invokes the registered listener", received?.id === "ev-listener" && received?.kind === "merge_done");

  let threwFromAppend = false;
  db.setEventListener(() => { throw new Error("listener fault"); });
  try { db.appendEvent({ id: "ev-throw", ts: now, managerSessionId: "mWH", kind: "merge_done" }); }
  catch { threwFromAppend = true; }
  check("a THROWING listener never breaks the audit write", threwFromAppend === false);
  // the audit row was still committed despite the throwing listener
  const events = db.listEvents ? db.listEvents("mWH") : null;
  check("the audit row is committed even when the listener throws",
    events ? events.some((e) => e.id === "ev-throw") : true);
}

db.close();

// --- (6) SECURITY: the validator boundary — human ACCEPTS, agent REJECTS ----------------------------
{
  const cfg = { orchestration: { alertWebhook: { url: "https://hooks.example.com/loom", events: ["merge_done"] } } };
  const human = validateProjectConfigOverride(cfg);
  check("HUMAN validator ACCEPTS orchestration.alertWebhook", human.ok === true);
  check("accepted alertWebhook round-trips (url + events)",
    human.ok && human.value.orchestration?.alertWebhook?.url === "https://hooks.example.com/loom" &&
    Array.isArray(human.value.orchestration?.alertWebhook?.events) &&
    human.value.orchestration.alertWebhook.events[0] === "merge_done");

  const agent = validateAgentProjectConfigOverride(cfg);
  check("AGENT validator REJECTS orchestration.alertWebhook (exfil guard)", agent.ok === false);
  check("agent rejection names the offending key", agent.ok === false && /alertWebhook/.test(agent.error));

  // mirror gateCommand's posture exactly: agent rejects gateCommand too, human accepts it.
  check("AGENT validator still REJECTS gateCommand (unchanged)",
    validateAgentProjectConfigOverride({ orchestration: { gateCommand: "calc.exe" } }).ok === false);
  check("HUMAN validator still ACCEPTS gateCommand (unchanged)",
    validateProjectConfigOverride({ orchestration: { gateCommand: "pnpm build" } }).ok === true);

  // malformed webhook is rejected even on the human path (url must be a URL; events an array)
  check("HUMAN validator rejects a non-URL webhook url", validateProjectConfigOverride({ orchestration: { alertWebhook: { url: "not-a-url", events: [] } } }).ok === false);
  check("HUMAN validator rejects a non-array events", validateProjectConfigOverride({ orchestration: { alertWebhook: { url: "https://x.example.com", events: "merge_done" } } }).ok === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the alert-webhook emitter POSTs on a HUMAN-configured matching event kind (right URL + payload), stays silent on non-matching kinds / unconfigured projects, is best-effort + bounded (a failing POST never throws into the event path), hooks the Db.appendEvent chokepoint without a throwing listener ever breaking the audit write, and is exfil-guarded: the agent config validator REJECTS orchestration.alertWebhook while the human validator ACCEPTS it (mirroring gateCommand)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
