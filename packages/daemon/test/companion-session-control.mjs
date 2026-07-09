import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `session_message`/`session_steer`/`session_stop`/
// `session_resume`, the `session-steer` ACT lever (card 305a54fb). The LAST + HIGHEST-injection-risk
// lever in the sensitive companion tranche: it ORIGINATES privileged session-lifecycle actions, fully
// friction-free (decision 71509fd5 — NO Primitive C propose/confirm round-trip, unlike decision_resolve/
// board_create/board_update). The residual safety model is Primitive A (owner-turn-only) + scope +
// optional roleFilter — checked on EVERY call, including stop/resume.
//
// Fully hermetic, but "run-shaped": unlike companion-board-write.mjs (whose writes land on the SAME db
// the test already owns), this lever drives ANOTHER session's real lifecycle — so this test wires a REAL
// `SessionService` (not a bare `{}` stub) behind a contract-faithful PtyStub (mirrors redirect-worker.mjs's
// own stub, extended with stop/isAlive/spawn) so message/steer/stop/resume are exercised through the ACTUAL
// scoped rails (SessionService.messageSessionAsCompanion/redirectSessionAsCompanion/stopSession/resume),
// not just mocked guard-passes. `resume()` needs a real-looking engine transcript file to pass its
// existence check — this test plants one under a SANDBOXED HOME (process.env.HOME/USERPROFILE), exactly
// like `engineTranscriptExists` (sessions/transcript.ts) resolves it via `os.homedir()`.
//
// Covers the card's DoD:
//   - message/steer/stop/resume each act on a session in a granted act-mode project, via the REAL rail
//   - target in a read-only-granted project rejects (mayAct false), for all four tools
//   - target in an ungranted project rejects, for all four tools
//   - proactive-turn (Primitive A null — no owner text) rejects ALL FOUR tools
//   - roleFilter restricts when configured; default (absent/empty) admits every role
//   - the [loom:from-owner-via-companion] / [loom:from-owner-via-companion:redirect] framing tag is
//     present on delivered message/steer text
//   - read-only/absent grant → all four tools unregistered (byte-identical spawn)
//   - NO Primitive C: a first call to any ACT tool commits immediately (no {status:'proposed'})
// Run: 1) build (turbo builds shared first), 2) node test/companion-session-control.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import;
// sessions/transcript.ts's engineTranscriptExists resolves os.homedir() at CALL time via HOME/USERPROFILE,
// so the sandbox must be in place before any resume() call, not just before import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-session-control-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-session-control-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

// A contract-faithful PtyStub — mirrors redirect-worker.mjs's own stub (enqueueStdin/flushPending/
// interruptForRedirect semantics), extended with stop/isAlive/spawn so SessionService.stopSession/resume
// drive REAL observable state, and getActiveTurnOwnerText/getActiveTurnOrigin so it ALSO serves as the
// router's `pty` (the companion's OWN turn-attestation read) — one shared PtyHost stands in for both
// roles here exactly as one real PtyHost does in production.
class PtyStub {
  constructor() {
    this.q = new Map(); this.live = new Set(); this.busy = new Set();
    this.interrupts = []; this.delivered = []; this.stops = []; this.spawns = [];
    this.ownerText = null;
  }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  setOwnerText(t) { this.ownerText = t; }
  getActiveTurnOwnerText() { return this.ownerText; }
  getActiveTurnOrigin() { return null; } // this lever never uses a route (no Primitive C)
  enqueueStdin(id, text, _source = "system", onDeliver) {
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead" };
    if (!this.busy.has(id)) { this.delivered.push({ id, text }); return { delivered: true }; }
    const a = this.q.get(id) ?? []; a.push({ id: `qm-${a.length}`, text, source: _source, onDeliver }); this.q.set(id, a);
    return { delivered: false, position: a.length };
  }
  flushPending(id) { const a = this.q.get(id) ?? []; this.q.set(id, []); return a; }
  interruptForRedirect(id) {
    this.interrupts.push(id);
    const a = this.q.get(id) ?? [];
    for (const m of a) { this.delivered.push({ id, text: m.text }); if (m.onDeliver) m.onDeliver(); }
    this.q.set(id, []);
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  isAlive(id) { return this.live.has(id); }
  stop(id, mode) { this.stops.push({ id, mode }); this.live.delete(id); this.busy.delete(id); }
  spawn(opts) { this.spawns.push(opts); this.live.add(opts.sessionId); }
}

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role ?? "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: opts.engineSessionId ?? `eng-${id}`, title: null,
    cwd: opts.cwd ?? os.tmpdir(), processState: opts.processState ?? "live", resumability: opts.resumability ?? "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: role ?? null,
    recycledFrom: opts.recycledFrom ?? null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

/** Plants a fake engine transcript file where sessions/transcript.ts's engineTranscriptExists looks for
 *  it (under the SANDBOXED $HOME/.claude/projects/<encoded-cwd>/<engineSessionId>.jsonl), so resume()'s
 *  existence check passes without a real claude process. */
function plantEngineTranscript(cwd, engineSessionId) {
  const dir = path.join(sandboxHome, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${engineSessionId}.jsonl`), "");
}

function setup(companionSess, proj, opts = {}) {
  const db = tmpDb();
  seedProject(db, proj, proj);
  seedSession(db, companionSess, proj, "assistant");
  const pty = new PtyStub();
  pty.setLive(companionSess);
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const orch = new OrchestrationMcpRouter(db, sessions, {}, pty);
  return { db, pty, sessions, orch };
}

try {
  // ============ registration gating: read-only / absent / act-mode ============
  {
    const proj = `proj-reg-${randomUUID()}`;
    const companionSess = `companion-reg-${randomUUID()}`;
    const { db, orch } = setup(companionSess, proj);
    const noGrantTools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("no grant at all: session control tools are NOT registered", !["session_message", "session_steer", "session_stop", "session_resume"].some((t) => noGrantTools.includes(t)));

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "read" });
    const readOnlyTools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("read-only grant: session control tools are NOT registered", !["session_message", "session_steer", "session_stop", "session_resume"].some((t) => readOnlyTools.includes(t)));

    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    const actTools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("act-mode grant: all four session control tools ARE registered", ["session_message", "session_steer", "session_stop", "session_resume"].every((t) => actTools.includes(t)));
    db.close();
  }

  // ============ session_message: delivered-live on a live idle target (REAL rail) ============
  {
    const proj = `proj-msg-live-${randomUUID()}`;
    const companionSess = `companion-msg-live-${randomUUID()}`;
    const target = `target-msg-live-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "manager");
    pty.setLive(target); // idle
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: tell the manager to hold off on the deploy");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "session_message", { target, message: "hold off on the deploy" });
    check("session_message (live idle): deliveryStatus is delivered-live", res.deliveryStatus === "delivered-live");
    check("session_message: delivered via the REAL pty rail, framed [loom:from-owner-via-companion]", pty.delivered.some((d) => d.id === target && d.text.startsWith("[loom:from-owner-via-companion]") && d.text.includes("hold off on the deploy")));
    check("session_message: NO Primitive C — commits on the FIRST call (no status:'proposed')", res.status === undefined);

    await client.close();
    db.close();
  }

  // ============ session_message: queued on a BUSY target, boarded on a NOT-LIVE target ============
  {
    const proj = `proj-msg-busy-${randomUUID()}`;
    const companionSess = `companion-msg-busy-${randomUUID()}`;
    const busyTarget = `target-msg-busy-${randomUUID()}`;
    const deadTarget = `target-msg-dead-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, busyTarget, proj, "worker");
    seedSession(db, deadTarget, proj, "worker", { processState: "exited" });
    pty.setLive(busyTarget); pty.setBusy(busyTarget);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: check in with both workers");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const busyRes = await call(client, "session_message", { target: busyTarget, message: "status please" });
    check("session_message (busy): deliveryStatus is queued", busyRes.deliveryStatus === "queued");
    check("session_message (busy): held FIFO on the real pty queue, framed", pty.getPending(busyTarget).some((t) => t.startsWith("[loom:from-owner-via-companion]") && t.includes("status please")));

    const deadRes = await call(client, "session_message", { target: deadTarget, message: "status please" });
    check("session_message (not-live, no successor): deliveryStatus is boarded", deadRes.deliveryStatus === "boarded" && typeof deadRes.taskId === "string");
    const boarded = db.getTask(deadRes.taskId);
    check("session_message (boarded): the card landed on the TARGET's own project board", boarded && boarded.projectId === proj);
    check("session_message (boarded): the card body names the owner-via-companion origin", boarded.body.includes("owner") && boarded.body.includes("companion"));

    await client.close();
    db.close();
  }

  // ============ session_steer: busy target — flush+supersede, interrupt fires, lands framed ============
  {
    const proj = `proj-steer-busy-${randomUUID()}`;
    const companionSess = `companion-steer-busy-${randomUUID()}`;
    const target = `target-steer-busy-${randomUUID()}`;
    const { db, pty, sessions, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "worker");
    pty.setLive(target); pty.setBusy(target);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });

    // Pre-load a queued (durable) message that the steer will supersede.
    const pre = sessions.messageSessionAsCompanion(target, "OLD — keep going on the current plan", companionSess);
    check("(steer setup) old direction is HELD (busy target) + persisted", pre.deliveryStatus === "queued");
    check("(steer setup) an undelivered durable message exists before the steer", db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("OLD")));

    pty.setOwnerText("the owner said: stop, pivot to the hotfix instead");
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "session_steer", { target, message: "pivot to the hotfix instead" });

    check("session_steer (busy): FLUSH — the superseded OLD direction is gone from the live queue", !pty.getPending(target).some((t) => t.includes("OLD")));
    check("session_steer (busy): SUPERSEDE — the old durable record is resolved", !db.listUndeliveredQueuedMessages().some((e) => e.detail.text.includes("OLD")));
    check("session_steer (busy): the target was interrupted (held redirect ⇒ interrupt fires)", pty.interrupts.includes(target));
    check("session_steer (busy): the authoritative redirect landed, framed [loom:from-owner-via-companion:redirect]", pty.delivered.some((d) => d.id === target && d.text.startsWith("[loom:from-owner-via-companion:redirect]") && d.text.includes("pivot to the hotfix")));
    check("session_steer: NO Primitive C — commits on the FIRST call", res.status === undefined);

    await client.close();
    db.close();
  }

  // ============ session_steer: idle target — delivered immediately, NO interrupt ============
  {
    const proj = `proj-steer-idle-${randomUUID()}`;
    const companionSess = `companion-steer-idle-${randomUUID()}`;
    const target = `target-steer-idle-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "worker");
    pty.setLive(target); // idle
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: change course now");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "session_steer", { target, message: "change course now" });
    check("session_steer (idle): delivered immediately (delivered:true)", res.delivered === true);
    check("session_steer (idle): NOT interrupted (nothing in-flight to cancel)", !pty.interrupts.includes(target));
    check("session_steer (idle): still framed", pty.delivered.some((d) => d.id === target && d.text.startsWith("[loom:from-owner-via-companion:redirect]")));

    await client.close();
    db.close();
  }

  // ============ session_stop + session_resume: REAL lifecycle round-trip ============
  {
    const proj = `proj-lifecycle-${randomUUID()}`;
    const companionSess = `companion-lifecycle-${randomUUID()}`;
    const target = `target-lifecycle-${randomUUID()}`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sc-cwd-"));
    const engineSessionId = `eng-${randomUUID()}`;
    plantEngineTranscript(cwd, engineSessionId);
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "worker", { cwd, engineSessionId });
    pty.setLive(target);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: stop that worker, then bring it back");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const stopRes = await call(client, "session_stop", { target });
    check("session_stop: returns stopped:true for the target", stopRes.stopped === true && stopRes.sessionId === target);
    check("session_stop: the REAL pty rail actually stopped it (default mode graceful)", pty.stops.some((s) => s.id === target && s.mode === "graceful"));
    check("session_stop: the target is no longer alive on the real pty", !pty.isAlive(target));

    const resumeRes = await call(client, "session_resume", { target });
    check("session_resume: returns the session's id", resumeRes.id === target);
    check("session_resume: the REAL pty rail actually respawned it", pty.spawns.some((s) => s.sessionId === target));
    check("session_resume: the target is alive again on the real pty", pty.isAlive(target));
    check("session_resume: the DB row reflects processState 'live'", db.getSession(target).processState === "live");

    // hard-mode stop is passed through untranslated.
    const hardStop = await call(client, "session_stop", { target, mode: "hard" });
    check("session_stop (hard): mode is passed through to the real pty rail", pty.stops.some((s) => s.id === target && s.mode === "hard"));
    check("session_stop (hard): still returns stopped:true", hardStop.stopped === true);

    await client.close();
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  // ============ session_resume: a RECYCLED session (successor exists) is rejected ============
  {
    const proj = `proj-recycled-${randomUUID()}`;
    const companionSess = `companion-recycled-${randomUUID()}`;
    const predecessor = `target-recycled-old-${randomUUID()}`;
    const successor = `target-recycled-new-${randomUUID()}`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sc-recycled-"));
    const engineSessionId = `eng-${randomUUID()}`;
    plantEngineTranscript(cwd, engineSessionId);
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, predecessor, proj, "manager", { cwd, engineSessionId, processState: "exited" });
    seedSession(db, successor, proj, "manager", { recycledFrom: predecessor });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: bring the old manager back");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "session_resume", { target: predecessor });
    check("session_resume (recycled): rejected with an {error} — only a human force-resume may resurrect it", typeof res.error === "string" && res.id === undefined);
    check("session_resume (recycled): the predecessor was NOT respawned", !pty.spawns.some((s) => s.sessionId === predecessor));

    await client.close();
    db.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  // ============ scope: read-only-granted project rejects, for ALL FOUR tools ============
  {
    const projRead = `proj-scope-ro-${randomUUID()}`;
    const projAct = `proj-scope-act-${randomUUID()}`;
    const companionSess = `companion-scope-ro-${randomUUID()}`;
    const target = `target-scope-ro-${randomUUID()}`;
    const db = tmpDb();
    seedProject(db, projRead, projRead); seedProject(db, projAct, projAct);
    seedSession(db, companionSess, projRead, "assistant");
    seedSession(db, target, projRead, "worker");
    const pty = new PtyStub(); pty.setLive(companionSess); pty.setLive(target);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, sessions, {}, pty);
    // session-steer is registered because ANOTHER granted project is act-mode — but the TARGET's own
    // project (projRead) is only read-mode, and the per-project mayAct recheck must still refuse it.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: projRead, mode: "read" });
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: projAct, mode: "act" });
    pty.setOwnerText("the owner said: do something");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const msg = await call(client, "session_message", { target, message: "hi" });
    check("read-only project: session_message rejected (mayAct false)", typeof msg.error === "string");
    const steer = await call(client, "session_steer", { target, message: "hi" });
    check("read-only project: session_steer rejected (mayAct false)", typeof steer.error === "string");
    const stop = await call(client, "session_stop", { target });
    check("read-only project: session_stop rejected (mayAct false)", typeof stop.error === "string");
    check("read-only project: the target was NOT stopped", pty.isAlive(target));
    const resume = await call(client, "session_resume", { target });
    check("read-only project: session_resume rejected (mayAct false)", typeof resume.error === "string");

    await client.close();
    db.close();
  }

  // ============ scope: ungranted project rejects, for ALL FOUR tools ============
  {
    const projGranted = `proj-scope-ungranted-granted-${randomUUID()}`;
    const projOther = `proj-scope-ungranted-other-${randomUUID()}`;
    const companionSess = `companion-scope-ungranted-${randomUUID()}`;
    const target = `target-scope-ungranted-${randomUUID()}`;
    const db = tmpDb();
    seedProject(db, projGranted, projGranted); seedProject(db, projOther, projOther);
    seedSession(db, companionSess, projGranted, "assistant");
    seedSession(db, target, projOther, "worker");
    const pty = new PtyStub(); pty.setLive(companionSess); pty.setLive(target);
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, sessions, {}, pty);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: projGranted, mode: "act" });
    pty.setOwnerText("the owner said: do something");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    for (const [tool, args] of [
      ["session_message", { target, message: "hi" }],
      ["session_steer", { target, message: "hi" }],
      ["session_stop", { target }],
      ["session_resume", { target }],
    ]) {
      const res = await call(client, tool, args);
      check(`ungranted project: ${tool} rejected`, typeof res.error === "string");
    }
    check("ungranted project: the target was never touched (still alive, no delivery)", pty.isAlive(target) && pty.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ Primitive A: a proactive turn (no owner text) rejects ALL FOUR tools ============
  {
    const proj = `proj-proactive-${randomUUID()}`;
    const companionSess = `companion-proactive-${randomUUID()}`;
    const target = `target-proactive-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "worker");
    pty.setLive(target);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText(null); // no owner text this turn — a proactive/heartbeat/reminder turn
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    for (const [tool, args] of [
      ["session_message", { target, message: "hi" }],
      ["session_steer", { target, message: "hi" }],
      ["session_stop", { target }],
      ["session_resume", { target }],
    ]) {
      const res = await call(client, tool, args);
      check(`proactive turn (no owner text): ${tool} rejected`, typeof res.error === "string");
    }
    check("proactive turn: the target was never touched", pty.isAlive(target) && pty.delivered.length === 0);

    await client.close();
    db.close();
  }

  // ============ roleFilter: restricts when configured, default admits every role ============
  {
    const proj = `proj-rolefilter-${randomUUID()}`;
    const companionSess = `companion-rolefilter-${randomUUID()}`;
    const managerTarget = `target-rf-mgr-${randomUUID()}`;
    const workerTarget = `target-rf-wkr-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, managerTarget, proj, "manager");
    seedSession(db, workerTarget, proj, "worker");
    pty.setLive(managerTarget); pty.setLive(workerTarget);
    db.upsertCompanionCapabilityGrant({
      sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act",
      config: { roleFilter: ["manager"] },
    });
    pty.setOwnerText("the owner said: message the manager");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const okRes = await call(client, "session_message", { target: managerTarget, message: "status?" });
    check("roleFilter ['manager']: an allowed role (manager) is accepted", okRes.deliveryStatus !== undefined && okRes.error === undefined);
    const blockedRes = await call(client, "session_message", { target: workerTarget, message: "status?" });
    check("roleFilter ['manager']: a disallowed role (worker) is rejected", typeof blockedRes.error === "string");

    await client.close();
    db.close();
  }
  {
    // Default (no roleFilter configured at all) admits every role — the OPPOSITE default of
    // decisionClasses' conservative admit-nothing, per the card's explicit "whatever I want" spec.
    const proj = `proj-rolefilter-default-${randomUUID()}`;
    const companionSess = `companion-rolefilter-default-${randomUUID()}`;
    const target = `target-rf-default-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    seedSession(db, target, proj, "worker");
    pty.setLive(target);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: message the worker");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const res = await call(client, "session_message", { target, message: "status?" });
    check("default roleFilter (unconfigured): every role is admitted", res.deliveryStatus !== undefined && res.error === undefined);

    await client.close();
    db.close();
  }

  // ============ unknown session id: all four reject cleanly (no crash) ============
  {
    const proj = `proj-unknown-${randomUUID()}`;
    const companionSess = `companion-unknown-${randomUUID()}`;
    const { db, pty, orch } = setup(companionSess, proj);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "session-steer", projectId: proj, mode: "act" });
    pty.setOwnerText("the owner said: do something");
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    for (const [tool, args] of [
      ["session_message", { target: "no-such-session", message: "hi" }],
      ["session_steer", { target: "no-such-session", message: "hi" }],
      ["session_stop", { target: "no-such-session" }],
      ["session_resume", { target: "no-such-session" }],
    ]) {
      const res = await call(client, tool, args);
      check(`unknown session: ${tool} rejected cleanly`, typeof res.error === "string");
    }

    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_message/session_steer/session_stop/session_resume each drive the REAL scoped SessionService rail (durable delivery, flush+supersede+interrupt, actual pty stop, actual respawn with DB processState flipping live); a read-only-granted or ungranted target project rejects all four, as does any proactive (no-owner-text) turn (Primitive A); an optional roleFilter restricts by role while an unconfigured one admits every role; delivered message/steer text is always framed [loom:from-owner-via-companion]; NO Primitive C — every action commits on the first call; a recycled (superseded) target's resume is refused; and the whole tool surface is unregistered under a read-only or absent grant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
