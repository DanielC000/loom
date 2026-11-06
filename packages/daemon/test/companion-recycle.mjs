import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 79e030d9 — recycle an EXHAUSTED Companion onto a FRESH engine session under the SAME Loom session id
// (SessionService.recycleCompanion via CompanionController.recycle). Hermetic like companion-live-upgrade.mjs:
// temp LOOM_HOME + sandboxed HOME, a REAL Db + SessionService + CompanionController + ContextWatcher driven
// against a FAKE pty (PtyHost's createPty seam) — no real claude, no daemon, no network.
//
// One section per transfer item (each has a behavioural-mutant RED recorded in the card's report):
//   (1) chat bindings intact          (2) home + voice prefs + reminders + durable grants intact
//   (3) no double-start of gateway/heartbeat/reminders/attention-push (controller keeps its wiring)
//   (4) in-memory trust closed (Trust Window + inline authored-content grant), durable grants KEPT
//   (5) queued alerts carried onto the fresh pty        (6) memory handoff (preamble + memory notes)
//   (7) owner exhaustion notice dismissed               (8) exhaustion mark cleared
//   (9) stale transcript is NOT re-read: the engine id is detached, so the watcher cannot re-flag
//   (10) guards: codex companion + non-companion refused, nothing changed
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/companion-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cmp-recycle-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.LOOM_GRACEFUL_GAP_MS = "50";
process.env.LOOM_GRACEFUL_RETRY_MS = "150";
process.env.LOOM_GRACEFUL_KILL_MS = "300";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { ContextWatcher } = await import("../dist/orchestration/context-watcher.js");
const { CompanionTrustWindow } = await import("../dist/companion/trust-window.js");
const { AuthoredContentGrantStore } = await import("../dist/companion/attestation.js");
const { authorCompanionMemory } = await import("../dist/skills/companion-memory-store.js");

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) {
    if (this.failNextSpawn) { this.failNextSpawn = false; throw new Error("injected spawn failure"); }
    // Trust state AT SPAWN TIME: the point-of-no-return close must already have happened by now.
    this.capture.push({ ...opts, trustWarmAtSpawn: trustWindow.isWarm(trustKeyOf(opts.sessionId)), grantAtSpawn: authoredGrants.hasGrant(opts.sessionId, projId) });
    return { ...super.createPty(opts), pid: 5000 + this.capture.length };
  }
}
let controller = null;
// Module-scope so SeamHost.createPty (above) can observe trust state at spawn time.
const ROUTE = { channel: "telegram", chatId: "424242" };
const trustWindow = new CompanionTrustWindow();
const authoredGrants = new AuthoredContentGrantStore();
const trustKeyOf = (sid) => ({ sessionId: sid, route: ROUTE, senderId: null });
let projId = null;
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  // index.ts's onExit also tells the companion controller — reproduced so the stale-exit guard is exercised.
  // ALSO reproduces index.ts's `if (exited && exited.role !== "run") sessions.archiveOnExit(exited)` (B1): the old
  // pty's exit DURING recycleCompanion's stop loop archives the assistant row, so a stale pre-stop snapshot lies.
  onExit(id) {
    db.setProcessState(id, "exited"); db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited && exited.role !== "run") svc.archiveOnExit(exited);
    void controller?.onSessionExit(id);
  },
};

const now = new Date().toISOString();
const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

projId = randomUUID();
db.insertProject({ id: projId, name: "Recycle", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
const profileId = randomUUID();
db.insertProfile({
  id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
});
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Juno", startupPrompt: "You are Juno, a companion.", position: 0, profileId, endpoint: false, ioSchema: null });

const sessionId = randomUUID();
const OLD_ENG = "eng-old-exhausted";
db.insertSession({
  id: sessionId, projectId: projId, agentId, engineSessionId: OLD_ENG, title: null, cwd,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
  noCommit: false, skills: null, connections: [], capabilities: [],
});
// The OLD (exhausted) transcript: its tail is the terminal "Prompt is too long" record.
const oldTranscript = engineTranscriptPath(cwd, OLD_ENG);
fs.mkdirSync(path.dirname(oldTranscript), { recursive: true });
fs.writeFileSync(oldTranscript, JSON.stringify({
  type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
  error: "invalid_request", isApiErrorMessage: true,
}) + "\n");

// ---- durable state keyed by the session id (must all survive) ----
db.upsertCompanionConfig({
  sessionId, botTokenBlob: "", channel: ROUTE.channel, allowedChatId: ROUTE.chatId, chatScope: "dm",
  heartbeatIntervalMinutes: 5, heartbeatPrompt: null, enabled: true, provisioned: true, name: "Juno",
});
db.upsertCompanionBinding({ sessionId, ...ROUTE, scope: "dm" });
db.setCompanionHome(sessionId, ROUTE);
db.upsertCompanionVoicePref({ sessionId, ...ROUTE, senderId: null, voiceReplies: "on", ttsLang: "en" });
db.upsertCompanionCapabilityGrant({ sessionId, capability: "attention-push", projectId: null, mode: "read" });
db.insertCompanionReminder({ id: randomUUID(), sessionId, cron: "0 9 * * *", prompt: "morning", label: null, route: null, enabled: true, createdAt: now });
authorCompanionMemory(sessionId, "owner-prefers-tea", "---\npinned: true\n---\nUNIQUE-MEMORY-MARKER-7731: the owner prefers tea over coffee.");

// ---- controller with counting fakes ----
const counts = { gwStart: 0, gwStop: 0, hbStart: 0, hbStop: 0, remStart: 0, attStart: 0 };
const cfg = {
  botToken: null, allowedChatId: ROUTE.chatId, sessionId, chatScope: "dm", homeChannel: ROUTE.channel, homeChatId: ROUTE.chatId,
  heartbeatIntervalMinutes: 5, heartbeatPrompt: "hb", bindingsSeeded: true,
};
const trustKey =trustKeyOf(sessionId);
const upgradeCalls = [];
const companionIds = new Set();
controller = new CompanionController({
  db, submitTurn: () => ({ delivered: true }), pty: host, hooks: { companionSessionIds: companionIds }, env: {},
  resolveEffective: () => [cfg],
  buildGateway: () => ({ start() { counts.gwStart++; }, async stop() { counts.gwStop++; }, bind() {}, unbind() {}, bindingsForSession: () => [] }),
  buildHeartbeat: () => ({ start() { counts.hbStart++; }, stop() { counts.hbStop++; } }),
  buildReminders: () => ({ start() { counts.remStart++; }, stop() {} }),
  buildAttentionPush: () => ({ start() { counts.attStart++; }, stop() {} }),
  closeTrustWindow: (sid) => { trustWindow.closeAllForSession(sid); authoredGrants.clearSession(sid); },
  recycleCompanionSession: (sid, hooks) => svc.recycleCompanion(sid, hooks),
  // N2: an auto-upgrade of the just-spawned fresh engine would kill it — the recycle re-arm must skip it.
  wasSessionAlreadyLive: () => true,
  upgradeCompanionSession: async (sid) => { upgradeCalls.push(sid); return db.getSession(sid); },
});

const watcher = new ContextWatcher({ db, pty: host, ratio: 0 });
const openNotices = () => db.listQuestionsForSession(sessionId).filter((q) => q.type === "notice" && q.dismissedAt == null);

try {
  // ===================== setup: live exhausted companion =====================
  db.setProcessState(sessionId, "live"); // the watcher scans live assistants only
  host.spawn({ sessionId, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, resumeId: OLD_ENG, role: "assistant", capabilities: [], skills: null });
  await controller.startInitial([cfg]);
  check("setup: gateway/heartbeat/reminders/attention-push armed once", counts.gwStart === 1 && counts.hbStart === 1 && counts.remStart === 1 && counts.attStart === 1);
  db.setBusy(sessionId, true); // the watcher only inspects a busy companion
  watcher.tick(new Date());
  const exhaustedRow = db.getSession(sessionId);
  check("setup: the watcher marked the companion exhausted", typeof exhaustedRow.contextExhaustedAt === "string");
  check("setup: the owner notice is open", openNotices().length === 1);
  // alerts queued while the exhaustion hold is on: they sit in the FIFO, undelivered
  host.enqueueStdin(sessionId, "[loom:alert] disk is 97% full", "system", undefined, undefined, "warning");
  host.enqueueStdin(sessionId, "ALERT-TWO from the fleet", "system", undefined, undefined, "agent");
  check("setup: both alerts are queued (held by the exhaustion hold)", host.getPending(sessionId).length === 2);
  trustWindow.arm(trustKey);
  authoredGrants.grant(sessionId, projId, "session");
  check("setup: trust window warm + authored-content grant present", trustWindow.isWarm(trustKey) && authoredGrants.hasGrant(sessionId, projId));
  const grantsBefore = JSON.stringify(db.listCompanionCapabilityGrantsForSession(sessionId));
  const bindingsBefore = JSON.stringify(db.getCompanionBindingsForSession(sessionId));

  // ===================== the recycle =====================
  host.capture.length = 0;
  const res = await controller.recycle(sessionId);
  check("recycle resolves ok", res.ok === true);
  const spawn = host.capture.at(-1);
  check("exactly ONE fresh spawn", host.capture.length === 1);
  check("the spawn is FRESH (no resumeId) and keeps the assistant role", spawn && spawn.resumeId === undefined && spawn.role === "assistant");
  check("the companion pty is alive again under the SAME session id", host.isAlive(sessionId) && res.session?.id === sessionId);
  // B1: the old pty's exit archived the row (archiveOnExit) DURING the stop loop; the fresh engine must be on the live rail.
  check("(B1) a LIVE recycle leaves archivedAt === null (not archived by the old pty's exit)", db.getSession(sessionId).archivedAt === null && res.session?.archivedAt == null);

  // (1) bindings
  check("(1) chat bindings intact (byte-identical rows)", JSON.stringify(db.getCompanionBindingsForSession(sessionId)) === bindingsBefore && bindingsBefore.includes("424242"));
  // (2) home / voice / reminders / durable grants
  check("(2) home target intact", JSON.stringify(db.getCompanionHome(sessionId)) === JSON.stringify(ROUTE));
  check("(2) voice pref intact", db.getCompanionVoicePref(sessionId, ROUTE.channel, ROUTE.chatId, null)?.voiceReplies === "on");
  check("(2) reminders intact", db.listEnabledCompanionReminders(sessionId).length === 1);
  check("(2) companion_config row intact + still enabled", db.getCompanionConfig(sessionId)?.enabled === true);
  // (3) no double-start: the controller never tore down nor re-built anything
  check("(3) no gateway/heartbeat/reminder/attention-push was rebuilt or stopped (no double-start, no teardown)",
    counts.gwStart === 1 && counts.gwStop === 0 && counts.hbStart === 1 && counts.hbStop === 0 && counts.remStart === 1 && counts.attStart === 1);
  check("(3) the controller still holds the session live (stale exit event did not tear it down)", controller.liveSessionIds().includes(sessionId));
  // (4) trust
  check("(4) in-memory Trust Window closed", !trustWindow.isWarm(trustKey));
  check("(4) inline authored-content grant closed", !authoredGrants.hasGrant(sessionId, projId));
  check("(4) trust was ALREADY closed at spawn time (point of no return, not after the tail)", spawn?.trustWarmAtSpawn === false && spawn?.grantAtSpawn === false);
  check("(4) DURABLE capability grants KEPT", JSON.stringify(db.listCompanionCapabilityGrantsForSession(sessionId)) === grantsBefore && grantsBefore.includes("attention-push"));
  // (5) queued alerts
  const carriedTexts = host.getPending(sessionId);
  check("(5) both queued alerts were carried onto the fresh pty", carriedTexts.some((t) => t.includes("disk is 97% full")) && carriedTexts.some((t) => t.includes("ALERT-TWO")));
  // (6) memory handoff
  check("(6) the fresh startup prompt leads with the recycle preamble", typeof spawn?.startupPrompt === "string" && spawn.startupPrompt.startsWith("[loom:companion-recycled]"));
  check("(6) the fresh startup prompt carries the persona", spawn?.startupPrompt?.includes("You are Juno, a companion."));
  check("(6) the fresh startup prompt carries the companion memory note", spawn?.startupPrompt?.includes("UNIQUE-MEMORY-MARKER-7731"));
  check("(6) NO transcript content leaks into the handoff", !spawn?.startupPrompt?.includes("Prompt is too long"));
  // (7) notice
  check("(7) the owner's exhaustion notice is dismissed", openNotices().length === 0);
  // (8) exhaustion mark
  const after = db.getSession(sessionId);
  check("(8) contextExhaustedAt cleared", after.contextExhaustedAt == null);
  check("(8) the 'Context exhausted' lastError cleared", !/context exhausted/i.test(after.lastError ?? ""));
  // (9) stale transcript non-re-flag
  check("(9) the abandoned engine session id is detached from the row", after.engineSessionId == null);
  db.setBusy(sessionId, true); // a turn is now in flight on the fresh session
  watcher.tick(new Date(Date.now() + 61_000));
  check("(9) before the new SessionStart lands the watcher does NOT re-flag exhaustion from the OLD transcript", db.getSession(sessionId).contextExhaustedAt == null);
  check("(9) ...and files no second notice", openNotices().length === 0);
  events.onEngineSessionId(sessionId, "eng-new-fresh"); // the new SessionStart hook
  watcher.tick(new Date(Date.now() + 122_000));
  check("(9) after the new engine id lands (no transcript yet) still not flagged", db.getSession(sessionId).contextExhaustedAt == null && db.getSession(sessionId).engineSessionId === "eng-new-fresh");

  // ===================== (10) guards =====================
  const codexId = randomUUID();
  db.insertSession({
    id: codexId, projectId: projId, agentId, engineSessionId: "eng-codex", title: null, cwd, processState: "exited", resumability: "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant", harness: "codex",
    browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, skills: null, connections: [], capabilities: [],
  });
  host.capture.length = 0;
  const codexRes = await controller.recycle(codexId);
  check("(10) a codex-harness companion is refused with a clear message", codexRes.ok === false && /codex/i.test(codexRes.error));
  check("(10) ...and nothing was spawned nor changed", host.capture.length === 0 && db.getSession(codexId).engineSessionId === "eng-codex");
  const workerId = randomUUID();
  db.insertSession({
    id: workerId, projectId: projId, agentId, engineSessionId: "eng-w", title: null, cwd, processState: "exited", resumability: "resumable",
    busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
    browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, skills: null, connections: [], capabilities: [],
  });
  const nonCompanion = await controller.recycle(workerId);
  check("(10) a non-companion session is refused", nonCompanion.ok === false && /companion/i.test(nonCompanion.error));

  // ===================== helpers for the review-round sections =====================
  const mkCompanion = ({ alive = true, exhausted = true, resumability = "resumable", archived = false } = {}) => {
    const id = randomUUID();
    const eng = `eng-${id.slice(0, 8)}`;
    db.insertSession({
      id, projectId: projId, agentId, engineSessionId: eng, title: null, cwd,
      processState: alive ? "live" : "exited", resumability, busy: false, createdAt: now, lastActivity: now, lastError: null,
      role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
      noCommit: false, skills: null, connections: [], capabilities: [],
    });
    if (exhausted) db.setContextExhausted(id, new Date().toISOString(), "Context exhausted");
    if (archived) db.archiveSession(id);
    // NOT ready (no SessionStart hook delivered) ⇒ enqueued messages stay QUEUED.
    if (alive) host.spawn({ sessionId: id, cwd, permission: { allow: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, resumeId: eng, role: "assistant", capabilities: [], skills: null });
    return { id, eng };
  };
  const armTrust = (sid) => { trustWindow.arm(trustKeyOf(sid)); authoredGrants.grant(sid, projId, "session"); };
  const trustOpen = (sid) => trustWindow.isWarm(trustKeyOf(sid)) || authoredGrants.hasGrant(sid, projId);

  // ===================== Q1: refuses a NON-exhausted companion; double-POST is harmless =====================
  {
    host.capture.length = 0;
    const second = await controller.recycle(sessionId); // the main companion was recycled above ⇒ its mark is cleared
    check("(Q1) recycling a companion that is no longer exhausted is refused with clear text", second.ok === false && /not exhausted/i.test(second.error));
    check("(Q1) ...nothing spawned, the fresh engine is still alive", host.capture.length === 0 && host.isAlive(sessionId));
    const healthy = mkCompanion({ exhausted: false });
    const r = await controller.recycle(healthy.id);
    check("(Q1) a healthy (never-exhausted) companion is refused and its engine id untouched", r.ok === false && /not exhausted/i.test(r.error) && db.getSession(healthy.id).engineSessionId === healthy.eng && host.isAlive(healthy.id));
  }

  // ===================== S1: a post-spawn tail throw never turns a live successor into a failure =====================
  {
    const c = mkCompanion();
    armTrust(c.id);
    host.enqueueStdin(c.id, "TAIL-ALERT-A", "system", undefined, undefined, "agent", undefined, undefined, false, null, { giveUpHeldUntil: Date.now() + 3_600_000 });
    host.enqueueStdin(c.id, "TAIL-ALERT-B", "system", undefined, undefined, "warning");
    host.enqueueStdin(c.id, "TAIL-DURABLE", "system", () => {}, undefined, "agent");
    let redrives = 0;
    const origRedrive = svc.redriveUndeliveredMessagesForRecipient.bind(svc);
    svc.redriveUndeliveredMessagesForRecipient = (sid) => { if (sid === c.id) redrives++; return origRedrive(sid); };
    const origBusy = db.setBusy.bind(db);
    const origDismiss = db.dismissNotices.bind(db);
    // Only AFTER the fresh spawn (capture is cleared just below, so >0 means the spawn happened) — the pty's
    // own onBusy event also routes through db.setBusy and must not be the thing that throws.
    db.setBusy = (sid, b) => { if (sid === c.id && host.capture.length > 0) throw new Error("injected setBusy failure"); return origBusy(sid, b); };
    db.dismissNotices = () => { throw new Error("injected dismiss failure"); };
    host.capture.length = 0;
    const r = await controller.recycle(c.id);
    db.setBusy = origBusy; db.dismissNotices = origDismiss; svc.redriveUndeliveredMessagesForRecipient = origRedrive;
    check("(S1) a throw in the post-spawn tail still reports SUCCESS (the successor is live)", r.ok === true && host.isAlive(c.id));
    check("(S1) trust was closed BEFORE the spawn (not after the tail)", host.capture.at(-1)?.trustWarmAtSpawn === false && host.capture.at(-1)?.grantAtSpawn === false && !trustOpen(c.id));
    check("(S1) the exhaustion mark is cleared despite the tail throw", db.getSession(c.id).contextExhaustedAt == null);
    const pend = host.flushPending(c.id);
    const texts = pend.map((m) => m.text);
    check("(S1) the REMAINING alerts are still delivered to the fresh pty", texts.some((t) => t.includes("TAIL-ALERT-A")) && texts.some((t) => t.includes("TAIL-ALERT-B")));
    check("(S1) the durable (onDeliver) entry is NOT requeued by the loop...", !texts.some((t) => t.includes("TAIL-DURABLE")));
    check("(S1) ...and the durable queue is re-driven EXACTLY once", redrives === 1);
    // S2: a FRESH successor delivers immediately — the give-up hold is not carried
    const alertA = pend.find((m) => m.text.includes("TAIL-ALERT-A"));
    check("(S2) the requeued alert carries NO giveUpHeldUntil (fresh successor delivers immediately)", alertA && alertA.giveUpHeldUntil === undefined);
  }

  // ===================== S3/S5: stop timeout ⇒ honest refusal, carried messages requeued, nothing persisted =====================
  {
    const c = mkCompanion();
    host.enqueueStdin(c.id, "TIMEOUT-ALERT", "system", undefined, undefined, "agent");
    const origStop = host.stop.bind(host);
    let repins = 0;
    const origRepin = svc.repinCapabilitySurface.bind(svc);
    svc.repinCapabilitySurface = (...a) => { repins++; return origRepin(...a); };
    host.stop = () => {}; // the process never dies
    host.capture.length = 0;
    let err = null;
    try { await svc.recycleCompanion(c.id); } catch (e) { err = e; }
    host.stop = origStop;
    svc.repinCapabilitySurface = origRepin;
    check("(S5) a stop timeout refuses with the 'did not stop' message", err && /did not stop in time/.test(err.message));
    check("(S5) ...nothing was spawned, engine id + exhaustion mark untouched", host.capture.length === 0 && db.getSession(c.id).engineSessionId === c.eng && db.getSession(c.id).contextExhaustedAt != null);
    check("(S5) ...and the carried message was REQUEUED onto the still-alive pty", host.getPending(c.id).some((t) => t.includes("TIMEOUT-ALERT")));
    check("(S3) the refusal is honest: no capability repin was persisted before the confirmed stop", repins === 0);
    host.stop(c.id, "hard");
  }

  // ===================== S5/S1/S3: the spawn throws ⇒ restore prior state, keep the mark, trust stays CLOSED =====================
  {
    const c = mkCompanion({ resumability: "unknown", archived: true });
    armTrust(c.id);
    // pin a distinctive ORIGINAL archive stamp (older than the onExit restamp the stop will produce)
    const archivedBefore = "2020-01-01T00:00:00.000Z";
    db.archiveSession(c.id, archivedBefore);
    host.failNextSpawn = true;
    let err = null;
    try { await controller.recycle(c.id).then((x) => { if (!x.ok) throw new Error(x.error); }); } catch (e) { err = e; }
    host.failNextSpawn = false;
    const row = db.getSession(c.id);
    check("(S5) a throwing spawn is reported as a failure", err && /injected spawn failure/.test(err.message));
    check("(S5) ...the OLD engine id is restored", row.engineSessionId === c.eng);
    check("(S5) ...with its PRIOR resumability (not forced to 'resumable')", row.resumability === "unknown");
    check("(S5) ...the process is exited, not phantom-live", row.processState === "exited" && !host.isAlive(c.id));
    check("(S5) ...the exhaustion mark is KEPT (the button stays, retry is possible)", row.contextExhaustedAt != null);
    check("(S3) ...the archivedAt restore is reverted on the spawn throw", row.archivedAt != null);
    check("(N1) ...to the ORIGINAL archive timestamp, not a restamp", row.archivedAt === archivedBefore);
    check("(S1) ...trust STAYS CLOSED (fail closed: the old engine was already dead)", !trustOpen(c.id));
  }

  // ===================== clearEngineSessionId throws ⇒ same restore path, never phantom-live =====================
  {
    const c = mkCompanion({ resumability: "unknown", archived: true });
    armTrust(c.id);
    const origClear = db.clearEngineSessionId.bind(db);
    db.clearEngineSessionId = (sid) => { if (sid === c.id) throw new Error("injected clear failure"); return origClear(sid); };
    let err = null;
    try { await controller.recycle(c.id).then((x) => { if (!x.ok) throw new Error(x.error); }); } catch (e) { err = e; }
    db.clearEngineSessionId = origClear;
    const row = db.getSession(c.id);
    check("(CL) a throwing clearEngineSessionId is reported as a failure", err && /injected clear failure/.test(err.message));
    check("(CL) ...the row is not left phantom-live", row.processState === "exited" && !host.isAlive(c.id));
    check("(CL) ...the OLD engine id is still on the row", row.engineSessionId === c.eng);
    check("(CL) ...archived state restored", row.archivedAt != null);
  }

  // ===================== S5: recycle of a companion that is NOT alive + Q3: wiring re-armed =====================
  {
    // Kill the main companion's pty and let onSessionExit tear its wiring down (the production sequence).
    host.stop(sessionId, "hard");
    await controller.onSessionExit(sessionId);
    check("(Q3) setup: the dead companion's wiring was torn down by onSessionExit", !controller.liveSessionIds().includes(sessionId) && !companionIds.has(sessionId));
    db.setContextExhausted(sessionId, new Date().toISOString(), "Context exhausted");
    const gwBefore = counts.gwStart;
    upgradeCalls.length = 0; // the setup's startInitial legitimately auto-upgraded once (dbba993f); isolate the recycle
    host.capture.length = 0;
    const r = await controller.recycle(sessionId);
    check("(S5) recycling a companion that is not alive succeeds with ONE fresh spawn", r.ok === true && host.capture.length === 1 && host.isAlive(sessionId));
    check("(Q3) its gateway/heartbeat wiring is LIVE again after the recycle", controller.liveSessionIds().includes(sessionId) && companionIds.has(sessionId) && counts.gwStart === gwBefore + 1);
    check("(N2) the re-arm did NOT auto-upgrade (kill) the just-spawned fresh engine", !upgradeCalls.includes(sessionId) && host.isAlive(sessionId));
  }

  // ===================== B1: archive state across the recycle (pre-stop snapshot is stale) =====================
  {
    // live ⇒ the old pty's exit archives it mid-stop; recycled engine must end up un-archived, on the live rail
    const live = mkCompanion();
    const r1 = await controller.recycle(live.id);
    check("(B1) live companion: recycle ok, archivedAt === null, live", r1.ok === true && db.getSession(live.id).archivedAt === null && db.getSession(live.id).processState === "live");
    // already-archived DEAD companion: design = a running fresh engine always lives on the rail (restored), success path
    const dead = mkCompanion({ alive: false, archived: true });
    const r2 = await controller.recycle(dead.id);
    check("(B1) already-archived dead companion: restored to the rail while its fresh engine runs", r2.ok === true && db.getSession(dead.id).archivedAt === null && host.isAlive(dead.id));
    // live companion + spawn throw ⇒ PRE-RECYCLE state (null), not the onExit archive stamp
    const liveFail = mkCompanion();
    host.failNextSpawn = true;
    const r3 = await controller.recycle(liveFail.id);
    host.failNextSpawn = false;
    check("(B1) live companion + spawn throw: archivedAt restored to its pre-recycle null", r3.ok === false && db.getSession(liveFail.id).archivedAt === null);
  }

  // ===================== S-a: stop timeout THROUGH THE CONTROLLER with trust armed ⇒ trust stays OPEN =====================
  {
    const c = mkCompanion();
    armTrust(c.id);
    const origStop = host.stop.bind(host);
    host.stop = () => {}; // the old engine never dies
    host.capture.length = 0;
    const r = await controller.recycle(c.id);
    host.stop = origStop;
    check("(S-a) stop timeout through the controller is refused", r.ok === false && /did not stop in time/.test(r.error));
    check("(S-a) ...trust stays OPEN while the old engine is still alive (hook not fired before the confirmed stop)", trustOpen(c.id) && host.isAlive(c.id));
    check("(S-a) ...nothing spawned", host.capture.length === 0);
    host.stop(c.id, "hard");
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await controller.stop().catch(() => {});
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
