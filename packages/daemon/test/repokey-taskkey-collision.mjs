import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c994ffeb (Code Review b0369501 of card 98039b36, finding out-of-scope of that fix): the
// secondary repoKey axis dir (`WORKTREES_DIR/<project>/<repoKey>`) shares ONE namespace with a PRIMARY
// task's own worktree dir (`WORKTREES_DIR/<project>/<taskKey>`) — `taskKey` (git/worktrees.ts) always
// outputs exactly 12 lowercase hex chars, so a repoKey spelled the same way (or case-colliding with one
// on a case-insensitive filesystem) can alias a real task's worktree dir. HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, REAL git on temp repos.
//
// Proves the DoD (two independent layers, approved by the manager after a VERIFY-FIRST hermetic repro
// of both collision directions against pre-fix dist):
//
//   PART A — registry-level rejection (validateRepoRegistry, projects/repos.ts), via REST:
//     (A1) a NEW repos key matching the 12-hex taskKey shape -> 400.
//     (A2/A3/A4) NEGATIVE CONTROLS: an 11-hex, a 13-hex, and a 12-char-but-not-all-hex key are all
//       accepted normally — the rejection is the EXACT 12-hex shape, never a blanket ban on short/hex-ish
//       keys.
//     (A5/A6) the existingKeys GRANDFATHER exemption: a project whose stored repos ALREADY carries a
//       12-hex key (seeded directly via db.updateProject, bypassing the validator — simulating data that
//       predates this fix, mirroring 98039b36's own test precedent) can still PATCH that SAME key back
//       (200) — but a DIFFERENT, new 12-hex key in the same PATCH is still rejected (400).
//
//   PART B — the cut-time backstop in `createWorktree` (git/worktrees.ts), real git, both collision
//     directions, each with a BEHAVIORAL negative control (card c994ffeb review requirement): disable the
//     backstop via `__setWorktreeCollisionBackstopForTest(false)` and show the pre-fix bad behavior comes
//     back (nesting / wrongful rename-aside) — proving the backstop is actually load-bearing, not merely
//     that it fires.
//     (B1) FORWARD: primary task A is cut first; a secondary task B whose repoKey === taskKey(A) is
//       refused, never nested inside A's own worktree.
//     (B2) REVERSE: a secondary task B is cut first under repoKey K; a primary task A whose taskKey===K
//       is refused, never silently renaming B's entire (real, live, uncommitted-work-holding) axis dir
//       aside as a "half-removed orphan".
//     (B3) control: a normal secondary-repo cut with a non-colliding repoKey, and a normal primary cut,
//       both proceed exactly as before — the backstop never fires on an ordinary, non-colliding cut.
//     (B4) Code Review of commit 367d53f6, finding 1 (card c994ffeb, docs/decisions/c994ffeb-nested-
//       worktree-signature-is-shape-and-git-link-file.md): the REVERSE check's nested-child signature
//       must be narrow on BOTH axes (taskKey-SHAPE name AND a `.git` FILE), or a genuine half-removed
//       orphan that happens to hold an ordinary nested clone/submodule is wrongly refused FOREVER instead
//       of renamed aside as before. (B4a) an orphan holding a real nested `git clone` (DIRECTORY `.git`,
//       any name) is still renamed aside. (B4b) an orphan holding a submodule-style `.git` FILE child
//       whose NAME is NOT taskKey-shaped is still renamed aside too.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/repokey-taskkey-collision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const tmpHome = useOwnLoomHome("loom-rtc-home-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const {
  createWorktree, taskKey, resolveWorktreePath, worktreeHasGitLink, TASK_KEY_SHAPE_RE,
  __setWorktreeCollisionBackstopForTest,
} = await import("../dist/git/worktrees.js");
const { WORKTREES_DIR } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A sibling path matching `${target}.stale-<ts>` under the SAME parent dir — the "renamed aside, never
// deleted" destination createWorktree's own half-removed-orphan path uses.
const findStaleAside = (target) => {
  const parent = path.dirname(target);
  const base = path.basename(target);
  if (!fs.existsSync(parent)) return null;
  const hit = fs.readdirSync(parent).find((e) => e.startsWith(`${base}.stale-`));
  return hit ? path.join(parent, hit) : null;
};

const mkRepo = (tag) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rtc-${tag}-`));
  fs.writeFileSync(path.join(r, "README.md"), `# ${tag}\n`);
  execSync(`git init -q`, { cwd: r });
  commitAll(r, "init", "-c user.email=rtc@loom -c user.name=rtc");
  return r;
};

try {
  // =====================================================================================================
  // PART A — validateRepoRegistry, via REST (POST /api/projects + PATCH /api/projects/:id)
  // =====================================================================================================
  {
    const db = new Db(path.join(tmpHome, "rest.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
    const primary = mkRepo("primary");
    const svcA = mkRepo("svcA");
    const vaultDir = mkRepo("vault");
    try {
      // --- Control: the shape regex itself, sanity-checked against real taskKey output. ---
      const realTaskKey = taskKey("some-real-task-id-0001");
      check("(control) a real taskKey matches TASK_KEY_SHAPE_RE", TASK_KEY_SHAPE_RE.test(realTaskKey));

      // (A1) a NEW repos key matching the 12-hex taskKey shape -> 400.
      const twelveHex = "fa6c83240b61";
      const badShape = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "BadShape", repoPath: primary, vaultPath: vaultDir, repos: [{ key: twelveHex, path: svcA }] },
      });
      check("(A1) POST with a 12-hex-char repos key -> 400", badShape.statusCode === 400);
      check("(A1) error names the taskKey-shape rule", /12 hex|task worktree key/.test(badShape.json().error ?? ""));
      check("(A1) no project row was created", !db.listAllProjects().some((p) => p.name === "BadShape"));

      // (A2) NEGATIVE CONTROL: an 11-hex-char key is accepted — one char short of the rejected shape.
      const elevenHex = "fa6c83240b6"; // 11 chars
      check("(A2 setup) control key is exactly 11 chars and all-hex", elevenHex.length === 11 && /^[0-9a-f]+$/i.test(elevenHex));
      const good11 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "Good11Hex", repoPath: primary, vaultPath: vaultDir, repos: [{ key: elevenHex, path: svcA }] },
      });
      check("(A2, control) POST with an 11-hex-char repos key -> 201", good11.statusCode === 201);
      check("(A2, control) key round-trips verbatim", good11.json().repos?.[0]?.key === elevenHex);

      // (A3) NEGATIVE CONTROL: a 13-hex-char key is accepted — one char long of the rejected shape.
      const thirteenHex = "fa6c83240b611"; // 13 chars
      check("(A3 setup) control key is exactly 13 chars and all-hex", thirteenHex.length === 13 && /^[0-9a-f]+$/i.test(thirteenHex));
      const good13 = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "Good13Hex", repoPath: primary, vaultPath: vaultDir, repos: [{ key: thirteenHex, path: svcA }] },
      });
      check("(A3, control) POST with a 13-hex-char repos key -> 201", good13.statusCode === 201);

      // (A4) NEGATIVE CONTROL: a 12-char key that is NOT all hex (contains "g" and "-") is accepted —
      // proves the rejection is the exact shape, never a blanket ban on any 12-char key.
      const twelveNotHex = "fa6c8324-b6g"; // 12 chars, not all [0-9a-f]
      check("(A4 setup) control key is exactly 12 chars but NOT all-hex", twelveNotHex.length === 12 && !/^[0-9a-f]+$/i.test(twelveNotHex));
      const good12NotHex = await app.inject({
        method: "POST", url: "/api/projects",
        payload: { name: "Good12NotHex", repoPath: primary, vaultPath: vaultDir, repos: [{ key: twelveNotHex, path: svcA }] },
      });
      check("(A4, control) POST with a 12-char non-hex repos key -> 201", good12NotHex.statusCode === 201);

      // (A5/A6) existingKeys GRANDFATHER exemption. Seed a project whose STORED repos already carries a
      // 12-hex key by writing it directly via db.updateProject (bypassing validateRepoRegistry entirely —
      // simulating data that predates this fix; mirrors 98039b36's own test precedent for grandfathered
      // shapes in stale-worktree-leftovers.mjs).
      const grandfatheredKey = "deadbeef1234";
      const svcB = mkRepo("svcB");
      const created = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Grandfathered", repoPath: primary, vaultPath: vaultDir } });
      check("(A5 setup) base project created -> 201", created.statusCode === 201);
      const projId = created.json().id;
      db.updateProject(projId, { repos: [{ key: grandfatheredKey, path: svcB }] });
      check("(A5 setup) grandfathered key is seeded directly in storage (bypassing the validator)", db.getProject(projId)?.repos?.[0]?.key === grandfatheredKey);

      // (A5) PATCHing the registry back with the SAME grandfathered key (plus an unrelated change) is
      // ACCEPTED — existingKeys (derived from the project's OWN pre-patch stored repos) exempts it.
      const patchSame = await app.inject({
        method: "PATCH", url: `/api/projects/${projId}`,
        payload: { repos: [{ key: grandfatheredKey, path: svcB, gateCommand: "npm test" }] },
      });
      check("(A5) PATCH re-submitting the SAME grandfathered 12-hex key -> 200", patchSame.statusCode === 200);
      check("(A5) the grandfathered key is still stored, now with its gateCommand", db.getProject(projId)?.repos?.[0]?.key === grandfatheredKey && db.getProject(projId)?.repos?.[0]?.gateCommand === "npm test");

      // (A6) a DIFFERENT, NEW 12-hex key in the SAME PATCH call is still REJECTED — the grandfather
      // exemption is scoped to the SPECIFIC pre-existing key, never a blanket bypass once any 12-hex key
      // exists on the project.
      const differentTwelveHex = "0123456789ab";
      const patchDifferent = await app.inject({
        method: "PATCH", url: `/api/projects/${projId}`,
        payload: { repos: [{ key: differentTwelveHex, path: svcB }] },
      });
      check("(A6) PATCH with a DIFFERENT new 12-hex key -> 400 (not grandfathered)", patchDifferent.statusCode === 400);
      check("(A6) the stored registry is UNCHANGED by the rejected PATCH", db.getProject(projId)?.repos?.[0]?.key === grandfatheredKey);
    } finally {
      await app.close();
      db.close();
      for (const d of [primary, svcA, vaultDir]) registerForCleanup(d);
    }
  }

  // =====================================================================================================
  // PART B — createWorktree's cut-time collision backstop, real git, both directions + behavioral controls
  // =====================================================================================================
  {
    const projectId = "projRtc";
    const repoPrimary1 = mkRepo("b1-primary");
    const repoSecondary1 = mkRepo("b1-secondary");

    // --- (B1) FORWARD: primary task A cut first, then a secondary task B whose repoKey === taskKey(A). ---
    const taskIdA1 = "rtc-fwd-primary-task-aaaa";
    const keyA1 = taskKey(taskIdA1);
    check("(B1 setup) keyA1 matches the 12-hex taskKey shape", TASK_KEY_SHAPE_RE.test(keyA1));
    const wtA1 = await createWorktree(repoPrimary1, projectId, taskIdA1, {}, null);
    check("(B1 setup) A's primary worktree exists", fs.existsSync(wtA1.worktreePath) && worktreeHasGitLink(wtA1.worktreePath));

    const taskIdB1 = "rtc-fwd-secondary-task-bbbb";
    let b1Err = null;
    try {
      await createWorktree(repoSecondary1, projectId, taskIdB1, {}, keyA1);
    } catch (e) { b1Err = e; }
    check("(B1) createWorktree REFUSES the colliding secondary cut", b1Err !== null);
    check("(B1) refusal names the collision", /collides with an existing task worktree/.test(b1Err?.message ?? ""));
    check("(B1) A's own worktree is UNTOUCHED (still a clean, valid worktree)", fs.existsSync(wtA1.worktreePath) && execSync("git status --porcelain", { cwd: wtA1.worktreePath }).toString().trim() === "");
    check("(B1) nothing was nested under A's worktree dir", fs.readdirSync(wtA1.worktreePath).every((n) => n !== path.basename(resolveWorktreePath(projectId, taskIdB1, keyA1))));

    // --- (B1-control) BEHAVIORAL NEGATIVE CONTROL: disable the backstop -> the pre-fix nesting bug returns. ---
    __setWorktreeCollisionBackstopForTest(false);
    let wtB1Nested = null;
    let b1ControlErr = null;
    try {
      wtB1Nested = await createWorktree(repoSecondary1, projectId, taskIdB1, {}, keyA1);
    } catch (e) { b1ControlErr = e; }
    __setWorktreeCollisionBackstopForTest(true); // restore immediately, before any further assertions/tests
    check("(B1-control) with the backstop disabled, the OLD bug reproduces: createWorktree does NOT throw", b1ControlErr === null);
    check("(B1-control) B's worktree was planted NESTED inside A's own worktree dir", !!wtB1Nested && wtB1Nested.worktreePath.startsWith(wtA1.worktreePath + path.sep));
    // Clean up the nested worktree's git registration before the directory-level cleanup below, so a
    // stray `.git/worktrees/` admin record in repoSecondary1 doesn't survive this test file.
    if (wtB1Nested) { try { execSync(`git worktree remove --force "${wtB1Nested.worktreePath}"`, { cwd: repoSecondary1 }); } catch { /* best-effort */ } }

    // --- (B2) REVERSE: secondary task B cut first (repoKey K), then primary task A whose taskKey === K. ---
    const repoPrimary2 = mkRepo("b2-primary");
    const repoSecondary2 = mkRepo("b2-secondary");
    const taskIdA2 = "rtc-rev-primary-task-cccc"; // will be cut PRIMARY second; its taskKey IS the repoKey
    const keyA2 = taskKey(taskIdA2);
    const taskIdB2 = "rtc-rev-secondary-task-dddd";
    const wtB2 = await createWorktree(repoSecondary2, projectId, taskIdB2, {}, keyA2);
    fs.writeFileSync(path.join(wtB2.worktreePath, "b2-uncommitted.txt"), "B2's real uncommitted work\n");
    check("(B2 setup) B2's uncommitted file is present", fs.existsSync(path.join(wtB2.worktreePath, "b2-uncommitted.txt")));

    let a2Err = null;
    try {
      await createWorktree(repoPrimary2, projectId, taskIdA2, {}, null);
    } catch (e) { a2Err = e; }
    check("(B2) createWorktree REFUSES the colliding primary cut", a2Err !== null);
    check("(B2) refusal names the nested worktree-shaped child it actually found", (a2Err?.message ?? "").includes(path.basename(wtB2.worktreePath)));
    check("(B2) refusal does NOT assert a specific repoKey must be renamed (describes findings, not a claim)", !/must be renamed/.test(a2Err?.message ?? ""));
    check("(B2) B2's worktree is STILL at its original path, untouched", fs.existsSync(wtB2.worktreePath));
    check("(B2) B2's uncommitted work SURVIVED (never renamed aside)", fs.existsSync(path.join(wtB2.worktreePath, "b2-uncommitted.txt")));
    const staleSiblings2 = fs.readdirSync(path.join(WORKTREES_DIR, projectId)).filter((n) => n.includes(".stale-") && n.startsWith(keyA2));
    check("(B2) nothing was renamed aside under the axis dir's own name", staleSiblings2.length === 0);

    // --- (B2-control) BEHAVIORAL NEGATIVE CONTROL: disable the backstop -> the pre-fix rename-aside bug returns. ---
    __setWorktreeCollisionBackstopForTest(false);
    let a2ControlErr = null;
    let wtA2Control = null;
    try {
      wtA2Control = await createWorktree(repoPrimary2, projectId, taskIdA2, {}, null);
    } catch (e) { a2ControlErr = e; }
    __setWorktreeCollisionBackstopForTest(true); // restore immediately
    check("(B2-control) with the backstop disabled, the OLD bug reproduces: createWorktree does NOT throw", a2ControlErr === null);
    const staleSiblingsControl = fs.existsSync(path.join(WORKTREES_DIR, projectId))
      ? fs.readdirSync(path.join(WORKTREES_DIR, projectId)).filter((n) => n.includes(".stale-") && n.startsWith(keyA2))
      : [];
    check("(B2-control) B2's ENTIRE axis dir was silently renamed aside as a 'half-removed orphan'", staleSiblingsControl.length === 1);
    let b2DataSurvivedAside = false;
    if (staleSiblingsControl.length === 1) {
      const asideDir = path.join(WORKTREES_DIR, projectId, staleSiblingsControl[0]);
      b2DataSurvivedAside = fs.existsSync(path.join(asideDir, path.basename(wtB2.worktreePath), "b2-uncommitted.txt"));
    }
    check("(B2-control) B2's uncommitted file is only reachable via the renamed-aside dir now (never deleted, but orphaned from its session's known path)", b2DataSurvivedAside);
    check("(B2-control) A2's fresh worktree now occupies the ORIGINAL axis-dir path", !!wtA2Control && wtA2Control.worktreePath === path.join(WORKTREES_DIR, projectId, keyA2));

    // --- (B3) CONTROL: an ordinary, non-colliding cut on each axis proceeds exactly as before. ---
    const repoPrimary3 = mkRepo("b3-primary");
    const repoSecondary3 = mkRepo("b3-secondary");
    const wtA3 = await createWorktree(repoPrimary3, projectId, "rtc-ordinary-primary-eeee", {}, null);
    check("(B3, control) an ordinary PRIMARY cut (no collision) succeeds", fs.existsSync(wtA3.worktreePath) && worktreeHasGitLink(wtA3.worktreePath));
    const wtB3 = await createWorktree(repoSecondary3, projectId, "rtc-ordinary-secondary-ffff", {}, "ordinary-service");
    check("(B3, control) an ordinary SECONDARY cut (non-colliding repoKey) succeeds", fs.existsSync(wtB3.worktreePath) && worktreeHasGitLink(wtB3.worktreePath));
    check("(B3, control) the ordinary secondary cut sits under its OWN repoKey axis dir", wtB3.worktreePath === path.join(WORKTREES_DIR, projectId, "ordinary-service", path.basename(wtB3.worktreePath)));

    // --- (B4a) Code Review of 367d53f6, finding 1: a genuine half-removed orphan holding a real nested
    // `git clone` (DIRECTORY `.git`, any name) must still be renamed aside, never refused forever. ---
    const repoPrimary4a = mkRepo("b4a-primary");
    const taskId4a = "rtc-orphan-with-clone-gggg";
    const path4a = resolveWorktreePath(projectId, taskId4a, null);
    fs.mkdirSync(path4a, { recursive: true });
    const nestedClonePath = path.join(path4a, "ref-clone"); // deliberately NOT taskKey-shaped
    fs.mkdirSync(nestedClonePath, { recursive: true });
    fs.writeFileSync(path.join(nestedClonePath, "clone-marker.txt"), "nested clone content\n");
    execSync(`git init -q`, { cwd: nestedClonePath });
    commitAll(nestedClonePath, "init", "-c user.email=rtc@loom -c user.name=rtc");
    check("(B4a setup) the orphan dir itself has no .git link", !worktreeHasGitLink(path4a));
    check("(B4a setup) the nested clone's .git is a DIRECTORY (a real clone, not a worktree link)", fs.statSync(path.join(nestedClonePath, ".git")).isDirectory());

    let wt4a = null, err4a = null;
    try {
      wt4a = await createWorktree(repoPrimary4a, projectId, taskId4a, {}, null);
    } catch (e) { err4a = e; }
    check("(B4a) createWorktree does NOT refuse — a nested real clone is not the repo-axis signature", err4a === null);
    const aside4a = findStaleAside(path4a);
    check("(B4a) the orphan (with its nested clone) was renamed ASIDE, never deleted", aside4a !== null);
    check("(B4a) the renamed-aside dir still carries the nested clone's own content", !!aside4a && fs.existsSync(path.join(aside4a, "ref-clone", "clone-marker.txt")));
    check("(B4a) a FRESH worktree now sits at the original path", !!wt4a && worktreeHasGitLink(wt4a.worktreePath));

    // --- (B4b) a genuine half-removed orphan holding a submodule-style `.git` FILE child whose NAME is
    // NOT taskKey-shaped must ALSO still be renamed aside — the shape half of the signature is load-
    // bearing on its own, independent of the FILE-vs-directory half proven by (B4a). ---
    const repoPrimary4b = mkRepo("b4b-primary");
    const taskId4b = "rtc-orphan-with-submodule-hhhh";
    const path4b = resolveWorktreePath(projectId, taskId4b, null);
    fs.mkdirSync(path4b, { recursive: true });
    const nestedSubmodulePath = path.join(path4b, "my-submodule"); // NOT taskKey-shaped
    fs.mkdirSync(nestedSubmodulePath, { recursive: true });
    fs.writeFileSync(path.join(nestedSubmodulePath, ".git"), "gitdir: ../.git/modules/my-submodule\n"); // a FILE, like a real submodule/worktree link
    check("(B4b setup) the orphan dir itself has no .git link", !worktreeHasGitLink(path4b));
    check("(B4b setup) the submodule-style child's .git is a FILE", fs.statSync(path.join(nestedSubmodulePath, ".git")).isFile());
    check("(B4b setup) the submodule-style child's NAME does NOT match the taskKey shape", !TASK_KEY_SHAPE_RE.test("my-submodule"));

    let wt4b = null, err4b = null;
    try {
      wt4b = await createWorktree(repoPrimary4b, projectId, taskId4b, {}, null);
    } catch (e) { err4b = e; }
    check("(B4b) createWorktree does NOT refuse — a non-taskKey-shaped name is not the repo-axis signature", err4b === null);
    const aside4b = findStaleAside(path4b);
    check("(B4b) the orphan (with its submodule-style child) was renamed ASIDE, never deleted", aside4b !== null);
    check("(B4b) a FRESH worktree now sits at the original path", !!wt4b && worktreeHasGitLink(wt4b.worktreePath));

    // Cleanup: remove worktree admin records so repo dirs can be deleted cleanly.
    for (const [repo, wt] of [[repoPrimary1, wtA1], [repoPrimary2, wtA2Control], [repoPrimary3, wtA3], [repoSecondary2, wtB2], [repoSecondary3, wtB3], [repoPrimary4a, wt4a], [repoPrimary4b, wt4b]]) {
      if (!wt) continue;
      try { execSync(`git worktree remove --force "${wt.worktreePath}"`, { cwd: repo }); } catch { /* best-effort */ }
    }
    for (const d of [repoPrimary1, repoSecondary1, repoPrimary2, repoSecondary2, repoPrimary3, repoSecondary3, repoPrimary4a, repoPrimary4b]) registerForCleanup(d);
  }
} finally {
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}
