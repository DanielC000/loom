import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 670b2081 — orchestration events pushed over /ws/fleet (Db.eventObserver → FleetHub.broadcast).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-fleet-session-feed.mjs). No fixed waits: every "did NOT arrive" claim is proven by ORDERING — a
// committed sentinel event is appended after the thing that must not arrive, and the next frame off the
// socket must be that sentinel (frames are FIFO on one socket, so a leaked frame would sit in front of it).
//
// Proves:
//   1. A committed appendEvent pushes exactly one `event` frame whose `event` is DEEP-EQUAL to the row
//      GET /api/orchestration/events returns for it (db.listEvents) — same projection, no `seq`, nothing added.
//   2. A rolled-back runInTransaction pushes NOTHING (sentinel is the next frame).
//   3. A committed runInTransaction pushes each event exactly once, in order, only after commit.
//   4. The alert-webhook slot (setEventListener) is undisturbed: it still fires per committed event, and a
//      throwing observer / throwing listener starves neither the other sink nor the audit write.
//   5. With no fleet socket attached the observer is never asked to project (active() false, notify uncalled).
import path from "node:path";
import fs from "node:fs";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-ev-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45371"; // distinct from the sibling ws-fleet*.mjs ports
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
const fleetHub = new FleetHub();
const app = await buildServer({
  db, pty: {}, sessions: { peekPendingMerge: () => undefined, gatePhaseForOpId: () => null }, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

let n = 0;
const ev = (kind, extra = {}) => ({ id: `ev-${++n}`, ts: new Date(Date.UTC(2026, 10, 5, 12, 0, n)).toISOString(), managerSessionId: "mgr-1", kind, ...extra });

try {
  await app.ready();
  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit });
  const hello = await inbox.next();
  check("hello arrives first", hello?.t === "hello");

  // --- (1) committed append → one frame, deep-equal to the REST projection ---------------------------
  const first = ev("merge_request", { workerSessionId: "w-1", taskId: "t-1", detail: { branch: "loom/x", nested: { a: [1, 2] } } });
  db.appendEvent(first);
  const f1 = await inbox.next();
  const restRow = db.listEvents("mgr-1").find((e) => e.id === first.id);
  check("(1) frame is t:event", f1?.t === "event");
  check("(1) frame.event is deep-equal to the row GET /api/orchestration/events returns", JSON.stringify(f1?.event) === JSON.stringify(restRow));
  check("(1) no `seq` (nothing the REST row lacks)", f1?.event && !("seq" in f1.event));
  check("(1) managerId repeats event.managerSessionId", f1?.managerId === "mgr-1");
  const bare = ev("idle_report");
  db.appendEvent(bare);
  const f1b = await inbox.next();
  check("(1) optional fields normalise exactly as REST does (workerSessionId/taskId null, detail absent)", JSON.stringify(f1b?.event) === JSON.stringify(db.listEvents("mgr-1").find((e) => e.id === bare.id)));

  // --- (2) rollback pushes nothing --------------------------------------------------------------------
  const rolled = ev("merge_request");
  let threw = false;
  try { db.runInTransaction(() => { db.appendEvent(rolled); throw new Error("boom"); }); } catch { threw = true; }
  const sentinel2 = ev("idle_report");
  db.appendEvent(sentinel2);
  const f2 = await inbox.next();
  check("(2) the rolled-back transaction threw", threw);
  check("(2) rolled-back event was never pushed (the next frame is the later sentinel)", f2?.event?.id === sentinel2.id);
  check("(2) rolled-back event is not in the table either (control: the rollback was real)", !db.listEvents("mgr-1").some((e) => e.id === rolled.id));

  // --- (3) committed transaction: each event once, in order, after commit ------------------------------
  const a = ev("merge_request"), b = ev("idle_report");
  let framesBeforeCommit = 0;
  db.runInTransaction(() => {
    db.appendEvent(a);
    db.appendEvent(b);
    framesBeforeCommit = fleetHub.size; // nothing observable yet: notify is only reachable after commit
  });
  const sentinel3 = ev("idle_report");
  db.appendEvent(sentinel3);
  const ids3 = [(await inbox.next())?.event?.id, (await inbox.next())?.event?.id, (await inbox.next())?.event?.id];
  check("(3) transaction events pushed once each, in order, followed directly by the sentinel (no duplicates)", JSON.stringify(ids3) === JSON.stringify([a.id, b.id, sentinel3.id]));
  check("(3) control: a socket was attached while the transaction ran", framesBeforeCommit === 1);

  // --- (4) the alert-webhook slot is undisturbed; sinks are fault-isolated -----------------------------
  const listenerSeen = [];
  db.setEventListener((e) => { listenerSeen.push(e.id); });
  const c = ev("merge_request");
  db.appendEvent(c);
  const f4 = await inbox.next();
  check("(4) webhook listener still fires for a committed event", listenerSeen.join() === c.id);
  check("(4) observer fires too", f4?.event?.id === c.id);

  const realNotify = db.eventObserver.notify;
  db.eventObserver.notify = () => { throw new Error("observer fault"); };
  const d = ev("merge_request");
  let seqD;
  try { seqD = db.appendEvent(d); } catch { seqD = undefined; }
  db.eventObserver.notify = realNotify;
  check("(4) a throwing observer neither breaks the audit write nor starves the webhook listener", typeof seqD === "number" && listenerSeen.includes(d.id));

  db.setEventListener(() => { throw new Error("listener fault"); });
  const e5 = ev("merge_request");
  let seqE;
  try { seqE = db.appendEvent(e5); } catch { seqE = undefined; }
  const f4e = await inbox.next();
  check("(4) a throwing webhook listener neither breaks the audit write nor starves the observer", typeof seqE === "number" && f4e?.event?.id === e5.id);
  db.setEventListener(() => {});

  // --- (5) no socket attached → observer never asked to project ----------------------------------------
  ws.terminate();
  const deadline = Date.now() + 5000;
  while (fleetHub.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20)); // polls an observable (hub size), not a fixed wait
  check("(5) control: the hub has dropped the closed socket", fleetHub.size === 0);
  let notifyCalls = 0;
  const wrapped = db.eventObserver.notify;
  db.eventObserver.notify = (x) => { notifyCalls++; wrapped(x); };
  db.appendEvent(ev("merge_request"));
  check("(5) with no fleet socket attached, notify is never called", notifyCalls === 0);
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — orchestration events push over /ws/fleet as the exact REST row, only on commit, exactly once, without disturbing the alert-webhook slot."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
