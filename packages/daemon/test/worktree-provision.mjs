// Worktree dep-provisioning test (task 650bb061). Proves the two load-bearing properties of the
// at-creation `pnpm install`:
//   (i)  after createWorktree a pnpm-workspace worktree is BUILD-READY (its own node_modules exists),
//        so the worker doesn't pay a full install before it can build;
//   (ii) removeWorktree on a worktree-WITH-node_modules leaves the MAIN checkout's node_modules fully
//        intact — the skill-store-nuke / junction-follow landmine: a frozen `pnpm install` gives each
//        worktree its OWN independent node_modules (NOT a junction into main), so the recursive fs.rm in
//        removeWorktree can never reach the main checkout. (A future regression to a junction WOULD nuke
//        main here.)
// Plus the bounded/best-effort gates that keep this off the daemon's hang surface.
//
// HERMETIC: a real temp pnpm workspace with NO external deps (only a workspace-internal dep) → the
// initial `pnpm install` and createWorktree's provisioning are fully OFFLINE, into a temp store dir, so
// the test never touches the network or the user's global store. LOOM_HOME is set BEFORE importing dist/*
// so WORKTREES_DIR is isolated (paths.ts reads it at module load).
// Run: 1) pnpm build, 2) node packages/daemon/test/worktree-provision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const stamp = Date.now();
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wtp-home-${stamp}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Keep pnpm fully hermetic: a temp store-dir (createWorktree's provisioner inherits process.env, so it
// resolves to the same store) + offline. With zero external deps nothing is fetched anyway.
const storeDir = path.join(os.tmpdir(), `loom-wtp-store-${stamp}`);
process.env.npm_config_store_dir = storeDir;

const { createWorktree, removeWorktree, provisionWorktreeDeps } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-wtp-repo-${stamp}`);

// pnpm must be on PATH (it is in the build gate's env). If not, SKIP rather than false-fail a weird env.
const pnpmProbe = spawnSync("pnpm --version", { shell: true, stdio: "ignore" });
if (pnpmProbe.status !== 0) {
  console.log("SKIP  pnpm not on PATH — cannot exercise real dep provisioning in this environment.");
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  process.exit(0);
}

try {
  // --- a real temp pnpm workspace: two packages, a → b (workspace:*), NO external deps (offline-installable) ---
  fs.mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages", "b"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"),
    JSON.stringify({ name: "wtp-fixture", private: true, version: "0.0.0" }, null, 2));
  fs.writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "packages", "a", "package.json"),
    JSON.stringify({ name: "@wtp/a", version: "0.0.0", dependencies: { "@wtp/b": "workspace:*" } }, null, 2));
  fs.writeFileSync(path.join(repo, "packages", "b", "package.json"),
    JSON.stringify({ name: "@wtp/b", version: "0.0.0" }, null, 2));

  // Generate pnpm-lock.yaml + a warm node_modules in the MAIN checkout (offline; no external deps).
  execSync("pnpm install --prefer-offline", { cwd: repo, stdio: "ignore", env: process.env });
  check("(setup) main checkout got a pnpm-lock.yaml", fs.existsSync(path.join(repo, "pnpm-lock.yaml")));
  check("(setup) main checkout got node_modules", fs.existsSync(path.join(repo, "node_modules")));

  execSync(`git init -q && git add . && git -c user.email=wtp@loom -c user.name=wtp commit -qm "init"`, { cwd: repo });

  // (i) BUILD-READY: createWorktree provisions the worktree's own node_modules (no worker install needed).
  const { worktreePath } = await createWorktree(repo, "projWTP", "build-ready-aaaa-1111");
  check("(i) worktree dir exists", fs.existsSync(worktreePath));
  check("(i) worktree node_modules populated at creation (build-ready, no worker install)",
    fs.existsSync(path.join(worktreePath, "node_modules")));
  check("(i) worktree's internal .pnpm virtual store exists (real install, not an empty dir)",
    fs.existsSync(path.join(worktreePath, "node_modules", ".pnpm")));
  check("(i) workspace dep linked in the worktree (packages/a → @wtp/b resolvable)",
    fs.existsSync(path.join(worktreePath, "packages", "a", "node_modules", "@wtp", "b")));

  // (ii) LANDMINE: removeWorktree must NOT touch the MAIN checkout's node_modules. Drop a sentinel inside
  //      main/node_modules; provision a second worktree (so it has its OWN node_modules), remove it, and
  //      assert main + sentinel survive. With independent node_modules this holds; a junction-into-main
  //      regression would delete the sentinel (and main) here.
  const sentinel = path.join(repo, "node_modules", "LANDMINE_SENTINEL.txt");
  fs.writeFileSync(sentinel, "do-not-delete\n");
  const mainNmRealBefore = fs.realpathSync(path.join(repo, "node_modules"));

  const { worktreePath: wt2 } = await createWorktree(repo, "projWTP", "landmine-bbbb-2222");
  check("(ii setup) 2nd worktree also has its own node_modules", fs.existsSync(path.join(wt2, "node_modules")));
  // sanity: the worktree's node_modules is a DIFFERENT real path from main's (not a link INTO main).
  check("(ii) worktree node_modules is independent of main's (not a junction into main)",
    fs.realpathSync(path.join(wt2, "node_modules")) !== mainNmRealBefore);

  await removeWorktree(repo, wt2);
  check("(ii) worktree removed", !fs.existsSync(wt2));
  check("(ii) MAIN checkout node_modules SURVIVES removeWorktree", fs.existsSync(path.join(repo, "node_modules")));
  check("(ii) MAIN checkout sentinel SURVIVES (removal did not follow into main)", fs.existsSync(sentinel));

  // (iii) GATE: provisioning is a silent no-op on a non-pnpm dir (no pnpm-lock.yaml) — this is why every
  //       bare-temp-repo test keeps byte-identical behavior. Must NOT throw, must NOT create node_modules.
  const bare = path.join(repo, "bare-no-pnpm");
  fs.mkdirSync(bare, { recursive: true });
  await provisionWorktreeDeps(bare); // no lockfile → skipped
  check("(iii) non-pnpm dir: provisioning is a no-op (no node_modules created, no throw)",
    !fs.existsSync(path.join(bare, "node_modules")));

  // (iv) BEST-EFFORT + BOUNDED: a provisioner that throws or hangs must NOT escape provisionWorktreeDeps.
  //      Inject fakes (needs a lockfile present to pass the gate → run against the real worktree dir).
  let threwResolved = false;
  await provisionWorktreeDeps(worktreePath, { provision: async () => { throw new Error("boom"); } })
    .then(() => { threwResolved = true; });
  check("(iv) a throwing provisioner is swallowed (createWorktree never aborts)", threwResolved);

  const t0 = Date.now();
  let hangResolved = false;
  await provisionWorktreeDeps(worktreePath, {
    provision: (_wt, ms) => new Promise((res) => setTimeout(() => res({ ok: false, reason: "slow" }), ms + 50)),
    timeoutMs: 200,
  }).then(() => { hangResolved = true; });
  check("(iv) a slow/failing provisioner returns (best-effort, degrades to worker-installs-itself)", hangResolved);
  check(`(iv) the injected timeoutMs is threaded through to the provisioner`, Date.now() - t0 >= 200);

  // (v) NON-PNPM DISPATCH (claude-free + offline via the ProvisionDeps seam): the broadened
  //     provisionWorktreeDeps must fire the RIGHT installer off the lockfile marker — npm marker → npm,
  //     yarn marker → yarn — and stay a no-op with no marker. We inject a recording provisioner so no real
  //     npm/yarn ever runs (and none need be installed); it captures the `manager` 3rd arg the dispatch
  //     passes. DETERMINISTIC precedence (pnpm > npm > yarn) is asserted by a dir carrying ALL THREE locks.
  const markerDir = (name, files) => {
    const d = path.join(repo, name);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), "");
    return d;
  };
  const recordDispatch = async (dir) => {
    const calls = [];
    await provisionWorktreeDeps(dir, { provision: async (_wt, _ms, manager) => { calls.push(manager); return { ok: true }; } });
    return calls;
  };

  check("(v) npm marker (package-lock.json) → npm installer fires",
    JSON.stringify(await recordDispatch(markerDir("only-npm", ["package-lock.json"]))) === JSON.stringify(["npm"]));
  check("(v) yarn marker (yarn.lock) → yarn installer fires",
    JSON.stringify(await recordDispatch(markerDir("only-yarn", ["yarn.lock"]))) === JSON.stringify(["yarn"]));
  check("(v) no recognized lockfile → no-op (provisioner never called)",
    JSON.stringify(await recordDispatch(markerDir("only-readme", ["README.md"]))) === JSON.stringify([]));
  check("(v) deterministic precedence: pnpm wins over npm+yarn when all three coexist",
    JSON.stringify(await recordDispatch(markerDir("all-three", ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]))) === JSON.stringify(["pnpm"]));
  check("(v) precedence: npm wins over yarn when both (no pnpm) coexist",
    JSON.stringify(await recordDispatch(markerDir("npm-and-yarn", ["package-lock.json", "yarn.lock"]))) === JSON.stringify(["npm"]));

  // (vi) NON-PNPM DEGRADE: an npm/yarn install that fails (returns {ok:false}) OR throws must be SWALLOWED,
  //      never escaping provisionWorktreeDeps — best-effort, the worker installs on its own. Exercised on an
  //      npm-marked dir so it goes through the real (non-pnpm) dispatch branch.
  const npmDir = markerDir("degrade-npm", ["package-lock.json"]);
  let npmFailResolved = false;
  await provisionWorktreeDeps(npmDir, { provision: async () => ({ ok: false, reason: "npm ci exited 1" }) })
    .then(() => { npmFailResolved = true; });
  check("(vi) a failing npm/yarn provisioner DEGRADES (best-effort, createWorktree never aborts)", npmFailResolved);
  let npmThrewResolved = false;
  await provisionWorktreeDeps(npmDir, { provision: async () => { throw new Error("yarn boom"); } })
    .then(() => { npmThrewResolved = true; });
  check("(vi) a throwing npm/yarn provisioner is swallowed (never throws past createWorktree)", npmThrewResolved);

  // cleanup the first worktree.
  await removeWorktree(repo, worktreePath);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree leaves a pnpm worktree BUILD-READY (own node_modules) without a worker install, removeWorktree CANNOT touch the main checkout's node_modules (landmine guarded), provisioning is a no-op off-pnpm, and the install is best-effort + bounded (a throw/hang degrades instead of wedging the spawn path)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
