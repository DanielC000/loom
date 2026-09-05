import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 022659ac — extend `deferredUntilTaskId` (card 793ac76d / task-defer-until.mjs) to accept MULTIPLE
// blockers, so a card genuinely blocked on more than one thing (the real specimen: card `4458dd9e`,
// blocked on TWO cards named only in prose, sat deferred for five days after both merged) can represent
// that as DATA instead of prose. HERMETIC: a real temp git repo (execSync) + a real Db, driving the built
// business logic directly (dist/mcp/tasks.js + dist/db.js) — no daemon, no real claude.
//
// Proves:
//   (1) AND-semantics: a card deferred behind TWO blockers stays deferred:true once ONE of them merges —
//       only clears once BOTH have. This is the exact gap that let `4458dd9e` go stale: a single-id field
//       cannot represent "blocked on two things", so the deferral went to prose, which has no auto-clear.
//   (2) OR-semantics for deferredStuck: with two blockers, ANY one going dangling (deleted) sets
//       deferredStuck:true even while the OTHER is still a genuinely live, unmerged, non-terminal blocker
//       (i.e. "cleanly pending" on its own) — the flag must not wait for every blocker to independently
//       go bad, and must not be silenced by one blocker still looking fine.
//   (3) OR-semantics, the other stuck cause: a 0-commit terminal close on ONE of two blockers ALSO sets
//       deferredStuck:true while the sibling blocker is still cleanly pending.
//   (4) NEGATIVE CONTROL: two blockers, both still open/unmerged/non-terminal — deferred:true,
//       deferredStuck:false. Proves (2)/(3) aren't just "stuck is always true with 2 blockers".
//   (5) Single-resolved-id COLLAPSE: passing an array containing exactly one distinct id (after dedupe —
//       either a 1-element array, or an array of duplicates of the same id) is stored/returned as a bare
//       string, never a 1-element array — this is what keeps a single-blocker deferral's on-disk shape
//       byte-identical whichever input shape a caller used.
//   (6) Empty array is REJECTED (whole patch, nothing written) — never silently treated as "no blocker".
//   (7) LEGACY TOLERANCE: a row whose deferred_until_task_id column holds a BARE uuid string — written
//       directly via raw SQL, bypassing serializeDeferredUntilTaskId entirely, reproducing exactly the
//       on-disk shape of every one of the 8 real single-blocker rows measured live on this board (card
//       022659ac's own DoD-2/3 correction) — reads back as a plain string (never mis-parsed as JSON, never
//       thrown on) and still auto-clears correctly once that one blocker merges. A fresh/empty DB can
//       never exercise this: every row IT creates already goes through the new serialize path, so this
//       step deliberately writes around that path to reproduce what's actually on disk today.
//   (8) WRITE-PATH SAFETY (the regression this card's OWN implementation could have introduced): an
//       UNRELATED field-only update on a still-live MULTI-blocker row (a plain columnKey move, done via
//       the SAME db.updateTask a stuck-flag write-through uses) must not throw — better-sqlite3 cannot
//       bind a raw JS array, and `updateTask`'s `next` carries the CURRENT (already-parsed, array-shaped)
//       deferredUntilTaskId forward on ANY patch that doesn't mention the field, so every write must
//       re-serialize it, not only a write that explicitly touches it.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-defer-until-multi.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-until-multi-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);

const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-until-multi-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // --- (1) AND-semantics: two blockers, only fully clears once BOTH merge ---
  const blockerA = createProjectTask(db, "pRepo", { title: "blocker A" });
  const blockerB = createProjectTask(db, "pRepo", { title: "blocker B" });
  const dependent = createProjectTask(db, "pRepo", { title: "dependent — blocked on A and B" });
  const setResult = await updateProjectTask(db, "pRepo", dependent.id, { deferred: true, deferredUntilTaskId: [blockerA.id, blockerB.id] });
  check("(1) set deferred+deferredUntilTaskId (array of 2) succeeds (no error)", !("error" in setResult));
  check("(1) ack echoes back the full 2-element array (not collapsed)", Array.isArray(setResult.deferredUntilTaskId) && setResult.deferredUntilTaskId.length === 2);

  const before = await getProjectTask(db, "pRepo", dependent.id);
  check("(1) POSITIVE CONTROL: stays deferred:true while BOTH blockers are unmerged", before.deferred === true);

  landBlocker(blockerA.id, "feat(x): blocker A landed");
  const afterOne = await getProjectTask(db, "pRepo", dependent.id);
  check("(1) ⭐ THE FIX ITSELF: stays deferred:true after only ONE of two blockers merges (the exact 4458dd9e gap)", afterOne.deferred === true);
  const listAfterOne = await listProjectTasks(db, "pRepo", { includeBody: true });
  const rowAfterOne = listAfterOne.find((t) => t.id === dependent.id);
  check("(1) listProjectTasks agrees: still deferred:true with one of two merged", rowAfterOne?.deferred === true);

  landBlocker(blockerB.id, "feat(y): blocker B landed");
  const afterBoth = await getProjectTask(db, "pRepo", dependent.id);
  check("(1) auto-clears to deferred:false once BOTH blockers have merged", afterBoth.deferred === false);
  const rawAfterBoth = db.getTask(dependent.id);
  check("(1) raw DB row persisted deferred=false", rawAfterBoth.deferred === false);
  check("(1) raw DB row also nulls deferredUntilTaskId on the auto-clear (mirrors the single-blocker path)", rawAfterBoth.deferredUntilTaskId === null);

  // --- (2) OR-semantics for deferredStuck: ONE dangling blocker stuck, even while the OTHER is cleanly pending ---
  const blockerC = createProjectTask(db, "pRepo", { title: "blocker C (will be deleted)" });
  const blockerD = createProjectTask(db, "pRepo", { title: "blocker D (stays open)" });
  const dependent2 = createProjectTask(db, "pRepo", { title: "dependent 2 — one dangling, one pending" });
  await updateProjectTask(db, "pRepo", dependent2.id, { deferred: true, deferredUntilTaskId: [blockerC.id, blockerD.id] });
  db.deleteTask(blockerC.id);
  let threw2 = false;
  let got2;
  try {
    got2 = await getProjectTask(db, "pRepo", dependent2.id);
  } catch {
    threw2 = true;
  }
  check("(2) a dangling blocker among several never throws", !threw2);
  check("(2) stays deferred:true (blockerD alone doesn't satisfy the AND)", got2?.deferred === true);
  check("(2) deferredStuck:true — ONE dangling blocker is enough, even though blockerD is still fine on its own", got2?.deferredStuck === true);

  // --- (3) OR-semantics, the other stuck cause: a 0-commit terminal close on ONE of two blockers ---
  const blockerE = createProjectTask(db, "pRepo", { title: "blocker E (closes 0-commit)" });
  const blockerF = createProjectTask(db, "pRepo", { title: "blocker F (stays open)" });
  const dependent3 = createProjectTask(db, "pRepo", { title: "dependent 3 — one 0-commit-closed, one pending" });
  await updateProjectTask(db, "pRepo", dependent3.id, { deferred: true, deferredUntilTaskId: [blockerE.id, blockerF.id] });
  await updateProjectTask(db, "pRepo", blockerE.id, { columnKey: "done" }); // 0 commits — no git call
  const got3 = await getProjectTask(db, "pRepo", dependent3.id);
  check("(3) stays deferred:true (blockerF alone doesn't satisfy the AND)", got3.deferred === true);
  check("(3) deferredStuck:true — ONE 0-commit-closed blocker is enough, even with a cleanly-pending sibling", got3.deferredStuck === true);
  const rawStuck3 = db.getTask(dependent3.id);
  check("(3) self-heal persisted deferredStuck=true on the raw row", rawStuck3.deferredStuck === true);

  // --- (4) NEGATIVE CONTROL: two blockers, both genuinely still open — NOT stuck, just pending ---
  const blockerG = createProjectTask(db, "pRepo", { title: "blocker G (open)" });
  const blockerH = createProjectTask(db, "pRepo", { title: "blocker H (open)" });
  const dependent4 = createProjectTask(db, "pRepo", { title: "dependent 4 — both cleanly pending" });
  await updateProjectTask(db, "pRepo", dependent4.id, { deferred: true, deferredUntilTaskId: [blockerG.id, blockerH.id] });
  const got4 = await getProjectTask(db, "pRepo", dependent4.id);
  check("(4) NEGATIVE CONTROL: stays deferred:true", got4.deferred === true);
  check("(4) NEGATIVE CONTROL: deferredStuck stays FALSE — two live blockers is not automatically stuck", got4.deferredStuck === false);

  // --- (5) single-resolved-id collapse: a 1-element array (and an array of duplicates) stores/returns a bare string ---
  const blockerI = createProjectTask(db, "pRepo", { title: "blocker I" });
  const dependent5 = createProjectTask(db, "pRepo", { title: "dependent 5 — 1-element array input" });
  const set5 = await updateProjectTask(db, "pRepo", dependent5.id, { deferred: true, deferredUntilTaskId: [blockerI.id] });
  check("(5) a 1-element array input collapses to a bare string on the ack", set5.deferredUntilTaskId === blockerI.id);
  const raw5 = db.getTask(dependent5.id);
  check("(5) ...and on the raw DB row too (never persisted as a 1-element array)", raw5.deferredUntilTaskId === blockerI.id);

  const dependent5b = createProjectTask(db, "pRepo", { title: "dependent 5b — duplicate-id array input" });
  const set5b = await updateProjectTask(db, "pRepo", dependent5b.id, { deferred: true, deferredUntilTaskId: [blockerI.id, blockerI.id] });
  check("(5) an array of DUPLICATES of the same id also collapses to a bare string", set5b.deferredUntilTaskId === blockerI.id);

  // --- (6) empty array is REJECTED, never silently treated as "no blocker" ---
  const dependent6 = createProjectTask(db, "pRepo", { title: "dependent 6 — empty array" });
  const set6 = await updateProjectTask(db, "pRepo", dependent6.id, { deferred: true, deferredReason: "placeholder", deferredUntilTaskId: [] });
  check("(6) an empty array is REJECTED", "error" in set6);
  const raw6 = db.getTask(dependent6.id);
  check("(6) nothing was written by the rejected empty-array call", raw6.deferredUntilTaskId === null && raw6.deferred === false);

  // --- (7) LEGACY TOLERANCE: a raw bare-uuid string written directly via SQL, bypassing serializeDeferredUntilTaskId ---
  const blockerLegacy = createProjectTask(db, "pRepo", { title: "legacy blocker" });
  const dependentLegacy = createProjectTask(db, "pRepo", { title: "dependent — legacy bare-string row" });
  db.close(); // release the handle so the raw connection below can write without contention
  {
    const raw = new Database(file);
    // Mimics exactly the 8 real production rows (card 022659ac DoD-2/3): deferred=1, a BARE uuid string
    // in deferred_until_task_id — never JSON-encoded, since this format predates this card entirely and
    // this card's own design deliberately keeps a single blocker stored this same bare way going forward.
    raw.prepare("UPDATE tasks SET deferred = 1, deferred_until_task_id = ? WHERE id = ?").run(blockerLegacy.id, dependentLegacy.id);
    raw.close();
  }
  const db2 = new Db(file);
  const legacyRaw = db2.getTask(dependentLegacy.id);
  check("(7) a raw bare-uuid deferred_until_task_id reads back as a plain string (not an array, not thrown on)", legacyRaw.deferredUntilTaskId === blockerLegacy.id);
  const legacyBefore = await getProjectTask(db2, "pRepo", dependentLegacy.id);
  check("(7) stays deferred:true while the legacy-shaped blocker is unmerged", legacyBefore.deferred === true);
  landBlocker(blockerLegacy.id, "feat(legacy): blocker landed");
  const legacyAfter = await getProjectTask(db2, "pRepo", dependentLegacy.id);
  check("(7) auto-clears correctly once the legacy-shaped single blocker merges", legacyAfter.deferred === false);

  // --- (8) WRITE-PATH SAFETY: an unrelated field-only update on a live multi-blocker row must not throw ---
  const blockerJ = createProjectTask(db2, "pRepo", { title: "blocker J (stays open)" });
  const blockerK = createProjectTask(db2, "pRepo", { title: "blocker K (stays open)" });
  const dependent8 = createProjectTask(db2, "pRepo", { title: "dependent 8 — unrelated update while multi-blocked" });
  await updateProjectTask(db2, "pRepo", dependent8.id, { deferred: true, deferredUntilTaskId: [blockerJ.id, blockerK.id] });
  let threw8 = false;
  try {
    // The SAME db.updateTask a deferredStuck-only write-through (persistDeferredStateBestEffort) uses —
    // this patch never mentions deferredUntilTaskId at all, so `next.deferredUntilTaskId` carries the
    // CURRENT already-parsed 2-element array forward; a write that doesn't re-serialize it would throw
    // (better-sqlite3 cannot bind a raw array).
    db2.updateTask(dependent8.id, { columnKey: "todo" });
  } catch {
    threw8 = true;
  }
  check("(8) an unrelated field-only db.updateTask on a multi-blocker row does NOT throw", !threw8);
  const raw8 = db2.getTask(dependent8.id);
  check("(8) the multi-blocker array survives the unrelated update, byte-identical, correct order", Array.isArray(raw8.deferredUntilTaskId) && raw8.deferredUntilTaskId[0] === blockerJ.id && raw8.deferredUntilTaskId[1] === blockerK.id);
  check("(8) the unrelated field was actually applied too", raw8.columnKey === "todo");
  const got8 = await getProjectTask(db2, "pRepo", dependent8.id);
  check("(8) the card is still correctly deferred:true post-update (both blockers still genuinely open)", got8.deferred === true);

  db2.close();
} finally {
  try { db.close(); } catch { /* already closed above */ }
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a card deferred behind MULTIPLE blockers stays deferred until EVERY one has merged (not just one of several — the exact gap that let a real 5-day-stale deferral, card 4458dd9e, go unnoticed), deferredStuck is the OR across all named blockers (one dangling or 0-commit-closed blocker is enough, even while a sibling is still cleanly pending), a resolved single id always collapses to a bare string regardless of input shape, an empty array is rejected rather than silently treated as no-blocker, a legacy bare-uuid row (the exact on-disk shape of every real single-blocker row on this board, written directly via SQL rather than through this card's own new code) is read and auto-cleared correctly, and an unrelated field-only update on a live multi-blocker row never throws."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
