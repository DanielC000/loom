import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5e30c4bd — computeDeployStaleness(): compares this daemon's own build clock against mainline
// HEAD, scoped to ONLY packages/daemon/src + packages/shared/src commits, so an assets/docs/vault-only
// merge never reports stale (the 637558ca cry-wolf precedent). HERMETIC: a real throwaway git repo
// (execSync git, real commits with controlled GIT_COMMITTER_DATE) + real throwaway dist-output fixture
// files, driven entirely through the exported test-seam overrides
// (distEntryOverride/repoRootOverride/sharedDistOverride) — no dependency on this checkout's own real
// dist/git state (EXCEPT section (8), which deliberately probes the real tree — see its own comment).
//
// Card c1072385 — the build is INCREMENTAL (`tsc` only rewrites files whose input changed), so
// dist/index.js's OWN mtime means "when index.ts last changed", not "when this daemon was last built".
// The build clock is now the NEWEST mtime across every file recursively under the dist directory (PLUS
// packages/shared/dist) rather than one file's mtime — sections (6)-(8) below prove this directly.
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
//   (6) c1072385's actual bug class, reproduced deterministically: dist/index.js frozen at an OLD mtime
//       while a DIFFERENT, NESTED file in the same dist tree was rewritten LATER by an incremental build
//       — a commit landing between those two mtimes must read clean, where a single-file (index.js-only)
//       check would have wrongly read it as stale. This is the "always exercisable" version of the real-
//       tree control in (8) — it doesn't depend on this checkout's own current dist state to demonstrate
//       the class of bug.
//   (7) packages/shared/dist is genuinely IN SCOPE (c1072385 DoD 1): a shared/src commit reads stale
//       against a stale shared/dist even though the daemon dist is unchanged, then reads clean once ONLY
//       shared/dist is rebuilt — daemon dist never touched — proving shared/dist is actually scanned,
//       not merely accepted as a parameter.
//   (8) REAL-TREE positive control (c1072385 DoD 2): on THIS checkout's actual built dist/index.js vs.
//       the actual newest mtime under packages/daemon/dist, the two must genuinely differ — a test that
//       only ever compares a fixture to itself cannot detect this bug class (that was the exact blindness
//       that let c1072385 ship). Guarded: loudly SKIPS rather than passing vacuously if this checkout's
//       dist happens to have a uniform mtime (e.g. a from-scratch build where every file lands in one
//       tsc pass) instead of asserting a fixed, possibly-flaky gap.
//
// Card 8ff7ccde — the banner's `distBuiltAt` is an ON-DISK ARTIFACT clock (newest dist mtime); it is NOT
// "the build this running process executes" — a rebuild that lands without a restart advances distBuiltAt
// while the process keeps running whatever it loaded at its OWN start. `processStartedAt` (new, 5th param
// `processStartedAtOverride` is its test seam) + `runningCodeBuiltAt` (= min(distBuiltAt, processStartedAt)
// — the EARLIER of the two is always what the process could possibly be executing) + `distAheadOfProcess`
// (distBuiltAt > processStartedAt — a rebuild happened that this process never picked up, made VISIBLE as
// its own field rather than folded silently into a corrected number) fix this. `stale`/`commitsBehind` are
// now computed against `runningCodeBuiltAt`, not the raw dist clock, so staleness can no longer be
// UNDERSTATED by a rebuild-without-restart:
//   (11) PROCESS-STALE POSITIVE CONTROL — the actual defect, reproduced: dist rebuilt AFTER a relevant
//        commit (so the OLD dist-only algorithm reads clean) while the process started BEFORE that commit
//        and never restarted — must still read stale:true. Deliberately sets build != running (see the
//        DoD's own warning: "a test exercising only build == running passes against the broken code").
//   (11n) CLEAN control, same shape: process started AFTER the last rebuild (the healthy case) — reads
//        exactly like before this card (runningCodeBuiltAt reduces to distBuiltAt, distAheadOfProcess:false).
//
// Card c241d54b — `newestMtimeMs(distDir)` returning null used to be coerced by `?? 0` into epoch, a
// different fact from "very old", when distDir was CONFIRMED to exist moments earlier (a build racing this
// read, not a legitimately-absent dir like packages/shared/dist). That epoch then fed an invalid pre-1970
// date into served-status.mjs's (4-setup) GIT_AUTHOR_DATE probe — the exact observed gate failure.
//   (12a) newestMtimeMs itself, DIRECTLY: a missing dir (the card's own "easy fixture") returns null, not 0
//        or a throw; a populated dir returns a real number (negative control — not an always-null instrument).
//   (12b) INTEGRATION-LEVEL, both directions, on computeDeployStaleness itself: distIndex is a real, plain
//        file (an unmocked statSync confirms it), and fs.readdirSync is patched to throw ENOENT for its
//        specific containing dir only — reproducing "distIndex exists, yet the dist-dir scan returns null"
//        deterministically, without racing an actual build (same monkeypatch technique already used by
//        test/transcript-fallback-cache-coherence.mjs's (C) section). Shows the PRE-FIX arithmetic on these
//        exact inputs collapses to epoch 0 / the byte-identical invalid date, and the POST-FIX result is
//        available:false with no epoch/invalid-date leaking anywhere.
//
// Card c3ce92ea — the WEB signal (webStale/webCommitsBehind), independent of the above:
//   (9) POSITIVE CONTROL, reproducing the exact bug this card fixes: a web-only commit landing after
//       BOTH dists were built must flip webStale:true while leaving stale/commitsBehind COMPLETELY
//       UNCHANGED (stale:false, commitsBehind:0) — proving the fix adds a new signal rather than
//       perturbing the existing one the card says must stay byte-identical.
//   (9b) NEGATIVE CONTROL on the SAME corpus: a daemon-src-only commit must NOT add to webCommitsBehind
//        (it stays at the pre-existing count from (9), not incremented), while it DOES correctly flip
//        stale/commitsBehind — proving the two signals are genuinely decoupled, not just both "true".
//   (9c) CLEAN control: rebuilding ONLY packages/web/dist after the web commit clears webStale without
//        touching the (still-genuinely-stale) daemon signal — the web signal goes both ways too.
//   (10) missing packages/web/dist entirely (never built / API-only deploy) must NOT make the whole
//        result unavailable — degrades to webDistBuiltAt:null with every web/src commit ever counting
//        as unbuilt, same tolerant-of-absence style as packages/shared/dist in section (7).
//
// Run: 1) build (turbo builds shared first), 2) node test/deploy-staleness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// Card 19fbeede: an `available === true` check that fails discards `reason` (the one field explaining
// WHY computeDeployStaleness degraded) unless the label carries it. No-op when `reason` is absent (the
// healthy path, available:true) so a passing run's output stays byte-unchanged.
const reasonSuffix = (result) => result?.reason ? ` — reason: ${JSON.stringify(result.reason)}` : "";

// Card f5421d27: every fixture root is suffixed with process.pid (not just Date.now()) and registered
// here so the outer finally below can sweep ALL of them unconditionally — a thrown error partway
// through (e.g. a git call) used to skip every fixture created after the throw point, since each
// section previously only cleaned up its OWN dirs inline; this array is the single source of truth
// for "what got created" regardless of where execution stops.
const createdDirs = [];
const trackDir = (dir) => { createdDirs.push(dir); return dir; };

const tmpHome = trackDir(path.join(os.tmpdir(), `loom-dpstl-${Date.now()}-${process.pid}`));
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { computeDeployStaleness: computeDeployStalenessRaw, newestMtimeMs: newestMtimeMsRaw } = await import("../dist/deploy-staleness.js");
// Card 8ff7ccde: the new 5th param (processStartedAtOverride) lets a test control the "since when has the
// CURRENTLY RUNNING code been in effect" clock independently of `distBuiltAt`. No section BEFORE (11)
// intends to exercise that axis — left to the real default (derived from this test process's own
// `process.uptime()`), its value would depend on what wall-clock day this test happens to run on relative
// to each section's fixture mtimes, which is exactly the non-hermetic coupling this suite's own header
// promises never to have. Pin it far enough in the future that it can never be the EARLIER of the two
// clocks for any fixture mtime any section below sets, so every section's behavior stays IDENTICAL to
// before this card; only (11)/(11n) call `computeDeployStalenessRaw` directly with an explicit override to
// actually exercise the new axis.
const FAR_FUTURE_PROCESS_START = "2030-01-01T00:00:00Z";
const computeDeployStaleness = (distEntry, repoRoot, sharedDist, webDist, processStartedAtOverride) =>
  computeDeployStalenessRaw(distEntry, repoRoot, sharedDist, webDist, processStartedAtOverride ?? FAR_FUTURE_PROCESS_START);

const repo = trackDir(path.join(os.tmpdir(), `loom-dpstl-repo-${Date.now()}-${process.pid}`));
fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "shared", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "assets", "skills", "demo"), { recursive: true });
const git = (args, dateIso) => execSync(`git ${args}`, {
  cwd: repo,
  env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
});
git("init -q");
git('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-01-01T00:00:00Z");

const distDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-dist-${Date.now()}-${process.pid}`));
fs.mkdirSync(distDir, { recursive: true });
const distEntry = path.join(distDir, "index.js");
const buildDistAt = (iso) => {
  fs.writeFileSync(distEntry, "// fixture built daemon entry\n");
  fs.utimesSync(distEntry, new Date(iso), new Date(iso));
};

try {
  // ===================== (4) unavailable, gracefully =====================
  const noRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-norepo-${Date.now()}-${process.pid}`));
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
  check("(1) a daemon/src commit AFTER the dist build ⇒ stale:true" + reasonSuffix(rStale), rStale.available === true && rStale.stale === true);
  check("(1) commitsBehind counts it", rStale.commitsBehind === 1);
  check("(1) mainlineHeadSha is a real 40-char sha", /^[0-9a-f]{40}$/.test(rStale.mainlineHeadSha ?? ""));
  check("(1) mainlineHeadDate is the real HEAD commit's date (June 2, not the dist build date)", (rStale.mainlineHeadDate ?? "").startsWith("2026-06-02"));
  check("(1) distBuiltAt reflects the fixture dist mtime (June 1)", (rStale.distBuiltAt ?? "").startsWith("2026-06-01"));

  // ===================== (1n) CLEAN control — SAME repo, rebuild dist AFTER the commit =====================
  buildDistAt("2026-06-03T00:00:00Z"); // dist "rebuilt" after the June 2 commit
  const rClean = computeDeployStaleness(distEntry, repo);
  check("(1n) dist rebuilt AFTER the relevant commit ⇒ stale:false (the signal goes BOTH ways)" + reasonSuffix(rClean), rClean.available === true && rClean.stale === false);
  check("(1n) commitsBehind is 0 once rebuilt", rClean.commitsBehind === 0);

  // ===================== (2) path-scoping negative control (the 637558ca cry-wolf precedent) =====================
  buildDistAt("2026-06-03T00:00:00Z"); // keep dist at June 3 (after all commits so far)
  fs.writeFileSync(path.join(repo, "assets", "skills", "demo", "SKILL.md"), "# demo skill\n");
  git("add assets/skills/demo/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): add demo skill"', "2026-06-04T00:00:00Z"); // AFTER the June 3 build
  const rAssetsOnly = computeDeployStaleness(distEntry, repo);
  check("(2) an assets/**-only commit AFTER the build must NOT count as stale" + reasonSuffix(rAssetsOnly), rAssetsOnly.available === true && rAssetsOnly.stale === false && rAssetsOnly.commitsBehind === 0);
  check("(2) mainlineHeadSha still advances to the real HEAD (the assets commit), even though it's excluded from staleness", (rAssetsOnly.mainlineHeadDate ?? "").startsWith("2026-06-04"));

  // ===================== (2b) positive control on the SAME corpus — a shared/src commit DOES count =====================
  fs.writeFileSync(path.join(repo, "packages", "shared", "src", "bar.ts"), "export const bar = 2;\n");
  git("add packages/shared/src/bar.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(shared): add bar"', "2026-06-05T00:00:00Z"); // AFTER the June 3 build
  const rSharedToo = computeDeployStaleness(distEntry, repo);
  check("(2b) a packages/shared/src commit in the SAME repo DOES count (proves (2) wasn't a vacuous corpus)" + reasonSuffix(rSharedToo), rSharedToo.available === true && rSharedToo.stale === true && rSharedToo.commitsBehind === 1);

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

  // ===================== (6) c1072385's actual bug class — reproduced deterministically =====================
  // Own throwaway repo + dist so this doesn't perturb the sequential history/state the sections above rely on.
  const incRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-increpo-${Date.now()}-${process.pid}`));
  fs.mkdirSync(path.join(incRepo, "packages", "daemon", "src"), { recursive: true });
  const gitInc = (args, dateIso) => execSync(`git ${args}`, {
    cwd: incRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitInc("init -q");
  gitInc('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-07-01T00:00:00Z");

  const incDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-incdist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(incDistDir, { recursive: true });
  const incDistEntry = path.join(incDistDir, "index.js");
  fs.writeFileSync(incDistEntry, "// fixture: dist/index.js — NOT rewritten by the incremental build below\n");
  fs.utimesSync(incDistEntry, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z")); // frozen — "the previous deploy"

  fs.writeFileSync(path.join(incRepo, "packages", "daemon", "src", "incremental.ts"), "export const inc = 1;\n");
  gitInc("add packages/daemon/src/incremental.ts");
  gitInc('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add incremental"', "2026-07-02T00:00:00Z"); // AFTER index.js's frozen mtime

  const nestedDir = path.join(incDistDir, "sessions"); // mirrors the real dist/sessions/*.js the incident actually measured
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedFile = path.join(nestedDir, "manager-prompt.js");
  fs.writeFileSync(nestedFile, "// fixture: a DIFFERENT, NESTED file the incremental build DID rewrite\n");
  fs.utimesSync(nestedFile, new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z")); // AFTER the commit — "this deploy"

  const rIncremental = computeDeployStaleness(incDistEntry, incRepo);
  check("(6) a commit landing BETWEEN index.js's stale mtime and a nested dist file's real rebuild mtime ⇒ stale:false — a single-file (index.js-only) check would have wrongly read stale:true here" + reasonSuffix(rIncremental), rIncremental.available === true && rIncremental.stale === false && rIncremental.commitsBehind === 0);
  check("(6) distBuiltAt reflects the NEWEST file in the tree (the nested file, July 3), not index.js's own frozen July 1 mtime", (rIncremental.distBuiltAt ?? "").startsWith("2026-07-03"));

  try { fs.rmSync(incRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(incDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (7) packages/shared/dist is genuinely IN SCOPE (c1072385 DoD 1) =====================
  const shRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-shrepo-${Date.now()}-${process.pid}`));
  fs.mkdirSync(path.join(shRepo, "packages", "shared", "src"), { recursive: true });
  const gitSh = (args, dateIso) => execSync(`git ${args}`, {
    cwd: shRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitSh("init -q");
  gitSh('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-08-01T00:00:00Z");

  const shDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-shdaemondist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(shDaemonDistDir, { recursive: true });
  const shDaemonDistEntry = path.join(shDaemonDistDir, "index.js");
  const buildShDaemonDistAt = (iso) => {
    fs.writeFileSync(shDaemonDistEntry, "// fixture daemon dist\n");
    fs.utimesSync(shDaemonDistEntry, new Date(iso), new Date(iso));
  };
  const shSharedDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-shshareddist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(shSharedDistDir, { recursive: true });
  const shSharedDistEntry = path.join(shSharedDistDir, "types.js");
  const buildShSharedDistAt = (iso) => {
    fs.writeFileSync(shSharedDistEntry, "// fixture shared dist\n");
    fs.utimesSync(shSharedDistEntry, new Date(iso), new Date(iso));
  };

  buildShDaemonDistAt("2026-08-01T12:00:00Z"); // daemon dist built once, NEVER rebuilt again in this section
  buildShSharedDistAt("2026-08-01T12:00:00Z"); // shared dist starts level with it

  fs.writeFileSync(path.join(shRepo, "packages", "shared", "src", "quux.ts"), "export const quux = 1;\n");
  gitSh("add packages/shared/src/quux.ts");
  gitSh('-c user.email=t@loom -c user.name=t commit -q -m "feat(shared): add quux"', "2026-08-02T00:00:00Z"); // AFTER both dists

  const rBeforeSharedRebuild = computeDeployStaleness(shDaemonDistEntry, shRepo, shSharedDistDir);
  check("(7-setup) a shared/src commit after BOTH dists were built ⇒ stale:true (sanity check before proving shared/dist is what clears it)" + reasonSuffix(rBeforeSharedRebuild), rBeforeSharedRebuild.available === true && rBeforeSharedRebuild.stale === true && rBeforeSharedRebuild.commitsBehind === 1);

  buildShSharedDistAt("2026-08-03T00:00:00Z"); // ONLY shared/dist rebuilt after the commit — daemon dist left untouched at 08-01T12:00
  const rAfterSharedRebuild = computeDeployStaleness(shDaemonDistEntry, shRepo, shSharedDistDir);
  check("(7) shared/dist alone rebuilt AFTER the shared/src commit ⇒ stale:false, even though daemon dist/index.js is UNCHANGED — proves packages/shared/dist is genuinely scanned, not just accepted as an unused parameter" + reasonSuffix(rAfterSharedRebuild), rAfterSharedRebuild.available === true && rAfterSharedRebuild.stale === false && rAfterSharedRebuild.commitsBehind === 0);
  check("(7) distBuiltAt reflects the newer shared/dist mtime (Aug 3), not the older, untouched daemon dist/index.js (Aug 1)", (rAfterSharedRebuild.distBuiltAt ?? "").startsWith("2026-08-03"));

  try { fs.rmSync(shRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(shDaemonDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(shSharedDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (8) REAL-TREE positive control (c1072385 DoD 2) =====================
  // Sections (6)/(7) prove the algorithm on a controlled fixture; this proves the BUG CLASS is real on
  // THIS checkout's own actual built output, not merely constructible in a fixture. A fixture whose mtime
  // the test itself sets can never demonstrate "the real build didn't rewrite this file" — that was
  // exactly test/deploy-staleness.mjs's original blind spot (per the module doc + this card).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const realDistDir = path.join(__dirname, "..", "dist");
  const realIndexJs = path.join(realDistDir, "index.js");
  const realIndexJsMtimeMs = fs.statSync(realIndexJs).mtime.getTime();
  let realNewestMtimeMs = realIndexJsMtimeMs;
  const stack = [realDistDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > realNewestMtimeMs) realNewestMtimeMs = mt;
      }
    }
  }
  if (realNewestMtimeMs === realIndexJsMtimeMs) {
    console.log("SKIP  (8) this checkout's dist/index.js mtime coincides with the newest mtime across the whole dist tree (e.g. a from-scratch build in one tsc pass) — the real-tree positive control for the incremental-build bug class is inconclusive on this run, not exercised. Section (6) above exercises the same class deterministically regardless.");
  } else {
    check("(8) on THIS checkout, dist/index.js's own mtime genuinely DIFFERS from the newest mtime across packages/daemon/dist — proves the incremental-build bug class is real here, not just fixture-constructible", true);
  }

  // ===================== (9) WEB SIGNAL — POSITIVE CONTROL (card c3ce92ea) =====================
  // Reproduces the exact bug this card fixes: a web-only commit after BOTH dists were built must flip
  // webStale WITHOUT moving the daemon-restart signal at all.
  const webRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-webrepo-${Date.now()}-${process.pid}`));
  fs.mkdirSync(path.join(webRepo, "packages", "daemon", "src"), { recursive: true });
  fs.mkdirSync(path.join(webRepo, "packages", "web", "src"), { recursive: true });
  const gitWeb = (args, dateIso) => execSync(`git ${args}`, {
    cwd: webRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitWeb("init -q");
  gitWeb('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-09-01T00:00:00Z");

  const webDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-webdaemondist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(webDaemonDistDir, { recursive: true });
  const webDaemonDistEntry = path.join(webDaemonDistDir, "index.js");
  const buildWebDaemonDistAt = (iso) => {
    fs.writeFileSync(webDaemonDistEntry, "// fixture daemon dist\n");
    fs.utimesSync(webDaemonDistEntry, new Date(iso), new Date(iso));
  };
  const webWebDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-webwebdist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(webWebDistDir, { recursive: true });
  const webWebDistEntry = path.join(webWebDistDir, "index.html");
  const buildWebWebDistAt = (iso) => {
    fs.writeFileSync(webWebDistEntry, "<!-- fixture web dist -->\n");
    fs.utimesSync(webWebDistEntry, new Date(iso), new Date(iso));
  };

  buildWebDaemonDistAt("2026-09-01T12:00:00Z");
  buildWebWebDistAt("2026-09-01T12:00:00Z");

  fs.writeFileSync(path.join(webRepo, "packages", "web", "src", "App.tsx"), "export const App = () => null;\n");
  gitWeb("add packages/web/src/App.tsx");
  gitWeb('-c user.email=t@loom -c user.name=t commit -q -m "feat(web): tweak App"', "2026-09-02T00:00:00Z"); // AFTER both dists

  const rWebOnly = computeDeployStaleness(webDaemonDistEntry, webRepo, undefined, webWebDistDir);
  check("(9) a web-only commit after both dists were built ⇒ webStale:true, webCommitsBehind:1 (POSITIVE CONTROL — the exact bug this card fixes)" + reasonSuffix(rWebOnly),
    rWebOnly.available === true && rWebOnly.webStale === true && rWebOnly.webCommitsBehind === 1);
  check("(9) the SAME web-only commit leaves the daemon-restart signal COMPLETELY UNCHANGED: stale:false, commitsBehind:0 (a web-only merge must never advise a daemon_restart)",
    rWebOnly.stale === false && rWebOnly.commitsBehind === 0);
  check("(9) webDistBuiltAt reflects the fixture web dist mtime (Sept 1)", (rWebOnly.webDistBuiltAt ?? "").startsWith("2026-09-01"));

  // ===================== (9b) WEB SIGNAL — NEGATIVE CONTROL, same corpus: daemon-src-only commit =====================
  fs.writeFileSync(path.join(webRepo, "packages", "daemon", "src", "foo.ts"), "export const foo = 1;\n");
  gitWeb("add packages/daemon/src/foo.ts");
  gitWeb('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add foo"', "2026-09-03T00:00:00Z"); // AFTER both dists
  const rDaemonOnly = computeDeployStaleness(webDaemonDistEntry, webRepo, undefined, webWebDistDir);
  check("(9b) a daemon-src-only commit on the SAME corpus does NOT add to the web signal — webCommitsBehind stays exactly 1 (the Sept 2 web commit from (9), not 2)",
    rDaemonOnly.webCommitsBehind === 1);
  check("(9b) the SAME daemon-src commit correctly flips the daemon-restart signal: stale:true, commitsBehind:1",
    rDaemonOnly.stale === true && rDaemonOnly.commitsBehind === 1);

  // ===================== (9c) WEB SIGNAL — CLEAN control: rebuild web dist AFTER the web commit =====================
  buildWebWebDistAt("2026-09-04T00:00:00Z"); // web dist rebuilt after the Sept 2 web commit; daemon dist left untouched
  const rWebRebuilt = computeDeployStaleness(webDaemonDistEntry, webRepo, undefined, webWebDistDir);
  check("(9c) web dist rebuilt AFTER the web commit ⇒ webStale:false (the web signal goes BOTH ways)" + reasonSuffix(rWebRebuilt),
    rWebRebuilt.available === true && rWebRebuilt.webStale === false && rWebRebuilt.webCommitsBehind === 0);
  check("(9c) the daemon-restart signal is UNCHANGED by a pure web-dist rebuild — still stale:true (the Sept 3 daemon commit is still unbuilt)",
    rWebRebuilt.stale === true && rWebRebuilt.commitsBehind === 1);

  try { fs.rmSync(webRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(webDaemonDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(webWebDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (10) WEB SIGNAL — missing web dist entirely (never built / API-only deploy) =====================
  const noWebRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-nowebrepo-${Date.now()}-${process.pid}`));
  fs.mkdirSync(path.join(noWebRepo, "packages", "web", "src"), { recursive: true });
  const gitNoWeb = (args, dateIso) => execSync(`git ${args}`, {
    cwd: noWebRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitNoWeb("init -q");
  gitNoWeb('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-10-01T00:00:00Z");
  fs.writeFileSync(path.join(noWebRepo, "packages", "web", "src", "App.tsx"), "export const App = () => null;\n");
  gitNoWeb("add packages/web/src/App.tsx");
  gitNoWeb('-c user.email=t@loom -c user.name=t commit -q -m "feat(web): add App"', "2026-10-02T00:00:00Z");

  const noWebDistDir = path.join(os.tmpdir(), `loom-dpstl-missingwebdist-${Date.now()}-${process.pid}`); // never created
  const noWebDaemonDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-nowebdaemondist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(noWebDaemonDistDir, { recursive: true });
  const noWebDaemonDistEntry = path.join(noWebDaemonDistDir, "index.js");
  fs.writeFileSync(noWebDaemonDistEntry, "// fixture daemon dist\n");
  fs.utimesSync(noWebDaemonDistEntry, new Date("2026-10-03T00:00:00Z"), new Date("2026-10-03T00:00:00Z"));

  const rNoWebDist = computeDeployStaleness(noWebDaemonDistEntry, noWebRepo, undefined, noWebDistDir);
  check("(10) a missing packages/web/dist does NOT make the whole signal unavailable" + reasonSuffix(rNoWebDist), rNoWebDist.available === true);
  check("(10) a missing packages/web/dist ⇒ webDistBuiltAt:null (never built, not epoch-stamped as a fake date)", rNoWebDist.webDistBuiltAt === null);
  check("(10) a missing packages/web/dist ⇒ every web/src commit ever counts as unbuilt (webCommitsBehind:1, webStale:true)",
    rNoWebDist.webCommitsBehind === 1 && rNoWebDist.webStale === true);

  try { fs.rmSync(noWebRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(noWebDaemonDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (11) PROCESS-STALE POSITIVE CONTROL (card 8ff7ccde) =====================
  // The actual defect: dist rebuilt AFTER a relevant commit (so a dist-only clock reads CLEAN) while the
  // process itself started BEFORE that commit and never restarted — so it never loaded the rebuild. Must
  // still read stale:true. Deliberately build (T3) != running (T1) — the DoD's own warning is that a test
  // exercising only build == running passes against the broken code.
  const procRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-procrepo-${Date.now()}-${process.pid}`));
  fs.mkdirSync(path.join(procRepo, "packages", "daemon", "src"), { recursive: true });
  const gitProc = (args, dateIso) => execSync(`git ${args}`, {
    cwd: procRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitProc("init -q");
  gitProc('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2026-11-01T00:00:00Z");

  const procDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-procdist-${Date.now()}-${process.pid}`));
  fs.mkdirSync(procDistDir, { recursive: true });
  const procDistEntry = path.join(procDistDir, "index.js");
  const buildProcDistAt = (iso) => {
    fs.writeFileSync(procDistEntry, "// fixture proc dist\n");
    fs.utimesSync(procDistEntry, new Date(iso), new Date(iso));
  };

  const T1_PROCESS_STARTED = "2026-11-01T01:00:00Z"; // the process's own start — never restarted since
  buildProcDistAt(T1_PROCESS_STARTED); // dist starts level with the process's own start

  fs.writeFileSync(path.join(procRepo, "packages", "daemon", "src", "proc.ts"), "export const proc = 1;\n");
  gitProc("add packages/daemon/src/proc.ts");
  gitProc('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add proc"', "2026-11-02T00:00:00Z"); // AFTER T1

  buildProcDistAt("2026-11-03T00:00:00Z"); // dist REBUILT after the commit — someone rebuilt, nobody restarted

  const rProcStale = computeDeployStalenessRaw(procDistEntry, procRepo, undefined, undefined, T1_PROCESS_STARTED);
  check("(11) distBuiltAt reflects the on-disk REBUILD (Nov 3), not the process's own start", (rProcStale.distBuiltAt ?? "").startsWith("2026-11-03"));
  check("(11) processStartedAt echoes the override (Nov 1 01:00) — the process's own, never-restarted, start", (rProcStale.processStartedAt ?? "").startsWith("2026-11-01T01:00"));
  check("(11) runningCodeBuiltAt is the EARLIER of the two (the process's own start, not the newer on-disk rebuild)", (rProcStale.runningCodeBuiltAt ?? "").startsWith("2026-11-01T01:00"));
  check("(11) distAheadOfProcess:true — the on-disk artifact moved past what this process ever loaded", rProcStale.distAheadOfProcess === true);
  check("(11) THE FIX: stale:true, commitsBehind:1 — the Nov 2 commit is correctly still-unbuilt-by-this-PROCESS, even though the on-disk dist (Nov 3) is newer than it (the pre-fix, dist-only algorithm would have read this clean)" + reasonSuffix(rProcStale),
    rProcStale.available === true && rProcStale.stale === true && rProcStale.commitsBehind === 1);

  // ===================== (11n) CLEAN control, same shape: process started AFTER the rebuild =====================
  const T4_PROCESS_STARTED_AFTER_REBUILD = "2026-11-04T00:00:00Z"; // AFTER the Nov 3 rebuild — the healthy case
  const rProcClean = computeDeployStalenessRaw(procDistEntry, procRepo, undefined, undefined, T4_PROCESS_STARTED_AFTER_REBUILD);
  check("(11n) a process started AFTER the last rebuild ⇒ runningCodeBuiltAt reduces to distBuiltAt (Nov 3)", (rProcClean.runningCodeBuiltAt ?? "").startsWith("2026-11-03"));
  check("(11n) distAheadOfProcess:false — the process's own start is not behind the artifact (the healthy/normal case)", rProcClean.distAheadOfProcess === false);
  check("(11n) stale:false, commitsBehind:0 — the signal reverts to normal once the process is caught up (goes BOTH ways)" + reasonSuffix(rProcClean),
    rProcClean.available === true && rProcClean.stale === false && rProcClean.commitsBehind === 0);

  try { fs.rmSync(procRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(procDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (12a) newestMtimeMs DIRECTLY: null-for-missing-dir + non-null negative control ====
  const missingDir = path.join(os.tmpdir(), `loom-dpstl-missing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); // never created
  check("(12a) newestMtimeMs on a directory that doesn't exist ⇒ null (the card's own 'easy fixture'), not 0 and not a throw", newestMtimeMsRaw(missingDir) === null);
  const populatedDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-populated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(populatedDir, { recursive: true });
  fs.writeFileSync(path.join(populatedDir, "f.txt"), "x");
  check("(12a-negative-control) newestMtimeMs on a directory WITH a file ⇒ a real number, not null (the instrument isn't always-null)", typeof newestMtimeMsRaw(populatedDir) === "number");

  // ===================== (12b) THE ACTUAL DEFECT, both directions (card c241d54b) =====================
  // distIndex is a real, plain file (a normal, unmocked fs.statSync confirms it exists), then
  // fs.readdirSync is patched so its call against THIS SPECIFIC dist dir throws ENOENT — reproducing "the
  // tree vanished in the window between the existence check and the scan" deterministically, without
  // racing an actual build. Same technique as test/transcript-fallback-cache-coherence.mjs's (C) section
  // (a precedent for monkeypatching fs.readdirSync in this suite); scoped to the exact dir path and
  // delegating to the real implementation for everything else (incl. sharedDistDir's own scan), and
  // restored in a finally so no other section is affected.
  const raceDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-racedir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(raceDir, { recursive: true });
  const raceDistIndex = path.join(raceDir, "index.js");
  fs.writeFileSync(raceDistIndex, "// fixture dist entry, confirmed to exist by a plain, unmocked statSync\n");
  check("(12b-setup) the fixture distIndex passes a plain, unmocked existence check (mirrors 'confirmed to exist a moment ago')", fs.statSync(raceDistIndex).isFile());

  const resolvedRaceDir = path.resolve(raceDir);
  const originalReaddirSync = fs.readdirSync;
  let racePatchFired = false;
  fs.readdirSync = function patchedReaddirSync(dir, ...rest) {
    if (path.resolve(String(dir)) === resolvedRaceDir) {
      racePatchFired = true;
      const err = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
      err.code = "ENOENT";
      throw err;
    }
    return originalReaddirSync.call(fs, dir, ...rest);
  };

  let rDistUnreadable;
  try {
    check("(12b-setup) newestMtimeMs(distDir) returns null once the scan is forced to throw, even though distIndex demonstrably exists", newestMtimeMsRaw(raceDir) === null);

    // (12-before) what the PRE-FIX arithmetic (`Math.max(newestMtimeMs(distDir) ?? 0, ...)`) would have
    // produced from these exact same inputs — reproduced directly, without reverting the fix.
    const preFixBuildMaxMs = Math.max(newestMtimeMsRaw(raceDir) ?? 0, 0);
    check("(12-before) PRE-FIX arithmetic on these inputs collapses to epoch 0", preFixBuildMaxMs === 0);
    check("(12-before) that epoch 0, offset by -60s exactly as served-status.mjs's (4-setup) amplifier does, renders as the BYTE-IDENTICAL invalid date git rejected in the observed failure", new Date(preFixBuildMaxMs - 60_000).toISOString() === "1969-12-31T23:59:00.000Z");
    console.log(`     (12-before, for reference) pre-fix distBuiltAt would have been: ${new Date(preFixBuildMaxMs).toISOString()}`);

    // (12-after) the actual fixed function, called end-to-end on the same fixture.
    rDistUnreadable = computeDeployStalenessRaw(raceDistIndex, repo);
  } finally {
    fs.readdirSync = originalReaddirSync; // never leave the global fs module patched
  }
  check("(12b self-check) the readdirSync patch actually fired (positive control — a never-fired patch proves nothing)", racePatchFired === true);
  check("(12-after) THE FIX: distIndex exists but its dist dir is unreadable ⇒ available:false, never a false epoch-0 answer" + reasonSuffix(rDistUnreadable), rDistUnreadable.available === false && typeof rDistUnreadable.reason === "string");
  check("(12-after) the unavailable reason names the dist directory specifically, not a generic message", /dist directory/.test(rDistUnreadable.reason ?? ""));
  check("(12-after) unavailable ⇒ stale:false, commitsBehind:0 (never a false-positive OR false-negative claim)", rDistUnreadable.stale === false && rDistUnreadable.commitsBehind === 0);
  check("(12-after) unavailable ⇒ distBuiltAt/runningCodeBuiltAt are null, never an epoch/invalid-date string", rDistUnreadable.distBuiltAt === null && rDistUnreadable.runningCodeBuiltAt === null);
} finally {
  // Sweeps EVERY fixture root registered via trackDir() above, not just this section's own —
  // the per-section rmSync calls above only run on the happy path; a thrown error anywhere in the
  // try block (e.g. a git call) used to skip every not-yet-reached inline cleanup, leaking those
  // dirs. force:true makes re-removing an already-cleaned dir a no-op, so this is safe alongside them.
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeDeployStaleness reads STALE and CLEAN correctly (both directions), excludes assets/docs-only commits (path-scoped, proven against a corpus that could have produced a false negative), counts multiple relevant commits, degrades gracefully (never throws) when unavailable, is derived fresh on every call with no cross-call caching, derives its build clock from the NEWEST mtime across the whole dist tree (daemon + shared) rather than one file (c1072385), that class of bug is demonstrated both on a controlled fixture and (when this checkout's own dist isn't uniformly-timed) on the real tree, (card c3ce92ea) the independent webStale/webCommitsBehind signal correctly flags a web-only commit as needing a rebuild WITHOUT ever perturbing the daemon-restart signal, in both directions, degrades gracefully when packages/web/dist is entirely missing, and (card c241d54b) a dist dir that becomes unreadable after its own entry file was confirmed to exist ⇒ available:false, never a coerced epoch-0/invalid-date answer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
