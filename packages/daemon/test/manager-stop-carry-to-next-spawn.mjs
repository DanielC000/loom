import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a84e5d67 part 1 — a STOPPED manager's undelivered durable inbound queue is carried to the project's
// NEXT manager on spawn (not a recycle successor), labelled `[loom:carried-from <old8>]`, instead of being
// left unresolved on a dead recipient.
//
// Proves (real Db + SessionService + a fake-pty seam host, no claude, no daemon):
//   (1) a stopped manager with two unresolved durable rows → a fresh startManager for the SAME agent gets
//       both re-minted as unresolved rows naming the fresh manager, each text starting with the carried-from
//       label; the old rows are resolved "superseded" and linked old→new via session_message_gave_up.
//   (2) a possible-duplicate tag stays FIRST, ahead of the carried-from label (decision 248abf9b).
//   (3) NEGATIVES (each must carry nothing): a stale context-recycle nudge row, a manager of a DIFFERENT
//       agent, and a recycle-superseded manager.
//   (4) a RESOLVED (already delivered) row is not carried.
//   (5) only the single most recent candidate WITH rows is carried: a second spawn RE-CARRIES the first
//       spawn's still-unresolved carried rows (it is now the most recent stopped manager with rows) and does
//       NOT pull the older stopped manager's leftover rows forward.
//   (6) BOUNDS — carried: agent-authored rows only. NOT carried: a kind:"warning" row, a sender:"system" row,
//       a row older than 7 days, a row a redrive would retire as stale (a later redirect_worker).
//   (7) labels do not STACK: an already `[loom:carried-from …]`-labelled row is re-labelled once, not twice.
//   (8) the startNew branch (a profile-resolved manager role) carries too.
//   (9) a carry whose re-mint FAILS boards a card (never silently dropped) and the spawn still succeeds.
// Run: 1) pnpm build, 2) node test/manager-stop-carry-to-next-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mscn-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const repo = path.join(os.tmpdir(), `loom-mscn-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# mscn\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=mscn@loom -c user.name=mscn");

const now = new Date().toISOString();
const db = new Db();

class SeamHost extends createSeamHost(PtyHost) {
  aliveIds = new Set();
  createPty(opts, hookToken, mcpToken) { this.aliveIds.add(opts.sessionId); return super.createPty(opts, hookToken, mcpToken); }
  stop(id) { this.aliveIds.delete(id); }
  isAlive(id) { return this.aliveIds.has(id); }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

db.insertProject({ id: "pM", name: "MSCN", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
for (const [i, a] of ["agX", "agY", "agZ", "agS", "agE", "agB"].entries()) {
  db.insertAgent({ id: a, projectId: "pM", name: a, startupPrompt: "MGR", position: i, profileId: null });
}

const insertMgr = (id, agentId, extra = {}) => db.insertSession({
  id, projectId: "pM", agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited",
  resumability: "unknown", busy: false, createdAt: new Date(Date.now() - 60_000).toISOString(), lastActivity: now, lastError: null, role: "manager", ...extra,
});
const queue = (recipientId, text, { resolved = false, sender = "some-worker", kind, ts = now } = {}) => {
  const msgId = randomUUID();
  db.appendEvent({ id: randomUUID(), ts, managerSessionId: sender, workerSessionId: recipientId, taskId: null, kind: "session_message_queued", detail: { msgId, text, sender, ...(kind ? { kind } : {}) } });
  if (resolved) db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: "", workerSessionId: recipientId, taskId: null, kind: "session_message_delivered", detail: { msgId } });
  return msgId;
};
const unresolvedTexts = (id) => db.listUnresolvedQueuedMessagesForWorker(id).map((e) => e.detail?.text);

try {
  // ── (1)(2)(4) agX: a stopped manager with real rows ────────────────────────────────────────────────────
  insertMgr("oldmgrX1", "agX");
  const m1 = queue("oldmgrX1", "worker says: item one");
  queue("oldmgrX1", "worker says: item two");
  queue("oldmgrX1", "[loom:possible-duplicate root:abcdef12] worker says: dup framed");
  queue("oldmgrX1", "already delivered text", { resolved: true });
  queue("oldmgrX1", "[loom:context] stale recycle nudge");
  const fX = svc.startManager("agX");
  const got = unresolvedTexts(fX.id);
  check("(1) both plain rows re-minted on the fresh manager with the carried-from label",
    got.includes("[loom:carried-from oldmgrX1]\nworker says: item one") && got.includes("[loom:carried-from oldmgrX1]\nworker says: item two"));
  check("(2) a possible-duplicate tag stays FIRST, ahead of the label",
    got.includes("[loom:possible-duplicate root:abcdef12] [loom:carried-from oldmgrX1]\nworker says: dup framed"));
  check("(4) the already-delivered row was NOT carried", !got.some((t) => t?.includes("already delivered text")));
  check("(3a) a stale context-recycle nudge was NOT carried", !got.some((t) => t?.includes("stale recycle nudge")));
  check("(1) the old plain rows are resolved (superseded) on the stopped manager",
    !unresolvedTexts("oldmgrX1").some((t) => t?.startsWith("worker says")));
  check("(1) old→new msgId link recorded (session_message_gave_up outcome:reminted)",
    db.listEventsForWorker(fX.id).some((e) => e.kind === "session_message_gave_up" && e.detail?.msgId === m1 && e.detail?.outcome === "reminted"));
  check("(3a) the stale nudge row stays unresolved on the old manager (untouched, not carried)",
    unresolvedTexts("oldmgrX1").some((t) => t?.includes("stale recycle nudge")));

  // ── (5) a second spawn after the first has live-stopped does not re-carry the already-carried rows ─────
  host.stop(fX.id); db.setProcessState(fX.id, "exited");
  const fX2 = svc.startManager("agX");
  check("(5) fX2 carried fX's still-unresolved rows (fX is the most recent stopped manager with rows)",
    unresolvedTexts(fX2.id).some((t) => t?.includes("worker says: item one")));
  check("(5) oldmgrX1's remaining stale nudge is NOT pulled forward by fX2 (most-recent-candidate-with-rows only)",
    !unresolvedTexts(fX2.id).some((t) => t?.includes("stale recycle nudge")));

  // ── (3b) a manager of a DIFFERENT agent is never a source ─────────────────────────────────────────────
  insertMgr("oldmgrY1", "agY");
  queue("oldmgrY1", "belongs to agY");
  const fZ = svc.startManager("agZ");
  check("(3b) a stopped manager of a DIFFERENT agent is not carried", unresolvedTexts(fZ.id).length === 0);
  check("(3b) agY's row stays unresolved on its own manager", unresolvedTexts("oldmgrY1").includes("belongs to agY"));

  // ── (3c) a recycle-SUPERSEDED manager is never a source (its recycle carry owns its queue) ────────────
  insertMgr("oldmgrS1", "agS");
  queue("oldmgrS1", "belongs to a recycled predecessor");
  insertMgr("succS", "agS", { recycledFrom: "oldmgrS1", createdAt: new Date(Date.now() - 30_000).toISOString() });
  const fS = svc.startManager("agS");
  check("(3c) a recycle-superseded manager's queue is not carried", unresolvedTexts(fS.id).length === 0);

  // ── (6)(7) BOUNDS + no label stacking on agB ──────────────────────────────────────────────────────────
  insertMgr("oldmgrB1", "agB");
  queue("oldmgrB1", "STALE-ROW worker says: superseded");
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 1).toISOString(), managerSessionId: "x", workerSessionId: "oldmgrB1", taskId: null, kind: "redirect_worker", detail: { queuedMsgId: "unrelated" } });
  const later = new Date(Date.now() + 5).toISOString();
  queue("oldmgrB1", "AGENT-OK worker says: keep me", { ts: later });
  queue("oldmgrB1", "WARNING-ROW idle notice", { ts: later, kind: "warning", sender: "system" });
  queue("oldmgrB1", "SYSTEM-SENDER agent-kind row", { ts: later, sender: "system" });
  queue("oldmgrB1", "AGED-ROW worker says: too old", { ts: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  queue("oldmgrB1", "[loom:carried-from deadbeef]\nSTACKED-ROW worker says: relabel me", { ts: later });
  const fB = svc.startManager("agB");
  const gotB = unresolvedTexts(fB.id);
  check("(6) the agent-authored row IS carried", gotB.includes("[loom:carried-from oldmgrB1]\nAGENT-OK worker says: keep me"));
  check("(6) a kind:warning row is NOT carried", !gotB.some((t) => t?.includes("WARNING-ROW")));
  check("(6) a sender:system row is NOT carried", !gotB.some((t) => t?.includes("SYSTEM-SENDER")));
  check("(6) a row older than 7 days is NOT carried", !gotB.some((t) => t?.includes("AGED-ROW")));
  check("(6) a row a redrive would retire as stale is NOT carried", !gotB.some((t) => t?.includes("STALE-ROW")));
  check("(7) labels do not stack — exactly one carried-from label, the new one",
    gotB.includes("[loom:carried-from oldmgrB1]\nSTACKED-ROW worker says: relabel me") && !gotB.some((t) => /carried-from deadbeef/.test(t ?? "")));

  // ── (8) the startNew branch (profile-resolved manager) carries too ────────────────────────────────────
  db.insertProfile({ id: "profMgrRig", name: "Manager Rig", role: "manager", description: "", allowDelta: [], skills: null, model: null, icon: null });
  db.insertAgent({ id: "agNM", projectId: "pM", name: "NM", startupPrompt: "", position: 9, profileId: "profMgrRig" });
  insertMgr("oldmgrN1", "agNM");
  queue("oldmgrN1", "NEWBRANCH worker says: via startNew");
  const fN = svc.startNew("agNM");
  check("(8) startNew (role resolved to manager) carries the stopped manager's row",
    fN.role === "manager" && unresolvedTexts(fN.id).includes("[loom:carried-from oldmgrN1]\nNEWBRANCH worker says: via startNew"));

  // ── (9) a failed re-mint boards a card and the spawn still succeeds ───────────────────────────────────
  db.insertAgent({ id: "agF", projectId: "pM", name: "F", startupPrompt: "MGR", position: 10, profileId: null });
  insertMgr("oldmgrF1", "agF");
  queue("oldmgrF1", "FAIL-TO-REMINT worker says: boom");
  const orig = SessionService.prototype.enqueueDurableMessage;
  SessionService.prototype.enqueueDurableMessage = function (recipientId, framedText) {
    if (typeof framedText === "string" && framedText.includes("FAIL-TO-REMINT")) throw new Error("injected re-mint failure");
    return orig.apply(this, arguments);
  };
  let fF, threwF = null;
  const tasksBeforeF = db.listTasks("pM").length;
  try { fF = svc.startManager("agF"); } catch (e) { threwF = e; } finally { SessionService.prototype.enqueueDurableMessage = orig; }
  check("(9) the spawn still SUCCEEDS over a failed carry", !threwF && fF?.processState === "live");
  const boarded = db.listTasks("pM").slice(tasksBeforeF).filter((t) => /could not be carried/.test(t.title));
  check("(9) a board card was filed naming the stopped + fresh managers",
    boarded.length === 1 && boarded[0].title.includes("oldmgrF1") && boarded[0].body.includes(fF.id));
  check("(9) the un-carried row is still unresolved on the old manager (not dropped)",
    unresolvedTexts("oldmgrF1").some((t) => t?.includes("FAIL-TO-REMINT")));

  // ── no rows at all → nothing carried, no board card ───────────────────────────────────────────────────
  const tasksBefore = db.listTasks("pM").length;
  const fE = svc.startManager("agE");
  check("(none) a spawn with no stopped manager carries nothing and boards nothing",
    unresolvedTexts(fE.id).length === 0 && db.listTasks("pM").length === tasksBefore);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
