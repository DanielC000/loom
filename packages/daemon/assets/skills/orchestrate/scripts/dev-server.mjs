#!/usr/bin/env node
// Launch a worktree dev-server, track the EXACT child process handle/pid it spawns, and tear it down
// by that same tracked handle on demand — so eyeballing a worktree's live app never needs a hand-rolled
// `netstat` + `taskkill` hunt (locale-fragile output parsing, and a name/port-based kill can reach an
// unrelated process — even the self-hosting daemon itself). Dependency-free: only node:child_process/
// node:fs/node:os/node:path/node:crypto, so it runs anywhere Node runs, no install step. Mirrors
// serve-static.mjs in this same scripts/ dir (single-purpose, no deps, one printed line to act on).
//
// Usage:
//   node dev-server.mjs start <dir> -- <command> [args...]
//     Spawns <command> with cwd=<dir>, detached from THIS process so it outlives it, and prints:
//       Started "<command...>" in <dir> (pid <pid>)
//       Stop with: node dev-server.mjs stop <dir>
//     Records {pid, command, dir, startedAt} to a tracking file keyed off <dir>'s absolute path (see
//     trackingFilePath) so a LATER, separate `stop` invocation — even from a different shell — can find
//     and kill EXACTLY this process. Refuses to start a second tracked server over an already-tracked,
//     still-alive one for the same <dir>; stop the first one before starting another.
//
//   node dev-server.mjs stop <dir>
//     Reads the tracking file for <dir>, kills the tracked pid (+ its process tree) BY THAT EXACT PID,
//     and removes the tracking file. A no-op (exit 0) if no tracked server is found for <dir> — this
//     never enumerates processes and never searches by name or port.
//
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

// Tracking file lives in the OS temp dir, keyed off the worktree's absolute path — never inside the
// worktree itself, so it's never mistaken for part of the tree (git status, the merge gate, …) and
// survives independently of whether the worktree dir itself is later removed.
function trackingFilePath(absDir) {
  const hash = crypto.createHash("sha256").update(absDir).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `loom-dev-server-${hash}.json`);
}

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

function start(dir, cmdArgs) {
  const absDir = path.resolve(dir);
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
  // win32 needs a shell to resolve .cmd/.ps1 shims (npm, pnpm, …) the way an interactive shell would —
  // but node's shell:true glues `cmd` + args into one command line for cmd.exe /c WITHOUT quoting
  // `cmd` itself, so an unquoted executable path containing spaces (e.g. the very common
  // "C:\Program Files\nodejs\node.exe") silently mis-parses: cmd.exe exits immediately, the target
  // process never starts, and nothing errors (stdio is ignored). Quoting `cmd` ourselves fixes the
  // spaced-path case and is a no-op for a bare command name like "pnpm" — verified against a real
  // spawn, not assumed.
  const child = spawn(win32 ? `"${cmd}"` : cmd, args, {
    cwd: absDir,
    // detached: own process group on POSIX (so the group-kill in killTracked reaches anything the
    // command itself spawns), and lets the child outlive this launcher process either way.
    detached: true,
    stdio: "ignore",
    shell: win32,
  });
  if (!child.pid) {
    console.error("start: failed to spawn (no pid)");
    process.exit(1);
  }
  child.unref();
  writeTracked(absDir, { pid: child.pid, command: cmdArgs, dir: absDir, startedAt: new Date().toISOString() });
  console.log(`Started "${cmdArgs.join(" ")}" in ${absDir} (pid ${child.pid})`);
  console.log(`Stop with: node ${SELF} stop ${dir}`);
}

function stop(dir) {
  const absDir = path.resolve(dir);
  const tracked = readTracked(absDir);
  if (!tracked) {
    console.log(`stop: no tracked dev-server for ${absDir} (nothing to do)`);
    return;
  }
  killTracked(tracked.pid);
  removeTracked(absDir);
  const label = Array.isArray(tracked.command) ? tracked.command.join(" ") : String(tracked.command);
  console.log(`Stopped pid ${tracked.pid} ("${label}") tracked for ${absDir}`);
}

const [, , mode, dirArg, ...rest] = process.argv;
if (mode === "start") {
  if (!dirArg) usageAndExit();
  const sepIdx = rest.indexOf("--");
  if (sepIdx === -1) usageAndExit();
  start(dirArg, rest.slice(sepIdx + 1));
} else if (mode === "stop") {
  if (!dirArg) usageAndExit();
  stop(dirArg);
} else {
  usageAndExit();
}
