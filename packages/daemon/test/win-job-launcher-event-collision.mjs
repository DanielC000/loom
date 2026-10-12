import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1718416d — the ALREADY_EXISTS / squatted-abort-event-name test (manager constraint 1: "If
// CreateEvent returns ERROR_ALREADY_EXISTS, the launcher refuses to start the merge: it exits with a
// distinct code"). Drives the REAL binary directly with a DELIBERATELY REUSED nonce — the cheapest real
// repro of a name collision, since it needs no extra P/Invoke tooling: launcher instance A creates (and
// holds, via its own running git+hook) the nonce-derived event; instance B, started once A's event is
// OBSERVABLY ready (via the launcher's own `--probe` mode — round 2, MINOR b: replaces a fixed 150ms
// head start with a real readiness wait), must see ERROR_ALREADY_EXISTS and exit the launcher's single
// refusal code (0x4C4F0003, round 2 MAJOR 2 — formerly 216) WITHOUT ever spawning git.
// WINDOWS-ONLY, requires build:native. Full mechanism: docs/decisions/1718416d-win-job-launcher-containment.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-event-collision — win32-only (this host is '" + process.platform + "').");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(__dirname, "..", "assets", "native", "win-job-launcher.exe");
if (!fs.existsSync(EXE)) {
  console.log("SKIP  win-job-launcher-event-collision — win-job-launcher.exe not built. Run `pnpm --filter @loom/daemon build:native` first.");
  process.exit(0);
}

// round 3 (optional item): import the REAL exit-code constant from bounded.ts rather than keeping a
// second hand-copied literal — the former 216/250/251 refusal reasons all collapsed into this ONE
// value (round 2, MAJOR 2), moved out of 0-255 so it can never collide with git's own exit code. See
// native/win-job-launcher/launcher.cs's own file-header doc for the authoritative definition.
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { LAUNCHER_EXIT_REFUSED } = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-wjl-collide-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
  return repo;
}

function spawnLauncher(repo, nonce, msg) {
  return new Promise((resolve) => {
    const child = spawn(EXE, ["run", nonce, "commit", "--allow-empty", "-m", msg], { cwd: repo, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** round 2, MINOR b: `--probe` is a pure existence check (never calls SetEvent — see launcher.cs's own
 *  doc), so it can be polled with no side effect on the instance being checked. Replaces a fixed 150ms
 *  head start with a real readiness wait: "has instance A actually created its event yet?" */
async function waitForEventReady(nonce, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await new Promise((resolve) => {
      const probe = spawn(EXE, ["--probe", nonce], { windowsHide: true });
      probe.on("close", resolve);
      probe.on("error", () => resolve(-1));
    });
    if (code === 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function run() {
  const nonce = crypto.randomBytes(16).toString("hex");
  const repoA = makeRepo("a");
  const repoB = makeRepo("b");

  // A runs a slow (1s) hook so it still holds the event when B starts.
  const hookPath = path.join(repoA, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\nsleep 1\nexit 0\n");
  fs.chmodSync(hookPath, 0o755);

  const promiseA = spawnLauncher(repoA, nonce, "collision case A");
  // round 2, MINOR b: wait for an OBSERVABLE readiness signal (A's event actually existing), never a
  // fixed sleep — a fixed wait here could race A on a slow/loaded host exactly like the fixed-wait guard
  // this project runs at the merge gate warns against for a NEGATIVE assertion, and while this one isn't
  // a negative assertion, a late-firing B due to a too-short fixed sleep would silently stop testing the
  // actual collision this test exists to prove.
  const ready = await waitForEventReady(nonce);
  check("instance A's abort event is observably ready before B races in (no fixed sleep)", ready);
  const resultB = await spawnLauncher(repoB, nonce, "collision case B");
  const resultA = await promiseA;

  check("instance A (first to the nonce): ran git normally, exit 0", resultA.code === 0);
  check("instance B (collided on the SAME nonce): refused with the single refusal code", resultB.code === LAUNCHER_EXIT_REFUSED);

  const logA = execFileSync("git", ["log", "--oneline", "-1", "--format=%s"], { cwd: repoA, encoding: "utf8" }).trim();
  check("instance A: its own commit landed", logA === "collision case A");
  let logBFailed = false;
  try { execFileSync("git", ["log", "-1"], { cwd: repoB, encoding: "utf8" }); } catch { logBFailed = true; }
  check("instance B: git was NEVER spawned — repoB has no commits at all", logBFailed);

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
