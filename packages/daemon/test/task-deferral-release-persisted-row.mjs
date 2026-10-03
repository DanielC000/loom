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
// Card f5292cf9 (delta review follow-ups on 363f5c2d/commit 30a0f727) adds four more proves below:
//   - the manual release path now keeps the alias edge as `released` history instead of deleting it,
//     mirroring the auto-release path (item 2) — (11).
//   - an explicit `deferredUntilEvent` override in the SAME `deferred:false` patch is respected, the
//     `deferredUntilEvent` sibling of case (5) — (8).
//   - a `stuckChanged`-only persist (deferred stays true) still re-reads the row rather than echoing the
//     pre-persist snapshot — (9).
//   - a FAILED autoCleared persist (the write throws) no longer lets the response pair the always-correct
//     computed `deferred:false` with a stale, still-non-null `deferredUntilTaskId`/`deferredReason`/
//     `deferredAt` straight off the pre-persist row — the cf62c1ef contradiction resurrected on the
//     failure path — (10).
// Case (5) itself passes on PRE-fix code too (an explicit same-patch override was already respected
// before this card; f5292cf9 only changed how the FORCED/implicit clear is applied) — kept here as a
// regression guard, not as one of this card's own RED-before-GREEN proofs.
//
// HERMETIC: a real Db (better-sqlite3) + a real temp git repo (execSync) for the auto-release scenario,
// driving the built business logic directly (dist/db.js + dist/mcp/tasks.js) — no daemon, no real claude.
// Mirrors task-defer-until-redefer.mjs's harness. (10) simulates a persist FAILURE by monkeypatching the
// live `db` instance's own `releaseDeferralEdges` method to throw for its one call, then restoring it
// immediately after — never a real I/O failure, just the same "the write throws" shape
// persistDeferredStateBestEffort's own catch is written to handle.
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
//       deferredUntilTaskId is NOT force-cleared. Passes on pre-fix code too (see note above) — a plain
//       regression guard, not an f5292cf9 RED→GREEN proof.
//   (6) ⭐ AUTO-release (blocker merges, discovered via getProjectTask): the RESPONSE's own
//       version/body/deferredReason/deferredAt match the raw DB row post-persist, not the pre-persist
//       snapshot (the M7 defect on getProjectTask).
//   (7) same, discovered via listProjectTasks.
//   (8) ⭐ a `deferred:false` patch that ALSO explicitly sets `deferredUntilEvent` in the SAME call
//       respects that value too — the deferredUntilEvent sibling of case (5).
//   (9) ⭐ a `stuckChanged`-only persist (deferred stays true, deferredStuck flips) still reflects the
//       post-persist row's `updatedAt` — not the pre-persist snapshot's.
//   (10) ⭐⭐ card f5292cf9 item 1: a FAILED autoCleared persist overlays deferredUntilTaskId/
//        deferredReason/deferredAt to null on the response rather than echoing the stale pre-persist row
//        alongside the always-correct computed `deferred:false` (the cf62c1ef contradiction resurrected
//        on the failure path) — and the raw DB row is left COMPLETELY UNTOUCHED (the two writes now run
//        in one transaction, so a failure can never land a half-updated row).
//   (11) ⭐ card f5292cf9 item 2: a manual release keeps the alias edge as `released` history (gates_deferral
//        cleared, `released:true`, row still present) instead of deleting it — mirroring the auto-release
//        path — for a FORCED/implicit clear. An EXPLICIT same-patch null (case 5's shape) still deletes
//        the edge with no history, unaffected by this card.
//   (12)-(15) ⭐ card f5292cf9 item 2's manager-requested READER SWEEP: a `released:true` edge produced by
//        a FORCED manual release (new as of this card — manual release never produced one before) must
//        never read as an open dependency, a re-block, or a duplicate relation to any reader. Proves,
//        end-to-end against the real reader code (not just the row shape):
//        (12) the released edge does NOT count toward `ready:true`/`blockedByOpen` for the released card;
//        (13) tasks_get's `relations.blockedBy` surfaces it with released:true + resolved:true (same shape
//             buildRelationView already gives an auto-released edge);
//        (14) a structure write that would otherwise CYCLE through the released edge is NOT blocked by it
//             (the cycle check's adjacency is built from isLiveEdge only — a released edge is invisible to
//             it, same as planTaskStructure already treats an auto-released one);
//        (15) re-deferring onto the SAME blocker REACTIVATES the existing row (gates:true, released:false)
//             rather than creating a second edge — exactly one blocks row survives between the pair.
//        These readers were ALREADY built (card 3df86c87/1ae4f88c) to handle a `released:true` row from
//        auto-release; this sweep confirms they handle the IDENTICAL row shape when it instead arrives via
//        the newly-history-preserving manual path, with no reader-side changes needed.
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

  // ===== (8) ⭐ an explicit deferredUntilEvent override in the SAME deferred:false patch is respected =====
  const c8 = createProjectTask(db, "pRepo", { title: "explicit deferredUntilEvent override on release" });
  await updateProjectTask(db, "pRepo", c8.id, {
    deferred: true, deferredReason: "owner-gated: awaiting sign-off",
    deferredUntilEvent: { kind: "gate-fail-naming", key: "old-file.mjs" },
  });
  const release8 = await updateProjectTask(db, "pRepo", c8.id, {
    deferred: false, deferredUntilEvent: { kind: "gate-fail-naming", key: "new-file.mjs" },
  });
  check("(8) release with an explicit deferredUntilEvent override succeeds", !("error" in release8));
  check(
    "(8) ⭐ the explicit deferredUntilEvent value is respected, not force-cleared to null",
    release8.deferredUntilEvent?.key === "new-file.mjs",
  );
  const raw8 = db.getTask(c8.id);
  check("(8) raw DB row confirms the explicit deferredUntilEvent value persisted", raw8.deferredUntilEvent?.key === "new-file.mjs");

  // ===== (9) ⭐ a stuckChanged-only persist (deferred stays true) still reflects the post-persist row =====
  const blocker9 = createProjectTask(db, "pRepo", { title: "blocker 9 (closed, never merged)" });
  await updateProjectTask(db, "pRepo", blocker9.id, { columnKey: "done" }); // closed with NO squash commit
  const c9 = createProjectTask(db, "pRepo", { title: "stuck deferral, re-read check" });
  await updateProjectTask(db, "pRepo", c9.id, { deferred: true, deferredUntilTaskId: blocker9.id, deferredReason: "blocked on 9's prerequisite" });
  const preUpdatedAt9 = db.getTask(c9.id).updatedAt;
  const got9 = await getProjectTask(db, "pRepo", c9.id);
  check("(9) setup: still deferred (blocker closed with no merge, not auto-cleared)", got9.deferred === true);
  check("(9) setup: deferredStuck flipped true (closed-with-no-merge)", got9.deferredStuck === true);
  const raw9 = db.getTask(c9.id);
  check("(9) setup sanity: the stuckChanged persist actually bumped the raw DB row's updatedAt", raw9.updatedAt !== preUpdatedAt9);
  check("(9) ⭐ THE FIX: response `updatedAt` matches the raw DB row's post-persist value (was: stale pre-persist snapshot)", got9.updatedAt === raw9.updatedAt);

  // ===== (10) ⭐⭐ card f5292cf9 item 1a: releaseDeferralEdges (the SECOND write) throws =====
  // This sub-case does NOT discriminate deferredReason/deferredAt: the FIRST write (db.updateTask, which
  // nulls both) already landed non-transactionally on pre-fix code before the second one throws, so those
  // two read null pre-fix too — only deferredUntilTaskId (edge-derived, released by the call that throws)
  // stays stale pre-fix. (10b) below is the sub-case that DOES discriminate all three, by making the FIRST
  // write itself throw instead.
  const blocker10 = createProjectTask(db, "pRepo", { title: "blocker 10" });
  const c10 = createProjectTask(db, "pRepo", { title: "failed auto-release, overlay check", body: "Card 10 description." });
  await updateProjectTask(db, "pRepo", c10.id, { deferred: true, deferredUntilTaskId: blocker10.id, deferredReason: "blocked on 10's prerequisite" });
  landBlocker(blocker10.id, "feat(z): blocker 10 landed");
  const preRaw10 = db.getTask(c10.id);
  let releaseDeferralEdgesCalls = 0;
  // Simulate the SECOND write (releaseDeferralEdges) throwing — the exact failure shape
  // persistDeferredStateBestEffort's own try/catch exists to handle. `delete` afterward restores the
  // real prototype method rather than leaking a stub into later cases.
  db.releaseDeferralEdges = () => { releaseDeferralEdgesCalls++; throw new Error("simulated persist failure (card f5292cf9 test)"); };
  const got10 = await getProjectTask(db, "pRepo", c10.id);
  delete db.releaseDeferralEdges;
  check("(10) setup sanity: the monkeypatched releaseDeferralEdges was actually invoked (the persist attempt reached it)", releaseDeferralEdgesCalls === 1);
  check("(10) response's computed `deferred` is still correctly false (independent of whether the write landed)", got10.deferred === false);
  check(
    "(10) ⭐ THE FIX: response `deferredUntilTaskId` is overlaid to null despite the failed write (was: stale non-null, the cf62c1ef contradiction)",
    got10.deferredUntilTaskId === null,
  );
  // Non-discriminating for THIS sub-case (see the comment above) — the first write already nulled these
  // before the second one threw, pre-fix and post-fix alike. Kept as a plain sanity check.
  check("(10) response `deferredReason` reads null (already landed by the first write, pre-fix and post-fix alike)", got10.deferredReason === null);
  check("(10) response `deferredAt` reads null (already landed by the first write, pre-fix and post-fix alike)", got10.deferredAt === null);
  const raw10 = db.getTask(c10.id);
  check(
    "(10) ⭐ THE FIX: the raw DB row is COMPLETELY UNTOUCHED by the failed attempt (both writes now run in one transaction)",
    JSON.stringify(raw10) === JSON.stringify(preRaw10),
  );

  // ===== (10b) ⭐⭐ card f5292cf9 item 1b: db.updateTask (the FIRST write) throws — discriminates ALL THREE =====
  // Pre-fix, NOTHING lands when the first write itself throws, so deferredUntilTaskId/deferredReason/
  // deferredAt are ALL stale (not just the edge) — the other half of the card's own "If updateTask
  // throws, OR it lands and releaseDeferralEdges then throws" description.
  const blocker10b = createProjectTask(db, "pRepo", { title: "blocker 10b" });
  const c10b = createProjectTask(db, "pRepo", { title: "failed auto-release (first write throws), overlay check" });
  await updateProjectTask(db, "pRepo", c10b.id, { deferred: true, deferredUntilTaskId: blocker10b.id, deferredReason: "blocked on 10b's prerequisite" });
  landBlocker(blocker10b.id, "feat(zz): blocker 10b landed");
  const preRaw10b = db.getTask(c10b.id);
  let updateTaskCalls10b = 0;
  const originalUpdateTask = db.updateTask.bind(db);
  db.updateTask = (...args) => { updateTaskCalls10b++; throw new Error("simulated persist failure (card f5292cf9 test, first write)"); };
  const got10b = await getProjectTask(db, "pRepo", c10b.id);
  db.updateTask = originalUpdateTask;
  check("(10b) setup sanity: the monkeypatched updateTask was actually invoked", updateTaskCalls10b === 1);
  check("(10b) response's computed `deferred` is still correctly false", got10b.deferred === false);
  check("(10b) ⭐ THE FIX: response `deferredUntilTaskId` is overlaid to null despite the failed write", got10b.deferredUntilTaskId === null);
  check("(10b) ⭐ THE FIX: response `deferredReason` is overlaid to null despite the failed write (was: stale, non-null)", got10b.deferredReason === null);
  check("(10b) ⭐ THE FIX: response `deferredAt` is overlaid to null despite the failed write", got10b.deferredAt === null);
  const raw10b = db.getTask(c10b.id);
  check(
    "(10b) ⭐ THE FIX: the raw DB row is COMPLETELY UNTOUCHED by the failed attempt",
    JSON.stringify(raw10b) === JSON.stringify(preRaw10b),
  );

  // ===== (11) ⭐ card f5292cf9 item 2: a manual FORCED release keeps the alias edge as `released` history =====
  const blocker11 = createProjectTask(db, "pRepo", { title: "blocker 11 (unmerged, forced clear)" });
  const c11 = createProjectTask(db, "pRepo", { title: "route-a deferral, forced clear keeps history" });
  await updateProjectTask(db, "pRepo", c11.id, { deferred: true, deferredUntilTaskId: blocker11.id });
  const release11 = await updateProjectTask(db, "pRepo", c11.id, { deferred: false }); // FORCED clear — field left untouched
  check("(11) release succeeds", !("error" in release11));
  check("(11) ack: deferredUntilTaskId cleared to null", release11.deferredUntilTaskId === null);
  const edges11 = db.listRelations("pRepo").filter((r) => r.fromTaskId === blocker11.id && r.toTaskId === c11.id);
  check("(11) setup sanity: exactly one blocks edge exists between blocker11 and c11", edges11.length === 1);
  check(
    "(11) ⭐ THE FIX: the edge is KEPT as `released` history, not deleted (was: setDeferralEdges deleted it with no history)",
    edges11[0]?.released === true && edges11[0]?.gatesDeferral === false,
  );

  // ===== (11b) an EXPLICIT same-patch null still deletes the edge with no history (unaffected by this card) =====
  const blocker11b = createProjectTask(db, "pRepo", { title: "blocker 11b (explicit clear)" });
  const c11b = createProjectTask(db, "pRepo", { title: "route-a deferral, explicit clear deletes" });
  await updateProjectTask(db, "pRepo", c11b.id, { deferred: true, deferredUntilTaskId: blocker11b.id });
  await updateProjectTask(db, "pRepo", c11b.id, { deferred: false, deferredUntilTaskId: null }); // EXPLICIT clear
  const edges11b = db.listRelations("pRepo").filter((r) => r.fromTaskId === blocker11b.id && r.toTaskId === c11b.id);
  check("(11b) an EXPLICIT same-patch null clear still DELETES the edge with no history (unaffected by this card)", edges11b.length === 0);

  // ===== (12) ⭐ READER SWEEP: the released edge from (11) does NOT count as an open blocker =====
  // c11 still carries a released:true edge FROM blocker11 (blocker11 is itself unmerged/non-terminal, so
  // if this edge were mistakenly treated as live/open, blockedByOpen would read 1, not 0). Move c11 into
  // the workReady column so it's eligible for `ready:true` at all, then check both signals.
  await updateProjectTask(db, "pRepo", c11.id, { columnKey: "todo" });
  const listed12 = await listProjectTasks(db, "pRepo", {});
  const row12 = listed12.find((t) => t.id === c11.id);
  check("(12) setup: c11 found on the board summary", !!row12);
  const ready12 = await listProjectTasks(db, "pRepo", { ready: true });
  check(
    "(12) ⭐ THE SWEEP: c11 (workReady, not held, not deferred) IS ready — the released edge into it is not read as an open blockedBy",
    ready12.some((t) => t.id === c11.id),
  );
  // Cross-check via the lower-level roll-up tasks_list's own blockedByOpen rides on (card 3df86c87) —
  // a second, independent path to the same answer, not just the ready-filter's own verdict.
  const boardRollupMod = await import("../dist/tasks/relations.js");
  const allTasks12 = db.listTasks("pRepo");
  const rollup12 = boardRollupMod.boardRollup(db, "pRepo", allTasks12);
  check("(12) ⭐ THE SWEEP: boardRollup's blockedByOpen for c11 reads 0, not 1 (same released edge, same answer)", rollup12.get(c11.id)?.blockedByOpen === 0);

  // ===== (13) ⭐ READER SWEEP: tasks_get surfaces the released edge as released:true + resolved:true =====
  const got13 = await getProjectTask(db, "pRepo", c11.id);
  const blockedBy13 = got13.relations.blockedBy.find((r) => r.id === blocker11.id);
  check("(13) setup: the released edge shows up in relations.blockedBy at all (history, not silently dropped)", !!blockedBy13);
  check("(13) ⭐ THE SWEEP: it carries released:true (same shape an auto-released edge gets)", blockedBy13?.released === true);
  check("(13) ⭐ THE SWEEP: it carries resolved:true (released implies resolved, never shown as an open block)", blockedBy13?.resolved === true);

  // ===== (14) ⭐ READER SWEEP: a structure write that would cycle through the released edge is NOT blocked =====
  // blocker11 --(released, history-only)--> c11 already exists. Declaring c11 --blocks--> blocker11 would
  // be a 2-cycle (blocker11 -> c11 -> blocker11) IF the released edge were live. It must succeed.
  const cyclic14 = await updateProjectTask(db, "pRepo", c11.id, { blocks: [blocker11.id] });
  check(
    "(14) ⭐ THE SWEEP: declaring c11 blocks blocker11 succeeds — the released edge is invisible to the cycle check",
    !("error" in cyclic14),
  );
  const edges14 = db.listRelations("pRepo").filter((r) => r.fromTaskId === c11.id && r.toTaskId === blocker11.id);
  check("(14) the new declared edge actually landed (c11 -> blocker11, declared)", edges14.length === 1 && edges14[0].declared === true);
  // Clean up the declared edge so it doesn't interfere with (15)'s own count below.
  await updateProjectTask(db, "pRepo", c11.id, { blocks: [] });

  // ===== (15) ⭐ READER SWEEP: re-deferring onto the SAME blocker REACTIVATES the row, never duplicates it =====
  const redefer15 = await updateProjectTask(db, "pRepo", c11.id, { deferred: true, deferredUntilTaskId: blocker11.id });
  check("(15) re-defer onto the same (released-history) blocker succeeds", !("error" in redefer15));
  const edges15 = db.listRelations("pRepo").filter((r) => r.fromTaskId === blocker11.id && r.toTaskId === c11.id);
  check("(15) ⭐ THE SWEEP: EXACTLY ONE blocks row survives between the pair (reactivated, not duplicated)", edges15.length === 1);
  check("(15) ⭐ THE SWEEP: the surviving row is reactivated — gates:true, released:false", edges15[0]?.gatesDeferral === true && edges15[0]?.released === false);

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a manual deferral release clears both deferredUntilTaskId and deferredUntilEvent (respecting an explicit same-patch override on either field), its ack reports the actual post-persist version, a later re-defer with no reason is correctly refused again, every read path that triggers an auto-release (getProjectTask, listProjectTasks) returns the genuinely post-persist row (including a stuckChanged-only persist) instead of a stale pre-persist snapshot, a FAILED auto-release persist overlays the would-have-cleared fields instead of resurrecting the cf62c1ef contradiction and leaves the raw row fully untouched (one transaction), and a manual FORCED release now keeps the alias edge as `released` history exactly like auto-release does, while an explicit same-patch clear still deletes it with no history."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
