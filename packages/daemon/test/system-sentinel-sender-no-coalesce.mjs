// Regression guard for card e01687ea's code-review follow-up (BLOCKING finding) — the `"system"` sentinel
// sender must NOT become a shared coalescing/reorder IDENTITY.
//
// Card e01687ea's original fix threaded `ctx.sender` straight into `enqueueStdin`'s `senderId` for EVERY
// `enqueueDurableMessage` caller. But several of those callers pass the LITERAL SENTINEL string `"system"`
// (a daemon-generated notice, no real originating session) together with `kind:"agent"` — cap-queue TTL/
// autofire-failed nudges, merge-rejection/already-merged settle nudges, a run_gate cancellation nudge, and
// every `enqueueDurableNudge` caller that passes `opts.kind:"agent"` (wake/poll/event-trigger resume
// nudges). Threading `ctx.sender` unconditionally would make `"system"` a non-null identity SHARED by every
// one of those unrelated daemon notices — a merge-rejection nudge for task A and an already-merged
// announcement for task B would coalesce into ONE turn, and a `"system"` nudge could leapfrog a manager's
// queued worker report to land beside an earlier `"system"` entry. Card `ccb407eb` deliberately made these
// agent-kind so each lands as its OWN turn; this regression would silently undo that for the whole class.
//
// The fix: `SessionService.coalesceSenderId` null-maps the `"system"` sentinel at the coalescing seam
// (`ctx.sender === "system" ? null : ctx.sender`) before it ever reaches `enqueueStdin`'s `senderId` — a
// null senderId never coalesces/reorders with anything (drainPending's/enqueueStdin's own `senderKey !==
// null` gates), restoring the exact pre-e01687ea one-nudge-per-turn behavior for this family, while a REAL
// sender id (the overwhelming majority of `enqueueDurableMessage` callers) still coalesces/reorders as
// card e01687ea intends.
//
// This suite drives `SessionService.enqueueDurableNudge` — a PUBLIC wrapper around the private
// `enqueueDurableMessage`, and one of the exact call shapes named above (`sender:"system"`, caller-supplied
// `kind`) — against a REAL `PtyHost` (the same createPty fake-write seam the sibling suites use). `role:
// null` makes `usesOrchestrationMcp` false, so the dispatch fires synchronously, no MCP-seen wait needed.
//   (A) two `kind:"agent"` system nudges to the SAME busy recipient do NOT coalesce — they drain as TWO
//       separate turns, one per Stop hook, exactly like two DIFFERENT real senders would (pty-agent-sender-
//       coalesce.mjs scenario (B)) — never like two SAME-sender messages (that same suite's scenario (A)).
//   (B) a REAL sender id (messageWorker, via the sibling worker-message-sender-wiring.mjs suite) is
//       UNAFFECTED by this null-mapping — re-asserted here as a sanity check that this fix is genuinely
//       narrow to the `"system"` sentinel, not a regression of DoD-1's own coalescing fix.
//
// RUN (no daemon needed): node test/system-sentinel-sender-no-coalesce.mjs
//   Requires the daemon built first (reads ../dist/{db,pty/host,sessions/service,orchestration/control}.js):
//   from packages/daemon run `pnpm build`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpHome = path.join(os.tmpdir(), `loom-sysent-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

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
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const PASTE_START = "\x1b[200~";

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const db = new Db();
const proj = `sysent-proj-${sfx}`, agent = `sysent-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: null,
  worktreePath: null, branch: null,
});

const sessions = new SessionService(db, host, new OrchestrationControl());

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
  const fake = fakes[fakes.length - 1];
  return { written: () => fake.writes.join(""), countOf: (m) => fake.writes.join("").split(m).length - 1 };
}

function primeBusy(sessionId) {
  const r = host.enqueueStdin(sessionId, "PRIMER_TURN");
  if (!r.delivered) throw new Error(`primeBusy(${sessionId}): PRIMER was not delivered immediately`);
}

try {
  // ===================== (A) two "system"-sender agent-kind nudges do NOT coalesce =====================
  {
    const recipient = `sysent-a-recip-${sfx}`;
    mkSession({ id: recipient, role: "worker" });
    const { written, countOf } = spawnReady(recipient);
    primeBusy(recipient);
    await sleep(250);

    sessions.enqueueDurableNudge(recipient, null, "SYSTEM_NUDGE_ONE", null, { kind: "agent" });
    sessions.enqueueDurableNudge(recipient, null, "SYSTEM_NUDGE_TWO", null, { kind: "agent" });
    check("(A) setup: both nudges queued (recipient busy)", host.getPending(recipient).length === 2);

    let pasteBefore = countOf(PASTE_START);
    host.deliverHook(recipient, { hook_event_name: "Stop" });
    check("(A) turn 1: exactly ONE submit, for NUDGE_ONE alone", countOf(PASTE_START) - pasteBefore === 1);
    check("(A) turn 1: NUDGE_TWO is NOT folded into NUDGE_ONE's turn — the sentinel never coalesced them",
      !written().includes("SYSTEM_NUDGE_TWO"));
    check("(A) turn 1: NUDGE_TWO is still queued, untouched", JSON.stringify(host.getPending(recipient)) === JSON.stringify(["SYSTEM_NUDGE_TWO"]));
    await sleep(250);

    pasteBefore = countOf(PASTE_START);
    host.deliverHook(recipient, { hook_event_name: "Stop" });
    check("(A) turn 2: exactly ONE submit, for NUDGE_TWO ALONE — confirms the pair needed two separate turns",
      countOf(PASTE_START) - pasteBefore === 1);
    check("(A) turn 2: queue now empty — both nudges eventually delivered as TWO separate turns", host.getPending(recipient).length === 0);
  }

  // ===================== (B) sanity: a REAL sender id is unaffected by the sentinel null-map =====================
  {
    const mgr = `sysent-b-mgr-${sfx}`, wkr = `sysent-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    const { written, countOf } = spawnReady(wkr);
    primeBusy(wkr);
    await sleep(250);

    sessions.messageWorker(mgr, wkr, "real sender message one");
    sessions.messageWorker(mgr, wkr, "real sender message two");
    check("(B) setup: both messages queued", host.getPending(wkr).length === 2);

    const pasteBefore = countOf(PASTE_START);
    host.deliverHook(wkr, { hook_event_name: "Stop" });
    check("(B) a REAL sender id still coalesces into ONE turn — the sentinel fix did not regress DoD-1",
      countOf(PASTE_START) - pasteBefore === 1 && host.getPending(wkr).length === 0);
    check("(B) both bodies landed in that one turn", written().includes("real sender message one") && written().includes("real sender message two"));
  }

  db.close();
} finally {
  for (const fake of fakes) { try { fake.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the \"system\" sentinel sender is null-mapped before it reaches enqueueStdin's coalescing/reorder identity, so unrelated daemon-generated agent-kind notices never coalesce with each other; a real sender id still coalesces exactly as card e01687ea intends."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
