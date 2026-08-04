import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9315ddf9 — a re-escalation either lost its new evidence (deduped, appended nothing) or
// fragmented the finding (a retitled follow-up minted a brand-new card with no link back).
// EVIDENCE (incident f91c8634 / platform cards 36160d67 / 36a3cad6): the SAME live incident hit
// BOTH failure modes in OPPOSITE directions while a Codescape manager sent follow-up evidence.
//
// Proves the three regression tests the card names:
//   (1) a re-escalation with the SAME title APPENDS its new detail and PRESERVES whatever body
//       content is already on the card (including a Lead's own triage note, which REPLACES the
//       body when filed — an append must build on top of that, never clobber it).
//   (2) a re-escalation with a CHANGED title never silently orphans the finding: with exactly ONE
//       other still-open escalation from the same manager session, it auto cross-links both cards
//       (mirrors the board's own project_task_create supersedes/relatedTo back-link); with TWO OR
//       MORE candidates, linking is genuinely ambiguous, so it does NOT guess — it surfaces every
//       candidate via `possiblyRelatedTaskIds` and touches neither existing card's body.
//   (3) a severity bump on a still-open title (the one path that already got THROUGH the dedup
//       gate per card 97c2c37b) never arrives with an empty payload — the bumped re-escalation's
//       detail is appended to the reused task's body, not just filed as a bare event.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP
// layer; platform-escalate-dedup.mjs already covers the dedup-vs-fresh-file wiring this builds on).
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-append.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escappend-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// No live Lead in this test — mirrors platform-escalate-dedup.mjs; append/link behavior is
// independent of whether a Lead is live to be nudged.
class SeamHost extends createSeamHost(PtyHost) {
  enqueueStdin() { throw new Error("no live Lead in this test — enqueueStdin should never be reached"); }
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
db.insertProject({ id: "pOrd", name: "Ordinary", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentMgr", projectId: "pOrd", name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
db.insertSession({
  id: "MGR", projectId: "pOrd", agentId: "agentMgr", engineSessionId: null, title: null, cwd: tmpHome,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

try {
  // ===================== (1) SAME title: append, never clobber =====================
  const TITLE1 = "worker_merge gate hangs on a slow build";
  const esc1 = svc.platformEscalate("MGR", { title: TITLE1, detail: "D1: three workers stalled 4+ min.", severity: "medium" });
  check("(1) 1st escalation files a fresh task", !!esc1.taskId && esc1.created === true);
  const bodyAfter1 = db.getTask(esc1.taskId).body;
  check("(1) fresh task body carries the original detail", bodyAfter1.includes("D1: three workers stalled"));

  const esc2 = svc.platformEscalate("MGR", { title: TITLE1, detail: "D2: now reproduces on every 3rd run.", severity: "medium" });
  check("(1) same-title re-escalation reuses the SAME taskId", esc2.taskId === esc1.taskId);
  check("(1) same-title re-escalation reports deduped:true, appended:true", esc2.deduped === true && esc2.appended === true);
  const bodyAfter2 = db.getTask(esc1.taskId).body;
  check("(1) the ORIGINAL detail is still present after the append", bodyAfter2.includes("D1: three workers stalled"));
  check("(1) the NEW detail was appended", bodyAfter2.includes("D2: now reproduces on every 3rd run."));
  check("(1) the append is timestamped/attributed (a Re-escalation section, not a silent splice)",
    bodyAfter2.includes("## Re-escalation") && bodyAfter2.includes("MGR"));

  // A Lead's triage note REPLACES the body (the exact combination the card calls out as the worst
  // case: Mode A + a triage note leaves NEITHER the original nor the new evidence). Simulate that,
  // then re-escalate again with the SAME title — the append must build on top of the triage note,
  // not resurrect the old body and not get silently dropped by it.
  db.updateTask(esc1.taskId, { body: "LEAD TRIAGE: investigating, looks host-related." });
  const esc3 = svc.platformEscalate("MGR", { title: TITLE1, detail: "D3: repro'd on a clean host too.", severity: "medium" });
  check("(1) a 3rd re-escalation after a Lead triage note also dedupes+appends", esc3.taskId === esc1.taskId && esc3.deduped === true && esc3.appended === true);
  const bodyAfter3 = db.getTask(esc1.taskId).body;
  check("(1) the Lead's triage note SURVIVES the append (not clobbered)", bodyAfter3.includes("LEAD TRIAGE: investigating"));
  check("(1) the newest evidence is ALSO present alongside the triage note", bodyAfter3.includes("D3: repro'd on a clean host too."));

  // Resolve section (1)'s thread before starting section (2) — the auto-link candidate scan below
  // is scoped to STILL-OPEN escalations from this manager session, so a resolved thread from an
  // earlier, unrelated finding must not count as a live candidate (mirrors the dedup test's own
  // "resolved" transition via a terminal columnKey).
  db.updateTask(esc1.taskId, { columnKey: "done" });

  // ===================== (2) CHANGED title: never silently orphan =====================
  // Exactly ONE other still-open escalation from this manager session ⇒ auto cross-link both ways.
  const TITLE2 = "gate queue depth spikes under load";
  const esc4 = svc.platformEscalate("MGR", { title: TITLE2, detail: "queue depth hit 40", severity: "medium" });
  check("(2) a genuinely new title (2nd open finding from this session) files fresh, unlinked so far",
    !!esc4.taskId && esc4.created === true && esc4.linkedTaskId === undefined);

  const TITLE2B = "gate queue depth spikes under load — now confirmed host-wide";
  const esc5 = svc.platformEscalate("MGR", { title: TITLE2B, detail: "confirmed across 3 hosts", severity: "medium" });
  check("(2) a retitled follow-up (exactly one open candidate) mints a new card", !!esc5.taskId && esc5.created === true && esc5.taskId !== esc4.taskId);
  check("(2) ...and reports linkedTaskId pointing at the prior open card (never silently orphaned)", esc5.linkedTaskId === esc4.taskId);
  const t4Body = db.getTask(esc4.taskId).body;
  const t5Body = db.getTask(esc5.taskId).body;
  check("(2) the OLDER card is back-noted with a pointer to the NEW one", t4Body.includes(`Related to: ${esc5.taskId}`));
  check("(2) the NEW card is forward-noted with a pointer to the OLDER one", t5Body.includes(`Related to: ${esc4.taskId}`));

  // TWO OR MORE candidates ⇒ genuinely ambiguous — must NOT guess a link (a wrong link is the
  // fragmentation bug running in reverse: it invites merging two distinct findings).
  const TITLE3 = "a completely unrelated third finding, same manager session";
  const esc6 = svc.platformEscalate("MGR", { title: TITLE3, detail: "unrelated to the gate queue issue", severity: "low" });
  check("(3rd open finding) files fresh", !!esc6.taskId && esc6.created === true);

  const TITLE4 = "yet another retitle, now with 3 open candidates to choose from";
  const esc7 = svc.platformEscalate("MGR", { title: TITLE4, detail: "which of the 3 open findings is this?", severity: "low" });
  check("(2) with 2+ open candidates, the new card is still created", !!esc7.taskId && esc7.created === true);
  check("(2) ...but it does NOT guess a link", esc7.linkedTaskId === undefined);
  check("(2) ...it surfaces every candidate instead", Array.isArray(esc7.possiblyRelatedTaskIds)
    && esc7.possiblyRelatedTaskIds.length === 3
    && esc7.possiblyRelatedTaskIds.includes(esc4.taskId)
    && esc7.possiblyRelatedTaskIds.includes(esc5.taskId)
    && esc7.possiblyRelatedTaskIds.includes(esc6.taskId));
  const t4BodyAfterAmbiguous = db.getTask(esc4.taskId).body;
  const t6BodyAfterAmbiguous = db.getTask(esc6.taskId).body;
  check("(2) an ambiguous candidate's body is left UNTOUCHED (no false link written)",
    !t4BodyAfterAmbiguous.includes(`Related to: ${esc7.taskId}`) && !t6BodyAfterAmbiguous.includes(`Related to: ${esc7.taskId}`));

  // ===================== (3) severity bump: payload must arrive with it =====================
  const TITLE5 = "orchestration poll loop backs up under a slow gate";
  const esc8 = svc.platformEscalate("MGR", { title: TITLE5, detail: "poll lag ~2s, tolerable", severity: "low" });
  check("(4th open finding, own thread) files fresh", !!esc8.taskId && esc8.created === true);

  const escBump = svc.platformEscalate("MGR", { title: TITLE5, detail: "poll lag now 45s, workers timing out", severity: "critical" });
  check("(3) a severity bump on a still-open title reuses the SAME task", escBump.taskId === esc8.taskId);
  check("(3) a severity bump is NOT reported as a plain dedup (it's genuinely new information)", !escBump.deduped);
  check("(3) a severity bump DOES report appended:true — the payload travels with the bump", escBump.appended === true);
  const bumpBody = db.getTask(esc8.taskId).body;
  check("(3) the ORIGINAL (low-severity) detail is still on the card", bumpBody.includes("poll lag ~2s, tolerable"));
  check("(3) the BUMPED detail — the actual payload behind the high-severity nudge — is on the card too",
    bumpBody.includes("poll lag now 45s, workers timing out"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a same-title re-escalation appends its new evidence without ever clobbering an existing body (including a Lead's own triage note); a retitled follow-up cross-links automatically when exactly one open candidate exists and refuses to guess when the link is ambiguous, surfacing every candidate instead; and a severity bump always arrives with the detail that justifies it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
