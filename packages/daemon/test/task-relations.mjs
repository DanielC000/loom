import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3df86c87 — task parent links + blocks/related/discovered-from relations, and the blocks-vs-
// deferredUntilTaskId single-storage contract (docs/decisions/3df86c87-*.md).
//
// HERMETIC: a real Db on a temp file + a temp git repo (only for the merged/auto-clear step), driving the
// built business logic directly (dist/mcp/tasks.js, dist/tasks/relations.js, dist/db.js) — no daemon.
//
// Proves:
//   (P) parents: set/clear, depth cap (a top card + 2 levels), cycle, self, cross-project, subtree-height
//       on a MOVE, ambiguous id-prefix naming candidates, whole-patch atomicity, delete-a-parent → its
//       children become top-level (and the delete is not blocked by having children).
//   (B) blocks: cycle (2- and 3-node) refused; an edge is OPEN until the blocker is terminal/merged and
//       then RESOLVED (kept as history, never a false block); a blocker closed with 0 commits RESOLVES a
//       plain edge; re-opening the blocker re-opens the edge; a deleted blocker's plain edge is gone.
//   (R) related is symmetric; discoveredFrom/discoveries; relatedTo on create writes a RELATION and NO prose.
//   (Y) ready: only workReady + not held + not deferred + no open blocks; composes with parentId.
//   (D) the alias: deferredUntilTaskId ↔ gates_deferral edges (bare string / array read-back); a plain
//       blockedBy NEVER sets deferred; the SAME 0-commit-closed blocker RESOLVES the plain edge while the
//       alias card stays deferred+STUCK (93669813's semantics are intentionally different); a merged
//       blocker auto-clears the alias and keeps the edge as RELEASED (display-only) resolved history.
//   (M) the boot backfill of the legacy deferred_until_task_id column: one-shot (marker), idempotent,
//       handles bare-string AND JSON-array rows, and the column is FROZEN afterwards.
//   (V) tasks_get view + board roll-up shapes; children.items capped at 100 with exact done/total.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-relations.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { createProjectTask, createProjectTaskChecked, updateProjectTask, getProjectTask, listProjectTasks, toBoardTasks, countProjectTasksAsync, relocateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildRelationView, boardRollup, isOpenBlocker, isCardDone, TASK_STRUCTURE_SHAPE, TASK_CREATE_STRUCTURE_SHAPE } = await import("../dist/tasks/relations.js");
const { taskKey } = await import("../dist/git/worktrees.js");

const repo = path.join(os.tmpdir(), `loom-relations-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo }).toString();
git("init -q");
git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m init`);
const landBlocker = (blockerId, msg) => {
  const branch = `loom/${taskKey(blockerId)}`;
  git(`-c user.email=x@loom -c user.name=x commit --allow-empty -q -m "${msg}" -m "Loom-Worker-Branch: ${branch}"`);
};

const file = path.join(os.tmpdir(), `loom-relations-${Date.now()}-${process.pid}.db`);
let db = new Db(file);
const now = new Date().toISOString();
const mk = (title, extra = {}) => createProjectTask(db, "pRepo", { title, ...extra });
const upd = (id, patch) => updateProjectTask(db, "pRepo", id, patch);
const isErr = (r) => r && typeof r === "object" && "error" in r;
const ok = (r) => !isErr(r);
const view = (id) => buildRelationView(db, db.getTask(id));

try {
  db.insertProject({ id: "pRepo", name: "Repo Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pOther", name: "Other Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  // ---------------- (P) parents ----------------
  const epic = mk("epic card");
  const child = mk("child card");
  const grand = mk("grandchild card");
  const great = mk("great-grandchild card");
  check("(P) parentId set on a child succeeds", ok(await upd(child.id, { parentId: epic.id })));
  check("(P) the child row carries parentId", db.getTask(child.id).parentId === epic.id);
  check("(P) a grandchild (2 levels below the top card) is allowed", ok(await upd(grand.id, { parentId: child.id })));
  const tooDeep = await upd(great.id, { parentId: grand.id });
  check("(P) a 3rd level below the top card is REFUSED", isErr(tooDeep) && /too deep/.test(tooDeep.error));
  check("(P) ...and the error says what WOULD work (attach to its own parent / make top-level)", /parentId:null/.test(tooDeep.error) && /instead/.test(tooDeep.error));
  check("(P) ...and nothing was written by the refused call", db.getTask(great.id).parentId === null);
  const cyc = await upd(epic.id, { parentId: grand.id });
  check("(P) parenting an ancestor under its own descendant is REFUSED as a cycle", isErr(cyc) && /cycle/.test(cyc.error));
  const self = await upd(epic.id, { parentId: epic.id });
  check("(P) a card cannot be its own parent", isErr(self) && /itself/.test(self.error));
  const otherProjTask = createProjectTask(db, "pOther", { title: "task on another board" });
  const cross = await upd(child.id, { parentId: otherProjTask.id });
  check("(P) a cross-project parent is REFUSED, saying relations are same-project only", isErr(cross) && /same-project only/.test(cross.error));
  // subtree height on a MOVE: epic (with 2 levels below it) cannot go under another card, but a leaf can.
  const other = mk("another top card");
  const moveTree = await upd(epic.id, { parentId: other.id });
  check("(P) moving a card that carries 2 levels of its own children under a parent is REFUSED (subtree height counts)", isErr(moveTree) && /too deep/.test(moveTree.error));
  check("(P) moving a leaf under a depth-1 card is fine", ok(await upd(great.id, { parentId: other.id })));
  check("(P) parentId:null clears (top-level again)", ok(await upd(great.id, { parentId: null })) && db.getTask(great.id).parentId === null);
  // whole-patch atomicity: a bad relation in the same patch must leave the title unchanged.
  const t0 = db.getTask(other.id);
  const atomic = await upd(other.id, { title: "renamed?", baseVersion: t0.version, blockedBy: ["nosuchid-0000"] });
  check("(P) an unresolvable relation id rejects the WHOLE patch", isErr(atomic) && /not found/.test(atomic.error));
  check("(P) ...and the title in the same patch was NOT written", db.getTask(other.id).title === "another top card");
  // ambiguous id-prefix names its candidates
  for (const id of ["aaaabbbb-1111-4000-8000-000000000001", "aaaabbbb-2222-4000-8000-000000000002"]) {
    db.insertTask({ id, projectId: "pRepo", title: `crafted ${id.slice(0, 8)}`, body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now, version: 1 });
  }
  const amb = await upd(other.id, { related: ["aaaabbbb"] });
  check("(P) an ambiguous id-prefix errors NAMING the candidates", isErr(amb) && /aaaabbbb-1111/.test(amb.error) && /aaaabbbb-2222/.test(amb.error));
  // delete a parent: children become top-level, and the delete is not blocked.
  const p2 = mk("parent to delete"); const k1 = mk("kid 1"); const k2 = mk("kid 2");
  await upd(k1.id, { parentId: p2.id }); await upd(k2.id, { parentId: p2.id });
  db.deleteTask(p2.id);
  check("(P) deleting a parent with children succeeds and the parent is gone", db.getTask(p2.id) === undefined);
  check("(P) ...its children are now top-level (parent_id NULL)", db.getTask(k1.id).parentId === null && db.getTask(k2.id).parentId === null);

  // ---------------- (B) blocks ----------------
  const a = mk("blk A"); const b = mk("blk B"); const c = mk("blk C");
  check("(B) A blocks B", ok(await upd(a.id, { blocks: [b.id] })));
  check("(B) B blocks C", ok(await upd(b.id, { blocks: [c.id] })));
  const cyc3 = await upd(c.id, { blocks: [a.id] });
  check("(B) C blocks A would close a 3-node cycle and is REFUSED, naming the path", isErr(cyc3) && /cycle/.test(cyc3.error) && cyc3.error.includes(a.id.slice(0, 8)));
  const cyc2 = await upd(a.id, { blockedBy: [b.id] });
  check("(B) A blockedBy B (B is downstream of A) is REFUSED as a cycle", isErr(cyc2) && /cycle/.test(cyc2.error));
  check("(B) ...and the error suggests `related` as the alternative", /related/.test(cyc2.error));
  check("(B) self-block refused", isErr(await upd(a.id, { blocks: [a.id] })));
  check("(B) B's blockedBy view lists A, OPEN (resolved:false)", (() => { const e = view(b.id).relations.blockedBy; return e.length === 1 && e[0].id === a.id && e[0].resolved === false; })());
  check("(B) A's blocks view lists B (reverse side computed, no second row)", view(a.id).relations.blocks.some((e) => e.id === b.id));
  // resolution: blocker A closes done with ZERO commits -> the plain edge RESOLVES.
  await upd(a.id, { columnKey: "done" });
  check("(B) a blocker closed done with 0 commits RESOLVES the plain edge (kept as history, resolved:true)", (() => { const e = view(b.id).relations.blockedBy; return e.length === 1 && e[0].resolved === true; })());
  const roll1 = boardRollup(db, "pRepo", db.listTasks("pRepo")).get(b.id);
  check("(B) the board roll-up reads blockedByOpen 0 once the blocker is closed", roll1.blockedByOpen === 0 && roll1.blockedByFirst === null);
  await upd(a.id, { columnKey: "todo" });
  check("(B) moving the blocker back OUT of the terminal lane re-opens the edge", view(b.id).relations.blockedBy[0].resolved === false);
  const roll2 = boardRollup(db, "pRepo", db.listTasks("pRepo")).get(b.id);
  check("(B) ...and the roll-up names it (blockedByOpen 1, blockedByFirst = A)", roll2.blockedByOpen === 1 && roll2.blockedByFirst?.id === a.id);
  check("(B) isOpenBlocker: a MERGED (mergedSha) blocker outside the terminal lane is resolved; a missing one never blocks",
    isOpenBlocker({ columnKey: "todo", mergedSha: "abc" }, "done") === false && isOpenBlocker(undefined, "done") === false && isOpenBlocker({ columnKey: "todo", mergedSha: null }, "done") === true);
  // deleted blocker: its plain edge goes with it (never a false block).
  const del = mk("blocker to delete"); const dep = mk("depends on deleted");
  await upd(dep.id, { blockedBy: [del.id] });
  db.deleteTask(del.id);
  check("(B) a DELETED blocker's plain edge is gone (no dangling false block)", view(dep.id).relations.blockedBy.length === 0 && db.listRelations("pRepo").every((e) => e.fromTaskId !== del.id));
  // replace semantics
  await upd(dep.id, { blockedBy: [a.id, b.id] });
  await upd(dep.id, { blockedBy: [a.id] });
  check("(B) blockedBy is a whole-set REPLACE (b dropped, a kept)", (() => { const e = view(dep.id).relations.blockedBy.map((x) => x.id); return e.length === 1 && e[0] === a.id; })());

  // ---------------- (R) related / discovered-from / relatedTo ----------------
  const r1 = mk("rel 1"); const r2 = mk("rel 2");
  await upd(r1.id, { related: [r2.id] });
  check("(R) related is visible from BOTH cards", view(r1.id).relations.related[0]?.id === r2.id && view(r2.id).relations.related[0]?.id === r1.id);
  await upd(r2.id, { related: [] });
  check("(R) related:[] from the OTHER side removes the edge", view(r1.id).relations.related.length === 0);
  const found = mk("follow-up found while working");
  await upd(found.id, { discoveredFrom: r1.id });
  check("(R) discoveredFrom recorded; the parent card lists it under `discoveries`", view(found.id).relations.discoveredFrom[0]?.id === r1.id && view(r1.id).relations.discoveries[0]?.id === found.id);
  await upd(found.id, { discoveredFrom: null });
  check("(R) discoveredFrom:null clears", view(found.id).relations.discoveredFrom.length === 0);
  const anchor = mk("anchor card", { body: "anchor body" });
  const viaRelated = createProjectTaskChecked(db, "pRepo", { title: "created with relatedTo" }, { relatedTo: anchor.id });
  check("(R) relatedTo on create creates a real related relation", ok(viaRelated) && view(anchor.id).relations.related[0]?.id === viaRelated.id);
  check("(R) ...and writes NO `Related to:` prose on either card", !/Related to:/.test(db.getTask(viaRelated.id).body) && !/Related to:/.test(db.getTask(anchor.id).body));
  const viaSup = createProjectTaskChecked(db, "pRepo", { title: "created with supersedes" }, { supersedes: anchor.id });
  check("(R) supersedes is UNCHANGED (prose on both cards)", /Supersedes:/.test(db.getTask(viaSup.id).body) && /Superseded by:/.test(db.getTask(anchor.id).body));
  const badCreate = createProjectTaskChecked(db, "pRepo", { title: "created with a bad parent", parentId: "nosuchid-1111" });
  check("(R) a create with an invalid parentId is refused and NO card is left behind", isErr(badCreate) && db.listTasks("pRepo").every((t) => t.title !== "created with a bad parent"));
  const goodCreate = createProjectTaskChecked(db, "pRepo", { title: "created under epic", parentId: epic.id, blockedBy: [anchor.id] });
  check("(R) a create with parentId + blockedBy applies both", ok(goodCreate) && goodCreate.parentId === epic.id && view(goodCreate.id).relations.blockedBy[0]?.id === anchor.id);

  // ---------------- (Y) ready ----------------
  const readyIds = async (opts = {}) => (await listProjectTasks(db, "pRepo", { ready: true, ...opts })).map((t) => t.id);
  const rd = mk("ready card", { columnKey: "todo" });
  const rdBlocked = mk("todo but blocked", { columnKey: "todo" });
  const rdBlocker = mk("open blocker", { columnKey: "in_progress" });
  await upd(rdBlocked.id, { blockedBy: [rdBlocker.id] });
  const rdHeld = mk("todo but held", { columnKey: "todo" });
  await upd(rdHeld.id, { held: true });
  const rdDeferred = mk("todo but deferred", { columnKey: "todo" });
  await upd(rdDeferred.id, { deferred: true, deferredReason: "parked for the test" });
  const rdBacklog = mk("not in the workReady lane", { columnKey: "backlog" });
  let ids = await readyIds();
  check("(Y) an unblocked, unheld, undeferred workReady card IS ready", ids.includes(rd.id));
  check("(Y) a card with an OPEN blocks edge is NOT ready", !ids.includes(rdBlocked.id));
  check("(Y) a held card is NOT ready", !ids.includes(rdHeld.id));
  check("(Y) a deferred card is NOT ready", !ids.includes(rdDeferred.id));
  check("(Y) a card outside the workReady lane is NOT ready", !ids.includes(rdBacklog.id));
  await upd(rdBlocker.id, { columnKey: "done" });
  ids = await readyIds();
  check("(Y) once the blocker closes, the blocked card BECOMES ready", ids.includes(rdBlocked.id));
  await upd(rd.id, { parentId: epic.id });
  ids = await readyIds({ parentId: epic.id });
  check("(Y) ready composes with parentId (only ready children of that parent)", ids.length === 1 && ids[0] === rd.id);
  check("(Y) tasks_list parentId alone returns the direct children", (await listProjectTasks(db, "pRepo", { parentId: epic.id })).map((t) => t.id).sort().join() === [child.id, goodCreate.id, rd.id].sort().join());

  // ---------------- (D) alias ----------------
  const blk1 = mk("alias blocker 1"); const blk2 = mk("alias blocker 2"); const holder = mk("alias holder");
  await upd(holder.id, { deferred: true, deferredUntilTaskId: blk1.id });
  const flagged1 = db.listRelations("pRepo").filter((e) => e.toTaskId === holder.id && e.type === "blocks");
  check("(D) deferredUntilTaskId (one id) is stored as ONE gates_deferral blocks edge", flagged1.length === 1 && flagged1[0].fromTaskId === blk1.id && flagged1[0].gatesDeferral === true);
  check("(D) ...and reads back as a bare string", db.getTask(holder.id).deferredUntilTaskId === blk1.id);
  await upd(holder.id, { deferredUntilTaskId: [blk1.id, blk2.id] });
  const back = db.getTask(holder.id).deferredUntilTaskId;
  check("(D) two ids read back as an ARRAY, in order", Array.isArray(back) && back[0] === blk1.id && back[1] === blk2.id);
  const cycD = await upd(blk1.id, { deferred: true, deferredUntilTaskId: holder.id });
  check("(D) a deferral edge obeys the blocks-cycle rule too", isErr(cycD) && /cycle/.test(cycD.error));
  // plain blockedBy never defers
  const plain = mk("plain blocked card", { columnKey: "todo" });
  await upd(plain.id, { blockedBy: [blk1.id] });
  check("(D) a plain blockedBy edge does NOT set deferred or a deferredUntilTaskId", db.getTask(plain.id).deferred !== true && db.getTask(plain.id).deferredUntilTaskId === null);
  // blockedBy replace must not touch the flagged edges owned by the alias
  await upd(holder.id, { blockedBy: [] });
  check("(D) blockedBy:[] does NOT remove the gates_deferral edges (they belong to deferredUntilTaskId)", Array.isArray(db.getTask(holder.id).deferredUntilTaskId));
  // the SAME 0-commit-closed blocker: plain edge RESOLVED, alias card stays deferred + STUCK
  const zero = mk("zero-commit blocker"); const zPlain = mk("plain dependant"); const zAlias = mk("alias dependant");
  await upd(zPlain.id, { blockedBy: [zero.id] });
  await upd(zAlias.id, { deferred: true, deferredUntilTaskId: zero.id });
  await upd(zero.id, { columnKey: "done" }); // 0 commits
  const zp = await getProjectTask(db, "pRepo", zPlain.id);
  const za = await getProjectTask(db, "pRepo", zAlias.id);
  check("(D) 0-commit close: the PLAIN blocks edge is resolved", zp.relations.blockedBy[0]?.resolved === true);
  check("(D) 0-commit close: the ALIAS card stays deferred:true AND deferredStuck:true (93669813, intentionally different)", za.deferred === true && za.deferredStuck === true);
  // a MERGED blocker auto-clears the alias and keeps the edge as released history
  const mb = mk("mergeable blocker"); const md = mk("alias dependant of a merged blocker");
  await upd(md.id, { deferred: true, deferredUntilTaskId: mb.id });
  landBlocker(mb.id, "feat(test): mergeable blocker landed");
  const mdRead = await getProjectTask(db, "pRepo", md.id);
  check("(D) the merged blocker auto-clears deferred", mdRead.deferred === false && mdRead.deferredUntilTaskId === null);
  const kept = db.listRelations("pRepo").filter((e) => e.toTaskId === md.id && e.fromTaskId === mb.id);
  check("(D) ...and the edge SURVIVES as a released (resolved-history) blocks edge: no gates bit, not declared", kept.length === 1 && kept[0].gatesDeferral === false && kept[0].declared === false && kept[0].released === true);
  check("(D) ...which the view shows as resolved (the release stamped the blocker's merged state — never moved to done here)", view(md.id).relations.blockedBy[0]?.resolved === true && !!db.getTask(mb.id).mergedSha && db.getTask(mb.id).columnKey !== "done");
  const readyAfterRelease = await (async () => {
    const plainDep = mk("plain dependant of the released blocker", { columnKey: "todo" });
    await upd(plainDep.id, { blockedBy: [mb.id] });
    return (await listProjectTasks(db, "pRepo", { ready: true })).some((t) => t.id === plainDep.id);
  })();
  check("(D) ...and ready agrees: a plain dependant of that git-merged blocker is ready", readyAfterRelease === true);
  check("(D) isCardDone is the ONE predicate (terminal lane OR merged stamp)", isCardDone({ columnKey: "done", mergedSha: null }, "done") && isCardDone({ columnKey: "x", mergedSha: "a" }, "done") && !isCardDone({ columnKey: "x", mergedSha: null }, "done"));
  // deleted blocker of an alias: edge kept dangling so the card reads STUCK (793ac76d)
  const gone = mk("alias blocker to delete"); const goneDep = mk("alias dependant of a deleted blocker");
  await upd(goneDep.id, { deferred: true, deferredUntilTaskId: gone.id });
  db.deleteTask(gone.id);
  const goneRead = await getProjectTask(db, "pRepo", goneDep.id);
  check("(D) a deleted alias blocker leaves the card deferred+stuck (edge kept dangling)", goneRead.deferred === true && goneRead.deferredStuck === true);

  // ---------------- (A) atomicity: ONE combined-graph validation, no silent partial write (review 4d3096d0 Major 1) ----------------
  const A1 = mk("atomic A1"); const PA = mk("atomic parent");
  const before1 = db.listTasks("pRepo").length;
  const rA = createProjectTaskChecked(db, "pRepo", { title: "created with a self-cancelling graph", blockedBy: [A1.id], blocks: [A1.id], parentId: PA.id });
  check("(A) repro (a): create {blockedBy:[A], blocks:[A], parentId:P} is REFUSED as a cycle (not a success with parentId dropped)", isErr(rA) && /cycle/.test(rA.error));
  check("(A) ...and no card and no edge was left behind", db.listTasks("pRepo").length === before1 && db.listRelations("pRepo").every((e) => e.toTaskId !== A1.id && e.fromTaskId !== A1.id));
  const Y = mk("atomic Y"); const X = mk("atomic X");
  const rB = await upd(X.id, { deferred: true, deferredUntilTaskId: Y.id, blocks: [Y.id] });
  check("(A) repro (b): update {deferredUntilTaskId:Y, blocks:[Y]} is REFUSED as a cycle (not an ack listing 'blocks' with no edge)", isErr(rB) && /cycle/.test(rB.error));
  check("(A) ...and NOTHING in that patch was written (deferred unchanged, no edges)", db.getTask(X.id).deferred !== true && db.listRelations("pRepo").every((e) => e.fromTaskId !== X.id && e.toTaskId !== X.id));
  const rC = await upd(X.id, { blockedBy: [Y.id], deferredUntilTaskId: Y.id, deferred: true });
  check("(A) blockedBy + deferredUntilTaskId naming the SAME blocker is fine (one edge, flagged)", ok(rC) && db.listRelations("pRepo").filter((e) => e.fromTaskId === Y.id && e.toTaskId === X.id).length === 1);
  await upd(X.id, { deferred: false, deferredUntilTaskId: null, blockedBy: [] });
  // a stale-baseVersion title write plus a parent change: the conflict must leave the parent untouched
  const stale = await upd(PA.id, { title: "renamed via stale write", baseVersion: 999, parentId: epic.id });
  check("(A) a title write refused for a stale baseVersion applies NONE of its structure either", isErr(stale) && stale.conflict === true && db.getTask(PA.id).parentId === null);
  // create with a valid full structure applies everything in one go
  const okC = createProjectTaskChecked(db, "pRepo", { title: "created with full structure", blockedBy: [A1.id], parentId: PA.id }, { relatedTo: [X.id, Y.id] });
  check("(A) a valid create lands parent + blocks + BOTH relatedTo relations together", ok(okC) && db.getTask(okC.id).parentId === PA.id && view(okC.id).relations.blockedBy[0]?.id === A1.id && view(okC.id).relations.related.length === 2);
  check("(A) create inputs have NO `related` field (relatedTo carries it); update keeps `related`", !("related" in TASK_CREATE_STRUCTURE_SHAPE) && ("related" in TASK_STRUCTURE_SHAPE));

  // ---------------- (X) relocate re-homes the deferral alias (review Major 2) ----------------
  db.insertProject({ id: "pOld", name: "Old", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pNew", name: "New", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  const xBlocker = createProjectTask(db, "pOld", { title: "relocate blocker" });
  const xDep = createProjectTask(db, "pOld", { title: "relocate dependant" });
  await updateProjectTask(db, "pOld", xDep.id, { deferred: true, deferredUntilTaskId: xBlocker.id });
  const moved = relocateProjectTask(db, xDep.id, "pNew");
  check("(X) relocate succeeds", ok(moved));
  const inNew = db.listTasks("pNew").find((t) => t.id === xDep.id);
  check("(X) in the NEW project the card still reads its blocker (not a reasonless manual deferral)", inNew?.deferredUntilTaskId === xBlocker.id && inNew?.deferred === true);
  const gotNew = await getProjectTask(db, "pNew", xDep.id);
  check("(X) tasks_get in the new project: blocker kept, deferred:true, deferredStuck:true (the blocker is now cross-project)", gotNew.deferredUntilTaskId === xBlocker.id && gotNew.deferred === true && gotNew.deferredStuck === true);
  db.deleteProject("pOld");
  check("(X) deleteProject(old) does NOT delete the moved card's alias edge", db.getTask(xDep.id).deferredUntilTaskId === xBlocker.id && db.listRelations("pNew").some((e) => e.toTaskId === xDep.id && e.gatesDeferral));
  const xStill = await getProjectTask(db, "pNew", xDep.id);
  check("(X) ...and it still reads deferred+stuck after the old project is gone", xStill.deferred === true && xStill.deferredStuck === true);

  // ---------------- (F) provenance: clearing a deferral never drops a pre-existing plain edge (review Minor 3) ----------------
  const fB = mk("prov blocker"); const fD = mk("prov dependant"); const fB2 = mk("prov blocker 2");
  await upd(fD.id, { blockedBy: [fB.id] });
  await upd(fD.id, { deferred: true, deferredUntilTaskId: [fB.id, fB2.id] });
  check("(F) flagging keeps ONE edge for the pre-existing blocker (no duplicate)", db.listRelations("pRepo").filter((e) => e.fromTaskId === fB.id && e.toTaskId === fD.id).length === 1);
  await upd(fD.id, { deferred: false, deferredUntilTaskId: null });
  const left = db.listRelations("pRepo").filter((e) => e.toTaskId === fD.id && e.type === "blocks");
  check("(F) clearing the deferral clears only the gates bit of the pre-existing declared blockedBy edge (dependency kept)", left.some((e) => e.fromTaskId === fB.id && !e.gatesDeferral));
  check("(F) ...and DELETES the edge the alias itself created", !left.some((e) => e.fromTaskId === fB2.id));
  check("(F) ...the dependency still shows as an open blockedBy", view(fD.id).relations.blockedBy.length === 1 && view(fD.id).relations.blockedBy[0].id === fB.id);

  // ---------------- (K) countsOnly + ready (review Minor 4) ----------------
  const readyList = await listProjectTasks(db, "pRepo", { ready: true });
  const readyCount = await countProjectTasksAsync(db, "pRepo", { ready: true });
  check("(K) countProjectTasksAsync({ready:true}) equals the number of ready rows (" + readyList.length + ")", readyCount.total === readyList.length && readyList.length > 0);
  const allCount = await countProjectTasksAsync(db, "pRepo", {});
  check("(K) ...and differs from the un-filtered count (ready is actually applied)", allCount.total > readyCount.total);

  // ---------------- (E) two independent bits per edge: declared vs gates_deferral (review 8d5f73bd) ----------------
  const eY = mk("bits Y"); const eX = mk("bits X");
  await upd(eX.id, { blockedBy: [eY.id] });
  await upd(eX.id, { deferred: true, deferredUntilTaskId: eY.id });
  const eRefused = await upd(eX.id, { deferred: false, deferredUntilTaskId: null, blocks: [eY.id] });
  check("(E) MAJOR repro: X blockedBy Y, defer on Y, then clear the deferral + blocks:[Y] in one call is REFUSED as a cycle (the declared edge Y->X survives the clear)", isErr(eRefused) && /cycle/.test(eRefused.error));
  check("(E) ...and nothing of that patch was written (still deferred on Y, X not blocking Y)", db.getTask(eX.id).deferredUntilTaskId === eY.id && !view(eX.id).relations.blocks.some((r) => r.id === eY.id));
  const eB = mk("bits B"); const eD = mk("bits D");
  await upd(eD.id, { blockedBy: [eB.id], deferred: true, deferredUntilTaskId: eB.id });
  const eBoth = db.listRelations("pRepo").find((e) => e.fromTaskId === eB.id && e.toTaskId === eD.id);
  check("(E) MINOR (a): blockedBy:[B] + defer on B in ONE call sets BOTH bits on ONE row (declared && gatesDeferral)", !!eBoth && eBoth.declared === true && eBoth.gatesDeferral === true && eBoth.released === false);
  await upd(eD.id, { deferred: false, deferredUntilTaskId: null });
  check("(E) ...and clearing the deferral KEEPS B as a declared blockedBy (open)", (() => { const r = view(eD.id).relations.blockedBy; return r.length === 1 && r[0].id === eB.id && r[0].resolved === false; })());
  const eB2 = mk("bits B2"); const eD2 = mk("bits D2");
  await upd(eD2.id, { blockedBy: [eB2.id] });
  await upd(eD2.id, { deferred: true, deferredUntilTaskId: eB2.id });
  await upd(eD2.id, { blockedBy: [] });
  const eGateOnly = db.listRelations("pRepo").find((e) => e.fromTaskId === eB2.id && e.toTaskId === eD2.id);
  check("(E) MINOR (b): blockedBy:[] clears ONLY the declared bit — the deferral still holds (gatesDeferral, not declared)", !!eGateOnly && eGateOnly.declared === false && eGateOnly.gatesDeferral === true && db.getTask(eD2.id).deferredUntilTaskId === eB2.id);
  check("(E) ...a flagged-only edge still SHOWS under blockedBy (it is a blocker)", view(eD2.id).relations.blockedBy.some((r) => r.id === eB2.id));
  await upd(eD2.id, { deferred: false, deferredUntilTaskId: null });
  check("(E) ...and clearing the deferral afterwards DELETES the row (no resurrection of a dependency the user removed)", !db.listRelations("pRepo").some((e) => e.fromTaskId === eB2.id && e.toTaskId === eD2.id) && view(eD2.id).relations.blockedBy.length === 0);
  // released history: display-only, never a live dependency
  const relRow = db.listRelations("pRepo").find((e) => e.fromTaskId === mb.id && e.toTaskId === md.id);
  check("(E) an auto-released alias edge is kept as RELEASED history (released, not declared, not gates)", !!relRow && relRow.released === true && relRow.declared === false && relRow.gatesDeferral === false);
  check("(E) released marker: the released item is flagged released:true (a declared+done blocker is resolved but NOT released)", view(md.id).relations.blockedBy[0]?.released === true && view(b.id).relations.blockedBy.every((r) => r.released === undefined));
  check("(E) ...shown as resolved history under blockedBy, and NOT counted by the roll-up", view(md.id).relations.blockedBy[0]?.resolved === true && boardRollup(db, "pRepo", db.listTasks("pRepo")).get(md.id).blockedByOpen === 0);
  check("(E) ...and it is NOT in the cycle graph (the reverse dependency md -> mb is allowed)", ok(await upd(mb.id, { blockedBy: [md.id] })));

  // ---------------- (Z) bulk lifecycle keeps the bits right on alias edges (review round 3) ----------------
  db.insertProject({ id: "pZ1", name: "Z1", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pZ2", name: "Z2", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  const zmk = (proj, title) => createProjectTask(db, proj, { title });
  const bothEdge = (from, to) => db.listRelations(db.getTask(to).projectId).find((e) => e.fromTaskId === from && e.toTaskId === to);
  // relocate the DEPENDENT: its alias edge (declared+gates) keeps gates, loses declared, and follows the card
  const zB = zmk("pZ1", "z blocker"); const zD = zmk("pZ1", "z dependant");
  await updateProjectTask(db, "pZ1", zD.id, { blockedBy: [zB.id] });
  await updateProjectTask(db, "pZ1", zD.id, { deferred: true, deferredUntilTaskId: zB.id });
  check("(Z) precondition: the edge carries BOTH bits", (() => { const e = bothEdge(zB.id, zD.id); return e.declared && e.gatesDeferral; })());
  relocateProjectTask(db, zD.id, "pZ2");
  check("(Z) relocate the dependant: the alias edge keeps gates, LOSES declared (relations are same-project only), and is re-homed", (() => { const e = bothEdge(zB.id, zD.id); return !!e && e.gatesDeferral === true && e.declared === false && e.projectId === "pZ2"; })());
  // relocate the BLOCKER: the alias edge into a card left behind loses declared too
  const zB2 = zmk("pZ1", "z blocker 2"); const zD2 = zmk("pZ1", "z dependant 2");
  await updateProjectTask(db, "pZ1", zD2.id, { blockedBy: [zB2.id] });
  await updateProjectTask(db, "pZ1", zD2.id, { deferred: true, deferredUntilTaskId: zB2.id });
  relocateProjectTask(db, zB2.id, "pZ2");
  check("(Z) relocate the BLOCKER: the alias edge is kept (gates) with declared cleared, still in the dependant's project", (() => { const e = bothEdge(zB2.id, zD2.id); return !!e && e.gatesDeferral === true && e.declared === false && e.projectId === "pZ1"; })());
  // delete the BLOCKER: the alias edge stays dangling (stuck) with declared cleared
  const zB3 = zmk("pZ1", "z blocker 3"); const zD3 = zmk("pZ1", "z dependant 3");
  await updateProjectTask(db, "pZ1", zD3.id, { blockedBy: [zB3.id] });
  await updateProjectTask(db, "pZ1", zD3.id, { deferred: true, deferredUntilTaskId: zB3.id });
  db.deleteTask(zB3.id);
  check("(Z) delete the BLOCKER: the alias edge stays dangling with gates set and declared CLEARED", (() => { const e = bothEdge(zB3.id, zD3.id); return !!e && e.gatesDeferral === true && e.declared === false; })());
  // the table's CHECK: no row with every bit clear can exist
  let checkRejected = false;
  try { db.db.prepare("INSERT INTO task_relations (id, project_id, from_task_id, to_task_id, type, declared, gates_deferral, released, created_at) VALUES ('x','pRepo','a','b','blocks',0,0,0,'t')").run(); } catch { checkRejected = true; }
  check("(Z) the CHECK constraint rejects an edge row with declared=gates=released=0", checkRejected);

  // ---------------- (O) OUTGOING blocks items: resolved comes from the edge's BLOCKER (the displayed card), card dc1e27fe ----------------
  const oDone = mk("outgoing: finished blocker"); const oOpen = mk("outgoing: not-done blocker"); const oTarget = mk("outgoing: blocked card", { columnKey: "todo" });
  await upd(oDone.id, { blocks: [oTarget.id] });
  await upd(oOpen.id, { blocks: [oTarget.id] });
  await upd(oDone.id, { columnKey: "done" });
  const oDoneOut = view(oDone.id).relations.blocks.find((r) => r.id === oTarget.id);
  const oOpenOut = view(oOpen.id).relations.blocks.find((r) => r.id === oTarget.id);
  check("(O) a TERMINAL-lane blocker's OUTGOING blocks item reads resolved:true (the blocked card is still To Do)", oDoneOut?.resolved === true);
  check("(O) a NOT-DONE blocker's outgoing item reads resolved:false", oOpenOut?.resolved === false);
  const oIn = view(oTarget.id).relations.blockedBy;
  check("(O) the reverse side agrees: the blocked card's blockedBy shows the finished blocker resolved and the open one not", oIn.find((r) => r.id === oDone.id)?.resolved === true && oIn.find((r) => r.id === oOpen.id)?.resolved === false);
  await upd(oTarget.id, { columnKey: "done" });
  check("(O) closing the BLOCKED card does not resolve an open blocker's outgoing edge", view(oOpen.id).relations.blocks.find((r) => r.id === oTarget.id)?.resolved === false);

  // ---------------- (V) views + caps ----------------
  const bigEpic = mk("wide epic");
  for (let i = 0; i < 105; i++) { const k = mk(`wide child ${i}`); db.setTaskParent(k.id, bigEpic.id); if (i < 5) db.updateTask(k.id, { columnKey: "done" }); }
  const wide = view(bigEpic.id);
  check("(V) children.items is capped at 100", wide.children.items.length === 100);
  check("(V) ...while total and done stay EXACT (105 / 5)", wide.children.total === 105 && wide.children.done === 5);
  const tg = await getProjectTask(db, "pRepo", bigEpic.id);
  check("(V) tasks_get (getProjectTask) carries parentId/parent/children/relations", "parentId" in tg && "parent" in tg && tg.children.total === 105 && "relations" in tg);
  const rowsL = await listProjectTasks(db, "pRepo", { parentId: bigEpic.id, limit: 3 });
  check("(V) tasks_list summary rows carry parentId", rowsL.length === 3 && rowsL.every((r) => r.parentId === bigEpic.id));
  const bt = toBoardTasks(db.listTasks("pRepo"), "done", boardRollup(db, "pRepo", db.listTasks("pRepo")));
  const btEpic = bt.find((t) => t.id === bigEpic.id);
  check("(V) board list rows carry the light roll-up (childCount/childDone/blockedByOpen/blockedByFirst) and no relation arrays",
    btEpic.childCount === 105 && btEpic.childDone === 5 && btEpic.blockedByOpen === 0 && btEpic.blockedByFirst === null && !("relations" in btEpic));

  // ---------------- (M) boot backfill of the legacy column ----------------
  const legacyBlk1 = mk("legacy blocker 1"); const legacyBlk2 = mk("legacy blocker 2"); const legacyBlk3 = mk("legacy blocker 3");
  const legacyBare = mk("legacy dependant (bare string)"); const legacyArr = mk("legacy dependant (json array)");
  const beforeEdges = db.listRelations("pRepo").length;
  db.close();
  {
    const raw = new Database(file);
    raw.prepare("UPDATE tasks SET deferred = 1, deferred_until_task_id = ? WHERE id = ?").run(legacyBlk1.id, legacyBare.id);
    raw.prepare("UPDATE tasks SET deferred = 1, deferred_until_task_id = ? WHERE id = ?").run(JSON.stringify([legacyBlk2.id, legacyBlk3.id]), legacyArr.id);
    raw.prepare("DELETE FROM app_meta WHERE key = ?").run("task_deferral_edges_backfill_done"); // a pre-upgrade DB has no marker
    raw.close();
  }
  db = new Db(file); // the constructor runs the migrations, incl. the one-shot backfill
  const afterBoot = db.listRelations("pRepo");
  check("(M) boot backfill: a bare-string row becomes a flagged edge, projected back as a string", db.getTask(legacyBare.id).deferredUntilTaskId === legacyBlk1.id);
  check("(M) boot backfill: a JSON-array row becomes two flagged edges, projected back as an array in order", (() => { const v = db.getTask(legacyArr.id).deferredUntilTaskId; return Array.isArray(v) && v[0] === legacyBlk2.id && v[1] === legacyBlk3.id; })());
  check("(M) boot backfill added exactly 3 edges (before/after: " + beforeEdges + " -> " + afterBoot.length + ")", afterBoot.length === beforeEdges + 3);
  const second = db.backfillDeferralEdgesOnce();
  check("(M) a second run is a no-op (marker present) — no duplicated edges", second === undefined && db.listRelations("pRepo").length === afterBoot.length);
  db.close();
  {
    const raw = new Database(file);
    raw.prepare("UPDATE tasks SET deferred_until_task_id = ? WHERE id = ?").run(legacyBlk3.id, legacyBare.id); // the FROZEN column drifts
    raw.close();
  }
  db = new Db(file);
  check("(M) the column is FROZEN: drift in it after the backfill is never re-read on a later boot", db.getTask(legacyBare.id).deferredUntilTaskId === legacyBlk1.id && db.listRelations("pRepo").length === afterBoot.length);
} finally {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — parents are depth-capped/cycle-safe/same-project, blocks resolves at read time (0-commit closes resolve it, deferral aliases keep their stuck semantics), ready is exact, and the legacy column backfills once."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
