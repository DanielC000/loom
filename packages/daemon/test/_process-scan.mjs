// Shared test-only helper: enumerate live processes on the host, filter/confirm by identity, and kill
// only what's been positively confirmed. See decision 4e026f35's "Test-suite process-scan notes" section
// for the full rationale (why a command-line substring scan can't see a leaked detached grandchild, the
// path-boundary hazard in the cmdline-scoped scan, and the pid-reuse risk this gates against).
// @decision 4e026f35
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import { commandLineOf, matchesRecordedEntry, normalizeCmdlinePath } from "../../../bin/lib/cmdline-identity.mjs";

const ENUM_TIMEOUT_MS = 20_000; // raised from 8s — timed out once under real gate load
const ENUM_RETRY_ATTEMPTS = 1; // ONE retry on a transient timeout/failure before failing closed

function enumerateWindows() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }"],
      { timeout: ENUM_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); },
    );
  });
}

function enumeratePosix() {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-eo", "pid=,ppid=,command="],
      { timeout: ENUM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); },
    );
  });
}

function parseWindows(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf("|");
    const second = trimmed.indexOf("|", first + 1);
    if (first === -1 || second === -1) continue;
    out.push({
      pid: Number(trimmed.slice(0, first)),
      ppid: Number(trimmed.slice(first + 1, second)),
      commandLine: trimmed.slice(second + 1),
    });
  }
  return out;
}

function parsePosix(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] });
  }
  return out;
}

async function enumerateOnce() {
  if (process.platform === "win32") return parseWindows(await enumerateWindows());
  return parsePosix(await enumeratePosix());
}

/**
 * Enumerate every live process on the host as `{pid, ppid, commandLine}`. Bounded, with ONE retry on a
 * transient failure/timeout (observed once under real gate load) before failing CLOSED — throws a clear,
 * labeled Error rather than letting a raw execFile timeout surface as an unhandled rejection partway
 * through a caller's assertions.
 * @returns {Promise<{pid:number, ppid:number, commandLine:string}[]>}
 */
export async function enumerateAllProcesses() {
  let lastErr;
  for (let attempt = 1; attempt <= ENUM_RETRY_ATTEMPTS + 1; attempt++) {
    try {
      return await enumerateOnce();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`[_process-scan] process enumeration failed after ${ENUM_RETRY_ATTEMPTS + 1} attempt(s) on ${process.platform}: ${lastErr?.message ?? lastErr}`);
}

// A bare `.includes()` substring match makes a LOOM_HOME like `...\.loom` also match
// `...\.loom-worktrees\...` (every worker's own worktree root) — `.loom` is a strict PREFIX of
// `.loom-worktrees`, not a path component on its own. Require a real boundary on the side where that
// hazard lives: the matched substring must be followed by a path separator, a quote, whitespace (an
// ordinary space/tab-delimited unquoted argument, e.g. `--home <home> --flag`), or the end of the string —
// never by an ordinary path/filename character. Both sides go through `cmdline-identity.mjs`'s
// `normalizeCmdlinePath` first (collapses `\` vs `/`, lowercases on win32 only), so the home's own
// separator spelling need not match the live command line's — after that normalization every separator is
// `/`, so the boundary set below checks for `/`, never `\`.
function isPathBoundaryChar(ch) {
  return ch === undefined || ch === "/" || ch === '"' || ch === "'" || ch === " " || ch === "\t";
}
export function commandLineReferencesPath(commandLine, pathSubstring) {
  if (!pathSubstring) return false;
  const cmd = normalizeCmdlinePath(commandLine);
  const target = normalizeCmdlinePath(pathSubstring);
  let fromIndex = 0;
  for (;;) {
    const i = cmd.indexOf(target, fromIndex);
    if (i === -1) return false;
    if (isPathBoundaryChar(cmd[i + target.length])) return true;
    fromIndex = i + 1; // the substring could also occur elsewhere, at a real boundary
  }
}

/**
 * Returns every currently-live process whose command line references `pathSubstring` at a real path
 * boundary (see `commandLineReferencesPath`) — as `{pid, commandLine}`. Cross-platform. Bounded — throws
 * if the enumeration itself hangs or errors after its retry, rather than silently reporting "found none"
 * on a failed scan.
 * @param {string} pathSubstring
 * @returns {Promise<{pid:number, commandLine:string}[]>}
 */
export async function liveProcessesReferencing(pathSubstring) {
  const all = await enumerateAllProcesses();
  return all.filter((p) => commandLineReferencesPath(p.commandLine, pathSubstring)).map(({ pid, commandLine }) => ({ pid, commandLine }));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

async function waitUntilDead(pid, { pollMs = 150, maxWaitMs = 3_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  return !isAlive(pid);
}

/**
 * Cross-platform exact-pid TREE kill — never by name/port/command-line pattern, only an exact pid (CLAUDE.md's
 * "discriminate on worktree path or a captured pid" rule applied here: this IS a captured pid, read back
 * from the leaked process's own pid-file record). win32: `taskkill /PID <pid> /T /F` (kills the whole
 * descendant tree). POSIX: SIGKILL the process GROUP first (`-pid` — correct when the target was spawned
 * `detached:true`, which makes it its own session/group leader, exactly how scripts/daemon-supervisor.mjs
 * and bin/loom.mjs's startDetached both spawn) then the bare pid as a fallback for a target that wasn't.
 * Best-effort: a target already gone (or never alive) is not an error.
 * @param {number} pid
 */
export function killPidTree(pid) {
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* no such group, or already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * `killPidTree`, VERIFIED: polls for the target to actually die and stops there. Deliberately does NOT
 * follow up with any downward `ParentProcessId`-chain sweep for a surviving descendant — see decision
 * 4e026f35's "Round 5 correction: no downward PPID sweep" for why (removed entirely after a review found
 * it could tree-kill unrelated long-lived processes, `Explorer.EXE` among them, on Windows). The
 * cmdline-scoped secondary scan (`liveProcessesReferencing`) is the accepted, documented straggler check
 * instead — a straggler that never references the test's own scratch LOOM_HOME substring is a residual
 * this module does not try to close.
 * @decision 4e026f35
 * @param {number} pid
 * @returns {Promise<{dead:boolean}>}
 */
export async function killPidTreeVerified(pid) {
  killPidTree(pid);
  const dead = await waitUntilDead(pid);
  return { dead };
}

function readPidFileRecord(pidFilePath) {
  try {
    const rec = JSON.parse(fs.readFileSync(pidFilePath, "utf8"));
    if (rec && Number.isInteger(rec.pid)) return rec;
  } catch { /* missing, partially-written, or malformed — treated as "not written yet" */ }
  return null;
}

// A pid is just a number the OS can recycle — a dead record's pid may since have been
// reused by an unrelated process. Before killing anything, confirm the LIVE command line actually
// contains the record's own `entry` field (same shape as daemon-supervisor-stop.mjs's `isOurSupervisor` /
// bin/loom.mjs's `isOurDaemon`). No `entry` recorded, or no match ⇒ REFUSE — never guess.
function confirmRecordIdentity(rec) {
  if (!rec.entry) return false;
  return matchesRecordedEntry(commandLineOf(rec.pid), rec.entry);
}

async function actOnPidRecord(rec) {
  if (!confirmRecordIdentity(rec)) {
    return { found: true, pid: rec.pid, identityConfirmed: false, killed: false };
  }
  const killResult = await killPidTreeVerified(rec.pid);
  return { found: true, pid: rec.pid, identityConfirmed: true, killed: true, ...killResult };
}

/**
 * Polls `pidFilePath` for a valid `{pid, entry}` record and, the INSTANT one appears, confirms its
 * identity against its own `entry` field (see `confirmRecordIdentity`) and — only if confirmed —
 * immediately TREE-kills that exact pid, verified (`killPidTreeVerified`) — argv/env-independent, and
 * (unlike waiting out a hard bound) it fires well before any slow work the owning process might be doing
 * (e.g. a deliberately-slowed build in a RED proof) has a chance to complete. Start this BEFORE the
 * bounded action you're racing it against so both run concurrently, and call `cancel()` once that action
 * has settled — an expected-refused run (no pid file ever written) would otherwise poll for the FULL
 * `maxWaitMs` for no reason.
 * @param {string} pidFilePath
 * @param {{ pollMs?: number, maxWaitMs: number }} opts
 * @returns {{ promise: Promise<{found: boolean, pid: number|null, identityConfirmed?: boolean|null, killed?: boolean}>, cancel: () => void }}
 */
export function watchPidFileAndKill(pidFilePath, { pollMs = 200, maxWaitMs }) {
  let cancelled = false;
  const promise = (async () => {
    const deadline = Date.now() + maxWaitMs;
    while (!cancelled && Date.now() < deadline) {
      const rec = readPidFileRecord(pidFilePath);
      if (rec) return await actOnPidRecord(rec);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // One last check — covers the instant between the final poll and cancellation/deadline, so a
    // same-tick race between the caller's cancel() and a just-written pid file isn't missed.
    const rec = readPidFileRecord(pidFilePath);
    if (rec) return await actOnPidRecord(rec);
    return { found: false, pid: null, identityConfirmed: null };
  })();
  return { promise, cancel: () => { cancelled = true; } };
}
