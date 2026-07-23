import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P1 regression test (board card 06b5c47f, correcting card 9e77050f's guard).
//
// THE BUG: mergeBranchLocked's pre-merge entry probe refused on `git status --porcelain
// --untracked-files=no`, which covers BOTH staged AND unstaged tracked changes. But only STAGED content
// can produce the corruption that guard exists to prevent — a `--squash` commits the INDEX, so unstaged
// working-tree edits are never committed by it and can never land under a branch's subject/trailer.
// Measured live: the boot scan flagged 4 canonical repos, and EVERY flagged entry was unstaged-only —
// 4-for-4 false positives, each blocking ALL merges on that project. Worse, one repo's only dirt was a
// submodule gitlink (a normal steady state for a repo with submodules, not residue) — a case that could
// block that repo's merges PERMANENTLY, since a human may have no reason (or ability) to "clear" it.
//
// THE TRAP a naive fix falls into: narrowing the probe to `diff --cached` for the MERGE refusal alone,
// without ALSO re-scoping the `reset --hard` cleanup calls further down in the same function, reopens a
// real data-loss bug — those resets discard staged AND unstaged tracked state, a WIDER blast radius than
// the narrowed merge-refusal now covers. THE FIX gives each precondition its own scope: the merge refusal
// keys on `diff --cached` alone; every `reset --hard` cleanup path is gated by its OWN separate guard
// (`hadUnstagedDirtAtEntry`, from the broad `git status`) that SKIPS the reset — leaving any residue for
// the next merge's staged-only refusal to catch — rather than running it over a human's pre-existing
// unstaged edits.
//
// This test proves all three DoD properties for the narrowed guard:
//   (1) A repo dirty ONLY with an ordinary unstaged tracked edit merges normally (ok:true) — and that
//       edit is untouched afterward.
//   (2) A repo whose only dirt is a submodule GITLINK (real submodule, mode 160000, checked-out commit
//       ahead of the recorded pointer — not staged) merges normally, and the gitlink is untouched.
//   (3) The property the ORIGINAL broad check protected — a human's unstaged edit is NEVER discarded by
//       a `reset --hard` cleanup path — still holds under the narrowed guard: forcing a REAL squash
//       conflict (which drives the "conflict cleanup" reset --hard) with an unrelated unstaged edit
//       present proves the edit survives the refusal untouched.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-unstaged-residue-does-not-block.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mur@loom -c user.name=mur";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-mur-repo-${label}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mur@loom && git config user.name mur && git config protocol.file.allow always`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, fromRef, file, content) {
  const wt = path.join(os.tmpdir(), `loom-mur-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" ${fromRef}`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  // ── (1) Ordinary unstaged tracked dirt merges normally ────────────────────────────────────────────
  {
    const repo = makeRepo("unstaged");
    fs.writeFileSync(path.join(repo, "human-wip.txt"), "original\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: repo });
    makeWorktree(repo, "loom/branch-u", "HEAD", "file-u.txt", `u-content-${sfx}\n`);

    // Dirty the canonical repo with an UNSTAGED edit — never `git add`ed.
    fs.writeFileSync(path.join(repo, "human-wip.txt"), "MY-UNSAVED-WORK\n");
    check("setup: human-wip.txt is unstaged-dirty, not staged", git(repo, "diff --cached --name-only") === "" && git(repo, "diff --name-only") === "human-wip.txt");

    const res = await mergeBranch(repo, "loom/branch-u", "Card U title");
    check("merge with ONLY unstaged dirt present succeeds (ok:true)", res.ok === true && !!res.sha);

    const wip = fs.readFileSync(path.join(repo, "human-wip.txt"), "utf8");
    check("the unstaged edit survives the merge untouched", wip === "MY-UNSAVED-WORK\n");
    const tree = git(repo, "ls-tree -r --name-only HEAD");
    check("branch U's content landed", tree.includes("file-u.txt"));
  }

  // ── (2) A submodule gitlink (mode 160000, checked-out commit ahead of the recorded pointer) merges
  //        normally — this is the PERMANENT-block case: a legitimately-configured repo with submodules
  //        must never be unable to merge just because its gitlink reflects normal submodule usage.
  {
    const subSrc = makeRepo("submodule-src");
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s1\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m s1`, { cwd: subSrc });
    const s1Sha = git(subSrc, "rev-parse HEAD");

    // `submodule add` clones subSrc's CURRENT HEAD, so it must run while subSrc is still at s1 — advancing
    // it happens AFTER, below, to simulate ordinary submodule usage (checked-out commit moves ahead of the
    // recorded pointer without anyone staging that move in the superproject).
    const repo = makeRepo("submodule-super");
    execSync(`git ${GIT_ID} -c protocol.file.allow=always submodule add "${subSrc}" sub`, { cwd: repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add submodule"`, { cwd: repo });
    const gitlinkModeAtEntry = git(repo, "ls-files -s -- sub").split(/\s+/)[0];
    check("setup: submodule is a REAL gitlink (mode 160000)", gitlinkModeAtEntry === "160000");
    const gitlinkShaAtEntry = git(repo, "ls-files -s -- sub").split(/\s+/)[1];
    check("setup: recorded gitlink SHA is the submodule's FIRST commit", gitlinkShaAtEntry === s1Sha);

    // Advance the submodule's SOURCE, then pull that into the checked-out submodule WITHOUT staging it in
    // the superproject — the normal steady state for a repo with submodules, not residue from an
    // interrupted squash.
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s2\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m s2`, { cwd: subSrc });
    const s2Sha = git(subSrc, "rev-parse HEAD");
    execSync(`git fetch -q origin && git checkout -q ${s2Sha}`, { cwd: path.join(repo, "sub") });
    // NOTE: the leading space in porcelain's "XY PATH" format is significant (X=index status, Y=worktree
    // status) — use the RAW output here, not the `git()` helper's `.trim()`, which would eat it.
    const statusRaw = execSync("git status --porcelain --untracked-files=no", { cwd: repo }).toString();
    check("setup: submodule shows as UNSTAGED dirt ( M sub), not staged", /^ M sub\r?\n?$/.test(statusRaw));
    check("setup: nothing is staged", git(repo, "diff --cached --name-only") === "");

    makeWorktree(repo, "loom/branch-s", "HEAD", "file-s.txt", `s-content-${sfx}\n`);

    const res = await mergeBranch(repo, "loom/branch-s", "Card S title");
    check("merge with ONLY a submodule gitlink dirty succeeds (ok:true) — not permanently blocked", res.ok === true && !!res.sha);

    const gitlinkModeAfter = git(repo, "ls-files -s -- sub").split(/\s+/)[0];
    const gitlinkShaAfter = git(repo, "ls-files -s -- sub").split(/\s+/)[1];
    check("the recorded gitlink is UNCHANGED by the merge (still mode 160000, still the old SHA)", gitlinkModeAfter === "160000" && gitlinkShaAfter === s1Sha);
    check("the submodule's own checked-out commit is UNCHANGED by the merge (not reset)", git(path.join(repo, "sub"), "rev-parse HEAD") === s2Sha);
  }

  // ── (3) THE PROPERTY THE ORIGINAL BROAD CHECK PROTECTED: a human's unstaged edit is NEVER discarded
  //        by a `reset --hard` cleanup path, even when one of those paths actually runs. Force a REAL
  //        squash conflict so the "conflict cleanup" reset --hard is reached with unstaged dirt present.
  {
    const repo = makeRepo("conflict-cleanup");
    fs.writeFileSync(path.join(repo, "conflict.txt"), "orig\n");
    fs.writeFileSync(path.join(repo, "human-wip.txt"), "original\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: repo });
    const baseRef = git(repo, "rev-parse HEAD");

    // Branch A lands FIRST (clean), advancing canonical's conflict.txt.
    const wtA = makeWorktree(repo, "loom/branch-a", baseRef, "conflict.txt", "A-version\n");
    const resA = await mergeBranch(repo, "loom/branch-a", "Card A title");
    check("setup: branch A lands cleanly first", resA.ok === true && !!resA.sha);

    // Branch B is cut from the ORIGINAL base (before A landed) and touches the SAME file differently —
    // squashing it now conflicts against canonical's current (A's) content.
    const wtB = makeWorktree(repo, "loom/branch-b", baseRef, "conflict.txt", "B-version\n");

    // Dirty an UNRELATED tracked file with unstaged edits right before the conflicting merge attempt.
    fs.writeFileSync(path.join(repo, "human-wip.txt"), "MY-UNSAVED-WORK\n");
    check("setup: human-wip.txt is unstaged-dirty going into the conflicting merge", git(repo, "diff --cached --name-only") === "" && git(repo, "diff --name-only").includes("human-wip.txt"));

    const resB = await mergeBranch(repo, "loom/branch-b", "Card B title");
    check("op B refuses due to the real conflict (ok:false, conflict:true)", resB.ok === false && resB.conflict === true);
    check("op B's reason explains cleanup was SKIPPED to protect the unstaged edit", typeof resB.reason === "string" && /skip/i.test(resB.reason) && /unstaged/i.test(resB.reason));

    const wip = fs.readFileSync(path.join(repo, "human-wip.txt"), "utf8");
    check("the unstaged edit survives the conflict-cleanup path COMPLETELY UNTOUCHED — never discarded by reset --hard", wip === "MY-UNSAVED-WORK\n");

    void wtA; void wtB;
  }

  // ── 9e77050f's own staged-residue refusal is UNCHANGED: still proven by merge-staged-residue-refuses.mjs.
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — unstaged tracked dirt (incl. a real submodule gitlink) no longer blocks merges, and a human's unstaged edit is still never discarded by a reset --hard cleanup path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
