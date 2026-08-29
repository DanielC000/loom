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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/build-gate-integrity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bgi-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { buildDaemon, deployBuildSteps } = await import("../dist/orchestration/restart.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Isolated fake repo root for the (C) snapshot/restore cases — NEVER the real repo's packages/web/dist.
const bgiRoot = path.join(os.tmpdir(), `loom-bgi-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const webDistDir = path.join(bgiRoot, "packages", "web", "dist");
const webDistFile = path.join(webDistDir, "index.html");
const backupDir = path.join(process.env.LOOM_HOME, "deploy-backup", "web-dist");
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

  // --- (C no-residue) a SUCCESSFUL deploy discards the pre-build snapshot — no leftover backup dir. ---
  seedWebDist();
  fs.rmSync(backupDir, { recursive: true, force: true });
  const okRunner2 = async (step) => ({ code: 0, out: `${step.label} ok` });
  const cleanGreen = await buildDaemon({ runStep: okRunner2, root: bgiRoot });
  check("(C no-residue) a successful deploy returns code 0", cleanGreen.code === 0);
  check("(C no-residue) a successful deploy leaves NO snapshot residue under LOOM_HOME",
    !fs.existsSync(backupDir));

  // --- (C install-only) a failing INSTALL never touches dist — build (and its snapshot) never runs. ---
  seedWebDist();
  const installOnlyFails = async (step) => (step.label === "install" ? { code: 1, out: "ERR_PNPM_OUTDATED_LOCKFILE" } : { code: 0, out: "should-not-run" });
  await buildDaemon({ runStep: installOnlyFails, root: bgiRoot });
  check("(C install-only) dist is untouched when only install fails (build never runs)",
    fs.existsSync(webDistFile) && fs.readFileSync(webDistFile, "utf8") === "ORIGINAL-UI");
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  fs.rmSync(bgiRoot, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the deploy build installs (--frozen-lockfile) BEFORE it force-builds turbo directly, a failing install short-circuits the build, a broken build can't verify a broken main green, and (card 3d7dccb9) the same invocation also runs the uncached \"stamp\" task right after \"build\"."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
