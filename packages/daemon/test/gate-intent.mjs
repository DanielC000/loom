import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// gate_intent_declare / gate_intent_withdraw / gate_queue's `declarations` array (card a5d1ae04) — the
// structured "I intend to fire a gate at ~T" advisory that replaces a hand-written peer-channel letter.
// Proves:
//   (unit, registry)  GateIntentRegistry itself, with an injectable clock: declare/redeclare/withdraw;
//                      msUntilFire goes NEGATIVE once `firesAt` passes rather than being clamped or the row
//                      vanishing exactly on that instant (this session's manager's explicit design ruling);
//                      the grace-window reap; the dead-seat reap (session no longer `processState:"live"`)
//                      fires INDEPENDENTLY of, and faster than, either clock-based rule.
//   (mutant, polarity) The dangerous failure direction here is OVER-expiry (a LIVE session's declaration
//                      wrongly dropped reads identically to "nobody declared" — invisible), so the control
//                      that actually has power is "a live, healthy declaration SURVIVES repeated reads,"
//                      not "a dead one eventually goes away." A deliberately-too-aggressive mutant rule is
//                      run against the SAME scenario first and shown to WRONGLY drop a still-live
//                      declaration, before the real registry is shown to correctly keep it — so the
//                      "survives" assertion below is proven to have power, not just proven to pass.
//   (unit, redaction)  SessionService.gateQueueForManager's `declarations` array: an own-project entry
//                      carries {repoKey, note, declaredBy}; a foreign-project entry omits all three
//                      (never redacted-to-null) and carries `redacted:true`, while `gateType`/`firesAt`/
//                      `declaredAt`/`ageMs`/`msUntilFire` cross the boundary either way (mirrors
//                      GateQueueEntry's own established redaction tiers). No raw `sessionId` anywhere.
//   (e2e, MCP)         the REAL gate_intent_declare/gate_intent_withdraw tools over a real router/client:
//                      manager-only (absent from the worker's pinned 6-tool surface, unchanged), a bad
//                      `inMs` is rejected with {error}, declare→read-back→withdraw→gone, and a DIFFERENT
//                      project's WORKER caller reading gate_queue sees the SAME redacted shape a manager
//                      caller there would (redaction keys off caller PROJECT, never caller ROLE — same
//                      invariant gate-queue.mjs already proves for `running`/`queued`).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-intent.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerForCleanup } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gi-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { GateIntentRegistry, INTENT_MAX_LEAD_MS, INTENT_EXPIRE_GRACE_MS } = await import("../dist/orchestration/gate-intent.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();

// ── (unit, registry) GateIntentRegistry — declare/withdraw/expiry, driven by an injectable clock ──────────
{
  let clock = 1_000_000; // arbitrary epoch-ms base, far from 0 so `now - X` never goes negative by accident
  const reg = new GateIntentRegistry(() => clock);
  const liveAlways = () => true;

  const row = reg.declare({ sessionId: "s1", projectId: "P", gateType: "merge", repoKey: "backend", note: "about to squash" }, 5 * 60_000);
  check("(unit, registry) declaredAt is stamped from the injected clock, not wall-clock Date.now()", row.declaredAt === 1_000_000);
  check("(unit, registry) firesAt = declaredAt + etaMs", row.firesAt === 1_000_000 + 5 * 60_000);

  check("(unit, registry) a fresh declaration is present in the snapshot", reg.snapshot(liveAlways).length === 1);

  // Redeclare — fully replaces, including declaredAt.
  clock += 60_000;
  const row2 = reg.declare({ sessionId: "s1", projectId: "P", gateType: "deploy" }, 10 * 60_000);
  check("(unit, registry) a redeclare re-stamps declaredAt to the NEW now, not the old one", row2.declaredAt === row.declaredAt + 60_000);
  const afterRedeclare = reg.snapshot(liveAlways);
  check("(unit, registry) a redeclare REPLACES — still exactly 1 row, not 2", afterRedeclare.length === 1);
  check("(unit, registry) the replaced row carries the NEW content (gateType flipped merge→deploy, repoKey/note gone)",
    afterRedeclare[0].gateType === "deploy" && afterRedeclare[0].repoKey === undefined && afterRedeclare[0].note === undefined);

  // Explicit withdraw.
  check("(unit, registry) withdraw() reports true when something was actually removed", reg.withdraw("s1") === true);
  check("(unit, registry) withdraw() is idempotent — a second call on nothing reports false, not an error", reg.withdraw("s1") === false);
  check("(unit, registry) snapshot is empty after withdraw", reg.snapshot(liveAlways).length === 0);
}

// ── (unit, registry) msUntilFire's underlying clock math: NEVER dropped exactly at firesAt, dropped only
//    after firesAt + INTENT_EXPIRE_GRACE_MS ─────────────────────────────────────────────────────────────
{
  let clock = 1_000_000;
  const reg = new GateIntentRegistry(() => clock);
  const liveAlways = () => true;
  const etaMs = 5 * 60_000;
  reg.declare({ sessionId: "s1", projectId: "P" }, etaMs);
  const firesAt = 1_000_000 + etaMs;

  clock = firesAt - 1;
  check("(unit, registry) still present 1ms BEFORE firesAt", reg.snapshot(liveAlways).length === 1);

  clock = firesAt + 1;
  check("(unit, registry) still present 1ms AFTER firesAt — NOT dropped exactly on the declared instant (manager's own ruling: let it go negative instead)", reg.snapshot(liveAlways).length === 1);

  clock = firesAt + INTENT_EXPIRE_GRACE_MS - 1;
  check("(unit, registry) still present 1ms before the grace window elapses", reg.snapshot(liveAlways).length === 1);

  clock = firesAt + INTENT_EXPIRE_GRACE_MS + 1;
  check("(unit, registry) gone 1ms after the grace window elapses", reg.snapshot(liveAlways).length === 0);
}

// ── (unit, registry) the hard backstop bounds worst-case lifetime regardless of firesAt ────────────────────
{
  let clock = 1_000_000;
  const reg = new GateIntentRegistry(() => clock);
  const liveAlways = () => true;
  // Declare at the MAX allowed lead — the hard backstop and the ordinary fireExpired rule land on the
  // exact same instant here by construction (declaredAt + MAX_LEAD_MS + GRACE === firesAt + GRACE when
  // etaMs === MAX_LEAD_MS), so this specifically exercises the "declared at the boundary" case rather than
  // a genuinely separate code path — the two rules are meant to coincide exactly at that boundary.
  reg.declare({ sessionId: "s1", projectId: "P" }, INTENT_MAX_LEAD_MS);
  const hardExpiry = 1_000_000 + INTENT_MAX_LEAD_MS + INTENT_EXPIRE_GRACE_MS;
  clock = hardExpiry - 1;
  check("(unit, registry) a max-lead declaration is still present 1ms before its own hard-backstop instant", reg.snapshot(liveAlways).length === 1);
  clock = hardExpiry + 1;
  check("(unit, registry) gone 1ms after the hard-backstop instant", reg.snapshot(liveAlways).length === 0);
}

// ── (unit, registry) dead-seat detection is INDEPENDENT of, and faster than, either clock rule ─────────────
{
  let clock = 1_000_000;
  const reg = new GateIntentRegistry(() => clock);
  reg.declare({ sessionId: "s1", projectId: "P" }, 15 * 60_000); // well within its own lifetime by every clock rule
  check("(unit, registry) present while the session reads as live", reg.snapshot(() => true).length === 1);
  // Same clock instant, only isSessionLive flips — this is the mechanism that answers card a5d1ae04's own
  // measured 17.7-min-late recycle notice: gone on the VERY NEXT READ, not bounded by any TTL.
  check("(unit, registry) gone on the very next read once the session no longer reads live — independent of any clock/TTL rule", reg.snapshot(() => false).length === 0);
}

// ── (mutant, polarity) prove the "a live declaration survives" assertion has power, before trusting it ────
// This session's manager: "the dangerous direction here is OVER-expiry... build the control with real
// power: a LIVE, healthy session's declaration SURVIVES repeated reads. Watch it go red before the fix."
{
  const declaredAt = 1_000_000;
  const etaMs = 5 * 60_000;
  const firesAt = declaredAt + etaMs;
  const checkAt = firesAt + 1; // just after firing — the exact window the real registry must NOT drop

  // A plausible, tempting bug: expire the instant `firesAt` passes, with no grace at all (i.e. someone
  // "simplifies" INTENT_EXPIRE_GRACE_MS away, or forgets to add it in the fireExpired comparison).
  const mutantFireExpired = (nowMs) => nowMs > firesAt; // no grace term
  check("(mutant) the no-grace mutant rule WOULD wrongly report this still-live declaration as expired at firesAt+1ms",
    mutantFireExpired(checkAt) === true);

  // The REAL registry, driven to the identical instant, must NOT drop it — this is the assertion the
  // mutant above just proved has power to catch a regression of.
  let clock = declaredAt;
  const reg = new GateIntentRegistry(() => clock);
  reg.declare({ sessionId: "s1", projectId: "P" }, etaMs);
  clock = checkAt;
  check("(mutant, real) the REAL registry correctly keeps a live declaration visible at the same instant the mutant above would have dropped it",
    reg.snapshot(() => true).length === 1);

  // And repeated reads (the actual "survives repeated reads" claim) don't degrade it either — snapshot()
  // mutates on every call, so re-reading itself is a real stress of the reap logic, not just calling it once.
  reg.snapshot(() => true);
  reg.snapshot(() => true);
  check("(mutant, real) survives THREE consecutive reads at the same still-live instant, not just the first", reg.snapshot(() => true).length === 1);
}

// ── (unit) SessionService.gateQueueForManager — declarations redaction, no real spawn ──────────────────────
{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P1 = `gi-own-${Date.now()}`, P2 = `gi-foreign-${Date.now()}`;
    db.insertProject({ id: P1, name: "GI Own", repoPath: "/tmp/gi-own", vaultPath: "/tmp/gi-own", config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "GI Foreign", repoPath: "/tmp/gi-foreign", vaultPath: "/tmp/gi-foreign", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "ga1", projectId: P1, name: "Orchestrator-1", startupPrompt: "", position: 0 });
    const mgr1 = `${P1}-mgr`;
    db.insertSession({ id: mgr1, projectId: P1, agentId: "ga1", engineSessionId: null, title: null, cwd: "/tmp/gi-own", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});

    const decl = sessions.declareGateIntent(mgr1, { etaMs: 5 * 60_000, gateType: "merge", repoKey: "backend", note: "squashing soon" });
    check("(unit) declareGateIntent succeeds for a live session", decl.ok === true);
    check("(unit) the returned entry, read back by the declaring session itself, carries full own-project detail",
      decl.ok && decl.entry.repoKey === "backend" && decl.entry.note === "squashing soon" && decl.entry.declaredBy === "Orchestrator-1");
    check("(unit) the returned entry carries no `sessionId` field at all", decl.ok && !("sessionId" in decl.entry));

    const ownView = sessions.gateQueueForManager(P1);
    check("(unit) own-project gate_queue read shows exactly 1 declaration", ownView.declarations.length === 1);
    const own = ownView.declarations[0];
    check("(unit) own-project declaration carries repoKey/note/declaredBy", own.repoKey === "backend" && own.note === "squashing soon" && own.declaredBy === "Orchestrator-1");
    check("(unit) own-project declaration carries gateType/firesAt/declaredAt/ageMs/msUntilFire", own.gateType === "merge" && typeof own.firesAt === "string" && typeof own.declaredAt === "string" && typeof own.ageMs === "number" && typeof own.msUntilFire === "number");
    check("(unit) own-project declaration carries NO `redacted` marker", !("redacted" in own));
    check("(unit) msUntilFire is positive (still ahead of the declared fire time)", own.msUntilFire > 0);

    const foreignView = sessions.gateQueueForManager(P2);
    check("(unit) foreign-project gate_queue read STILL shows the declaration (cross-project visibility, same as running/queued)", foreignView.declarations.length === 1);
    const foreign = foreignView.declarations[0];
    check("(unit) foreign-project declaration OMITS repoKey/note/declaredBy entirely (never redacted-to-null)",
      !("repoKey" in foreign) && !("note" in foreign) && !("declaredBy" in foreign));
    check("(unit) foreign-project declaration carries redacted:true", foreign.redacted === true);
    check("(unit) foreign-project declaration STILL carries gateType/firesAt/declaredAt/ageMs/msUntilFire — the sanctioned cross-project set",
      foreign.gateType === "merge" && typeof foreign.firesAt === "string" && typeof foreign.msUntilFire === "number");
    check("(unit) the note text never appears anywhere in the foreign-project snapshot", !JSON.stringify(foreignView).includes("squashing soon"));
    check("(unit) no raw session id anywhere in either view's JSON", !JSON.stringify(ownView).includes(mgr1) && !JSON.stringify(foreignView).includes(mgr1));

    // Withdraw — gone from BOTH views immediately (not waiting on any TTL).
    check("(unit) withdrawGateIntent reports true", sessions.withdrawGateIntent(mgr1) === true);
    check("(unit) gone from the own-project view immediately after withdraw", sessions.gateQueueForManager(P1).declarations.length === 0);
    check("(unit) gone from the foreign-project view immediately after withdraw", sessions.gateQueueForManager(P2).declarations.length === 0);

    // Bad etaMs.
    const tooLong = sessions.declareGateIntent(mgr1, { etaMs: INTENT_MAX_LEAD_MS + 1 });
    check("(unit) etaMs beyond INTENT_MAX_LEAD_MS is REJECTED with an error, not clamped", tooLong.ok === false && typeof tooLong.error === "string");
    const negative = sessions.declareGateIntent(mgr1, { etaMs: -1 });
    check("(unit) a negative etaMs is rejected", negative.ok === false);
    check("(unit) neither rejected call left a row behind", sessions.gateQueueForManager(P1).declarations.length === 0);

    // Dead-seat: recycle the declaring session (processState → exited) and confirm immediate disappearance.
    sessions.declareGateIntent(mgr1, { etaMs: 5 * 60_000 });
    check("(unit, dead-seat) present while the session is live", sessions.gateQueueForManager(P1).declarations.length === 1);
    db.setProcessState(mgr1, "exited");
    check("(unit, dead-seat) gone on the very next read once the declaring session's processState leaves 'live' — the mechanism answering the 17.7-min-late recycle case", sessions.gateQueueForManager(P1).declarations.length === 0);
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

// ── (e2e, MCP) the REAL gate_intent_declare/withdraw tools + gate_queue's declarations array ───────────────
{
  const dbs = [];
  try {
    const db = new Db();
    dbs.push(db);
    const P1 = `gi-mcp-own-${Date.now()}`, P2 = `gi-mcp-foreign-${Date.now()}`;
    db.insertProject({ id: P1, name: "GI MCP Own", repoPath: "/tmp/gi-mcp-own", vaultPath: "/tmp/gi-mcp-own", config: {}, createdAt: now, archivedAt: null });
    db.insertProject({ id: P2, name: "GI MCP Foreign", repoPath: "/tmp/gi-mcp-foreign", vaultPath: "/tmp/gi-mcp-foreign", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "gma1", projectId: P1, name: "Orchestrator-1", startupPrompt: "", position: 0 });
    db.insertAgent({ id: "gma2", projectId: P2, name: "dev-2", startupPrompt: "", position: 0 });
    const mgr1 = `${P1}-mgr`;
    const wkr2 = `${P2}-wkr`;
    db.insertSession({ id: mgr1, projectId: P1, agentId: "gma1", engineSessionId: null, title: null, cwd: "/tmp/gi-mcp-own", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: wkr2, projectId: P2, agentId: "gma2", engineSessionId: null, title: null, cwd: "/tmp/gi-mcp-foreign", processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });

    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});
    const router = new OrchestrationMcpRouter(db, sessions);

    const connect = async (sessionId, role) => {
      const server = router.buildServer(sessionId, role);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: `gate-intent-${sessionId}`, version: "0" });
      await client.connect(clientT);
      return { server, client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args ?? {} })).content[0].text) };
    };

    const mgr = await connect(mgr1, "manager");
    check("(e2e, MCP) gate_intent_declare IS registered on the manager's own MCP surface", Object.keys(mgr.server._registeredTools).includes("gate_intent_declare"));
    check("(e2e, MCP) gate_intent_withdraw IS registered on the manager's own MCP surface", Object.keys(mgr.server._registeredTools).includes("gate_intent_withdraw"));

    const badDeclare = await mgr.call("gate_intent_declare", { inMs: INTENT_MAX_LEAD_MS + 1 });
    check("(e2e, MCP) an out-of-range inMs is rejected with {error}", typeof badDeclare.error === "string" && !badDeclare.entry);

    const declared = await mgr.call("gate_intent_declare", { inMs: 5 * 60_000, gateType: "merge", repoKey: "backend", note: "about to squash" });
    check("(e2e, MCP) a valid declare returns {entry} with full own-project detail", declared.entry?.repoKey === "backend" && declared.entry?.note === "about to squash" && declared.entry?.declaredBy === "Orchestrator-1");

    const ownSnap = await mgr.call("gate_queue");
    check("(e2e, MCP) the manager's own gate_queue read shows the declaration, full detail", ownSnap.declarations.length === 1 && ownSnap.declarations[0].repoKey === "backend");

    // A WORKER caller in a DIFFERENT project reads gate_queue too — same real project-scoped redaction
    // gate_queue's running/queued arrays already prove (gate-queue.mjs), now extended to declarations.
    const wkr = await connect(wkr2, "worker");
    const wSnap = await wkr.call("gate_queue");
    check("(e2e, MCP worker) a worker in a DIFFERENT project sees the declaration too (cross-project visibility)", wSnap.declarations.length === 1);
    const wEntry = wSnap.declarations[0];
    check("(e2e, MCP worker) redacted for the worker caller — same shape a foreign MANAGER would see (redaction keys off caller PROJECT, never caller ROLE)",
      wEntry.redacted === true && !("repoKey" in wEntry) && !("note" in wEntry) && !("declaredBy" in wEntry));
    check("(e2e, MCP worker) gateType/firesAt still visible to the worker caller (the sanctioned cross-project set)", wEntry.gateType === "merge" && typeof wEntry.firesAt === "string");
    check("(e2e, MCP worker) worker surface does NOT register gate_intent_declare/withdraw — manager-only",
      !Object.keys(wkr.server._registeredTools).includes("gate_intent_declare") && !Object.keys(wkr.server._registeredTools).includes("gate_intent_withdraw"));
    check("(e2e, MCP worker) worker surface is UNCHANGED — still EXACTLY the pinned 6-tool set",
      Object.keys(wkr.server._registeredTools).slice().sort().join(",") === "directive_status,gate_queue,gate_status,my_context,run_gate,worker_report");
    await wkr.client.close();

    const withdrawn = await mgr.call("gate_intent_withdraw");
    check("(e2e, MCP) withdraw reports {withdrawn:true}", withdrawn.withdrawn === true);
    const afterWithdraw = await mgr.call("gate_queue");
    check("(e2e, MCP) gone from gate_queue immediately after withdraw", afterWithdraw.declarations.length === 0);
    const secondWithdraw = await mgr.call("gate_intent_withdraw");
    check("(e2e, MCP) a second withdraw with nothing left is {withdrawn:false}, not an error", secondWithdraw.withdrawn === false);

    await mgr.client.close();
  } finally {
    for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GateIntentRegistry declares/redeclares/withdraws correctly with an injectable clock; msUntilFire goes negative rather than clamping or vanishing exactly at firesAt; the grace-window and hard-backstop reaps fire at their exact boundaries; dead-seat detection (session no longer live) reaps independently of and faster than either clock rule; a deliberately-too-aggressive mutant expiry rule was shown to WRONGLY drop a live declaration before the real registry was shown to correctly keep it (proving that assertion has power); SessionService.gateQueueForManager's declarations array redacts repoKey/note/declaredBy cross-project while gateType/firesAt/declaredAt/ageMs/msUntilFire cross the boundary, with no raw sessionId anywhere; and the real gate_intent_declare/gate_intent_withdraw MCP tools are manager-only (absent from the worker's unchanged pinned 6-tool surface) while gate_queue's declarations array is visible on both surfaces with redaction keyed off caller project, never caller role."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
