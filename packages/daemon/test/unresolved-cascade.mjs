import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `unresolvedCascade` test (card f797affb) — the EXPOSURE half of `5c3db367`'s
// forensic close. That card spent a two-file, cross-referenced log read to establish that a give-up/
// re-mint cascade ending PARKED, with a `[prompt-mismatch]` logged alongside, was in that specimen
// benign — delivered and fully acted on, just never individually CONFIRMED by Loom's own bookkeeping.
// NOTHING in worker_list/worker_status could have told anyone that without the archaeology.
//
// `unresolvedCascade` is pure WIRING over two ALREADY-EXISTING signals: `parkedDirective` (a give-up/
// re-mint cascade PARKED with no individual CONFIRMED — see stale-directive-projection.mjs) and
// `lastMismatch` (a `[prompt-mismatch]` logged on the worker — see worker-mismatch-generic-signal.mjs),
// combined only when both fire within a bounded correlation window of each other. Mirrors
// stale-directive-projection.mjs's harness technique (a real Db + the real manager MCP tools over an
// InMemoryTransport pair, HERMETIC — no real claude, no external daemon) and adds a minimal `pty` STUB
// (not a real PtyHost) exposing only the `getLastMismatch*`/other getters worker_list/worker_status call,
// so `lastMismatch` can be driven directly by wall-clock `detectedAt` values without needing to reproduce
// a real submit/mismatch race through node-pty.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-unresolved-cascade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-29T12:00:00.000Z";
const nowMs = Date.parse(now);
const projId = "proj-uc";
const agentId = "agent-uc";
db.insertProject({ id: projId, name: "UnresolvedCascade", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedManager(id) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
  });
}
function seedWorker(id, parentId, { turnSeq = 0 } = {}) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: parentId, taskId: "tk-" + id, branch: "loom/" + id,
  });
  for (let i = 0; i < turnSeq; i++) db.incrementTurnSeq(id);
}
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
const at = (sec) => new Date(nowMs + sec * 1000).toISOString();
const atMs = (sec) => nowMs + sec * 1000;

seedManager("MGR");

// A minimal `pty` STUB — only the getters worker_list/worker_status actually call. `mismatchByWorker` is
// keyed per-worker so each scenario below can drive its own `lastMismatch` independently; every other
// getter returns a fixed, inert value (mirrors what a real PtyHost reads for a session with no activity
// of that kind).
const mismatchByWorker = new Map(); // workerId -> { kind, gen, detectedAt } | null, shaped like a raw lastMismatch* record
const ptyStub = {
  getLastOutputAt() { return null; },
  getComposerDirtyLen() { return null; },
  getComposerDirtyLenBelieved() { return null; },
  getPendingConfirmMs() { return null; },
  getLastMismatchNoticeSuppressed() { return null; },
  getLastPasteTripwireGiveUp() { return null; },
  // `deriveLastMismatch` (orchestration.ts) picks whichever of replay/fusion/unmatched has the latest
  // `detectedAt` — since each test scenario below only ever seeds ONE kind per worker, routing that one
  // record through whichever getter matches its own `kind` (and returning null from the other two) is
  // sufficient to drive the derived `lastMismatch` view deterministically.
  getLastMismatchReplay(workerId) {
    const m = mismatchByWorker.get(workerId);
    return m?.kind === "replay" ? { gen: m.gen, replayedGen: m.gen - 1, reportedLen: 10, intendedLen: 10, detectedAt: m.detectedAt, explainedBenign: null } : null;
  },
  getLastMismatchFusion(workerId) {
    const m = mismatchByWorker.get(workerId);
    return m?.kind === "fusion" ? { gen: m.gen, spanGens: [m.gen - 1, m.gen], reportedLen: 10, intendedLen: 10, detectedAt: m.detectedAt } : null;
  },
  getLastMismatchUnmatched(workerId) {
    const m = mismatchByWorker.get(workerId);
    return m?.kind === "unmatched" ? { gen: m.gen, intendedLen: 10, intendedText: "x", detectedAt: m.detectedAt } : null;
  },
};

// ---------------------------------------------------------------------------------------------------
// (a) FIRES: a realistic give-up/re-mint/park cascade (mirrors stale-directive-projection.mjs case (j))
// with a `[prompt-mismatch]` (kind:"replay") detected in the SAME instant as the terminal give-up — the
// exact shape `5c3db367`'s own trace showed (both logged under the same write timestamp).
seedWorker("w-cascade", "MGR", { turnSeq: 0 });
ev("w-cascade", "MGR", "message_worker", at(0), { msgId: "m-cascade", turnSeqAtDelivery: 0 });
ev("w-cascade", "MGR", "session_message_gave_up", at(5), { msgId: "m-cascade", rootMsgId: "m-cascade", chainDepth: 0, outcome: "reminted", remintedAs: "m-cascade-1" });
ev("w-cascade", "MGR", "session_message_gave_up", at(10), { msgId: "m-cascade-1", rootMsgId: "m-cascade", chainDepth: 1, outcome: "parked" });
mismatchByWorker.set("w-cascade", { kind: "replay", gen: 4, detectedAt: atMs(10) });

// (b) RED-FIRST CONTROL — a healthy delivery: message delivered cleanly, no park, and (deliberately) a
// mismatch ALSO fires elsewhere in the session's life. Proves `unresolvedCascade` needs `parkedDirective`
// itself, not just "a mismatch happened somewhere" — the DoD's own second paired-test requirement.
seedWorker("w-healthy", "MGR", { turnSeq: 3 });
ev("w-healthy", "MGR", "message_worker", at(0), { msgId: "m-healthy", turnSeqAtDelivery: 0 });
mismatchByWorker.set("w-healthy", { kind: "replay", gen: 2, detectedAt: atMs(1) });

// (c) NO-FIRE — parked, but NO mismatch ever fired on this worker (an ordinary park, the case
// `parkedDirective` alone already covers correctly on its own).
seedWorker("w-parked-only", "MGR", { turnSeq: 0 });
ev("w-parked-only", "MGR", "message_worker", at(0), { msgId: "m-parked-only", turnSeqAtDelivery: 0 });
ev("w-parked-only", "MGR", "session_message_gave_up", at(5), { msgId: "m-parked-only", rootMsgId: "m-parked-only", chainDepth: 0, outcome: "reminted", remintedAs: "m-parked-only-1" });
ev("w-parked-only", "MGR", "session_message_gave_up", at(10), { msgId: "m-parked-only-1", rootMsgId: "m-parked-only", chainDepth: 1, outcome: "parked" });
// deliberately no mismatchByWorker.set for this worker

// (d) NO-FIRE — a mismatch fired, but this worker was never parked (mirrors worker-mismatch-generic-
// signal.mjs's own "clean" shape from the directive side: a plain, in-flight delivery).
seedWorker("w-mismatch-only", "MGR", { turnSeq: 9 });
ev("w-mismatch-only", "MGR", "message_worker", at(0), { msgId: "m-mismatch-only", turnSeqAtDelivery: 0 });
mismatchByWorker.set("w-mismatch-only", { kind: "unmatched", gen: 6, detectedAt: atMs(30) });

// (e) NO-FIRE — parked AND mismatched, but the mismatch is FAR outside the correlation window (well
// beyond any realistic single cascade — see deriveUnresolvedCascade's own doc for why the window is
// bounded at all: without it, two genuinely unrelated stale/sticky signals would falsely pair).
seedWorker("w-out-of-window", "MGR", { turnSeq: 0 });
ev("w-out-of-window", "MGR", "message_worker", at(0), { msgId: "m-oow", turnSeqAtDelivery: 0 });
ev("w-out-of-window", "MGR", "session_message_gave_up", at(5), { msgId: "m-oow", rootMsgId: "m-oow", chainDepth: 0, outcome: "reminted", remintedAs: "m-oow-1" });
ev("w-out-of-window", "MGR", "session_message_gave_up", at(10), { msgId: "m-oow-1", rootMsgId: "m-oow", chainDepth: 1, outcome: "parked" });
mismatchByWorker.set("w-out-of-window", { kind: "fusion", gen: 40, detectedAt: atMs(10 + 3600) }); // +1h — far past any bounded window

// (f) NO-FIRE — confirmed-after-park: the give-up chain resolved to `confirmed-after-park` (the message
// DID land), so `parkedDirective` itself reads null and `unresolvedCascade` must not fire even though a
// mismatch is present nearby — a confirmed message is not an unresolved one.
seedWorker("w-confirmed-after-park", "MGR", { turnSeq: 0 });
ev("w-confirmed-after-park", "MGR", "message_worker", at(0), { msgId: "m-cap", turnSeqAtDelivery: 0 });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(5), { msgId: "m-cap", rootMsgId: "m-cap", chainDepth: 0, outcome: "reminted", remintedAs: "m-cap-1" });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(10), { msgId: "m-cap-1", rootMsgId: "m-cap", chainDepth: 1, outcome: "parked" });
ev("w-confirmed-after-park", "MGR", "session_message_gave_up", at(12), { msgId: "m-cap-1", rootMsgId: "m-cap", outcome: "confirmed-after-park", latencyMs: 2000 });
mismatchByWorker.set("w-confirmed-after-park", { kind: "replay", gen: 3, detectedAt: atMs(11) });

const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
}), {}, /** @type {any} */ (ptyStub));
const server = router.buildServer("MGR", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "unresolved-cascade-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const status = async (id) => parse(await client.callTool({ name: "worker_status", arguments: { workerSessionId: id } }));

const list = parse(await client.callTool({ name: "worker_list", arguments: {} }));
const byId = Object.fromEntries(list.map((w) => [w.workerSessionId, w]));

// ============ (a) RED-FIRST: the cascade-with-no-CONFIRMED case must RAISE the state ============
check("(a) sanity: parkedDirective fired (the raw cascade signal, unchanged by this card)",
  byId["w-cascade"]?.parkedDirective !== null && byId["w-cascade"]?.parkedDirective?.msgId === "m-cascade");
check("(a) sanity: lastMismatch fired (the raw prompt-mismatch signal, unchanged by this card)",
  byId["w-cascade"]?.lastMismatch !== null && byId["w-cascade"]?.lastMismatch?.kind === "replay");
check("(a) FIRES unresolvedCascade — the exact combination this card exists to surface",
  byId["w-cascade"]?.unresolvedCascade !== null
  && byId["w-cascade"]?.unresolvedCascade?.msgId === "m-cascade"
  && byId["w-cascade"]?.unresolvedCascade?.mismatchKind === "replay");
// Card f797affb DoD-4: must NOT nudge anyone toward worker_stop/respawn. The note is allowed to NAME
// those tools only to explicitly RULE THEM OUT ("do not worker_stop/recycle on this alone") — it must
// never RECOMMEND them, so the check asserts the prohibition phrasing rather than mere absence of the
// word (a bare "not worker_stop" substring check would false-fail on the correct, explicit prohibition).
check("(a) the note states UNRESOLVED, never a guessed verdict, and explicitly PROHIBITS (not recommends) worker_stop/recycle",
  typeof byId["w-cascade"]?.unresolvedCascade?.note === "string"
  && /UNRESOLVED/.test(byId["w-cascade"].unresolvedCascade.note)
  && /could not be determined/i.test(byId["w-cascade"].unresolvedCascade.note)
  && /do not worker_stop\/recycle/i.test(byId["w-cascade"].unresolvedCascade.note));
check("(a) the note names the actual disambiguation check (read the transcript)",
  /transcript/i.test(byId["w-cascade"]?.unresolvedCascade?.note ?? ""));

// ============ (b) RED-FIRST CONTROL: an ordinary healthy delivery must NOT raise the state ============
check("(b) sanity: no parkedDirective on a healthy delivery",
  byId["w-healthy"]?.parkedDirective === null);
check("(b) sanity: a mismatch DID fire on this worker (proves this isn't a vacuous 'nothing happened' control)",
  byId["w-healthy"]?.lastMismatch !== null);
check("(b) NO-FIRE: unresolvedCascade stays null for a healthy delivery even though a mismatch fired elsewhere in its life",
  byId["w-healthy"]?.unresolvedCascade === null);

// ============ (c)-(f) further negative controls, each isolating one half of the combination ============
check("(c) NO-FIRE: parked alone, never a mismatch",
  byId["w-parked-only"]?.parkedDirective !== null && byId["w-parked-only"]?.unresolvedCascade === null);

check("(d) NO-FIRE: mismatched alone, never parked",
  byId["w-mismatch-only"]?.lastMismatch !== null
  && byId["w-mismatch-only"]?.parkedDirective === null
  && byId["w-mismatch-only"]?.unresolvedCascade === null);

check("(e) NO-FIRE: parked AND mismatched, but the mismatch is an hour outside the correlation window",
  byId["w-out-of-window"]?.parkedDirective !== null
  && byId["w-out-of-window"]?.lastMismatch !== null
  && byId["w-out-of-window"]?.unresolvedCascade === null);

check("(f) NO-FIRE: confirmed-after-park (the message DID land) — parkedDirective itself reads null, so unresolvedCascade must too",
  byId["w-confirmed-after-park"]?.directive?.state === "confirmed-after-park"
  && byId["w-confirmed-after-park"]?.parkedDirective === null
  && byId["w-confirmed-after-park"]?.unresolvedCascade === null);

// ============================ worker_status mirrors worker_list ============================
const sCascade = await status("w-cascade");
check("worker_status(w-cascade) carries the same unresolvedCascade as worker_list",
  sCascade.unresolvedCascade?.msgId === "m-cascade" && sCascade.unresolvedCascade?.mismatchKind === "replay");
const sHealthy = await status("w-healthy");
check("worker_status(w-healthy) → unresolvedCascade null (healthy control, mirrored)",
  sHealthy.unresolvedCascade === null);

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — unresolvedCascade (card f797affb) fires ONLY on the exact combination it exists to surface (a give-up/re-mint cascade PARKED with no individual CONFIRMED, co-occurring within a bounded window with a logged [prompt-mismatch]), proven RED-first against a realistic cascade; a healthy delivery with an unrelated mismatch elsewhere in the worker's life does NOT raise it (the paired control); parked-alone, mismatch-alone, out-of-window, and confirmed-after-park (the message actually landed) all correctly stay null; the note states UNRESOLVED plainly, never guesses a verdict, never steers toward worker_stop/recycle, and names the transcript read that actually settles it; and worker_status mirrors worker_list exactly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
