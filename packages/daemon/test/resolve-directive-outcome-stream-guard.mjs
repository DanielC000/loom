import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3c39be30 — regression coverage for `resolveDirectiveOutcome`'s newly-enforced stream precondition
// (mcp/orchestration.ts) and the `directiveByMsgId`/`peerMessageStatusByMsgId` twins fold.
//
// THE DEFECT THIS PROVES AGAINST: `resolveDirectiveOutcome` used to accept ANY `OrchestrationEvent[]`, with
// an undocumented, unenforced precondition that the array actually be capable of containing the
// `session_message_delivered`/`session_message_gave_up` row for the msgId chain being walked. A
// freehand-assembled array that couldn't (e.g. `peerMessageStatusByMsgId`'s first implementation, card
// 0f693dea, which fed `db.listEvents(managerSessionId)` before `resolveQueuedMessage` threaded the real
// sender through) returned a CONFIDENT `"pending"` forever — no error, no null, no warning. A passing test
// suite did not catch it: the test asserted "pending" on a message it never actually drained.
//
// THE FIX: stream selection is now folded into three named constructors (workerDirectiveStream /
// workerLineageDirectiveStream / managerLineageDirectiveStream — module-private, exercised here only via
// the real tools that call them) — the ONLY way to build a `DirectiveEventStream`. `resolveDirectiveOutcome`
// carries a REAL runtime tag (not just a TS-erased phantom type) and REFUSES (throws) any array that didn't
// come from one of them.
//
// (1) POSITIVE CONTROL — the guard actually fires: a hand-assembled array shaped EXACTLY like the historical
//     defect (the same event, same fields, just not built via any sanctioned constructor) now throws instead
//     of returning a silent "pending". Proven against the REAL exported function, not a reimplementation.
// (2) NEGATIVE CONTROL — the guard does not fire on legitimate input: driving the REAL production entry
//     points (worker_status's queriedDirective via directiveByMsgId, directive_status via
//     directiveDeliveriesForCaller) resolves "delivered" without throwing, proving part (1) isn't just an
//     unconditional throw regardless of input.
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter, resolveDirectiveOutcome } from "../dist/mcp/orchestration.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (1) POSITIVE CONTROL: the guard actually fires =====================
// This is the exact shape of the original defect: a plain array built by hand (never routed through
// workerDirectiveStream/workerLineageDirectiveStream/managerLineageDirectiveStream), containing an event
// that WOULD have resolved this msgId to "delivered" had it been reached. Pre-fix, resolveDirectiveOutcome
// would happily walk it and return {state:"pending"} (the malformed root msgId has no give-up event, falls
// through to the delivered-check, and — depending on array construction — could go either way silently).
// Post-fix it must refuse to walk it AT ALL, regardless of what answer the walk would have produced.
{
  const rootDirective = {
    id: "evt-1", ts: "2026-08-06T00:00:00.000Z", managerSessionId: "MGR", workerSessionId: "W",
    taskId: null, kind: "message_worker", detail: { msgId: "m1", turnSeqAtDelivery: 0 },
  };
  const handAssembledEvents = [rootDirective]; // NOT built via any sanctioned stream constructor
  let threw = false;
  let thrownMessage = "";
  try {
    resolveDirectiveOutcome(handAssembledEvents, rootDirective, "m1");
  } catch (e) {
    threw = true;
    thrownMessage = String(e?.message ?? e);
  }
  check("(1) resolveDirectiveOutcome THROWS on a hand-assembled events array (the guard actually fires, not just a passing test)", threw);
  check("(1) the thrown error names the sanctioned constructors, so a future violator gets an actionable message, not a bare crash",
    /workerDirectiveStream|workerLineageDirectiveStream|managerLineageDirectiveStream/.test(thrownMessage));
}

// Second positive-control specimen: an EMPTY hand-assembled array — proves the guard fires on the tag's
// absence alone, independent of content (a non-empty array above already proves it isn't merely "empty
// array throws" — this proves the reverse: content alone, with no tag, is not enough to pass).
{
  let threw = false;
  try {
    resolveDirectiveOutcome([], { id: "x", ts: "2026-08-06T00:00:00.000Z", managerSessionId: "MGR", workerSessionId: "W", taskId: null, kind: "message_worker", detail: { msgId: "m2" } }, "m2");
  } catch { threw = true; }
  check("(1b) resolveDirectiveOutcome ALSO throws on an empty hand-assembled array (tag absence, not array content, is what's checked)", threw);
}

// ===================== (2) NEGATIVE CONTROL: real production paths still resolve, no throw =====================
// Drives the REAL worker_status / directive_status tools — both now route through the sanctioned stream
// constructors internally (directiveByMsgId -> workerDirectiveStream; directiveDeliveriesForCaller ->
// workerLineageDirectiveStream) — over a hermetic Db, exactly mirroring stale-directive-projection.mjs's
// and directive-status.mjs's own harness shape. A held message_worker that later drains must still resolve
// "delivered", proving the fold didn't quietly reintroduce the original bug it's meant to prevent.
const dbFile = path.join(os.tmpdir(), `loom-resolve-directive-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-06T00:00:00.000Z";
const projId = "proj-rdog";
const agentId = "agent-rdog";
db.insertProject({ id: projId, name: "ResolveDirectiveGuard", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({
  id: "MGR", projectId: projId, agentId, engineSessionId: "eng-MGR", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null,
});
db.insertSession({
  id: "W", projectId: projId, agentId, engineSessionId: "eng-W", title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker", parentSessionId: "MGR", taskId: "tk-W", branch: "loom/W",
});
const ev = (workerId, mgrId, kind, ts, detail) => db.appendEvent({
  id: randomUUID(), ts, managerSessionId: mgrId, workerSessionId: workerId, taskId: "tk-" + workerId, kind, detail,
});
// A HELD message_worker (no turnSeqAtDelivery on its own event) that later drains via
// session_message_delivered — the SAME held-then-drains shape peer-message-status.mjs's (d2) reproduces for
// the sender side; this exercises the RECIPIENT/worker-keyed side of the same fold.
ev("W", "MGR", "message_worker", now, { msgId: "m-held" });
ev("W", "MGR", "session_message_delivered", now, { msgId: "m-held", turnSeqAtDelivery: 0, sender: "MGR" });

const orch = new OrchestrationMcpRouter(db, /** @type {any} */ ({
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
}));

const parse = (res) => JSON.parse(res.content[0].text);
async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "resolve-directive-outcome-stream-guard-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  // worker-facing directive_status -> directiveDeliveriesForCaller -> workerLineageDirectiveStream
  const workerClient = await connect(orch.buildServer("W", "worker"));
  const wCall = async (name, args) => parse(await workerClient.callTool({ name, arguments: args }));
  const ds = await wCall("directive_status", {});
  check("(2) directive_status resolves the held-then-drained directive as a delivery, no throw (workerLineageDirectiveStream path)",
    Array.isArray(ds.deliveries) && ds.deliveries.some((d) => d.msgId === "m-held"));
  await workerClient.close();

  // manager-facing worker_status(msgId) -> directiveByMsgId -> workerDirectiveStream
  const mgrClient = await connect(orch.buildServer("MGR", "manager"));
  const mCall = async (name, args) => parse(await mgrClient.callTool({ name, arguments: args }));
  const status = await mCall("worker_status", { workerSessionId: "W", msgId: "m-held" });
  check("(2) worker_status's queriedDirective resolves the held-then-drained msgId to \"delivered\" (workerDirectiveStream path, not \"pending\")",
    status.queriedDirective?.found === true && status.queriedDirective?.state === "delivered");
  await mgrClient.close();
} finally {
  db.close();
  // card f273ebb9: the DB runs in WAL mode (db.ts), so a bare unlink of dbFile alone could leave its
  // `-wal`/`-shm` sidecars behind — sweep all three through the shared bounded-retry helper, which also
  // no-ops cleanly on a sidecar that was never created.
  for (const p of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) cleanupPathSync(p);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveDirectiveOutcome refuses a hand-assembled events array outright (positive control, card 3c39be30's enforced precondition), and the real directive_status/worker_status tools still resolve correctly through the folded stream constructors (negative control)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
