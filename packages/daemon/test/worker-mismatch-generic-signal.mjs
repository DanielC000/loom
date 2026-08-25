import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_list/worker_status `lastMismatch` generic-derived-view test (card 31f3d047).
//
// THE BUG THIS CLOSES: a session sat in an ACTIVELY-FIRING `[prompt-mismatch-unmatched-remainder]` loop
// (Loom classified it correctly, 8 times, in real time) while `worker_status` read clean —
// `lastMismatchReplay` and `lastMismatchFusion` were both (correctly) null, because the mismatch was
// neither a replay nor a fusion: it was `Live.lastMismatchUnmatched`'s own broader "unmatchable" class,
// which had a getter (`getLastMismatchUnmatched`, card 59757189) but NO worker_list/worker_status
// projection at all. "Two specifically-named nulls license 'not a replay, not a fusion' — never 'not
// detected.'" This test proves the fix: a GENERIC, DERIVED `lastMismatch: {kind, gen, at}` field that
// covers all three named classes (replay/fusion/unmatched) from ONE read, so a reader never needs to know
// every class name in advance. Mirrors worker-mismatch-suppressed-signal.mjs's harness technique (a REAL
// PtyHost over the createPty() seam, wired into a REAL OrchestrationMcpRouter — no real claude, no daemon).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/worker-mismatch-generic-signal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mismatch-generic-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} };
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retrofitted onto the shared _wait.mjs waitUntil (card 24d2e0ac): same timeoutMs/stepMs budget, still
// returns true/false — a thrown predicate is a real bug and should propagate, not fold into false.
const waitUntil = async (predicate, timeoutMs = 2000, stepMs = 5) => {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs: stepMs, label: "worker-mismatch-generic-signal: predicate" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
};
const hasPendingMismatchNotice = (sid) => host.getPendingEntries(sid).some((e) => e.text.includes("[loom:prompt-mismatch]"));

const dbFile = path.join(os.tmpdir(), `loom-mismatch-generic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seededActivity = "2026-08-24T12:00:00.000Z";
const projId = "proj-mismatch-generic";
const agentId = "agent-mismatch-generic";
db.insertProject({ id: projId, name: "MismatchGeneric", repoPath: projId, vaultPath: projId, config: {}, createdAt: seededActivity, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
for (const id of ["w-remainder", "w-replay", "w-fusion", "w-clean", "w-not-in-pty"]) {
  db.insertSession({ id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seededActivity, lastActivity: seededActivity, lastError: null, role: "worker", parentSessionId: "mgr", taskId: `task-${id}` });
}

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

function spawnReady(targetHost, sessionId) {
  targetHost.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  targetHost.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {}, host);
async function connectAs(sessionId, role) {
  const server = router.buildServer(sessionId, role);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: `mismatch-generic-test-${sessionId}`, version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  return { call: async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} })) };
}

const mgrClient = await connectAs("mgr", "manager");

try {
  // ============== (1) THE CARD'S OWN SPECIMEN — an unmatched-REMAINDER mismatch, not just any =========
  // unmatchable one: `reported` CONTAINS an earlier generation's own recorded write as a substring, with
  // real content before/after it that is NOT accounted for (`findRecognizedSubstring`, pty/host.ts —
  // logs `[prompt-mismatch-unmatched-remainder]`, exactly the class that fired 8x while worker_status
  // read clean in the real incident). This is strictly NARROWER than an arbitrary unrelated-content
  // mismatch — a test exercising only that broader shape would not prove THIS class is covered.
  {
    const SID = "w-remainder";
    spawnReady(host, SID);
    const earlierGenText = "[loom:worker-report] worker AAAA — an earlier, real prior generation's own write";
    const genText = "[loom:from-manager] the real content this generation actually intended to submit";
    // gen=1: a real prior write, recorded in recentWrittenTurns.
    host.enqueueStdin(SID, earlierGenText);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: earlierGenText });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    // gen=2: intended genText, but the engine reports gen=1's own recorded text SANDWICHED between
    // leading/trailing junk that Loom has no record of writing — a remainder, not an exact replay/fusion.
    host.enqueueStdin(SID, genText);
    const leadingJunk = "stray leading content Loom never wrote ";
    const trailingJunk = " and stray trailing content Loom never wrote either";
    const reported = leadingJunk + earlierGenText + trailingJunk;
    const beforeDetect = Date.now();
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: reported });
    const afterDetect = Date.now();

    check("(1) sanity — this really is the unmatched-remainder class at the PtyHost level (getLastMismatchUnmatched fires, not replay/fusion)",
      host.getLastMismatchUnmatched(SID) !== null && host.getLastMismatchReplay(SID) === null && host.getLastMismatchFusion(SID) === null);

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(1) RED-PROOF — worker_list surfaces the remainder mismatch via the GENERIC lastMismatch field, not left null like its named siblings",
      row?.lastMismatch !== null && row?.lastMismatch !== undefined
      && row.lastMismatch.kind === "unmatched"
      && row.lastMismatch.gen === 2
      && row.lastMismatchReplay === null && row.lastMismatchFusion === null);
    check("(1) lastMismatch.at is a real wall-clock timestamp taken at detection",
      typeof row.lastMismatch.at === "number" && row.lastMismatch.at >= beforeDetect && row.lastMismatch.at <= afterDetect);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(1) worker_status: same shape, same values — a manager reading THIS ONE field learns the mismatch fired without knowing 'unmatched-remainder' is a class that exists",
      status?.lastMismatch?.kind === "unmatched" && status.lastMismatch.gen === 2 && status.lastMismatch.at === row.lastMismatch.at);

    // Close out gen=2's own turn and drain its pending `[loom:prompt-mismatch]` notice as a clean,
    // matching turn of its own (mirrors pty-prompt-mismatch.mjs scenario 20's own established technique)
    // — required before further enqueueStdin/deliverHook calls on this SAME session in test (4) below can
    // be trusted to confirm the generation they actually intend, rather than an off-by-one against a
    // still-outstanding notice.
    await waitUntil(() => hasPendingMismatchNotice(SID));
    host.deliverHook(SID, { hook_event_name: "Stop" }); // closes gen=2's turn; busy->false drains the queued notice as the new outstanding turn
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: host.live.get(SID).lastPrompt });
    host.deliverHook(SID, { hook_event_name: "Stop" });
  }

  // ============== (2) A REPLAY-ONLY mismatch surfaces as kind:"replay" ==============
  {
    const SID = "w-replay";
    spawnReady(host, SID);
    const gen1Text = "[loom:from-manager] generation 1's own real content";
    host.enqueueStdin(SID, gen1Text);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // byteIdentical=true, gen=1
    host.deliverHook(SID, { hook_event_name: "Stop" });
    const gen2Text = "[loom:from-manager] generation 2's own real, different content";
    host.enqueueStdin(SID, gen2Text);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: gen1Text }); // reports gen1's text verbatim — a replay

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(2) a pure replay surfaces as kind:\"replay\" via the generic field, and its own named field agrees",
      status?.lastMismatch?.kind === "replay" && status.lastMismatchReplay !== null
      && status.lastMismatch.gen === status.lastMismatchReplay.gen && status.lastMismatchFusion === null);
  }

  // ============== (3) A FUSION mismatch surfaces as kind:"fusion" ==============
  {
    const SID = "w-fusion";
    spawnReady(host, SID);
    const genNMinus1Text = "[loom:worker-report] worker BBBB — generation N-1's own real report";
    const genNText = "[loom:merge-done] worker CCCC merged — generation N's own real, different content";
    host.enqueueStdin(SID, genNMinus1Text);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: genNMinus1Text });
    host.deliverHook(SID, { hook_event_name: "Stop" });
    host.enqueueStdin(SID, genNText);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: genNMinus1Text + genNText }); // confirmed fusion

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(3) a confirmed fusion surfaces as kind:\"fusion\" via the generic field, and its own named field agrees",
      status?.lastMismatch?.kind === "fusion" && status.lastMismatchFusion !== null
      && status.lastMismatch.gen === status.lastMismatchFusion.gen && status.lastMismatchReplay === null);
  }

  // ============== (4) MOST-RECENT-WINS: a later mismatch of a DIFFERENT kind on the same worker =======
  // supersedes an earlier one in the generic view — proves this is derived live, not latched to whichever
  // class fired first.
  {
    const SID = "w-remainder"; // reuse worker (1) above — it already has an "unmatched" lastMismatch
    const before = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(4) setup: this worker's generic view currently reads \"unmatched\" (from test (1))", before?.lastMismatch?.kind === "unmatched");
    const unmatchedGen = before.lastMismatch.gen;

    const priorText = "[loom:from-manager] a real, clean turn on this worker, to be replayed by the NEXT one";
    host.enqueueStdin(SID, priorText);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: priorText }); // byteIdentical=true
    host.deliverHook(SID, { hook_event_name: "Stop" });
    const nextText = "[loom:from-manager] the next generation's own real, different content";
    host.enqueueStdin(SID, nextText);
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: priorText }); // reports the prior turn verbatim — a fresh replay, later in wall-clock time

    const after = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(4) RED-PROOF — the generic view now reflects the LATER replay (kind:\"replay\"), not stuck on the earlier unmatched occurrence",
      after?.lastMismatch?.kind === "replay" && after.lastMismatchReplay !== null && after.lastMismatch.gen === after.lastMismatchReplay.gen);
    check("(4) the later replay's own gen is strictly after the earlier unmatched occurrence's gen",
      after.lastMismatch.gen > unmatchedGen);
    // `lastMismatchUnmatched` itself is NOT exposed raw on worker_status (deliberately — see the
    // deriveLastMismatch doc: a raw fourth field would reproduce the exact gap this card fixes), so check
    // its underlying PtyHost value directly to prove it's genuinely untouched, not merely absent from the
    // response.
    check("(4) the earlier occurrence's own named PtyHost field is untouched (still recording the SAME unmatched capture) — only the DERIVED view moved",
      host.getLastMismatchUnmatched(SID)?.gen === unmatchedGen);
  }

  // ============== (5) A clean worker (no mismatch ever) reads lastMismatch:null, not a fabricated value ==
  {
    const SID = "w-clean";
    spawnReady(host, SID);
    host.enqueueStdin(SID, "an entirely ordinary, correctly-delivered turn");
    host.deliverHook(SID, { hook_event_name: "UserPromptSubmit", prompt: "an entirely ordinary, correctly-delivered turn" });

    const list = await mgrClient.call("worker_list");
    const row = list.find((w) => w.workerSessionId === SID);
    check("(5) worker_list: a clean worker reads lastMismatch:null", row?.lastMismatch === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: SID });
    check("(5) worker_status: same null", status.lastMismatch === null);
  }

  // ============== (6) NULL for a session not live in THIS PtyHost process ==============
  {
    const list = await mgrClient.call("worker_list");
    const other = list.find((w) => w.workerSessionId === "w-not-in-pty");
    check("(6) worker_list: a worker never spawned in this process reads lastMismatch:null", other && other.lastMismatch === null);

    const status = await mgrClient.call("worker_status", { workerSessionId: "w-not-in-pty" });
    check("(6) worker_status: same null", status.lastMismatch === null);
  }

  // ============== (7) byte-compat: a router built the OLD way (no pty arg) still works ==============
  {
    const routerNoPty = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
    const server = routerNoPty.buildServer("mgr", "manager");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "mismatch-generic-nopty-test", version: "0" });
    await client.connect(clientT);
    const list = JSON.parse((await client.callTool({ name: "worker_list", arguments: {} })).content[0].text);
    check("(7) a router with no PtyHost wired still returns worker_list without throwing", Array.isArray(list) && list.length === 5);
    check("(7) every row reads lastMismatch:null when no PtyHost was wired", list.every((w) => w.lastMismatch === null));
  }
} finally {
  for (const sid of ["w-remainder", "w-replay", "w-fusion", "w-clean"]) {
    try { host.stop(sid, "hard"); } catch { /* ignore */ }
  }
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — `lastMismatch` (card 31f3d047) exposes worker_list/worker_status's GENERIC, DERIVED view over lastMismatchReplay/lastMismatchFusion/lastMismatchUnmatched: an unmatched-REMAINDER mismatch (the card's own real specimen — an actively-firing loop that read clean through the two named fields) is now visible in ONE read via kind:\"unmatched\", replay/fusion surface their own kinds too, the derived view tracks whichever fired MOST RECENTLY (not latched to the first), a clean worker reads null (not a fabricated value), a worker not live in this process reads null, and a router built without a PtyHost stays byte-compatible."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
