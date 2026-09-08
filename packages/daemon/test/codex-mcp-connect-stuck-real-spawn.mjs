// Card 6bf0ee32 — repro for the reported "codex MCP-connect failure leaves the busy signal stuck
// indefinitely" degenerate state. `test/codex-stateful-runtime-real-spawn.mjs`'s own header already
// documented this informally (a prior worker's real-spawn finding: "that failure leaves codex's
// title-bar busy-spinner marker STUCK ... for longer than is practical to wait out") — but that was a
// ONE-TIME snapshot read taken shortly after boot, never a sustained wait to see whether it clears.
//
// 🔴 THIS TEST'S OWN FINDING REFUTES THE LITERAL PREMISE, under the realistic "gateway absent" reading
// (a closed port — nothing listening, so codex's MCP client gets a real, immediate connection refusal):
// across FOUR independent real-spawn trials during this card's development, the busy signal reliably
// self-resolved via the EXISTING `armCodexBusyStaleTimer` staleness mechanism — busy went true, then false
// again, at (true-at-ms -> false-at-ms) 880->11181, 975->11203, 860->11068, 1147->11427 (a ~360ms spread
// across all four — a mechanism reading, not a coincidence). Codex's own spinner genuinely stops
// refreshing after its own ~8s retry budget, and the existing 3s staleness window then correctly declares
// idle. It did NOT stay stuck indefinitely. This file is therefore a REGRESSION GUARD on that self-heal
// continuing to work — Loom's whole worker-supervision model keys off busy/idle, and a session that could
// stay permanently busy is the single worst failure that model is worst at diagnosing (per this card's own
// body) — not a guard for a fix that was never built, because the repro did not show a defect to fix under
// this specific failure shape (a cleanly-refused port). The 60s bound below is deliberately ~5x the
// measured ~11.2s, chosen to assert the INVARIANT ("it clears") without tuning the bound to the
// measurement ("it clears in ~11s") — a tight bound here would make this a timing flake on a slower host,
// not evidence of a real regression.
//
// ⚠️ ON `codex-stateful-runtime-real-spawn.mjs`'s OWN "stuck ... longer than practical to wait out" CLAIM:
// this is a HYPOTHESIS about that observation, not a confirmed explanation. That file's own trust-dialog
// wait resolves in well under 1s (the ready placeholder renders in the very first TUI frame), and its next
// line is a single one-time `isBusy` read with no further wait — given this test's measured ~11.2s busy
// window starting under 1s after spawn, a one-time check taken shortly after boot would very plausibly
// land inside it. But the alternative cannot be excluded: that worker's own trial may have seen a
// genuinely longer or differently-shaped stuck state under conditions this test did not reproduce (a
// different host's personal `~/.codex/config.toml`, a different codex version, or some other divergence).
// Do not read this as "explained" — only as the most likely account given what both runs describe.
//
// ⚠️ NOT COVERED, disclosed rather than assumed away: (1) this host's own personal `~/.codex/config.toml`
// has additional real MCP servers configured alongside the two unreachable ones this test wires in
// (observed "Starting MCP servers (3/5)" in the raw TUI output) — the ~11s duration may be dominated by
// those OTHER servers' own real startup, not isolated to the unreachable pair, and no trial isolated a
// "2-unreachable-only, zero personal servers" configuration; (2) this test only exercises a CLEANLY
// REFUSED port (ECONNREFUSED), never a silently-hung/blackholed endpoint (no RST) — Loom's gateway is
// loopback-only, so ECONNREFUSED is the realistic production case and a local packet-blackhole without a
// deliberately exotic firewall has ~nil realistic incidence, but that variant was never tested and could
// plausibly behave differently. Recorded as an explicit, named, untested bound — not "tested and fine".
//
// SHAPE: PtyHost.spawn with a DELIBERATELY, VERIFIED-unreachable port (see findUnreachablePort below) — a
// real gotcha found developing this file: `PORT` (paths.ts) defaults to 4317, which a real, live
// self-hosting Loom daemon on this very host was ALREADY listening on (confirmed via a live TCP probe
// while this test's first draft ran). Simply "not starting a gateway in this process" does NOT mean
// "nothing is listening" on a shared dev host — codex's MCP servers silently reached that REAL daemon
// instead, which is why an early draft of this file observed no busy episode at all.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available on this host (mirrors every sibling real-spawn file's posture).
// ZERO MODEL TURNS SPENT: this file never calls enqueueStdin/submitCodex.
//
// 🔴 Card ba60e802: the busy-rise/self-heal repro below is gated on `host.isCodexBootReady` (raced against
// PtyHost's own `onCodexBootStuck` fail-loud ceiling) being reached FIRST — it no longer asserts on the
// bare "Ask Codex to do anything" placeholder alone. That placeholder renders in the very first TUI frame
// while the model is still genuinely loading (same trap `codex-submit-confirmation-real-spawn.mjs`'s own
// header describes), so a real gate run under host contention saw it satisfied while codex's actual boot
// never progressed far enough for the MCP-connect phase this repro is about — and the OLD logic then
// reported that as a FAILURE of the self-heal invariant, when the invariant was never exercised at all
// (gate `93280647`: `[codex-boot-stuck] ... unmet: model-loaded`, `busy transitions observed: []`). If
// boot readiness is never reached this run, this file now logs a SKIP (precondition not met) and exits 0
// without asserting anything about the invariant — "codex never booted" is not "the invariant holds".
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-mcp-connect-stuck-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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

try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  codex-mcp-connect-stuck-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}).`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-mcp-stuck-");
process.env.LOOM_HOME = TMP;

// Force a genuinely unreachable port instead of assuming none is bound (see this file's own header for
// why that assumption is unsafe on a shared dev host) — confirm nothing answers it before trusting it.
async function findUnreachablePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 41000 + Math.floor(Math.random() * 9000);
    const reachable = await new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: candidate, timeout: 300 });
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (!reachable) return candidate;
  }
  throw new Error("could not find an unreachable port after 20 attempts");
}
const unreachablePort = await findUnreachablePort();
process.env.LOOM_PORT = String(unreachablePort);
console.log(`[repro] confirmed port ${unreachablePort} is unreachable (connection refused/timeout) — using it as LOOM_PORT so codex's MCP servers have nothing real to reach`);

const { PtyHost } = await import("../dist/pty/host.js");

const SESSION_ID = "codex-mcp-stuck-test";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-mcp-stuck-cwd-"));

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const releaseCodexLock = await acquireCodexRealSpawnLock();

const busyTransitions = []; // { t: msSinceStart, busy }
let startedAt = 0;
const exitedSessions = new Map();
const bootStuckEvents = []; // { sessionId, info } — see the boot-readiness gate below (card ba60e802)
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, busy) { busyTransitions.push({ t: Date.now() - startedAt, busy }); },
  onCodexBootStuck(sessionId, info) { bootStuckEvents.push({ sessionId, info }); },
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const host = new PtyHost(events);

let buf = "";
startedAt = Date.now();
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- ESTABLISH BOOT READINESS POSITIVELY FIRST (card ba60e802) — the repro below must never assert on a
// state its own precondition never reached. The old wait here was on the bare "Ask Codex to do anything"
// placeholder alone, which renders in the very first TUI frame while the model is still genuinely loading
// (see codex-submit-confirmation-real-spawn.mjs's own header for why that placeholder alone is NOT a
// readiness signal) — so it could (and, in a real gate run, did) succeed while codex's actual boot never
// progressed far enough for the MCP-connect phase this repro is about to ever run at all. `host.isCodexBootReady`
// reads the SAME composite (ready marker + model-loaded + trust-dialog-resolved) `enqueueStdinCodex` itself
// gates every submit on — racing it against PtyHost's OWN fail-loud `onCodexBootStuck` ceiling
// (pty/host.ts, CODEX_BOOT_READY_TIMEOUT_MS, default 45s) rather than inventing a second, independent
// timeout: if codex never reaches boot readiness, that ceiling fires on its own and IS the signal that the
// environment failed to deliver the state under test — a SKIP, never a FAIL of the self-heal invariant
// below, since the invariant was never exercised. Budget here is the internal ceiling plus slack for the
// event to propagate and this poll to observe it (never a second guess at "how long codex takes to boot").
//
// Real incident this closes: gate `93280647` (card ba60e802) saw `[codex-boot-stuck] ... unmet:
// model-loaded` at 45s, and the OLD logic below still asserted "busy never rose" as a FAILURE of the
// self-heal invariant — an assertion about a state (MCP-connect) that literally never had a chance to run.
let bootReady = false;
try {
  const outcome = await waitUntil(
    () => {
      if (host.isCodexBootReady(SESSION_ID)) return "ready";
      if (bootStuckEvents.some((e) => e.sessionId === SESSION_ID)) return "stuck";
      return false;
    },
    { label: `${SESSION_ID} reaches real boot readiness OR PtyHost's own boot-stuck ceiling fires`, timeoutMs: 50_000 },
  );
  bootReady = outcome === "ready";
} catch {
  // Outer budget exhausted without EITHER signal firing — treated identically to an observed boot-stuck
  // report below: boot readiness was not established, so the repro below cannot run.
  bootReady = false;
}

if (!bootReady) {
  const stuckInfo = bootStuckEvents.find((e) => e.sessionId === SESSION_ID)?.info;
  const unmet = stuckInfo
    ? ([!stuckInfo.readyMarker && "ready marker", !stuckInfo.modelLoaded && "model-loaded", !stuckInfo.trustDialogResolved && "trust-dialog-resolved"].filter(Boolean).join(", ") || "none individually")
    : null;
  // ⚠️ SKIP, never FAIL: "codex never booted, so the invariant was not exercised" is NOT "the invariant
  // holds" — this line exists so a future reader of this log cannot mistake a SKIP for coverage.
  // 🔴 Card ba60e802 round 2: MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's own
  // WARN_LINE_RE), not a bare `SKIP  ` line — a PASSING file's own stdout is otherwise discarded entirely
  // (test-daemon.mjs:1923's own comment), so an un-prefixed SKIP notice here would exit 0 and vanish
  // without a trace on a green gate, silently converting the exact "asserted something it did not measure"
  // defect this card exists to remove into an invisible false PASS instead. See reportGracefulStopExitCode
  // in codex-transcript-real-spawn.mjs for the sibling case this same rule was already applied to.
  console.log(`WARN  SKIP: the MCP-connect busy/self-heal invariant was NOT exercised this run: real codex never reached boot readiness${unmet ? ` (unmet: ${unmet})` : " (no boot-stuck report observed either — the outer wait budget was exhausted)"}. This is a precondition miss, not evidence the self-heal invariant holds.`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
} else {
  // --- THE GUARD: with the unreachable MCP servers, does a real busy episode happen, and does it clear
  // again within a bounded window? Two separate, bounded waits (never one open-ended poll) — the FIRST
  // proves the degenerate state is real (busy DOES rise from the MCP-connect attempt), the SECOND proves the
  // EXISTING self-heal keeps working (busy DOES fall again on its own). Both budgets are deliberately
  // generous relative to the ~11.2s this took across four measured real trials, without pretending to prove
  // an unbounded claim — a bounded pass here is evidence the self-heal still works within this budget, never
  // proof it can never get stuck under some OTHER condition (see this file's own header for what remains
  // untested). `busyTransitions.length > 0` (recorded by the onBusy listener from spawn time, above) is
  // checked alongside the live `isBusy()` poll so a busy episode that already rose AND cleared while we were
  // waiting for boot readiness above is still correctly counted — a live-only poll here could otherwise miss
  // a transition that happened entirely before this wait started watching. ---------------------------------
  try {
    await waitUntil(() => busyTransitions.length > 0 || host.isBusy(SESSION_ID), {
      label: `${SESSION_ID} busy signal rises from the MCP-connect attempt against unreachable servers`,
      timeoutMs: 20000,
    });
    check("REPRO: with unreachable MCP servers, codex's MCP-connect attempt made the session busy (a real busy episode was observed, not just boot chrome)", true);
  } catch (err) {
    console.log(`[repro] busy never rose within budget: ${err.message}`);
    check("REPRO: with unreachable MCP servers, codex's MCP-connect attempt made the session busy", false);
  }

  if (host.isBusy(SESSION_ID)) {
    try {
      await waitUntil(() => !host.isBusy(SESSION_ID), {
        label: `${SESSION_ID} busy signal falls again on its own (self-heal via the existing staleness timer) — measured ~11.2s across four prior real trials, this bound is ~5x that`,
        timeoutMs: 60_000,
      });
      check("GUARD: the busy episode cleared on its own within 60s (bounded window) via the existing armCodexBusyStaleTimer mechanism — no unconfirmed-stuck defect reproduced under this failure shape", true);
    } catch (err) {
      console.log(`[repro] busy did NOT clear within the 60s bounded window: ${err.message}`);
      check("GUARD: the busy episode cleared on its own within 60s (bounded window)", false);
    }
  }
}
console.log(`[repro] busy transitions observed (ms since spawn): ${JSON.stringify(busyTransitions)}`);

host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} onExit after graceful stop`, timeoutMs: 8000 });
} catch {
  console.log(`[cleanup] graceful stop didn't confirm exit in time — escalating to hard stop`);
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
  await new Promise((r) => setTimeout(r, 1000));
}
unsubscribe();

// --- md5-diff-disclose ---------------------------------------------------------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const removable = remaining.match(blockRe) ?? [];
  if (removable.length) {
    const restored = remaining.split(removable[0]).join("");
    if (md5(restored) === hashBefore) {
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] removed the expected [projects.'${scratchCwd}'] block this run added.`);
    } else {
      console.log(`[cleanup] ⚠️ found an expected-shaped block but removing it did not restore the exact pre-run hash — leaving config.toml untouched.`);
    }
  } else {
    console.log(`[cleanup] ⚠️ config.toml changed but no [projects.'${scratchCwd}'] block was found.`);
  }
} else {
  console.log("[cleanup] config.toml unchanged.");
}

releaseCodexLock();

console.log(failures === 0
  ? (bootReady
      ? "\n✅ ALL PASS — a real busy episode from an unreachable-MCP-server spawn was observed and confirmed to clear again within a bounded window, via this project's own existing self-heal mechanism."
      // Card ba60e802 round 2: also a `WARN  ` line (same reasoning as the mid-file notice above) — this
      // is the terse, at-a-glance closing verdict; the mid-file line above carries the diagnostic detail
      // (which of ready-marker/model-loaded/trust-dialog-resolved was unmet). Both earn a place in the
      // retained WARNINGS block: this one lets a reader scanning many files' closing lines immediately see
      // "this file's overall run was a SKIP, not a real PASS" without reading the longer detail line.
      : "\nWARN  ⚠️  SKIPPED — real codex never reached boot readiness this run, so the MCP-connect busy/self-heal invariant was NOT exercised. A SKIP is a precondition miss, not confirmation the invariant holds.")
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
