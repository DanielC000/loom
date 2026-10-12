#!/usr/bin/env node
// Load-smokes the REAL win-job-launcher.exe built by build-native-launcher.mjs — spawn, signal-abort
// (confirmed exit), and a plain git exit-code passthrough. Replaces release.yml's old inline PowerShell
// smoke (card 1718416d, round 2, MINOR c): a Node ChildProcess object tracks its own exit state
// directly via its own "close" event, so there's no PowerShell $p.Handle-before-ExitCode race to get
// right, and the abort is triggered off an OBSERVABLE marker the hook itself writes, never a fixed
// sleep. Also smokes that git's own exit code passes through the launcher unmodified — not exercised by
// the old inline smoke at all.
//
// Windows-only; a loud no-op everywhere else (same posture as build-native-launcher.mjs). Usage:
//   node scripts/smoke-win-job-launcher.mjs [path-to-exe]
// Exits 0 on full success (or a non-win32 no-op), 1 on any failure or a missing exe. Deliberately
// standalone (no test-runner dependency) so it can run identically from release.yml and from a
// developer's own shell for a local dry run of the exact same check the release job runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, "packages/daemon/assets/native/win-job-launcher.exe");

// Mirrors native/win-job-launcher/launcher.cs's own exit-code contract (see that file's header doc) —
// not exported anywhere TS-side either; pinned here the same way the test suite pins it.
const EXIT_CONFIRMED_KILLED = 0x4c4f0001;

function log(m) { console.log(`[smoke:win-job-launcher] ${m}`); }
let failures = 0;
const check = (label, cond) => { log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeRepo(tag) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `loom-wjl-smoke-${tag}-`));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "wjl-smoke@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "wjl-smoke"], { cwd: repo });
  return repo;
}

/** Poll for `file` to exist — an OBSERVABLE event, never a fixed sleep (the old inline smoke waited a
 *  fixed 300ms before signaling; this waits for the hook to actually report it has started). */
async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** round 3, NIT: a hung real process (the launcher, git, or the --signal invocation) must fail this
 *  smoke loudly within a bounded time rather than hang the release job forever — the launcher's own
 *  "run" mode waits on git plus a bounded TerminateJobObject confirm poll (5s, see launcher.cs), so
 *  `exitTimeoutMs` below is set comfortably above that, not an arbitrary guess. */
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function smokeAbortConfirmed() {
  const repo = makeRepo("abort");
  const markerFile = path.join(repo, "wjl-smoke.marker").replace(/\\/g, "/");
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\necho 1 > ${markerFile}\nsleep 10\nexit 0\n`);
  fs.chmodSync(hookPath, 0o755);

  const nonce = crypto.randomBytes(16).toString("hex");
  const child = spawn(EXE, ["run", nonce, "commit", "--allow-empty", "-m", "smoke abort"], { cwd: repo, windowsHide: true });
  const exitPromise = new Promise((resolve) => child.on("close", (code) => resolve(code)));

  const markerSeen = await waitForFile(path.join(repo, "wjl-smoke.marker"));
  check("abort smoke: the hook's own marker file appeared (observable start signal, not a fixed sleep)", markerSeen);

  const signaler = spawn(EXE, ["--signal", nonce], { windowsHide: true });
  await withTimeout(
    new Promise((resolve) => { signaler.on("close", resolve); signaler.on("error", resolve); }),
    5000, "abort smoke: waiting for the --signal invocation to exit",
  );

  const code = await withTimeout(exitPromise, 15000, "abort smoke: waiting for the launcher to exit after the abort");
  check(`abort smoke: launcher reports the confirmed-kill exit code (got ${code}, expected ${EXIT_CONFIRMED_KILLED})`, code === EXIT_CONFIRMED_KILLED);
}

async function smokeGitExitCodePassthrough() {
  const repo = makeRepo("passthrough");
  const args = ["log", "--format=%H", "-1", "definitely-not-a-real-ref-xyz"];

  let bareCode = 0;
  try {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  } catch (e) {
    bareCode = e.status ?? 1;
  }
  check("exit-code passthrough smoke: bare git exits non-zero for a bad ref (sanity)", bareCode !== 0);

  const nonce = crypto.randomBytes(16).toString("hex");
  const code = await withTimeout(
    new Promise((resolve) => {
      const child = spawn(EXE, ["run", nonce, ...args], { cwd: repo, windowsHide: true });
      child.on("close", (c) => resolve(c));
    }),
    15000, "exit-code passthrough smoke: waiting for the launcher-spawned git to exit",
  );
  check(`exit-code passthrough smoke: launcher passes git's own exit code through unmodified (bare=${bareCode} launcher=${code})`, code === bareCode);
}

async function main() {
  if (process.platform !== "win32") {
    log(`skipped — win32-only (this host is '${process.platform}').`);
    return 0;
  }
  if (!fs.existsSync(EXE)) {
    console.error(`[smoke:win-job-launcher] ERROR: exe not found at ${EXE}. Build it first (pnpm --filter @loom/daemon build:native).`);
    return 1;
  }
  await smokeAbortConfirmed();
  await smokeGitExitCodePassthrough();
  log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  return failures === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`[smoke:win-job-launcher] ERROR: ${e?.message ?? e}`);
    process.exit(1);
  });
}
