import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 887e10b8 Item 1 (multi-harness epic df1f94b0, Phase 1) — closes the gap
// codex-doctrine-injection.mjs's hermetic coverage deliberately leaves open: that file calls
// `injectCodexDoctrine` directly, so it proves the FUNCTION works but never proves `spawnCodexProcess`
// actually CALLS it. "Shipping a detector is not someone reading it" (project memory
// `shipping-a-detector-is-not-someone-reading-it`) applies just as much to a fix shipped-but-never-wired
// as to a fix nobody looks at — this test drives the REAL, WIRED `spawnCodexProcess` (via `PtyHost.spawn`,
// through a fake `createCodexPty()` override, mirroring `codex-queue-state-machine.mjs`'s established
// technique) with a REAL scratch cwd on disk, and asserts AGENTS.md actually lands there. Whether a real
// codex process then READS that file is a separate claim — see `test/codex-doctrine-real-spawn.mjs`.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-doctrine-spawn-wiring.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TMP = mkdtempManaged("loom-codex-doctrine-wiring-home-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

/** A fake, fully-scripted codex pty — no real process. Mirrors `codex-queue-state-machine.mjs`'s
 *  `makeFakePty`/`FakeCodexHost` exactly; only the assertions differ (this file cares about the
 *  filesystem side effect of spawning, not the queue/turn state machine). */
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5150,
    write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
  };
}

class FakeCodexHost extends PtyHost {
  createCodexPty() { return makeFakePty(); }
}

const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
};
const host = new FakeCodexHost(events);

// --- role: "worker" — spawnCodexProcess must itself call injectCodexDoctrine (not just the function
// existing in isolation) before the fake pty is even created — the call is synchronous in spawnCodexProcess,
// so it's already on disk the instant host.spawn() returns, no waiting needed. --------------------------
{
  const cwd = mkdtempManaged("loom-codex-doctrine-wiring-worker-cwd-");
  const target = path.join(cwd, "AGENTS.md");
  check("AGENTS.md absent before spawn", !fs.existsSync(target));
  host.spawn({
    sessionId: "wiring-worker", cwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: "worker", harness: "codex",
  });
  check("spawnCodexProcess(role='worker') actually calls injectCodexDoctrine — AGENTS.md exists immediately after spawn() returns",
    fs.existsSync(target));
  const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  check("the file spawnCodexProcess wrote carries the same managed-block marker the unit test asserts on",
    content.startsWith("<!-- LOOM:CODEX-DOCTRINE:BEGIN"));
}

// --- role: undefined (plain) — the Phase-1 scope limit holds through the REAL spawn path too, not just
// the isolated function. --------------------------------------------------------------------------------
{
  const cwd = mkdtempManaged("loom-codex-doctrine-wiring-plain-cwd-");
  const target = path.join(cwd, "AGENTS.md");
  host.spawn({
    sessionId: "wiring-plain", cwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: {}, role: undefined, harness: "codex",
  });
  check("spawnCodexProcess(role=undefined) does NOT inject AGENTS.md (Phase-1 worker-only scope, enforced at the real spawn call site)",
    !fs.existsSync(target));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the REAL, wired spawnCodexProcess (not merely the isolated injectCodexDoctrine function) delivers AGENTS.md to a worker-role codex spawn's actual cwd, and correctly skips it for a non-worker role."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
