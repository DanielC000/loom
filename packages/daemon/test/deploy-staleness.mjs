import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5e30c4bd — computeDeployStaleness(): compares this daemon's own build clock against mainline
// HEAD, scoped to ONLY packages/daemon/src + packages/shared/src commits, so an assets/docs/vault-only
// merge never reports stale (the 637558ca cry-wolf precedent). HERMETIC: a real throwaway git repo
// (execSync git, real commits with controlled GIT_COMMITTER_DATE) + real throwaway dist-output fixture
// files, driven entirely through the exported test-seam options (distEntry/repoRoot/sharedDist) — no
// dependency on this checkout's own real dist/git state (EXCEPT section (8), which deliberately probes the
// real tree — see its own comment).
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
//   (4) unavailable, gracefully, never throws: no .git at the given repoRoot; dist entry missing.
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
// `processStartedAt` (its test seam) + `runningCodeBuiltAt` (= min(distBuiltAt, processStartedAt)
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
// Card 3d7dccb9 — builtContentMatchesHead, the CONTENT-based fallback for the one case a sha comparison
// alone cannot resolve: a REAL, non-ancestor commit whose shipped tree is nonetheless byte-identical to
// mainline HEAD (a worker worktree's own union-forward merge commit vs. its later squash-merge onto
// mainline — see the module doc's mechanism section for the live incident this answers):
//   (23a) BOTH POLARITIES, positive: a genuine divergent branch (real `git merge-base --is-ancestor`
//         failure, not a hypothetical sha) with IDENTICAL content ⇒ builtContentMatchesHead:true.
//   (23b) BOTH POLARITIES, negative: the SAME divergent shape but with a REAL content difference ⇒
//         builtContentMatchesHead:false — proves (23a)'s `true` isn't a check that always reads true.
//   (23c) the ordinary-ancestor case (processBuiltSha equals mainline HEAD) never spends the extra git
//         calls — builtContentMatchesHead stays null; the already-correct processBuiltShaMatchesHead/stale
//         answer that case instead.
//   (23d) an unresolvable processBuiltSha ⇒ null, never a fabricated verdict.
//
// Card 9aa4e2c9 — `processStartedAt` must be a STABLE, joinable stamp: the SAME string on every read of
// the same (never-restarted) boot, not a value that drifts because the old formula
// (`Date.now() - process.uptime()*1000`) subtracted a WALL clock from a MONOTONIC one:
//   (24a) POSITIVE CONTROL: the REMOVED formula, reproduced under a controlled clock-rate mismatch
//         (no real waiting — a real interval this short can't reliably show physical oscillator drift, so
//         the divergence is injected directly, same technique as (12b)'s monkeypatched fs.readdirSync) —
//         proves the shape of check below is capable of failing, not vacuous.
//   (24b) THE FIX: two real calls into the shipped computeDeployStaleness (no override — exercises the
//         actual `performance.timeOrigin` branch), under the SAME mocked clock skew that broke (24a),
//         return an IDENTICAL processStartedAt — proves the fix is structurally immune, not merely
//         avoiding the specific numbers (24a) used.
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
// Card 8ff7ccde: the `processStartedAt` option lets a test control the "since when has the CURRENTLY
// RUNNING code been in effect" clock independently of `distBuiltAt`. No section BEFORE (11)
// intends to exercise that axis — left to the real default (derived from this test process's own
// `process.uptime()`), its value would depend on what wall-clock day this test happens to run on relative
// to each section's fixture mtimes, which is exactly the non-hermetic coupling this suite's own header
// promises never to have. Pin it far enough in the future that it can never be the EARLIER of the two
// clocks for any fixture mtime any section below sets, so every section's behavior stays IDENTICAL to
// before this card; only (11)/(11n) call `computeDeployStalenessRaw` directly with an explicit override to
// actually exercise the new axis.
const FAR_FUTURE_PROCESS_START = "2030-01-01T00:00:00Z";
// Card f26339d7: processBuiltSha/processBuiltDirty options forwarded verbatim (undefined stays undefined,
// since computeDeployStalenessRaw's own default for an omitted key — "the caller didn't tell me" — is
// exactly right; there is no FAR_FUTURE-style neutral default for a sha/dirty flag the way there is for a
// clock).
// Card 119fd301: local wrapper's OWN param is now a single options object (named seams, never counted),
// mirroring the production function it wraps — only `processStartedAt` gets the FAR_FUTURE substitution;
// every other key forwards through unchanged.
const computeDeployStaleness = ({ distEntry, repoRoot, sharedDist, webDist, processStartedAt, processBuiltSha, processBuiltDirty } = {}) =>
  computeDeployStalenessRaw({ distEntry, repoRoot, sharedDist, webDist, processStartedAt: processStartedAt ?? FAR_FUTURE_PROCESS_START, processBuiltSha, processBuiltDirty });

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
  const rNoRepo = computeDeployStaleness({ distEntry, repoRoot: noRepo });
  check("(4) no .git at repoRoot ⇒ available:false, never throws", rNoRepo.available === false && typeof rNoRepo.reason === "string");
  check("(4) unavailable ⇒ stale:false (never a false-positive claim)", rNoRepo.stale === false);
  // Card d3d4d432: no .git is the ONE genuinely NOT-APPLICABLE cause (a packaged install) — classified at
  // the SOURCE (the unavailable() call site), not string-matched from `reason` downstream.
  check("(4) no .git ⇒ reasonKind:\"not-applicable\" (classified at source, not string-matched from reason)", rNoRepo.reasonKind === "not-applicable");
  fs.rmSync(noRepo, { recursive: true, force: true });

  const rNoDist = computeDeployStaleness({ distEntry: path.join(distDir, "does-not-exist.js"), repoRoot: repo });
  check("(4) missing dist entry ⇒ available:false, never throws", rNoDist.available === false && typeof rNoDist.reason === "string");
  // Card d3d4d432: EVERY other unavailable() cause is COULD-NOT-MEASURE — the instrument was reachable in
  // principle but a step failed — never silently equivalent to the one true not-applicable case above.
  check("(4) missing dist entry ⇒ reasonKind:\"could-not-measure\" (the instrument was reachable, a step failed — NOT the same as \"not applicable\")", rNoDist.reasonKind === "could-not-measure");

  // ===================== (1) STALE positive control =====================
  buildDistAt("2026-06-01T00:00:00Z"); // dist "built" June 1
  fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "foo.ts"), "export const foo = 1;\n");
  git("add packages/daemon/src/foo.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add foo"', "2026-06-02T00:00:00Z"); // AFTER the build

  const rStale = computeDeployStaleness({ distEntry, repoRoot: repo });
  check("(1) a daemon/src commit AFTER the dist build ⇒ stale:true" + reasonSuffix(rStale), rStale.available === true && rStale.stale === true);
  check("(1) commitsBehind counts it", rStale.commitsBehind === 1);
  check("(1) mainlineHeadSha is a real 40-char sha", /^[0-9a-f]{40}$/.test(rStale.mainlineHeadSha ?? ""));
  check("(1) mainlineHeadDate is the real HEAD commit's date (June 2, not the dist build date)", (rStale.mainlineHeadDate ?? "").startsWith("2026-06-02"));
  check("(1) distBuiltAt reflects the fixture dist mtime (June 1)", (rStale.distBuiltAt ?? "").startsWith("2026-06-01"));

  // ===================== (1n) CLEAN control — SAME repo, rebuild dist AFTER the commit =====================
  buildDistAt("2026-06-03T00:00:00Z"); // dist "rebuilt" after the June 2 commit
  const rClean = computeDeployStaleness({ distEntry, repoRoot: repo });
  check("(1n) dist rebuilt AFTER the relevant commit ⇒ stale:false (the signal goes BOTH ways)" + reasonSuffix(rClean), rClean.available === true && rClean.stale === false);
  check("(1n) commitsBehind is 0 once rebuilt", rClean.commitsBehind === 0);

  // ===================== (2) path-scoping negative control (the 637558ca cry-wolf precedent) =====================
  buildDistAt("2026-06-03T00:00:00Z"); // keep dist at June 3 (after all commits so far)
  fs.writeFileSync(path.join(repo, "assets", "skills", "demo", "SKILL.md"), "# demo skill\n");
  git("add assets/skills/demo/SKILL.md");
  git('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): add demo skill"', "2026-06-04T00:00:00Z"); // AFTER the June 3 build
  const rAssetsOnly = computeDeployStaleness({ distEntry, repoRoot: repo });
  check("(2) an assets/**-only commit AFTER the build must NOT count as stale" + reasonSuffix(rAssetsOnly), rAssetsOnly.available === true && rAssetsOnly.stale === false && rAssetsOnly.commitsBehind === 0);
  check("(2) mainlineHeadSha still advances to the real HEAD (the assets commit), even though it's excluded from staleness", (rAssetsOnly.mainlineHeadDate ?? "").startsWith("2026-06-04"));

  // ===================== (2b) positive control on the SAME corpus — a shared/src commit DOES count =====================
  fs.writeFileSync(path.join(repo, "packages", "shared", "src", "bar.ts"), "export const bar = 2;\n");
  git("add packages/shared/src/bar.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(shared): add bar"', "2026-06-05T00:00:00Z"); // AFTER the June 3 build
  const rSharedToo = computeDeployStaleness({ distEntry, repoRoot: repo });
  check("(2b) a packages/shared/src commit in the SAME repo DOES count (proves (2) wasn't a vacuous corpus)" + reasonSuffix(rSharedToo), rSharedToo.available === true && rSharedToo.stale === true && rSharedToo.commitsBehind === 1);

  // ===================== (3) multiple relevant commits after the build ⇒ all counted =====================
  fs.writeFileSync(path.join(repo, "packages", "daemon", "src", "baz.ts"), "export const baz = 3;\n");
  git("add packages/daemon/src/baz.ts");
  git('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add baz"', "2026-06-06T00:00:00Z"); // AFTER the June 3 build
  const rMulti = computeDeployStaleness({ distEntry, repoRoot: repo });
  check("(3) two relevant commits after the build ⇒ commitsBehind:2 (shared bar + daemon baz — assets commit still excluded)", rMulti.commitsBehind === 2);

  // ===================== (5) fresh on every call — no caching across calls (DoD #4) =====================
  const rFirst = computeDeployStaleness({ distEntry, repoRoot: repo });
  buildDistAt("2026-06-07T00:00:00Z"); // rebuild AFTER everything, no code change in between
  const rSecond = computeDeployStaleness({ distEntry, repoRoot: repo });
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

  const rIncremental = computeDeployStaleness({ distEntry: incDistEntry, repoRoot: incRepo });
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

  const rBeforeSharedRebuild = computeDeployStaleness({ distEntry: shDaemonDistEntry, repoRoot: shRepo, sharedDist: shSharedDistDir });
  check("(7-setup) a shared/src commit after BOTH dists were built ⇒ stale:true (sanity check before proving shared/dist is what clears it)" + reasonSuffix(rBeforeSharedRebuild), rBeforeSharedRebuild.available === true && rBeforeSharedRebuild.stale === true && rBeforeSharedRebuild.commitsBehind === 1);

  buildShSharedDistAt("2026-08-03T00:00:00Z"); // ONLY shared/dist rebuilt after the commit — daemon dist left untouched at 08-01T12:00
  const rAfterSharedRebuild = computeDeployStaleness({ distEntry: shDaemonDistEntry, repoRoot: shRepo, sharedDist: shSharedDistDir });
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

  const rWebOnly = computeDeployStaleness({ distEntry: webDaemonDistEntry, repoRoot: webRepo, webDist: webWebDistDir });
  check("(9) a web-only commit after both dists were built ⇒ webStale:true, webCommitsBehind:1 (POSITIVE CONTROL — the exact bug this card fixes)" + reasonSuffix(rWebOnly),
    rWebOnly.available === true && rWebOnly.webStale === true && rWebOnly.webCommitsBehind === 1);
  check("(9) the SAME web-only commit leaves the daemon-restart signal COMPLETELY UNCHANGED: stale:false, commitsBehind:0 (a web-only merge must never advise a daemon_restart)",
    rWebOnly.stale === false && rWebOnly.commitsBehind === 0);
  check("(9) webDistBuiltAt reflects the fixture web dist mtime (Sept 1)", (rWebOnly.webDistBuiltAt ?? "").startsWith("2026-09-01"));

  // ===================== (9b) WEB SIGNAL — NEGATIVE CONTROL, same corpus: daemon-src-only commit =====================
  fs.writeFileSync(path.join(webRepo, "packages", "daemon", "src", "foo.ts"), "export const foo = 1;\n");
  gitWeb("add packages/daemon/src/foo.ts");
  gitWeb('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add foo"', "2026-09-03T00:00:00Z"); // AFTER both dists
  const rDaemonOnly = computeDeployStaleness({ distEntry: webDaemonDistEntry, repoRoot: webRepo, webDist: webWebDistDir });
  check("(9b) a daemon-src-only commit on the SAME corpus does NOT add to the web signal — webCommitsBehind stays exactly 1 (the Sept 2 web commit from (9), not 2)",
    rDaemonOnly.webCommitsBehind === 1);
  check("(9b) the SAME daemon-src commit correctly flips the daemon-restart signal: stale:true, commitsBehind:1",
    rDaemonOnly.stale === true && rDaemonOnly.commitsBehind === 1);

  // ===================== (9c) WEB SIGNAL — CLEAN control: rebuild web dist AFTER the web commit =====================
  buildWebWebDistAt("2026-09-04T00:00:00Z"); // web dist rebuilt after the Sept 2 web commit; daemon dist left untouched
  const rWebRebuilt = computeDeployStaleness({ distEntry: webDaemonDistEntry, repoRoot: webRepo, webDist: webWebDistDir });
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

  const rNoWebDist = computeDeployStaleness({ distEntry: noWebDaemonDistEntry, repoRoot: noWebRepo, webDist: noWebDistDir });
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

  const rProcStale = computeDeployStalenessRaw({ distEntry: procDistEntry, repoRoot: procRepo, processStartedAt: T1_PROCESS_STARTED });
  check("(11) distBuiltAt reflects the on-disk REBUILD (Nov 3), not the process's own start", (rProcStale.distBuiltAt ?? "").startsWith("2026-11-03"));
  check("(11) processStartedAt echoes the override (Nov 1 01:00) — the process's own, never-restarted, start", (rProcStale.processStartedAt ?? "").startsWith("2026-11-01T01:00"));
  check("(11) runningCodeBuiltAt is the EARLIER of the two (the process's own start, not the newer on-disk rebuild)", (rProcStale.runningCodeBuiltAt ?? "").startsWith("2026-11-01T01:00"));
  check("(11) distAheadOfProcess:true — the on-disk artifact moved past what this process ever loaded", rProcStale.distAheadOfProcess === true);
  check("(11) THE FIX: stale:true, commitsBehind:1 — the Nov 2 commit is correctly still-unbuilt-by-this-PROCESS, even though the on-disk dist (Nov 3) is newer than it (the pre-fix, dist-only algorithm would have read this clean)" + reasonSuffix(rProcStale),
    rProcStale.available === true && rProcStale.stale === true && rProcStale.commitsBehind === 1);

  // ===================== (11n) CLEAN control, same shape: process started AFTER the rebuild =====================
  const T4_PROCESS_STARTED_AFTER_REBUILD = "2026-11-04T00:00:00Z"; // AFTER the Nov 3 rebuild — the healthy case
  const rProcClean = computeDeployStalenessRaw({ distEntry: procDistEntry, repoRoot: procRepo, processStartedAt: T4_PROCESS_STARTED_AFTER_REBUILD });
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
    rDistUnreadable = computeDeployStalenessRaw({ distEntry: raceDistIndex, repoRoot: repo });
  } finally {
    fs.readdirSync = originalReaddirSync; // never leave the global fs module patched
  }
  check("(12b self-check) the readdirSync patch actually fired (positive control — a never-fired patch proves nothing)", racePatchFired === true);
  check("(12-after) THE FIX: distIndex exists but its dist dir is unreadable ⇒ available:false, never a false epoch-0 answer" + reasonSuffix(rDistUnreadable), rDistUnreadable.available === false && typeof rDistUnreadable.reason === "string");
  check("(12-after) the unavailable reason names the dist directory specifically, not a generic message", /dist directory/.test(rDistUnreadable.reason ?? ""));
  check("(12-after) card d3d4d432: a build-race dist-dir failure classifies as could-not-measure, not not-applicable", rDistUnreadable.reasonKind === "could-not-measure");
  check("(12-after) unavailable ⇒ stale:false, commitsBehind:0 (never a false-positive OR false-negative claim)", rDistUnreadable.stale === false && rDistUnreadable.commitsBehind === 0);
  check("(12-after) unavailable ⇒ distBuiltAt/runningCodeBuiltAt are null, never an epoch/invalid-date string", rDistUnreadable.distBuiltAt === null && rDistUnreadable.runningCodeBuiltAt === null);

  // ===================== (13)-(17) CARD f26339d7 — distBuiltSha / processBuiltSha / deploySignatureMismatch =====================
  // AMENDMENT 1 (owner correction): computeDeployStaleness stays PURE — `processBuiltSha` is never read or
  // cached by this function itself, only ECHOED from the explicit `processBuiltSha` option (card 119fd301:
  // an options-object key now, not a positional arg). The REAL "captured once at process start" mechanism
  // lives in served-status.ts's own
  // top-level module load (proven separately, against the real production module, by
  // served-status-process-sha.mjs) — this file only proves computeDeployStaleness's own pure logic: given
  // the same inputs, always the same outputs, with no hidden module-level state to reset between sections.
  //
  // A dedicated corpus with REAL commit shas (git rev-parse, not a fixture string) since
  // `processBuiltSha`'s "does this resolve as a real commit" path (commitDateMs) needs an actual object in
  // the repo.
  const shaCorpusRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-shacorpus-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(path.join(shaCorpusRepo, "packages", "daemon", "src"), { recursive: true });
  const gitSha = (args, dateIso) => execSync(`git ${args}`, {
    cwd: shaCorpusRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  const headShaOf = (repoDir) => execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

  gitSha("init -q");
  gitSha('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2027-01-01T00:00:00Z");

  fs.writeFileSync(path.join(shaCorpusRepo, "packages", "daemon", "src", "old.ts"), "export const old = 1;\n");
  gitSha("add packages/daemon/src/old.ts");
  gitSha('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add old"', "2027-01-02T00:00:00Z"); // T1
  const commitOldSha = headShaOf(shaCorpusRepo); // the commit a not-yet-restarted process is (correctly) still running

  fs.writeFileSync(path.join(shaCorpusRepo, "packages", "daemon", "src", "new.ts"), "export const isNew = 1;\n");
  gitSha("add packages/daemon/src/new.ts");
  gitSha('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add new"', "2027-01-03T00:00:00Z"); // T2, AFTER T1
  const commitNewSha = headShaOf(shaCorpusRepo); // the real latest restart-relevant commit / mainline HEAD

  const shaDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-shadist-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(shaDistDir, { recursive: true });
  const shaDistEntry = path.join(shaDistDir, "index.js");
  const buildShaDistAt = (iso, bakedSha, dirty = false) => {
    fs.writeFileSync(shaDistEntry, "// fixture dist entry\n");
    fs.writeFileSync(path.join(shaDistDir, "build-info.json"), JSON.stringify({ sha: bakedSha, dirty }));
    fs.utimesSync(shaDistEntry, new Date(iso), new Date(iso));
  };

  // ---- (13) plain read, healthy/matching case (a PROVABLY CLEAN build) ----
  buildShaDistAt("2027-01-03T12:00:00Z", commitNewSha); // built AFTER both commits, baking the real HEAD
  const r13 = computeDeployStaleness({ distEntry: shaDistEntry, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(13) distBuiltSha reads the sha baked into build-info.json" + reasonSuffix(r13), r13.distBuiltSha === commitNewSha);
  check("(13) distBuiltDirty reads the dirty flag baked into build-info.json", r13.distBuiltDirty === false);
  check("(13) processBuiltSha echoes the override exactly", r13.processBuiltSha === commitNewSha);
  check("(13) processBuiltDirty echoes the override exactly", r13.processBuiltDirty === false);
  check("(13) distBuiltShaDiffersFromProcess:false when both agree", r13.distBuiltShaDiffersFromProcess === false);
  check("(13) processBuiltShaMatchesHead:true when processBuiltSha equals the real mainline HEAD AND the build is provably clean", r13.processBuiltShaMatchesHead === true);
  check("(13) a healthy build (processBuiltSha==HEAD, dist built after both commits) ⇒ stale:false", r13.stale === false);
  check("(13) and deploySignatureMismatch:false — no disagreement to surface (processBuiltShaMatchesHead is true)", r13.deploySignatureMismatch === false);

  // ---- (14) THE REBUILD-WITHOUT-RESTART CASE — the actual property this amendment introduces ----
  // SAME setup as (13): a rebuild has landed on disk (build-info.json now bakes commitNewSha, mtime after
  // both commits so the mtime clock reads "caught up"). But THIS CALL passes processBuiltSha =
  // commitOldSha — simulating "the real running process captured its OWN sha at start, before this
  // rebuild happened, and hasn't restarted since". Because computeDeployStaleness is PURE, this is a
  // ONE-CALL proof: there is no cache to poison, no first-call-timing race — the two values are simply
  // whatever this call was told, which is exactly the point (see the module doc's AMENDMENT 1 section for
  // why a cache-based version of this field was WRONG).
  const r14 = computeDeployStaleness({ distEntry: shaDistEntry, repoRoot: shaCorpusRepo, processBuiltSha: commitOldSha, processBuiltDirty: false });
  check("(14) distBuiltSha reflects the REBUILD that landed on disk (fresh read, unaffected by the processBuiltSha option)" + reasonSuffix(r14),
    r14.distBuiltSha === commitNewSha);
  check("(14) processBuiltSha reports what the caller says THIS PROCESS is running — commitOldSha, NOT the on-disk rebuild",
    r14.processBuiltSha === commitOldSha);
  check("(14) distBuiltShaDiffersFromProcess:true — THE definitive, content-based 'a rebuild landed, this process hasn't restarted' signal",
    r14.distBuiltShaDiffersFromProcess === true);

  // ---- (15) graceful degradation: processBuiltSha option omitted / explicitly null ----
  const r15omitted = computeDeployStaleness({ distEntry: shaDistEntry, repoRoot: shaCorpusRepo }); // no processBuiltSha/processBuiltDirty key at all
  check("(15) processBuiltSha option OMITTED ⇒ processBuiltSha:null — never falls back to distBuiltSha's value" + reasonSuffix(r15omitted),
    r15omitted.processBuiltSha === null && r15omitted.distBuiltSha === commitNewSha);
  check("(15) processBuiltDirty OMITTED ⇒ null", r15omitted.processBuiltDirty === null);
  check("(15) processBuiltSha:null ⇒ processBuiltShaMatchesHead:null and deploySignatureMismatch:false (never fabricated without proof)",
    r15omitted.processBuiltShaMatchesHead === null && r15omitted.deploySignatureMismatch === false);
  check("(15) distBuiltShaDiffersFromProcess:false when processBuiltSha is unresolved (never a positive claim without both sides)",
    r15omitted.distBuiltShaDiffersFromProcess === false);
  const r15null = computeDeployStaleness({ distEntry: shaDistEntry, repoRoot: shaCorpusRepo, processBuiltSha: null, processBuiltDirty: null });
  check("(15) processBuiltSha/processBuiltDirty options explicitly null ⇒ identical degradation to omitting them",
    r15null.processBuiltSha === null && r15null.processBuiltDirty === null && r15null.processBuiltShaMatchesHead === null && r15null.deploySignatureMismatch === false);

  // ---- (16) no build-info.json at all (an old dist built before this card) ----
  const shaDistDir3 = trackDir(path.join(os.tmpdir(), `loom-dpstl-shadist3-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(shaDistDir3, { recursive: true });
  const shaDistEntry3 = path.join(shaDistDir3, "index.js");
  fs.writeFileSync(shaDistEntry3, "// fixture dist entry 3, no build-info.json\n");
  fs.utimesSync(shaDistEntry3, new Date("2027-01-03T12:00:00Z"), new Date("2027-01-03T12:00:00Z"));
  const r16 = computeDeployStaleness({ distEntry: shaDistEntry3, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(16) no build-info.json at all ⇒ distBuiltSha:null, never a throw or a fabricated value" + reasonSuffix(r16), r16.available === true && r16.distBuiltSha === null);
  check("(16) no build-info.json at all ⇒ distBuiltDirty:null too", r16.distBuiltDirty === null);
  check("(16) processBuiltSha is UNAFFECTED by a missing distBuiltSha — it still echoes the override", r16.processBuiltSha === commitNewSha);
  check("(16) distBuiltShaDiffersFromProcess:false when distBuiltSha is unresolved (never a positive claim without both sides)", r16.distBuiltShaDiffersFromProcess === false);

  // ---- (16b) Code Review "ALSO REQUIRED" (a) — the LITERAL {"sha":null,"dirty":null} JSON shape ----
  // write-build-info.mjs's own real degradation output (git unavailable at BUILD time) — a DIFFERENT case
  // from (16)'s missing file entirely, and the PRIMARY production degradation path (a packaged tarball's
  // own build, or any build run outside a git checkout).
  const shaDistDir3b = trackDir(path.join(os.tmpdir(), `loom-dpstl-shadist3b-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(shaDistDir3b, { recursive: true });
  const shaDistEntry3b = path.join(shaDistDir3b, "index.js");
  fs.writeFileSync(shaDistEntry3b, "// fixture dist entry 3b\n");
  fs.writeFileSync(path.join(shaDistDir3b, "build-info.json"), JSON.stringify({ sha: null, dirty: null })); // write-build-info.mjs's REAL degraded output
  fs.utimesSync(shaDistEntry3b, new Date("2027-01-03T12:00:00Z"), new Date("2027-01-03T12:00:00Z"));
  const r16b = computeDeployStaleness({ distEntry: shaDistEntry3b, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(16b) the literal {sha:null,dirty:null} JSON write-build-info.mjs produces when git is unavailable ⇒ distBuiltSha:null, never a throw" + reasonSuffix(r16b),
    r16b.available === true && r16b.distBuiltSha === null && r16b.distBuiltDirty === null);

  // ---- (17) THE ACTUAL DEFECT — deploySignatureMismatch: the cache-replay signature (DoD #4) ----
  // Simulates a turbo cache-replay: dist mtime bumped AFTER both commits (so the mtime-based clock reads
  // stale:false — "caught up"). `deploySignatureMismatch` is fed from `processBuiltSha`, not `distBuiltSha`
  // (see the module doc) — so what matters here is that the CALLER (a not-yet-restarted real process)
  // still reports commitOldSha as what it's executing, exactly the shape a cache-replay produces in
  // production (the replay's mtime bump fools the date clock; the process's own captured sha does not).
  const shaDistDir4 = trackDir(path.join(os.tmpdir(), `loom-dpstl-shadist4-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(shaDistDir4, { recursive: true });
  const shaDistEntry4 = path.join(shaDistDir4, "index.js");
  fs.writeFileSync(shaDistEntry4, "// fixture dist entry 4 — cache-replay simulation\n");
  fs.utimesSync(shaDistEntry4, new Date("2027-01-04T00:00:00Z"), new Date("2027-01-04T00:00:00Z")); // mtime AFTER commitNewSha (T2)
  const r17 = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitOldSha, processBuiltDirty: false });
  check("(17-setup) the mtime-based clock reads stale:false — the replay's mtime bump fools it, exactly as designed" + reasonSuffix(r17),
    r17.stale === false && r17.commitsBehind === 0);
  check("(17) THE DEFECT DETECTED: deploySignatureMismatch:true — processBuiltSha (the OLD commit) proves the mtime clock's 'caught up' claim is FALSE",
    r17.deploySignatureMismatch === true);
  check("(17) processBuiltShaMatchesHead:false (the process is genuinely behind real HEAD)", r17.processBuiltShaMatchesHead === false);

  // ---- (17n) CLEAN control, same shape — the process reports it's running the TRUE latest commit ----
  const r17n = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(17n) CLEAN control: stale:false AND deploySignatureMismatch:false when the process genuinely IS running the latest commit (the detector goes both ways)" + reasonSuffix(r17n),
    r17n.stale === false && r17n.deploySignatureMismatch === false);
  check("(17n) processBuiltShaMatchesHead:true in the clean case", r17n.processBuiltShaMatchesHead === true);

  // ---- (18) Code Review BLOCKING 3 — a DIRTY (or unknown-dirtiness) build must NEVER read as a clean match ----
  // Same corpus, SAME sha as HEAD (commitNewSha) — the ONLY thing that varies below is the dirty flag. If
  // dirty gating weren't wired, ALL THREE would read processBuiltShaMatchesHead:true (sha equality alone).
  const r18dirty = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: true });
  check("(18) processBuiltDirty:true, sha EQUALS mainline HEAD ⇒ processBuiltShaMatchesHead:false anyway — a dirty build can never claim a clean match" + reasonSuffix(r18dirty),
    r18dirty.processBuiltShaMatchesHead === false);
  const r18unknown = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: null });
  check("(18) processBuiltDirty:null (UNKNOWN, not merely absent-of-proof-of-dirty) ⇒ ALSO processBuiltShaMatchesHead:false — unknown is treated the same as dirty, never assumed clean" + reasonSuffix(r18unknown),
    r18unknown.processBuiltShaMatchesHead === false);
  const r18clean = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(18) POSITIVE CONTROL: the SAME sha with processBuiltDirty EXACTLY false ⇒ processBuiltShaMatchesHead:true — proves (18)'s two FALSE results above are the dirty gate, not a broken sha comparison",
    r18clean.processBuiltShaMatchesHead === true);

  // ---- (19) Code Review "ALSO REQUIRED" (b) — an UNRESOLVABLE baked sha (shallow clone / pruned object) ----
  // A real-looking 40-hex string that is NOT actually an object in shaCorpusRepo — commitDateMs's own
  // `git log -1 <sha>` lookup fails, and that failure must degrade the mismatch check to false, never throw
  // and never fabricate a positive.
  const unresolvableSha = "f".repeat(40);
  const r19 = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: unresolvableSha, processBuiltDirty: false });
  check("(19) an unresolvable baked sha ⇒ processBuiltShaMatchesHead:false (it genuinely doesn't match real HEAD)" + reasonSuffix(r19),
    r19.processBuiltShaMatchesHead === false);
  check("(19) THE FIX: an unresolvable sha ⇒ deploySignatureMismatch stays false — commitDateMs fails closed, never a fabricated positive without a resolvable date",
    r19.deploySignatureMismatch === false);

  // ---- (20) Code Review "ALSO REQUIRED" (c) — CRY-WOLF CONTROL: the COMMON healthy state ----
  // Mainline moved via a commit that does NOT touch a restart-relevant path (docs/assets-only — same
  // exclusion section (2) above already proves at the commitsBehind level) — so processBuiltShaMatchesHead
  // is correctly false (the sha genuinely differs from the NEW mainline HEAD) but deploySignatureMismatch
  // must stay false too: this is NOT a cache-replay, it's just mainline moving on unrelated work while the
  // daemon is genuinely fine. Given this module's own 637558ca cry-wolf precedent, nothing pinned this
  // false-positive direction before.
  fs.mkdirSync(path.join(shaCorpusRepo, "assets", "skills", "demo2"), { recursive: true });
  fs.writeFileSync(path.join(shaCorpusRepo, "assets", "skills", "demo2", "SKILL.md"), "# demo2\n");
  gitSha("add assets/skills/demo2/SKILL.md");
  gitSha('-c user.email=t@loom -c user.name=t commit -q -m "docs(assets): add demo2 skill"', "2027-01-05T00:00:00Z"); // T3, AFTER commitNewSha (T2) — mainline HEAD is now this commit, but it's assets-only (excluded)
  const r20 = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(20-setup) mainline HEAD moved (an assets-only commit AFTER commitNewSha) — processBuiltSha genuinely no longer equals HEAD" + reasonSuffix(r20),
    r20.processBuiltShaMatchesHead === false);
  check("(20-setup) and stale:false — the assets-only commit is correctly excluded from the restart-relevant count (same exclusion as section (2))",
    r20.stale === false);
  check("(20) CRY-WOLF CONTROL: deploySignatureMismatch:false — a legitimate cache hit / genuinely fine daemon whose only 'staleness' is mainline moving on unrelated docs work, NOT a false positive",
    r20.deploySignatureMismatch === false);

  // ---- (21) Code Review "ALSO REQUIRED" (d) — webBuiltSha has NO caching to regress into ----
  // Two calls, SAME repo/process args, but the web dist's OWN build-info.json is rewritten between them —
  // webBuiltSha must reflect the NEW value on the very next call. A future "consistency" refactor that
  // accidentally caches webBuiltSha the way `builtSha` used to be cached (AMENDMENT 1's own mistake) would
  // fail this silently otherwise, since every OTHER webBuiltSha assertion in this suite only ever checks
  // ONE value in isolation.
  const webPinDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-webpin-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(webPinDir, { recursive: true });
  fs.writeFileSync(path.join(webPinDir, "build-info.json"), JSON.stringify({ sha: commitOldSha, dirty: false }));
  const rWebPinBefore = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, webDist: webPinDir, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(21-setup) webBuiltSha reads the web dist's OWN baked sha" + reasonSuffix(rWebPinBefore), rWebPinBefore.webBuiltSha === commitOldSha);
  fs.writeFileSync(path.join(webPinDir, "build-info.json"), JSON.stringify({ sha: commitNewSha, dirty: false })); // rewrite — NO restart/reset of any kind between calls
  const rWebPinAfter = computeDeployStaleness({ distEntry: shaDistEntry4, repoRoot: shaCorpusRepo, webDist: webPinDir, processBuiltSha: commitNewSha, processBuiltDirty: false });
  check("(21) PINNED: webBuiltSha reflects the rewrite on the VERY NEXT call — it is never cached, unlike processBuiltSha's deliberate module-load capture",
    rWebPinAfter.webBuiltSha === commitNewSha);

  // ---- (22) Code Review "ALSO REQUIRED" (final) — baked info survives the NO-.git bail (packaged install) ----
  // The exact case DoD-1 names explicitly: a published npm tarball's own build ships dist/build-info.json
  // but has no .git at all. "What commit is this artifact/process?" must still be answerable even though
  // every git-derived comparison field is correctly unavailable.
  const noGitRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-nogitrepo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(noGitRepo, { recursive: true }); // deliberately NEVER git-init'd
  const packagedDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-packageddist-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(packagedDistDir, { recursive: true });
  const packagedDistEntry = path.join(packagedDistDir, "index.js");
  fs.writeFileSync(packagedDistEntry, "// fixture packaged dist entry\n");
  fs.writeFileSync(path.join(packagedDistDir, "build-info.json"), JSON.stringify({ sha: commitOldSha, dirty: false })); // baked at RELEASE build time, ships in the tarball
  const r22 = computeDeployStaleness({ distEntry: packagedDistEntry, repoRoot: noGitRepo, processBuiltSha: commitOldSha, processBuiltDirty: false });
  check("(22) no .git at all ⇒ available:false (unchanged behavior)" + reasonSuffix(r22), r22.available === false);
  check("(22) card d3d4d432: no .git ⇒ reasonKind:\"not-applicable\" even alongside a fully-baked processBuiltSha/distBuiltSha (a packaged install genuinely has no git, this is not a git-derived-field-failure case)", r22.reasonKind === "not-applicable");
  check("(22) THE FIX: distBuiltSha/distBuiltDirty are STILL populated from the real, already-shipped dist/build-info.json — not thrown away just because git is unavailable",
    r22.distBuiltSha === commitOldSha && r22.distBuiltDirty === false);
  check("(22) processBuiltSha/processBuiltDirty are STILL populated too — they never depended on git at all",
    r22.processBuiltSha === commitOldSha && r22.processBuiltDirty === false);
  check("(22) distBuiltShaDiffersFromProcess is STILL computed — this comparison needs no git either",
    r22.distBuiltShaDiffersFromProcess === false); // both sides are commitOldSha here — a genuinely non-diverged packaged install
  check("(22) but every GIT-derived field correctly stays unavailable — mainlineHeadSha:null, processBuiltShaMatchesHead:null, deploySignatureMismatch:false",
    r22.mainlineHeadSha === null && r22.processBuiltShaMatchesHead === null && r22.deploySignatureMismatch === false);

  try { fs.rmSync(shaCorpusRepo, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (23) Card 3d7dccb9 — builtContentMatchesHead: the CONTENT-based fallback =====================
  // A `processBuiltSha` that is a REAL commit but NOT an ancestor of mainline HEAD is exactly the shape of
  // a worker worktree's own union-forward merge commit vs. its later squash-merge onto mainline: same
  // shipped content, different commit identity. Reproduced with a genuine divergent branch (not a
  // hypothetical sha) so `git merge-base --is-ancestor` and `git diff` run against real objects.
  const caRepo = trackDir(path.join(os.tmpdir(), `loom-dpstl-carepo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(path.join(caRepo, "packages", "daemon", "src"), { recursive: true });
  const gitCa = (args, dateIso) => execSync(`git ${args}`, {
    cwd: caRepo,
    env: { ...process.env, ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}) },
  });
  gitCa("init -q");
  gitCa('-c user.email=t@loom -c user.name=t commit -q -m init --allow-empty', "2027-02-01T00:00:00Z");
  const caDefaultBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: caRepo }).toString().trim(); // "main" or "master" — never assumed

  const caDistDir = trackDir(path.join(os.tmpdir(), `loom-dpstl-cadist-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`));
  fs.mkdirSync(caDistDir, { recursive: true });
  const caDistEntry = path.join(caDistDir, "index.js");
  const buildCaDistAt = (iso) => {
    fs.writeFileSync(caDistEntry, "// fixture ca dist entry\n");
    fs.utimesSync(caDistEntry, new Date(iso), new Date(iso));
  };
  buildCaDistAt("2027-02-05T00:00:00Z"); // after everything below — commitsBehind/stale are not what this section tests

  // ---- (23a) IDENTICAL-CONTENT divergent commit — must report NOT-stale-BY-CONTENT ----
  gitCa("checkout -qb worktree-branch");
  fs.writeFileSync(path.join(caRepo, "packages", "daemon", "src", "identical.ts"), "export const same = 1;\n");
  gitCa("add packages/daemon/src/identical.ts");
  gitCa('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add identical"', "2027-02-02T00:00:00Z");
  const workerSha = execSync("git rev-parse HEAD", { cwd: caRepo }).toString().trim();

  gitCa(`checkout -q ${caDefaultBranch}`);
  // Re-applies the SAME file content as a SEPARATE commit — simulates a squash-merge landing content
  // identical to the worktree branch above, under a different commit identity/parent/timestamp.
  // `git checkout` prunes packages/daemon/src back to empty (it held only the just-left branch's
  // now-absent identical.ts) and removes the now-empty dir entirely — recreate it before writing.
  fs.mkdirSync(path.join(caRepo, "packages", "daemon", "src"), { recursive: true });
  fs.writeFileSync(path.join(caRepo, "packages", "daemon", "src", "identical.ts"), "export const same = 1;\n");
  gitCa("add packages/daemon/src/identical.ts");
  gitCa('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add identical (squash)"', "2027-02-03T00:00:00Z");
  const mainlineShaIdentical = execSync("git rev-parse HEAD", { cwd: caRepo }).toString().trim();

  check("(23a-setup) workerSha is genuinely NOT an ancestor of mainline HEAD (a real divergent branch, never merged)",
    (() => { try { execSync(`git merge-base --is-ancestor ${workerSha} ${mainlineShaIdentical}`, { cwd: caRepo }); return false; } catch (e) { return e.status === 1; } })());
  const r23a = computeDeployStaleness({ distEntry: caDistEntry, repoRoot: caRepo, processBuiltSha: workerSha, processBuiltDirty: false });
  check("(23a-setup) processBuiltShaMatchesHead:false — the sha genuinely differs from mainline HEAD" + reasonSuffix(r23a),
    r23a.processBuiltShaMatchesHead === false);
  check("(23a) THE FIX: builtContentMatchesHead:true — a non-ancestor commit whose shipped tree is byte-identical to mainline HEAD is correctly NOT flagged stale by content, despite the sha mismatch",
    r23a.builtContentMatchesHead === true);

  // ---- (23b) NEGATIVE POLARITY — a genuinely stale build (real content difference) must still report stale ----
  gitCa("checkout -qb worktree-branch-2"); // branches from caDefaultBranch's current tree — identical.ts stays present
  fs.mkdirSync(path.join(caRepo, "packages", "daemon", "src"), { recursive: true }); // defensive, mirrors (23a)'s note
  fs.writeFileSync(path.join(caRepo, "packages", "daemon", "src", "divergent.ts"), "export const divergent = 1;\n");
  gitCa("add packages/daemon/src/divergent.ts");
  gitCa('-c user.email=t@loom -c user.name=t commit -q -m "feat(daemon): add divergent"', "2027-02-04T00:00:00Z");
  const staleWorkerSha = execSync("git rev-parse HEAD", { cwd: caRepo }).toString().trim();

  // computeDeployStaleness resolves "mainline HEAD" as whatever THIS repoRoot's checked-out HEAD
  // currently is (see the module doc — it has no notion of a named "main" branch) — check back out to
  // caDefaultBranch so mainlineHeadSha resolves to mainlineShaIdentical again, not to staleWorkerSha
  // itself (which is what's currently checked out after the branch-create above).
  gitCa(`checkout -q ${caDefaultBranch}`);
  // mainline HEAD (mainlineShaIdentical from (23a)) never got this change — the trees genuinely differ.
  const r23b = computeDeployStaleness({ distEntry: caDistEntry, repoRoot: caRepo, processBuiltSha: staleWorkerSha, processBuiltDirty: false });
  check("(23b-setup) this staleWorkerSha is ALSO not an ancestor of mainline HEAD (same divergent shape as (23a))" + reasonSuffix(r23b),
    r23b.processBuiltShaMatchesHead === false);
  check("(23b) BOTH POLARITIES: builtContentMatchesHead:false — a REAL content difference (divergent.ts, never on mainline) is correctly still flagged, proving (23a)'s true isn't a check that always reads true",
    r23b.builtContentMatchesHead === false);

  // ---- (23c) the ORDINARY-ancestor case never spends the extra git calls — builtContentMatchesHead stays null ----
  const r23c = computeDeployStaleness({ distEntry: caDistEntry, repoRoot: caRepo, processBuiltSha: mainlineShaIdentical, processBuiltDirty: false });
  check("(23c) processBuiltSha EQUALS mainline HEAD (trivially its own ancestor) ⇒ builtContentMatchesHead stays null — the ordinary case is answered by processBuiltShaMatchesHead/stale instead, not this field",
    r23c.processBuiltShaMatchesHead === true && r23c.builtContentMatchesHead === null);

  // ---- (23d) an UNRESOLVABLE processBuiltSha ⇒ null, never a fabricated verdict ----
  const r23d = computeDeployStaleness({ distEntry: caDistEntry, repoRoot: caRepo, processBuiltSha: "f".repeat(40), processBuiltDirty: false });
  check("(23d) an unresolvable processBuiltSha ⇒ builtContentMatchesHead:null (merge-base can't resolve it — degrades, never throws or fabricates)",
    r23d.builtContentMatchesHead === null);

  try { fs.rmSync(caRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(caDistDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // ===================== (24) Card 9aa4e2c9 — processStartedAt STABILITY across calls =====================
  {
    const originalDateNow = Date.now;
    const originalUptime = process.uptime;
    try {
      // ---- (24a) POSITIVE CONTROL — reproduce the REMOVED `Date.now() - process.uptime()*1000` formula
      // under a controlled wall/monotonic clock-rate mismatch: the wall clock advances 1000ms between the
      // two "reads" while the monotonic clock advances only 500ms — exactly the shape the module doc's
      // mechanism section describes (two independent clocks disagreeing). Values are chosen to multiply
      // exactly in IEEE-754 double precision (500.5 * 1000 has no rounding error), so the asserted 500ms
      // gap is exact, not an artifact of float noise.
      const baseWallMs = 1_800_000_000_000;
      let call = 0;
      Date.now = () => (call === 0 ? baseWallMs : baseWallMs + 1000);
      process.uptime = () => (call === 0 ? 500 : 500.5);
      const oldFormula = () => Date.now() - process.uptime() * 1000;
      call = 0;
      const oldT1 = oldFormula();
      call = 1;
      const oldT2 = oldFormula();
      check("(24a) POSITIVE CONTROL: the REMOVED `Date.now() - process.uptime()*1000` formula genuinely drifts (500ms) under a real wall/monotonic clock-rate mismatch — proves the check below is capable of failing, not vacuous", oldT2 - oldT1 === 500);

      // ---- (24b) THE FIX, exercised for real — two calls into the ACTUAL shipped computeDeployStaleness
      // (via the raw import, so NO processStartedAt override — this hits the real `performance.timeOrigin`
      // branch), under the SAME mocked Date.now/process.uptime skew that (24a) just proved drifts the old
      // formula. `performance.timeOrigin` never reads either mocked global, so this proves the fix is
      // structurally immune to this clock-skew class, not merely avoiding the specific numbers in (24a).
      call = 0;
      const r24First = computeDeployStalenessRaw({ distEntry, repoRoot: repo });
      call = 1;
      const r24Second = computeDeployStalenessRaw({ distEntry, repoRoot: repo });
      check("(24b) THE FIX: two calls in the same process return an IDENTICAL processStartedAt despite the SAME Date.now/process.uptime skew that (24a) just proved drifts the old formula" + reasonSuffix(r24First),
        r24First.processStartedAt !== null && r24First.processStartedAt === r24Second.processStartedAt);
    } finally {
      Date.now = originalDateNow;
      process.uptime = originalUptime;
    }
  }
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
  ? "\n✅ ALL PASS — computeDeployStaleness reads STALE and CLEAN correctly (both directions), excludes assets/docs-only commits (path-scoped, proven against a corpus that could have produced a false negative), counts multiple relevant commits, degrades gracefully (never throws) when unavailable, is derived fresh on every call with no cross-call caching, derives its build clock from the NEWEST mtime across the whole dist tree (daemon + shared) rather than one file (c1072385), that class of bug is demonstrated both on a controlled fixture and (when this checkout's own dist isn't uniformly-timed) on the real tree, (card c3ce92ea) the independent webStale/webCommitsBehind signal correctly flags a web-only commit as needing a rebuild WITHOUT ever perturbing the daemon-restart signal, in both directions, degrades gracefully when packages/web/dist is entirely missing, (card c241d54b) a dist dir that becomes unreadable after its own entry file was confirmed to exist ⇒ available:false, never a coerced epoch-0/invalid-date answer, and (card f26339d7) distBuiltSha reads the build-time-baked sha FRESH every call while processBuiltSha is a PURE echo of the caller-supplied processBuiltSha option (no caching inside computeDeployStaleness itself — see AMENDMENT 1), distBuiltShaDiffersFromProcess correctly flags a rebuild-without-restart in one call with no cache-timing race, both degrade to null/false gracefully when build-info.json or the override is absent, and deploySignatureMismatch correctly flags a simulated turbo cache-replay (mtime says fresh, the process's own baked sha proves it's genuinely behind) while staying false on a clean, matching process. (The 'captured once at REAL process start, frozen despite a later on-disk change' property this amendment introduces is proven separately, against the actual production module, by served-status-process-sha.mjs.) (Card 3d7dccb9) builtContentMatchesHead correctly resolves the one case a sha comparison can't — a real, non-ancestor divergent commit with identical shipped content reads NOT-stale-by-content, the same divergent shape with a real content difference still reads stale, both proven on a genuine git branch (not a hypothetical sha), the ordinary-ancestor case never spends the extra git calls (stays null), and an unresolvable sha degrades to null rather than a fabricated verdict. (Card 9aa4e2c9) processStartedAt is a STABLE, joinable stamp read once from performance.timeOrigin — proven by first showing the REMOVED Date.now()-minus-process.uptime() formula genuinely drifts under a controlled clock-rate mismatch (a positive control that can fail), then showing two real calls to the shipped code under that SAME mismatch return an identical value."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
