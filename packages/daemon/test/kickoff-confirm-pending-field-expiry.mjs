import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Code Review f3fa9002 (card 8882e2ca) Major 2: worker_list/worker_status's `kickoffConfirmPending`
// field (and worker_stop's own advisory warning, covered separately in
// worker-stop-kickoff-confirm-pending-warning.mjs) used to never EXPIRE — once a worker's composerDirtyLen
// read large, the field stayed non-null FOREVER, regardless of how much elapsed time had passed or
// whether the worker had since confirmed and completed its turn. This drives the REAL `worker_status`
// MCP tool (not a re-implemented approximation) against a real Db + a configurable PtyStub proving the
// field now EXPIRES on both axes, via the shared `withinKickoffConfirmWindow` predicate:
//   (A) POSITIVE: turnSeq:0, large composerDirtyLen, RECENT liveStartedAt (well inside the window) ->
//       the field is present, naming the size + window.
//   (B) EXPIRY BY ELAPSED TIME: the IDENTICAL worker, but liveStartedAt far enough in the past that the
//       size-aware window has genuinely elapsed -> the field is null. RED against the pre-fix
//       implementation (size+turnSeq only, no elapsed-time check at all) — that version would have kept
//       reporting this worker as pending forever.
//   (C) EXPIRY BY COMPLETED TURN, DESPITE A LAGGING composerDirtyLen: turnSeq already > 0 (the kickoff
//       confirmed and the worker completed a real turn) but composerDirtyLen STILL reads the large
//       pre-confirm value (card c148f118's own documented staleness — composerDirtyLen has no automatic
//       clear path on every generation) -> the field is null regardless, because turnSeq is checked
//       FIRST, before any composerDirtyLen/liveStartedAt read at all.
//   (D) CONTROL: an ordinary-sized kickoff (never earns an extended window) stays null throughout —
//       unaffected by either expiry axis.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/kickoff-confirm-pending-field-expiry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const dbFile = path.join(os.tmpdir(), `loom-kcpfe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "proj-kcpfe";
const agentId = "agent-kcpfe";
db.insertProject({ id: projId, name: "KCPFE", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });

const mkWorker = (id) => {
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: true, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgr", taskId: `task-${id}` });
};

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

/** Configurable PtyStub — the two reads `withinKickoffConfirmWindow` needs, PLUS every other
 *  `pty?.getXxx` getter worker_status/worker_list unconditionally call (null-returning no-ops) — unlike
 *  worker-status-projection-guard.mjs's own stub-less call (no 4th ctor arg at all, so every `pty?.`
 *  read there short-circuits on `pty` itself being undefined), this file needs a REAL `pty` for the two
 *  reads above, so every OTHER getter needs a real (if inert) implementation or it throws. */
class PtyStub {
  constructor() { this.liveStartedAtMap = new Map(); this.composerDirtyLenMap = new Map(); this.firstTurnStarted = new Set(); }
  setLiveStartedAt(id, ms) { this.liveStartedAtMap.set(id, ms); }
  liveStartedAt(id) { return this.liveStartedAtMap.has(id) ? this.liveStartedAtMap.get(id) : null; }
  setComposerDirtyLen(id, n) { this.composerDirtyLenMap.set(id, n); }
  getComposerDirtyLen(id) { return this.composerDirtyLenMap.has(id) ? this.composerDirtyLenMap.get(id) : undefined; }
  setFirstTurnStarted(id, on = true) { if (on) this.firstTurnStarted.add(id); else this.firstTurnStarted.delete(id); }
  getLastOutputAt() { return null; }
  getComposerDirtyLenBelieved() { return null; }
  getPendingConfirmMs() { return null; }
  getPendingQueueDepth() { return null; }
  getCurrentTurnBusyForMs() { return null; }
  getCodexBootStuck() { return null; }
  getLastMismatchReplay() { return null; }
  getLastMismatchFusion() { return null; }
  getLastMismatchPastedContentWrapReplay() { return null; }
  getLastMismatchNoticeSuppressed() { return null; }
  getLastMismatchUnmatched() { return null; }
  getLastPasteTripwireGiveUp() { return null; }
  getLastFlushAttribution() { return null; }
  hasFirstTurnStarted(id) { return this.firstTurnStarted.has(id); }
}
const pty = new PtyStub();

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, /** @type {any} */ (pty));
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "kickoff-confirm-pending-field-expiry-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  // (A) POSITIVE: recent liveStartedAt, well inside the window for this size.
  mkWorker("w-a");
  pty.setLiveStartedAt("w-a", Date.now() - 97_000);
  pty.setComposerDirtyLen("w-a", 69_000);
  const statusA = await call("worker_status", { workerSessionId: "w-a" });
  check("(A) THE FIELD: present while inside the window", !!statusA.kickoffConfirmPending);
  check("(A) names the char count + window", statusA.kickoffConfirmPending?.composerDirtyLen === 69_000 && statusA.kickoffConfirmPending?.windowMs > 0);

  // (B) EXPIRY BY ELAPSED TIME: same worker, same composerDirtyLen, but liveStartedAt far enough back
  // that the window (floor 60s + this size's extra, capped at 360s -> 420s total) has genuinely elapsed.
  pty.setLiveStartedAt("w-a", Date.now() - 500_000);
  const statusB = await call("worker_status", { workerSessionId: "w-a" });
  check("(B) THE FIX: null once the window has genuinely elapsed, despite the IDENTICAL large composerDirtyLen",
    statusB.kickoffConfirmPending === null);

  // (C) EXPIRY BY COMPLETED TURN: turnSeq > 0, composerDirtyLen STILL reads the stale large value.
  mkWorker("w-c");
  db.incrementTurnSeq("w-c"); // turnSeq: 0 -> 1 (a genuine completed turn)
  pty.setLiveStartedAt("w-c", Date.now() - 10_000); // recent — would otherwise read "inside the window"
  pty.setComposerDirtyLen("w-c", 69_000); // LAGGING: card c148f118's own documented staleness
  const statusC = await call("worker_status", { workerSessionId: "w-c" });
  check("(C) THE FIX: null once turn 1 completed, even with a LAGGING large composerDirtyLen reading",
    statusC.kickoffConfirmPending === null);

  // (D) CONTROL: an ordinary-sized kickoff never earns an EXTENDED window — past the flat 60s floor
  // (no extra contributed by its size) the field is null, unlike (A)'s 69K-char worker at the same
  // elapsed time.
  mkWorker("w-d");
  pty.setLiveStartedAt("w-d", Date.now() - 70_000); // past the flat 60s floor, with ZERO size-based extra
  pty.setComposerDirtyLen("w-d", 50); // ordinary-sized, well under the scale threshold
  const statusD = await call("worker_status", { workerSessionId: "w-d" });
  check("(D) CONTROL: an ordinary-sized kickoff's field is null once past the flat floor (no extended window to contribute)",
    statusD.kickoffConfirmPending === null);

  // (F) Code Review 6a497b53's DECISION: the field is non-null ONLY when the kickoff's own size earned
  // an EXTENDED window (kickoffConfirmWindowMs(composerDirtyLen) > 0) — NOT merely "within the shared
  // predicate's floor+extra window". An ordinary-sized kickoff WELL WITHIN its first 60s (the exact case
  // the pre-fix implementation got wrong — it read non-null here, matching worker_list's own doc only
  // by accident for the "past the floor" case (D) tests, never for THIS one) must ALSO read null.
  mkWorker("w-f");
  pty.setLiveStartedAt("w-f", Date.now() - 10_000); // well inside the flat 60s floor
  pty.setComposerDirtyLen("w-f", 50); // ordinary-sized — earns zero extended window
  const statusF = await call("worker_status", { workerSessionId: "w-f" });
  check("(F) THE FIX: an ordinary-sized kickoff reads null even WELL WITHIN the flat 60s floor (never earned an extended window at all)",
    statusF.kickoffConfirmPending === null);

  // (G) Major 2's own root fix: turnSeq===0 means "no COMPLETED turn", not "kickoff unconfirmed" — a
  // worker whose first turn has genuinely STARTED (hasFirstTurnStarted:true, busy mid-turn) but hasn't
  // COMPLETED one yet (turnSeq still 0) must read null, even with a large composerDirtyLen reading
  // (a real, if stale, remnant from the give-up/heal cycle that preceded the turn actually starting).
  mkWorker("w-g");
  pty.setLiveStartedAt("w-g", Date.now() - 10_000);
  pty.setComposerDirtyLen("w-g", 69_000);
  pty.setFirstTurnStarted("w-g", true);
  const statusG = await call("worker_status", { workerSessionId: "w-g" });
  check("(G) THE FIX: null once the first turn has STARTED, even with turnSeq still 0 and a large composerDirtyLen reading",
    statusG.kickoffConfirmPending === null);

  // (H) worker_list (fleetView) shares the SAME predicate — confirm it reads the field identically for
  // the SAME (A)-shaped worker, not a second, divergently-implemented copy.
  const list = await call("worker_list", {});
  const rowA = list.find((r) => r.workerSessionId === "w-a");
  check("(H) worker_list's own row for the SAME worker currently reads null too (w-a was expired in (B), not re-armed)",
    rowA && rowA.kickoffConfirmPending === null);
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 8882e2ca (Code Review f3fa9002, Major 2): worker_list/worker_status's " +
    "kickoffConfirmPending field now EXPIRES on both axes via the shared withinKickoffConfirmWindow " +
    "predicate — once the size-aware elapsed-time window genuinely passes (B), and once the worker's " +
    "turnSeq shows a completed turn regardless of a lagging composerDirtyLen (C) — while still reporting " +
    "correctly while genuinely pending (A), staying null for an ordinary-sized kickoff throughout (D/F — " +
    "even WELL WITHIN the flat floor, Code Review 6a497b53's own decision), null once the first turn has " +
    "genuinely STARTED regardless of turnSeq/composerDirtyLen (G), and reading identically from " +
    "worker_list's own row for the same worker (H)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
