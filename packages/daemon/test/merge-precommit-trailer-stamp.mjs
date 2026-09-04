import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c862f14c — drops mergeBranchLocked's follow-up `git commit --amend` (which stamped
// `Loom-Worker-Base`/`Loom-Worker-PathSet` on a SECOND commit) in favor of computing both from the
// STAGED index and baking them into the ORIGINAL commit message, so a solo squash-merge lands as ONE
// commit. Card c862f14c's own DoD-1 proves the staged-vs-HEAD path set and the post-commit `sha^..sha`
// path set are the SAME two tree objects (a commit's tree IS the index it was made from; its parent IS
// whatever HEAD was before it) — this suite is DoD-3 and DoD-4's real-git verification of that fix.
// REAL git on temp repos, NO claude and NO live daemon.
//
// Proves:
//   DoD-3 — POSITIVE CONTROL, byte-identical digest (not "both verify green", which two DIFFERENT
//   digests can both do): for a PLAIN case and a RENAME case, the `Loom-Worker-PathSet` digest the new
//   pre-commit stamp actually lands is diffed BYTE-FOR-BYTE against an INDEPENDENT post-hoc recomputation
//   via the exported `changedPathSetDigest(git, sha^, sha)` — the same function {@link
//   verifyPersistedPathSet} itself uses to check a stamp later, called here directly against the landed
//   commit, entirely independent of however the stamp itself was produced.
//     (1) PLAIN — a new file, no rename involved.
//     (2) RENAME — main renames a path the branch also edited (the card 756a2cd8 shape), squash lands
//         cleanly under the renamed path.
//
//   DoD-4 — a real `commit-msg` hook (fixture, not mocked) whose appended trailer EMBEDS its own run
//   number (from a shared counter file), not a fixed string — a fixed-string trailer is idempotent, so an
//   old-code amend's SECOND invocation re-appending the identical text would hide the discard this case
//   exists to catch; embedding the run number means the old code's second invocation lands "run 2" (having
//   discarded the first commit's own "run 1"), so asserting the landed value is exactly 1 is what actually
//   discriminates, not just presence of the trailer:
//     (3) The hook fires EXACTLY ONCE per merge (the old two-commit amend fired it twice).
//     (4) The landed commit carries the hook's FIRST-invocation trailer ("run 1"), not a later run's value
//         that discarded it (the old amend rebuilt the message from an in-memory JS string, silently
//         discarding whatever the hook had written onto the first commit, then re-fired on the amend).
//     (5) The machine-stamped `Loom-Worker-Base`/`Loom-Worker-PathSet` trailers are STILL present
//         alongside the hook's own trailer (neither side clobbers the other now that there's one commit).
//   MANUALLY VERIFIED RED against the pre-fix (follow-up-amend) code by reverting git/worktrees.ts to its
//   pre-c862f14c form, rebuilding, and re-running cases (3)-(4) — both failed (hook fired twice; case (4)'s
//   trailer was overwritten by the amend) before this fix landed. Not re-verified automatically on every
//   run (same convention as merge-trailer-shadowing.mjs's own case (4)).
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-precommit-trailer-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch, changedPathSetDigest, taskKey } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=pts@loom -c user.name=pts";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const tmpDirs = [];

// A minimal `Pick<SimpleGit, "raw">` shim over real git — identical call shape to what production passes
// changedPathSetDigest, so this test exercises the SAME exported function verifyPersistedPathSet uses,
// independent of however the trailer stamp itself was produced.
function rawGit(cwd) {
  return { async raw(args) { return execFileSync("git", args, { cwd }).toString(); } };
}

function newRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-pts-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(repo);
  fs.mkdirSync(repo, { recursive: true });
  execSync(`git init -q && git config user.email pts@loom && git config user.name pts && git commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

function makeWorktreeBranch(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-pts-wt-${branch.replace(/\//g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

try {
  // ── DoD-3 (1) PLAIN — byte-identical digest, no rename involved ────────────────────────────────────────
  {
    const repo = newRepo("plain");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pts-task-plain-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const wt = makeWorktreeBranch(repo, branch, "new-file.txt", "plain new content\n");
    removeWorktree(repo, wt);

    const merged = await mergeBranch(repo, branch, "Card plain-case title");
    check("(1) precondition: plain-case squash landed", merged.ok === true && typeof merged.sha === "string");
    const body = git(repo, `log -1 --format=%B ${merged.sha}`);
    const stampedDigest = body.match(/Loom-Worker-PathSet: (\S+)/)?.[1];
    check("(1) precondition: the landed commit carries a Loom-Worker-PathSet trailer", !!stampedDigest);

    const independentDigest = await changedPathSetDigest(rawGit(repo), `${merged.sha}^`, merged.sha);
    check("(1) DoD-3: stamped digest is BYTE-IDENTICAL to an independent sha^..sha recomputation (plain case)",
      stampedDigest === independentDigest);
  }

  // ── DoD-3 (2) RENAME — byte-identical digest, main renames a path the branch also edited ────────────────
  {
    const repo = newRepo("rename");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pts-task-rename-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;

    fs.writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add shared file"`, { cwd: repo });
    const wt = makeWorktreeBranch(repo, branch, "shared.txt", "line1-BRANCH-EDIT\nline2\nline3\n");
    removeWorktree(repo, wt);

    execSync(`git mv shared.txt renamed.txt`, { cwd: repo });
    execSync(`git ${GIT_ID} commit -q -m "main: rename shared file"`, { cwd: repo });

    const merged = await mergeBranch(repo, branch, "Card rename-case title");
    check("(2) precondition: squash onto a renamed path succeeded (no conflict)", merged.ok === true && typeof merged.sha === "string");
    const body = git(repo, `log -1 --format=%B ${merged.sha}`);
    const stampedDigest = body.match(/Loom-Worker-PathSet: (\S+)/)?.[1];
    check("(2) precondition: the landed commit carries a Loom-Worker-PathSet trailer", !!stampedDigest);

    const independentDigest = await changedPathSetDigest(rawGit(repo), `${merged.sha}^`, merged.sha);
    check("(2) DoD-3: stamped digest is BYTE-IDENTICAL to an independent sha^..sha recomputation (rename case)",
      stampedDigest === independentDigest);
  }

  // ── DoD-4 (3)(4)(5) — a real commit-msg hook fires ONCE and its trailer SURVIVES ─────────────────────────
  {
    const repo = newRepo("hook");
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskId = `pts-task-hook-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const wt = makeWorktreeBranch(repo, branch, "hooked-file.txt", "content for the hooked merge\n");
    removeWorktree(repo, wt);

    // Installed AFTER the worktree's own setup commit (hooks are shared per-repo, not per-worktree — same
    // ordering rationale as merge-hang-does-not-wedge-queue.mjs's own hook install comment) so it only
    // fires for the merge's own commit(s), not the branch's own worker commit above.
    //
    // The trailer the hook appends EMBEDS its own run number (from a shared counter file), rather than a
    // fixed string — deliberately, so this test can actually discriminate a follow-up amend from a single
    // commit. A FIXED-string trailer is idempotent: an old-code amend re-fires the hook against the
    // in-memory `amendedMessage` (which never contained the first commit's hook-added line), so the SECOND
    // invocation re-appends the same fixed text and the final message looks identical either way — the
    // discarding happened, but a content-identical re-append hides it. Embedding the run number means the
    // OLD code's second invocation appends "run 2" (having discarded the first commit's own "run 1"), while
    // the NEW code's single invocation appends "run 1" — so asserting the LANDED value is exactly 1 (not
    // merely present) is what actually catches the discard, not just the fire count in case (3) below.
    const counterPath = path.join(repo, ".git", "hook-fired-count");
    const hookPath = path.join(repo, ".git", "hooks", "commit-msg");
    const counterPosix = counterPath.replace(/\\/g, "/");
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\ncount=$(cat "${counterPosix}" 2>/dev/null || echo 0)\nnext=$((count + 1))\necho $next > "${counterPosix}"\necho "Signed-off-by-run: $next" >> "$1"\n`,
    );
    fs.chmodSync(hookPath, 0o755);

    const merged = await mergeBranch(repo, branch, "Card hook-case title");
    check("(3)-(5) precondition: hooked squash landed", merged.ok === true && typeof merged.sha === "string");

    const fireCount = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8").trim()) : 0;
    check("(3) DoD-4: the commit-msg hook fired EXACTLY ONCE for this merge (a follow-up amend would fire it twice)",
      fireCount === 1);

    const finalBody = git(repo, `log -1 --format=%B ${merged.sha}`);
    const landedRun = finalBody.match(/Signed-off-by-run: (\d+)/)?.[1];
    check("(4) DoD-4: the hook's FIRST-invocation trailer SURVIVES onto the final landed commit — landed " +
      `run number is 1, not a later run's value that discarded it (landed: ${landedRun ?? "<absent>"})`,
      landedRun === "1");
    check("(5) DoD-4: the machine-stamped Loom-Worker-Base/PathSet trailers are STILL present alongside the " +
      "hook's own trailer (neither commit clobbers the other)",
      /Loom-Worker-Base: \S+/.test(finalBody) && /Loom-Worker-PathSet: \S+/.test(finalBody));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the pre-commit Loom-Worker-Base/PathSet stamp (card c862f14c) is byte-identical to an " +
    "independent post-hoc sha^..sha recomputation for both a plain and a rename case, and a real commit-msg " +
    "hook fires exactly once (not twice) with its own trailer surviving alongside the machine-stamped ones."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
