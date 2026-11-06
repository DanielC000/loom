import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// computeDeployStalenessAsync() — the request-serving (`served_status` REST + MCP) twin of
// computeDeployStaleness(). Its three unconditional git history reads run through async execFile instead of a
// synchronous execFileSync, so a slow-but-completing read can neither block the event loop nor be killed by
// the sync path's 1 s cap. HERMETIC: a throwaway git repo + dist fixture, driven through the exported seams
// (repoRoot/distEntry/sharedDist/webDist/processStartedAt) and the async-git test seam (`asyncGit`).
//
// Proves:
//   (1) EQUIVALENCE: with the real async git read, the async result deep-equals the sync result.
//   (2) NON-BLOCKING: against a stubbed 300 ms git, a 20 ms timer scheduled DURING the call fires BEFORE the
//       call resolves (a synchronous read would hold the loop and let the call resolve first).
//   (3) SUBSTITUTION: the async-read results are what the computation consumes (a distinctive fake HEAD sha
//       comes back verbatim) and exactly the three unconditional reads are issued.
//   (4) DEGRADE: a rejected async read degrades to the same available:false / could-not-measure shape.
//   (5) NO LEAK: after the async call (success or failure) the sync function reads the REAL git again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-dsan-"));
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { computeDeployStaleness, computeDeployStalenessAsync } = await import("../dist/deploy-staleness.js");
const execFileP = promisify(execFile);

const repo = path.join(tmpHome, "repo");
fs.mkdirSync(path.join(repo, "packages", "daemon", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "shared", "src"), { recursive: true });
fs.mkdirSync(path.join(repo, "packages", "web", "src"), { recursive: true });
const git = (args, env = {}) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } }).trim();
git("init -q");
git('config user.email t@loom'); git('config user.name t');
const commit = (rel, when) => {
  fs.writeFileSync(path.join(repo, rel), `// ${when}\n`);
  git(`add -A`);
  git(`commit -q -m "c ${rel}"`, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
};
commit("packages/daemon/src/a.ts", "2026-01-01T00:00:00Z");
commit("packages/web/src/w.ts", "2026-01-02T00:00:00Z");
commit("packages/shared/src/s.ts", "2026-01-03T00:00:00Z");

// dist built BEFORE the last commits so the signal has something to count (stale:true), via old mtimes.
const distDir = path.join(repo, "packages", "daemon", "dist");
const sharedDist = path.join(repo, "packages", "shared", "dist");
const webDist = path.join(repo, "packages", "web", "dist");
for (const d of [distDir, sharedDist, webDist]) fs.mkdirSync(d, { recursive: true });
const old = new Date("2026-01-01T12:00:00Z");
for (const f of [path.join(distDir, "index.js"), path.join(sharedDist, "x.js"), path.join(webDist, "index.html")]) {
  fs.writeFileSync(f, "x");
  fs.utimesSync(f, old, old);
}
const opts = {
  distEntry: path.join(distDir, "index.js"), repoRoot: repo, sharedDist, webDist,
  processStartedAt: "2026-01-04T00:00:00Z",
};
const realHead = git("rev-parse HEAD");

// A real async read, optionally delayed — the stand-in for "git is slow but completes".
const realAsyncGit = async (repoRoot, args) => (await execFileP("git", ["-C", repoRoot, ...args], { encoding: "utf8" })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- (1) equivalence
{
  const syncResult = computeDeployStaleness(opts);
  const asyncResult = await computeDeployStalenessAsync({ ...opts, asyncGit: realAsyncGit });
  check("(1) fixture is a real measurement (available:true, stale:true, commitsBehind 1, webCommitsBehind 1)", syncResult.available === true && syncResult.stale === true && syncResult.commitsBehind === 1 && syncResult.webCommitsBehind === 1);
  check("(1) async result deep-equals the sync result", JSON.stringify(asyncResult) === JSON.stringify(syncResult));
  const defaultSeam = await computeDeployStalenessAsync(opts); // the production execFile path, no stub
  check("(1) the production async read (no stub) deep-equals the sync result too", JSON.stringify(defaultSeam) === JSON.stringify(syncResult));
}

// ---- (2) non-blocking + (3) substitution
{
  const calls = [];
  const slowGit = async (repoRoot, args) => {
    calls.push(args);
    await sleep(300);
    const out = await realAsyncGit(repoRoot, args);
    // Distinctive HEAD so a fall-through to the real synchronous read cannot be mistaken for the stub.
    return args[0] === "log" && args[1] === "-1" ? out.replace(realHead, "f".repeat(40)) : out;
  };
  let timerFiredAtMs = null;
  const t0 = performance.now();
  setTimeout(() => { timerFiredAtMs = performance.now() - t0; }, 20);
  const result = await computeDeployStalenessAsync({ ...opts, asyncGit: slowGit });
  const resolvedAtMs = performance.now() - t0;
  check("(2) a 20 ms timer scheduled during the call fired BEFORE the call resolved (event loop was free)", timerFiredAtMs !== null && timerFiredAtMs < resolvedAtMs);
  check("(2) the call did wait for the slow git (resolved no sooner than the stub's 300 ms)", resolvedAtMs >= 280);
  check("(3) exactly the three unconditional history reads were issued", calls.length === 3 && calls.filter((a) => a[0] === "log").length === 3);
  check("(3) the async-read output is what the computation consumed (stub HEAD sha returned verbatim)", result.mainlineHeadSha === "f".repeat(40));
}

// ---- (4) degrade + (5) no leak
{
  const failing = async (repoRoot, args) => {
    if (args.includes("--max-count=2000") && args.includes("packages/daemon/src")) throw new Error("boom: simulated git failure");
    return realAsyncGit(repoRoot, args);
  };
  const degraded = await computeDeployStalenessAsync({ ...opts, asyncGit: failing });
  check("(4) a rejected history read degrades to available:false / could-not-measure", degraded.available === false && degraded.reasonKind === "could-not-measure" && /daemon-src\/shared commit history/.test(degraded.reason) && /boom/.test(degraded.reason));
  const after = computeDeployStaleness(opts);
  check("(5) after the async calls the sync function reads the REAL git again (no leaked substitution)", after.available === true && after.mainlineHeadSha === realHead);
}

try { cleanupPathSync(tmpHome); } catch { /* best effort */ }
console.log(failures === 0
  ? "\n✅ ALL PASS — computeDeployStalenessAsync matches the sync result, leaves the event loop free during slow git, substitutes exactly the three history reads, degrades on a failed read, and leaks nothing into the sync path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
