import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// card a5d9c458 (P1 DATA-LOSS CLASS) — the two DB-free/pre-spawn halves of the fix, proven directly
// against createWorktree + SessionService.reclaimWedgedWorktreePathForSpawn. REAL git on temp repos
// under %TEMP%, NO claude and NO live daemon. The third half (gcWorktreeDir's `staleKnowledge`
// live-claim re-check, exercised via the background sweep) is proven in worktree-wedge-retry.mjs.
//
// (A) createWorktree must NEVER reuse/recut a dir that exists but has NO `.git` link (a half-removed
//     orphan — an earlier removal attempt dropped git's own worktree admin record + `.git` link but
//     couldn't finish deleting the directory contents) as if it were a retained worktree. It must set
//     the dir aside (never delete — it may hold uncommitted work) and cut a fresh worktree/branch at
//     the original path instead. Before the fix, this exact shape reproduced the incident's own error:
//     `fatal: ambiguous argument '<sha>...loom/<key>': unknown revision or path not in the working tree`.
//
// (B) SessionService.reclaimWedgedWorktreePathForSpawn (called immediately before every
//     createWorktree(...) call in service.ts) must clear a stale WedgedWorktreeEntry for the exact
//     path a respawn is about to claim BEFORE createWorktree ever touches it — renaming any dir still
//     sitting there aside (never deleting it) and dropping the stale tracking entry, so neither this
//     spawn's own createWorktree call nor a later wedge-sweep tick can collide with it.
//
// (C) the pre-spawn check is a harmless no-op when the path isn't wedge-tracked.
//
// ROUND 2 (Code Review ffc2b31b) additions:
// (D) createWorktree's own rename-aside FAILS — must THROW, never silently reuse/recut the dir. Uses the
//     `__setRenameDirAsideForTest` seam, which has shipped since round 2 — this section FAILS (not SKIPS)
//     when that seam is absent, so a later removal/rename of it is caught rather than silently unexercised.
// (E) reclaimWedgedWorktreePathForSpawn's own rename-aside FAILS — must REFUSE the spawn (throw) rather
//     than letting createWorktree proceed against a dir in an unknown state, and must KEEP the wedge
//     entry (there is still something there a later retry needs to deal with). Same seam, same FAIL
//     (not SKIP) posture when absent.
// (F) a "starting" claimant (mid-spawn, before the session flips to "live") protects a wedge-tracked
//     path from the background sweep exactly like a "live" one does.
// (G) reclaimWedgedWorktreePathForSpawn renames a wedge-tracked dir aside EVEN WHEN it still has a
//     valid `.git` link — unlike createWorktree's own half-removed-dir check, a wedge-tracked path's
//     whole lifecycle already ended regardless of what got left behind.
//
// ROUND 3 (delta Code Review 133a89bc) addition:
// (H) MUTUAL EXCLUSION — a respawn's reclaimWedgedWorktreePathForSpawn racing in while a removal is
//     still settling against that exact path (including removeWorktree's OWN clean-reject retry delay)
//     must REFUSE outright, never recreate a fresh worktree there while the old removal is in flight.
//
// ROUND 3 (card 623a7a62, Code Review 44cac5fd finding 2) addition:
// (J) the SAME mutual exclusion as (H), widened to a path that OVERLAPS (not exact-equals) one marked
//     REMOVING — a respawn's target CONTAINING or CONTAINED BY a removal-in-flight path must refuse too.
//
// Card ceeb188b (Code Review of 367d53f6, finding 2 — c994ffeb's own finding 1 fixed createWorktree's
// OWN reverse check; this is the SAME predicate consulted a second time):
// (I) reclaimWedgedWorktreePathForSpawn must NOT rename aside a wedge-tracked path that is really a
//     repo-axis dir holding a REAL, live nested secondary-repo worktree — refuse instead (throw, keep
//     the wedge entry, release the claim), leaving the nested worktree's data + git registration intact.
// (I-control) BEHAVIOURAL NEGATIVE CONTROL: disabling the shared backstop flag (the SAME
//     __setWorktreeCollisionBackstopForTest seam createWorktree's own reverse check uses — card ceeb188b
//     deliberately reuses it rather than adding a second one) brings the pre-fix bug back.
// (I-resolve) the refusal is NOT permanent — once the nested worktree is removed (simulating it being
//     merged/stopped), the SAME wedge-tracked path reclaims and respawns normally.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/createworktree-wedge-reclaim.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-cwr-home-");
requireHermeticEnv();

const {
  createWorktree, resolveWorktreePath, normForCompare, killableRemoveDir, __setRenameDirAsideForTest,
  taskKey, __setWorktreeCollisionBackstopForTest,
} = await import("../dist/git/worktrees.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cwr@loom -c user.name=cwr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const head = (cwd) => git(cwd, "rev-parse HEAD");

// A sibling path matching `${target}.stale-<ts>` under the SAME parent dir — the "renamed aside, never
// deleted" destination both fixes use. Returns the first match or null.
function findStaleAside(target) {
  const parent = path.dirname(target);
  const base = path.basename(target);
  if (!fs.existsSync(parent)) return null;
  const hit = fs.readdirSync(parent).find((e) => e.startsWith(`${base}.stale-`));
  return hit ? path.join(parent, hit) : null;
}

const repo = path.join(os.tmpdir(), `loom-cwr-repo-${Date.now()}-${process.pid}`);
const PROJ = "projCwr";

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# cwr test\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const mainHead = head(repo);

  // ============================================================================================
  // (A) a dir exists at the target path with NO `.git` link — must be set aside, never reused/recut.
  // ============================================================================================
  const taskA = "halfremoved-aaaa-1111";
  const pathA = resolveWorktreePath(PROJ, taskA);
  fs.mkdirSync(pathA, { recursive: true });
  fs.writeFileSync(path.join(pathA, "orphan-leftover.txt"), "half-removed orphan content\n");
  check("(A setup) the half-removed dir has no .git link", !fs.existsSync(path.join(pathA, ".git")));

  const resultA = await createWorktree(repo, PROJ, taskA);
  check("(A) createWorktree still returns the SAME deterministic path", resultA.worktreePath === pathA);
  check("(A) a FRESH, real worktree now sits there (.git link present)", fs.existsSync(path.join(pathA, ".git")));
  check("(A) the fresh worktree's HEAD == current main (cut off HEAD, not re-cut from nothing)", head(pathA) === mainHead);
  check("(A) on the correct loom/<key> branch", git(pathA, "rev-parse --abbrev-ref HEAD") === resultA.branch);
  check("(A) the orphan's own leftover file is GONE from the fresh worktree (not merged in)", !fs.existsSync(path.join(pathA, "orphan-leftover.txt")));

  const asideA = findStaleAside(pathA);
  check("(A) the OLD half-removed dir was renamed ASIDE, never deleted", asideA !== null);
  if (asideA) {
    check("(A) the renamed-aside dir still carries the orphan's ORIGINAL content", fs.readFileSync(path.join(asideA, "orphan-leftover.txt"), "utf8") === "half-removed orphan content\n");
    check("(A) the renamed-aside dir has no .git link either (it's the same dead leftover, just moved)", !fs.existsSync(path.join(asideA, ".git")));
    fs.rmSync(asideA, { recursive: true, force: true });
  }
  execSync(`git worktree remove --force "${pathA}"`, { cwd: repo });

  // ============================================================================================
  // (B) a path is wedge-tracked AND still holds a half-removed dir — reclaimWedgedWorktreePathForSpawn
  //     (called before createWorktree, as service.ts does at both its real call sites) must rename it
  //     aside and clear the tracking entry; createWorktree then cuts a genuinely fresh worktree there.
  // ============================================================================================
  const taskB = "reclaim-spawn-bbbb-2222";
  const pathB = resolveWorktreePath(PROJ, taskB);
  fs.mkdirSync(pathB, { recursive: true });
  fs.writeFileSync(path.join(pathB, "old-orphan.txt"), "stale wedged content\n");

  const db = new Db();
  db.recordWorktreeWedgeAttempt(pathB, repo, "simulated wedge from an earlier boot pass");
  check("(B setup) the path is tracked as wedged before the pre-spawn check runs", db.getWedgedWorktree(pathB) !== undefined);
  const sessions = new SessionService(db, {}, new OrchestrationControl(), {});

  sessions.reclaimWedgedWorktreePathForSpawn(PROJ, taskB);
  check("(B) the old dir is GONE from the original path (renamed aside, not deleted in place)", !fs.existsSync(pathB));
  check("(B) the wedge-tracking entry was DROPPED", db.getWedgedWorktree(pathB) === undefined);
  const asideB = findStaleAside(pathB);
  check("(B) the old content survives, renamed aside", asideB !== null && fs.readFileSync(path.join(asideB, "old-orphan.txt"), "utf8") === "stale wedged content\n");

  const resultB = await createWorktree(repo, PROJ, taskB);
  check("(B) createWorktree now cuts a GENUINELY FRESH worktree at the original path", resultB.worktreePath === pathB && fs.existsSync(path.join(pathB, ".git")));
  check("(B) the fresh worktree's HEAD == current main", head(pathB) === mainHead);
  check("(B) a LATER sweep tick has nothing stale left to trip over this path", db.getWedgedWorktree(pathB) === undefined);

  if (asideB) fs.rmSync(asideB, { recursive: true, force: true });
  execSync(`git worktree remove --force "${pathB}"`, { cwd: repo });
  db.close();

  // ============================================================================================
  // (C) the pre-spawn check is a harmless no-op when the path isn't wedge-tracked — every ordinary
  //     spawn (the overwhelming common case) must be byte-identical to before this fix.
  // ============================================================================================
  const taskC = "ordinary-spawn-cccc-3333";
  const pathC = resolveWorktreePath(PROJ, taskC);
  const dbC = new Db();
  const sessionsC = new SessionService(dbC, {}, new OrchestrationControl(), {});
  check("(C setup) nothing is wedge-tracked for this path", dbC.getWedgedWorktree(pathC) === undefined);
  sessionsC.reclaimWedgedWorktreePathForSpawn(PROJ, taskC); // must not throw, must not create anything
  check("(C) the no-op check did not create anything at the target path", !fs.existsSync(pathC));
  const resultC = await createWorktree(repo, PROJ, taskC);
  check("(C) an ordinary fresh spawn still works unchanged", resultC.worktreePath === pathC && fs.existsSync(path.join(pathC, ".git")));
  execSync(`git worktree remove --force "${pathC}"`, { cwd: repo });
  dbC.close();

  // ============================================================================================
  // (D) ROUND 2 — createWorktree's own rename-aside FAILS: must THROW, never silently reuse/recut.
  //     `__setRenameDirAsideForTest` has shipped since round 2 — FAIL (not SKIP) when it's absent, so a
  //     seam removed/renamed by a later change is caught here instead of silently going unexercised.
  // ============================================================================================
  const hasRenameSeam = typeof __setRenameDirAsideForTest === "function";
  check("(D/E seam) __setRenameDirAsideForTest is present", hasRenameSeam);
  if (hasRenameSeam) {
    const taskD = "halfremoved-rename-fail-dddd-4444";
    const pathD = resolveWorktreePath(PROJ, taskD);
    fs.mkdirSync(pathD, { recursive: true });
    fs.writeFileSync(path.join(pathD, "orphan-leftover.txt"), "half-removed orphan content (D)\n");

    __setRenameDirAsideForTest(() => { throw new Error("simulated rename failure (D)"); });
    let threwD = null;
    try { await createWorktree(repo, PROJ, taskD); } catch (e) { threwD = e; }
    __setRenameDirAsideForTest(); // restore the real fs.renameSync before anything else runs

    check("(D) createWorktree THROWS when its own rename-aside fails", threwD !== null && /could not be renamed aside/.test(threwD.message));
    check("(D) the original half-removed dir is UNTOUCHED (never reused/recut)",
      fs.existsSync(pathD) && fs.readFileSync(path.join(pathD, "orphan-leftover.txt"), "utf8") === "half-removed orphan content (D)\n");
    check("(D) no fresh worktree was cut there (still no .git link)", !fs.existsSync(path.join(pathD, ".git")));
    check("(D) no stale-aside dir was created (the rename never succeeded)", findStaleAside(pathD) === null);
    fs.rmSync(pathD, { recursive: true, force: true });
  }

  // ============================================================================================
  // (E) ROUND 2 — reclaimWedgedWorktreePathForSpawn's own rename-aside FAILS: must REFUSE the spawn
  //     (throw) rather than letting createWorktree proceed against unknown content, and must KEEP the
  //     wedge entry. Same seam, same FAIL (not SKIP) posture when absent — see (D)'s own note.
  // ============================================================================================
  if (hasRenameSeam) {
    const taskE = "reclaim-rename-fail-eeee-5555";
    const pathE = resolveWorktreePath(PROJ, taskE);
    fs.mkdirSync(pathE, { recursive: true });
    fs.writeFileSync(path.join(pathE, "old-orphan.txt"), "stale wedged content (E)\n");

    const dbE = new Db();
    dbE.recordWorktreeWedgeAttempt(pathE, repo, "simulated wedge from an earlier boot pass (E)");
    const sessionsE = new SessionService(dbE, {}, new OrchestrationControl(), {});

    __setRenameDirAsideForTest(() => { throw new Error("simulated rename failure (E)"); });
    let threwE = null;
    try { sessionsE.reclaimWedgedWorktreePathForSpawn(PROJ, taskE); } catch (e) { threwE = e; }
    __setRenameDirAsideForTest();

    check("(E) reclaimWedgedWorktreePathForSpawn THROWS when its own rename-aside fails", threwE !== null && /could not be renamed aside/.test(threwE.message));
    check("(E) the wedge-tracking entry is KEPT (not cleared) — a later retry can still act on it", dbE.getWedgedWorktree(pathE) !== undefined);
    check("(E) the original dir is UNTOUCHED", fs.existsSync(pathE) && fs.readFileSync(path.join(pathE, "old-orphan.txt"), "utf8") === "stale wedged content (E)\n");
    check("(E) the in-flight claim was self-released on throw (not leaked)",
      !(sessionsE.claimedWorktreePaths && sessionsE.claimedWorktreePaths.has(normForCompare(pathE))));

    fs.rmSync(pathE, { recursive: true, force: true });
    dbE.close();
  }

  // ============================================================================================
  // (F) ROUND 2 — a "starting" claimant (mid-spawn, before the session flips to "live") protects a
  //     wedge-tracked path from the background sweep exactly like a "live" one does — processState
  //     "starting" is the OTHER half of findLiveSessionClaimingWorktreePath's check.
  // ============================================================================================
  const taskF = "starting-claimant-ffff-6666";
  const pathF = resolveWorktreePath(PROJ, taskF);
  fs.mkdirSync(pathF, { recursive: true });
  fs.writeFileSync(path.join(pathF, "starting-worker-content.txt"), "a mid-spawn worker's real content\n");

  const dbF = new Db();
  dbF.recordWorktreeWedgeAttempt(pathF, repo, "simulated earlier wedge, now superseded by a respawn mid-cut");
  const nowF = new Date().toISOString();
  dbF.insertProject({ id: "projCwrF", name: "CWR-F", repoPath: repo, vaultPath: repo, config: {}, createdAt: nowF, archivedAt: null });
  dbF.insertAgent({ id: "agentCwrF", projectId: "projCwrF", name: "t", startupPrompt: "", position: 0 });
  dbF.insertSession({
    id: "sessCwrF", projectId: "projCwrF", agentId: "agentCwrF", engineSessionId: null, title: null, cwd: pathF,
    processState: "starting", resumability: "unknown", busy: false, createdAt: nowF, lastActivity: nowF, lastError: null,
    role: "worker", worktreePath: pathF,
  });

  let removeDirCallsForF = 0;
  const sessionsF = new SessionService(dbF, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => { if (target === pathF) removeDirCallsForF++; return killableRemoveDir(target, ms); },
  });
  await sessionsF.sweepWedgedWorktreesOnce();
  check("(F) a 'starting' claimant protects the path — the sweep never attempted removal", removeDirCallsForF === 0);
  check("(F) the path's real content SURVIVED the sweep tick untouched", fs.existsSync(path.join(pathF, "starting-worker-content.txt")));
  check("(F) the stale wedge-tracking entry was DROPPED (not left to retry against a starting path forever)", dbF.getWedgedWorktree(pathF) === undefined);

  fs.rmSync(pathF, { recursive: true, force: true });
  dbF.close();

  // ============================================================================================
  // (G) ROUND 2 — reclaimWedgedWorktreePathForSpawn renames a wedge-tracked dir aside EVEN WHEN it
  //     still has a valid `.git` link — unlike createWorktree's own half-removed-dir check (which only
  //     reuses/recuts a dir WITHOUT a `.git` link), a wedge-tracked path's whole lifecycle already
  //     ended (a prior removal attempt against it failed), so this must never special-case leaving a
  //     still-linked dir in place just because it LOOKS like a real worktree.
  // ============================================================================================
  const taskG = "wedge-with-gitlink-gggg-7777";
  const pathG = resolveWorktreePath(PROJ, taskG);
  fs.mkdirSync(pathG, { recursive: true });
  fs.mkdirSync(path.join(pathG, ".git")); // fake .git link — worktreeHasGitLink only checks existence
  fs.writeFileSync(path.join(pathG, "still-linked-content.txt"), "a dir that still LOOKS like a real worktree\n");

  const dbG = new Db();
  dbG.recordWorktreeWedgeAttempt(pathG, repo, "simulated wedge on a dir that still has a .git link");
  check("(G setup) the dir has a .git link", fs.existsSync(path.join(pathG, ".git")));
  const sessionsG = new SessionService(dbG, {}, new OrchestrationControl(), {});

  sessionsG.reclaimWedgedWorktreePathForSpawn(PROJ, taskG);
  check("(G) the dir is GONE from the original path despite having a .git link", !fs.existsSync(pathG));
  check("(G) the wedge-tracking entry was DROPPED", dbG.getWedgedWorktree(pathG) === undefined);
  const asideG = findStaleAside(pathG);
  check("(G) the old (still-.git-linked) content survives, renamed aside",
    asideG !== null && fs.readFileSync(path.join(asideG, "still-linked-content.txt"), "utf8") === "a dir that still LOOKS like a real worktree\n");

  const resultG = await createWorktree(repo, PROJ, taskG);
  check("(G) createWorktree cuts a GENUINELY FRESH worktree at the original path", resultG.worktreePath === pathG && fs.existsSync(path.join(pathG, ".git")));
  check("(G) the fresh worktree's HEAD == current main", head(pathG) === mainHead);

  if (asideG) fs.rmSync(asideG, { recursive: true, force: true });
  execSync(`git worktree remove --force "${pathG}"`, { cwd: repo });
  dbG.close();

  // ============================================================================================
  // (H) ROUND 3 — MUTUAL EXCLUSION: a removal in progress against a wedge-tracked path (the real
  //     sweep, via gcWorktreeDir) marks that path REMOVING for the WHOLE removal, including the short
  //     clean-reject retry delay removeWorktree waits through between its own attempts. A respawn's
  //     reclaimWedgedWorktreePathForSpawn racing in during exactly that delay window must REFUSE
  //     outright (throw), never recreate a fresh worktree there while the old removal is still settling.
  // ============================================================================================
  const taskH = "mutex-retry-hhhh-8888";
  const pathH = resolveWorktreePath(PROJ, taskH);
  fs.mkdirSync(pathH, { recursive: true });
  fs.writeFileSync(path.join(pathH, "old-leftover.txt"), "a leftover a prior removal attempt failed on\n");

  const dbH = new Db();
  dbH.recordWorktreeWedgeAttempt(pathH, repo, "simulated wedge, about to be retried by the sweep");
  let removeDirCallsH = 0;
  let reclaimRaceResult = null; // filled by the racing reclaim attempt below
  const sessionsH = new SessionService(dbH, {}, new OrchestrationControl(), {
    removeDir: async (target, ms) => {
      if (target !== pathH) return { removed: true, killed: false };
      removeDirCallsH++;
      if (removeDirCallsH === 1) {
        // Race a respawn's reclaim in WHILE removeWorktree's own clean-reject retry delay is running —
        // scheduled well inside the real 500ms delay window, never awaited directly (fire-and-forget,
        // mirroring the real concurrency: the sweep and a respawn are two independent call stacks).
        setTimeout(() => {
          try {
            sessionsH.reclaimWedgedWorktreePathForSpawn(PROJ, taskH);
            reclaimRaceResult = { threw: false };
          } catch (e) {
            reclaimRaceResult = { threw: true, message: e.message };
          }
        }, 50);
        return { removed: false, killed: false }; // a clean reject — triggers the retry delay
      }
      return killableRemoveDir(target, ms); // second attempt: the removal actually succeeds
    },
  });

  await sessionsH.sweepWedgedWorktreesOnce();
  check("(H) the racing reclaim attempt actually ran (not a dead test)", reclaimRaceResult !== null);
  check("(H) the racing reclaim REFUSED (threw) while the removal was still in progress for this path",
    !!reclaimRaceResult && reclaimRaceResult.threw === true && /removal in progress/.test(reclaimRaceResult.message ?? ""));
  check("(H) the OLD removal proceeded unobstructed and actually succeeded on its second attempt",
    removeDirCallsH === 2 && !fs.existsSync(pathH));
  check("(H) the wedge-tracking entry was cleared (a real removal, not a left-on-disk retry)", dbH.getWedgedWorktree(pathH) === undefined);
  check("(H) the REMOVING mark was released afterward (not leaked)",
    !(sessionsH.removingWorktreePaths && sessionsH.removingWorktreePaths.has(normForCompare(pathH))));

  dbH.close();

  // ============================================================================================
  // (J) card 623a7a62 round 3 (Code Review 44cac5fd finding 2) — the SAME mutual exclusion as (H), but
  //     for a path that OVERLAPS (not exact-equals) one currently marked REMOVING: a respawn whose own
  //     target CONTAINS or is CONTAINED BY a path with a removal in flight must refuse too, via
  //     pathsOverlap, not just an exact-string collision. Pure logic against the in-memory
  //     removingWorktreePaths set (white-box, same pattern claimedWorktreePaths tests already use) —
  //     no real removal is driven, so no filesystem setup is needed.
  // ============================================================================================
  const taskJ = "mutex-overlap-jjjj-5555";
  const pathJ = resolveWorktreePath(PROJ, taskJ);

  const dbJ = new Db();
  const sessionsJ = new SessionService(dbJ, {}, new OrchestrationControl());

  // The REMOVING mark is a DESCENDANT of this spawn's own target (the shape a nested leftover one level
  // below pathJ would carry).
  const removingDescendantJ = path.join(pathJ, "nested-leaf.stale-1700000000100");
  sessionsJ.removingWorktreePaths.add(normForCompare(removingDescendantJ));
  let threwJ1 = null;
  try { sessionsJ.reclaimWedgedWorktreePathForSpawn(PROJ, taskJ); } catch (e) { threwJ1 = e; }
  check("(J) a respawn whose target CONTAINS a path marked REMOVING refuses (throws)",
    threwJ1 !== null && /removal in progress for an overlapping path/.test(threwJ1.message));
  sessionsJ.removingWorktreePaths.clear();

  // Reverse direction: the REMOVING mark is an ANCESTOR of this spawn's own target.
  const removingAncestorJ = path.dirname(pathJ);
  sessionsJ.removingWorktreePaths.add(normForCompare(removingAncestorJ));
  let threwJ2 = null;
  try { sessionsJ.reclaimWedgedWorktreePathForSpawn(PROJ, taskJ); } catch (e) { threwJ2 = e; }
  check("(J) a respawn whose target is CONTAINED BY a path marked REMOVING refuses too (symmetric)",
    threwJ2 !== null && /removal in progress for an overlapping path/.test(threwJ2.message));
  sessionsJ.removingWorktreePaths.clear();

  // Negative control: an unrelated sibling marked REMOVING must NOT block this spawn — the widened check
  // isn't "refuse everything near a removal".
  const removingSiblingJ = resolveWorktreePath(PROJ, "mutex-overlap-unrelated-jjjj-6666");
  sessionsJ.removingWorktreePaths.add(normForCompare(removingSiblingJ));
  let threwJ3 = null, claimJ3 = null;
  try { claimJ3 = sessionsJ.reclaimWedgedWorktreePathForSpawn(PROJ, taskJ); } catch (e) { threwJ3 = e; }
  check("(J) negative control: an unrelated sibling marked REMOVING does NOT block this spawn", threwJ3 === null);
  claimJ3?.release();
  sessionsJ.removingWorktreePaths.clear();

  dbJ.close();

  // ============================================================================================
  // (I) card ceeb188b — a wedge-tracked path can ALSO be a repo-axis dir holding a REAL, live nested
  //     secondary-repo worktree (a grandfathered repoKey aliasing this task's own taskKey, per c994ffeb).
  //     reclaimWedgedWorktreePathForSpawn must refuse (throw) rather than renaming the whole axis dir
  //     aside, leaving the nested worktree's data + git registration + the wedge entry all intact.
  // ============================================================================================
  const taskI = "nested-live-wedge-iiii-9999";
  const keyI = taskKey(taskI);
  const pathI = resolveWorktreePath(PROJ, taskI);
  fs.mkdirSync(pathI, { recursive: true }); // bare axis dir — no .git link of its own

  const repoI2 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cwr-nested-"));
  fs.writeFileSync(path.join(repoI2, "README.md"), "# nested\n");
  execSync(`git init -q`, { cwd: repoI2 });
  commitAll(repoI2, "init", GIT_ID);

  const taskI2 = "nested-live-secondary-jjjj-0000";
  const wtI2 = await createWorktree(repoI2, PROJ, taskI2, {}, keyI);
  fs.writeFileSync(path.join(wtI2.worktreePath, "i2-uncommitted.txt"), "I2's real uncommitted work\n");
  check("(I setup) I2's worktree is nested directly under pathI", wtI2.worktreePath.startsWith(pathI + path.sep));
  check("(I setup) I2's .git entry is a FILE (a real worktree link, not a clone)", fs.statSync(path.join(wtI2.worktreePath, ".git")).isFile());

  const dbI = new Db();
  dbI.recordWorktreeWedgeAttempt(pathI, repo, "simulated: an earlier removal of I's primary worktree failed");
  check("(I setup) pathI is tracked as wedged", dbI.getWedgedWorktree(pathI) !== undefined);
  const sessionsI = new SessionService(dbI, {}, new OrchestrationControl(), {});

  let threwI = null;
  try { sessionsI.reclaimWedgedWorktreePathForSpawn(PROJ, taskI); } catch (e) { threwI = e; }

  check("(I) reclaim REFUSES (throws) instead of renaming the axis dir aside", threwI !== null);
  check("(I) refusal names the nested child it actually found", threwI !== null && threwI.message.includes(path.basename(wtI2.worktreePath)));
  check("(I) refusal states what unblocks it (the nested worktree being merged/stopped and removed)", threwI !== null && /merged\/stopped and removed/.test(threwI.message));
  check("(I) pathI itself is UNTOUCHED — no rename-aside happened", fs.existsSync(pathI) && !findStaleAside(pathI));
  check("(I) I2's worktree is STILL at its original, nested path", fs.existsSync(wtI2.worktreePath));
  check("(I) I2's uncommitted work SURVIVED untouched", fs.readFileSync(path.join(wtI2.worktreePath, "i2-uncommitted.txt"), "utf8") === "I2's real uncommitted work\n");
  const worktreeListI = execSync("git worktree list", { cwd: repoI2 }).toString();
  check("(I) I2's git worktree registration still resolves (not prunable)", worktreeListI.includes(wtI2.worktreePath.replace(/\\/g, "/")) && !/prunable/.test(worktreeListI));
  check("(I) the wedge-tracking entry for pathI is KEPT (not cleared) — a later retry can act on it once I2 clears", dbI.getWedgedWorktree(pathI) !== undefined);
  check("(I) the in-flight claim was self-released on throw (not leaked)",
    !(sessionsI.claimedWorktreePaths && sessionsI.claimedWorktreePaths.has(normForCompare(pathI))));

  // --- (I-control) BEHAVIOURAL NEGATIVE CONTROL: disable the SAME shared backstop flag createWorktree's
  //     own reverse check uses -> the pre-fix bug returns. Reuses pathI/wtI2/dbI unmutated by (I) above. ---
  __setWorktreeCollisionBackstopForTest(false);
  let threwIControl = null;
  try { sessionsI.reclaimWedgedWorktreePathForSpawn(PROJ, taskI); } catch (e) { threwIControl = e; }
  __setWorktreeCollisionBackstopForTest(true); // restore immediately, before any further assertions/tests

  check("(I-control) with the shared backstop disabled, the OLD bug reproduces: reclaim does NOT throw", threwIControl === null);
  check("(I-control) pathI was renamed aside despite holding I2's live nested worktree", !fs.existsSync(pathI));
  const asideI = findStaleAside(pathI);
  check("(I-control) I2's worktree now sits only under the renamed-aside dir — orphaned from its own git registration", asideI !== null && fs.existsSync(path.join(asideI, path.basename(wtI2.worktreePath), "i2-uncommitted.txt")));
  check("(I-control) the wedge-tracking entry for pathI was cleared, as if the rename were safe", dbI.getWedgedWorktree(pathI) === undefined);

  if (asideI) fs.rmSync(asideI, { recursive: true, force: true });
  try { execSync("git worktree prune", { cwd: repoI2 }); } catch { /* ignore — admin record now dangles after the control's raw fs rename */ }
  fs.rmSync(repoI2, { recursive: true, force: true });
  dbI.close();

  // ============================================================================================
  // (I-resolve) the refusal in (I) is NOT permanent — once the nested worktree is removed (simulating
  //     it being merged/stopped), the SAME wedge-tracked path reclaims and respawns normally. Fresh
  //     task/repo identifiers — (I)'s own entities are left exactly as the control above mutated them.
  // ============================================================================================
  const taskK = "nested-live-resolve-kkkk-1111";
  const keyK = taskKey(taskK);
  const pathK = resolveWorktreePath(PROJ, taskK);
  fs.mkdirSync(pathK, { recursive: true });

  const repoK2 = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cwr-resolve-"));
  fs.writeFileSync(path.join(repoK2, "README.md"), "# resolve\n");
  execSync(`git init -q`, { cwd: repoK2 });
  commitAll(repoK2, "init", GIT_ID);

  const taskK2 = "nested-live-resolve-sec-llll-2222";
  const wtK2 = await createWorktree(repoK2, PROJ, taskK2, {}, keyK);
  check("(I-resolve setup) K2's worktree is nested under pathK", wtK2.worktreePath.startsWith(pathK + path.sep));

  const dbK = new Db();
  dbK.recordWorktreeWedgeAttempt(pathK, repo, "simulated wedge, to be resolved once K2 clears");
  const sessionsK = new SessionService(dbK, {}, new OrchestrationControl(), {});

  let threwKBefore = null;
  try { sessionsK.reclaimWedgedWorktreePathForSpawn(PROJ, taskK); } catch (e) { threwKBefore = e; }
  check("(I-resolve) while K2 is still live, reclaim refuses exactly like (I)", threwKBefore !== null);

  // K2 "completes" — its own worktree is removed (the normal lifecycle, not this fix's own code path).
  execSync(`git worktree remove --force "${wtK2.worktreePath}"`, { cwd: repoK2 });
  check("(I-resolve) K2's nested worktree is now gone", !fs.existsSync(wtK2.worktreePath));
  check("(I-resolve) pathK is still wedge-tracked and still on disk", dbK.getWedgedWorktree(pathK) !== undefined && fs.existsSync(pathK));

  let threwKAfter = null;
  try { sessionsK.reclaimWedgedWorktreePathForSpawn(PROJ, taskK); } catch (e) { threwKAfter = e; }
  check("(I-resolve) reclaim no longer refuses now that the nested worktree is gone — SELF-RESOLVED", threwKAfter === null);
  check("(I-resolve) pathK was renamed aside via the ordinary wedge-reclaim path", !fs.existsSync(pathK));
  check("(I-resolve) the wedge-tracking entry was cleared normally", dbK.getWedgedWorktree(pathK) === undefined);

  const resultKResolve = await createWorktree(repo, PROJ, taskK);
  check("(I-resolve) a genuinely fresh worktree now cuts at pathK, completing the respawn", resultKResolve.worktreePath === pathK && fs.existsSync(path.join(pathK, ".git")));

  const asideK = findStaleAside(pathK);
  if (asideK) fs.rmSync(asideK, { recursive: true, force: true });
  execSync(`git worktree remove --force "${pathK}"`, { cwd: repo });
  try { execSync("git worktree prune", { cwd: repoK2 }); } catch { /* ignore */ }
  fs.rmSync(repoK2, { recursive: true, force: true });
  dbK.close();
} finally {
  try { execSync("git worktree prune", { cwd: repo }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree never reuses/recuts a dir with no .git link (set aside, never deleted, then fresh-cut); SessionService.reclaimWedgedWorktreePathForSpawn clears a stale wedge-tracking entry (and sets aside whatever still sits there, even a dir that still has a .git link) BEFORE createWorktree can claim the same deterministic path; an ordinary, never-wedged spawn is unaffected; a 'starting' claimant protects a path exactly like a 'live' one; a rename-aside failure on EITHER side REFUSES outright (throws) instead of silently proceeding against unknown content, keeping the wedge entry intact on reclaim's own failure; a respawn's reclaim racing in WHILE a removal is still settling against the exact same path (including removeWorktree's own clean-reject retry delay) is REFUSED outright, never left to recreate a fresh worktree out from under an in-flight removal; and (card ceeb188b) reclaimWedgedWorktreePathForSpawn refuses to rename aside a wedge-tracked path that holds a REAL, live nested secondary-repo worktree (leaving its data + git registration + the wedge entry intact), the pre-fix bug returns when the shared backstop flag is disabled, and the refusal self-resolves once the nested worktree is removed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
