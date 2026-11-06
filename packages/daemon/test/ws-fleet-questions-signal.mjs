import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 55de3b68 — the Request-inbox change signal pushed over /ws/fleet (Db.questionsChangeListener →
// FleetHub.broadcast). HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's
// injectWS, like ws-fleet-event-push.mjs). Every "did NOT arrive" claim is proven by ORDERING, not a wait: a
// committed sentinel orchestration event is appended after the thing that must not signal, and the next
// frame off the socket must be that sentinel (frames are FIFO on one socket).
//
// Proves:
//   1. The frame is CONTENTLESS: exactly {t:"questions"} — no id/title/count/state.
//   2. Every questions mutator signals (insert, answer, credential answer, amend, cancel, escalate,
//      acknowledge, mark-read, dismiss-notices, consume x4, claim, clear-ssh, reparent, binding-applied,
//      attachment-opened, session-delete cascade) — and a no-op call (0 rows changed) signals nothing.
//   3. A rolled-back runInTransaction signals nothing; a committed one signals exactly once (coalesced).
//   4. A burst of N mutations in one tick is ONE frame.
//   7. The JOINED fields (task lane/title, asking-session liveness, project/agent name) signal on a real
//      change only, only when a question shows them, and never on a busy flip.
//   5. With no fleet socket attached the hub is never asked to broadcast; a throwing listener never breaks
//      the write.
//   6. Trust tier: GET /api/questions and GET /ws/fleet are both Tier 1, and a gateway token has no scope
//      column, so any credential that can open the socket can already read the inbox.
import path from "node:path";
import fs from "node:fs";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-q-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45372"; // distinct from the sibling ws-fleet*.mjs ports
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const flush = () => new Promise((r) => setImmediate(r)); // lets the Db's coalescing microtask run (observable, not a timed wait)

function makeInbox() {
  const queue = [];
  let waiter = null;
  const onInit = (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiter) { const resolve = waiter; waiter = null; resolve(msg); } else queue.push(msg);
    });
  };
  const next = (ms = 2000) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiter = null; resolve(null); }, ms);
      waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    });
  };
  return { onInit, next };
}

const db = new Db(path.join(TMP, "loom.db"));
const seedNow = new Date().toISOString();
db.insertProject({ id: "p1", name: "Proj", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: seedNow, archivedAt: null, reserved: false });
db.insertAgent({ id: "a1", projectId: "p1", name: "Agent", startupPrompt: "x", position: 0, profileId: null });
const mkSession = (id) => db.insertSession({
  id, projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
  processState: "live", resumability: "unknown", busy: false, createdAt: seedNow, lastActivity: seedNow,
  lastError: null, role: "worker", parentSessionId: null,
});
mkSession("mgr-1");
mkSession("mgr-2");

const fleetHub = new FleetHub();
const app = await buildServer({
  db, pty: {}, sessions: { peekPendingMerge: () => undefined, gatePhaseForOpId: () => null }, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

let n = 0;
const q = (over = {}) => ({
  id: `q-${++n}`, sessionId: "mgr-1", projectId: "p1", type: "decision", title: `Q${n}`, body: "b", options: ["a", "b"],
  recommendation: null, taskId: null, permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
  credentialEnvVar: null, provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
  state: "pending", chosenOption: null, note: null, createdAt: new Date(Date.UTC(2026, 10, 5, 12, 0, n)).toISOString(),
  answeredAt: null, consumedAt: null, ...over,
});
let en = 0;
const sentinelEvent = () => ({ id: `ev-${++en}`, ts: new Date(Date.UTC(2026, 10, 5, 13, 0, en)).toISOString(), managerSessionId: "mgr-1", kind: "idle_report" });

try {
  await app.ready();
  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit });
  check("hello arrives first", (await inbox.next())?.t === "hello");

  // Expects exactly ONE questions frame for `fn`, then proves nothing else followed it (sentinel is next).
  const expectSignal = async (label, fn) => {
    fn();
    await flush();
    const sentinel = sentinelEvent();
    db.appendEvent(sentinel);
    const f = await inbox.next();
    const after = await inbox.next();
    check(`(2) ${label} → one {t:"questions"} frame`, f?.t === "questions");
    check(`(2) ${label} → nothing but the sentinel follows (no duplicate)`, after?.t === "event" && after.event?.id === sentinel.id);
    return f;
  };
  // Expects NO questions frame for `fn` (the sentinel is the very next frame).
  const expectSilent = async (label, fn) => {
    fn();
    await flush();
    const sentinel = sentinelEvent();
    db.appendEvent(sentinel);
    const f = await inbox.next();
    check(`${label} → no questions frame (the sentinel is the next frame)`, f?.t === "event" && f.event?.id === sentinel.id);
  };

  // --- (1) contentless ----------------------------------------------------------------------------------
  const first = q({ title: "SECRET-TITLE-DO-NOT-LEAK" });
  const f1 = await expectSignal("insertQuestion", () => db.insertQuestion(first));
  check("(1) the frame is EXACTLY {t:\"questions\"} (no id, title, count, state, or any other key)", JSON.stringify(f1) === '{"t":"questions"}');
  check("(1) the frame text carries nothing of the row", !JSON.stringify(f1).includes(first.id) && !JSON.stringify(f1).includes("SECRET"));

  // --- (2) every mutator signals ------------------------------------------------------------------------
  const a = q(); db.insertQuestion(a); await flush(); await inbox.next(); // drain the insert's frame
  await expectSignal("answerQuestion", () => db.answerQuestion(a.id, { chosenOption: "a", note: null, answeredAt: seedNow }));
  const b = q(); db.insertQuestion(b); await flush(); await inbox.next();
  await expectSignal("amendQuestion", () => db.amendQuestion(b.id, { title: "T2" }));
  await expectSignal("markQuestionEscalated", () => db.markQuestionEscalated(b.id, seedNow));
  await expectSignal("acknowledgeQuestion", () => db.acknowledgeQuestion(b.id, new Date(Date.now() + 3600_000).toISOString()));
  await expectSignal("markQuestionsRead", () => db.markQuestionsRead([b.id], seedNow));
  await expectSignal("cancelQuestion", () => db.cancelQuestion(b.id, { reason: "r", cancelledBy: "human" }));
  const nt = q({ type: "notice", state: "notice" }); db.insertQuestion(nt); await flush(); await inbox.next();
  await expectSignal("dismissNotices", () => db.dismissNotices([nt.id], seedNow));
  const c = q(); db.insertQuestion(c); await flush(); await inbox.next();
  db.answerQuestion(c.id, { chosenOption: "a", note: null, answeredAt: seedNow }); await flush(); await inbox.next();
  await expectSignal("acknowledgeAnsweredQuestion (answered→consumed)", () => db.acknowledgeAnsweredQuestion(c.id, seedNow));
  const d = q(); db.insertQuestion(d); await flush(); await inbox.next();
  db.answerQuestion(d.id, { chosenOption: "a", note: null, answeredAt: seedNow }); await flush(); await inbox.next();
  await expectSignal("pullAnsweredQuestions (consume)", () => db.pullAnsweredQuestions("mgr-1", seedNow));
  const e = q(); db.insertQuestion(e); await flush(); await inbox.next();
  await expectSignal("reparentQuestions", () => db.reparentQuestions("mgr-1", "mgr-2"));
  await expectSignal("deleting a session cascades its questions away", () => db.deleteSession("mgr-2"));
  const lone = q({ sessionId: "mgr-1" }); db.insertQuestion(lone); await flush(); await inbox.next();

  // a no-op write signals nothing: mark-read of an id that is already read, dismiss of an unknown id, reparent of nobody
  db.markQuestionsRead([lone.id], seedNow); await flush(); await inbox.next(); // first time → signals; drain
  await expectSilent("markQuestionsRead of an already-read row", () => db.markQuestionsRead([lone.id], seedNow));
  await expectSilent("dismissNotices of an unknown id", () => db.dismissNotices(["nope"], seedNow));
  await expectSilent("reparentQuestions with no matching rows", () => db.reparentQuestions("ghost", "mgr-1"));
  await expectSilent("last_surfaced_* bookkeeping write (not inbox-visible)", () => db.markQuestionSurfaced(lone.id, "s", seedNow));

  // --- (3) transactions ---------------------------------------------------------------------------------
  const rolled = q();
  let threw = false;
  try { db.runInTransaction(() => { db.insertQuestion(rolled); throw new Error("boom"); }); } catch { threw = true; }
  check("(3) the rolled-back transaction threw", threw);
  check("(3) control: the rollback was real (row absent)", db.getQuestion(rolled.id) === undefined);
  await expectSilent("(3) a ROLLED-BACK transaction", () => {});

  const t1 = q(), t2 = q();
  db.runInTransaction(() => { db.insertQuestion(t1); db.insertQuestion(t2); });
  await flush();
  const sTx = sentinelEvent(); db.appendEvent(sTx);
  const fTx = await inbox.next(), afterTx = await inbox.next();
  check("(3) a COMMITTED two-insert transaction signals once", fTx?.t === "questions" && afterTx?.event?.id === sTx.id);

  // a nested throw caught by the outer transaction must not leak the nested signal while the outer one commits nothing
  let nestedCaught = false;
  try {
    db.runInTransaction(() => {
      try { db.runInTransaction(() => { db.insertQuestion(q()); throw new Error("nested"); }); } catch { nestedCaught = true; }
      throw new Error("outer");
    });
  } catch { /* expected */ }
  check("(3) precondition: the nested throw was caught", nestedCaught);
  await expectSilent("(3) a rolled-back nested+outer transaction", () => {});

  // --- (4) a burst coalesces ----------------------------------------------------------------------------
  for (let i = 0; i < 25; i++) db.insertQuestion(q());
  await flush();
  const sBurst = sentinelEvent(); db.appendEvent(sBurst);
  const fBurst = await inbox.next(), afterBurst = await inbox.next();
  check("(4) 25 inserts in one tick → ONE frame", fBurst?.t === "questions" && afterBurst?.event?.id === sBurst.id);

  // --- (5) fault isolation + inert without a socket ----------------------------------------------------
  const realListener = db.questionsChangeListener;
  db.questionsChangeListener = () => { throw new Error("listener fault"); };
  let wrote = false;
  try { db.insertQuestion(q()); wrote = true; await flush(); } catch { wrote = false; }
  db.questionsChangeListener = realListener;
  check("(5) a throwing listener neither breaks the write nor escapes", wrote);
  await expectSilent("(5) (control) the throwing-listener write left no stray frame", () => {});

  // --- (7) JOINED fields: the inbox row JOINs task lane/title, session liveness, project + agent names -----
  // None of these writes touches the questions table, so only the explicit notifier calls make them signal.
  const jp = "pj", ja = "aj";
  db.insertProject({ id: jp, name: "JoinProj", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: seedNow, archivedAt: null, reserved: false });
  db.insertAgent({ id: ja, projectId: jp, name: "JoinAgent", startupPrompt: "x", position: 0, profileId: null });
  db.insertSession({ id: "js-1", projectId: jp, agentId: ja, engineSessionId: null, title: null, cwd: TMP, processState: "live", resumability: "unknown", busy: false, createdAt: seedNow, lastActivity: seedNow, lastError: null, role: "worker", parentSessionId: null });
  db.insertSession({ id: "js-quiet", projectId: jp, agentId: ja, engineSessionId: null, title: null, cwd: TMP, processState: "live", resumability: "unknown", busy: false, createdAt: seedNow, lastActivity: seedNow, lastError: null, role: "worker", parentSessionId: null });
  const mkTask = (id, title) => db.insertTask({ id, projectId: jp, title, body: "", columnKey: "in_progress", position: 1, createdAt: seedNow, updatedAt: seedNow });
  mkTask("jt-ref", "referenced card");
  mkTask("jt-free", "card nobody asked about");
  const jq = q({ sessionId: "js-1", projectId: jp, taskId: "jt-ref" });
  db.insertQuestion(jq); await flush(); await inbox.next();

  await expectSignal("a referenced card changing LANE", () => db.updateTask("jt-ref", { columnKey: "done" }));
  await expectSignal("a referenced card changing TITLE", () => db.updateTask("jt-ref", { title: "renamed card" }));
  await expectSilent("a referenced card changing only PRIORITY (not a displayed field)", () => db.updateTask("jt-ref", { priority: "p1" }));
  await expectSilent("an UNREFERENCED card changing lane (EXISTS gate)", () => db.updateTask("jt-free", { columnKey: "done" }));
  // Setup in its OWN tick (insertQuestion signals too, and would mask the call under test if coalesced with it).
  mkTask("jt-del", "to delete"); db.insertQuestion(q({ sessionId: "js-1", projectId: jp, taskId: "jt-del" })); await flush(); await inbox.next();
  await expectSignal("a referenced card being DELETED (joined lane/title go null)", () => db.deleteTask("jt-del"));

  await expectSignal("the asking session's process_state live -> exited (it has an open question)", () => db.setProcessState("js-1", "exited"));
  await expectSilent("the same process_state written again (no transition)", () => db.setProcessState("js-1", "exited"));
  await expectSignal("the asking session's resumability changing", () => db.setResumability("js-1", "resumable"));
  await expectSilent("the same resumability written again", () => db.setResumability("js-1", "resumable"));
  await expectSilent("a BUSY flip on the asking session (would turn the signal back into a poll)", () => { db.setBusy("js-1", true); db.setBusy("js-1", false); });
  await expectSilent("a process_state transition on a session with NO open question", () => db.setProcessState("js-quiet", "exited"));
  await expectSilent("a resumability transition on a session with NO open question", () => db.setResumability("js-quiet", "resumable"));
  await expectSignal("resumability moving to dead (setup for the next case)", () => db.setResumability("js-1", "dead"));
  await expectSignal("setEngineSessionId flipping resumability dead -> resumable", () => db.setEngineSessionId("js-1", "eng-1"));

  await expectSignal("a PROJECT rename", () => db.updateProject(jp, { name: "JoinProj2" }));
  await expectSilent("a project update that does not touch the name", () => db.updateProject(jp, { noGateByDesign: true }));
  await expectSignal("an AGENT rename", () => db.updateAgent(ja, { name: "JoinAgent2" }));
  await expectSilent("an agent update that does not touch the name", () => db.updateAgent(ja, { startupPrompt: "y" }));

  // --- (8) bulk/cross-entity writers: behavioural proof the call FIRES (the guard text only proves it is present)
  const layout = [{ key: "in_progress", label: "In progress" }, { key: "done", label: "Done" }];
  db.insertProject({ id: "pq", name: "NoQuestions", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: seedNow, archivedAt: null, reserved: false });
  await expectSilent("applyBoardColumnLayout on a project with NO questions", () => db.applyBoardColumnLayout("pq", layout, [], "done"));
  await expectSignal("applyBoardColumnLayout on a project whose question references a card", () => db.applyBoardColumnLayout(jp, layout, [], "done"));

  await expectSignal("recoverStaleSessions flipping a live asker (mgr-1 has open questions) to exited", () => { db.recoverStaleSessions(); });
  await expectSilent("recoverStaleSessions again (nothing live left to flip)", () => { db.recoverStaleSessions(); });

  await expectSilent("a cross-project relocateTask of a card NO question references", () => db.relocateTask("jt-free", { projectId: "p1", columnKey: "in_progress", position: 1 }));
  await expectSignal("a cross-project relocateTask of a card a question references (the question's project_id follows)", () => db.relocateTask("jt-ref", { projectId: "p1", columnKey: "in_progress", position: 2 }));

  ws.terminate();
  const deadline = Date.now() + 5000;
  while (fleetHub.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20)); // polls an observable (hub size)
  check("(5) control: the hub has dropped the closed socket", fleetHub.size === 0);
  let broadcasts = 0;
  const realBroadcast = fleetHub.broadcast.bind(fleetHub);
  fleetHub.broadcast = (m) => { broadcasts++; realBroadcast(m); };
  db.insertQuestion(q());
  await flush();
  check("(5) with no fleet socket attached the hub is never asked to broadcast", broadcasts === 0);

  // --- (6) trust tier -----------------------------------------------------------------------------------
  const tier = fs.readFileSync(new URL("../src/gateway/trust-tier.ts", import.meta.url), "utf8");
  check("(6) GET /api/questions is Tier 1", /method: "GET", pattern: "\/api\/questions"/.test(tier));
  check("(6) GET /ws/fleet is Tier 1", /method: "GET", pattern: "\/ws\/fleet"/.test(tier));
  const cols = db.db.prepare("PRAGMA table_info(gateway_tokens)").all().map((r) => r.name);
  check("(6) gateway tokens carry no scope/route/permission column (one tier: whatever opens the socket reads the inbox)", !cols.some((c) => /scope|route|perm|role|allow/i.test(c)));
  check("(6) control: the column probe saw the real table", cols.includes("hash") && cols.includes("status"));
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the inbox change signal is contentless, post-commit, coalesced, mutator-complete and inert without a socket."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
