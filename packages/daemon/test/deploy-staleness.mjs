import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5e30c4bd — computeDeployStaleness(): compares this daemon's own built entry (dist/index.js mtime)
// against mainline HEAD, scoped to ONLY packages/daemon/src + packages/shared/src commits, so an
// assets/docs/vault-only merge never reports stale (the 637558ca cry-wolf precedent). HERMETIC:
// a real throwaway git repo (execSync git, real commits with controlled GIT_COMMITTER_DATE) + a real
// throwaway "dist/index.js" fixture file, driven entirely through the exported test-seam overrides
// (distEntryOverride/repoRootOverride) — no dependency on this checkout's own real dist/git state.
//
// Proves the DoD:
//   (1) STALE positive control: a dist built BEFORE a packages/daemon/src commit ⇒ stale:true,
//       commitsBehind counts it, mainlineHeadSha/Date reflect the real unfiltered HEAD.
//   (1n) CLEAN control, same repo: rebuild dist AFTER that commit ⇒ stale:false, commitsBehind:0 —
//        proves the signal actually GOES BOTH WAYS (a check that never reads clean is decoration).
//   (2) path-scoping negative control: a commit AFTER the dist build that touches ONLY an excluded path
//       (assets/skills/**, a docs-only file) must NOT count — proves DoD #2's cry-wolf exclusion.
//       (2b) positive control on the SAME corpus: a packages/shared/src commit in the SAME repo, at the
//            same point in history, DOES count — so the exclusion is proven against a corpus that could
//            actually produce a "stale" verdict, not a vacuously-empty one.
//   (3) multiple relevant commits after the build ⇒ commitsBehind counts ALL of them, not just one.
//   (4) unavailable, gracefully, never throws: no .git at repoRootOverride; dist entry missing.
//   (5) two independent calls after the SAME mutation return the SAME fresh answer — proves it's derived
//       at call time, not cached/memoized across calls (DoD #4).
//
// Run: 1) build (turbo builds shared first), 2) node test/deploy-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-dpstl-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { computeDeployStaleness } = await import("../dist/deploy-staleness.js");

const repo = path.join(os.tmpdir(), `loom-dpstl-repo-${Date.now()}`);
fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "shared", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "assets", "skills", "demo"), { recursive: true });
const git = (args, dateIso) => execSync(`git ${args}`, {
  cwd: repo,
  env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
});
git("init -q");
git('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-01-01T00:00:00Z");

const distDir = path.join(os.tmpdir(), `loom-dpstl-dist-${Date.now()}`);
fs.mkdirSync(distDir, { recursive: true });
const distEntry = path.join(distDir, "index.js");
const buildDistAt = (iso) => {
  fs.writeFileSync(distEntry, "// fixture built daemon entry\n");
  fs.utimesSync(distEntry, new Date(iso), new Date(iso));
};

try {
  // ===================== (4) unavailable, gracefully =====================
  const noRepo = path.join(os.tmpdir(), `loom-dpstl-norepo-${Date.now()}`);
  fs.mkdirSync(noRepo, { recursive: true });
  buildDistAt("2026-06-01T00:00:00Z");
  const rNoRepo = computeDeployStaleness(distEntry, noRepo);
  check("(4) no .git at repoRoot ⇒ available:false, never throws", rNoRepo.available === false && typeof rNoRepo.reason === "string");
  check("(4) unavailable ⇒ stale:false (never a false-positive claim)", rNoRepo.stale === false);
  fs.rmSync(noRepo, { recursive: true, force: true });

  const rNoDist = computeDeployStaleness(path.join(distDir, "does-not-exist.js"), repo);
  check("(4) missing dist entry ⇒ available:false, never throws", rNoDist.available === false && typeof rNoDist.reason === "string");

  // ===================== (1) STALE positive control =====================
  buildDistAt("2026-06-01T00:00:00Z"); // dist "built" June 1
  fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "foo.ts"), "export const foo = 1;\n");
  git("add packages/daemon/src/foo.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add foo"', "2026-06-02T00:00:00Z"); // AFTER the build

  const rStale = computeDeployStaleness(distEntry, repo);
  check("(1) a daemon/src commit AFTER the dist build ⇒ stale:true", rStale.available === true && rStale.stale === true);
  check("(1) commitsBehind counts it", rStale.commitsBehind === 1);
  check("(1) mainlineHeadSha is a real 40-char sha", /^[0-9a-f]{40}$/.test(rStale.mainlineHeadSha ?? ""));
  check("(1) mainlineHeadDate is the real HEAD commit's date (June 2, not the dist build date)", (rStale.mainlineHeadDate ?? "").startsWith("2026-06-02"));
  check("(1) distBuiltAt reflects the fixture dist mtime (June 1)", (rStale.distBuiltAt ?? "").startsWith("2026-06-01"));

  // ===================== (1n) CLEAN control — SAME repo, rebuild dist AFTER the commit =====================
  buildDistAt("2026-06-03T00:00:00Z"); // dist "rebuilt" after the June 2 commit
  const rClean = computeDeployStaleness(distEntry, repo);
  check("(1n) dist rebuilt AFTER the relevant commit ⇒ stale:false (the signal goes BOTH ways)", rClean.available === true && rClean.stale === false);
  check("(1n) commitsBehind is 0 once rebuilt", rClean.commitsBehind === 0);

  // ===================== (2) path-scoping negative control (the 637558ca cry-wolf precedent) =====================
  buildDistAt("2026-06-03T00:00:00Z"); // keep dist at June 3 (after all commits so far)
  fs.writeFileSync(path.join(repo, "assets", "skills", "demo", "SKILL.md"), "# demo skill\n");
  git("add assets/skills/demo/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): add demo skill"', "2026-06-04T00:00:00Z"); // AFTER the June 3 build
  const rAssetsOnly = computeDeployStaleness(distEntry, repo);
  check("(2) an assets/**-only commit AFTER the build must NOT count as stale", rAssetsOnly.available === true && rAssetsOnly.stale === false && rAssetsOnly.commitsBehind === 0);
  check("(2) mainlineHeadSha still advances to the real HEAD (the assets commit), even though it's excluded from staleness", (rAssetsOnly.mainlineHeadDate ?? "").startsWith("2026-06-04"));

  // ===================== (2b) positive control on the SAME corpus — a shared/src commit DOES count =====================
  fs.writeFileSync(path.join(repo, "packages", "shared", "src", "bar.ts"), "export const bar = 2;\n");
  git("add packages/shared/src/bar.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(shared): add bar"', "2026-06-05T00:00:00Z"); // AFTER the June 3 build
  const rSharedToo = computeDeployStaleness(distEntry, repo);
  check("(2b) a packages/shared/src commit in the SAME repo DOES count (proves (2) wasn't a vacuous corpus)", rSharedToo.available === true && rSharedToo.stale === true && rSharedToo.commitsBehind === 1);

  // ===================== (3) multiple relevant commits after the build ⇒ all counted =====================
  fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "baz.ts"), "export const baz = 3;\n");
  git("add packages/daemon/src/baz.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add baz"', "2026-06-06T00:00:00Z"); // AFTER the June 3 build
  const rMulti = computeDeployStaleness(distEntry, repo);
  check("(3) two relevant commits after the build ⇒ commitsBehind:2 (shared bar + daemon baz — assets commit still excluded)", rMulti.commitsBehind === 2);

  // ===================== (5) fresh on every call — no caching across calls (DoD #4) =====================
  const rFirst = computeDeployStaleness(distEntry, repo);
  buildDistAt("2026-06-07T00:00:00Z"); // rebuild AFTER everything, no code change in between
  const rSecond = computeDeployStaleness(distEntry, repo);
  check("(5) a call before a rebuild reads stale", rFirst.stale === true);
  check("(5) the VERY NEXT call after the rebuild reads clean — proves no stale in-process cache", rSecond.stale === false && rSecond.commitsBehind === 0);
} finally {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(distDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeDeployStaleness reads STALE and CLEAN correctly (both directions), excludes assets/docs-only commits (path-scoped, proven against a corpus that could have produced a false negative), counts multiple relevant commits, degrades gracefully (never throws) when unavailable, and is derived fresh on every call with no cross-call caching."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
