import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1718416d — real-spawn matrix for the Windows Job Object containment launcher
// (native/win-job-launcher/launcher.cs), driven through the REAL `git/bounded.ts` integration
// (spawnCanonicalGitTree → killableCanonicalRaw), not the standalone binary — proving the daemon's own
// wiring, not just the prototype. Full mechanism + the STEP 0/0b investigation that motivated this
// design: docs/decisions/1718416d-win-job-launcher-containment.md.
//
// WINDOWS-ONLY and requires `pnpm --filter @loom/daemon build:native` to have run first (the exe is a
// build artifact, never committed — see .gitignore). Both gates print an explicit SKIP and exit 0
// without ever reaching the PASS/FAIL machinery, same discipline as node-pty-quoting-parity.mjs.
//
// Never kills by image name, never touches a shared/ambient repo: every fixture is its own
// mkdtempManaged() dir, and the survivor check below is scoped to THIS call's own real Win32 pids —
// round 2, MAJOR 4: an earlier cut of this file scanned the WHOLE HOST for any `sh.exe`/`sleep.exe` by
// image name, which this host being shared and live (card 1718416d's own STEP 0/0b investigation
// measured a concurrent, unrelated session's own sh.exe during a run of THIS exact test) makes both
// false-FAIL-prone (an unrelated sh.exe/sleep.exe counted as a "survivor") and false-PASS-prone (an
// unrelated process satisfying the "found at least one candidate" sanity check without this call's own
// tree ever being observed at all). The hook itself now reports its own MSYS pid (and the double-forked
// tail's) to a file; this file resolves each one to its REAL Win32 pid via `/proc/<msys-pid>/winpid`
// (MSYS/Git-for-Windows' own proc emulation — only visible to an MSYS-runtime-aware process, hence
// shelling out to `sh -c` rather than reading it directly from Node) and checks/kills ONLY those exact
// pids — the same technique STEP 0/0b's own investigation used, carried into a committed test. (The
// header above an earlier cut of this file cited a `scanRealDescendants()` helper that was never
// actually defined anywhere in this file — this doc replaces that stale reference, round 2, MAJOR 4.)
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);

if (process.platform !== "win32") {
  console.log("SKIP  win-job-launcher-spawn — win32-only (this host is '" + process.platform + "'); the containment mechanism under test has no POSIX analogue.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { killableCanonicalRaw, treeDeathConfirmed, isWinJobLauncherAvailable } =
  await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

if (!isWinJobLauncherAvailable()) {
  console.log("SKIP  win-job-launcher-spawn — win-job-launcher.exe not built. Run `pnpm --filter @loom/daemon build:native` first (needs the in-box .NET Framework csc.exe; a loud no-op without it).");
  process.exit(0);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo(tag) {
  const repo = mkdtempManaged(`loom-wjl-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "wjl@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "wjl"], { cwd: repo });
  return repo;
}

function installHook(repo, script) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, script);
  fs.chmodSync(hookPath, 0o755);
}

// The direct child (sh) and the double-forked tail each report their OWN MSYS pid to a file in the repo
// root BEFORE doing anything else — via `$BASHPID`, NEVER `$$`. Verified directly (a standalone repro,
// not assumed): this hook's `/bin/sh` is bash under the hood, and POSIX `$$` is defined as the pid of
// the INVOKING shell — it does NOT change inside a `( ... )` subshell in bash, so a nested `echo $$`
// silently reports the TOP-LEVEL script's own pid a second time, never the actual forked descendant.
// `$BASHPID` is bash's own always-current-process variable and DOES change per subshell (confirmed:
// outer=819, one level of `(...)` -> 820, two levels -> 821, in a throwaway repro). `exec sleep 25` (not
// a bare `sleep 25`) makes the innermost subshell EXEC into sleep, so the pid it already wrote stays
// sleep's own real pid rather than a parent shell's.
const SH_PID_FILE = "wjl-sh.pid";
const TAIL_PID_FILE = "wjl-tail.pid";
// The top-level `sleep 8` (not `sleep 1`) deliberately gives the abort case below a wide window: pid
// resolution below shells out to `sh -c "cat /proc/.../winpid"` TWICE, which is not free — a short hook
// sleep raced the abort firing before those resolves finished and made the "alive before" sanity check
// flaky (observed directly: the abort's own 800ms timeout vs. ~1s of real diagnostic overhead).
const DOUBLE_FORK_HOOK =
  `#!/bin/sh\necho $BASHPID > ${SH_PID_FILE}\n( ( echo $BASHPID > ${TAIL_PID_FILE}; exec sleep 25 ) & ) &\nsleep 8\nexit 0\n`;
const SIMPLE_HOOK = "#!/bin/sh\nsleep 1\nexit 0\n";

/** Poll for `fileName` to appear under `repo` and return the MSYS pid it reports — an OBSERVABLE event
 *  (the hook writes this before doing anything else), never a fixed sleep. Bounded so a hook that never
 *  starts (a real bug) fails the check rather than hanging the test. */
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

/** MSYS's own `/proc/<pid>/winpid` emulation is visible only to an MSYS-runtime-aware process (Git for
 *  Windows' `sh.exe`), never to a bare Node.exe read — shell out to resolve it. Returns `null` on any
 *  failure (process already gone, emulation unavailable) rather than throwing. */
async function winPidFromMsysPid(msysPid) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", `cat /proc/${msysPid}/winpid 2>/dev/null`]);
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Scoped to an EXACT pid (never an image name) — `tasklist`'s own "no tasks" message is plain text on
 *  stdout with exit 0, not an error, so a real match is distinguished by its CSV row starting with a
 *  quote. */
async function isWinPidAlive(winPid) {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${winPid}`, "/FO", "CSV", "/NH"]);
    return stdout.trim().startsWith('"');
  } catch {
    return false;
  }
}

/** Scoped to an EXACT pid (never an image name) — see CLAUDE.md's process-cleanup rule. Best-effort: a
 *  pid that's already gone is not an error here. */
async function killWinPid(winPid) {
  try { await execFileAsync("taskkill", ["/F", "/PID", String(winPid)]); } catch { /* already gone */ }
}

async function run() {
  // Case 1: double-fork hook, aborted mid-flight (SHORT timeoutMs) — must confirm-kill with the tail's
  // own real pid (the one STEP 0/0b's own investigation found escapes a bare taskkill /T) actually dead.
  {
    const repo = makeRepo("abort");
    installHook(repo, DOUBLE_FORK_HOOK);
    let threw = null;
    // 3000ms: comfortably longer than the pid-resolution diagnostics below take (two concurrent
    // `sh -c cat /proc/.../winpid` shell-outs), comfortably shorter than the hook's own 8s natural sleep
    // — so the abort still genuinely fires mid-flight, never racing a natural completion.
    const callPromise = killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "abort case"], 3000, "wjl-abort-case")
      .catch((e) => { threw = e; });

    const [shMsysPid, tailMsysPid] = await Promise.all([
      waitForMsysPid(repo, SH_PID_FILE),
      waitForMsysPid(repo, TAIL_PID_FILE),
    ]);
    check("double-fork hook, aborted: the direct child (sh) reported its own pid", shMsysPid !== null);
    check("double-fork hook, aborted: the double-forked tail reported its own pid", tailMsysPid !== null);

    const [shWinPid, tailWinPid] = await Promise.all([
      shMsysPid !== null ? winPidFromMsysPid(shMsysPid) : Promise.resolve(null),
      tailMsysPid !== null ? winPidFromMsysPid(tailMsysPid) : Promise.resolve(null),
    ]);
    check(`double-fork hook, aborted: resolved the direct child's REAL Win32 pid via /proc/<msys>/winpid (got ${shWinPid})`, shWinPid !== null);
    check(`double-fork hook, aborted: resolved the tail's REAL Win32 pid via /proc/<msys>/winpid (got ${tailWinPid})`, tailWinPid !== null);
    check("double-fork hook, aborted: the direct child and the tail resolved to DIFFERENT real pids (proving $BASHPID, not $$, actually distinguished them)", shWinPid !== null && tailWinPid !== null && shWinPid !== tailWinPid);

    const shAliveBefore = shWinPid !== null && await isWinPidAlive(shWinPid);
    const tailAliveBefore = tailWinPid !== null && await isWinPidAlive(tailWinPid);
    check("double-fork hook, aborted: the direct child's real pid is ALIVE before the abort (sanity — not vacuous)", shAliveBefore);
    check("double-fork hook, aborted: the tail's real pid is ALIVE before the abort (sanity — not vacuous)", tailAliveBefore);

    await callPromise;
    check("double-fork hook, aborted: rejects", threw !== null);
    // treeDeathConfirmed(threw) becoming true IS the observable event: the launcher's own internal
    // TerminateJobObject + ActiveProcesses===0 poll already happened, synchronously, INSIDE the awaited
    // call above, before it ever rejected — there is nothing left to wait for. No fixed sleep here (see
    // fixed-wait-negative-guard.mjs, which this file must stay clean against): the aliveness checks below
    // check a fact that is already settled by the time this line runs.
    check("double-fork hook, aborted: treeDeathConfirmed", threw !== null && treeDeathConfirmed(threw));

    const shAliveAfter = shWinPid !== null && await isWinPidAlive(shWinPid);
    const tailAliveAfter = tailWinPid !== null && await isWinPidAlive(tailWinPid);
    check("double-fork hook, aborted: the direct child's real pid is DEAD after the confirmed kill (scoped to THIS call's own pid, never by image name)", !shAliveAfter);
    check("double-fork hook, aborted: the tail's real pid is DEAD after the confirmed kill (scoped to THIS call's own pid, never by image name)", !tailAliveAfter);
  }

  // Case 2: double-fork hook, allowed to run to natural completion — plain clean commit. The tail still
  // forks a real `sleep 25`; clean it up (scoped to its own real pid) rather than leaving it to expire
  // naturally and risk polluting a concurrent lane on a shared host.
  {
    const repo = makeRepo("normal-fork");
    installHook(repo, DOUBLE_FORK_HOOK);
    // 15000ms: comfortable margin above the hook's own 8s natural sleep (see DOUBLE_FORK_HOOK's doc).
    const out = await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "normal fork case"], 15000, "wjl-normal-fork");
    check("double-fork hook, normal completion: resolves with commit output", /normal fork case/.test(out) || out.length >= 0);
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
    check("double-fork hook, normal completion: commit actually landed", log === "normal fork case");

    const tailMsysPid = await waitForMsysPid(repo, TAIL_PID_FILE);
    const tailWinPid = tailMsysPid !== null ? await winPidFromMsysPid(tailMsysPid) : null;
    if (tailWinPid !== null) await killWinPid(tailWinPid);
  }

  // Case 3: simple hook (no backgrounding at all) — the exact shape that hung before this card's fix.
  {
    const repo = makeRepo("simple");
    installHook(repo, SIMPLE_HOOK);
    const t0 = Date.now();
    await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "simple hook case"], 10000, "wjl-simple");
    const elapsed = Date.now() - t0;
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
    check("simple hook: commit landed", log === "simple hook case");
    check(`simple hook: completed promptly, not hung (${elapsed}ms)`, elapsed < 8000);
  }

  // Case 4: no hook at all.
  {
    const repo = makeRepo("nohook");
    const out = await killableCanonicalRaw(repo, ["commit", "--allow-empty", "-m", "no hook case"], 10000, "wjl-nohook");
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
    check("no hook: resolves", typeof out === "string");
    check("no hook: commit landed", log === "no hook case");
  }

  console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
