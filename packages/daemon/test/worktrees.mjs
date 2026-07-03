// Git worktree manager test (PR #12 + H1 hardening). REAL git on a temp repo (like busy-flag's
// repo setup). LOOM_HOME is set to a temp dir BEFORE importing dist/* so WORKTREES_DIR is isolated
// (paths.ts reads LOOM_HOME at module load). Run: 1) build daemon, 2) node test/worktrees.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wt-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, mergeBranch, isBranchMerged, findLandedSquashCommit, toConventionalSubject } = await import("../dist/git/worktrees.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Slack for the bounded-op LOWER-bound timing assertions (j/k1/k2/l). Durations are measured with the
// MONOTONIC performance.now() (not Date.now()), so a wall-clock NTP/virtualization backward step can't
// make elapsed read under the timeout; this slack additionally absorbs libuv's sub-ms early timer fire
// (a setTimeout(N) can fire a hair before a fresh clock sample). It does NOT weaken the proof — the floor
// still decisively distinguishes "waited ~the timeout" from an instant (~0ms) early return. (A
// Date.now()-measured floor flaked the v0.3.0 release CI: it read 249ms on the loaded runner.)
const TIMER_SLACK_MS = 50;
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git -c user.email=wt@loom -c user.name=wt commit -qm "${msg}"`, { cwd: dir });
};

const repo = path.join(os.tmpdir(), `loom-wt-repo-${Date.now()}`);
const taskId = "abcd1234-ef56-7890";

try {
  // (a) a real repo with a commit on the default branch. Configure a git identity so mergeBranch's PLAIN
  //     `git commit` (the squash commit — no `-c` overrides by design) has an author, mirroring a real repo.
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# worktree test\n");
  execSync(`git init -q && git config user.email wt@loom && git config user.name wt && git add . && git commit -q -m "init"`, { cwd: repo });

  // (b) createWorktree → dir exists, HEAD on the loom/<key> branch (key is hashed, not a raw slice).
  const { worktreePath, branch } = await createWorktree(repo, "projWT", taskId);
  const key = path.basename(worktreePath);
  check(`(b) branch = loom/<key> (got ${branch})`, branch === `loom/${key}`);
  check("(b) worktree dir exists", fs.existsSync(worktreePath));
  check(`(b) worktree HEAD on ${branch}`, git(worktreePath, "rev-parse --abbrev-ref HEAD") === branch);
  check("(b) git worktree list includes the new worktree", git(repo, "worktree list").includes(key));

  // (c) ISOLATION: a commit on the worktree branch must not touch the canonical tree or its tip.
  const canonTipBefore = git(repo, "rev-parse HEAD");
  commitInto(worktreePath, "worker-file.txt", "from the worker\n", "worker commit");
  check("(c) worker commit advanced the worktree branch", git(worktreePath, "rev-parse HEAD") !== canonTipBefore);
  check("(c) canonical working tree does NOT contain worker-file.txt", !fs.existsSync(path.join(repo, "worker-file.txt")));
  check("(c) canonical branch tip unchanged", git(repo, "rev-parse HEAD") === canonTipBefore);

  // (d) distinct cwd → distinct transcript dir.
  check("(d) worktree cwd hashes to a distinct transcript dir from the repo",
    engineTranscriptPath(worktreePath, "x") !== engineTranscriptPath(repo, "x"));

  // (e) removeWorktree → dir gone, no longer listed (branch NOT deleted here — that's the merge's job).
  //     Its boolean return (bd9fc808 — the worktree-gc.ts retry queue's success signal) is TRUE here.
  const removedE = await removeWorktree(repo, worktreePath);
  check("(e) removeWorktree returns true on a successful removal", removedE === true);
  check("(e) worktree dir removed", !fs.existsSync(worktreePath));
  check("(e) git worktree list no longer lists it", !git(repo, "worktree list").includes(key));
  check("(e) removeWorktree did NOT delete the branch", git(repo, `branch --list ${branch}`).includes(branch));

  // (f) H1.1 — a CLEAN SQUASH merge lands ONE commit + deletes the branch: merge the worker's branch
  //     (two worker commits), remove the worktree, deleteBranch → the loom/<key> branch is force-gone
  //     (re-spawn won't hit "already exists"). The squash collapses N worker commits into ONE clean
  //     commit on main carrying the deterministic Loom-Worker-Branch trailer — NOT a merge commit.
  const tF = "feature-aaaa-1111";
  const headBeforeF = git(repo, "rev-parse HEAD");
  const { worktreePath: wtF, branch: brF } = await createWorktree(repo, "projWT", tF);
  commitInto(wtF, "f.txt", "f\n", "f commit 1");
  commitInto(wtF, "f2.txt", "f2\n", "f commit 2"); // two commits → must collapse to ONE on main
  const merged = await mergeBranch(repo, brF, "Feature F task title");
  check("(f) clean squash merge ok", merged.ok === true);
  check("(f) mergeBranch returns the new squash-commit SHA", typeof merged.sha === "string" && merged.sha.length >= 7);
  check("(f) exactly ONE new commit landed on main (the squash, not 2 worker commits)",
    git(repo, `rev-list --count ${headBeforeF}..HEAD`) === "1");
  check("(f) the landed commit is NOT a merge commit (single parent)",
    git(repo, "rev-list --parents -n 1 HEAD").trim().split(/\s+/).length === 2);
  check("(f) NO `Merge branch` commit was created",
    git(repo, `log --format=%s ${headBeforeF}..HEAD`).includes("Merge branch") === false);
  // The safety-net coerces the bare-prose title into Conventional Commits form (no leading type → "chore: ").
  check("(f) subject is the task title coerced to Conventional Commits form",
    git(repo, "log -1 --format=%s") === "chore: Feature F task title");
  check("(f) body carries the deterministic Loom-Worker-Branch trailer",
    git(repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${brF}`));
  check("(f) NO Co-Authored-By trailer (repo-config identity only)",
    git(repo, "log -1 --format=%b").includes("Co-Authored-By") === false);
  check("(f) both worker files landed on main", fs.existsSync(path.join(repo, "f.txt")) && fs.existsSync(path.join(repo, "f2.txt")));
  await removeWorktree(repo, wtF);
  await deleteBranch(repo, brF);
  check("(f) merged branch is GONE after deleteBranch (force-deleted — not in main's ancestry)", git(repo, `branch --list ${brF}`) === "");
  check("(f) merged worktree removed", !fs.existsSync(wtF));

  // (g) H1.2 — a REJECTED merge retains the worktree+branch; re-spawning on the same task must NOT throw.
  const tG = "rejected-bbbb-2222";
  const { worktreePath: wtG, branch: brG } = await createWorktree(repo, "projWT", tG);
  commitInto(wtG, "g.txt", "g\n", "g commit"); // worker's in-progress changes, merge rejected → retained
  // (g1) dir still present → createWorktree reuses it (no throw, same path).
  const reuse = await createWorktree(repo, "projWT", tG);
  check("(g1) re-create with the worktree present → reuses it (same path, no throw)", reuse.worktreePath === wtG && reuse.branch === brG);
  // (g2) dir removed but branch survives → createWorktree re-ATTACHES to the branch (no throw, history kept).
  await removeWorktree(repo, wtG);
  check("(g2 setup) branch survived the worktree removal", git(repo, `branch --list ${brG}`).includes(brG));
  const reattach = await createWorktree(repo, "projWT", tG);
  check("(g2) re-create with branch-only → attaches (dir back, HEAD on branch)",
    fs.existsSync(reattach.worktreePath) && git(reattach.worktreePath, "rev-parse --abbrev-ref HEAD") === brG);
  check("(g2) the retained branch kept the worker's commit (g.txt present in the re-attached tree)",
    fs.existsSync(path.join(reattach.worktreePath, "g.txt")));
  await removeWorktree(repo, reattach.worktreePath);
  await deleteBranch(repo, brG);

  // (i) H1.3 — two distinct task ids sharing the first 8 chars get DISTINCT branches/worktrees.
  const a = "abcd1234-1111", b = "abcd1234-2222"; // identical first 8 chars
  const A = await createWorktree(repo, "projWT", a);
  const B = await createWorktree(repo, "projWT", b);
  check("(i) id8-colliding tasks → distinct branches", A.branch !== B.branch);
  check("(i) id8-colliding tasks → distinct worktree dirs", A.worktreePath !== B.worktreePath);
  // cleanup: these were never merged — just drop the worktrees (no deleteBranch; their branches are unused).
  await removeWorktree(repo, A.worktreePath);
  await removeWorktree(repo, B.worktreePath);

  // (j) BOUNDED removal — the priority reliability fix. A busy/locked worktree dir makes
  //     `git worktree remove` HANG INDEFINITELY (it does NOT throw), and boot-reconcile's Pass B calls
  //     removeWorktree DURING daemon boot — so one stuck removal wedged the entire daemon boot for
  //     hours (2026-06-03). Inject a fake git whose `raw` NEVER resolves (a wedged child) with a tiny
  //     timeout and prove removeWorktree still RETURNS within the window — bounded, never an infinite
  //     hang. (Deterministic + cross-platform: no real busy handle needed.)
  {
    let seenTimeout = -1;
    const neverGit = { raw: () => new Promise(() => {}) }; // a hung child: this promise never settles
    const fakeFactory = (_repo, blockMs) => { seenTimeout = blockMs; return neverGit; };
    const ghostPath = path.join(process.env.LOOM_HOME, `ghost-${Date.now()}`); // not on disk → fs.rm no-ops
    const tinyMs = 250;
    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    let resolved = false;
    await removeWorktree(repo, ghostPath, { gitFactory: fakeFactory, timeoutMs: tinyMs }).then(() => { resolved = true; });
    const elapsed = performance.now() - t0;
    check("(j) removeWorktree RETURNS despite a never-resolving git op (not an infinite hang)", resolved);
    check(`(j) bounded by the timeout — returned in ${Math.round(elapsed)}ms (both ops capped at ${tinyMs}ms)`,
      elapsed >= tinyMs - TIMER_SLACK_MS && elapsed < tinyMs * 8 + 1500);
    check(`(j) block timeout is passed through to the git factory (got ${seenTimeout}ms)`, seenTimeout === tinyMs);

    // (j2) the DEFAULT (no timeoutMs) path uses a 15s per-op block timeout — generous for a real
    //      removal, bounded for a hang. Record the ms the factory receives; a fast stub git lets the
    //      fs backstop do the actual dir removal so the assertion stays hermetic.
    const { worktreePath: wtJ } = await createWorktree(repo, "projWT", "bounded-cccc-3333");
    let defaultMs = -1;
    await removeWorktree(repo, wtJ, { gitFactory: (_p, ms) => { defaultMs = ms; return { raw: async () => "" }; } });
    check("(j2) default per-op block timeout is 15000ms (generous-but-bounded)", defaultMs === 15000);
    check("(j2) dir still removed via the fs backstop when git is stubbed", !fs.existsSync(wtJ));
    // (the stub git leaves the admin record registered; the repo teardown below drops it — no deleteBranch.)
  }

  // (k) The OTHER boot-reconcile ops are bounded too — isBranchMerged + deleteBranch run during
  //     boot-reconcile Pass A (Pass A: isBranchMerged → finalizeMerge's deleteBranch), so a hung git
  //     there wedges boot just like removeWorktree. Same fake-never-resolves proof: inject a git whose
  //     `raw` never settles and assert each RETURNS within the bounded window, default cap 15000ms.
  {
    const neverGit = { raw: () => new Promise(() => {}) }; // a hung child: this promise never settles
    const tinyMs = 250;

    // (k1) isBranchMerged: a hung `git branch --merged` returns the SAFE default false (→ Pass A SKIPS
    //      the session), bounded — never a hang.
    let mergedMs = -1;
    const t1 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    const merged = await isBranchMerged(repo, "any-branch", "HEAD",
      { gitFactory: (_p, ms) => { mergedMs = ms; return neverGit; }, timeoutMs: tinyMs });
    const e1 = performance.now() - t1;
    check("(k1) isBranchMerged RETURNS despite a never-resolving git op (not an infinite hang)", merged === false);
    check(`(k1) bounded — returned false in ${Math.round(e1)}ms (cap ${tinyMs}ms)`, e1 >= tinyMs - TIMER_SLACK_MS && e1 < tinyMs * 5 + 1500);
    check(`(k1) block timeout passed through to the git factory (got ${mergedMs}ms)`, mergedMs === tinyMs);
    let mergedDefMs = -1;
    await isBranchMerged(repo, "any-branch", "HEAD", { gitFactory: (_p, ms) => { mergedDefMs = ms; return { raw: async () => "" }; } });
    check("(k1) default per-op block timeout is 15000ms", mergedDefMs === 15000);

    // (k2) deleteBranch: a hung `git branch -D` is swallowed + bounded (best-effort), never a hang.
    let delMs = -1;
    const t2 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    let delResolved = false;
    await deleteBranch(repo, "loom/nonexistent",
      { gitFactory: (_p, ms) => { delMs = ms; return neverGit; }, timeoutMs: tinyMs }).then(() => { delResolved = true; });
    const e2 = performance.now() - t2;
    check("(k2) deleteBranch RETURNS despite a never-resolving git op (swallowed, not a hang)", delResolved);
    check(`(k2) bounded — returned in ${Math.round(e2)}ms (cap ${tinyMs}ms)`, e2 >= tinyMs - TIMER_SLACK_MS && e2 < tinyMs * 5 + 1500);
    check(`(k2) block timeout passed through to the git factory (got ${delMs}ms)`, delMs === tinyMs);
    let delDefMs = -1;
    await deleteBranch(repo, "loom/nonexistent", { gitFactory: (_p, ms) => { delDefMs = ms; return { raw: async () => "" }; } });
    check("(k2) default per-op block timeout is 15000ms", delDefMs === 15000);
  }

  // (l) BOUNDED FILESYSTEM backstop — the 2026-06-04 outage fix. Even with the git ops bounded, the
  //     recursive `fs.rm` backstop was UNBOUNDED: a worktree dir with a stuck Windows directory handle
  //     (held by a SEPARATE process) makes the recursive remove block on the libuv threadpool FOREVER —
  //     it never throws on its own. boot-reconcile Pass B calls removeWorktree DURING boot, before
  //     app.listen(), so that hang wedged the whole daemon (port 4317 unbound ~5-6 min). Inject an `rm`
  //     that NEVER resolves (a stuck handle) with a tiny timeout and prove removeWorktree still RETURNS
  //     within the window — the stuck dir is left on disk + logged, never an infinite hang.
  {
    const stubFastGit = (_p, _ms) => ({ raw: async () => "" }); // git ops succeed fast → only the fs.rm hangs
    const neverRm = () => new Promise(() => {}); // a stuck dir handle: this remove never settles
    const tinyMs = 250;
    const stuckPath = path.join(process.env.LOOM_HOME, `stuck-${Date.now()}`); // Date.now() here = unique path, not a duration
    fs.mkdirSync(stuckPath, { recursive: true }); // real dir on disk so the "left behind" signal below is meaningful
    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    let resolved = false;
    let removedL;
    await removeWorktree(repo, stuckPath,
      { gitFactory: stubFastGit, rm: neverRm, timeoutMs: tinyMs }).then((r) => { resolved = true; removedL = r; });
    const elapsed = performance.now() - t0;
    check("(l) removeWorktree RETURNS despite a never-resolving fs.rm (stuck dir handle, not an infinite hang)", resolved);
    check("(l) returns FALSE — the dir is left on disk (the signal worktree-gc.ts's background retry queues on)",
      removedL === false && fs.existsSync(stuckPath));
    fs.rmSync(stuckPath, { recursive: true, force: true }); // cleanup (neverRm never actually removed it)
    check(`(l) bounded by the timeout — returned in ${Math.round(elapsed)}ms (fs backstop capped at ${tinyMs}ms)`,
      elapsed >= tinyMs - TIMER_SLACK_MS && elapsed < tinyMs * 8 + 1500);
  }

  // (m) findLandedSquashCommit — the deterministic trailer detector that REPLACES isBranchMerged under
  //     squash (boot-reconcile Pass A) and the `Merge branch` grep (workerDiff stage 3). Proves: it finds
  //     a genuine landed squash by trailer (branch present + branch gone), ignores an unrelated branch,
  //     and — THE DATA-LOSS-SENSITIVE re-task guard — returns null when the branch was RE-CUT onto a PRIOR
  //     squash (a re-spawned live worker carrying a historical trailer + new work), so Pass A KEEPS it.
  {
    // A genuine landed squash for task tM: worker commits, mergeBranch squashes onto main (branch retained,
    // as in the daemon-died-after-squash orphan). The branch DIVERGES from the squash → detected as landed.
    const tM = "squashland-dddd-4444";
    const { worktreePath: wtM, branch: brM } = await createWorktree(repo, "projWT", tM);
    commitInto(wtM, "m.txt", "m\n", "m commit");
    const mM = await mergeBranch(repo, brM, "M task");
    check("(m) squash landed ok", mM.ok === true && typeof mM.sha === "string");
    const foundPresent = await findLandedSquashCommit(repo, brM);
    check("(m) finds the squash by trailer while the branch is STILL present (the orphan shape)", foundPresent === mM.sha);
    check("(m) does NOT match an unrelated branch", (await findLandedSquashCommit(repo, "loom/nonexistent")) === null);
    // Branch gone (the fully-finalized / workerDiff stage-3 shape) → the trailer commit is still found.
    await removeWorktree(repo, wtM);
    await deleteBranch(repo, brM);
    check("(m) branch is GONE", git(repo, `branch --list ${brM}`) === "");
    check("(m) STILL finds the squash by trailer after the branch is deleted (trailer persists in main)",
      (await findLandedSquashCommit(repo, brM)) === mM.sha);

    // RE-TASK GUARD: re-spawn the SAME task (same key → same branch name). createWorktree re-cuts the
    // empty branch onto CURRENT main (which now contains the prior squash as an ancestor). The worker does
    // NEW work. The historical trailer is in main, but the trailer commit is an ANCESTOR of the re-cut
    // branch → findLandedSquashCommit must return NULL so Pass A treats this as a LIVE worker, not a landed
    // orphan (else the re-spawned worker's worktree would be deleted — data loss).
    const { worktreePath: wtM2, branch: brM2 } = await createWorktree(repo, "projWT", tM);
    check("(m) re-task reuses the SAME branch name", brM2 === brM);
    commitInto(wtM2, "m-new.txt", "new live work\n", "m re-task commit");
    check("(m) RE-TASK GUARD: a branch re-cut onto the prior squash is NOT a landed orphan → null (KEEP the live worker)",
      (await findLandedSquashCommit(repo, brM2)) === null);
    await removeWorktree(repo, wtM2);
    await deleteBranch(repo, brM2);
  }

  // (n) toConventionalSubject — the PURE merge safety-net that guarantees every squash subject is
  //     Conventional Commits even if a card title slips. Unit cases for the three branches (passthrough,
  //     legacy-bracket map, bare-prose default) + an END-TO-END proof through mergeBranch that the subject
  //     is coerced AND the load-bearing Loom-Worker-Branch trailer survives EXACTLY (reconcile keys on it).
  {
    // Already-conventional → UNCHANGED (incl. scope and the `!` breaking marker).
    check("(n) passthrough: plain conventional", toConventionalSubject("fix: paste double-fires") === "fix: paste double-fires");
    check("(n) passthrough: scope + bang", toConventionalSubject("feat(web)!: drop old API") === "feat(web)!: drop old API");
    // Plain scoped subject (no bang) — the form doctrine now requires — passes through untouched.
    check("(n) passthrough: scope, no bang", toConventionalSubject("docs(skills): require commit scope") === "docs(skills): require commit scope");
    // Legacy [Type, Priority] / [Type] bracket → mapped type + bracket stripped.
    check("(n) legacy [Bug, P2] → fix:", toConventionalSubject("[Bug, P2] Fix paste") === "fix: Fix paste");
    check("(n) legacy [Release] → chore:", toConventionalSubject("[Release] Bump to v0.5.0") === "chore: Bump to v0.5.0");
    check("(n) legacy [Feature, P1] → feat:", toConventionalSubject("[Feature, P1] Voice input") === "feat: Voice input");
    check("(n) legacy [Maintenance] → chore:", toConventionalSubject("[Maintenance] Bump actions") === "chore: Bump actions");
    check("(n) legacy [Hardening] → fix:", toConventionalSubject("[Hardening, P2] Bound git op") === "fix: Bound git op");
    check("(n) legacy unknown type → chore:", toConventionalSubject("[Frobnicate] Do a thing") === "chore: Do a thing");
    // Multi-type bracket → FIRST listed type (documented behavior; spec map has no multi-type case).
    check("(n) multi-type [Bug/Docs] → first type (fix:)", toConventionalSubject("[Bug/Docs] Fix and document") === "fix: Fix and document");
    // Bare prose → default chore: prefix; description casing untouched.
    check("(n) bare prose → chore:", toConventionalSubject("Refresh the dashboard") === "chore: Refresh the dashboard");
    check("(n) bare prose keeps description casing", toConventionalSubject("ALL CAPS thing") === "chore: ALL CAPS thing");

    // END-TO-END through mergeBranch: a legacy-bracket title is coerced on the squash subject AND the
    // Loom-Worker-Branch trailer is preserved EXACTLY (the downstream reconcile key — must not regress).
    const tN = "convsubj-eeee-5555";
    const { worktreePath: wtN, branch: brN } = await createWorktree(repo, "projWT", tN);
    commitInto(wtN, "n.txt", "n\n", "n commit");
    const mN = await mergeBranch(repo, brN, "[Bug, P2] Fix the thing");
    check("(n) e2e squash ok", mN.ok === true && typeof mN.sha === "string");
    check("(n) e2e subject coerced to conventional through mergeBranch",
      git(repo, "log -1 --format=%s") === "fix: Fix the thing");
    check("(n) e2e Loom-Worker-Branch trailer preserved EXACTLY (reconcile key intact)",
      git(repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${brN}`));
    check("(n) e2e the coerced commit is still discoverable by its trailer", (await findLandedSquashCommit(repo, brN)) === mN.sha);
    await removeWorktree(repo, wtN);
    await deleteBranch(repo, brN);
  }
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worktree-per-worker isolates, merges + deletes the branch on a clean merge, tolerates re-spawn on a retained (rejected) task, never collides on the first 8 chars of a task id, and every boot-reconcile op (removeWorktree's git ops AND its filesystem backstop, isBranchMerged, deleteBranch) is BOUNDED — neither a hung git nor a stuck directory handle can wedge daemon boot anywhere in the reconcile path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
