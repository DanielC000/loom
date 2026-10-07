import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression guard for card cdd8ec44: host.ts's 4 per-session log construction sites (spawn/spawnShell/
// spawnCodexProcess/seedCanned) used to call `fs.createWriteStream(path)` with no flags → "w" → TRUNCATE
// on every (re)open — so a resume (including crash-recovery resume) wiped the pre-crash log exactly when
// it's needed for forensics. The fix routes all 4 through one shared `openSessionLogStream` helper that
// opens in APPEND ("a") mode, writes a respawn-separator line, and rotates once at open time if the file
// has already crossed SESSION_LOG_ROTATE_BYTES (keeping one prior generation at `<id>.log.1`).
//
// RUN (after `pnpm build`): node test/session-log-append-on-reopen.mjs
//
// PART 1 exercises `openSessionLogStream` directly — the hermetic "two opens of the same session log ⇒
// the first content survives" RED/GREEN proof the card's DoD asked for, plus the rotation bound.
// PART 2 exercises the real `PtyHost.spawn()` call site end-to-end (fake pty, no real claude/network) to
// prove the fix is actually wired into the respawn path the bug report was about, not just the helper in
// isolation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME + a tiny rotation threshold (read at module-load time by host.ts — see
// SESSION_LOG_ROTATE_BYTES's own doc), both set BEFORE importing dist/pty/host.js.
const tmpHome = path.join(os.tmpdir(), `loom-logreopen-test-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_SESSION_LOG_ROTATE_BYTES = "100"; // tiny — a handful of writes crosses it deterministically

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { PtyHost, openSessionLogStream, SESSION_LOG_ROTATE_BYTES } = await import("../dist/pty/host.js");

check("SESSION_LOG_ROTATE_BYTES picked up the env override", SESSION_LOG_ROTATE_BYTES === 100);

// ===================== PART 1: openSessionLogStream direct unit coverage =====================
async function endStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

{
  const sid = "unit-reopen";
  const logPath = path.join(tmpHome, "logs", `${sid}.log`);

  // First open: no existing file. Write a marker, close.
  const s1 = openSessionLogStream(sid, "fresh spawn");
  s1.write("GEN1-MARKER\n");
  await endStream(s1);
  const afterGen1 = fs.readFileSync(logPath, "utf8");
  check("first open creates the file with its own separator + marker", afterGen1.includes("session log reopened") && afterGen1.includes("GEN1-MARKER"));

  // Second open of the SAME id: this is the exact bug — a bare createWriteStream() here would TRUNCATE
  // afterGen1 away. Prove it goes RED under the pre-fix shape, then GREEN under the real helper.
  const bare = fs.createWriteStream(logPath); // pre-fix shape: default flags ("w")
  await endStream(bare);
  const bareReopenTruncates = fs.readFileSync(logPath, "utf8").length === 0;
  check("RED proof: a bare createWriteStream() reopen (the pre-fix shape) truncates the file to empty", bareReopenTruncates);

  // Restore GEN1 content (the bare reopen above wiped it) before exercising the real fix.
  fs.writeFileSync(logPath, afterGen1);

  const s2 = openSessionLogStream(sid, "resume");
  s2.write("GEN2-MARKER\n");
  await endStream(s2);
  const afterGen2 = fs.readFileSync(logPath, "utf8");
  check("GREEN: openSessionLogStream's reopen APPENDS — GEN1 content survives", afterGen2.includes("GEN1-MARKER"));
  check("GREEN: GEN2 content was appended after it", afterGen2.includes("GEN2-MARKER"));
  check("GREEN: a reopen separator naming the reason was written for the second open", afterGen2.includes("session log reopened") && afterGen2.includes("(resume)"));
  check("GREEN: true append order — GEN1 precedes GEN2 in the file", afterGen2.indexOf("GEN1-MARKER") < afterGen2.indexOf("GEN2-MARKER"));
}

{
  // Rotation: push the file past SESSION_LOG_ROTATE_BYTES (100, via the env override), then reopen —
  // the oversized content must move to `<id>.log.1`, and the FRESH `.log` must start clean.
  const sid = "unit-rotate";
  const logPath = path.join(tmpHome, "logs", `${sid}.log`);
  const rotatedPath = `${logPath}.1`;

  const s1 = openSessionLogStream(sid, "fresh spawn");
  s1.write("x".repeat(SESSION_LOG_ROTATE_BYTES + 1));
  await endStream(s1);
  check("fixture: the file is now over the rotation threshold", fs.statSync(logPath).size > SESSION_LOG_ROTATE_BYTES);
  check("fixture: no .1 file yet", !fs.existsSync(rotatedPath));

  const s2 = openSessionLogStream(sid, "resume");
  s2.write("POST-ROTATE-MARKER\n");
  await endStream(s2);

  check("rotation: the oversized generation moved to <id>.log.1", fs.existsSync(rotatedPath) && fs.readFileSync(rotatedPath, "utf8").includes("x".repeat(50)));
  const freshContent = fs.readFileSync(logPath, "utf8");
  check("rotation: the fresh .log does NOT carry the oversized prior content", !freshContent.includes("x".repeat(50)));
  check("rotation: the fresh .log carries the new reopen separator + marker", freshContent.includes("session log reopened") && freshContent.includes("POST-ROTATE-MARKER"));

  // A SECOND rotation must not fail just because a `.1` already exists (rmSync+renameSync overwrite path).
  const s3 = openSessionLogStream(sid, "resume");
  s3.write("y".repeat(SESSION_LOG_ROTATE_BYTES + 1));
  await endStream(s3);
  const s4 = openSessionLogStream(sid, "resume");
  s4.write("SECOND-ROTATE-MARKER\n");
  await endStream(s4);
  check("rotation: a second rotation overwrites the existing .1 without throwing", fs.readFileSync(rotatedPath, "utf8").includes("y".repeat(50)));
  check("rotation: the .log after a second rotation carries only the newest marker", fs.readFileSync(logPath, "utf8").includes("SECOND-ROTATE-MARKER"));
}

// ===================== PART 2: the real PtyHost.spawn() respawn path =====================
{
  const fakes = [];
  function makeFakePty() {
    let dataCb = null;
    let exitCb = null;
    const fake = {
      pid: 9191,
      write() {},
      resize() {},
      onData(cb) { dataCb = cb; return { dispose() { dataCb = null; } }; },
      onExit(cb) { exitCb = cb; return { dispose() {} }; },
      kill() { const cb = exitCb; exitCb = null; cb?.({ exitCode: 0 }); },
      emitData(s) { dataCb?.(s); },
    };
    fakes.push(fake);
    return fake;
  }

  class TestPtyHost extends PtyHost {
    sweepOrphanedDescendants(_rootPid) {}
    reapExitedDescendants() {} async probeRootSurvival(_rootPid, _sessionId) { return { foundAlive: false, identityConfirmed: false, enumerationFailed: false }; }
    createPty() { return makeFakePty(); }
  }

  const events = {
    onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  };

  const host = new TestPtyHost(events);
  const SID = "real-spawn-reopen-test";
  const logPath = path.join(tmpHome, "logs", `${SID}.log`);

  try {
    host.spawn({
      sessionId: SID,
      cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 },
      sessionEnv: {},
    });
    const fake1 = fakes[0];
    check("fresh spawn used the injected fake pty", !!fake1 && host.isAlive(SID) === true);
    fake1.emitData("GEN1-REAL-MARKER\r\n");
    await waitUntil(() => { try { return fs.readFileSync(logPath, "utf8").includes("GEN1-REAL-MARKER"); } catch { return false; } }, { timeoutMs: 3000, intervalMs: 25, label: "gen1 marker flushed to disk" });

    host.stop(SID, "hard");
    await waitUntil(() => host.isAlive(SID) === false, { timeoutMs: 3000, intervalMs: 25, label: "gen1 session stopped" });

    // Respawn the SAME session id with a resumeId — the crash-recovery-shaped case the bug report named.
    host.spawn({
      sessionId: SID,
      cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 },
      sessionEnv: {},
      resumeId: "fake-engine-session-id",
    });
    const fake2 = fakes[1];
    check("resume spawn used a SECOND injected fake pty", !!fake2 && fake2 !== fake1);
    fake2.emitData("GEN2-REAL-MARKER\r\n");
    await waitUntil(() => { try { return fs.readFileSync(logPath, "utf8").includes("GEN2-REAL-MARKER"); } catch { return false; } }, { timeoutMs: 3000, intervalMs: 25, label: "gen2 marker flushed to disk" });

    const finalContent = fs.readFileSync(logPath, "utf8");
    check("real spawn(): the crash-recovery-shaped resume APPENDS — pre-resume content survives", finalContent.includes("GEN1-REAL-MARKER"));
    check("real spawn(): the resumed generation's own output was appended after it", finalContent.includes("GEN2-REAL-MARKER"));
    check("real spawn(): a respawn separator naming \"resume\" was written", finalContent.includes("session log reopened") && finalContent.includes("(resume)"));
    check("real spawn(): true append order — GEN1 precedes GEN2", finalContent.indexOf("GEN1-REAL-MARKER") < finalContent.indexOf("GEN2-REAL-MARKER"));

    host.stop(SID, "hard");
  } finally {
    try { host.stop(SID, "hard"); } catch { /* already stopped — ignore */ }
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — per-session logs now append (not truncate) across a respawn, and rotate once at open time when oversized."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
