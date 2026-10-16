import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs + a real turbo spawn against an isolated fixture
// Card ec6ead9d — REAL-SPAWN proof that the deploy build's cache-defeating flag (read off the REAL
// `deployBuildSteps()` production function, never hand-typed) genuinely still defeats the cache READ the
// same way the old `--force` did, while ALSO writing no new cache entry. build-gate-integrity.mjs already
// asserts the flag's STRING is present in deployBuildSteps' output (hermetic, no real spawn); this test
// is the complementary real-spawn proof that the flag actually BEHAVES as claimed. NEVER runs against the
// real repo's shared `.turbo/cache` (turbo 2.x shares that directory across every git worktree of this
// repo) — the fixture here is its own disposable git repo with its own `--cache-dir`, under the OS temp
// dir, removed in a `finally`. See docs/decisions/ec6ead9d-bound-turbo-cache-growth.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-dbcf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { deployBuildSteps } = await import("../dist/orchestration/restart.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Read the REAL flag + the REAL resolved turbo binary path off the REAL production function — never
// hand-typed or re-resolved — so this test can't silently drift from whatever restart.ts actually ships.
const realBuildStep = deployBuildSteps("/unused/fake/root").find((s) => s.label === "build");
const turboBinPath = realBuildStep.args[0];
const cacheFlag = realBuildStep.args.find((a) => a.startsWith("--cache="));
check("(setup) deployBuildSteps' real \"build\" step resolves an absolute turbo binary path",
  typeof turboBinPath === "string" && fs.existsSync(turboBinPath));
check("(setup) it carries a --cache= flag to test",
  typeof cacheFlag === "string" && cacheFlag.length > 0);
check("(setup) it is NOT the old --force (sanity: this test would be proving nothing against --force)",
  !realBuildStep.args.includes("--force"));

const root = path.join(os.tmpdir(), `loom-dbcf-${Date.now()}-${process.pid}`);
const cacheDir = path.join(root, ".turbo-cache-test");

try {
  fs.mkdirSync(path.join(root, "packages", "pkg-a"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "deploy-build-cache-flag-fixture-root", private: true, workspaces: ["packages/*"], packageManager: "npm@10.0.0",
  }));
  fs.writeFileSync(path.join(root, "turbo.json"), JSON.stringify({
    $schema: "https://turbo.build/schema.json",
    tasks: { build: { outputs: ["dist/**"] } },
  }));
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "package.json"), JSON.stringify({
    name: "pkg-a", version: "1.0.0", private: true, scripts: { build: "node build.js" },
  }));
  // turbo's content hashing is git-based and includes UNTRACKED working-tree files, not just committed
  // ones — confirmed directly: turbo ALSO writes its own per-package `.turbo/turbo-build.log` (content
  // differs every run), which, left untracked, perturbed every "rebuild"'s hash and made it wrongly
  // cache-miss every time. Both the build's own OUTPUT (dist/, exec-count.txt) AND turbo's own `.turbo/`
  // log dir must be gitignored for an ordinary rebuild's hash to be stable.
  fs.writeFileSync(path.join(root, ".gitignore"), ".turbo/\n.turbo-cache-test/\n");
  fs.writeFileSync(path.join(root, "packages", "pkg-a", ".gitignore"), "dist/\nexec-count.txt\n.turbo/\n");
  // The build script's own real side effect (an incrementing exec-count file) is the ground truth for
  // "did the real command actually run", independent of — and more reliable than — turbo's own console
  // banner wording (which this test also checks, but a wording change upstream shouldn't alone flip this).
  fs.writeFileSync(path.join(root, "packages", "pkg-a", "build.js"),
    'const fs=require("fs"),path=require("path");' +
    'const p=path.join(__dirname,"exec-count.txt");' +
    'let n=0;try{n=parseInt(fs.readFileSync(p,"utf8"),10)||0;}catch{}' +
    'n+=1;fs.writeFileSync(p,String(n));' +
    'fs.mkdirSync(path.join(__dirname,"dist"),{recursive:true});' +
    'fs.writeFileSync(path.join(__dirname,"dist","out.txt"),`built ${n} times`);');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "loom-test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "loom-test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", os.devNull], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, stdio: "ignore" });

  const execCountPath = path.join(root, "packages", "pkg-a", "exec-count.txt");
  const readExecCount = () => { try { return parseInt(fs.readFileSync(execCountPath, "utf8"), 10) || 0; } catch { return 0; } };
  const cacheEntries = () => { try { return fs.readdirSync(cacheDir); } catch { return []; } };
  // Mirrors restart.ts's own no-shell invocation shape (decision 51522f05): absolute node + absolute
  // turbo JS, args array, no shell.
  const runBuild = (...extraArgs) =>
    execFileSync(process.execPath, [turboBinPath, "build", `--cache-dir=${cacheDir}`, ...extraArgs], { cwd: root, encoding: "utf8" });

  // --- STEP 1: ordinary build populates the cache (cache miss, executes) ---
  const out1 = runBuild();
  check("(1) first build genuinely executes (exec-count advances to 1)", readExecCount() === 1);
  check("(1) first build reports a cache MISS, not a hit", /cache miss, executing/.test(out1));
  const filesAfter1 = cacheEntries();
  check("(1) first build populates the cache directory", filesAfter1.length > 0);

  // --- STEP 2: an ORDINARY second build (no cache-defeating flag) is a genuine cache HIT — positive
  // control proving this fixture's cache plumbing actually works before trusting step 3's "no hit" result. ---
  const out2 = runBuild();
  check("(2 control) an ordinary rebuild is a real cache HIT (FULL TURBO)", /cache hit, replaying logs/.test(out2) && /FULL TURBO/.test(out2));
  check("(2 control) exec-count does NOT advance on a cache hit (the script genuinely did not re-run)", readExecCount() === 1);
  check("(2 control) cache directory is unchanged by a hit (no new file written)", cacheEntries().length === filesAfter1.length);

  // --- STEP 3: the REAL deploy flag — must behave like --force (genuinely re-executes, no FULL TURBO/
  // cache-hit-replaying banner) while ALSO writing no new cache entry (unlike --force). Capture mtimes
  // BEFORE this step so "no write" can be proven as "untouched", not merely "same file count" (a same-
  // count overwrite-in-place would pass a count-only check but still be a write). ---
  const mtimesBefore3 = new Map(filesAfter1.map((f) => [f, fs.statSync(path.join(cacheDir, f)).mtimeMs]));
  const out3 = runBuild(cacheFlag);
  check("(3) the real deploy flag makes the build genuinely RE-EXECUTE (exec-count advances to 2)", readExecCount() === 2);
  check("(3) no FULL TURBO banner — this was not served from cache", !/FULL TURBO/.test(out3));
  check("(3) no \"cache hit, replaying logs\" — turbo did not treat this as a hit", !/cache hit, replaying logs/.test(out3));
  const filesAfter3 = cacheEntries();
  check("(3) the real deploy flag writes NO new cache entry (file count unchanged from step 1/2)",
    filesAfter3.length === filesAfter1.length);
  check("(3) and every existing cache file's mtime is UNCHANGED (not even overwritten in place with identical content)",
    filesAfter3.length === mtimesBefore3.size
      && filesAfter3.every((f) => mtimesBefore3.has(f) && fs.statSync(path.join(cacheDir, f)).mtimeMs === mtimesBefore3.get(f)));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the real deploy build flag (read off deployBuildSteps itself) genuinely defeats the cache READ exactly like --force did, while writing no new cache entry, on a real turbo spawn against an isolated fixture."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
