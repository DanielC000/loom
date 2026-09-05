// Regression guard for card 4458dd9e — proves the web UI's human composer route
// (`POST /api/sessions/:id/input`, gateway/server.ts) actually threads a real, non-null `senderId`
// (the fixed `HUMAN_COMPOSER_SENDER_ID` sentinel, pty/host.ts) into `enqueueStdin`, so consecutive
// composer entries queued while the recipient is busy coalesce into ONE turn — the same "same-sender
// bursts now coalesce" guarantee `worker-message-sender-wiring.mjs` proves for `messageWorker`, but
// through the REAL HTTP route this time, not a direct SessionService call. Before card 4458dd9e this
// route passed NO `senderId` at all (positional arg 10 omitted), so `drainPending`'s `senderKey !== null`
// gate never engaged and two composer messages queued back-to-back drained as TWO separate turns instead
// of one — exactly the gap `CLAUDE.md`'s "Message drain is kind-classified" paragraph had (incorrectly)
// already claimed was closed for "a human composer turn".
//
// This suite builds the REAL Fastify gateway in-process (buildServer) against a temp Db + the REAL
// PtyHost driving a FAKE pty (createPty seam, write-capturing like worker-message-sender-wiring.mjs) —
// FULLY HERMETIC, no live daemon, no real claude, no bound port — and drives the composer route via
// app.inject():
//   (A) two POST /api/sessions/:id/input calls to the SAME busy recipient COALESCE into ONE turn.
//   (B) both message bodies land in that one turn, joined by the visible DRAIN_SEPARATOR, in send order.
//   (C) sanity: a DIFFERENT kind of agent-authored entry (e.g. a worker report, senderless `"system"`)
//       queued between two composer entries does NOT get folded into the composer's own coalescing run —
//       same-sender coalescing must stay scoped to the actual sender, never widen to "any agent-kind".
//
// PROVEN TO CATCH THE DEFECT: dropping the trailing `HUMAN_COMPOSER_SENDER_ID` arg from the route's
// `enqueueStdin(...)` call (gateway/server.ts) turns check (A) RED — two separate turns instead of one —
// while pty-queue-rest.mjs (which never drains the queue) stays entirely GREEN throughout, confirming
// that suite alone could never have caught this.
//
// RUN (self-isolating; sets its OWN temp LOOM_HOME before importing dist):
//   1) build the daemon, 2) node test/composer-input-sender-coalesce.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cisc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(process.env.LOOM_HOME, "logs"), { recursive: true });
requireHermeticEnv(); // confirm LOOM_HOME is the throwaway temp dir, never the real ~/.loom

const LOOM = process.env.LOOM_HOME;

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEP = "────────"; // the visible coalesce separator (host.ts DRAIN_SEPARATOR)
const PASTE_START = "\x1b[200~";

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

const db = new Db(path.join(LOOM, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "t", projectId: "p", name: "t", startupPrompt: "x", position: 0 });
const SID = "s";
db.insertSession({ id: SID, projectId: "p", agentId: "t", engineSessionId: null, title: null, cwd: LOOM,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });

const host = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
host.spawn({ sessionId: SID, cwd: LOOM, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
host.deliverHook(SID, { hook_event_name: "SessionStart" });

const stub = {};
const app = await buildServer({ db, pty: host, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, control: stub, usageStatus: stub });

function fakeFor(sessionId) {
  // The single fake created by host.spawn() above (createPty is called once per spawn in this suite).
  return fakes[fakes.length - 1];
}

try {
  const { writes } = fakeFor(SID);
  const written = () => writes.join("");
  const countOf = (m) => writes.join("").split(m).length - 1;

  host.enqueueStdin(SID, "PRIMER_TURN"); // idle → delivers now + arms busy, so everything after this QUEUES
  await sleep(250); // let PRIMER's async paste-end + Enter flush before enqueuing more

  // ===================== (A)+(B): two composer inputs to the same busy recipient coalesce =====================
  const p1 = await app.inject({ method: "POST", url: `/api/sessions/${SID}/input`, payload: { text: "please double-check the schema" } });
  const p2 = await app.inject({ method: "POST", url: `/api/sessions/${SID}/input`, payload: { text: "and run the migration once that's done" } });
  check("(A) setup: both composer posts 200, queued (recipient busy)",
    p1.statusCode === 200 && p1.json().delivered === false && p2.statusCode === 200 && p2.json().delivered === false);
  check("(A) setup: FIFO order is [msg1, msg2] (no reorder needed — already adjacent, same sender)",
    host.getPending(SID).length === 2);

  const pasteBefore = countOf(PASTE_START);
  host.deliverHook(SID, { hook_event_name: "Stop" });

  // THE WIRING PROOF: this can only be ONE submit if the composer route genuinely threads a real, stable
  // senderId into enqueueStdin's drain-time coalescing gate — with senderId omitted (the pre-4458dd9e
  // shape), drainPending's `senderKey !== null` gate never engages and these two composer entries drain
  // as TWO separate turns instead.
  check("(A) WIRING: exactly ONE submit for both same-recipient composer posts (real coalescing fired)",
    countOf(PASTE_START) - pasteBefore === 1);
  check("(A) WIRING: queue fully drained — both composer entries left in ONE turn, none stranded for a second turn",
    host.getPending(SID).length === 0);

  const turn1 = written();
  const i1 = turn1.indexOf("please double-check the schema");
  const i2 = turn1.indexOf("and run the migration once that's done");
  check("(B) both message bodies present, FIFO order, joined by the visible coalesce separator",
    i1 >= 0 && i2 >= 0 && i1 < i2 && turn1.includes(SEP));

  await sleep(250);

  // ===================== (C) an interleaved, DIFFERENT (senderless) agent-kind entry is not folded in =====================
  const p3 = await app.inject({ method: "POST", url: `/api/sessions/${SID}/input`, payload: { text: "COMPOSER_THREE" } });
  check("(C) setup: composer post 3 queued", p3.statusCode === 200 && p3.json().delivered === false);
  // A senderless agent-kind entry (e.g. a worker report) queued right after it — same route, same kind,
  // but no senderId at all, so it must NOT join the composer's own same-sender run.
  host.enqueueStdin(SID, "WORKER_REPORT_FOUR", "system", undefined, undefined, "agent");
  check("(C) setup: both entries queued", host.getPending(SID).length === 2);

  const pasteBefore2 = countOf(PASTE_START);
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("(C) turn: exactly ONE submit, for COMPOSER_THREE alone — the senderless entry did not coalesce in",
    countOf(PASTE_START) - pasteBefore2 === 1);
  const turn3 = written();
  check("(C) COMPOSER_THREE delivered, WORKER_REPORT_FOUR still queued behind it (different/no sender breaks the run)",
    turn3.includes("COMPOSER_THREE") && !turn3.includes("WORKER_REPORT_FOUR") &&
    JSON.stringify(host.getPending(SID)) === JSON.stringify(["WORKER_REPORT_FOUR"]));

  db.close();
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  try { await app.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(LOOM);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the composer's POST /api/sessions/:id/input route genuinely threads HUMAN_COMPOSER_SENDER_ID into enqueueStdin, so same-sender coalescing fires through the REAL HTTP route for consecutive composer entries, without widening to fold in an unrelated senderless agent-kind entry."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
