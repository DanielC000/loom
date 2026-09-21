import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card ca0957d7 — the defect: `deferredUntilEvent: {kind:"request-answered", key:"<requestId>"}` had no
// dangling-key detector, unlike `deferredUntilTaskId`'s own `deferredStuck`. If the named Request was later
// cancelled or superseded, the trigger could never fire again, `deferredStuck` stayed `false`, and the card
// sat `deferred:true` forever behind a condition that read live and wasn't. Live specimen: card `45a23c27`.
//
// FIX: `resolveDeferredEffective` (mcp/tasks.ts) now also resolves `deferredUntilEvent` of kind
// `"request-answered"` against the live requests store — see `resolveDeferredEventStuck`'s own doc and
// docs/decisions/ca0957d7-....md for the full contract.
//
// HERMETIC: a real Db (+ a real temp git repo for the ONE scenario, G, that needs a genuine merge) driving
// the built business logic directly (dist/mcp/tasks.js + dist/db.js) — no daemon, no real claude.
//
// Proves:
//   (A) POSITIVE — a blocker-less manual deferral (no deferredUntilTaskId at all) whose deferredUntilEvent
//       key resolves to a CANCELLED request: getProjectTask AND listProjectTasks both surface
//       deferredStuck:true, deferred stays true, the raw DB row self-heals (write-through), and a second
//       read doesn't write-storm it again. This is the exact `45a23c27` specimen shape — it used to
//       short-circuit straight to stuck:false before this card, since ids.length === 0.
//   (B) POSITIVE — a deferredUntilEvent key that never resolves to any request at all (dangling, same
//       shape as a deleted task blocker) also sets deferredStuck:true.
//   (C) NEGATIVE CONTROL — a key resolving to "pending" is NOT stuck (still genuinely live).
//   (D) NEGATIVE CONTROL, the DoD's own companion assertion — a key resolving to "answered" is NOT stuck:
//       that state means the event ALREADY fired; conflating "already fired" with "can never fire" would
//       turn a working queue into false alarms.
//   (E) NEGATIVE CONTROL — a key resolving to "consumed" is likewise NOT stuck, same reasoning as (D).
//   (F) NEGATIVE CONTROL — kind:"gate-fail-naming" never triggers this detector, even naming a key that
//       collides with a real, cancelled request's id — proves the two kinds are resolved independently.
//   (G) SCOPE GUARD — a card deferred on BOTH a real task blocker (which actually merges) AND a cancelled
//       deferredUntilEvent: once the task blocker merges, deferred auto-clears to false and deferredStuck
//       resets to false regardless of the event's own cancelled state — deferredUntilEvent never gates
//       `deferred` itself, only annotates.
//   (H) includeMerged:false — the event-stuck check is NOT gated on includeMerged (unlike the git-derived
//       blocker check): a card with a task blocker (still open, unmerged) AND a cancelled
//       deferredUntilEvent still reads deferredStuck:true even when the git lookup is skipped entirely.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-defer-stuck-event.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-stuck-event-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-stuck-event-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

let qCounter = 0;
function insertQuestion(db, projectId, sessionId, state) {
  const id = `q-${++qCounter}-${process.pid}`;
  db.insertQuestion({
    id, sessionId, projectId, type: "decision", title: `request ${id}`, body: "detail", options: null,
    recommendation: null, taskId: null, permissionAction: null, permissionScopeHint: null,
    permissionExpiresAt: null, credentialEnvVar: null,
    state, chosenOption: state === "answered" || state === "consumed" ? "A" : null, note: null,
    createdAt: now, answeredAt: state === "answered" || state === "consumed" ? now : null,
    consumedAt: state === "consumed" ? now : null,
    cancelledReason: state === "cancelled" ? "superseded" : null,
    cancelledBy: state === "cancelled" ? "agent" : null,
    cancelledAt: state === "cancelled" ? now : null,
  });
  return id;
}

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  const agentId = "it-agent";
  db.insertAgent({ id: agentId, projectId: "pRepo", name: "t", startupPrompt: "orchestrate", position: 0 });
  const sessId = "mgr-filer";
  db.insertSession({
    id: sessId, projectId: "pRepo", agentId, engineSessionId: "eng-" + sessId, title: null, cwd: "pRepo",
    processState: "live", resumability: "resumable", busy: false, role: "manager",
    createdAt: now, lastActivity: now, lastError: null,
  });

  // --- (A) blocker-less manual deferral, event key resolves to a CANCELLED request ---
  const qCancelled = insertQuestion(db, "pRepo", sessId, "cancelled");
  const cardA = createProjectTask(db, "pRepo", { title: "dependent card A" });
  const setA = await updateProjectTask(db, "pRepo", cardA.id, {
    deferred: true, deferredReason: "waiting on the owner's decision", deferredUntilEvent: { kind: "request-answered", key: qCancelled },
  });
  check("(A) set deferred+deferredUntilEvent succeeds (no error)", !("error" in setA));

  let updateTaskCalls = 0;
  const _updateTask = db.updateTask.bind(db);
  db.updateTask = (...args) => { updateTaskCalls++; return _updateTask(...args); };

  updateTaskCalls = 0;
  const gotA = await getProjectTask(db, "pRepo", cardA.id);
  check("(A) scope: deferred stays true — a cancelled request never auto-clears deferred, only annotates", gotA.deferred === true);
  check("(A) getProjectTask: deferredStuck flips true for a cancelled request-answered key", gotA.deferredStuck === true);
  check("(A) the self-heal transition makes EXACTLY ONE db.updateTask call", updateTaskCalls === 1);
  const listA = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowA = listA.find((t) => t.id === cardA.id);
  check("(A) listProjectTasks (the board summary): ALSO surfaces deferredStuck:true", rowA?.deferredStuck === true);
  const rawA = db.getTask(cardA.id);
  check("(A) self-heal: the RAW DB row is persisted deferredStuck=true", rawA.deferredStuck === true);
  check("(A) self-heal did NOT touch deferred or deferredUntilEvent", rawA.deferred === true && rawA.deferredUntilEvent?.key === qCancelled);

  updateTaskCalls = 0;
  const gotASecond = await getProjectTask(db, "pRepo", cardA.id);
  check("(A) second read: still deferredStuck:true", gotASecond.deferredStuck === true);
  check("(A) second read makes ZERO db.updateTask calls (no write-storm)", updateTaskCalls === 0);

  // --- (B) event key that never resolves to any request at all (dangling) ---
  const cardB = createProjectTask(db, "pRepo", { title: "dependent card B" });
  await updateProjectTask(db, "pRepo", cardB.id, {
    deferred: true, deferredReason: "waiting on a request that never existed / was purged",
    deferredUntilEvent: { kind: "request-answered", key: "never-existed-request-id" },
  });
  const gotB = await getProjectTask(db, "pRepo", cardB.id);
  check("(B) scope: still deferred:true", gotB.deferred === true);
  check("(B) a dangling (never-resolving) request-answered key ALSO surfaces deferredStuck:true", gotB.deferredStuck === true);

  // --- (C)/(D)/(E) NEGATIVE CONTROLS — pending / answered / consumed are all NOT stuck ---
  const qPending = insertQuestion(db, "pRepo", sessId, "pending");
  const cardC = createProjectTask(db, "pRepo", { title: "dependent card C (pending)" });
  await updateProjectTask(db, "pRepo", cardC.id, { deferred: true, deferredReason: "still waiting", deferredUntilEvent: { kind: "request-answered", key: qPending } });
  const gotC = await getProjectTask(db, "pRepo", cardC.id);
  check("(C) NEGATIVE CONTROL: a still-pending request-answered key is NOT stuck", gotC.deferredStuck === false);
  check("(C) NEGATIVE CONTROL: stays deferred:true", gotC.deferred === true);

  const qAnswered = insertQuestion(db, "pRepo", sessId, "answered");
  const cardD = createProjectTask(db, "pRepo", { title: "dependent card D (answered)" });
  await updateProjectTask(db, "pRepo", cardD.id, { deferred: true, deferredReason: "event fired, awaiting release judgement", deferredUntilEvent: { kind: "request-answered", key: qAnswered } });
  const gotD = await getProjectTask(db, "pRepo", cardD.id);
  check("(D) NEGATIVE CONTROL (DoD companion assertion): an ANSWERED key is NOT stuck — it already fired", gotD.deferredStuck === false);
  check("(D) NEGATIVE CONTROL: stays deferred:true (release is a reader's judgement call, never automatic)", gotD.deferred === true);

  const qConsumed = insertQuestion(db, "pRepo", sessId, "consumed");
  const cardE = createProjectTask(db, "pRepo", { title: "dependent card E (consumed)" });
  await updateProjectTask(db, "pRepo", cardE.id, { deferred: true, deferredReason: "event fired and pulled", deferredUntilEvent: { kind: "request-answered", key: qConsumed } });
  const gotE = await getProjectTask(db, "pRepo", cardE.id);
  check("(E) NEGATIVE CONTROL: a CONSUMED key is likewise NOT stuck", gotE.deferredStuck === false);

  // --- (F) NEGATIVE CONTROL — gate-fail-naming never triggers this detector, even naming a cancelled request's id ---
  const cardF = createProjectTask(db, "pRepo", { title: "dependent card F (gate-fail-naming)" });
  await updateProjectTask(db, "pRepo", cardF.id, { deferred: true, deferredReason: "waiting on a specific test to go red", deferredUntilEvent: { kind: "gate-fail-naming", key: qCancelled } });
  const gotF = await getProjectTask(db, "pRepo", cardF.id);
  check("(F) NEGATIVE CONTROL: kind gate-fail-naming is never resolved as a request key, even colliding with a cancelled request's id", gotF.deferredStuck === false);

  // --- (G) SCOPE GUARD — a real task blocker merging auto-clears deferred + resets stuck, regardless of a
  // simultaneously-cancelled deferredUntilEvent on the same card ---
  const qForG = insertQuestion(db, "pRepo", sessId, "cancelled");
  const blockerG = createProjectTask(db, "pRepo", { title: "blocker (will actually merge)" });
  const cardG = createProjectTask(db, "pRepo", { title: "dependent card G (blocker + cancelled event, both set)" });
  await updateProjectTask(db, "pRepo", cardG.id, {
    deferred: true, deferredUntilTaskId: blockerG.id, deferredUntilEvent: { kind: "request-answered", key: qForG },
  });
  const gotGBefore = await getProjectTask(db, "pRepo", cardG.id);
  check("(G) precondition: while the blocker is still open, deferredStuck is true (the cancelled event ORs in)", gotGBefore.deferredStuck === true);
  landBlocker(blockerG.id, "feat(x): blocker G actually landed");
  const gotGAfter = await getProjectTask(db, "pRepo", cardG.id);
  check("(G) once the task blocker merges, deferred auto-clears to false regardless of the event's own cancelled state", gotGAfter.deferred === false);
  check("(G) deferredStuck resets to false once deferred auto-clears — never meaningful once deferred is false", gotGAfter.deferredStuck === false);

  // --- (H) includeMerged:false — event-stuck is NOT gated on includeMerged, unlike the blocker check ---
  const qForH = insertQuestion(db, "pRepo", sessId, "cancelled");
  const blockerH = createProjectTask(db, "pRepo", { title: "blocker H (still open, unmerged)" });
  const cardH = createProjectTask(db, "pRepo", { title: "dependent card H (open blocker + cancelled event)" });
  await updateProjectTask(db, "pRepo", cardH.id, {
    deferred: true, deferredUntilTaskId: blockerH.id, deferredUntilEvent: { kind: "request-answered", key: qForH },
  });
  const listH = await listProjectTasks(db, "pRepo", { includeBody: true, includeMerged: false });
  const rowH = listH.find((t) => t.id === cardH.id);
  check("(H) includeMerged:false: the event-stuck half still reads deferredStuck:true (a plain DB read, not git-derived)", rowH?.deferredStuck === true);
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a deferredUntilEvent(kind:request-answered) key that resolves to cancelled/dangling now surfaces deferredStuck:true (self-healing, no write-storm), pending/answered/consumed keys correctly stay NOT stuck, gate-fail-naming is untouched, a merging task blocker still auto-clears deferred regardless of a simultaneously-cancelled event, and the event-stuck check is not gated on includeMerged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
