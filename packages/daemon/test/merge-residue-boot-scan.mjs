import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 9e77050f — the boot-time companion to the merge-time refusal in merge-staged-residue-refuses.mjs.
// `scanCanonicalReposForMergeResidue` is READ-ONLY and best-effort: it shrinks the detection window for
// canonical-index residue from "next merge attempt" to "next daemon boot", but never mutates or blocks —
// same reasoning as the merge-time check (residue is indistinguishable from a human's own WIP, so this only
// reports, never resets). Covers: a clean repo reports nothing; a dirty (staged) repo is reported with its
// status; a path that isn't a real git repo is silently skipped, never thrown.
// Run: 1) build daemon (pnpm build), 2) node test/merge-residue-boot-scan.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { scanCanonicalReposForMergeResidue } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDirs = [];

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-mrbs-repo-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mrbs@loom && git config user.name mrbs && git add -A && git -c user.email=mrbs@loom -c user.name=mrbs commit -q -m init --allow-empty`, { cwd: repo });
  return repo;
}

try {
  const cleanRepo = makeRepo("clean");
  const dirtyRepo = makeRepo("dirty");
  fs.writeFileSync(path.join(dirtyRepo, "wip.txt"), "staged wip\n");
  execSync("git add -A", { cwd: dirtyRepo });
  const notARepo = path.join(os.tmpdir(), `loom-mrbs-notrepo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(notARepo, { recursive: true });
  tmpDirs.push(notARepo);

  const result = await scanCanonicalReposForMergeResidue([cleanRepo, dirtyRepo, notARepo]);

  check("clean repo is NOT reported", !result.some((r) => r.repoPath === cleanRepo));
  const dirtyEntry = result.find((r) => r.repoPath === dirtyRepo);
  check("dirty (staged) repo IS reported", !!dirtyEntry);
  check("reported status names the staged file", !!dirtyEntry && dirtyEntry.status.includes("wip.txt"));
  check("a non-repo path is silently skipped, not thrown/reported", !result.some((r) => r.repoPath === notARepo));
  check("scan never mutates: dirty repo's index is UNCHANGED after the scan", execSync("git diff --cached --name-only", { cwd: dirtyRepo }).toString().trim() === "wip.txt");
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — boot-time residue scan reports dirty canonical repos and never mutates anything."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
