import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card eb58b8bd — scan the MAINLINE ref, not bare "HEAD", in the orphan-landed sweep (boot-reconcile Pass
// A) and findLandedSquashCommitViaMap's own base, mirroring d69d4858's fix for the solo confirm path.
//
// d69d4858 (see solo-merge-watermark-branch-pin.mjs) pinned the SOLO confirm path's already-landed lookups
// to the stored mainline watermark branch instead of bare HEAD — but that file's own banner explicitly
// says (OUT OF SCOPE, carded separately, eb58b8bd): "the periodic orphan sweep and
// findLandedSquashCommitViaMap also scan HEAD — not touched here." THIS file closes that gap.
//
// Mechanism: `reconcileOrchestrationOnBoot`'s Pass A finalizes a worker (removes its worktree, deletes its
// branch, moves its task to a terminal column) the moment it finds a `Loom-Worker-Branch:` trailer commit
// reachable from its scan base. If the canonical checkout is DIVERTED to a stray branch (a same-commit
// checkout, a GitWriter tool, a manual checkout) and a trailer commit for a worker's branch lands on THAT
// stray branch rather than on mainline, scanning bare "HEAD" trusts whatever the checkout happens to be
// sitting on and finalizes a worker whose work never actually reached mainline — silent data loss,
// structurally identical to the hazard d69d4858 closed for the solo path.
//
// REAL git on temp repos, NO claude and NO live daemon — drives reconcileOrchestrationOnBoot() directly,
// mirroring boot-reconcile-batch-lookup.mjs's own direct-drive shape, with solo-merge-watermark-branch-
// pin.mjs's watermark-seed/divert idioms. Proves:
//   (A) RED-FIRST — watermark stamped on MAIN; canonical diverted to a stray branch; the worker's real
//       trailer commit lands on the STRAY branch only. Pass A must NOT finalize: worktree retained, no
//       merge_done recorded, task stays non-terminal. Run this against pre-card code (revert
//       sessions/service.ts's Pass A wiring, rebuild, re-run) to see this assertion fail.
//   (B) CONTROL (unchanged ordinary finalization) — watermark stamped, the worker's real trailer commit
//       lands for real on mainline (no divert) — Pass A still finalizes exactly as before this card.
//   (C) CONTROL (no watermark yet) — true first sight for this (project, repoKey): no watermark ever
//       stamped, real trailer commit lands on mainline (no divert) — Pass A still finalizes (absent ⇒
//       "HEAD" fallback, byte-identical to today).
//   (D) UNREADABLE — the watermark row is corrupt (non-JSON), canonical genuinely on mainline with a REAL
//       trailer commit (the exact shape that WOULD look "already landed" via the old bare-HEAD scan).
//       Pass A must fail CLOSED: skip finalizing this pass (worktree retained, no merge_done) rather than
//       guess either way. A SECOND reconcile call after the row is repaired to valid JSON DOES finalize —
//       proving this is a skip-and-retry, never a permanent wedge.
//   (F) UNRESOLVABLE REF (Code Review round 2, card eb58b8bd, minor 1) — the watermark row parses fine
//       (valid JSON) but NAMES a branch that no longer exists (a rename/delete) — same landed-looking
//       mainline-HEAD precondition as (D). Pass A must fail CLOSED the same way, but must ALSO fire its
//       own counted warning naming THIS project/branch, not silently degrade like an ordinary "not
//       landed" miss would.
//   (E) findLandedSquashCommitViaMap's own `base` param, isolated from Pass A's wiring — against a
//       diverted canonical (stray-only trailer commit), base:"HEAD" and base:<mainline ref> must disagree,
//       and the composite (repoPath, base) cache key must not let one answer leak into the other on
//       repeat, same-process calls (E), including under a CONCURRENT race on the same two bases (E2).
//
// Run: 1) build daemon (pnpm build), 2) node test/boot-reconcile-orphan-sweep-watermark-branch-pin.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
useOwnLoomHome("loom-bosw-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, findLandedSquashCommitViaMap } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bosw@loom -c user.name=bosw";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const db = new Db();
const sessions = new SessionService(db, {}, new OrchestrationControl());
const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;
// Code Review round 2 (card eb58b8bd) minor 1: scenario (F) below asserts the NEW unresolvable-watermark-
// ref warning actually fires (naming the affected project/branch), not just that Pass A skips finalizing
// — same capture idiom as batch-merge-watermark-branch-pin.mjs's own analogous check.
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); realWarn(...a); };

const mk = (label) => ({
  projId: `bosw-${label}-proj-${sfx}`, agentId: `bosw-${label}-agent-${sfx}`, mgrId: `bosw-${label}-mgr-${sfx}`,
  taskId: `bosw-${label}-task-${sfx}`, workerId: `bosw-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-bosw-${label}-repo-${sfx}`),
});
function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# bosw\n");
  git(P.repo, "init", "-q");
  git(P.repo, "config", "core.autocrlf", "false");
  git(P.repo, "config", "user.email", "bosw@loom");
  git(P.repo, "config", "user.name", "bosw");
  commitAll(P.repo, "init", GIT_ID);
  return git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
}
function seedProjectTaskWorker(P) {
  db.insertProject({ id: P.projId, name: "BOSW", repoPath: P.repo, vaultPath: P.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: P.taskId, projectId: P.projId, title: "BOSW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: P.workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: P.taskId, worktreePath: P.worktreePath, branch: P.branch });
}
async function addWorker(P) {
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, P.taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feat.ts"), "export const feat = 1;\n");
  commitAll(worktreePath, "feat: real work", GIT_ID);
  P.worktreePath = worktreePath; P.branch = branch;
}
const isTerminal = (P) => db.getTask(P.taskId)?.columnKey !== "in_progress";

// ── (A) RED-FIRST: canonical diverted, trailer commit on the STRAY branch only — must NOT finalize ────────
{
  const A = mk("a");
  const MAIN = makeRepo(A);
  await addWorker(A);
  seedProjectTaskWorker(A);
  db.setMeta(MW.mainlineWatermarkKey(A.projId, "primary"), JSON.stringify({ branch: MAIN, sha: git(A.repo, "rev-parse", "HEAD") }));

  git(A.repo, "checkout", "-q", "-b", "strayA"); // divert — no new commit yet, same sha as mainline
  git(A.repo, "merge", "-q", "--squash", A.branch);
  commitAll(A.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${A.branch}`], GIT_ID);
  const strayTip = git(A.repo, "rev-parse", "HEAD");
  const mainTip = git(A.repo, "rev-parse", MAIN);
  check("(A) precondition: the trailer commit is on the STRAY branch", git(A.repo, "log", "strayA", `--grep=Loom-Worker-Branch: ${A.branch}`, "--format=%H") === strayTip);
  check("(A) precondition: mainline's own ref carries NO such trailer", git(A.repo, "log", MAIN, `--grep=Loom-Worker-Branch: ${A.branch}`, "--format=%H") === "");
  check("(A) precondition: canonical is genuinely on the stray branch", git(A.repo, "symbolic-ref", "--short", "HEAD") === "strayA");

  const rA = await sessions.reconcileOrchestrationOnBoot();
  check("(A) worktree is RETAINED (not finalized)", fs.existsSync(A.worktreePath));
  check("(A) NO merge_done was recorded for this worker", mergeDoneCount(A.mgrId) === 0);
  check("(A) the task stays non-terminal", !isTerminal(A));
  check("(A) mainline's own ref is untouched", git(A.repo, "rev-parse", MAIN) === mainTip);
  check("(A) rA.mergesFinished counts nothing for this worker (0 — the only session in this reconcile call)", rA.mergesFinished === 0);
}

// ── (B) CONTROL: ordinary finalization (watermark stamped, real landing on mainline, no divert) ───────────
{
  const B = mk("b");
  const MAIN = makeRepo(B);
  await addWorker(B);
  seedProjectTaskWorker(B);
  db.setMeta(MW.mainlineWatermarkKey(B.projId, "primary"), JSON.stringify({ branch: MAIN, sha: git(B.repo, "rev-parse", "HEAD") }));

  git(B.repo, "merge", "-q", "--squash", B.branch);
  commitAll(B.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${B.branch}`], GIT_ID);
  check("(B) precondition: canonical is genuinely on MAIN (no divert)", git(B.repo, "symbolic-ref", "--short", "HEAD") === MAIN);

  const rB = await sessions.reconcileOrchestrationOnBoot();
  check("(B) worktree IS removed (finalized)", !fs.existsSync(B.worktreePath));
  check("(B) a merge_done WAS recorded", mergeDoneCount(B.mgrId) === 1);
  check("(B) the task reached a terminal column", isTerminal(B));
  check("(B) rB.mergesFinished === 1", rB.mergesFinished === 1);
}

// ── (C) CONTROL: true first sight — no watermark ever stamped, real landing on mainline, no divert ─────────
{
  const C = mk("c");
  const MAIN = makeRepo(C);
  await addWorker(C);
  seedProjectTaskWorker(C);
  // Deliberately NOT stamping a watermark for (C.projId, "primary") — true first sight.

  git(C.repo, "merge", "-q", "--squash", C.branch);
  commitAll(C.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${C.branch}`], GIT_ID);
  check("(C) precondition: canonical is genuinely on MAIN", git(C.repo, "symbolic-ref", "--short", "HEAD") === MAIN);

  const rC = await sessions.reconcileOrchestrationOnBoot();
  check("(C) with no watermark, Pass A still finalizes (absent ⇒ HEAD fallback, unchanged)", !fs.existsSync(C.worktreePath));
  check("(C) a merge_done WAS recorded", mergeDoneCount(C.mgrId) === 1);
  check("(C) the task reached a terminal column", isTerminal(C));
  check("(C) rC.mergesFinished === 1", rC.mergesFinished === 1);
}

// ── (D) UNREADABLE: a corrupt watermark row fails CLOSED (skip, never guess), then retries once repaired ──
{
  const D = mk("d");
  const MAIN = makeRepo(D);
  await addWorker(D);
  seedProjectTaskWorker(D);
  const KEY = MW.mainlineWatermarkKey(D.projId, "primary");
  db.setMeta(KEY, "this is not json at all");

  // The shape that WOULD look "already landed" via the old bare-HEAD scan: a real trailer commit sitting
  // right on the CURRENT mainline HEAD, no divert at all.
  git(D.repo, "merge", "-q", "--squash", D.branch);
  commitAll(D.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${D.branch}`], GIT_ID);
  const landedLookingSha = git(D.repo, "rev-parse", "HEAD");
  check("(D) precondition: a trailer commit for this worker sits on the CURRENT mainline HEAD", git(D.repo, "log", MAIN, `--grep=Loom-Worker-Branch: ${D.branch}`, "--format=%H") === landedLookingSha);

  const rD1 = await sessions.reconcileOrchestrationOnBoot();
  check("(D) pass 1: worktree is RETAINED (fails closed on the unreadable row)", fs.existsSync(D.worktreePath));
  check("(D) pass 1: NO merge_done was recorded", mergeDoneCount(D.mgrId) === 0);
  check("(D) pass 1: the task stays non-terminal", !isTerminal(D));
  check("(D) pass 1: rD1.mergesFinished === 0", rD1.mergesFinished === 0);

  // Repair the row to a valid watermark matching the real checkout, then retry.
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: landedLookingSha }));
  const rD2 = await sessions.reconcileOrchestrationOnBoot();
  check("(D) pass 2 (repaired row): worktree IS removed — this was a skip-and-retry, not a permanent wedge", !fs.existsSync(D.worktreePath));
  check("(D) pass 2: a merge_done WAS recorded", mergeDoneCount(D.mgrId) === 1);
  check("(D) pass 2: the task reached a terminal column", isTerminal(D));
  check("(D) pass 2: rD2.mergesFinished === 1", rD2.mergesFinished === 1);
}

// ── (F) WATERMARK NAMES AN UNRESOLVABLE BRANCH (renamed/deleted) — Code Review round 2 minor 1 ────────────
// A well-formed watermark row ("ok" state — valid JSON, parses fine) can still name a branch that no
// longer exists (a master->main rename, a manually deleted branch). Pass A must fail CLOSED exactly like
// the unreadable-row case (D) above: skip this session's landed-lookup/finalize, never fall back to
// scanning bare HEAD — but UNLIKE (D)'s generic warning, it must ALSO name THIS specific project/branch in
// its own counted, once-per-pass log line, so an operator isn't left silently wondering why finalization
// stopped for a project whose row parses perfectly fine.
{
  const F = mk("f");
  const MAIN = makeRepo(F);
  await addWorker(F);
  seedProjectTaskWorker(F);
  const GHOST_BRANCH = `ghost-${sfx}`; // deliberately never created in this repo
  db.setMeta(MW.mainlineWatermarkKey(F.projId, "primary"), JSON.stringify({ branch: GHOST_BRANCH, sha: git(F.repo, "rev-parse", "HEAD") }));

  // The shape that WOULD look "already landed" via the old bare-HEAD scan (same precondition as (D)): a
  // real trailer commit sitting right on the CURRENT mainline HEAD, no divert at all — but here the
  // watermark row itself parses fine; only the NAMED branch is unresolvable.
  git(F.repo, "merge", "-q", "--squash", F.branch);
  commitAll(F.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${F.branch}`], GIT_ID);
  const landedLookingShaF = git(F.repo, "rev-parse", "HEAD");
  check("(F) precondition: a trailer commit for this worker sits on the CURRENT mainline HEAD", git(F.repo, "log", MAIN, `--grep=Loom-Worker-Branch: ${F.branch}`, "--format=%H") === landedLookingShaF);
  check("(F) precondition: the named watermark branch genuinely does not exist", git(F.repo, "branch", "--list", GHOST_BRANCH) === "");

  const warnedBefore = warned.length;
  const rF = await sessions.reconcileOrchestrationOnBoot();
  check("(F) worktree is RETAINED (fails closed on the unresolvable ref, never falls back to HEAD)", fs.existsSync(F.worktreePath));
  check("(F) NO merge_done was recorded", mergeDoneCount(F.mgrId) === 0);
  check("(F) the task stays non-terminal", !isTerminal(F));
  check("(F) rF.mergesFinished === 0", rF.mergesFinished === 0);
  const newWarningsF = warned.slice(warnedBefore);
  check("(F) the once-per-pass log fires, naming THIS project and the ghost branch",
    newWarningsF.some((w) => w.includes("stored mainline watermark names a branch that no longer resolves") && w.includes(F.projId) && w.includes(GHOST_BRANCH)));
}

// ── (E) findLandedSquashCommitViaMap's own `base` param + composite cache key, isolated from Pass A ────────
{
  const E = mk("e");
  const MAIN = makeRepo(E);
  await addWorker(E);
  const MAINREF = `refs/heads/${MAIN}`;

  git(E.repo, "checkout", "-q", "-b", "strayE");
  git(E.repo, "merge", "-q", "--squash", E.branch);
  commitAll(E.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${E.branch}`], GIT_ID);
  check("(E) precondition: canonical is diverted to the stray branch", git(E.repo, "symbolic-ref", "--short", "HEAD") === "strayE");

  const viaHead = await findLandedSquashCommitViaMap(E.repo, E.branch, "HEAD");
  check("(E) base:\"HEAD\" (= the stray branch) reports a HIT — the stray-only trailer commit IS reachable from bare HEAD", viaHead.hit === true && typeof viaHead.sha === "string");

  const viaMain = await findLandedSquashCommitViaMap(E.repo, E.branch, MAINREF);
  check("(E) base:<mainline ref> reports a clean, FULLY-SCANNED miss — the trailer commit is absent from mainline's own history", viaMain.hit === false && viaMain.scanComplete === true);

  // Repeat BOTH calls once more, interleaved, to prove the composite (repoPath, base) cache key — not one
  // cached scan silently reused for the other base on the SAME repoPath.
  const viaHead2 = await findLandedSquashCommitViaMap(E.repo, E.branch, "HEAD");
  const viaMain2 = await findLandedSquashCommitViaMap(E.repo, E.branch, MAINREF);
  check("(E) repeat base:\"HEAD\" call is STILL a hit (cache didn't get clobbered by the mainline-ref call)", viaHead2.hit === true && viaHead2.sha === viaHead.sha);
  check("(E) repeat base:<mainline ref> call STILL disagrees (cache didn't get clobbered by the HEAD call)", !(viaMain2.hit && viaMain2.sha === viaHead.sha));
}

// ── (E2) CONCURRENT composite-key race, isolated from (E)'s own already-cached state ────────────────────
// Code Review round 2 (card eb58b8bd) minor 2: (E) above runs its two base calls SEQUENTIALLY — by the
// time either reaches getOrStartMergedMapScan, the other has already settled and cleared its in-flight
// entry, so (E) alone can never exercise mergedMapInFlight's actual dedup race. The in-flight map's
// composite (repoPath, base) key is load-bearing specifically for TWO calls racing concurrently; a repoPath-
// only in-flight key would let the second concurrent call join the first's already-registered promise and
// silently receive the WRONG base's answer. Uses a fresh repo/branch (never touched by (E)) so neither
// concurrent call can be served from mergedMapCache's settled entries either.
{
  const E2 = mk("e2");
  const MAIN2 = makeRepo(E2);
  await addWorker(E2);
  const MAIN2REF = `refs/heads/${MAIN2}`;

  git(E2.repo, "checkout", "-q", "-b", "strayE2");
  git(E2.repo, "merge", "-q", "--squash", E2.branch);
  commitAll(E2.repo, ["BOSW-TASK", `Loom-Worker-Branch: ${E2.branch}`], GIT_ID);
  check("(E2) precondition: canonical is diverted to the stray branch", git(E2.repo, "symbolic-ref", "--short", "HEAD") === "strayE2");

  const [viaHeadConcurrent, viaMainConcurrent] = await Promise.all([
    findLandedSquashCommitViaMap(E2.repo, E2.branch, "HEAD"),
    findLandedSquashCommitViaMap(E2.repo, E2.branch, MAIN2REF),
  ]);
  check("(E2) concurrent base:\"HEAD\" (= the stray branch) still reports a HIT", viaHeadConcurrent.hit === true && typeof viaHeadConcurrent.sha === "string");
  check("(E2) concurrent base:<mainline ref> still reports a clean, FULLY-SCANNED miss — NOT the HEAD call's hit leaked across the race", viaMainConcurrent.hit === false && viaMainConcurrent.scanComplete === true);
}

console.warn = realWarn;
console.log(failures === 0
  ? "\n✅ ALL PASS — boot-reconcile Pass A's orphan sweep (and findLandedSquashCommitViaMap's own base) now scan the stored mainline watermark ref instead of bare HEAD: a diverted canonical carrying a stray-only trailer commit is never finalized (A), ordinary landings on mainline still finalize whether a watermark is stamped (B) or not yet (C), an unreadable watermark row fails closed as a skip-and-retry rather than a guess or a permanent wedge (D), a watermark naming an unresolvable (renamed/deleted) branch also fails closed AND fires its own named, counted warning (F), and the cache correctly keeps two different scan bases for the same repo independent both sequentially (E) and under concurrent racing calls (E2)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exitCode = failures === 0 ? 0 : 1;
