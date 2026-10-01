// Regression guard for card 5c3d0518's sibling fix: scripts/sync-claude-skills.mjs's
// `.loom-managed-skills.json` (dev-only, gitignored, but still disk-resident) used to trust its entries
// straight into `fs.rmSync(path.join(destDir, prevManaged), { recursive: true, force: true })` with no
// validation — the same defect card 97e6a1c6 fixed for the runtime per-session manifest. The fix reuses
// that fix's own `isSafeManifestEntry` predicate (exported from packages/daemon/src/skills/inject.ts)
// rather than re-deriving a second copy of the shape here.
// Runs the REAL script as a child process (it executes top-level, not via an exported function), pointed
// at a throwaway repoRoot via LOOM_SYNC_SKILLS_REPO_ROOT so it never touches this checkout's own
// .claude/skills. Needs packages/daemon/dist/skills/inject.js already built.
// Run after build: node test/sync-claude-skills-manifest-validation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const repoScript = path.resolve(here, "..", "..", "..", "scripts", "sync-claude-skills.mjs");
check("(setup) the real sync script exists at the resolved path", fs.existsSync(repoScript));

const root = path.join(os.tmpdir(), `loom-sync-skills-manifest-validation-${Date.now()}-${process.pid}`);
const fakeRepoRoot = path.join(root, "fake-repo");
const srcDir = path.join(fakeRepoRoot, "packages", "daemon", "assets", "skills");
const destDir = path.join(fakeRepoRoot, ".claude", "skills");

try {
  // One canonical skill, so the script has real work to do and doesn't early-exit.
  fs.mkdirSync(path.join(srcDir, "loom-canon"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "loom-canon", "SKILL.md"), "---\nname: loom-canon\ndescription: x\n---\nbody");

  // A sibling of fakeRepoRoot — the escape target. path.join(destDir, "../../../victim") climbs
  // destDir -> .claude/skills -> .claude -> fakeRepoRoot -> fakeRepoRoot's PARENT (= root), landing on
  // `root/victim`, exactly mirroring skills-inject-manifest-validation.mjs's repoA/victim shape.
  fs.mkdirSync(destDir, { recursive: true });
  const victim = path.join(root, "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "marker.txt"), "do-not-delete");

  // A legitimate deprecated-cleanup entry too, for contrast: a REAL prior-managed dir no longer canonical
  // must still be removed — the fix must drop only the UNSAFE entry, not disable cleanup altogether.
  fs.mkdirSync(path.join(destDir, "loom-deprecated"), { recursive: true });
  fs.writeFileSync(path.join(destDir, "loom-deprecated", "SKILL.md"), "stale");

  fs.writeFileSync(
    path.join(destDir, ".loom-managed-skills.json"),
    JSON.stringify(["../../../victim", "loom-deprecated"]),
  );

  const res = spawnSync(process.execPath, [repoScript], {
    env: { ...process.env, LOOM_SYNC_SKILLS_REPO_ROOT: fakeRepoRoot },
    encoding: "utf8",
  });

  check("(1) the script exits cleanly", res.status === 0);
  check("(1) the sibling victim/ dir SURVIVES (escape entry dropped, not rmSync'd)", fs.existsSync(path.join(victim, "marker.txt")));
  check("(1) the drop is logged loudly", /dropped 1 invalid managed-manifest entr/.test(res.stdout));
  check("(1) the dropped entry's own text is named in the log", res.stdout.includes("../../../victim"));
  check("(2) CONTROL: the legitimate deprecated entry is still cleaned up", !fs.existsSync(path.join(destDir, "loom-deprecated")));
  check("(2) CONTROL: the canonical skill was still delivered", fs.existsSync(path.join(destDir, "loom-canon", "SKILL.md")));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sync-claude-skills.mjs rejects a path-escaping managed-manifest entry before pruning."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
