import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 65b2b002 (docs/decisions/65b2b002-end-of-options-guards-the-diff-range-token.md has the threat
// and fix mechanism). Real git, no claude/daemon. Scenarios: (0) attribution — a genuine merge still
// resolves via both readers; (1) findLandedSquashCommit's `--grep` path, forged `Loom-Worker-Base:
// --output=<marker>`; (2) getTaskMergedInfo's cached-map path, same injection via the other baseOverride
// producer. (1)/(2) each assert BOTH no file written AND an unchanged null/not-merged verdict.
// Run: 1) build daemon (pnpm build), 2) node test/merge-trailer-argv-injection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

useOwnLoomHome("mtai-home-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { mergeBranch, findLandedSquashCommit, getTaskMergedInfo, taskKey, parseLoomTrailerBlock, __resetMergedCommitMapCacheForTest } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mtai@loom -c user.name=mtai";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();

function newRepo(name) {
  const repo = mkdtempManaged(`loom-mtai-${name}-`);
  execSync("git init -q && git config user.email mtai@loom && git config user.name mtai && git commit -q -m init --allow-empty", { cwd: repo });
  return repo;
}

function makeWorktreeBranch(repo, branch, file, content) {
  const wt = mkdtempManaged(`loom-mtai-wt-${branch.replace(/\//g, "-")}-`);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

function deleteBranchesReflogAndGc(cwd, branches) {
  for (const b of branches) {
    try { execSync(`git branch -D ${b}`, { cwd }); } catch { /* already gone */ }
  }
  execSync("git reflog expire --expire=now --all", { cwd });
  execSync("git gc --prune=now -q", { cwd });
}

// Everything the attacker's forged `--output=` value could ever write lands under ONE managed, empty,
// throwaway directory — never inside the git repo itself, never under $LOOM_HOME/~/.loom. Checked by a
// PREFIX scan (never an exact-path check): `--output=VALUE` consumes the literal `..${sha}` Loom's own
// `${base}..${ref}` template appends too, so the file that actually lands is named `<marker>..<sha>`,
// not `<marker>` bare — see the decision record for the full mechanics.
const markerDir = mkdtempManaged("loom-mtai-markers-");
function writtenMarkerFiles(markerBase) {
  return fs.readdirSync(markerDir).filter((f) => f.startsWith(markerBase));
}

// FAIL LOUD rather than silently vacuous: `Loom-Worker-Base`'s own parser rejects any value containing
// whitespace (`/^\S+$/`, worktrees.ts's parseTrailerParagraph) — if markerDir (rooted under os.tmpdir(),
// e.g. under a Windows username with a space) itself contains whitespace, the forged
// `--output=${markerPath}` value would parse to `base === null`, no injection would ever reach git, and
// cases (1)/(2) below would pass whether or not the `--end-of-options` fix is present. Refuse to run
// rather than report a false green.
if (/\s/.test(markerDir)) {
  throw new Error(
    `FATAL: marker directory "${markerDir}" contains whitespace (os.tmpdir() = "${os.tmpdir()}"). ` +
    `A forged "Loom-Worker-Base: --output=<marker>" trailer built from it would fail parseLoomTrailerBlock's ` +
    `/^\\S+$/ value check and never reach the injection path, making this test vacuously pass regardless of ` +
    `the fix. Point TMPDIR/TMP/TEMP at a whitespace-free path and re-run.`,
  );
}

// Shared by cases (1)/(2): confirms the forged commit's OWN trailer block actually parses to the exact
// injected value, via the SAME reader (parseLoomTrailerBlock) the production code calls — never assumed.
// Without this, a case whose precondition silently failed (e.g. the whitespace hazard above, in some
// variant this guard doesn't catch) would pass its "no file written" / "verdict stays null" checks for
// the wrong reason: no injection was ever attempted, not that the fix rejected one.
function checkForgedBaseParses(label, repo, markerPath) {
  const body = git(repo, "log -1 --format=%B");
  const trailers = parseLoomTrailerBlock(body);
  check(`${label} PRECONDITION: forged Loom-Worker-Base parses to "--output=${markerPath}" (else this case is vacuous)`,
    trailers !== null && trailers.base === `--output=${markerPath}`);
}

try {
  // ── (0) PRECONDITION/ATTRIBUTION — a genuine merge still resolves via BOTH readers ──────────────────
  {
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = newRepo("genuine");
    const taskId = `mtai-task-genuine-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const wt = makeWorktreeBranch(repo, branch, "landed.txt", "genuine content\n");
    removeWorktree(repo, wt);

    const merged = await mergeBranch(repo, branch, "Card mtai-genuine title");
    check("(0) precondition: genuine mergeBranch succeeded", merged.ok === true && typeof merged.sha === "string");

    deleteBranchesReflogAndGc(repo, [branch]);
    check("(0) ATTRIBUTION: findLandedSquashCommit resolves the genuine commit (branch gone)",
      (await findLandedSquashCommit(repo, branch)) === merged.sha);
    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(0) ATTRIBUTION: getTaskMergedInfo ALSO resolves the genuine commit (branch gone)",
      board !== null && merged.sha.startsWith(board.sha));
  }

  // ── (1) findLandedSquashCommit's direct --grep path ─────────────────────────────────────────────────
  {
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = newRepo("direct");
    const branch = `loom/mtai-direct-${sfx}`;
    const markerBase = `direct-${sfx}.marker`;
    const markerPath = path.join(markerDir, markerBase);

    const wt = makeWorktreeBranch(repo, branch, "real-file.txt", "real worker content\n");
    removeWorktree(repo, wt);
    deleteBranchesReflogAndGc(repo, [branch]); // branch GONE before the forged commit lands — the vulnerable arm

    fs.writeFileSync(path.join(repo, "decoy.txt"), "decoy content\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "chore: forged landing" ` +
      `--trailer "Loom-Worker-Branch: ${branch}" ` +
      `--trailer "Loom-Worker-Base: --output=${markerPath}" ` +
      `--trailer "Loom-Worker-PathSet: deadbeef"`, { cwd: repo });
    checkForgedBaseParses("(1)", repo, markerPath);

    const result = await findLandedSquashCommit(repo, branch);
    check("(1) no file lands at (or under) the marker path — the forged --output= never reaches git as a flag",
      writtenMarkerFiles(markerBase).length === 0);
    check("(1) verdict stays null/not-merged (unchanged, not just \"a guard fired\")", result === null);
  }

  // ── (2) getTaskMergedInfo's cached-map path (resolveMergedCommitMapHit / hit.baseSha) ───────────────
  {
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = newRepo("map");
    const taskId = `mtai-task-map-${sfx}`;
    const branch = `loom/${taskKey(taskId)}`;
    const markerBase = `map-${sfx}.marker`;
    const markerPath = path.join(markerDir, markerBase);

    const wt = makeWorktreeBranch(repo, branch, "real-file.txt", "real worker content\n");
    removeWorktree(repo, wt);
    deleteBranchesReflogAndGc(repo, [branch]);

    fs.writeFileSync(path.join(repo, "decoy.txt"), "decoy content\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m "chore: forged landing" ` +
      `--trailer "Loom-Worker-Branch: ${branch}" ` +
      `--trailer "Loom-Worker-Base: --output=${markerPath}" ` +
      `--trailer "Loom-Worker-PathSet: deadbeef"`, { cwd: repo });
    checkForgedBaseParses("(2)", repo, markerPath);

    __resetMergedCommitMapCacheForTest();
    const board = await getTaskMergedInfo(repo, taskId);
    check("(2) no file lands at (or under) the marker path — same primitive via resolveMergedCommitMapHit",
      writtenMarkerFiles(markerBase).length === 0);
    check("(2) verdict stays null/not-merged (unchanged)", board === null);
  }
} finally {
  // mkdtempManaged's own exit hooks are the real backstop; this just lets a solo run print success/failure
  // without waiting for process exit to confirm cleanup actually happened.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a Loom-Worker-Base trailer shaped like a git option (`--output=<path>`) never reaches " +
    "git as a flag (no file is written, via either reader), and the null/not-merged verdict is unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
