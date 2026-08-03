import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cf62c1ef — re-deferring an auto-cleared card must NOT silently un-defer it again on the next
// read. The parent mechanism (793ac76d, task-defer-until.mjs) proved the auto-clear itself works but
// never drove a RE-DEFER afterward — structurally blind to this bug, per the card's own DoD-2 warning.
//
// THE SEQUENCE THIS PROVES SAFE (previously broken):
//   1. defer A true + deferredUntilTaskId: B
//   2. B merges => next read auto-clears A to deferred:false (AND, under the fix, nulls
//      deferredUntilTaskId in the same write-through — the actual fix for this card).
//   3. manager RE-DEFERS A for an unrelated reason: tasks_update(A, {deferred:true}), NOT touching
//      deferredUntilTaskId.
//   4. next read: A must STAY deferred:true. Pre-fix, the stale deferredUntilTaskId (still pointing at
//      the already-merged B) would cause the resolver to silently re-clear it right back to false.
//
// HERMETIC: a real temp git repo (execSync) + a real Db, driving the built business logic directly
// (dist/mcp/tasks.js + dist/db.js) — no daemon, no real claude. Mirrors task-defer-until.mjs's harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-defer-until-redefer.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-redefer-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);

const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-redefer-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  const blocker = createProjectTask(db, "pRepo", { title: "blocker card" });
  const dependent = createProjectTask(db, "pRepo", { title: "dependent card" });

  // --- step 1: defer + name the blocker ---
  const setResult = await updateProjectTask(db, "pRepo", dependent.id, { deferred: true, deferredUntilTaskId: blocker.id });
  check("(1) set deferred+deferredUntilTaskId succeeds (no error)", !("error" in setResult));

  // --- step 2: blocker merges => auto-clear fires on read ---
  landBlocker(blocker.id, "feat(x): blocker landed");
  const gotAfterClear = await getProjectTask(db, "pRepo", dependent.id);
  check("(2) auto-clears to deferred:false once the blocker merges", gotAfterClear.deferred === false);
  check(
    "(2) THE FIX: deferredUntilTaskId is ALSO nulled by the auto-clear (same response, not just a later read)",
    gotAfterClear.deferredUntilTaskId === null,
  );
  const rawAfterClear = db.getTask(dependent.id);
  check("(2) raw DB row confirms deferredUntilTaskId persisted null, not just in the response", rawAfterClear.deferredUntilTaskId === null);

  // --- step 3: manager RE-DEFERS for an unrelated reason, touching only `deferred` ---
  const redeferResult = await updateProjectTask(db, "pRepo", dependent.id, { deferred: true });
  check("(3) re-defer succeeds (no error)", !("error" in redeferResult));
  const rawAfterRedefer = db.getTask(dependent.id);
  check("(3) re-defer persisted deferred:true", rawAfterRedefer.deferred === true);
  check("(3) re-defer did not resurrect a deferredUntilTaskId (still null — no new blocker was named)", rawAfterRedefer.deferredUntilTaskId === null);

  // --- step 4: THE BUG — next read must STAY deferred:true, not silently re-clear ---
  const gotAfterRedefer = await getProjectTask(db, "pRepo", dependent.id);
  check(
    "(4) ⭐ getProjectTask: re-defer STICKS — does not silently re-clear on the next read (the actual bug)",
    gotAfterRedefer.deferred === true,
  );
  const listAfterRedefer = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowAfterRedefer = listAfterRedefer.find((t) => t.id === dependent.id);
  check(
    "(4) ⭐ listProjectTasks: re-defer ALSO sticks on the list surface",
    rowAfterRedefer?.deferred === true,
  );
  const rawFinal = db.getTask(dependent.id);
  check("(4) raw DB row still deferred:true after the read (no silent write-back undid the re-defer)", rawFinal.deferred === true);

  // --- negative control: re-defer WITH a fresh, still-unmerged blocker still behaves correctly ---
  const blocker2 = createProjectTask(db, "pRepo", { title: "second blocker (unmerged)" });
  await updateProjectTask(db, "pRepo", dependent.id, { deferred: true, deferredUntilTaskId: blocker2.id });
  const gotWithFreshBlocker = await getProjectTask(db, "pRepo", dependent.id);
  check(
    "(control) re-deferring against a NEW, still-unmerged blocker correctly stays deferred:true",
    gotWithFreshBlocker.deferred === true && gotWithFreshBlocker.deferredUntilTaskId === blocker2.id,
  );
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an auto-cleared card's deferredUntilTaskId is nulled alongside deferred, so a later unrelated re-defer starts clean and sticks instead of being silently re-cleared on the next read."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
