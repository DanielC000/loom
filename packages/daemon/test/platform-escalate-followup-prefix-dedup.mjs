import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 83b243f8 — `platform_escalate`'s `followUpOn` resolver reports a UNIQUE task id as AMBIGUOUS.
//
// ROOT CAUSE (service.ts, the `followUpOn` branch): `ownEscalationTasks` is built by pushing one Task
// per ESCALATION ROW (`listEscalationsForProject` returns `orchestration_events` rows, not distinct
// tasks) — never deduped by taskId. A thread with N follow-ups on the SAME task therefore has that
// task's id appear N times in the candidate list handed to `getByIdPrefix`. Passing the FULL id still
// works (`.find` returns the first match regardless of duplicates), but an 8-char PREFIX falls through
// to `resolveIdPrefix`'s `matches.length > 1` branch — N identical entries ⇒ `matches.length === N` ⇒ a
// false "ambiguous" naming the SAME id N times. Self-worsening: every follow-up filed on a thread makes
// that thread's own prefix harder to resolve.
//
// ⛔ The fix belongs at THIS call site (dedupe the candidate list by taskId) — NOT inside
// `id-prefix.ts`/`resolveIdPrefix`/`getByIdPrefix`, which must keep reporting genuine ambiguity across
// genuinely DISTINCT task ids. Part (3) below is the guard against a fix that (wrongly) dedupes inside
// the generic resolver and masks that real case.
//
// Proves:
//   (1) ⭐ THE REPORTED BUG, reproduced via real usage (no synthetic fixture): a task with 3 escalation
//       rows (mirrors the real `2ae36814`/`77dc70c2` cards named on the board card) fails to resolve by
//       its own unique 8-char prefix before the fix, and appends cleanly onto the SAME task after it.
//   (2) NEGATIVE CONTROL: a task with exactly ONE escalation row resolves by prefix fine (both before
//       and after) — proves the fix doesn't merely widen matching, and that single-follow-up threads
//       were never broken.
//   (3) ⛔ GUARD: two genuinely DISTINCT tasks whose ids happen to share an 8-char prefix are STILL
//       reported ambiguous, naming both real ids — a dedupe-by-taskId fix must never collapse this into
//       a false unique match.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE — a REAL Db + SessionService driven directly (no MCP
// layer), mirroring platform-escalate-followup.mjs's harness exactly.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-escalate-followup-prefix-dedup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-escprefixdedup-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// No live Lead in this test — mirrors platform-escalate-followup.mjs; the defect is independent of
// whether a Lead is live to be nudged.
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
  // ===== (1) THE REPORTED BUG: a thread with 3 escalation rows on ONE task, resolved by its own prefix =====
  const escA = svc.platformEscalate("MGR", { title: "gate lane starves under a slow build", detail: "first sighting", severity: "low" });
  check("(setup) 1st escalation files a fresh task", !!escA.taskId && escA.created === true);
  svc.platformEscalate("MGR", { title: "follow-up 2", detail: "2nd row on the same thread", followUpOn: escA.taskId });
  svc.platformEscalate("MGR", { title: "follow-up 3", detail: "3rd row on the same thread", followUpOn: escA.taskId });
  const rowsA = db.listEscalationsForProject("pOrd").filter((e) => e.taskId === escA.taskId);
  check("(setup) task A now has 3 escalation rows (mirrors the real 77dc70c2/2ae36814 cards)", rowsA.length === 3);

  const prefixA = escA.taskId.slice(0, 8);
  let threwAmbiguous = false;
  let ambiguousMessage = "";
  try {
    svc.platformEscalate("MGR", { title: "follow-up via prefix", detail: "4th row, referenced by 8-char prefix", followUpOn: prefixA });
  } catch (e) {
    threwAmbiguous = /ambiguous/i.test(e.message);
    ambiguousMessage = e.message;
  }
  check(`(1) ⭐ THE BUG (pre-fix) / FIXED (post-fix): resolving task A's OWN unique 8-char prefix must NOT throw "ambiguous" (saw: ${threwAmbiguous ? ambiguousMessage : "no throw"})`,
    threwAmbiguous === false);

  // Re-run for real once the guard above tells us it didn't throw, to confirm the append actually landed
  // on the SAME task (not a coincidental non-throw with no effect).
  const escF = svc.platformEscalate("MGR", { title: "follow-up via prefix (real)", detail: "prefix-addressed follow-up", followUpOn: prefixA });
  check("(1) the prefix-addressed follow-up reuses task A's id, not a fork", escF.taskId === escA.taskId);
  check("(1) outcome:\"appended\"", escF.outcome === "appended");
  const bodyA = db.getTask(escA.taskId).body;
  check("(1) the prefix-addressed detail actually landed on task A's body", bodyA.includes("prefix-addressed follow-up"));

  // ===== (2) NEGATIVE CONTROL: a single-row thread resolves by its own prefix, unaffected by the fix =====
  const escG = svc.platformEscalate("MGR", { title: "a lone, never-followed-up finding", detail: "g", severity: "low" });
  const rowsG = db.listEscalationsForProject("pOrd").filter((e) => e.taskId === escG.taskId);
  check("(setup) task G has exactly 1 escalation row", rowsG.length === 1);
  const prefixG = escG.taskId.slice(0, 8);
  let threwG = false;
  try { svc.platformEscalate("MGR", { title: "follow-up on G via prefix", detail: "h", followUpOn: prefixG }); }
  catch { threwG = true; }
  check("(2) a single-row thread's own prefix resolves fine (both before and after the fix)", threwG === false);

  // ===== (3) ⛔ GUARD: genuine cross-task ambiguity (two DISTINCT tasks sharing an 8-char prefix) must =====
  // ===== still be reported — proves the fix dedupes by TASK, not by discarding real ambiguity =====
  const sharedPrefix = "deadbeef";
  const idX = `${sharedPrefix}-1111-4111-8111-111111111111`;
  const idY = `${sharedPrefix}-2222-4222-8222-222222222222`;
  for (const id of [idX, idY]) {
    db.insertTask({ id, projectId: "pHome", title: `guard task ${id}`, body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
    db.appendEvent({
      id: `${id}-evt`, ts: now, managerSessionId: "MGR", taskId: id, kind: "platform_escalate",
      detail: { originProjectId: "pOrd", severity: "low", platformProjectId: "pHome", title: `guard task ${id}` },
    });
  }
  let threwCrossTaskAmbiguous = false;
  let crossTaskMessage = "";
  try {
    svc.platformEscalate("MGR", { title: "attempted prefix follow-up", detail: "should be rejected as genuinely ambiguous", followUpOn: sharedPrefix });
  } catch (e) {
    threwCrossTaskAmbiguous = /ambiguous/i.test(e.message);
    crossTaskMessage = e.message;
  }
  check("(3) ⛔ two DISTINCT tasks sharing a prefix are STILL reported ambiguous (dedupe must not mask real ambiguity)",
    threwCrossTaskAmbiguous === true);
  check("(3) …and the error names BOTH real, distinct ids (not the same id twice)",
    crossTaskMessage.includes(idX) && crossTaskMessage.includes(idY));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — followUpOn's candidate list is deduped by task id, so a thread's own unique 8-char prefix resolves regardless of how many follow-ups it has accumulated, while two genuinely distinct tasks sharing a prefix are still correctly reported ambiguous."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
