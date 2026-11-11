import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 66ebb36c — boot Phase 0's `.json.tmp-safety-<pid>-<hex>` residue must stay BOUNDED across reboots,
// and no token may be lost on any boot. Growth was observed as 2 -> 4 -> 3 -> 3 on ad7fd1ca and
// 1 -> 2 -> 3 on 2ba1f25e, in the shape below; main stopped growing once d694e77d (card 43cf3b26,
// plural `resolvedKeys` persisted at a boot collision) landed. This file is the regression pin: the growth
// is real across REAL reboots (a fresh process per boot, same LOOM_HOME), not an artifact of calling the
// boot function repeatedly in one process.
//
// SHAPE (K = canonicalRepoLockKey(W), W a real git repo):
//   X = W/gone-subdir (never created) -> sha(K).json                 tokens [X-tok], resolvedKey K
//   Y = W/gone-two    (never created) -> sha(K).json.tmp-99999       tokens [Y-tok], resolvedKey K
//   W (a real repo)                   -> ffff...ff.json (stale name) tokens [W-tok]
//
// TWO SCENARIOS, differing only in which paths the boot is told are registered:
//   x-y-registered   registered = [X, Y]    -> the growth shape (one safety-tmp per boot kept growing)
//   w-x-y-registered registered = [W, X, Y] -> a different disk outcome; Y-tok was LOST on ad7fd1ca/2ba1f25e
// EVERY boot, in EVERY scenario, asserts every seeded token is still present in SOME file in the
// quarantine dir (the safety-tmp is often the sole durable copy; it must never be swept), that the
// safety-tmp count never exceeds 1, never rises from one boot to the next, and has stopped changing by the
// last two boots.
//
// Run: 1) pnpm build  2) node test/merge-quarantine-66ebb36c-boot-safety-tmp-bounded.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { finishAndExit, mkdtempManaged, useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distGitDir = path.join(__dirname, "..", "dist", "git");
const bootArg = process.argv.find((a) => a.startsWith("--boot="));

if (bootArg) {
  // CHILD MODE — ONE boot, in a fresh process. LOOM_HOME arrives from the driver's env (reused unchanged).
  useOwnLoomHome("loom-66ebb36c-boot-");
  requireHermeticEnv();
  const registered = JSON.parse(bootArg.slice("--boot=".length));
  const { reenterMergeQuarantinesAtBootTestOnly } = await import(pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href);
  reenterMergeQuarantinesAtBootTestOnly(registered, []);
  process.exit(0);
}

// DRIVER MODE
useOwnLoomHome("loom-66ebb36c-");
requireHermeticEnv();
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

const BOOTS = 6;
const GIT_ID = "-c user.email=mq66ebb36c@loom -c user.name=mq66ebb36c";
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const hashForKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const SAFETY_TMP = /\.json\.tmp-safety-\d+-[0-9a-f]+$/;

function makeRepo() {
  const repo = mkdtempManaged("loom-66ebb36c-repo-");
  fs.writeFileSync(path.join(repo, "README.md"), "# 66ebb36c\n");
  execSync("git init -q && git config user.email mq66ebb36c@loom && git config user.name mq66ebb36c", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function tokensOnDisk(dir) {
  const found = new Set();
  for (const f of fs.readdirSync(dir)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    for (const t of parsed?.tokens ?? []) found.add(t);
  }
  return found;
}

function runScenario(name, registeredKeys) {
  console.log(`\n=== SCENARIO ${name} (fresh process per boot, own LOOM_HOME) ===`);
  const home = mkdtempManaged("loom-66ebb36c-home-");
  const qdir = path.join(home, "merge-quarantines");
  fs.mkdirSync(qdir, { recursive: true });
  const w = makeRepo();
  const k = canonicalRepoLockKey(w);
  const paths = { W: w, X: path.join(w, "gone-subdir"), Y: path.join(w, "gone-two") };
  const rec = (repoPath, token, extra = {}) => JSON.stringify({
    repoPath, branch: `b-${token}`, reason: "66ebb36c repro", enteredAt: Date.now(), tokens: [token], ...extra,
  }, null, 2) + "\n";
  fs.writeFileSync(path.join(qdir, `${hashForKey(k)}.json`), rec(paths.X, "X-tok", { resolvedKey: k }));
  fs.writeFileSync(path.join(qdir, `${hashForKey(k)}.json.tmp-99999`), rec(paths.Y, "Y-tok", { resolvedKey: k }));
  fs.writeFileSync(path.join(qdir, `${"f".repeat(24)}.json`), rec(paths.W, "W-tok"));
  check(`(precondition) ${name}: X and Y are unresolvable, W is a real repo sharing their key`,
    !fs.existsSync(paths.X) && !fs.existsSync(paths.Y) && canonicalRepoLockKey(paths.X) === k && canonicalRepoLockKey(paths.Y) === k);
  check(`(precondition) ${name}: all three seeded tokens are on disk before boot 1`,
    ["X-tok", "Y-tok", "W-tok"].every((t) => tokensOnDisk(qdir).has(t)));

  const { LOOM_HOME: _ambient, ...envWithoutHome } = process.env;
  const registered = registeredKeys.map((key) => paths[key]);
  const counts = [];
  for (let boot = 1; boot <= BOOTS; boot++) {
    execFileSync(process.execPath, [__filename, `--boot=${JSON.stringify(registered)}`], {
      env: { ...envWithoutHome, LOOM_HOME: home }, stdio: ["ignore", "ignore", "ignore"],
    });
    const files = fs.readdirSync(qdir);
    const safety = files.filter((f) => SAFETY_TMP.test(f)).length;
    counts.push(safety);
    const present = tokensOnDisk(qdir);
    const missing = ["X-tok", "Y-tok", "W-tok"].filter((t) => !present.has(t));
    check(`${name} boot ${boot}: every seeded token still on disk (missing: ${JSON.stringify(missing)}; files=${files.length}, safety-tmp=${safety})`, missing.length === 0);
  }
  console.log(`${name}: safety-tmp count per boot = ${JSON.stringify(counts)}`);
  check(`*** ${name}: safety-tmp count never exceeds 1 on any boot`, counts.every((c) => c <= 1));
  check(`*** ${name}: safety-tmp count never rises from one boot to the next`, counts.every((c, i) => i === 0 || c <= counts[i - 1]));
  check(`*** ${name}: safety-tmp count has converged by the last two boots`, counts[BOOTS - 1] === counts[BOOTS - 2]);
}

runScenario("x-y-registered", ["X", "Y"]);
runScenario("w-x-y-registered", ["W", "X", "Y"]);

console.log(failures === 0
  ? "\n✅ boot safety-tmp residue stays bounded and no token is lost across reboots"
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 66ebb36c.`);
await finishAndExit(failures === 0 ? 0 : 1);
