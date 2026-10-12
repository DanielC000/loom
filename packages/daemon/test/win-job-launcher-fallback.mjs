import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1718416d — proves the MANDATORY fallback contract: with win-job-launcher.exe unavailable, a
// canonical git call on win32 must behave BYTE-IDENTICALLY to pre-1718416d code — the taskkill-based
// kill-confirm path (24c0bdba) fires, an unconfirmed kill still quarantines the repo (merge-quarantine.ts),
// and nothing about that path changed. Full mechanism: docs/decisions/1718416d-win-job-launcher-containment.md.
//
// WINDOWS-ONLY (the fallback IS the posix path there — nothing to isolate). Forces the fallback via
// `setWinJobLauncherOverrideForTest(null)` — NEVER renames/unlinks/overwrites the REAL
// win-job-launcher.exe. That file backs the self-hosting daemon from this SAME canonical checkout's
// package path; the merge gate runs test files concurrently (a parallel lane would lose it mid-run);
// and a gate-timeout SIGKILL skips both `try/finally` and any `process.on("exit")` hook, leaving it
// permanently renamed with the daemon silently on the fallback forever. See
// docs/decisions/1718416d-win-job-launcher-containment.md's "Do not" for this exact hazard.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-fallback — win32-only (this host is '" + process.platform + "'); the fallback IS the only path on POSIX, nothing to isolate.");
  process.exit(0);
}

// Hermetic: the fallback path raises a REAL, durable merge-quarantine latch under LOOM_HOME.
useOwnLoomHome("loom-wjl-fallback-");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { killableCanonicalRaw, treeDeathUnconfirmed, setWinJobLauncherOverrideForTest } =
  await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);
const EXE = path.join(__dirname, "..", "assets", "native", "win-job-launcher.exe");

const exeExistedAtStart = fs.existsSync(EXE);
const exeHashAtStart = exeExistedAtStart ? crypto.createHash("sha256").update(fs.readFileSync(EXE)).digest("hex") : null;

if (!exeExistedAtStart) {
  console.log("SKIP  win-job-launcher-fallback — win-job-launcher.exe not built (nothing to force-unavailable against, meaningfully). Run `pnpm --filter @loom/daemon build:native` first.");
  process.exit(0);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo() {
  const repo = mkdtempManaged("loom-wjl-fb-");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
  return repo;
}

// round 2, MAJOR 4 ("ALSO"): the double-fork hook below deliberately leaves a real `sleep 25` alive — the
// fallback (taskkill /T) is documented NOT to reliably catch it. Clean it up at the end, scoped to its
// own real pid, never by image name (CLAUDE.md's process-cleanup rule) — same technique
// win-job-launcher-spawn.mjs uses: the hook reports its own MSYS pid (via `$BASHPID`, NEVER `$$` — POSIX
// `$$` does not change inside a `( ... )` subshell in bash, so it would silently report the TOP-LEVEL
// hook's own pid instead of the actual forked tail; verified directly in a standalone repro) to a file,
// resolved to a real Win32 pid via MSYS's `/proc/<pid>/winpid` emulation (only visible to an MSYS-aware
// process, hence `sh -c`).
const TAIL_PID_FILE = "wjl-tail.pid";
async function waitForMsysPid(repo, fileName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const file = path.join(repo, fileName);
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const n = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}
async function winPidFromMsysPid(msysPid) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", `cat /proc/${msysPid}/winpid 2>/dev/null`]);
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
async function killWinPid(winPid) {
  try { await execFileAsync("taskkill", ["/F", "/PID", String(winPid)]); } catch { /* already gone */ }
}

async function run() {
  setWinJobLauncherOverrideForTest(null); // force unavailable — never touches the real file
  try {
    const repo = makeRepo();
    // The real double-forked hook that Job Object containment exists to catch — with the launcher
    // unavailable, this must fall back to the taskkill tree-kill (24c0bdba), whose own documented
    // residual (b966962b) is that this EXACT shape is NOT reliably confirmable. Unconfirmed is the
    // CORRECT, expected outcome here — proving the fallback is live, not a regression.
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hookPath, `#!/bin/sh\n( ( echo $BASHPID > ${TAIL_PID_FILE}; exec sleep 25 ) & ) &\nsleep 1\nexit 0\n`);
    fs.chmodSync(hookPath, 0o755);

    let threw = null;
    try {
      await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "fallback case"], 800, "wjl-fallback-case");
    } catch (e) { threw = e; }
    check("launcher unavailable: a hard-to-contain double-fork hook still rejects (today's exact behavior)", threw !== null);
    // docs/decisions/b966962b's own finding: this EXACT double-fork shape is the one taskkill /T
    // reliably loses on Windows, so an UNCONFIRMED verdict here is the correct, expected pre-1718416d
    // outcome — proving the fallback is genuinely live and unchanged, not a false "it just worked".
    // `killableCanonicalRaw` itself only THROWS the tagged error — raising a quarantine from a
    // treeDeathUnconfirmed catch is the CALLER's job (mergeBranchLocked etc., per docs/decisions/
    // 24c0bdba), already covered by merge-commit-kill-confirm.mjs; this test's scope is narrower:
    // proving the fallback produces the SAME tagged-error shape that quarantine machinery keys off.
    check("launcher unavailable: taskkill path reports treeDeathUnconfirmed for this shape", threw !== null && treeDeathUnconfirmed(threw));

    // Clean up the real survivor the fallback (correctly, per b966962b) could not catch — scoped to its
    // own real pid, never by image name, so it can't pollute a concurrent lane on a shared host.
    const tailMsysPid = await waitForMsysPid(repo, TAIL_PID_FILE);
    const tailWinPid = tailMsysPid !== null ? await winPidFromMsysPid(tailMsysPid) : null;
    if (tailWinPid !== null) await killWinPid(tailWinPid);
  } finally {
    setWinJobLauncherOverrideForTest(undefined); // clear the override — resumes checking the real path
  }

  // The real exe was NEVER touched by this file — assert it, not just assume it.
  const exeExistedAtEnd = fs.existsSync(EXE);
  check("the real win-job-launcher.exe still exists after this test", exeExistedAtEnd);
  if (exeExistedAtEnd) {
    const exeHashAtEnd = crypto.createHash("sha256").update(fs.readFileSync(EXE)).digest("hex");
    check("the real win-job-launcher.exe's content hash is UNCHANGED (this test never touched the real file)", exeHashAtEnd === exeHashAtStart);
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
