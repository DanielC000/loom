import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 363f5c2d (full review lane 486d4238, M6+M7) — two bugs on the deferral-release path:
//
// M6 (manual release, updateProjectTask): a manual `tasks_update({deferred:false})` folded the outgoing
// `deferredReason` into `body` (bumping `version` in the DB, card 1d27c3cd) but built its ACK from
// `{...owned, ...dbPatch}` — `owned` is the PRE-write snapshot, so the ack reported the OLD version while
// the DB was already one ahead. The same release also never cleared `deferredUntilTaskId` — so a route-(a)
// release left a stale blocker reference, and a LATER `deferred:true` with no reason was silently ACCEPTED
// (misread as route-(a), since `deferredUntilTaskId` still looked set) instead of refused by the c90e9525
// manual-reason guard — the mirror image of the footgun cf62c1ef fixed on the AUTO-release path
// (task-defer-until-redefer.mjs). It also never cleared `deferredUntilEvent`.
//
// M7 (auto-release read paths, listProjectTasks/getProjectTask): persistDeferredStateBestEffort persists
// the SAME reason-fold + version bump on the read that discovers a blocker merged, but both read sites
// built their response from the PRE-persist task snapshot — so the response itself (not just the raw DB
// row, which task-deferred-reason-preserved-on-release.mjs already checks) reported a stale
// body/deferredReason/deferredAt/version.
//
// Fix: ONE helper (rereadAfterPersist, mcp/tasks.js) re-reads the row post-persist at every site that
// persists one of these side effects, and the manual release now also clears deferredUntilTaskId/
// deferredUntilEvent (server-computed, respecting an explicit caller override in the same patch).
//
// HERMETIC: a real Db (better-sqlite3) + a real temp git repo (execSync) for the auto-release scenario,
// driving the built business logic directly (dist/db.js + dist/mcp/tasks.js) — no daemon, no real claude.
// Mirrors task-defer-until-redefer.mjs's harness.
//
// Proves:
//   (1) manual release clears deferredUntilTaskId (ack AND raw DB row), for a route-(a) deferral that
//       needed no reason.
//   (2) manual release clears deferredUntilEvent (ack AND raw DB row), for a manual deferral with a
//       reason.
//   (3) ⭐ the ack's `version` after a manual release (which folds a reason into body) matches the raw
//       DB row's version — NOT the pre-write version (the M6 defect).
//   (4) ⭐ cf62c1ef holds on the MANUAL release path too: after releasing a route-(a) deferral (1), a
//       LATER bare `deferred:true` with no reason is REFUSED (pre-fix: silently accepted, since the
//       un-cleared deferredUntilTaskId made it look like route-(a)).
//   (5) an explicit caller override in the SAME patch is respected — deferred:false alongside an explicit
//       deferredUntilTaskId is NOT force-cleared.
//   (6) ⭐ AUTO-release (blocker merges, discovered via getProjectTask): the RESPONSE's own
//       version/body/deferredReason/deferredAt match the raw DB row post-persist, not the pre-persist
//       snapshot (the M7 defect on getProjectTask).
//   (7) same, discovered via listProjectTasks.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-deferral-release-persisted-row.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks, createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-defer-release-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-defer-release-${Date.now()}-${process.pid}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // ===== (1) manual release clears deferredUntilTaskId (route-a, no reason needed) =====
  const blocker1 = createProjectTask(db, "pRepo", { title: "blocker 1 (unmerged)" });
  const c1 = createProjectTask(db, "pRepo", { title: "route-a deferral to release" });
  const set1 = await updateProjectTask(db, "pRepo", c1.id, { deferred: true, deferredUntilTaskId: blocker1.id });
  check("(1) setup: route-a deferral set", !("error" in set1) && set1.deferredUntilTaskId === blocker1.id);
  const release1 = await updateProjectTask(db, "pRepo", c1.id, { deferred: false });
  check("(1) release succeeds", !("error" in release1));
  check("(1) ⭐ ack: deferredUntilTaskId cleared to null (was never cleared pre-fix)", release1.deferredUntilTaskId === null);
  const raw1 = db.getTask(c1.id);
  check("(1) raw DB row confirms deferredUntilTaskId persisted null", raw1.deferredUntilTaskId === null);

  // ===== (2) manual release clears deferredUntilEvent (manual deferral, needs a reason) =====
  const c2 = createProjectTask(db, "pRepo", { title: "manual deferral with event annotation" });
  const set2 = await updateProjectTask(db, "pRepo", c2.id, {
    deferred: true, deferredReason: "owner-gated: awaiting infra sign-off",
    deferredUntilEvent: { kind: "gate-fail-naming", key: "some-test-file.mjs" },
  });
  check("(2) setup: manual deferral with deferredUntilEvent set", !("error" in set2) && set2.deferredUntilEvent?.key === "some-test-file.mjs");
  const release2 = await updateProjectTask(db, "pRepo", c2.id, { deferred: false });
  check("(2) release succeeds", !("error" in release2));
  check("(2) ⭐ ack: deferredUntilEvent cleared to null", release2.deferredUntilEvent === null);
  const raw2 = db.getTask(c2.id);
  check("(2) raw DB row confirms deferredUntilEvent persisted null", raw2.deferredUntilEvent === null || raw2.deferredUntilEvent === undefined);

  // ===== (3) ⭐ ack's version matches the raw DB row post-release (the body fold bumps version) =====
  const c3 = createProjectTask(db, "pRepo", { title: "version-check deferral", body: "Original description." });
  const set3 = await updateProjectTask(db, "pRepo", c3.id, { deferred: true, deferredReason: "parked for version check" });
  check("(3) setup: manual deferral with reason set", !("error" in set3));
  const versionBeforeRelease3 = db.getTask(c3.id).version;
  const release3 = await updateProjectTask(db, "pRepo", c3.id, { deferred: false });
  check("(3) release succeeds", !("error" in release3));
  const raw3 = db.getTask(c3.id);
  check("(3) setup sanity: the release actually folded a reason into body and bumped the DB version", raw3.version > versionBeforeRelease3);
  check("(3) ⭐ THE FIX: the ack's own `version` matches the raw DB row's post-persist version (was: stale pre-write version)", release3.version === raw3.version);

  // ===== (4) ⭐ cf62c1ef holds on the MANUAL release path: a later bare deferred:true is REFUSED =====
  const redefer4 = await updateProjectTask(db, "pRepo", c1.id, { deferred: true });
  check(
    "(4) ⭐ THE FIX: re-deferring c1 (released in (1)) with NO reason is REFUSED — deferredUntilTaskId is genuinely null now, so this reads as a manual deferral needing a reason (pre-fix: silently accepted as route-a)",
    "error" in redefer4,
  );
  const raw4 = db.getTask(c1.id);
  check("(4) nothing was written by the refused call — still deferred:false", raw4.deferred === false);

  // ===== (5) an explicit caller override in the SAME patch is respected, never force-cleared =====
  const blocker5 = createProjectTask(db, "pRepo", { title: "blocker 5 (unmerged)" });
  const blocker5b = createProjectTask(db, "pRepo", { title: "blocker 5b (unmerged, the override target)" });
  const c5 = createProjectTask(db, "pRepo", { title: "explicit override on release" });
  await updateProjectTask(db, "pRepo", c5.id, { deferred: true, deferredUntilTaskId: blocker5.id });
  const release5 = await updateProjectTask(db, "pRepo", c5.id, { deferred: false, deferredUntilTaskId: blocker5b.id });
  check("(5) a deferred:false patch that ALSO explicitly sets deferredUntilTaskId in the SAME call succeeds", !("error" in release5));
  check(
    "(5) the explicit deferredUntilTaskId value is respected, not force-cleared to null",
    release5.deferredUntilTaskId === blocker5b.id,
  );
  const raw5 = db.getTask(c5.id);
  check("(5) raw DB row confirms the explicit value persisted", raw5.deferredUntilTaskId === blocker5b.id);

  // ===== (6) ⭐ AUTO-release via getProjectTask: the RESPONSE reflects the post-persist row =====
  const blocker6 = createProjectTask(db, "pRepo", { title: "blocker 6" });
  const c6 = createProjectTask(db, "pRepo", { title: "auto-released, response check", body: "Card 6 description." });
  await updateProjectTask(db, "pRepo", c6.id, { deferred: true, deferredUntilTaskId: blocker6.id, deferredReason: "blocked on 6's prerequisite" });
  landBlocker(blocker6.id, "feat(x): blocker 6 landed");
  const got6 = await getProjectTask(db, "pRepo", c6.id);
  check("(6) setup: auto-clears to deferred:false on this read", got6.deferred === false);
  const raw6 = db.getTask(c6.id);
  check("(6) ⭐ THE FIX: response `version` matches the raw DB row's post-persist version", got6.version === raw6.version);
  check("(6) ⭐ THE FIX: response `body` matches the raw DB row's post-persist (folded) body", got6.body === raw6.body);
  check("(6) ⭐ response body actually carries the folded reason (sanity the fold really happened)", got6.body.includes("blocked on 6's prerequisite"));
  check("(6) ⭐ THE FIX: response `deferredReason` matches the raw DB row (both null post-fold)", got6.deferredReason === raw6.deferredReason && got6.deferredReason === null);
  // Non-discriminating for THIS route-a scenario (deferredAt is never stamped on route-a either way, per
  // c90e9525) — kept as a plain sanity check, not a fix-proof, since it reads null==null even pre-fix.
  check("(6) response `deferredAt` matches the raw DB row (both null — never stamped on a route-a deferral)", got6.deferredAt === raw6.deferredAt && got6.deferredAt === null);

  // ===== (7) ⭐ AUTO-release via listProjectTasks: the RESPONSE reflects the post-persist row =====
  const blocker7 = createProjectTask(db, "pRepo", { title: "blocker 7" });
  const c7 = createProjectTask(db, "pRepo", { title: "auto-released via list, response check", body: "Card 7 description." });
  await updateProjectTask(db, "pRepo", c7.id, { deferred: true, deferredUntilTaskId: blocker7.id, deferredReason: "blocked on 7's prerequisite" });
  landBlocker(blocker7.id, "feat(y): blocker 7 landed");
  const listed7 = await listProjectTasks(db, "pRepo", { includeBody: true });
  const row7 = listed7.find((t) => t.id === c7.id);
  const raw7 = db.getTask(c7.id);
  check("(7) setup: row found and auto-cleared", !!row7 && row7.deferred === false);
  check("(7) ⭐ THE FIX: listProjectTasks row `version` matches the raw DB row's post-persist version", row7.version === raw7.version);
  check("(7) ⭐ THE FIX: listProjectTasks row `body` matches the raw DB row's post-persist (folded) body", row7.body === raw7.body);
  check("(7) ⭐ listProjectTasks row body actually carries the folded reason", row7.body.includes("blocked on 7's prerequisite"));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manual deferral release clears both deferredUntilTaskId and deferredUntilEvent (respecting an explicit same-patch override), its ack reports the actual post-persist version, a later re-defer with no reason is correctly refused again, and every read path that triggers an auto-release (getProjectTask, listProjectTasks) returns the genuinely post-persist row instead of a stale pre-persist snapshot."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
