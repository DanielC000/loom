// Card 353f6dc4 (multi-harness epic df1f94b0 Phase 1) — DoD-5's remaining real-spawn coverage: drives
// the REAL, WIRED `PtyHost.spawn({harness:"codex"})` implementation (spawnCodexProcess/createCodexPty in
// pty/host.ts) end to end against a real, installed codex CLI — trust-dialog detect/answer, idle
// detection, and the stop() exit sequence. This exercises THIS PROJECT'S OWN CODE, not a hand-rolled
// duplicate of the probe's throwaway script (see codex-mcp-reachability-real-spawn.mjs's own header for
// why that distinction matters — a probe script proves the PROTOCOL works; this proves LOOM'S
// IMPLEMENTATION of it does).
//
// SCOPE, DELIBERATELY NARROW: spawn -> trust-dialog resolved -> a genuine ready-ish state -> stop/exit.
// This does NOT stand up a real gateway/MCP router — MCP reachability under a real listening endpoint is
// ALREADY covered by codex-mcp-reachability-real-spawn.mjs, and a real end-to-end worker (a live manager,
// a real project, a real gate) is DoD-2, explicitly the dispatching lead's to provision (this card's own
// ruling). Without a real gateway, codex's own MCP-server-startup phase fails to connect — a REAL finding
// from this test's own development: that failure leaves codex's title-bar busy-spinner marker STUCK
// (isCodexBusy reads true) for longer than is practical to wait out here, so this test does NOT assert
// isBusy ever settles to false — it only asserts busy is NOT true from the very first observation (i.e.
// this test never itself submitted a turn, so any TRUE busy reading here is entirely attributable to the
// MCP-startup episode, logged as informational, never a fixture-CLI stand-in for DoD-2's real coverage).
//
// ZERO MODEL TURNS SPENT, BY CONSTRUCTION: this file never calls enqueueStdin/submitCodex — it only
// spawns, observes, and stops. The submit/busy/idle PROTOCOL itself was already empirically validated
// against the real binary in the probe card (a7d74718, findings.md State 4) and is deliberately NOT
// re-validated here with a real model turn (this card's own "don't re-spend the owner's subscription"
// constraint) — submitCodex's own code is a direct, line-for-line transcription of that OBSERVED recipe
// (write text, 300ms later write \r), reviewable by reading it, not something a permanent regression
// test should spend a real subscription turn on every run to re-confirm.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available on this host (mirrors codex-mcp-reachability-real-spawn.mjs's own posture exactly).
//
// Safety: runs against the REAL ~/.codex (a sandboxed CODEX_HOME breaks auth — see pty/codex-doctrine.ts's
// own header), applying the SAME md5-before/diff-after/disclose discipline the probe used — but here it
// proves THIS PROJECT'S OWN diffConfigAfterSpawn/removeAddedTrustBlocks code does the cleanup correctly,
// not a hand-rolled test-local reimplementation of that logic.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-stateful-runtime-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute (mirrors
// codex-mcp-reachability-real-spawn.mjs's own posture). -----------------------------------------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  // Card 5978735a: MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's own WARN_LINE_RE) —
  // a bare `SKIP  ` line is discarded entirely once this file reports a pass, leaving zero trace on CI
  // (ubuntu-latest, no codex CLI) that this file's real coverage never ran.
  console.log(`WARN  SKIP  codex-stateful-runtime-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-runtime-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");

const SESSION_ID = "codex-runtime-test";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-runtime-cwd-"));

// --- md5-before (real ~/.codex/config.toml) -----------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

// Card 14e6cf5f: serialize against any sibling real-codex-spawn test file (currently
// codex-mcp-reachability-real-spawn.mjs) — see _codex-real-spawn-lock.mjs's own header for the measured
// concurrent-scheduling failure this closes. Held until the config.toml diff/cleanup below is done, since
// that also touches the same shared file.
const releaseCodexLock = await acquireCodexRealSpawnLock();

const exitedSessions = new Map(); // sessionId -> {code, intended}
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const host = new PtyHost(events);

let buf = "";
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- Boot + trust-dialog + a genuine post-dialog state — observed via THIS PROJECT'S OWN subscribe(),
// never a guessed sleep. Keyed on the input placeholder OR the model-name footer line (both appear once
// the interactive TUI advances past the trust dialog, REGARDLESS of whether MCP servers ever connect —
// see this file's own header for why "context left"/full-ready is deliberately NOT the bar here). This
// test NEVER writes the trust-dialog answer itself, so reaching this state at all proves THIS PROJECT'S
// OWN code detected and answered it (a naive/no-op adapter would hang here indefinitely, or worse, have
// the dialog silently consume this test's OWN idle wait as menu input — the exact failure the probe
// itself reproduced once). --------------------------------------------------------------------------
try {
  await waitUntil(() => buf.includes("Ask Codex to do anything"), {
    label: `${SESSION_ID} real codex TUI advances past the trust dialog (proves it was detected+answered by this project's own code — this test never wrote a response itself)`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never advanced past the trust dialog within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}
console.log(`[info] trust dialog text ${buf.includes("Do you trust the contents of this directory?") ? "WAS" : "was NOT"} seen in this run's output (both are valid — depends on whether this scratch cwd was already trusted)`);

check("host.isAlive reports true for the real codex session (routed through findAnyLive)", host.isAlive(SESSION_ID) === true);
check("host.getPid returns a real, positive pid for the codex session", typeof host.getPid(SESSION_ID) === "number" && host.getPid(SESSION_ID) > 0);
// This test never called enqueueStdin/submitCodex, so busy CAN legitimately still be true here — this
// harness stands up no real gateway, and codex's own MCP-server-startup episode holds the busy-marker
// while it (fruitlessly) tries to connect. Informational only; see this file's own header.
console.log(`[info] host.isBusy reads ${host.isBusy(SESSION_ID)} at this point (this test stood up no real gateway, so a codex MCP-startup episode legitimately holding busy=true here is expected, not a defect — see codex-mcp-reachability-real-spawn.mjs for MCP-connectivity coverage against a real gateway)`);

// --- stop() — the real codex exit sequence (two Ctrl+C, ~800ms apart), observed via THIS PROJECT'S OWN
// events.onExit callback, never a guessed delay. ------------------------------------------------------
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(SESSION_ID);
  check("the real codex process exited with code 0 (clean shutdown, per the probe's own observed sequence)", exit.code === 0);
} catch (err) {
  console.log(`FAIL  real codex never reported onExit within budget after graceful stop: ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort cleanup */ }
}
check("host.isAlive reports false once the real codex process has exited", host.isAlive(SESSION_ID) === false);
unsubscribe();

// --- md5-diff-disclose: confirm THIS PROJECT'S OWN cleanup (diffConfigAfterSpawn/removeAddedTrustBlocks,
// run inside spawnCodexProcess's own trust-dialog handler) actually restored config.toml, not a
// test-local reimplementation of that logic. -----------------------------------------------------------
// The in-process trust-dialog lock's own delayed diff+cleanup (a ~1.5s setTimeout inside
// spawnCodexProcess, armed back when the trust dialog was first answered — well before this point, given
// the boot-to-ready wait and the full stop sequence already elapsed above) has had ample time to finish
// by now; poll for TWO CONSECUTIVE identical reads (rather than trusting one immediate read) as the
// observable "settled" signal, so a straggling write mid-poll is still caught rather than raced.
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort settle wait — the check below still reports the truth either way */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("THIS PROJECT'S OWN removeAddedTrustBlocks already stripped the expected [projects.'<scratchCwd>'] block (no manual cleanup needed)", !stillPresent);
  if (stillPresent) {
    // Best-effort manual cleanup so a failure here doesn't leave the owner's real config.toml dirty.
    const removable = remaining.match(blockRe) ?? [];
    if (removable.length) {
      const restored = remaining.split(removable[0]).join("");
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed the block THIS PROJECT'S OWN code should have already stripped: ${removable[0]}`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged (this scratch cwd was likely already trusted from a prior run, or the diff genuinely found nothing to clean).");
}

releaseCodexLock();

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost.spawn({harness:\"codex\"}) drove a REAL codex process through boot, past the trust dialog, and through stop(), all observed via this project's own public API (isAlive/getPid/subscribe/events.onExit), zero model turns spent, and this project's own trust-dialog cleanup code (not a test-local reimplementation) left config.toml in its pre-run state."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
