#!/usr/bin/env node
// Stop a `pnpm daemon:stable --detach`ed supervisor+daemon pair (card 2f146782). Companion to
// scripts/daemon-supervisor.mjs's --detach launch path — see that file's own header for the launch side.
//
// Graceful stop is the SAME loopback control hook bin/loom.mjs's `stop()` uses for the packaged CLI
// (POST /internal/shutdown, bearer-authed with the loopback secret) — the daemon runs the identical
// gateway either way. Once the daemon exits gracefully (code 0, not the restart sentinel), the
// supervisor's own `for (;;)` loop calls `process.exit(0)` right behind it — so stopping the DAEMON is
// normally sufficient; this script waits for the supervisor PID to actually disappear before declaring
// success, and only reaches for a hard kill (of that SAME captured PID, identity-CONFIRMED first — see
// isOurSupervisor below — never by name/port) as a last resort.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { commandLineOf, matchesRecordedEntry } from "../bin/lib/cmdline-identity.mjs";

const DEFAULT_PORT = 4317;
const loomHome = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const pidPath = path.join(loomHome, "daemon-supervisor.pid");
// This process's OWN env-derived port — used only as a FALLBACK when the pid record has none (an older
// record from before Code Review finding #3). Prefer rec.port (below): the LAUNCHER already resolved
// LOOM_PORT the same way daemon-supervisor.mjs does, including a value that came only from
// <LOOM_HOME>/.env — this process's own env may not have that (e.g. invoked from a different shell), so
// re-deriving here first could silently target the WRONG port (single daemon: a spurious hard-kill after
// an unreachable graceful stop; two-daemons-side-by-side, per CLAUDE.md's isolated-daemon-testing note:
// gracefully stopping the WRONG one, then hard-killing the right supervisor besides — the exact double-
// damage scenario this finding named).
const envPort = process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : null;

function readPidRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(pidPath, "utf8"));
    return Number.isInteger(rec?.pid) ? rec : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

// FALLBACK ONLY (a pid record predating card 03cc6cae's `entry` field): anchored on the `scripts/` DIRECTORY
// this script actually lives in, not a bare filename — a bare `daemon-supervisor\.mjs` previously matched
// any unrelated path merely containing that filename.
const LEGACY_SUPERVISOR_CMDLINE_RE = /[\\/]scripts[\\/]daemon-supervisor\.mjs(?:["'\s]|$)/i;

/**
 * Code Review finding #1 (Critical): `pid` alone proves only that SOMEONE holds that OS pid — a live pid
 * there is not proof it's still OUR supervisor. Mirrors bin/loom.mjs's `isOurDaemon` (card 03cc6cae): tier
 * 1 is the recorded `entry` via the shared `matchesRecordedEntry` (`../bin/lib/cmdline-identity.mjs`);
 * tier 2 (a pre-`entry` pid record) is `LEGACY_SUPERVISOR_CMDLINE_RE`. Returns false — REFUSE, never guess
 * — on anything we can't positively confirm, including when the command line can't be read at all.
 */
function isOurSupervisor(rec) {
  const info = commandLineOf(rec.pid);
  if (!info.raw) return false;
  if (rec.entry) return matchesRecordedEntry(info, rec.entry);
  return LEGACY_SUPERVISOR_CMDLINE_RE.test(info.raw);
}

function readLoopbackSecret() {
  try { return fs.readFileSync(path.join(loomHome, "gateway-loopback.key"), "utf8").trim() || null; } catch { return null; }
}

function postShutdown(port) {
  return new Promise((resolve) => {
    const secret = readLoopbackSecret();
    const headers = secret ? { authorization: `Bearer ${secret}` } : {};
    const req = http.request({ host: "127.0.0.1", port, path: "/internal/shutdown", method: "POST", timeout: 2000, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (e) => resolve({ error: e }));
    req.on("timeout", () => { req.destroy(); resolve({ error: new Error("timeout") }); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(intervalMs);
  }
  return await pred();
}

async function main() {
  const rec = readPidRecord();
  if (!rec) {
    console.log(`daemon-supervisor: no PID file at ${pidPath} — nothing to stop (or it wasn't started with --detach).`);
    return 0;
  }
  // Code Review finding #3: prefer the launcher's OWN recorded port over re-deriving one from this
  // process's own env — see envPort's doc above for why the two can disagree.
  const port = rec.port ?? envPort ?? DEFAULT_PORT;
  if (!isAlive(rec.pid)) {
    fs.rmSync(pidPath, { force: true });
    console.log(`daemon-supervisor: not running (stale PID ${rec.pid} cleaned).`);
    return 0;
  }

  console.log(`daemon-supervisor: stopping (supervisor PID ${rec.pid}, daemon port ${port}) …`);
  const hook = await postShutdown(port);
  if (hook.status === 202 || hook.status === 200) {
    // The daemon's graceful exit (0) makes the supervisor's own loop exit right behind it — wait for
    // BOTH the port to stop answering and the captured supervisor PID to actually disappear.
    const daemonDown = await waitUntil(() => new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: 1000 }, (res) => { res.resume(); resolve(false); });
      req.on("error", () => resolve(true));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    }), 12000);
    if (daemonDown) {
      const supervisorDown = await waitUntil(() => !isAlive(rec.pid), 8000);
      if (supervisorDown) {
        fs.rmSync(pidPath, { force: true });
        console.log("daemon-supervisor: stopped (graceful).");
        return 0;
      }
      console.error(`daemon-supervisor: the daemon stopped but the supervisor (PID ${rec.pid}) is still alive after 8s — falling back to a hard kill of that PID.`);
    } else {
      console.error("daemon-supervisor: the daemon did not stop answering within 12s — falling back to a hard kill.");
    }
  } else if (hook.status === 404) {
    console.error("daemon-supervisor: this daemon predates the graceful-shutdown hook — falling back to a hard kill.");
  } else if (hook.status === 401) {
    console.error("daemon-supervisor: the daemon rejected our stop credential (401) — falling back to a hard kill.");
  } else if (hook.status !== undefined) {
    // Code Review finding #8: an unclassified but real HTTP status (e.g. 500) means we DID reach the
    // daemon — "no response" would be a misleading thing to say here.
    console.error(`daemon-supervisor: the daemon answered /internal/shutdown with an unexpected status ${hook.status} — falling back to a hard kill.`);
  } else {
    console.error(`daemon-supervisor: could not reach the daemon on port ${port} (${hook.error?.message ?? "no response"}) — falling back to a hard kill.`);
  }

  // Last resort: hard-kill ONLY the PID we captured at spawn — but ONLY once its own live command line
  // confirms it's still our supervisor (finding #1). A pid the file names that we can't positively
  // confirm is a REFUSAL, not a guess. On Windows /T /F also takes down its still-live children (the
  // build/daemon procs) once confirmed.
  //
  // RESIDUAL WINDOW (not closed by the check above, card a2f821bf): `isOurSupervisor` confirms identity,
  // but the actual kill happens a moment later — `commandLineOf` itself shells out (spawnSync to
  // powershell/ps), and in that gap the confirmed process can exit and the OS can reuse its pid. The kill
  // below can then, in principle, reach an unrelated process. On Windows this is worse: `/T /F` takes the
  // whole process tree, not just this one pid. Not closed by narrowing — re-checking right before the
  // kill, or shrinking the gap, still leaves the same window, only smaller. What WOULD close it is
  // signalling by a stable handle rather than a recyclable number (a Windows process handle taken at
  // confirmation time and signalled through it directly; a POSIX pidfd) — neither of which Node exposes
  // cross-platform today. Not reducible with the APIs available to us here, not structurally impossible.
  if (isAlive(rec.pid)) {
    if (!isOurSupervisor(rec)) {
      console.error(`daemon-supervisor: PID ${rec.pid} from the pid file is alive, but its command line does not confirm it as our supervisor (daemon-supervisor.mjs) — the pid may have been reused by an unrelated process since the file was written. Refusing to kill an unverified process. If you're sure it's the stuck supervisor, stop it yourself: ${process.platform === "win32" ? `taskkill /PID ${rec.pid} /T /F` : `kill -9 ${rec.pid}`}`);
      return 1;
    }
    console.error(`daemon-supervisor: ⚠ hard-killing PID ${rec.pid} (confirmed our supervisor; no graceful teardown).`);
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(rec.pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(rec.pid, "SIGKILL"); } catch { /* already gone */ } }
    await waitUntil(() => !isAlive(rec.pid), 5000);
  }
  if (isAlive(rec.pid)) {
    console.error(`daemon-supervisor: failed to stop PID ${rec.pid}.`);
    return 1;
  }
  fs.rmSync(pidPath, { force: true });
  console.log("daemon-supervisor: stopped (forced).");
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error("daemon-supervisor: stop failed:", err?.message ?? err); process.exit(1); });
