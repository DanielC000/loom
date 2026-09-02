import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8e0d09e8 — a `platform_escalate` notice's TITLE is frozen at filing (the dedupe signature — never
// re-minted), so a recipient reading a notice that sat queued for a while has no way to tell it's reading
// a snapshot. Two additive fields close the gap:
//   DoD-1: the notice states its own FILING timestamp — frozen data, safe to bake in right at filing.
//   DoD-5: the notice also states the escalated card's CURRENT COLUMN (or that it's terminal) — LIVE
//     data, which must be read as late as possible: right when the text is actually assembled for a real
//     write (`pty/host.ts`'s `annotatedMessageText`, via a `resolveTailAtDelivery` closure), not at the
//     original `platformEscalate` call. The whole point is to catch a card the Lead already closed
//     BETWEEN filing and drain — a filing-time-only read would almost never see that (the task was just
//     created a moment earlier), which is exactly why this must be genuinely delivery-time.
//
// THE DISCRIMINATING RED for DoD-5: file an escalation while the Lead is BUSY (so the note QUEUES rather
// than delivering immediately), close the card WHILE the note is still queued, then drain it — the
// delivered text must reflect the post-enqueue close. Before this fix (or with `resolveTailAtDelivery`
// reverted), the delivered text is frozen at enqueue time and can never mention a column change that
// happens after — this test fails on exactly that missing tail, not on the note changing shape generally.
//
// DRIVES THE REAL PtyHost busy/drain state machine (only `createPty` faked) — mirrors
// platform-escalate-parked-wake.mjs — so `annotatedMessageText`'s delivery-time resolution genuinely runs,
// unlike platform-escalate-co-pending.mjs's `enqueueStdin`-stubbing SeamHost (which bypasses drain
// entirely and would never exercise this).
//
// AMEND (Code Reviewer Major ①, 2026-09-02): `submit()` bakes the tail's resolved text verbatim into
// `live.lastPrompt`, and a usage-cap kill's `resumeAfterRateLimit` replays that exact string unchanged,
// however much later the park clears — potentially hours. The tail now stamps its OWN "as of" read time
// (matching the frame's filing-stamp format) so a replay stays honest about the tail's real vintage
// instead of silently reading as current. Scenario (4) below proves that stamp travels verbatim through
// a real `StopFailure(rate_limit)` park + `resumeAfterRateLimit` replay (mirrors
// pty-rate-limit-park-drain.mjs's park/resume mechanics) — the column is mutated again WHILE parked, and
// the replayed text must still show the ORIGINAL stamp/value, never a silently-refreshed one.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-filed-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escfiledstamp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

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

const now = new Date().toISOString();
const db = new Db();
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new TestPtyHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
const seedSession = (id, projectId, agentId, role) => db.insertSession({
  id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role, parentSessionId: null,
});
seedSession("LEAD", "pHome", "agentLead", "platform");
seedSession("MGR", "pOrd", "agentMgr", "manager");

try {
  host.spawn({
    sessionId: "LEAD", cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fake = fakes[0];
  host.deliverHook("LEAD", { hook_event_name: "SessionStart" });

  // ===================== DoD-1: an IMMEDIATE (idle-Lead) delivery carries the filing stamp =====================
  const beforeFile = new Date();
  const esc1 = svc.platformEscalate("MGR", { title: "immediate-delivery filing stamp", detail: "d1", severity: "low" });
  check("(1) delivered live to an idle Lead", esc1.deliveryStatus === "delivered-live");
  const delivered1 = fake.writes.join("");
  check("(1) the delivered note states a filing timestamp for THIS escalation's task",
    delivered1.includes(esc1.taskId) && /\(filed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(delivered1));
  check("(1) the filing timestamp is close to when platformEscalate was actually called (not some other time)", (() => {
    const m = delivered1.match(/\(filed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\)/);
    if (!m) return false;
    const stamped = new Date(m[1]);
    return Math.abs(stamped.getTime() - beforeFile.getTime()) < 5000;
  })());
  check("(1) title is NOT re-minted — the frozen title still appears verbatim", delivered1.includes("immediate-delivery filing stamp"));

  host.deliverHook("LEAD", { hook_event_name: "Stop" }); // settle esc1's turn

  // ===================== DoD-5: THE DISCRIMINATING RED — a column change WHILE queued must be visible ======
  // Make the Lead busy first, so the next escalation QUEUES instead of delivering immediately.
  host.enqueueStdin("LEAD", "an unrelated in-flight turn");
  check("setup: Lead is genuinely busy", db.getSession("LEAD").busy === true);

  const writesBeforeEsc2 = fake.writes.length;
  const esc2 = svc.platformEscalate("MGR", { title: "delivery-time column read", detail: "d2", severity: "low" });
  check("(2) a busy Lead queues the note rather than delivering it immediately", esc2.deliveryStatus === "queued");
  check("(2) nothing new was written yet — the note is still sitting in the queue, unresolved", fake.writes.length === writesBeforeEsc2);

  // The Lead — mid its OTHER turn — closes esc2's card. This mirrors the real specimen: the escalation's
  // own notice is still queued behind another turn while the card gets triaged and moved to terminal.
  db.updateTask(esc2.taskId, { columnKey: "done" });

  // Settle the in-flight turn — this drains the queue and delivers esc2's notice as the NEXT turn.
  host.deliverHook("LEAD", { hook_event_name: "Stop" });

  const delivered2 = fake.writes.slice(writesBeforeEsc2).join("");
  check("(2) esc2's notice actually drained and was written", delivered2.includes(esc2.taskId));
  check("(2) THE FIX: the delivered text reflects the column change that happened AFTER enqueue (delivery-time read, not filing-time)",
    /column as of \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z: `done` \(terminal\)/.test(delivered2));
  check("(2) the frozen title is still the pre-triage title — never re-minted just because the column moved",
    delivered2.includes("delivery-time column read"));

  host.deliverHook("LEAD", { hook_event_name: "Stop" }); // settle esc2's turn (hygiene)

  // ===================== DEGRADE: a lookup failure must never drop or delay the notice =====================
  host.enqueueStdin("LEAD", "another unrelated in-flight turn");
  const writesBeforeEsc3 = fake.writes.length;
  const esc3 = svc.platformEscalate("MGR", { title: "degrade on a vanished task", detail: "d3", severity: "low" });
  db.deleteTask(esc3.taskId); // the column lookup at drain time will now find nothing
  host.deliverHook("LEAD", { hook_event_name: "Stop" });
  const delivered3 = fake.writes.slice(writesBeforeEsc3).join("");
  check("(3) a failed delivery-time column lookup still delivers the note (never dropped)",
    delivered3.includes(esc3.taskId) && delivered3.includes("degrade on a vanished task"));
  check("(3) …just without a column tail — degrades to the filing stamp alone",
    !delivered3.includes("column as of"));

  host.deliverHook("LEAD", { hook_event_name: "Stop" }); // settle esc3's turn (hygiene)

  // ===================== Code Reviewer Major ①: the tail's OWN stamp must survive a rate-limit replay ======
  // `submit()` bakes the FULLY-RESOLVED text (tail included) verbatim into `live.lastPrompt`, and
  // `resumeAfterRateLimit` replays that exact string unchanged, however much later the park clears. The
  // frame's `(filed …)` stamp says nothing about the TAIL's own age — so the tail must carry its own "as
  // of" mark, and that mark must be the ORIGINAL read (never silently refreshed) when replayed.
  const writesBeforeEsc4 = fake.writes.length;
  const esc4 = svc.platformEscalate("MGR", { title: "rate-limit replay staleness", detail: "d4", severity: "low" });
  check("(4) delivered live to the (still idle) Lead", esc4.deliveryStatus === "delivered-live");
  const delivered4a = fake.writes.slice(writesBeforeEsc4).join("");
  const stampMatch = delivered4a.match(/column as of (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):/);
  check("(4) the immediate delivery's tail carries its own 'as of' stamp", !!stampMatch);
  const originalAsOf = stampMatch && stampMatch[1];

  // Simulate a usage-cap kill BEFORE the turn Stops normally — parks the session, freezing `live.lastPrompt`
  // as exactly the text just delivered above (tail, and its stamp, already baked in).
  host.deliverHook("LEAD", { hook_event_name: "StopFailure", error: "rate_limit" });

  // The column drifts FURTHER while parked — mirrors a real cap park lasting a while with more triage
  // happening in the meantime. Deliberately a DIFFERENT value from esc4's initial (default-landing)
  // column, so a wrongly-re-resolved replay is actually distinguishable from a correctly-frozen one.
  const originalColumnKey = db.getTask(esc4.taskId).columnKey;
  const driftedColumnKey = originalColumnKey === "in_review" ? "in_progress" : "in_review";
  db.updateTask(esc4.taskId, { columnKey: driftedColumnKey });

  const writesBeforeResume = fake.writes.length;
  host.resumeAfterRateLimit("LEAD");
  const replayed = fake.writes.slice(writesBeforeResume).join("");
  check("(4) THE FIX survives a rate-limit replay: the replayed text carries the SAME (never re-derived) 'as of' stamp",
    originalAsOf !== null && replayed.includes(`column as of ${originalAsOf}:`));
  check("(4) the replay is the frozen ORIGINAL text, not a fresh re-resolve against the now-drifted column",
    replayed.includes(`\`${originalColumnKey}\``) && !replayed.includes(`\`${driftedColumnKey}\``));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a platform_escalate notice now states its own filing timestamp (frozen, baked in at filing) AND, resolved genuinely at delivery time (not at filing), the escalated card's current column or terminal status, each carrying its OWN 'as of' stamp — proven by closing a card WHILE its notice sat queued behind another turn and confirming the DELIVERED text reflects the close, never the filing-time snapshot. A column lookup that fails (the task is gone) degrades to the filing stamp alone rather than dropping or delaying the notice. And a rate-limit-killed turn's replay (`live.lastPrompt`, verbatim, however much later) still discloses exactly when its tail was actually read, instead of silently reading as current."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
