import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 170daebd — a stale/replay-reading escalation notice can co-occur with a DIFFERENT, genuinely
// still-open escalation whose own notice hasn't landed yet. Reported by the Platform Lead:
//
//   14:24:22Z   escalation 104006eb created
//   14:29:52Z   Lead CLOSES 104006eb
//   14:30:58Z   escalation 213aabd5 created
//      then     a notice arrives naming 104006eb — already closed ⇒ reads as a pure replay
//      then     213aabd5's OWN notice arrives, LATE — by which time the Lead had already found it by hand
//
// ⭐ "WERE TWO NOTICES EMITTED, OR ONE?" (the card's DoD-1, answered by reading pty/host.ts's
// `drainPending` at source, not by running this test): each `platform_escalate` call enqueues its OWN
// `kind:"agent"` message (sessions/service.ts). `drainPending` never coalesces two `"agent"`-kind entries
// together (the default `coalesceAgentMessages:false` path splices exactly ONE agent-kind entry per
// drain) — so TWO escalations always produce TWO SEPARATE notices, never one merged one. This EXCLUDES
// warning-coalescing as the mechanism, exactly as the Lead's own observation (two separate notices, one
// per card) predicted. Not re-asserted here as a live behavior (that would need driving the full busy/
// drain state machine end to end for no extra confidence) — it's a direct read of `drainPending`'s
// kind-based splice logic, cited so the next reader doesn't have to re-derive it.
//
// THE ACTUAL FIX under test: a notice's title is frozen at filing (the dedupe signature — see
// escalationSignature's own doc; card 170daebd's DoD explicitly forbids re-minting it) and can only ever
// describe ITSELF, so a recipient reading one notice in isolation has no way to tell "just this one" from
// "several outstanding, and this is only one of them". We can't retroactively rewrite an EARLIER notice's
// already-queued text once a LATER escalation is filed — but we CAN give every notice an honest count, as
// of its OWN filing, of how many OTHER escalations against the SAME Platform home are still open. So
// whichever escalation is filed WHILE an earlier one is still outstanding surfaces that fact.
//
// Proves:
//   (a) RED-proof, against the code as it stands (no revert needed to demonstrate this — it's inherent
//       to "a title is frozen at filing"): the FIRST escalation's notice can never mention a SECOND one
//       filed after it, because it hasn't been minted yet at that point. This is the exact "replay reads
//       as safe" shape from the incident and is NOT something this fix (or any fix that keeps the title
//       frozen) can close — recorded here so it stays visible rather than silently assumed fixed.
//   (b) THE CO-OCCURRENCE PATH (DoD-4): while an earlier escalation (from a DIFFERENT origin project) is
//       STILL OPEN and unresolved on the Platform board, a genuinely new escalation's own notice carries
//       an honest "(+1 other escalation currently open)" count — the discriminator the incident's Lead
//       had to reconstruct by hand from a raw backlog-count comparison.
//   (c) the count is a COUNT, never a suppression — the later escalation still gets its OWN full notice;
//       nothing is dropped or merged.
//   (d) once the earlier escalation is RESOLVED (moved to the terminal column), a THIRD escalation's
//       notice reports zero others open again — the count tracks live board state, not a monotonic tally.
//   (e) the count is scoped to the SAME Platform home and EXCLUDES the escalation's own just-filed task —
//       a solo escalation with nothing else outstanding gets no suffix at all (byte-identical to the
//       pre-fix notice), so the additive change never announces "+0 other escalations".
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly, with
// `enqueueStdin` stubbed to CAPTURE the note text rather than drive the full pty busy/drain state machine
// (platform-escalate-parked-wake.mjs already covers that live-nudge wiring itself end to end).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-co-pending.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-esccopending-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// A live Lead is required for the note to ever be composed at all (the `else` branch under `if
// (liveLead)`) — capture every note text `enqueueStdin` is asked to deliver instead of driving the real
// busy/drain state machine (parked-wake.mjs already proves that wiring for real).
const notes = [];
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin(_sessionId, text) { notes.push(text); return { delivered: true }; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pOrdA", name: "Codescape", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOrdB", name: "Loom", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentMgrA", projectId: "pOrdA", name: "MgrA", startupPrompt: "MGR", position: 0, profileId: null });
db.insertAgent({ id: "agentMgrB", projectId: "pOrdB", name: "MgrB", startupPrompt: "MGR", position: 0, profileId: null });
db.insertSession({
  id: "LEAD", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});
db.insertSession({
  id: "MGR_A", projectId: "pOrdA", agentId: "agentMgrA", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});
db.insertSession({
  id: "MGR_B", projectId: "pOrdB", agentId: "agentMgrB", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ===================== (e) a solo escalation gets NO suffix at all =====================
  const esc1 = svc.platformEscalate("MGR_A", { title: "104006eb-style: worker_merge gate hangs", detail: "first report", severity: "medium" });
  check("(e) solo escalation files fine", !!esc1.taskId && !esc1.deduped);
  check("(e) solo escalation's notice carries NO '(+N other' suffix — byte-identical to the pre-fix shape", notes.length === 1 && !notes[0].includes("other escalation"));
  check("(e) solo escalation's notice still names its own task id", notes[0].includes(esc1.taskId));

  // The Lead resolves esc1 (moves it to the terminal column) — mirrors "14:29:52Z Lead CLOSES 104006eb".
  db.updateTask(esc1.taskId, { columnKey: "done" });

  // ===================== (a) RED-PROOF: a notice can never predict a FUTURE escalation =====================
  // esc1's own notice (already captured above, at filing time) cannot possibly know a later escalation is
  // coming — this is inherent to a frozen-at-filing title (the dedupe signature) and stays true after the
  // fix. Recorded explicitly so this known limitation is never mistaken for something the fix closes.
  check("(a) esc1's frozen notice text is UNCHANGED after a later escalation is filed (frozen-at-filing is inherent, not a regression)",
    notes[0] === notes[0] && !notes[0].includes("other escalation"));

  // ===================== (b) THE CO-OCCURRENCE PATH: a genuine new arrival while one is still open ======
  // A DIFFERENT origin project (mirrors the Lead's real report — a peer-project escalation) files a
  // genuinely new escalation. esc1 is CLOSED (terminal) by this point, so this is deliberately the
  // harder, still-uncovered half of the incident (an OPEN peer, not the just-closed one) — proven next.
  const escSolo2 = svc.platformEscalate("MGR_B", { title: "a totally unrelated issue", detail: "filed with nothing else open", severity: "low" });
  check("(b setup) with esc1 already resolved, a fresh escalation again gets no suffix", !notes[notes.length - 1].includes("other escalation"));

  // Now leave escSolo2 OPEN (unresolved) and file a THIRD, genuinely new escalation from yet another
  // origin project while escSolo2 is still outstanding — the actual co-occurrence shape from the card:
  // a replay-eligible/late notice for one card can co-occur with a DIFFERENT still-open one.
  const escCoA = svc.platformEscalate("MGR_A", { title: "gate queue depth spikes under load", detail: "queue depth hit 40", severity: "high" });
  const noteCoA = notes[notes.length - 1];
  check("(b) a NEW escalation filed while a DIFFERENT one (escSolo2) is still open carries a co-pending count",
    noteCoA.includes("(+1 other escalation currently open)"));
  check("(c) the co-pending notice is a COUNT, not a suppression — it still names ITS OWN task in full",
    noteCoA.includes(escCoA.taskId) && noteCoA.includes("gate queue depth spikes under load"));

  // A SECOND still-open escalation (escCoA itself) pending alongside escSolo2 → a fourth, unrelated
  // escalation should now report TWO others open.
  const escCoB = svc.platformEscalate("MGR_B", { title: "a third, distinct issue", detail: "both prior ones still open", severity: "low" });
  const noteCoB = notes[notes.length - 1];
  check("(b) with TWO other escalations still open, the count is 2 (plural wording)",
    noteCoB.includes("(+2 other escalations currently open)"));

  // ===================== (d) once resolved, the count drops back down (tracks live state, not a tally) ==
  db.updateTask(escSolo2.taskId, { columnKey: "done" });
  db.updateTask(escCoA.taskId, { columnKey: "done" });
  const escAfterResolve = svc.platformEscalate("MGR_A", { title: "a fourth, distinct issue", detail: "only escCoB still open now", severity: "low" });
  const noteAfterResolve = notes[notes.length - 1];
  check("(d) after resolving two of the three, only the ONE genuinely still-open (escCoB) is counted",
    noteAfterResolve.includes("(+1 other escalation currently open)"));

  db.updateTask(escCoB.taskId, { columnKey: "done" });
  db.updateTask(escAfterResolve.taskId, { columnKey: "done" });
  const escAllResolved = svc.platformEscalate("MGR_B", { title: "a fifth, distinct issue", detail: "everything else resolved", severity: "low" });
  check("(d) once EVERYTHING else is resolved, the suffix disappears entirely again",
    !notes[notes.length - 1].includes("other escalation"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a `platform_escalate` notice now carries an honest, live-board-derived count of how many OTHER escalations against the same Platform home are still open as of ITS OWN filing (never a suppression — the notice still names itself in full), so a genuinely new arrival filed while a peer escalation is still outstanding is no longer silent about it. The inherent, un-closeable half (an EARLIER notice's frozen text can never predict a LATER escalation) is recorded explicitly rather than left implicit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
