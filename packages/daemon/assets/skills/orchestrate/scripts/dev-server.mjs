#!/usr/bin/env node
// Launch a worktree dev-server, track the EXACT child process handle/pid it spawns, and tear it down
// by that same tracked handle on demand — so eyeballing a worktree's live app never needs a hand-rolled
// `netstat` + `taskkill` hunt (a state-word grep silently false-zeros under locale/codepage — a
// port/PID grep is unaffected — and a name/port-based kill can reach an
// unrelated process — even the self-hosting daemon itself). Dependency-free: only node:child_process/
// node:fs/node:os/node:path/node:crypto, so it runs anywhere Node runs, no install step. Mirrors
// serve-static.mjs in this same scripts/ dir (single-purpose, no deps, tracked-pid start/stop) — both
// record their port to the SAME kind of tracking file, so a consumer reads one place regardless of
// which helper launched the server; see PORT DETECTION below for why the mechanism differs.
//
// Usage:
//   <dir> MUST be an absolute path in every invocation (start AND stop) — never a relative one. A
//   relative <dir> resolves against THIS PROCESS's own cwd, which can silently differ between calls and
//   key the same logical directory under two different tracking files (or the reverse: the same tracking
//   file used by two different directories); see requireAbsoluteDir's own comment for the failure modes.
//   `start`/`stop` both refuse (nonzero exit, no tracking file touched) rather than resolve a relative
//   <dir> against cwd.
//
//   node dev-server.mjs start <dir> -- <command> [args...]
//     Spawns <command> with cwd=<dir>, detached from THIS process so it outlives it, and prints:
//       Started "<command...>" in <dir> (pid <pid>)
//       Log: <path to the child's captured stdout/stderr>
//       Stop with: node dev-server.mjs stop <dir>
//       Bound: <url> (recorded to the tracking file)   [or a "not detected" note — see below]
//     Records {pid, command, dir, startedAt, logFile, port, host, url} to a tracking file keyed off
//     <dir>'s absolute path (see trackingFilePath) so a LATER, separate `stop` invocation — even from a
//     different shell — can find and kill EXACTLY this process. `port`/`host`/`url` start `null` and are
//     filled in once the child's own startup banner (e.g. Vite's "Local: http://localhost:5173/")
//     appears in its captured output — see PORT DETECTION below. **A consumer must use `url` AS GIVEN,
//     never rebuild it from `port` alone** — the banner's reported HOST is captured alongside the port
//     precisely because a bare port doesn't determine a reachable URL: the same port can be reachable at
//     `127.0.0.1` on one server and refuse that same address while answering at `[::1]` (or vice versa)
//     on another, entirely healthy one — the binding is the server's own choice, and guessing wrong reads
//     as "the server didn't start" against a server that's fine. `host` is the same value made directly
//     usable (see the `0.0.0.0` note below); `url` is `host`+`port` already assembled — use it verbatim.
//     Refuses to start a second tracked server over an already-tracked, still-alive one for the same
//     <dir>; stop the first one before starting another.
//
//   node dev-server.mjs stop <dir>
//     Reads the tracking file for <dir>, kills the tracked pid (+ its process tree) BY THAT EXACT PID,
//     and removes the tracking file. A no-op (exit 0) if no tracked server is found for <dir> — this
//     never enumerates processes and never searches by name or port. Prints the tracked port (when
//     known) alongside the pid, re-read fresh from the tracking file in this separate process.
//
// PORT DETECTION — why this differs from serve-static.mjs even though its OWN detached child still
// spawns with `stdio: "ignore"` (unchanged there — see that file's own start()):
// serve-static.mjs *is* the server, so it knows its own bound port the instant `listen()`'s callback
// fires and can write it straight to its tracking file. This helper spawns an ARBITRARY command (vite,
// next, webpack-dev-server, …) that picks its own port and steps to the next free one under contention —
// there is no API to ask a foreign pid "what port did you bind," so the only generic signal available is
// the child's own startup banner, captured to a log file and polled for a `host:port` pattern common to
// most dev-server banners.
//
// SUPERVISOR — why the CAPTURE ITSELF needs an extra hop, not just a log file: the naive version (spawn
// the real command directly, as the tracked+detached process, with its stdio wired straight to a log
// file's fd) silently loses the output on Windows. Verified against a real spawn, repeatedly: a process
// created with `detached:true` (Windows gives it its own new console) that itself needs a shell — cmd.exe
// — to resolve a `.cmd`/`.ps1` shim (pnpm, npm, …), and THAT shell then spawns the real target as a
// GRANDCHILD, loses that grandchild's stdout/stderr no matter how the redirection is wired: a real fd
// handed to the top-level spawn, `stdio:"ignore"` plus cmd.exe's own `>logfile 2>&1` redirection syntax —
// both tested, both silently empty, even though the grandchild itself runs to completion successfully
// (proven by having it write a sentinel file directly). Quoting isn't the culprit either — an UNQUOTED,
// no-spaces, PATH-resolved command (`node --version`) run the same way loses its output too; only a
// direct, non-shell, single-hop child (no cmd.exe, no grandchild) keeps it. Since a shell is genuinely
// needed here (`.cmd`/`.ps1` shim resolution is the whole reason `shell:win32` exists in this file), the
// fix is to make the DETACHED, TRACKED process a small supervisor rather than the real command: `start`
// spawns `node -e <SUPERVISOR_CODE> <payload>` directly (no shell — `process.execPath` is a real, directly
// executable path, so Windows launches it via a normal argv-array CreateProcess call that needs no manual
// quoting even though the path itself commonly contains spaces, e.g. "C:\Program Files\nodejs\node.exe").
// That supervisor is the ONLY detached hop; it then spawns the REAL command as its own ordinary
// (non-detached) child — using the exact same shell/quoting rules this file already has for win32 — and
// pipes THAT child's stdout+stderr into the log file using Node's own stream API (`child.stdout.pipe`),
// which only depends on the supervisor being an ordinary running process talking to its own immediate
// child, never on OS-level handle inheritance across more than one hop. `stop`'s tracked-pid kill still
// reaches the real command exactly as before: `taskkill /T` on win32 kills the supervisor's whole subtree
// (verified: killing the supervisor's pid this way took the real command's own process down with it), and
// on POSIX the supervisor's non-detached child simply inherits the same new process group `detached:true`
// already gave the supervisor, so `killTracked`'s `-pid` group-kill reaches it too — unchanged.
//
// Bounded (LOOM_DEV_SERVER_PORT_TIMEOUT_MS, default 15000ms) so a framework that never announces a port —
// or is just slow to boot — doesn't hang `start` forever; on timeout the tracking file's `port`/`host`/
// `url` stay `null` for good (nothing keeps polling the log after `start`'s own process exits) and the
// printed log path is the fallback — grep it directly once the child catches up, or raise the timeout if
// this framework is just slow to boot.
// SAFETY (the reason this helper exists): `stop` only ever acts on the pid THIS SAME HELPER recorded
// in `start` for that exact <dir> — never a name/port/netstat search, never a bash `$!` (which on
// Windows is the shell's pid, not the real listener). It never touches any process it didn't itself
// spawn. ACCEPTED RISK: if the tracked pid has since exited and the OS reused that number for an
// unrelated process, `stop` would signal that unrelated process instead — a generic pid-reuse race any
// pid-tracking scheme has. This is judged acceptable here because the intended lifetime of a tracked
// dev-server (an interactive eyeball session, stopped promptly after) is short relative to typical OS
// pid-reuse windows, and the alternative (re-verifying identity via process enumeration) reintroduces
// the exact OS-enumeration blind spot — win32 exposes no per-process cwd — this handle-tracked design
// exists to avoid.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = path.basename(fileURLToPath(import.meta.url));

function usageAndExit() {
  console.error(`Usage:\n  node ${SELF} start <dir> -- <command> [args...]\n  node ${SELF} stop <dir>`);
  process.exit(1);
}

// Tracking file (and its sibling log file, below) live in the OS temp dir, keyed off the worktree's
// absolute path — never inside the worktree itself, so neither is ever mistaken for part of the tree
// (git status, the merge gate, …) and both survive independently of whether the worktree dir itself is
// later removed.
function pathHash(absDir) {
  return crypto.createHash("sha256").update(absDir).digest("hex").slice(0, 16);
}

// `start`/`stop` MUST be called with an already-absolute <dir> — never a relative one. `path.resolve`
// on a RELATIVE input fills in the gap from `process.cwd()`, so the SAME relative string (e.g. ".",
// "web") keys a DIFFERENT tracking file depending on whatever directory the invoking process happens to
// be sitting in at that moment — silently, with no error. Two callers that both believe they mean "the
// same worktree" can end up on two different tracking files (one records, the other finds nothing and
// wrongly concludes no server is running), or the SAME caller can lose its own record if its shell cwd
// drifts between `start` and a later `stop` (see the worker doctrine's own "a Bash cd leaks into every
// later call" warning — this is exactly that footgun, applied to this helper). `path.resolve` on an
// ALREADY-ABSOLUTE input is a pure normalization (collapses ".."/trailing slashes) and does not depend
// on cwd, so requiring an absolute <dir> up front — refusing loudly rather than silently keying off cwd
// — closes the ambiguity by construction instead of trying to reconcile it after the fact.
function requireAbsoluteDir(dir) {
  if (!path.isAbsolute(dir)) {
    console.error(`${SELF}: <dir> must be an absolute path (got "${dir}") — a relative path resolves against this process's own cwd, which can silently differ between callers and key the same logical directory under two different tracking files. Pass an absolute path (e.g. your worktree's own absolute directory).`);
    process.exit(1);
  }
  return path.resolve(dir);
}

function trackingFilePath(absDir) {
  return path.join(os.tmpdir(), `loom-dev-server-${pathHash(absDir)}.json`);
}

// Captures the child's stdout+stderr — see the PORT DETECTION note at the top of this file for why.
function logFilePath(absDir) {
  return path.join(os.tmpdir(), `loom-dev-server-${pathHash(absDir)}.log`);
}

// Matches the host:port a dev server's own startup banner reports it bound to — Vite ("Local:
// http://localhost:5173/"), Next.js ("- Local: http://localhost:3000"), webpack-dev-server ("Loopback:
// http://localhost:8080/"), and similar frameworks that print a loopback (or all-interfaces) URL.
// Deliberately generic rather than tied to one framework's exact wording, since `start` spawns an
// ARBITRARY command and cannot know in advance which one. Captures BOTH the host token (group 1, exactly
// as the banner wrote it) and the port (group 2) — a consumer needs the host too: the same port can be
// reachable at `127.0.0.1` on one server and refuse that address while answering at `[::1]` on another
// (or the reverse), so recording only the port and inviting a rebuild guesses at the host either way.
const PORT_BANNER_RE = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\D{0,5}(\d{2,5})\b/i;

// Maps a banner-reported host token to a host a consumer can actually connect to. Every token except
// `0.0.0.0` is already concrete and passes through verbatim (`[::1]` keeps its own brackets, ready to
// drop straight into a URL). `0.0.0.0` means "all interfaces" — it is the server's BIND address, not an
// address anything can CONNECT to — so a consumer needs a concrete loopback host instead; `127.0.0.1` is
// the one guaranteed to reach an any-interfaces bind (an any-interfaces server also accepts IPv6 loopback
// on many platforms, but IPv4 loopback is the one guaranteed by the `0.0.0.0` bind itself).
function urlHost(bannerHost) {
  return bannerHost === "0.0.0.0" ? "127.0.0.1" : bannerHost;
}

// Strips ANSI/VT100 SGR escape sequences before matching — Vite (and most colorized CLIs) wraps just
// the port digits in their own color codes (`\x1b[1m5317\x1b[22m`), and an SGR code commonly contains a
// digit itself (bold is "\x1b[1m"), which lands INSIDE PORT_BANNER_RE's \D{0,5} gap and breaks the match
// entirely — verified against a real captured `pnpm web` log, where the raw line failed to match at all
// and only matched once stripped.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// A LINE that mentions a host:port but describes it as a DESTINATION rather than something the command
// itself bound — a reverse-proxy target being the concrete, verified case (this repo's own `pnpm web`
// prints "[web] proxying → http://127.0.0.1:4317" — the DAEMON's port — before Vite's own ready banner;
// a plain first-match-in-the-whole-log scrape would record the daemon, not the dev server, and a worker
// would eyeball the wrong process while believing the check passed). Excluded regardless of whether it
// also matches PORT_BANNER_RE.
const DECOY_CONTEXT_RE = /\b(?:proxy|proxying|forward(?:ing)?|target|upstream)\b/i;
// A LINE that additionally affirms "this is where I'm bound" rather than merely mentioning a port in
// passing — preferred over a non-excluded-but-unaffirmed match when both exist on the same poll.
const BOUND_AFFIRMATION_RE = /\b(?:local|loopback|listening|ready|serving)\b/i;

// Scans line by line (a banner is one URL per line in every framework observed) rather than the whole
// blob, so DECOY_CONTEXT_RE can be scoped to the SAME line the port appears on. Returns the first
// AFFIRMED (non-excluded + keyword-matched) candidate {host, port} if one exists, else the first
// non-excluded candidate, else null — never a decoy line, even if it's the only match in the log.
// KNOWN LIMIT (stated, not silently assumed): this is a heuristic, not a proof — a framework whose
// banner happens to use none of BOUND_AFFIRMATION_RE's words falls back to "first non-excluded", which
// is wrong if THAT line is itself an undetected decoy this list doesn't yet know to exclude, or if a
// legitimate non-banner port mention (an HMR port, a "press h for help" hint) appears before the real
// banner. Generalizing further (e.g. verifying the candidate is actually listening) doesn't strictly
// dominate this: the observed real case (a reverse-proxy target) is genuinely alive too — it's the
// daemon — so a liveness check alone cannot tell it apart from the real bind.
// Returns `{host, port, affirmed}` for the first candidate found (affirmed preferred over non-affirmed —
// see below), or null if none. `affirmed` lets waitForBinding tell "this IS the bind" from "this merely
// mentions a port", so it can keep polling for a later, better line instead of locking onto the first
// port-shaped mention it sees.
function extractBinding(logPath) {
  let content;
  try {
    content = fs.readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  let firstNonDecoy = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, "");
    if (DECOY_CONTEXT_RE.test(line)) continue;
    const m = PORT_BANNER_RE.exec(line);
    if (!m) continue;
    const candidate = { host: m[1], port: Number(m[2]) };
    if (BOUND_AFFIRMATION_RE.test(line)) return { ...candidate, affirmed: true };
    if (firstNonDecoy == null) firstNonDecoy = candidate;
  }
  return firstNonDecoy ? { ...firstNonDecoy, affirmed: false } : null;
}

// Poll the log file for the child's own bound-host:port banner, bounded — see PORT DETECTION above.
// Only an AFFIRMED candidate short-circuits the loop; a non-affirmed one (a port mentioned without a
// "local/listening/ready/…" keyword on its line) keeps polling in case a real, affirmed banner shows up
// later in the log — accepting the non-affirmed candidate only if the deadline is reached with nothing
// better (the post-loop extractBinding call below already does exactly that).
async function waitForBinding(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const binding = extractBinding(logPath);
    if (binding != null && binding.affirmed) return binding;
    await new Promise((r) => setTimeout(r, 100));
  }
  return extractBinding(logPath);
}

// The DETACHED, TRACKED process `start` spawns is this supervisor, not the real command — see the
// SUPERVISOR note at the top of this file for why. Plain CommonJS (invoked via `node -e`, which is
// CJS by default) — no imports beyond core modules, kept as a single self-contained string since it
// travels as one spawn argv entry, not a file on disk.
const SUPERVISOR_CODE = [
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  "const payload = JSON.parse(process.argv[1]);",
  // 'w': fresh truncate each `start` — a leftover log from a previous run at this <dir> could otherwise
  // be mistaken for this one's port banner.
  "const out = fs.createWriteStream(payload.logPath, { flags: 'w' });",
  "const child = spawn(payload.cmd, payload.args, { cwd: payload.cwd, shell: payload.shell, stdio: ['ignore', 'pipe', 'pipe'] });",
  // { end: false } on BOTH — the exit handler below owns closing `out` once the real command exits, so
  // whichever of stdout/stderr happens to end first (e.g. a framework that only ever writes to stderr,
  // while stdout stays open until process exit) can't prematurely end the shared stream and silently
  // drop the other's later output.
  "child.stdout.pipe(out, { end: false });",
  "child.stderr.pipe(out, { end: false });",
  // Exit once the real command does, so a target that dies on its own (a bad command, a crash) doesn't
  // leave an orphaned supervisor sitting around forever.
  "child.on('exit', (code) => { out.end(); process.exit(code == null ? 1 : code); });",
].join("\n");

function readTracked(absDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(trackingFilePath(absDir), "utf8"));
    if (parsed && typeof parsed.pid === "number" && parsed.dir === absDir) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeTracked(absDir, record) {
  fs.writeFileSync(trackingFilePath(absDir), JSON.stringify(record), "utf8");
}

function removeTracked(absDir) {
  try { fs.unlinkSync(trackingFilePath(absDir)); } catch { /* already gone */ }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Kill exactly `pid` (+ its process tree) by that exact handle — never a name/port search. `taskkill
// /T /F` on win32 kills the tracked pid's whole subtree (mirrors killRemoveChild's posture elsewhere in
// this codebase); POSIX kills the process group first (start() puts the child in its own group via
// `detached: true`, so `-pid` reaches any children it spawned) then the pid itself as a fallback.
function killTracked(pid) {
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* no such group / already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function start(dir, cmdArgs) {
  const absDir = requireAbsoluteDir(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.error(`start: not a directory: ${absDir}`);
    process.exit(1);
  }
  if (cmdArgs.length === 0) usageAndExit();

  const existing = readTracked(absDir);
  if (existing && isAlive(existing.pid)) {
    console.error(`start: a dev-server is already tracked for ${absDir} (pid ${existing.pid}). Stop it first: node ${SELF} stop ${dir}`);
    process.exit(1);
  }

  const [cmd, ...args] = cmdArgs;
  const win32 = process.platform === "win32";
  const logPath = logFilePath(absDir);
  const payload = JSON.stringify({
    logPath,
    // win32 needs a shell to resolve .cmd/.ps1 shims (npm, pnpm, …) the way an interactive shell would —
    // but a shell-joined command line mis-parses an UNQUOTED executable path containing spaces (e.g. the
    // very common "C:\Program Files\nodejs\node.exe"): cmd.exe splits on the first space and reports
    // "command not found". Quoting `cmd` fixes that case — but quoting is NOT a no-op for a bare,
    // unspaced command name the way it looks like it should be: quoting "pnpm" (verified against a real
    // spawn) makes cmd.exe resolve a DIFFERENT, broken pnpm entry (a corepack shim that throws
    // MODULE_NOT_FOUND on this box) instead of the working one an unquoted "pnpm" finds — the previous
    // comment here asserted the opposite and was wrong. Only quote when `cmd` actually needs it.
    cmd: win32 && /\s/.test(cmd) ? `"${cmd}"` : cmd,
    args,
    cwd: absDir,
    shell: win32,
  });
  // Truncate the log HERE, in the launcher, synchronously, BEFORE spawning the supervisor. This is the
  // actual fix for the stale-port race (card 7d0eceab): waitForBinding's first read fires immediately
  // after spawn, while the detached supervisor is still booting its own node process — well before it
  // reaches its own `fs.createWriteStream(logPath, { flags: 'w' })` truncation below. A leftover log from
  // a previous `start` at this same <dir> would otherwise be read as this run's port banner, and since
  // this first read is essentially instantaneous, it wins virtually always when a stale log exists. The
  // supervisor's own truncating open still runs too (harmless, and correct for its own writes) but must
  // never be the ONLY barrier — this synchronous truncate is what actually closes the race.
  fs.writeFileSync(logPath, "", "utf8");

  // See the SUPERVISOR note at the top of this file: the detached, TRACKED process is this supervisor,
  // not `cmd` directly. No shell here — `process.execPath` is spawned directly (a real, directly
  // executable path), so Windows launches it via a normal argv-array CreateProcess call that needs no
  // manual quoting even though the path itself commonly contains spaces.
  const child = spawn(process.execPath, ["-e", SUPERVISOR_CODE, payload], {
    // detached: own process group on POSIX (so the group-kill in killTracked reaches the supervisor's
    // own non-detached child too, which inherits that same group), and lets the whole thing outlive this
    // launcher process either way. `stdio: "ignore"` for the supervisor itself — it writes the real
    // command's output to logPath directly via fs (see SUPERVISOR_CODE), never through inherited stdio.
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) {
    console.error("start: failed to spawn (no pid)");
    process.exit(1);
  }
  child.unref();
  writeTracked(absDir, { pid: child.pid, command: cmdArgs, dir: absDir, startedAt: new Date().toISOString(), logFile: logPath, port: null, host: null, url: null });
  console.log(`Started "${cmdArgs.join(" ")}" in ${absDir} (pid ${child.pid})`);
  console.log(`Log: ${logPath}`);
  console.log(`Stop with: node ${SELF} stop ${dir}`);

  const timeoutMs = Number(process.env.LOOM_DEV_SERVER_PORT_TIMEOUT_MS || 15000);
  const binding = await waitForBinding(logPath, timeoutMs);
  if (binding != null) {
    const host = urlHost(binding.host);
    const url = `http://${host}:${binding.port}/`;
    const current = readTracked(absDir);
    if (current && current.pid === child.pid) writeTracked(absDir, { ...current, port: binding.port, host, url });
    // Print the URL, not just the port — see the top-of-file note: a consumer must use it AS GIVEN,
    // never rebuild it from the port, since the same port can be unreachable at a guessed host.
    console.log(`Bound: ${url} (recorded to the tracking file)`);
  } else {
    console.log(`Bound host:port not detected within ${timeoutMs}ms — the tracking file's port/host/url stay unset (nothing keeps watching after this command exits); grep ${logPath} directly once the server has finished starting, or raise LOOM_DEV_SERVER_PORT_TIMEOUT_MS if this framework is just slow to boot.`);
  }
}

function stop(dir) {
  const absDir = requireAbsoluteDir(dir);
  const tracked = readTracked(absDir);
  if (!tracked) {
    console.log(`stop: no tracked dev-server for ${absDir} (nothing to do)`);
    return;
  }
  killTracked(tracked.pid);
  removeTracked(absDir);
  const label = Array.isArray(tracked.command) ? tracked.command.join(" ") : String(tracked.command);
  const portLabel = typeof tracked.port === "number" ? ` (port ${tracked.port})` : "";
  console.log(`Stopped pid ${tracked.pid}${portLabel} ("${label}") tracked for ${absDir}`);
}

const [, , mode, dirArg, ...rest] = process.argv;
if (mode === "start") {
  if (!dirArg) usageAndExit();
  const sepIdx = rest.indexOf("--");
  if (sepIdx === -1) usageAndExit();
  await start(dirArg, rest.slice(sepIdx + 1));
} else if (mode === "stop") {
  if (!dirArg) usageAndExit();
  stop(dirArg);
} else {
  usageAndExit();
}
