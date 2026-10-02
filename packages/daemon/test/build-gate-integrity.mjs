import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Build-gate integrity test (the `daemon_restart` deploy build). HERMETIC: NO real spawn, NO claude,
// NO live daemon — drives the restart module's deploy-build seam directly with a FAKE step runner, so
// it asserts the exact commands + flags + ordering without compiling or installing anything.
//
// Guards the two ways a BROKEN/STALE main could pass the deploy gate green (P1 6865de1f):
//   (A) a stale FULL TURBO cache replaying a green build over broken source → the build step must defeat
//       the cache with `--force` passed DIRECTLY to turbo (`node <turbo> build … --force`), NOT the
//       `pnpm run build --force` shape that forwards --force to vite and leaves the cache intact.
//   (B) a merged dep-add never linked → an INSTALL step (`pnpm install --frozen-lockfile`) must run
//       BEFORE the build, and a failing install must SHORT-CIRCUIT the build (don't compile a tree whose
//       deps aren't installed).
//   (C) card 0eb97fa1 — a FAILED build must not leave packages/web/dist wiped: turbo's `clean` task
//       (turbo.json) wipes web's dist unconditionally BEFORE build even attempts to run, so a build that
//       then fails (tests/typecheck/vite) currently leaves the daemon serving a broken/missing UI while
//       reporting itself healthy. buildDaemon snapshots dist before the "build" step and restores it on
//       failure / discards it on success — driven here via the `root` test seam so NOTHING touches the
//       real repo's packages/web/dist.
//   (D) card bde5d1fe item 4 — a QUARANTINED checkout (an earlier merge's orphaned process that could not
//       be confirmed dead may still be rewriting files in `root`) must refuse BEFORE install/build ever
//       runs — compiling a half-written tree is exactly the risk 24c0bdba's kill-confirm mechanism exists
//       to close everywhere else on the canonical-mutating path; the deploy build is no exception.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/build-gate-integrity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bgi-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { buildDaemon, deployBuildSteps, webDistBackupDir } = await import("../dist/orchestration/restart.js");
const { enterMergeQuarantine, clearMergeQuarantine } = await import("../dist/git/merge-quarantine.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (cond, timeoutMs, stepMs = 20) => {
  try {
    return !!(await sharedWaitUntil(cond, { timeoutMs, intervalMs: stepMs, label: "build-gate-integrity: cond" }));
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return cond();
  }
};

// Isolated fake repo root for the (C) snapshot/restore cases — NEVER the real repo's packages/web/dist.
const bgiRoot = path.join(os.tmpdir(), `loom-bgi-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const webDistDir = path.join(bgiRoot, "packages", "web", "dist");
const webDistFile = path.join(webDistDir, "index.html");
// Card 8e84e4a6: the backup dir is now PER-ATTEMPT (`web-dist-<attemptId>`, never a fixed path — see
// restart.ts's webDistBackupDir), so "no residue" is checked against the whole deploy-backup/ PARENT dir
// (any leftover web-dist-* subdir) rather than one hardcoded path that nothing would ever write to again.
const backupParentDir = path.join(process.env.LOOM_HOME, "deploy-backup");
const webDistBackupEntries = () => {
  try { return fs.readdirSync(backupParentDir).filter((n) => n.startsWith("web-dist-")); }
  catch { return []; }
};
const seedWebDist = () => {
  fs.rmSync(webDistDir, { recursive: true, force: true });
  fs.mkdirSync(webDistDir, { recursive: true });
  fs.writeFileSync(webDistFile, "ORIGINAL-UI");
};
seedWebDist();

try {
  // --- (steps) the deploy build is exactly [install, build], with the right flags ---
  const steps = deployBuildSteps("/repo/root");
  check("(steps) deploy build is two ordered steps: install then build",
    steps.length === 2 && steps[0].label === "install" && steps[1].label === "build");

  const install = steps[0];
  check("(B) install runs `pnpm install --frozen-lockfile` (frozen → reproducible, fail-closed on lockfile drift)",
    install.shell === true && /\bpnpm install\b/.test(install.command) && install.command.includes("--frozen-lockfile"));
  check("(B) install is BOUNDED (a hung registry fetch can't wedge the deploy)", install.timeoutMs > 0);

  const build = steps[1];
  check("(A) build invokes turbo via ABSOLUTE node (no shell, no PATH reliance — 51522f05-proof)",
    build.shell === false && build.command === process.execPath);
  check("(A) build passes `--force` DIRECTLY to turbo (cache-defeating), not to a build script",
    build.args.includes("--force") && build.args.some((a) => /turbo/.test(a)) && build.args.indexOf("--force") > build.args.findIndex((a) => /turbo/.test(a)));
  check("(A) build covers BOTH @loom/daemon and @loom/web (served UI can't go stale)",
    build.args.includes("--filter=@loom/daemon") && build.args.includes("--filter=@loom/web"));
  // Card 3d7dccb9 / 24f53a72 — "stamp" (turbo.json: cache:false, dependsOn:["build"]) must ride the SAME
  // turbo invocation as "build", right after it, so dist/build-info.json is always re-stamped from THIS
  // checkout's real HEAD. NOT merely "for consistency" with other build paths — since 24f53a72, "build"'s
  // own outputs glob EXCLUDES build-info.json ("!dist/build-info.json"), so "stamp" is that file's ONLY
  // writer, full stop; an invocation that omitted it (even --force'd) would leave build-info.json entirely
  // untouched rather than reflecting the just-built HEAD. See restart.ts's own comment, and deploy-staleness
  // .ts's module doc, for why --force alone was never enough (it doesn't stop "build"'s own successful-run
  // cache WRITE, which could poison a LATER, unrelated non-forced invocation's cache-hit read).
  check("(3d7dccb9) build ALSO runs the \"stamp\" task, positioned right after \"build\" (turbo's own dependsOn ordering, not this array's)",
    build.args.includes("stamp") && build.args.indexOf("stamp") === build.args.indexOf("build") + 1);
  // Card bce50c22 — "skills-sync" (turbo.json: cache:false, dependsOn:["build"], same shape as "stamp")
  // must ALSO ride this same invocation, or a deploy build could leave this checkout's .claude/skills
  // mirror unrefreshed after a merged assets/skills/** change (the sync used to run INSIDE the cached
  // "build" script and is now a separate uncached task that must be explicitly requested).
  check("(bce50c22) build ALSO runs the \"skills-sync\" task, right after \"stamp\"",
    build.args.includes("skills-sync") && build.args.indexOf("skills-sync") === build.args.indexOf("stamp") + 1);
  // The aad5fff3 footgun guard: the build must NOT be the `pnpm … build --force` shape (where --force
  // reaches vite, not turbo). Proven by the absence of a `pnpm`-script invocation in the command/args.
  check("(A) build is NOT the `pnpm run build --force` footgun shape (--force would forward to vite)",
    !/\bpnpm\b/.test(build.command) && !build.args.some((a) => /^pnpm$/.test(a)));

  // --- (order) a green run executes install BEFORE build and returns code 0 ---
  const calls = [];
  const okRunner = async (step) => { calls.push(step.label); return { code: 0, out: `${step.label} ok` }; };
  const green = await buildDaemon({ runStep: okRunner, root: bgiRoot });
  check("(order) green deploy runs install THEN build", JSON.stringify(calls) === JSON.stringify(["install", "build"]));
  check("(order) green deploy returns code 0", green.code === 0);
  check("(order) green tail is the BUILD step's output (last step)", green.tail === "build ok");

  // --- (B short-circuit) a failing install ABORTS before the build ---
  const calls2 = [];
  const installFails = async (step) => { calls2.push(step.label); return { code: 1, out: step.label === "install" ? "ERR_PNPM_OUTDATED_LOCKFILE" : "should-not-run" }; };
  const badInstall = await buildDaemon({ runStep: installFails, root: bgiRoot });
  check("(B) failing install short-circuits — build NEVER runs", JSON.stringify(calls2) === JSON.stringify(["install"]));
  check("(B) failing install returns non-zero", badInstall.code !== 0);
  check("(B) failing-install tail names the install step + the lockfile remediation",
    /install FAILED/.test(badInstall.tail) && /pnpm-lock\.yaml/.test(badInstall.tail) && /ERR_PNPM_OUTDATED_LOCKFILE/.test(badInstall.tail));

  // --- (A short-circuit) install green, build broken → deploy fails (a broken main can't pass green) ---
  const buildFails = async (step) => ({ code: step.label === "build" ? 2 : 0, out: step.label === "build" ? "TS2307: Cannot find module './new'" : "" });
  const badBuild = await buildDaemon({ runStep: buildFails, root: bgiRoot });
  check("(A) broken build (install green) returns non-zero — broken main can't verify green", badBuild.code === 2);
  check("(A) broken-build tail names the build step + surfaces the compiler error",
    /build FAILED/.test(badBuild.tail) && /TS2307/.test(badBuild.tail));

  // --- (empty output) a failed step with NO captured output still yields a debuggable tail ---
  const silentFail = await buildDaemon({ runStep: async () => ({ code: 1, out: "   " }), root: bgiRoot });
  check("(empty) a failed step with no output yields a debuggable '(no … output captured)' tail",
    /no install output captured/.test(silentFail.tail) && silentFail.code === 1);

  // --- (C) card 0eb97fa1 — a build that WIPES dist (simulating turbo's `clean` task) and then FAILS
  // must leave packages/web/dist RESTORED to its pre-build state, not missing. ---
  seedWebDist();
  const wipeThenFail = async (step) => {
    if (step.label === "build") {
      fs.rmSync(webDistDir, { recursive: true, force: true }); // what turbo's clean+broken-build does today
      return { code: 2, out: "TS2307: Cannot find module './new'" };
    }
    return { code: 0, out: "install ok" };
  };
  const wiped = await buildDaemon({ runStep: wipeThenFail, root: bgiRoot });
  check("(C) a build that wipes-then-fails still returns the non-zero code", wiped.code === 2);
  check("(C) packages/web/dist is RESTORED after a failed build that wiped it (not left missing)",
    fs.existsSync(webDistFile) && fs.readFileSync(webDistFile, "utf8") === "ORIGINAL-UI");
  check("(C) negative control: an ORDINARY successful restore never mentions the anomalous missing-snapshot wording",
    !/no longer present at restore time/.test(wiped.tail));

  // --- (C no-residue) a SUCCESSFUL deploy discards the pre-build snapshot — no leftover backup dir. ---
  seedWebDist();
  fs.rmSync(backupParentDir, { recursive: true, force: true });
  const okRunner2 = async (step) => ({ code: 0, out: `${step.label} ok` });
  const cleanGreen = await buildDaemon({ runStep: okRunner2, root: bgiRoot });
  check("(C no-residue) a successful deploy returns code 0", cleanGreen.code === 0);
  check("(C no-residue) a successful deploy leaves NO snapshot residue under LOOM_HOME (no leftover web-dist-* dir)",
    webDistBackupEntries().length === 0);

  // --- (C aged-sweep) Code Review, card 8e84e4a6: the sweep gates a removal on AGE, not merely "not my
  // attemptId" — a SUFFICIENTLY OLD orphan (a prior crashed deploy) is swept, but a YOUNG one (standing in
  // for another LIVE daemon's own still-in-progress attempt, since LOOM_HOME can be shared by more than
  // one daemon process) is left strictly alone. ---
  seedWebDist();
  const oldOrphan = path.join(backupParentDir, "web-dist-old-orphan");
  const youngOrphan = path.join(backupParentDir, "web-dist-young-orphan");
  fs.mkdirSync(oldOrphan, { recursive: true });
  fs.writeFileSync(path.join(oldOrphan, "marker.txt"), "old");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(oldOrphan, threeHoursAgo, threeHoursAgo); // backdate past STALE_WEB_DIST_BACKUP_AGE_MS (2h)
  fs.mkdirSync(youngOrphan, { recursive: true }); // left at its natural (just-created, i.e. "now") mtime
  fs.writeFileSync(path.join(youngOrphan, "marker.txt"), "young");
  const agedSweepResult = await buildDaemon({ runStep: okRunner2, root: bgiRoot, attemptId: "aged-sweep-attempt" });
  check("(C aged-sweep) deploy still succeeds", agedSweepResult.code === 0);
  check("(C aged-sweep) a SUFFICIENTLY OLD orphaned backup dir IS swept", !fs.existsSync(oldOrphan));
  check("(C aged-sweep) a YOUNG orphaned backup dir is left ALONE — proves the sweep discriminates on age, not just identity",
    fs.existsSync(youngOrphan));
  check("(C aged-sweep) and still leaves no residue of its OWN attempt dir either (excluding the deliberately-left-alone young orphan)",
    webDistBackupEntries().filter((n) => n !== "web-dist-young-orphan").length === 0);
  fs.rmSync(youngOrphan, { recursive: true, force: true }); // test-only cleanup — never swept by production code at this age

  // --- (C concurrent) TWO attempts genuinely overlapping in real wall-clock time never collide on each
  // other's own backup dir — proves the per-attempt snapshot/restore mechanism is safe in ISOLATION (not
  // merely because requestDaemonRestart's single-flight happens to prevent the overlap in practice). ---
  seedWebDist();
  let releaseConcurrentA;
  const concurrentGateA = new Promise((r) => { releaseConcurrentA = r; });
  let aEnteredBuild = false;
  const runStepA = async (step) => {
    if (step.label === "build") { aEnteredBuild = true; await concurrentGateA; }
    return { code: 0, out: `${step.label} ok` };
  };
  const pConcurrentA = buildDaemon({ runStep: runStepA, root: bgiRoot, attemptId: "concurrent-A" });
  await waitUntil(() => aEnteredBuild, 2000);
  check("(C concurrent) attempt A's own backup dir exists while A is still mid-build",
    fs.existsSync(webDistBackupDir("concurrent-A")));
  const concurrentBResult = await buildDaemon({ runStep: okRunner2, root: bgiRoot, attemptId: "concurrent-B" });
  check("(C concurrent) attempt B completes successfully WHILE A is still in flight", concurrentBResult.code === 0);
  check("(C concurrent) attempt B's OWN backup dir is cleanly discarded once it finishes",
    !fs.existsSync(webDistBackupDir("concurrent-B")));
  check("(C concurrent) attempt A's backup dir SURVIVED attempt B's entire run untouched — no collision in either direction",
    fs.existsSync(webDistBackupDir("concurrent-A")));
  releaseConcurrentA();
  const concurrentAResult = await pConcurrentA;
  check("(C concurrent) attempt A completes successfully once released", concurrentAResult.code === 0);
  check("(C concurrent) attempt A's own backup dir is also cleanly discarded once IT finishes",
    !fs.existsSync(webDistBackupDir("concurrent-A")));

  // --- (C missing-snapshot) Code Review, card 8e84e4a6: a snapshot WAS taken for this attempt but is gone
  // by restore time (e.g. external interference, or a sweep bug) — must be surfaced DISTINCTLY from the
  // ordinary "no snapshot was ever taken" no-op, never silently swallowed as if nothing were wrong. ---
  seedWebDist();
  const missingAttemptId = "missing-snapshot-attempt";
  const runStepRemoveBackup = async (step) => {
    if (step.label === "build") {
      fs.rmSync(webDistBackupDir(missingAttemptId), { recursive: true, force: true }); // simulate the snapshot vanishing after it was taken
      return { code: 2, out: "TS2307: Cannot find module './new'" };
    }
    return { code: 0, out: "install ok" };
  };
  const missingSnapshotResult = await buildDaemon({ runStep: runStepRemoveBackup, root: bgiRoot, attemptId: missingAttemptId });
  check("(C missing-snapshot) deploy still fails with the build step's own non-zero code", missingSnapshotResult.code === 2);
  check("(C missing-snapshot) the failure tail flags the anomalous missing snapshot distinctly from an ordinary no-op",
    /no longer present at restore time/.test(missingSnapshotResult.tail));

  // --- (C install-only) a failing INSTALL never touches dist — build (and its snapshot) never runs. ---
  seedWebDist();
  const installOnlyFails = async (step) => (step.label === "install" ? { code: 1, out: "ERR_PNPM_OUTDATED_LOCKFILE" } : { code: 0, out: "should-not-run" });
  await buildDaemon({ runStep: installOnlyFails, root: bgiRoot });
  check("(C install-only) dist is untouched when only install fails (build never runs)",
    fs.existsSync(webDistFile) && fs.readFileSync(webDistFile, "utf8") === "ORIGINAL-UI");

  // --- (D) card bde5d1fe item 4 — a quarantined `root` refuses BEFORE install/build ever runs ---
  seedWebDist();
  enterMergeQuarantine(bgiRoot, "unrelated-branch", "manufactured for SCENARIO D");
  const calls3 = [];
  const trackedRunner = async (step) => { calls3.push(step.label); return { code: 0, out: `${step.label} ok` }; };
  const quarantinedResult = await buildDaemon({ runStep: trackedRunner, root: bgiRoot });
  check("(D) a quarantined root refuses the deploy build (non-zero)", quarantinedResult.code !== 0);
  check("(D) neither install NOR build ever ran — refused before spending the cycle", calls3.length === 0);
  check("(D) the refusal names the quarantine in its tail", /quarantined/i.test(quarantinedResult.tail));
  check("(D) dist is untouched — never even reached the snapshot/build step", fs.existsSync(webDistFile) && fs.readFileSync(webDistFile, "utf8") === "ORIGINAL-UI");

  // NEGATIVE CONTROL: once cleared, the IDENTICAL call runs normally — proves (D)'s refusal above was the
  // quarantine specifically, not some unrelated defect vacuously failing every call.
  clearMergeQuarantine(bgiRoot);
  const calls4 = [];
  const trackedRunner2 = async (step) => { calls4.push(step.label); return { code: 0, out: `${step.label} ok` }; };
  const clearedResult = await buildDaemon({ runStep: trackedRunner2, root: bgiRoot });
  check("(D) control: once cleared, the SAME call succeeds and runs both steps", clearedResult.code === 0 && JSON.stringify(calls4) === JSON.stringify(["install", "build"]));
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  fs.rmSync(bgiRoot, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the deploy build installs (--frozen-lockfile) BEFORE it force-builds turbo directly, a failing install short-circuits the build, a broken build can't verify a broken main green, (card 3d7dccb9) the same invocation also runs the uncached \"stamp\" task right after \"build\", and (card bde5d1fe) a quarantined checkout refuses before either step runs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
