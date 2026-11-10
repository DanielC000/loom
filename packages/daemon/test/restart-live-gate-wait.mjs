import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2bbc0412 — `requestDaemonRestart` never silently orphans a live (non-advisory) gate/merge op:
//   (A) a worker gate admitted before the restart's exit: the restart WAITS for it (bounded), the op settles
//       normally (never orphaned), the owning manager of the OTHER project gets exactly one
//       `[loom:restart-pending]` nudge (the requester's own project gets none), and a NEW worker run_gate
//       attempted during the wait is refused by the latch — recorded nowhere (no lastWorkerGateCheck, no
//       worker_gate event, no pendingOps entry).
//   (B) an op that never settles: after the bound the restart REFUSES with the opId, no exit, no intent left
//       behind, latch released (a later run_gate is not latch-refused).
//   (C) an op that appears AFTER the wait (at the final supervisor recheck): refused at the final recheck,
//       intent cleared.
//   (D) `liveRealWorkOps()` ignores an advisory dist-importer entry and counts a real one (same read as
//       gate_queue's restartSafe).
//   (E) override `proceedDespiteLiveOps`: no wait, exits, opIds recorded in the result AND the intent (with the
//       reason), a `[loom:restart-orphaning]` nudge to EVERY owner (requester's project included) before exit.
//   (F) an empty override reason is refused outright; (G) an override from an overlapping call interrupts an
//       already-waiting attempt.
// Run: 1) build (pnpm build), 2) node test/restart-live-gate-wait.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil, deferred } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `lm-rlgw-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();
process.env.LOOM_SUPERVISED = "1"; // requestDaemonRestart refuses outright when unsupervised

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const restart = await import("../dist/orchestration/restart.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const sfx = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const DIR = path.join(os.tmpdir(), `lm-rlgw-dir-${sfx}`);
registerForCleanup(DIR);
fs.mkdirSync(DIR, { recursive: true });

const db = new Db(path.join(os.tmpdir(), `lm-rlgw-db-${sfx}.db`));
const ids = { p1: `rlgw-p1-${sfx}`, p2: `rlgw-p2-${sfx}`, a1: `rlgw-a1-${sfx}`, a2: `rlgw-a2-${sfx}`, m1: `rlgw-m1-${sfx}`, m2: `rlgw-m2-${sfx}`, w2: `rlgw-w2-${sfx}`, w3: `rlgw-w3-${sfx}`, w4: `rlgw-w4-${sfx}` };
for (const [p, a] of [[ids.p1, ids.a1], [ids.p2, ids.a2]]) {
  db.insertProject({ id: p, name: p, repoPath: DIR, vaultPath: DIR, config: { orchestration: { gateCommand: "node -e 0" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: a, projectId: p, name: "t", startupPrompt: "", position: 0 });
}
const session = (id, projectId, agentId, role, parentSessionId = null) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: DIR, processState: "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId, ...(role === "worker" ? { worktreePath: DIR } : {}),
});
session(ids.m1, ids.p1, ids.a1, "manager");
session(ids.m2, ids.p2, ids.a2, "manager");
session(ids.w2, ids.p2, ids.a2, "worker", ids.m2);
session(ids.w3, ids.p2, ids.a2, "worker", ids.m2);
session(ids.w4, ids.p2, ids.a2, "worker", ids.m2);

const sessions = new SessionService(db, {
  stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; },
  getPersistablePendingSnapshot: () => ({ texts: [], holds: {}, mintedAt: {} }), isComposerDirty: () => false,
}, new OrchestrationControl(), { runGate: async () => ({ passed: true, steps: [] }) });
const nudges = [];
sessions.enqueueDurableNudge = (id, role, text) => { nudges.push({ id, role, text, at: Date.now() }); };
const nudgesTo = (id, tag) => nudges.filter((n) => n.id === id && n.text.startsWith(tag));

const mkExit = () => { const calls = []; return { calls, fn: (c) => calls.push(c) }; };
const restartDeps = (exit, extra = {}) => ({
  buildDeps: { runStep: async () => ({ code: 0, out: "" }) },
  exit: exit.fn, isSupervisorAlive: async () => ({ alive: true }),
  armHardShutdownWatchdog: () => ({ step() {}, disarm() {} }), mergeDangerGraceMs: 50, advisoryPreemptVerifyMs: 500,
  liveWorkPollMs: 20, ...extra,
});
/** A pendingOps entry of `kind` that stays running until `d` resolves; returns the settle promise + minted opId. */
const liveOp = (key, kind, owner, d) => {
  // waitMs 0: attach() returns a "pending" view at once; `finished` flips only when the op's own closure completes.
  const st = { finished: false, result: null };
  st.attached = sessions.pendingOps.attach(key, kind, owner, 0, async () => { await d.promise; st.finished = true; return "done"; }, undefined, {}, undefined);
  return st;
};
const opIdOf = (key) => sessions.pendingOps.peek(key)?.opId;
/** waitUntil, but a timeout first prints a FAIL line (so a regression reads as a failed assertion, not a bare crash). */
const mustSee = async (label, cond) => {
  try { await waitUntil(cond, { label, timeoutMs: 5000 }); } catch (e) { check(label, false); throw e; }
  check(label, true);
};
const reset = () => { restart.clearRestartIntent(); nudges.length = 0; auditBaseline = db.listEventsSince(0, 1_000_000).length; };
let auditBaseline = 0;
/** restart_orphaned_ops rows written since the last reset(). */
const orphanRows = () => db.listEventsSince(0, 1_000_000).slice(auditBaseline).filter((e) => e.kind === "restart_orphaned_ops");

try {
  // ── (A) wait for a live worker gate; latch refuses a NEW run_gate; owner of the OTHER project nudged once ──
  {
    reset();
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const gateOpId = opIdOf(`gate:${ids.w2}`);
    check("(A-pre) the fixture gate op is live and counted by liveRealWorkOps", sessions.liveRealWorkOps().some((o) => o.opId === gateOpId && o.projectId === ids.p2));
    const exit = mkExit();
    let resolved = false;
    const p = sessions.requestDaemonRestart(ids.m1, "deploy A", restartDeps(exit, { liveWorkWaitMs: 20_000 })).then((r) => { resolved = true; return r; });
    await mustSee("(A) the other project's manager was told the restart is waiting", () => nudgesTo(ids.m2, "[loom:restart-pending]").length === 1);
    check("(A) restart is WAITING: not resolved, no exit, no intent written yet", !resolved && exit.calls.length === 0 && restart.readRestartIntent() === null);
    check("(A) the nudge names the live opId and the requester's own project got none", nudgesTo(ids.m2, "[loom:restart-pending]")[0].text.includes(gateOpId) && nudges.filter((n) => n.id === ids.m1).length === 0);
    // The latch: a NEW worker run_gate (w3, no op of its own) is refused before anything is minted.
    let refused = null;
    try { await sessions.runWorkerGate(ids.w3); } catch (e) { refused = e; }
    check("(A) a NEW run_gate during the wait is refused with 'retry in ~1 min'", refused instanceof Error && /Retry in ~1 min/.test(refused.message) && /NOT a gate verdict/.test(refused.message));
    check("(A) the latch refusal minted no op, no lastWorkerGateCheck, no worker_gate event",
      sessions.pendingOps.peek(`gate:${ids.w3}`) === undefined && !sessions.lastWorkerGateCheck.has(ids.w3) && db.listEventsForWorker(ids.w3).filter((e) => e.kind === "worker_gate").length === 0);
    check("(A) the already-running op is still counted (latch did not touch it)", sessions.pendingOps.peek(`gate:${ids.w2}`)?.state === "running");
    check("(A) the gate op has NOT finished while the restart waits", gate.finished === false);
    d.resolve();
    const r = await p;
    check("(A) after the gate settled, the restart proceeded", r.restarting === true && r.liveOpsWait?.settledBeforeExit === true && r.liveOpsWait.initial === 1 && r.orphanedOps === undefined);
    check("(A) the op ran to completion before the restart exited — never orphaned", gate.finished === true && exit.calls.length === 0);
    await waitUntil(() => exit.calls.length === 1, { label: "(A) exit(75) captured" });
    check("(A) exit code is the restart sentinel", exit.calls[0] === restart.RESTART_EXIT_CODE);
    check("(A) exactly ONE restart-pending nudge in total, and no orphaning nudge", nudgesTo(ids.m2, "[loom:restart-pending]").length === 1 && nudges.every((n) => !n.text.startsWith("[loom:restart-orphaning]")));
    check("(A) latch is released after the exit callback (no leak into the next call)", sessions.restartAdmissionLatch === false);
    reset();
  }

  // ── (B) bounded wait then REFUSE ──────────────────────────────────────────────────────────────────────
  {
    reset();
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const gateOpId = opIdOf(`gate:${ids.w2}`);
    const exit = mkExit();
    const t0 = Date.now();
    const r = await sessions.requestDaemonRestart(ids.m1, "deploy B", restartDeps(exit, { liveWorkWaitMs: 300 }));
    check("(B) refused after the bound: restarting:false naming the opId", r.restarting === false && r.liveOpsRefused?.[0]?.opId === gateOpId && r.error.includes(gateOpId) && /proceedDespiteLiveOps/.test(r.error));
    check("(B) it really waited ~the bound (>=250ms) rather than refusing instantly", (r.liveOpsWait?.waitedMs ?? 0) >= 250 && Date.now() - t0 >= 250 && r.liveOpsWait.settledBeforeExit === false);
    check("(B) no exit scheduled, no intent left behind, latch released", exit.calls.length === 0 && restart.readRestartIntent() === null && sessions.restartAdmissionLatch === false);
    // Control: with the latch released, run_gate is not refused by the latch any more (whatever else it does).
    let afterErr = null;
    try { await sessions.runWorkerGate(ids.w3); } catch (e) { afterErr = e; }
    check("(B) control: after the refusal run_gate is no longer latch-refused", !(afterErr instanceof Error && /restart is pending/.test(afterErr.message)));
    d.resolve();
    await waitUntil(() => gate.finished && sessions.pendingOps.peek(`gate:${ids.w2}`)?.state !== "running", { label: "(B) the fixture gate settled" });
    // Positive control for (B): the very same call with the op gone proceeds.
    const exit2 = mkExit();
    const r2 = await sessions.requestDaemonRestart(ids.m1, "deploy B2", restartDeps(exit2, { liveWorkWaitMs: 300 }));
    check("(B) control: once the op settled the same restart proceeds immediately", r2.restarting === true && r2.liveOpsWait === undefined);
    await waitUntil(() => exit2.calls.length === 1, { label: "(B) exit2 captured" });
    reset();
  }

  // ── (C) an op appearing after the wait is caught by the FINAL synchronous recheck ─────────────────────
  {
    reset();
    const d = deferred();
    let calls = 0; let lateOp = null; let lateOpId = null;
    const exit = mkExit();
    const r = await sessions.requestDaemonRestart(ids.m1, "deploy C", restartDeps(exit, {
      isSupervisorAlive: async () => {
        if (++calls === 2) { lateOp = liveOp(`merge:late-${sfx}`, "merge", ids.m2, d); lateOpId = opIdOf(`merge:late-${sfx}`); }
        return { alive: true };
      },
    }));
    check("(C) refused at the final recheck, naming the late op", r.restarting === false && r.liveOpsRefused?.[0]?.opId === lateOpId && /immediately before exiting/.test(r.error));
    check("(C) intent cleared, no exit, latch released", restart.readRestartIntent() === null && exit.calls.length === 0 && sessions.restartAdmissionLatch === false);
    d.resolve(); await lateOp;
    reset();
  }

  // ── (D) liveRealWorkOps vs an advisory entry ──────────────────────────────────────────────────────────
  {
    const cap = sessions.gateQueueForManager(ids.p1).cap;
    const hold = (extra) => { const d = deferred(); const started = deferred();
      const run = sessions.gateSemaphore.runExclusive(cap, { gateType: "worker", projectId: ids.p1, sessionId: ids.m1, taskId: null, branch: null, opId: `rlgw-sem-${Math.random().toString(36).slice(2, 7)}`, ...extra }, async () => { started.resolve(); await d.promise; return "ok"; }, "high").catch(() => "x");
      return { release: () => d.resolve(), run, started }; };
    const adv = hold({ distImporterCheckOnly: true, advisoryRepoPath: DIR });
    await adv.started.promise;
    check("(D) an advisory dist-importer entry is NOT live real work", sessions.liveRealWorkOps().length === 0 && sessions.gateQueueForManager(ids.p1).restartSafe === true);
    adv.release(); await adv.run;
    const real = hold({});
    await real.started.promise;
    check("(D) control: a non-advisory semaphore entry IS live real work (and flips restartSafe)", sessions.liveRealWorkOps().length === 1 && sessions.gateQueueForManager(ids.p1).restartSafe === false);
    real.release(); await real.run;
  }

  // ── (E) override: no wait, orphans recorded, EVERY owner nudged before the exit ───────────────────────
  {
    reset();
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const own = liveOp(`merge:own-${sfx}`, "merge", ids.m1, d);
    const g1 = opIdOf(`gate:${ids.w2}`); const g2 = opIdOf(`merge:own-${sfx}`);
    const exit = mkExit();
    const r = await sessions.requestDaemonRestart(ids.m1, "urgent deploy", restartDeps(exit, { liveWorkWaitMs: 20_000, proceedDespiteLiveOps: "owner-approved urgent fix" }));
    check("(E) override: restarts immediately, no live-op wait recorded", r.restarting === true && r.liveOpsWait === undefined);
    check("(E) the result names exactly the orphaned opIds", JSON.stringify((r.orphanedOps ?? []).map((o) => o.opId).sort()) === JSON.stringify([g1, g2].sort()));
    const intent = restart.readRestartIntent();
    check("(E) the restart intent records the orphaned opIds and the reason", intent?.orphanedOps?.reason === "owner-approved urgent fix" && JSON.stringify(intent.orphanedOps.ops.map((o) => o.opId).sort()) === JSON.stringify([g1, g2].sort()));
    check("(E) BOTH owners (other project's manager via its worker, AND the requester's own) got one restart-orphaning nudge naming their opId",
      nudgesTo(ids.m2, "[loom:restart-orphaning]").length === 1 && nudgesTo(ids.m2, "[loom:restart-orphaning]")[0].text.includes(g1)
      && nudgesTo(ids.m1, "[loom:restart-orphaning]").length === 1 && nudgesTo(ids.m1, "[loom:restart-orphaning]")[0].text.includes(g2));
    check("(E) the nudges went out BEFORE the exit callback fired", exit.calls.length === 0);
    check("(E) no restart-pending nudge on the override path (it never waited)", nudges.every((n) => !n.text.startsWith("[loom:restart-pending]")));
    // Audit trail (round 2): one durable row per affected project, written synchronously before the exit.
    const rows = orphanRows();
    const rowP1 = rows.find((e) => e.detail?.projectId === ids.p1); const rowP2 = rows.find((e) => e.detail?.projectId === ids.p2);
    check("(E) exactly one restart_orphaned_ops row per affected project (p1: own merge, p2: worker gate)", rows.length === 2 && !!rowP1 && !!rowP2);
    check("(E) each row carries the overriding session id, the reason and ONLY its project's opIds",
      rowP1?.detail.overridingSessionId === ids.m1 && rowP1.detail.reason === "owner-approved urgent fix" && JSON.stringify(rowP1.detail.opIds) === JSON.stringify([g2])
      && rowP2?.detail.overridingSessionId === ids.m1 && JSON.stringify(rowP2.detail.opIds) === JSON.stringify([g1]));
    check("(E) the rows were written before the exit callback fired", exit.calls.length === 0);
    await waitUntil(() => exit.calls.length === 1, { label: "(E) exit captured" });
    d.resolve(); await gate; await own;
    reset();
  }

  // ── (F) empty override reason refused ─────────────────────────────────────────────────────────────────
  {
    reset();
    const exit = mkExit();
    const r = await sessions.requestDaemonRestart(ids.m1, "x", restartDeps(exit, { proceedDespiteLiveOps: "   " }));
    check("(F) an empty/blank override reason is refused, nothing restarted", r.restarting === false && /non-empty reason/.test(r.error) && exit.calls.length === 0 && restart.readRestartIntent() === null);
  }

  // ── (G) an overlapping override call interrupts a waiting attempt ─────────────────────────────────────
  {
    reset();
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const g1 = opIdOf(`gate:${ids.w2}`);
    const exit = mkExit();
    const p1 = sessions.requestDaemonRestart(ids.m1, "deploy G", restartDeps(exit, { liveWorkWaitMs: 60_000 }));
    await mustSee("(G) first attempt is waiting (other project's manager told)", () => nudgesTo(ids.m2, "[loom:restart-pending]").length === 1);
    // The ATTACHED caller is a DIFFERENT session (m2): the audit row must name it, not the first caller (m1).
    const p2 = sessions.requestDaemonRestart(ids.m2, "deploy G override", restartDeps(exit, { proceedDespiteLiveOps: "stuck behind a 3h gate" }));
    const [r1, r2] = await Promise.all([p1, p2]);
    const gRows = orphanRows();
    check("(G) the audit row names the OVERRIDING (attached) caller and its reason, not the first caller",
      gRows.length === 1 && gRows[0].detail.overridingSessionId === ids.m2 && gRows[0].managerSessionId === ids.m2
      && gRows[0].detail.reason === "stuck behind a 3h gate" && gRows[0].detail.projectId === ids.p2 && JSON.stringify(gRows[0].detail.opIds) === JSON.stringify([g1]));
    check("(G) the waiting attempt switched to the override path and both callers share its result", r1 === r2 && r1.restarting === true && r1.orphanedOps?.[0]?.opId === g1);
    check("(G) the overridden op's owner got the orphaning nudge", nudgesTo(ids.m2, "[loom:restart-orphaning]").length === 1);
    await waitUntil(() => exit.calls.length === 1, { label: "(G) exit captured" });
    d.resolve(); await gate;
    reset();
  }

  // ── (H) latch + a RETAINED settled verdict: it passes through (the worker whose gate settled mid-wait still gets it) ──
  {
    reset();
    const usable = (v) => v.ran === true && typeof v.passed === "boolean" && v.headCurrent === true;
    await sessions.pendingOps.attach(`gate:${ids.w3}`, "gate", ids.w3, 2000, async () => ({ ran: true, passed: true, headCurrent: true, steps: [] }), undefined,
      { retainMs: 60_000, classifyOutcome: () => "passed", isRetainedResultUsable: usable }, undefined);
    check("(H-pre) the fixture left a retained, non-running verdict for w3", sessions.pendingOps.peek(`gate:${ids.w3}`)?.state !== "running" && sessions.pendingOps.peek(`gate:${ids.w3}`) !== undefined);
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const exit = mkExit();
    const p = sessions.requestDaemonRestart(ids.m1, "deploy H", restartDeps(exit, { liveWorkWaitMs: 20_000 }));
    await mustSee("(H) restart is waiting (latch closed)", () => sessions.restartAdmissionLatch === true);
    let err = null; let res = null;
    try { res = await sessions.runWorkerGate(ids.w3); } catch (e) { err = e; }
    check("(H) w3's retained verdict is served through the closed latch (no latch refusal)", err === null && res?.settled === true && res.ok === true && res.value.passed === true);
    // Negative control: a worker with NO retained verdict and no running op is still refused, with the corrected wording.
    let err2 = null;
    try { await sessions.runWorkerGate(ids.w4); } catch (e) { err2 = e; }
    check("(H) control: with no retained verdict, a NEW gate is refused, wording says no NEW gate is started and a just-finished result was sent",
      err2 === null ? false : /no NEW gate is started/.test(err2.message) && /result was sent to you/.test(err2.message));
    d.resolve(); await gate; await p;
    await waitUntil(() => exit.calls.length === 1, { label: "(H) exit captured" });
    reset();
  }

  // ── (I) the catch-all releases the latch; a build failure never closes it ─────────────────────────────
  {
    reset();
    const d = deferred();
    const gate = liveOp(`gate:${ids.w2}`, "gate", ids.w2, d);
    const realNotify = sessions.notifyLiveOpOwners;
    sessions.notifyLiveOpOwners = () => { throw new Error("boom-in-wait"); };
    const exit = mkExit();
    const origErr = console.error; console.error = () => {};
    let r;
    try { r = await sessions.requestDaemonRestart(ids.m1, "deploy I", restartDeps(exit, { liveWorkWaitMs: 20_000 })); } finally { console.error = origErr; sessions.notifyLiveOpOwners = realNotify; }
    check("(I) an exception inside the wait degrades to restarting:false (catch-all)", r.restarting === false && /failed unexpectedly/.test(r.error) && /boom-in-wait/.test(r.error) && exit.calls.length === 0);
    check("(I) the catch-all RELEASED the latch and left no intent / in-flight lock", sessions.restartAdmissionLatch === false && restart.readRestartIntent() === null && sessions.inFlightRestart === null);
    d.resolve(); await gate;
    reset();
    const exitB = mkExit();
    const rb = await sessions.requestDaemonRestart(ids.m1, "deploy I2", restartDeps(exitB, { buildDeps: { runStep: async () => ({ code: 1, out: "boom" }) } }));
    check("(I) a build failure refuses and the latch stays OPEN (never closed, never leaked)", rb.restarting === false && /daemon build failed/.test(rb.error) && sessions.restartAdmissionLatch === false && exitB.calls.length === 0 && sessions.inFlightRestart === null);
  }

  // ── (J) proceedReason is bounded (service-side) and both MCP schemas carry the same bound ─────────────
  {
    reset();
    const max = SessionService.PROCEED_REASON_MAX;
    const exit = mkExit();
    const tooLong = await sessions.requestDaemonRestart(ids.m1, "x", restartDeps(exit, { proceedDespiteLiveOps: "x".repeat(max + 1) }));
    check("(J) an over-long override reason is refused, nothing restarted", tooLong.restarting === false && /too long/.test(tooLong.error) && exit.calls.length === 0 && restart.readRestartIntent() === null && sessions.restartAdmissionLatch === false);
    const ok = await sessions.requestDaemonRestart(ids.m1, "x", restartDeps(exit, { proceedDespiteLiveOps: "x".repeat(max) }));
    check("(J) control: a reason of exactly the max is accepted", ok.restarting === true);
    await waitUntil(() => exit.calls.length === 1, { label: "(J) exit captured" });
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    for (const f of ["orchestration.ts", "platform.ts"]) {
      const src = fs.readFileSync(path.join(here, "..", "src", "mcp", f), "utf8");
      check(`(J) ${f}'s proceedReason schema is bounded at ${max}`, new RegExp(`proceedReason: z\\.string\\(\\)\\.max\\(${max}\\)`).test(src));
    }
    reset();
  }
} finally {
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS -- a restart waits (bounded) for live gate/merge ops, refuses with their opIds rather than orphaning them, closes the run_gate door meanwhile without recording a verdict, notifies other projects' owners, and the explicit override records + announces what it orphans."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
