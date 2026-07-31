import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 793ac76d — make a deferred card's un-defer condition DATA, not prose: an optional
// `deferredUntilTaskId` companion to `deferred` ("deferred until THIS task merges"), auto-cleared at
// READ time (getProjectTask/listProjectTasks, mcp/tasks.ts) once the named blocker's git-derived
// `merged` state resolves non-null — the SAME mechanism task-merged-state.mjs already exercises for
// `merged` itself, reused here rather than any new sync path. HERMETIC: a real temp git repo (execSync)
// + a real Db, driving the built business logic directly (dist/mcp/tasks.js + dist/db.js) — no daemon,
// no real claude.
//
// Proves:
//   (1) POSITIVE CONTROL (DoD 6): a deferred card with a live (unmerged) blocker STAYS deferred:true on
//       BOTH getProjectTask and listProjectTasks — proving the mechanism can show "still blocked" before
//       ever proving it can show "cleared". A test asserting only the cleared end-state proves nothing.
//   (2) Once the blocker lands (a squash commit carrying its `Loom-Worker-Branch:` trailer), BOTH
//       surfaces flip to deferred:false — and the RAW DB row is actually persisted false (a fresh
//       db.getTask, bypassing the MCP layer entirely) — proving the idle-watchdog's direct db.listTasks
//       read also self-heals, not just the MCP response.
//   (3) NO WRITE-STORM: a second read (either surface) after the clear has already landed does not bump
//       `updatedAt` again — the write-through fires exactly once, on the genuine transition, never on an
//       already-cleared row.
//   (4) held is UNTOUCHED by the auto-clear — a card that's both held:true and deferred:true (with a
//       blocker) keeps held:true after the blocker merges; only `deferred` moves.
//   (5) Set-time validation: a self-reference is rejected; an unknown blocker id is rejected — neither
//       write lands.
//   (6) A blocker deleted AFTER being validly set (dangling reference) degrades to "stays deferred" at
//       read time — never throws.
//   (7) Omitting `deferredUntilTaskId` entirely is byte-identical to today: a plain `deferred:true` with
//       no blocker never auto-clears, no matter what else merges.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-defer-until.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-until-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);

const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-until-${Date.now()}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // --- (1)/(2)/(3): main positive-control scenario, both surfaces ---
  const blocker = createProjectTask(db, "pRepo", { title: "blocker card" });
  const dependent = createProjectTask(db, "pRepo", { title: "dependent card" });
  const setResult = await updateProjectTask(db, "pRepo", dependent.id, { deferred: true, deferredUntilTaskId: blocker.id });
  check("set deferred+deferredUntilTaskId succeeds (no error)", !("error" in setResult));

  // (1) POSITIVE CONTROL — blocker still unmerged, card must stay deferred on BOTH surfaces.
  const gotBefore = await getProjectTask(db, "pRepo", dependent.id);
  check("(1) getProjectTask: stays deferred:true while blocker is unmerged", gotBefore.deferred === true);
  const listBefore = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowBefore = listBefore.find((t) => t.id === dependent.id);
  check("(1) listProjectTasks: ALSO stays deferred:true while blocker is unmerged", rowBefore?.deferred === true);
  const rawBefore = db.getTask(dependent.id);
  check("(1) raw DB row also still deferred=true before the blocker lands", rawBefore.deferred === true);

  // (2) land the blocker, then re-read via getProjectTask first.
  landBlocker(blocker.id, "feat(x): blocker landed");
  const gotAfter = await getProjectTask(db, "pRepo", dependent.id);
  check("(2) getProjectTask: auto-clears to deferred:false once the blocker is merged", gotAfter.deferred === false);
  const rawAfter = db.getTask(dependent.id);
  check("(2) the RAW DB row is persisted deferred=false (idle-watchdog's own db.listTasks self-heals)", rawAfter.deferred === false);
  const updatedAtAfterClear = rawAfter.updatedAt;
  check("(2) the persisted clear bumped updatedAt off the pre-clear value", updatedAtAfterClear !== rawBefore.updatedAt);

  // (3) NO WRITE-STORM — a second read (both surfaces) after the clear must not write again.
  await new Promise((r) => setTimeout(r, 5)); // ensure a distinguishable timestamp WOULD show if a write fired
  const gotSecond = await getProjectTask(db, "pRepo", dependent.id);
  check("(3) getProjectTask second read: still deferred:false", gotSecond.deferred === false);
  const rawSecond = db.getTask(dependent.id);
  check("(3) getProjectTask second read performs NO further write — updatedAt unchanged", rawSecond.updatedAt === updatedAtAfterClear);
  const listSecond = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowSecond = listSecond.find((t) => t.id === dependent.id);
  check("(3) listProjectTasks read after the clear: also deferred:false, no further write", rowSecond?.deferred === false);
  const rawThird = db.getTask(dependent.id);
  check("(3) listProjectTasks read performs NO further write either — updatedAt still unchanged", rawThird.updatedAt === updatedAtAfterClear);

  // --- (3b) isolate the write-storm control on listProjectTasks as the FIRST discovering read (the
  // more frequently-polled surface) — a separate blocker/dependent pair so it can't ride on (2)'s clear. ---
  const blocker2 = createProjectTask(db, "pRepo", { title: "blocker card 2" });
  const dependent2 = createProjectTask(db, "pRepo", { title: "dependent card 2" });
  await updateProjectTask(db, "pRepo", dependent2.id, { deferred: true, deferredUntilTaskId: blocker2.id });
  landBlocker(blocker2.id, "feat(y): blocker 2 landed");
  const list2First = await listProjectTasks(db, "pRepo", { includeBody: true });
  const row2First = list2First.find((t) => t.id === dependent2.id);
  check("(3b) listProjectTasks AS THE DISCOVERING READ: clears deferred:false", row2First?.deferred === false);
  const raw2First = db.getTask(dependent2.id).updatedAt;
  const list2Second = await listProjectTasks(db, "pRepo", { includeBody: true });
  const row2Second = list2Second.find((t) => t.id === dependent2.id);
  check("(3b) listProjectTasks second read: still deferred:false", row2Second?.deferred === false);
  const raw2Second = db.getTask(dependent2.id).updatedAt;
  check("(3b) listProjectTasks second read performs NO further write — updatedAt unchanged", raw2Second === raw2First);

  // --- (4) held is UNTOUCHED by the auto-clear ---
  const blocker3 = createProjectTask(db, "pRepo", { title: "blocker card 3" });
  const dependent3 = createProjectTask(db, "pRepo", { title: "held + deferred card" });
  await updateProjectTask(db, "pRepo", dependent3.id, { held: true, deferred: true, deferredUntilTaskId: blocker3.id });
  landBlocker(blocker3.id, "feat(z): blocker 3 landed");
  const got3 = await getProjectTask(db, "pRepo", dependent3.id);
  check("(4) deferred auto-clears to false", got3.deferred === false);
  check("(4) held is left UNTOUCHED (still true) — this mechanism only ever touches deferred", got3.held === true);
  const raw3 = db.getTask(dependent3.id);
  check("(4) raw DB row confirms held:true survived the deferred write-through", raw3.held === true);

  // --- (5) set-time validation ---
  const selfRefTarget = createProjectTask(db, "pRepo", { title: "self-ref card" });
  const selfRefResult = await updateProjectTask(db, "pRepo", selfRefTarget.id, { deferred: true, deferredUntilTaskId: selfRefTarget.id });
  check("(5) a self-reference is REJECTED", "error" in selfRefResult);
  const rawSelfRef = db.getTask(selfRefTarget.id);
  check("(5) a rejected self-reference writes NOTHING (deferredUntilTaskId stays null)", rawSelfRef.deferredUntilTaskId === null);

  const unknownRefTarget = createProjectTask(db, "pRepo", { title: "unknown-ref card" });
  const unknownRefResult = await updateProjectTask(db, "pRepo", unknownRefTarget.id, { deferred: true, deferredUntilTaskId: "00000000-0000-0000-0000-000000000000" });
  check("(5) an unknown blocker id is REJECTED", "error" in unknownRefResult);
  const rawUnknownRef = db.getTask(unknownRefTarget.id);
  check("(5) a rejected unknown-blocker-id write leaves deferredUntilTaskId null", rawUnknownRef.deferredUntilTaskId === null);

  // --- (6) dangling blocker (deleted AFTER being validly set) degrades to "stays deferred", never throws ---
  const blocker4 = createProjectTask(db, "pRepo", { title: "blocker card 4 (will be deleted)" });
  const dependent4 = createProjectTask(db, "pRepo", { title: "dependent card 4 (dangling)" });
  await updateProjectTask(db, "pRepo", dependent4.id, { deferred: true, deferredUntilTaskId: blocker4.id });
  db.deleteTask(blocker4.id);
  let dangledThrew = false;
  let got4;
  try {
    got4 = await getProjectTask(db, "pRepo", dependent4.id);
  } catch {
    dangledThrew = true;
  }
  check("(6) a dangling blocker reference never throws", !dangledThrew);
  check("(6) a dangling blocker reference degrades to STAYS deferred (never silently drops it)", got4?.deferred === true);

  // --- (7) omitting deferredUntilTaskId entirely stays byte-identical to today ---
  const plainDeferred = createProjectTask(db, "pRepo", { title: "plain deferred, no blocker" });
  await updateProjectTask(db, "pRepo", plainDeferred.id, { deferred: true });
  // Land a totally unrelated commit — proves an unrelated merge can never affect a blocker-less deferral.
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "chore: unrelated landing"`);
  const got7 = await getProjectTask(db, "pRepo", plainDeferred.id);
  check("(7) a plain deferred:true with no deferredUntilTaskId NEVER auto-clears", got7.deferred === true);
  check("(7) deferredUntilTaskId reads null/absent when never set", got7.deferredUntilTaskId === null || got7.deferredUntilTaskId === undefined);
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a deferred card with a named blocker stays deferred while that blocker is unmerged, auto-clears (both getProjectTask and listProjectTasks, plus the raw persisted DB row) exactly once the blocker's git-derived merged state resolves, never write-storms a settled clear, leaves held untouched, rejects a self-reference/unknown blocker id at set time, degrades safely for a dangling blocker, and never auto-clears a deferral with no named blocker."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
