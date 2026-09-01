// Regression guard for card e01687ea DoD-2 — proves `senderId` actually reaches `enqueueStdin` through the
// REAL production funnel (SessionService.messageWorker → enqueueDurableMessage), not just the primitive.
//
// pty-agent-sender-coalesce.mjs (card eac3464d) already proves same-sender coalescing works when a test
// calls `host.enqueueStdin(...)` DIRECTLY with an explicit `senderId` — it exercises drainPending's/
// enqueueStdin's own logic in isolation and is structurally BLIND to card e01687ea's actual defect: at
// `SessionService.enqueueDurableMessage` (sessions/service.ts), the `senderId` positional argument to
// `this.pty.enqueueStdin(...)` was hardcoded `undefined` instead of `ctx.sender` — so EVERY production
// caller of that method (messageWorker, worker_redirect, worker_report→manager, session_message, peer
// letters, settle nudges, cross-remints) fed drainPending's coalescing gate (`senderKey !== null`) a
// permanently-null key, making same-sender coalescing structurally unreachable no matter how correct the
// primitive-level logic was. A test that passes `senderId` by hand (as the eac3464d suite does) can never
// catch that: it never exercises the funnel this defect actually lives in.
//
// This suite drives the REAL `SessionService.messageWorker` against a REAL `PtyHost` (the same createPty
// fake-write seam pty-agent-sender-coalesce.mjs uses) — NO real claude, no live daemon:
//   (A) two `messageWorker` calls from the SAME manager, while the worker is busy, COALESCE into ONE turn
//       — this can only pass if `senderId` genuinely threads from `ctx.sender` (the manager's session id)
//       through `enqueueDurableMessage` to `enqueueStdin`'s drain-time coalescing gate.
//   (B) both queued messages' bodies land in that one turn, joined by the visible DRAIN_SEPARATOR, in
//       send order — proving this is a genuine coalesce, not an accidental pass-through.
//
// PROVEN TO CATCH THE DEFECT: reverting ONLY the `service.ts` fix (restoring the hardcoded `undefined` at
// `enqueueDurableMessage`'s `this.pty.enqueueStdin(...)` call) turns check (A) RED — two separate turns
// (one per message) instead of one coalesced turn — while pty-agent-sender-coalesce.mjs stays entirely
// GREEN throughout, confirming that suite alone could never have caught this.
//
// RUN (no daemon needed): node test/worker-message-sender-wiring.mjs
//   Requires the daemon built first (reads ../dist/{db,pty/host,sessions/service,orchestration/control}.js):
//   from packages/daemon run `pnpm build`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-wmsw-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => { writes.push(d); }, writes };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const SEP = "────────"; // the visible coalesce separator (host.ts DRAIN_SEPARATOR)
const PASTE_START = "\x1b[200~";

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `wmsw-proj-${sfx}`, agent = `wmsw-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
  worktreePath: null, branch: null,
});

const sessions = new SessionService(db, host, new OrchestrationControl());

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { written: () => fake.writes.join(""), countOf: (m) => fake.writes.join("").split(m).length - 1 };
}

/** Mirrors pty-agent-sender-coalesce.mjs's primeBusy: put the worker mid-turn so the messageWorker calls
 *  below are HELD/queued (not delivered immediately), the only shape that exercises drainPending's
 *  coalescing gate at all. */
function primeBusy(sessionId) {
  const r = host.enqueueStdin(sessionId, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`primeBusy(${sessionId}): PRIMER was not delivered immediately`);
}

try {
  const mgr = `wmsw-mgr-${sfx}`, wkr = `wmsw-wkr-${sfx}`;
  mkSession({ id: mgr, role: "manager" });
  mkSession({ id: wkr, role: "worker", parentSessionId: mgr });

  const { written, countOf } = spawnReady(wkr);
  // The manager session need not itself be spawned on the pty host — messageWorker only needs it to exist
  // in the DB (the parent-scope check) and to be the `ctx.sender` threaded into enqueueDurableMessage.
  primeBusy(wkr);
  await sleep(250); // let PRIMER's async paste-end + Enter flush before enqueuing more (mirrors eac3464d suite)

  const r1 = sessions.messageWorker(mgr, wkr, "please double-check the schema");
  const r2 = sessions.messageWorker(mgr, wkr, "and run the migration once that's done");
  check("(A) setup: both messages HELD (worker busy)", r1.delivered === false && r2.delivered === false);
  check("(A) setup: FIFO order is [msg1, msg2] (no reorder needed — already adjacent, same sender)",
    JSON.stringify(host.getPending(wkr)).includes("please double-check the schema") &&
    host.getPending(wkr).length === 2);

  const pasteBefore = countOf(PASTE_START);
  host.deliverHook(wkr, { hook_event_name: "Stop" });

  // THE WIRING PROOF: this can only be ONE submit if `ctx.sender` (the manager's session id) actually
  // reached `enqueueStdin`'s `senderId` param through `enqueueDurableMessage` — with `senderId` hardcoded
  // `undefined` (the pre-fix defect), drainPending's `senderKey !== null` gate never engages and these two
  // messages drain as TWO separate turns instead.
  check("(A) WIRING: exactly ONE submit for both same-manager messageWorker calls (real coalescing fired)",
    countOf(PASTE_START) - pasteBefore === 1);
  check("(A) WIRING: queue fully drained — both messages left in ONE turn, none stranded for a second turn",
    host.getPending(wkr).length === 0);

  const turn = written();
  const i1 = turn.indexOf("please double-check the schema");
  const i2 = turn.indexOf("and run the migration once that's done");
  check("(B) both message bodies present, FIFO order, joined by the visible coalesce separator",
    i1 >= 0 && i2 >= 0 && i1 < i2 && turn.includes(SEP));

  db.close();
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — senderId genuinely threads from SessionService.messageWorker's ctx.sender through enqueueDurableMessage into enqueueStdin, so same-sender coalescing fires through the REAL production funnel, not just the primitive."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
